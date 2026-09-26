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
  const [, deleted] = await db.$transaction([
    db.paymentAllocation.deleteMany({ where: { tenantId, paymentId } }),
    db.payment.deleteMany({ where: { tenantId, id: paymentId } }),
  ]);
  return deleted.count;
}

export async function openChargesForMatching(tenantId: string, db: PrismaClient = prisma) {
  const charges = await db.charge.findMany({
    where: { tenantId, status: "ISSUED" },
    select: { id: true, amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
    orderBy: { dueDate: "asc" },
  });
  return charges.map((c) => ({ id: c.id, open: chargeBalance(c).open })).filter((c) => c.open > 0.005);
}
