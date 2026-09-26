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
    // TODO(#52 Task 1): Finanzdaten haben keine FK auf Tenant → dann explizit und in Abhängigkeitsreihenfolge löschen.
    async cleanup() {
      await db.tenant.delete({ where: { id: tenantId } });
    },
  };
}
