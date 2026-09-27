// Sollstellungen der Verträge einer Person (Miete + Flächenmiete; Fläche hängt über die Teilfläche am Vertrag).
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export function chargesForLeases(tenantId: string, leaseIds: string[], db: PrismaClient = prisma) {
  if (leaseIds.length === 0) return Promise.resolve([]);
  return db.charge.findMany({
    where: { tenantId, OR: [{ leaseId: { in: leaseIds } }, { areaAllocation: { leaseId: { in: leaseIds } } }] },
    include: { allocations: { select: { amount: true, payment: { select: { id: true, date: true, amount: true, direction: true } } } } },
    orderBy: { dueDate: "desc" },
  });
}
