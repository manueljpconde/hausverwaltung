// Sollstellungslauf (Miete + Flächenmiete). #52: Duplikate verhindert die DB (Teilindizes nur ISSUED);
// nur Eindeutigkeitsverletzungen gelten als „schon vorhanden", alles andere wird weitergereicht.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export function isUniqueViolation(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code === "P2002";
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

export function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  return { first: new Date(Date.UTC(y, m - 1, 1)), last: new Date(Date.UTC(y, m, 0)), due: new Date(Date.UTC(y, m - 1, 3)) };
}

async function createOnce(db: PrismaClient, data: Prisma.ChargeUncheckedCreateInput): Promise<boolean> {
  try {
    await db.charge.create({ data });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

export async function generateMonthlyCharges(tenantId: string, month: string, db: PrismaClient = prisma) {
  const { first, last, due } = monthBounds(month);
  const leases = await db.lease.findMany({
    where: { tenantId, startDate: { lte: last }, OR: [{ endDate: null }, { endDate: { gte: first } }] },
    include: { components: { select: { amount: true } } },
  });
  let created = 0;
  let skipped = 0;
  for (const l of leases) {
    const warm = Number(l.rentCold) + l.components.reduce((a, c) => a + Number(c.amount), 0);
    if (await createOnce(db, { tenantId, leaseId: l.id, type: "MIETE", period: first, dueDate: due, amount: warm })) created++;
    else skipped++;
  }
  // Flächenmodell (Gewerbe): nur Teilflächen von Objekten mit areaModel=true, keine
  // Außenflächen (outdoor zählt nicht zur Pool-Summe/NK) — Filter wie das bisherige
  // generateAreaCharges in api-ops.ts, siehe task-5-report.md.
  const props = await db.property.findMany({
    where: { tenantId, areaModel: true },
    select: {
      areaAllocations: {
        where: { outdoor: false, pricePerSqm: { not: null }, from: { lte: last }, OR: [{ to: null }, { to: { gte: first } }] },
        select: { id: true, label: true, area: true, pricePerSqm: true },
      },
    },
  });
  for (const p of props) {
    for (const a of p.areaAllocations) {
      const amount = Math.round(Number(a.area) * Number(a.pricePerSqm) * 100) / 100;
      if (amount <= 0) continue;
      if (await createOnce(db, { tenantId, areaAllocationId: a.id, type: "MIETE", period: first, dueDate: due, amount, description: a.label ?? "Flächenmiete" })) created++;
      else skipped++;
    }
  }
  return { created, skipped };
}
