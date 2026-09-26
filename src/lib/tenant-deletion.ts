// #52: Finanzdaten haben keine FK auf Tenant — beim Löschen explizit und vollständig entfernen (DSGVO).
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function deleteTenantData(tenantId: string, db: PrismaClient = prisma) {
  await db.$transaction([
    db.paymentAllocation.deleteMany({ where: { tenantId } }),
    db.dunningNotice.deleteMany({ where: { tenantId } }),
    db.payment.deleteMany({ where: { tenantId } }),
    db.charge.deleteMany({ where: { tenantId } }),
    db.quotaDebtorSnapshot.deleteMany({ where: { tenantId } }),
    db.condominiumAssessmentLine.deleteMany({ where: { tenantId } }),
    db.condominiumAssessment.deleteMany({ where: { tenantId } }),
    db.tenant.delete({ where: { id: tenantId } }),
  ]);
}
