// #52 R2: Lebenszyklus der Sollstellungen — nie physisch löschen; Sperrreihenfolge (Plan-Advisory) → Assessment → Charges (id aufsteigend).
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ALLOCATIONS_FOR_BALANCE, chargeBalance, MONEY_EPSILON } from "@/lib/charges";
import { QuotaError } from "./errors";
import { lockAssessment, lockChargesOrdered, lockPlanShared, recomputeAssessmentStatusInTx } from "./tx";
import { monthlyFromAnnual } from "./compute";
import { parseOrThrow, reasonSchema, refundInputSchema } from "./input";

type Ctx = { tenantId: string; userId: string; userName: string | null };
const RC = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 };

// Ungesperrter Kontext: nur unveränderliche Bezüge (Snapshot → Zeile → Assessment); Status wird erst unter Sperre gelesen.
async function chargeContext(tx: Prisma.TransactionClient, tenantId: string, chargeId: string) {
  const c = await tx.charge.findFirst({
    where: { id: chargeId, tenantId },
    select: { id: true, quotaDebtorSnapshot: { select: { id: true, lineId: true, amountCents: true, line: { select: { assessmentId: true, amountCents: true } } } } },
  });
  if (!c) throw new QuotaError("NOT_FOUND", "charge");
  return c;
}

async function audit(tx: Prisma.TransactionClient, ctx: Ctx, entity: string, entityId: string, summary: string) {
  await tx.auditLog.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, userName: ctx.userName, action: "UPDATE", entity, entityId, summary } });
}

// Grund: getrimmt, 3–500 Zeichen.
const requireReason = (reason: string) => parseOrThrow(reasonSchema, reason);

export async function voidChargeInTx(tx: Prisma.TransactionClient, ctx: Ctx, chargeId: string, reason: string) {
  reason = requireReason(reason);
  const c = await chargeContext(tx, ctx.tenantId, chargeId);
  const assessmentId = c.quotaDebtorSnapshot?.line.assessmentId;
  if (assessmentId) await lockAssessment(tx, ctx.tenantId, assessmentId);
  await lockChargesOrdered(tx, ctx.tenantId, [chargeId]);
  const cur = await tx.charge.findUniqueOrThrow({ where: { id_tenantId: { id: chargeId, tenantId: ctx.tenantId } }, select: { status: true, _count: { select: { allocations: true } } } });
  if (cur.status === "CANCELLED") return; // bereits storniert (z. B. durch cancelAssessment): kein zweiter Eintrag
  if (cur._count.allocations > 0) throw new QuotaError("HAS_PAYMENTS");
  await tx.charge.update({ where: { id_tenantId: { id: chargeId, tenantId: ctx.tenantId } }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason } });
  await audit(tx, ctx, "Charge", chargeId, `CANCELLED: ${reason}`);
  if (assessmentId) await recomputeAssessmentStatusInTx(tx, ctx.tenantId, assessmentId);
}

export async function voidCharge(ctx: Ctx, chargeId: string, reason: string, db: PrismaClient = prisma) {
  return db.$transaction((tx) => voidChargeInTx(tx, ctx, chargeId, reason), RC);
}

export async function refundAndCancelInTx(
  tx: Prisma.TransactionClient, ctx: Ctx, chargeId: string,
  p: { accountId?: string | null; date: Date; reference?: string | null; reason: string },
): Promise<{ paymentId: string | null }> {
  const input = parseOrThrow(refundInputSchema, p);
  const reason = input.reason;
  const c = await chargeContext(tx, ctx.tenantId, chargeId);
  const assessmentId = c.quotaDebtorSnapshot?.line.assessmentId;
  if (assessmentId) await lockAssessment(tx, ctx.tenantId, assessmentId);
  await lockChargesOrdered(tx, ctx.tenantId, [chargeId]);
  const cur = await tx.charge.findUniqueOrThrow({
    where: { id_tenantId: { id: chargeId, tenantId: ctx.tenantId } },
    select: { amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
  });
  if (cur.status === "CANCELLED") throw new QuotaError("INVALID_INPUT", "already cancelled");
  if (input.accountId) {
    // Alle Prüfungen vor dem Schreiben; die zusammengesetzte FK (accountId, tenantId) bleibt die zweite Linie.
    const account = await tx.account.findFirst({ where: { id: input.accountId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!account) throw new QuotaError("INVALID_INPUT", "account");
  }
  const paid = Math.round(chargeBalance(cur).paid * 100) / 100;
  let paymentId: string | null = null;
  if (paid > MONEY_EPSILON) {
    // Vollständige Rückzahlung nur hier: gleiche Transaktion wie CANCELLED (Charge ist bereits gesperrt).
    const payment = await tx.payment.create({ data: { tenantId: ctx.tenantId, accountId: input.accountId ?? null, date: input.date, amount: paid, direction: "AUSGANG", reference: input.reference } });
    await tx.paymentAllocation.create({ data: { tenantId: ctx.tenantId, paymentId: payment.id, chargeId, amount: paid } });
    paymentId = payment.id;
  }
  await tx.charge.update({ where: { id_tenantId: { id: chargeId, tenantId: ctx.tenantId } }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason } });
  await audit(tx, ctx, "Charge", chargeId, paymentId ? `REFUNDED ${paid.toFixed(2)} + CANCELLED: ${reason}` : `CANCELLED: ${reason}`);
  if (assessmentId) await recomputeAssessmentStatusInTx(tx, ctx.tenantId, assessmentId);
  return { paymentId };
}

export async function refundAndCancel(
  ctx: Ctx, chargeId: string, p: { accountId?: string | null; date: Date; reference?: string | null; reason: string }, db: PrismaClient = prisma,
) {
  return db.$transaction((tx) => refundAndCancelInTx(tx, ctx, chargeId, p), RC);
}

export async function cancelAssessmentInTx(tx: Prisma.TransactionClient, ctx: Ctx, assessmentId: string, reason: string) {
  reason = requireReason(reason);
  const a = await lockAssessment(tx, ctx.tenantId, assessmentId);
  if (a.status === "CANCELLED") return; // bereits storniert: nichts zu tun
  // Nur ISSUED: bereits stornierte Sollstellungen behalten Grund und Zahlungshistorie; ihre Zuordnungen blockieren nicht.
  const issued = await tx.charge.findMany({
    where: { tenantId: ctx.tenantId, status: "ISSUED", quotaDebtorSnapshot: { line: { assessmentId } } },
    select: { id: true }, orderBy: { id: "asc" },
  });
  const ids = issued.map((c) => c.id);
  await lockChargesOrdered(tx, ctx.tenantId, ids);
  // Unter der Sperre erneut lesen: eine inzwischen festgeschriebene Zahlung ist jetzt sichtbar.
  const cur = await tx.charge.findMany({
    where: { tenantId: ctx.tenantId, id: { in: ids }, status: "ISSUED" },
    select: { id: true, _count: { select: { allocations: true } } },
  });
  if (cur.some((c) => c._count.allocations > 0)) throw new QuotaError("HAS_PAYMENTS");
  await tx.charge.updateMany({
    where: { tenantId: ctx.tenantId, id: { in: cur.map((c) => c.id) }, status: "ISSUED" },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason },
  });
  await recomputeAssessmentStatusInTx(tx, ctx.tenantId, assessmentId);
  await audit(tx, ctx, "CondominiumAssessment", assessmentId, `CANCELLED (${cur.length} charges): ${reason}`);
}

export async function cancelAssessment(ctx: Ctx, assessmentId: string, reason: string, db: PrismaClient = prisma) {
  return db.$transaction((tx) => cancelAssessmentInTx(tx, ctx, assessmentId, reason), RC);
}

export async function reissueChargeInTx(tx: Prisma.TransactionClient, ctx: Ctx, chargeId: string): Promise<{ chargeId: string }> {
  const c = await chargeContext(tx, ctx.tenantId, chargeId);
  const snap = c.quotaDebtorSnapshot;
  if (!snap) throw new QuotaError("INVALID_INPUT", "not a quota charge");
  const assessmentId = snap.line.assessmentId;
  // Art, Objekt und Periode sind unveränderlich (Trigger); daraus der Plan-Schlüssel für Schritt 0.
  const head = await tx.condominiumAssessment.findFirstOrThrow({ where: { id: assessmentId, tenantId: ctx.tenantId }, select: { kind: true, propertyId: true, period: true } });
  const year = head.period.getUTCFullYear();
  // Schritt 0b: nur der Advisory-Lock; die Planzeile wird ungesperrt gelesen (kein Zyklus mit der Planänderung).
  if (head.kind === "ORDINARY") await lockPlanShared(tx, ctx.tenantId, head.propertyId, year);
  const a = await lockAssessment(tx, ctx.tenantId, assessmentId);
  await lockChargesOrdered(tx, ctx.tenantId, [chargeId]);
  const cur = await tx.charge.findUniqueOrThrow({
    where: { id_tenantId: { id: chargeId, tenantId: ctx.tenantId } },
    select: { status: true, type: true, amount: true, period: true, dueDate: true, description: true },
  });
  if (cur.status !== "CANCELLED") throw new QuotaError("INVALID_INPUT", "charge not cancelled");
  const active = await tx.charge.count({ where: { tenantId: ctx.tenantId, quotaDebtorSnapshotId: snap.id, status: "ISSUED" } });
  if (active > 0) throw new QuotaError("ALREADY_ISSUED_CONFLICT", "snapshot already has an issued charge");
  const others = await tx.quotaDebtorSnapshot.aggregate({
    where: { tenantId: ctx.tenantId, lineId: snap.lineId, id: { not: snap.id }, charges: { some: { status: "ISSUED" } } },
    _sum: { amountCents: true },
  });
  if ((others._sum.amountCents ?? 0) + snap.amountCents > snap.line.amountCents) throw new QuotaError("SNAPSHOT_SUPERSEDED");
  if (a.status === "CANCELLED" && a.kind === "ORDINARY") {
    const plan = await tx.economicPlan.findFirst({ where: { tenantId: ctx.tenantId, propertyId: a.propertyId, year }, select: { totalAmount: true } });
    if (!plan || monthlyFromAnnual(Math.round(Number(plan.totalAmount) * 100), a.period.getUTCMonth() + 1) !== a.totalCents) {
      throw new QuotaError("PLAN_CHANGED");
    }
  }
  const created = await tx.charge.create({
    data: { tenantId: ctx.tenantId, quotaDebtorSnapshotId: snap.id, type: cur.type, period: cur.period, dueDate: cur.dueDate, amount: cur.amount, description: cur.description },
  });
  try {
    // Kanonischer Gesamtstatus; eine stornierte Emission wird dadurch wieder ISSUED.
    await recomputeAssessmentStatusInTx(tx, ctx.tenantId, assessmentId);
  } catch (e) {
    // Teilindex assessment_issued_uniq: für Objekt/Periode/Art ist bereits eine Ersatz-Emission ISSUED.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new QuotaError("ALREADY_ISSUED_CONFLICT");
    throw e;
  }
  await audit(tx, ctx, "Charge", created.id, `REISSUED from ${chargeId}`);
  return { chargeId: created.id };
}

export async function reissueCharge(ctx: Ctx, chargeId: string, db: PrismaClient = prisma) {
  return db.$transaction((tx) => reissueChargeInTx(tx, ctx, chargeId), RC);
}

export async function replaceDebtorInTx(
  tx: Prisma.TransactionClient, ctx: Ctx, lineId: string, fromPersonId: string, toPersonId: string, reason: string,
): Promise<{ chargeId: string }> {
  reason = requireReason(reason);
  const line = await tx.condominiumAssessmentLine.findFirst({ where: { id: lineId, tenantId: ctx.tenantId }, select: { id: true, assessmentId: true } });
  if (!line) throw new QuotaError("NOT_FOUND", "line");
  await lockAssessment(tx, ctx.tenantId, line.assessmentId);
  const to = await tx.person.findFirst({ where: { id: toPersonId, tenantId: ctx.tenantId }, select: { id: true } });
  if (!to) throw new QuotaError("INVALID_INPUT", "person");
  // Ein früherer Snapshot derselben Person auf dieser Zeile wäre eine Wiederbelebung — dafür gibt es reissueCharge.
  const existing = await tx.quotaDebtorSnapshot.count({ where: { tenantId: ctx.tenantId, lineId, personId: toPersonId } });
  if (existing > 0) throw new QuotaError("INVALID_INPUT", "person already has a snapshot on this line");
  const from = await tx.quotaDebtorSnapshot.findFirst({
    where: { tenantId: ctx.tenantId, lineId, personId: fromPersonId },
    select: { id: true, shareSnapshot: true, amountCents: true, charges: { where: { status: "ISSUED" }, select: { id: true } } },
  });
  if (!from) throw new QuotaError("NOT_FOUND", "snapshot");
  if (from.charges.length === 0) throw new QuotaError("INVALID_INPUT", "no issued charge");
  const oldId = from.charges[0].id;
  // Erst sperren, dann prüfen: recordPayment sperrt nur die Sollstellung.
  await lockChargesOrdered(tx, ctx.tenantId, [oldId]);
  const old = await tx.charge.findUniqueOrThrow({
    where: { id_tenantId: { id: oldId, tenantId: ctx.tenantId } },
    select: { status: true, type: true, amount: true, period: true, dueDate: true, description: true, _count: { select: { allocations: true } } },
  });
  if (old.status !== "ISSUED") throw new QuotaError("INVALID_INPUT", "no issued charge");
  if (old._count.allocations > 0) throw new QuotaError("HAS_PAYMENTS");
  await tx.charge.update({ where: { id_tenantId: { id: oldId, tenantId: ctx.tenantId } }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason } });
  const snap = await tx.quotaDebtorSnapshot.create({ data: { tenantId: ctx.tenantId, lineId, personId: toPersonId, shareSnapshot: from.shareSnapshot, amountCents: from.amountCents } });
  const created = await tx.charge.create({
    data: { tenantId: ctx.tenantId, quotaDebtorSnapshotId: snap.id, type: old.type, period: old.period, dueDate: old.dueDate, amount: old.amount, description: old.description },
  });
  await audit(tx, ctx, "CondominiumAssessmentLine", lineId, `DEBTOR ${fromPersonId} → ${toPersonId} (charge ${oldId} → ${created.id}): ${reason}`);
  return { chargeId: created.id };
}

export async function replaceDebtor(ctx: Ctx, lineId: string, fromPersonId: string, toPersonId: string, reason: string, db: PrismaClient = prisma) {
  return db.$transaction((tx) => replaceDebtorInTx(tx, ctx, lineId, fromPersonId, toPersonId, reason), RC);
}
