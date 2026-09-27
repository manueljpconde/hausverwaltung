import { expect, it } from "vitest";
import { describeDb, integrationDb as db } from "./test-db";
import { deleteTenantData } from "./tenant-deletion";
import { recordPayment } from "./payments";

describeDb("Mandant löschen (#52)", () => {
  it("entfernt Sollstellungen, Zahlungen, Zuordnungen, Mahnungen und die ganze Quota-Kette — keine Waisen", async () => {
    const tenant = await db!.tenant.create({ data: { name: `del-${crypto.randomUUID()}` } });
    const tenantId = tenant.id;
    const property = await db!.property.create({ data: { tenantId, name: "P", street: "S", zip: "1", city: "L" } });
    const building = await db!.building.create({ data: { tenantId, propertyId: property.id, name: "B" } });
    const unit = await db!.unit.create({ data: { tenantId, buildingId: building.id, label: "A", area: 50 } });
    const lease = await db!.lease.create({ data: { tenantId, unitId: unit.id, startDate: new Date("2026-01-01"), rentCold: 500 } });
    const d = new Date("2026-09-01");
    const charge = await db!.charge.create({ data: { tenantId, leaseId: lease.id, type: "MIETE", period: d, dueDate: d, amount: 500 } });
    await recordPayment({ tenantId, chargeId: charge.id, date: d, amount: 200, direction: "EINGANG" }, db!);
    const account = await db!.account.create({ data: { tenantId, name: "Konto" } });
    await recordPayment({ tenantId, accountId: account.id, date: d, amount: 20, direction: "AUSGANG" }, db!);
    await db!.dunningNotice.create({ data: { tenantId, chargeId: charge.id, level: 1 } });
    // vollständige Quota-Kette mit Zahlung
    const person = await db!.person.create({ data: { tenantId, firstName: "Ana", lastName: "Teste" } });
    const assessment = await db!.condominiumAssessment.create({ data: { tenantId, propertyId: property.id, period: d, kind: "ORDINARY", method: "PERMILLAGE", dueDate: d, asOf: d, totalCents: 5000, requestKey: "k" } });
    const line = await db!.condominiumAssessmentLine.create({ data: { tenantId, assessmentId: assessment.id, unitId: unit.id, amountCents: 5000 } });
    const snap = await db!.quotaDebtorSnapshot.create({ data: { tenantId, lineId: line.id, personId: person.id, shareSnapshot: 1000, amountCents: 5000 } });
    const quota = await db!.charge.create({ data: { tenantId, quotaDebtorSnapshotId: snap.id, type: "HAUSGELD", period: d, dueDate: d, amount: 50 } });
    await recordPayment({ tenantId, chargeId: quota.id, date: d, amount: 50, direction: "EINGANG" }, db!);

    await deleteTenantData(tenantId, db!);

    expect(await db!.tenant.count({ where: { id: tenantId } })).toBe(0);
    const counts = await Promise.all([
      db!.charge.count({ where: { tenantId } }), db!.payment.count({ where: { tenantId } }), db!.paymentAllocation.count({ where: { tenantId } }),
      db!.dunningNotice.count({ where: { tenantId } }), db!.condominiumAssessment.count({ where: { tenantId } }),
      db!.condominiumAssessmentLine.count({ where: { tenantId } }), db!.quotaDebtorSnapshot.count({ where: { tenantId } }),
      db!.person.count({ where: { tenantId } }), db!.lease.count({ where: { tenantId } }), db!.unit.count({ where: { tenantId } }),
      db!.account.count({ where: { tenantId } }),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
