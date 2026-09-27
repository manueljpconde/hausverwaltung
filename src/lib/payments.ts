// #52: Zahlungen anlegen und Sollstellungen zuordnen — Deckel und Zeilensperre, eine Transaktion.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ALLOCATIONS_FOR_BALANCE, chargeBalance, MONEY_EPSILON } from "@/lib/charges";
import { QuotaError } from "@/lib/quotas/errors";

export class PaymentError extends Error {}

type RecordInput = {
  tenantId: string;
  accountId?: string | null;
  chargeId?: string | null;
  date: Date;
  amount: number;
  direction: "EINGANG" | "AUSGANG";
  reference?: string | null;
  externalId?: string | null;
  note?: string | null;
  allowCredit?: boolean;
};

export async function recordPayment(input: RecordInput, db: PrismaClient = prisma) {
  return db.$transaction((tx) => recordPaymentInTx(tx, input), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

// #52 R2: Primitive in der Transaktion des Aufrufers; sperrt nur die Sollstellung (Lock-Reihenfolge Schritt 2).
export async function recordPaymentInTx(tx: Prisma.TransactionClient, input: RecordInput): Promise<{ paymentId: string; allocated: number }> {
  const { chargeId, allowCredit = false, ...data } = input;
  if (!(data.amount > 0)) throw new PaymentError("Betrag muss positiv sein");
  if (data.accountId) {
    const account = await tx.account.findFirst({ where: { id: data.accountId, tenantId: data.tenantId }, select: { id: true } });
    if (!account) throw new PaymentError("Konto nicht gefunden");
  }
  if (!chargeId) {
    const payment = await tx.payment.create({ data });
    return { paymentId: payment.id, allocated: 0 };
  }

  // Sperre auf die Sollstellung: parallele Zahlungen sehen den aktuellen Saldo.
  // #52 R2: Sperre, Saldo und Deckel vor dem Schreiben — eine abgelehnte Rückzahlung hinterlässt keine Zeile, auch wenn der Aufrufer den Fehler fängt.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Charge" WHERE id = ${chargeId} AND "tenantId" = ${data.tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new PaymentError("Sollstellung nicht gefunden");
  const charge = await tx.charge.findUniqueOrThrow({
    where: { id: chargeId },
    select: { amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
  });
  if (charge.status !== "ISSUED") throw new PaymentError("Sollstellung ist storniert");

  const b = chargeBalance(charge);
  let allocated: number;
  if (data.direction === "AUSGANG") {
    allocated = Math.round(Math.min(data.amount, Math.max(0, b.paid)) * 100) / 100;
    // #52 R2: den Nettoeingang auf 0 bringen darf nur refundAndCancel (gleiche Transaktion wie CANCELLED).
    if (allocated > 0 && b.paid - allocated <= MONEY_EPSILON) {
      throw new QuotaError("USE_REFUND_AND_CANCEL");
    }
  } else {
    allocated = Math.round(Math.min(data.amount, allowCredit ? data.amount : Math.max(0, b.open)) * 100) / 100;
  }
  const payment = await tx.payment.create({ data });
  if (allocated > 0) {
    await tx.paymentAllocation.create({ data: { tenantId: data.tenantId, paymentId: payment.id, chargeId, amount: allocated } });
  }
  return { paymentId: payment.id, allocated };
}

export async function deletePaymentWithAllocations(tenantId: string, paymentId: string, db: PrismaClient = prisma) {
  return db.$transaction((tx) => deletePaymentWithAllocationsInTx(tx, tenantId, paymentId));
}

export async function deletePaymentWithAllocationsInTx(tx: Prisma.TransactionClient, tenantId: string, paymentId: string) {
  const allocations = await tx.paymentAllocation.findMany({
    where: { tenantId, paymentId },
    select: { chargeId: true, amount: true, payment: { select: { direction: true } } },
  });
  const chargeIds = [...new Set(allocations.map((a) => a.chargeId))];
  if (chargeIds.length > 0) {
    const direction = allocations[0].payment.direction;
    // Sperre auf die betroffenen Sollstellungen: der Saldo nach dem Löschen wird unter der Sperre geprüft.
    await tx.$queryRaw`SELECT id FROM "Charge" WHERE id IN (${Prisma.join(chargeIds)}) AND "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
    const charges = await tx.charge.findMany({
      where: { id: { in: chargeIds }, tenantId },
      select: { id: true, amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
    });
    // #52 R2: Zahlungen einer stornierten Sollstellung sind Historie — sonst bliebe sie storniert mit nicht erstattetem Geld.
    if (charges.some((c) => c.status === "CANCELLED")) {
      throw new PaymentError("Zahlung einer stornierten Sollstellung kann nicht gelöscht werden");
    }
    for (const c of charges) {
      const b = chargeBalance(c);
      const ownTotal = allocations.filter((a) => a.chargeId === c.id).reduce((s, a) => s + Number(a.amount), 0);
      const incoming = direction === "EINGANG" ? b.incoming - ownTotal : b.incoming;
      const outgoing = direction === "AUSGANG" ? b.outgoing - ownTotal : b.outgoing;
      // #52 fix: incoming ist cent-gerundet, ownTotal roh — exakter Vergleich schlägt bei
      // Rundungsresten (z.B. 0.3 − 0.2 = 0.09999999999999998) fälschlich zu.
      if (outgoing - incoming > MONEY_EPSILON) {
        throw new PaymentError("Zahlung kann nicht gelöscht werden: Rückzahlungen übersteigen danach die Eingänge");
      }
      // #52 R2: Löschen darf eine Sollstellung mit Rückzahlungen nicht auf Nettoeingang 0 bringen — das ist refundAndCancel vorbehalten.
      if (outgoing > MONEY_EPSILON && incoming - outgoing <= MONEY_EPSILON) {
        throw new PaymentError("Zahlung kann nicht gelöscht werden: die Sollstellung wäre danach vollständig erstattet — Rückzahlung stornieren oder refundAndCancel verwenden");
      }
    }
  }
  await tx.paymentAllocation.deleteMany({ where: { tenantId, paymentId } });
  const deleted = await tx.payment.deleteMany({ where: { tenantId, id: paymentId } });
  return deleted.count;
}

export async function openChargesForMatching(tenantId: string, db: PrismaClient = prisma) {
  const charges = await db.charge.findMany({
    where: { tenantId, status: "ISSUED" },
    select: { id: true, amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
    orderBy: { dueDate: "asc" },
  });
  return charges.map((c) => ({ id: c.id, open: chargeBalance(c).open })).filter((c) => c.open > MONEY_EPSILON);
}

// Automatischer Abgleich (camt/Bank-Sync): exakter Betrag, jeder Treffer nur einmal.
export function matchOpenCharge(open: { id: string; open: number }[], amount: number): string | null {
  const hit = open.find((o) => o.open > 0 && Math.abs(o.open - amount) < MONEY_EPSILON);
  if (!hit) return null;
  hit.open = 0;
  return hit.id;
}

export function unappliedPart(amount: number, allocated: number, chargeId?: string | null) {
  const unapplied = Math.round((amount - allocated) * 100) / 100;
  return chargeId && unapplied > MONEY_EPSILON ? { applied: allocated, unapplied } : null;
}

// Finanzhistorie einer Sollstellung: Zahlungen oder Mahnungen → nicht löschen (bis voidCharge, Release 2).
export async function chargeHasHistory(tenantId: string, chargeId: string, db: PrismaClient = prisma) {
  const [allocations, dunnings] = await Promise.all([
    db.paymentAllocation.count({ where: { tenantId, chargeId } }),
    db.dunningNotice.count({ where: { tenantId, chargeId } }),
  ]);
  return allocations + dunnings > 0;
}
