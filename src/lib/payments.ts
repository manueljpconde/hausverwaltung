// #52: Zahlungen anlegen und Sollstellungen zuordnen — Deckel und Zeilensperre, eine Transaktion.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ALLOCATIONS_FOR_BALANCE, chargeBalance } from "@/lib/charges";

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
  const { chargeId, allowCredit = false, ...data } = input;
  if (!(data.amount > 0)) throw new PaymentError("Betrag muss positiv sein");
  return db.$transaction(async (tx) => {
    if (data.accountId) {
      const account = await tx.account.findFirst({ where: { id: data.accountId, tenantId: data.tenantId }, select: { id: true } });
      if (!account) throw new PaymentError("Konto nicht gefunden");
    }
    const payment = await tx.payment.create({ data });
    if (!chargeId) return { paymentId: payment.id, allocated: 0 };

    // Sperre auf die Sollstellung: parallele Zahlungen sehen den aktuellen Saldo.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Charge" WHERE id = ${chargeId} AND "tenantId" = ${data.tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new PaymentError("Sollstellung nicht gefunden");
    const charge = await tx.charge.findUniqueOrThrow({
      where: { id: chargeId },
      select: { amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
    });
    if (charge.status !== "ISSUED") throw new PaymentError("Sollstellung ist storniert");

    const b = chargeBalance(charge);
    const cap = data.direction === "AUSGANG" ? b.paid : allowCredit ? data.amount : Math.max(0, b.open);
    const allocated = Math.round(Math.min(data.amount, cap) * 100) / 100;
    if (allocated > 0) {
      await tx.paymentAllocation.create({ data: { tenantId: data.tenantId, paymentId: payment.id, chargeId, amount: allocated } });
    }
    return { paymentId: payment.id, allocated };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function deletePaymentWithAllocations(tenantId: string, paymentId: string, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
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
      for (const c of charges) {
        const b = chargeBalance(c);
        const ownTotal = allocations.filter((a) => a.chargeId === c.id).reduce((s, a) => s + Number(a.amount), 0);
        const incoming = direction === "EINGANG" ? b.incoming - ownTotal : b.incoming;
        const outgoing = direction === "AUSGANG" ? b.outgoing - ownTotal : b.outgoing;
        if (outgoing > incoming) {
          throw new PaymentError("Zahlung kann nicht gelöscht werden: Rückzahlungen übersteigen danach die Eingänge");
        }
      }
    }
    await tx.paymentAllocation.deleteMany({ where: { tenantId, paymentId } });
    const deleted = await tx.payment.deleteMany({ where: { tenantId, id: paymentId } });
    return deleted.count;
  });
}

export async function openChargesForMatching(tenantId: string, db: PrismaClient = prisma) {
  const charges = await db.charge.findMany({
    where: { tenantId, status: "ISSUED" },
    select: { id: true, amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
    orderBy: { dueDate: "asc" },
  });
  return charges.map((c) => ({ id: c.id, open: chargeBalance(c).open })).filter((c) => c.open > 0.005);
}
