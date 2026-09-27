// #52 R2: Emission von Quoten — ein Snapshot (REPEATABLE READ), Plan-Sperre, Idempotenz über requestKey.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allocateCents, computeLines, monthlyFromAnnual, requestKey, resolveHolders } from "./compute";
import { QuotaError } from "./errors";
import { issueInputSchema, parseOrThrow } from "./input";
import { lockPlanShared, SerializationConflict, withRetry } from "./tx";

export type IssueInput = {
  propertyId: string; kind: "ORDINARY" | "EXTRAORDINARY"; month: string;
  method?: "PERMILLAGE" | "FIXED" | "CUSTOM"; custom?: Record<string, number>; dueDay?: number;
  totalCents?: number; asOf?: Date; dueDate?: Date; description?: string; resolutionId?: string;
};
export type IssueResult = { assessmentId: string; created: boolean; lines: number; charges: number };
type Ctx = { tenantId: string; userId: string; userName: string | null };

function parseMonth(month: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new QuotaError("INVALID_INPUT", "month");
  return { year: Number(m[1]), month: Number(m[2]), period: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) };
}

export async function issueQuotasInTx(tx: Prisma.TransactionClient, ctx: Ctx, raw: IssueInput): Promise<IssueResult> {
  const input = parseOrThrow(issueInputSchema, raw);
  const { year, month, period } = parseMonth(input.month);
  const method = input.method;
  const description = input.kind === "EXTRAORDINARY" ? input.description : null;
  const resolutionId = input.kind === "EXTRAORDINARY" ? input.resolutionId ?? null : null;
  const property = await tx.property.findFirst({ where: { id: input.propertyId, tenantId: ctx.tenantId }, select: { id: true, management: true, meaTotal: true } });
  if (!property) throw new QuotaError("NOT_FOUND", "property");
  if (property.management !== "WEG") throw new QuotaError("INVALID_INPUT", "property is not a condominium");

  let totalCents: number, asOf: Date, dueDate: Date, annualCents: number | undefined;
  if (input.kind === "ORDINARY") {
    // Reihenfolge wie eine Planänderung: erst die Planzeile (FOR SHARE; nach dem Snapshot geändert → 40001 → Retry),
    // dann der Advisory-Lock. Umgekehrt entstünde ein Deadlock mit dem Trigger (Zeilensperre → Advisory).
    const plans = await tx.$queryRaw<{ totalAmount: Prisma.Decimal }[]>`
      SELECT "totalAmount" FROM "EconomicPlan" WHERE "tenantId" = ${ctx.tenantId} AND "propertyId" = ${property.id} AND year = ${year} FOR SHARE`;
    if (plans.length === 0) throw new QuotaError("PLAN_MISSING");
    await lockPlanShared(tx, ctx.tenantId, property.id, year);
    annualCents = Math.round(Number(plans[0].totalAmount) * 100);
    totalCents = monthlyFromAnnual(annualCents, month);
    asOf = period;
    const dueDay = input.dueDay ?? 8;
    dueDate = new Date(Date.UTC(year, month - 1, dueDay));
  } else {
    await lockPlanShared(tx, ctx.tenantId, property.id, year);
    totalCents = input.totalCents; asOf = input.asOf; dueDate = input.dueDate; // durch das Schema garantiert
  }

  if (resolutionId) {
    // Deliberação desta tenant e deste imóvel; FOR SHARE: eine gleichzeitige Verschiebung wartet bzw. führt zu 40001 → Retry.
    const res = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Resolution" WHERE id = ${resolutionId} AND "tenantId" = ${ctx.tenantId} AND "propertyId" = ${property.id} FOR SHARE`;
    if (res.length === 0) throw new QuotaError("INVALID_INPUT", "resolution");
  }

  const key = requestKey({ kind: input.kind, period, method, dueDate, asOf, totalCents, custom: input.custom, resolutionId: resolutionId, description: description });

  // Idempotenz: nur über den Teilindex; bestehende Emission unter Sperre vergleichen.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "CondominiumAssessment" (id, "tenantId", "propertyId", period, kind, method, "dueDate", "asOf", "totalCents", "requestKey", description, "resolutionId")
    VALUES (gen_random_uuid()::text, ${ctx.tenantId}, ${property.id}, ${period}, ${input.kind}::"QuotaKind", ${method}::"AssessmentMethod", ${dueDate}, ${asOf}, ${totalCents}, ${key}, ${description}, ${resolutionId})
    ON CONFLICT ("tenantId", "propertyId", period, kind) WHERE status = 'ISSUED' DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) {
    const existing = await tx.$queryRaw<{ id: string; requestKey: string }[]>`
      SELECT id, "requestKey" FROM "CondominiumAssessment"
      WHERE "tenantId" = ${ctx.tenantId} AND "propertyId" = ${property.id} AND period = ${period} AND kind = ${input.kind}::"QuotaKind" AND status = 'ISSUED' FOR UPDATE`;
    if (existing.length === 0) throw new SerializationConflict("conflict row vanished"); // gleichzeitig storniert → withRetry mit neuem Snapshot
    if (existing[0].requestKey !== key) throw new QuotaError("ALREADY_ISSUED_CONFLICT");
    const [lines, charges] = await Promise.all([
      tx.condominiumAssessmentLine.count({ where: { tenantId: ctx.tenantId, assessmentId: existing[0].id } }),
      tx.charge.count({ where: { tenantId: ctx.tenantId, quotaDebtorSnapshot: { line: { assessmentId: existing[0].id } } } }),
    ]);
    return { assessmentId: existing[0].id, created: false, lines, charges };
  }
  const assessmentId = inserted[0].id;
  await tx.$queryRaw`SELECT id FROM "CondominiumAssessment" WHERE id = ${assessmentId} AND "tenantId" = ${ctx.tenantId} FOR UPDATE`;

  const [units, owners, tenant] = await Promise.all([
    tx.unit.findMany({ where: { tenantId: ctx.tenantId, building: { propertyId: property.id } }, select: { id: true, mea: true } }),
    tx.owner.findMany({ where: { tenantId: ctx.tenantId, unit: { building: { propertyId: property.id } } }, select: { unitId: true, personId: true, share: true, vigencia: true, validFrom: true, validTo: true } }),
    tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { ownerValidityCutoverAt: true } }),
  ]);
  const lines = computeLines({ totalCents, method, units, meaTotal: property.meaTotal, custom: input.custom, annualCents: method === "FIXED" && input.kind === "ORDINARY" ? annualCents : undefined });

  const failures: { unitId: string; reason: string }[] = [];
  const holdersByUnit = new Map<string, { personId: string; share: number }[]>();
  for (const l of lines) {
    const h = resolveHolders(owners.filter((o) => o.unitId === l.unitId), asOf, tenant.ownerValidityCutoverAt);
    if ("error" in h) failures.push({ unitId: l.unitId, reason: h.error });
    else holdersByUnit.set(l.unitId, h);
  }
  if (failures.length > 0) throw new QuotaError("HOLDERS_INVALID", undefined, failures); // Rollback: nichts geschrieben

  let charges = 0;
  for (const l of lines) {
    const line = await tx.condominiumAssessmentLine.create({ data: { tenantId: ctx.tenantId, assessmentId, unitId: l.unitId, amountCents: l.amountCents } });
    if (l.amountCents === 0) continue;
    const holders = holdersByUnit.get(l.unitId)!;
    const parts = allocateCents(l.amountCents, holders.map((h) => ({ id: h.personId, weight: h.share })));
    for (const p of parts) {
      const share = holders.find((h) => h.personId === p.id)!.share;
      const snap = await tx.quotaDebtorSnapshot.create({ data: { tenantId: ctx.tenantId, lineId: line.id, personId: p.id, shareSnapshot: share, amountCents: p.amountCents } });
      if (p.amountCents === 0) continue;
      await tx.charge.create({ data: { tenantId: ctx.tenantId, quotaDebtorSnapshotId: snap.id, type: "HAUSGELD", period, dueDate, amount: p.amountCents / 100, description: description } });
      charges++;
    }
  }
  await tx.auditLog.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, userName: ctx.userName, action: "CREATE", entity: "CondominiumAssessment", entityId: assessmentId, summary: `${input.kind} ${input.month} ${method} ${totalCents}` } });
  return { assessmentId, created: true, lines: lines.length, charges };
}

export function issueQuotas(ctx: Ctx, input: IssueInput, db: PrismaClient = prisma) {
  return withRetry(() => db.$transaction((tx) => issueQuotasInTx(tx, ctx, input), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 }));
}

export async function issueQuotasRange(ctx: Ctx, input: IssueInput & { from: string; to: string }, db: PrismaClient = prisma) {
  const { from: fromMonth, to: toMonth, ...single } = input; // from/to gehören nicht zum strikten Einzel-Schema
  // R9: nur ordinárias — eine extraordinária im Lote wiederholte dasselbe asOf/dueDate.
  if (single.kind !== "ORDINARY") throw new QuotaError("INVALID_INPUT", "range only for ordinary");
  const from = parseMonth(fromMonth); const to = parseMonth(toMonth);
  const count = (to.year - from.year) * 12 + (to.month - from.month) + 1;
  if (count < 1 || count > 12) throw new QuotaError("INVALID_INPUT", "range 1–12 months");
  parseOrThrow(issueInputSchema, { ...single, month: fromMonth }); // gemeinsame Felder einmal prüfen statt N-mal je Monat
  const out: { month: string; result?: IssueResult; error?: { code: string; details?: unknown } }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(from.year, from.month - 1 + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    try { out.push({ month, result: await issueQuotas(ctx, { ...single, month }, db) }); }
    catch (e) {
      if (e instanceof QuotaError) { out.push({ month, error: { code: e.code, details: e.details } }); continue; }
      // Unerwartet: bereits festgeschriebene Monate nicht verlieren — melden und abbrechen.
      out.push({ month, error: { code: "UNEXPECTED", details: { message: e instanceof Error ? e.message : String(e) } } });
      break;
    }
  }
  return out;
}
