import { expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb } from "./test-db";

describeDb("Integrations-DB (#52)", () => {
  it("legt einen isolierten Mandanten an und räumt ihn wieder weg", async () => {
    const { tenantId, cleanup } = await createTestTenant();
    expect(await integrationDb!.tenant.count({ where: { id: tenantId } })).toBe(1);
    await cleanup();
    expect(await integrationDb!.tenant.count({ where: { id: tenantId } })).toBe(0);
  });
});
