// Nur für Tests: echte Postgres-DB (INTEGRATION_DATABASE_URL), sonst werden die Suiten übersprungen.
import { PrismaClient } from "@prisma/client";
import { describe } from "vitest";

const url = process.env.INTEGRATION_DATABASE_URL;
export const integrationDb = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
export const describeDb = describe.skipIf(!integrationDb);

export async function createTestTenant() {
  const db = integrationDb!;
  const tenant = await db.tenant.create({ data: { name: `test-${crypto.randomUUID()}` } });
  const tenantId = tenant.id;
  return {
    tenantId,
    // Finanzdaten haben keine FK auf Tenant → explizit und in Abhängigkeitsreihenfolge löschen.
    async cleanup() {
      const where = { where: { tenantId } };
      await db.$transaction([
        db.paymentAllocation.deleteMany(where),
        db.dunningNotice.deleteMany(where),
        db.payment.deleteMany(where),
        db.account.deleteMany(where),
        db.charge.deleteMany(where),
        db.quotaDebtorSnapshot.deleteMany(where),
        db.condominiumAssessmentLine.deleteMany(where),
        db.condominiumAssessment.deleteMany(where),
        // Resolution/EconomicPlan erst nach Assessment (resolutionId-FK, Plan-Sperr-Trigger); Owner/AuditLog vor dem Tenant.
        db.resolution.deleteMany(where),
        db.economicPlan.deleteMany(where),
        db.owner.deleteMany(where),
        db.auditLog.deleteMany(where),
        db.areaAllocation.deleteMany(where),
        db.lease.deleteMany(where),
        db.tenant.delete({ where: { id: tenantId } }),
      ]);
    },
  };
}
