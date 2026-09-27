import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";
import { wegFixture } from "./quotas/fixtures";

let t: Awaited<ReturnType<typeof createTestTenant>>;
let fx: Awaited<ReturnType<typeof wegFixture>>;
const may = new Date(Date.UTC(2026, 4, 1));
const assessment = (over: object = {}) => ({
  tenantId: t.tenantId, propertyId: fx.property.id, period: may, kind: "ORDINARY" as const, method: "PERMILLAGE" as const,
  dueDate: may, asOf: may, totalCents: 10000, requestKey: "k", ...over,
});

describeDb("R2-Schema (#52)", () => {
  beforeEach(async () => { t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(() => t.cleanup());

  it("CANCELLED braucht cancelledAt und einen nicht leeren Grund; ISSUED keines von beiden", async () => {
    const lease = await db!.lease.create({ data: { tenantId: t.tenantId, unitId: fx.units[0].id, startDate: may, rentCold: 100 } });
    const base = { tenantId: t.tenantId, leaseId: lease.id, type: "SONSTIGES" as const, period: may, dueDate: may, amount: 10 };
    await expect(db!.charge.create({ data: { ...base, status: "CANCELLED", cancelledAt: new Date() } })).rejects.toThrow(/charge_cancel_consistency/);
    await expect(db!.charge.create({ data: { ...base, status: "CANCELLED", cancelledAt: new Date(), cancelReason: "   " } })).rejects.toThrow(/charge_cancel_consistency/);
    await expect(db!.charge.create({ data: { ...base, cancelReason: "x" } })).rejects.toThrow(/charge_cancel_consistency/);
    await expect(db!.charge.create({ data: { ...base, status: "CANCELLED", cancelledAt: new Date(), cancelReason: "erro" } })).resolves.toBeTruthy();
  });

  it("Deliberação muss zum Objekt des Assessments gehören — beim Schreiben des Assessments und beim Verschieben der Deliberação", async () => {
    const other = await db!.property.create({ data: { tenantId: t.tenantId, name: "Outro", street: "S", zip: "1", city: "L", management: "WEG" } });
    const resOther = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: other.id, number: 1, title: "x", text: "x", date: may } });
    await expect(db!.condominiumAssessment.create({ data: assessment({ kind: "EXTRAORDINARY", resolutionId: resOther.id }) })).rejects.toThrow(/assessment resolution not in assessment property/);
    const res = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: fx.property.id, number: 1, title: "x", text: "x", date: may } });
    await db!.condominiumAssessment.create({ data: assessment({ kind: "EXTRAORDINARY", resolutionId: res.id }) });
    await expect(db!.resolution.update({ where: { id: res.id }, data: { propertyId: other.id } })).rejects.toThrow(/assessment resolution not in assessment property/);
  });

  it("Wirtschaftsplan ist gesperrt, solange eine ordentliche ISSUED-Emission des Jahres existiert", async () => {
    const a = await db!.condominiumAssessment.create({ data: assessment() });
    await expect(db!.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 1300 } })).rejects.toThrow(/plan locked by issued ordinary assessments/);
    await expect(db!.economicPlan.delete({ where: { id: fx.plan.id } })).rejects.toThrow(/plan locked by issued ordinary assessments/);
    await db!.condominiumAssessment.update({ where: { id: a.id }, data: { status: "CANCELLED" } });
    await expect(db!.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 1300 } })).resolves.toBeTruthy();
  });

  it("Notiz-Änderung am Plan bleibt erlaubt", async () => {
    await db!.condominiumAssessment.create({ data: assessment() });
    await expect(db!.economicPlan.update({ where: { id: fx.plan.id }, data: { note: "nota" } })).resolves.toBeTruthy();
  });
});
