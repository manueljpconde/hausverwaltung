import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";
import { deletePaymentWithAllocations, openChargesForMatching, PaymentError, recordPayment } from "./payments";

let t: Awaited<ReturnType<typeof createTestTenant>>;
let chargeId: string;
const day = new Date(Date.UTC(2026, 8, 3));

describeDb("recordPayment (#52)", () => {
  beforeEach(async () => {
    t = await createTestTenant();
    const property = await db!.property.create({ data: { tenantId: t.tenantId, name: "P", street: "S", zip: "1", city: "L" } });
    const building = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: property.id, name: "B" } });
    const unit = await db!.unit.create({ data: { tenantId: t.tenantId, buildingId: building.id, label: "A", area: 50 } });
    const lease = await db!.lease.create({ data: { tenantId: t.tenantId, unitId: unit.id, startDate: day, rentCold: 500 } });
    chargeId = (await db!.charge.create({ data: { tenantId: t.tenantId, leaseId: lease.id, type: "MIETE", period: day, dueDate: day, amount: 500 } })).id;
  });
  afterEach(() => t.cleanup());

  const pay = (amount: number, over: object = {}) =>
    recordPayment({ tenantId: t.tenantId, chargeId, date: day, amount, direction: "EINGANG", ...over }, db!);

  it("ordnet die Zahlung der Sollstellung zu", async () => {
    const r = await pay(200);
    expect(r.allocated).toBe(200);
    expect(await openChargesForMatching(t.tenantId, db!)).toEqual([{ id: chargeId, open: 300 }]);
  });

  it("Überzahlung: nur bis zum offenen Betrag, Rest bleibt unzugeordnet", async () => {
    await pay(400);
    const r = await pay(300);
    expect(r.allocated).toBe(100);
    const p = await db!.payment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect(Number(p.amount)).toBe(300);
  });

  it("Rückzahlung (AUSGANG) höchstens bis zum Nettoeingang", async () => {
    await pay(200);
    const r = await pay(500, { direction: "AUSGANG" });
    expect(r.allocated).toBe(200);
    expect(await openChargesForMatching(t.tenantId, db!)).toEqual([{ id: chargeId, open: 500 }]);
  });

  it("parallele Zahlungen überschreiten den offenen Betrag nie (Lock)", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => pay(200)));
    expect(results.reduce((s, r) => s + r.allocated, 0)).toBe(500);
  });

  it("fremde oder stornierte Sollstellung wird abgelehnt", async () => {
    const other = await createTestTenant();
    try {
      await expect(recordPayment({ tenantId: other.tenantId, chargeId, date: day, amount: 10, direction: "EINGANG" }, db!)).rejects.toBeInstanceOf(PaymentError);
    } finally {
      await other.cleanup();
    }
    await db!.charge.update({ where: { id: chargeId }, data: { status: "CANCELLED" } });
    await expect(pay(10)).rejects.toBeInstanceOf(PaymentError);
  });

  it("ohne Sollstellung: nur die Kontobewegung", async () => {
    const r = await recordPayment({ tenantId: t.tenantId, date: day, amount: 50, direction: "AUSGANG" }, db!);
    expect(r.allocated).toBe(0);
    expect(await db!.paymentAllocation.count({ where: { paymentId: r.paymentId } })).toBe(0);
  });

  it("Löschen einer Zahlung entfernt ihre Zuordnungen", async () => {
    const r = await pay(200);
    expect(await deletePaymentWithAllocations(t.tenantId, r.paymentId, db!)).toBe(1);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("Konto eines anderen Mandanten wird abgelehnt", async () => {
    const other = await createTestTenant();
    const account = await db!.account.create({ data: { tenantId: other.tenantId, name: "Fremdkonto" } });
    try {
      await expect(
        recordPayment({ tenantId: t.tenantId, accountId: account.id, date: day, amount: 50, direction: "EINGANG" }, db!),
      ).rejects.toBeInstanceOf(PaymentError);
      expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(0);
    } finally {
      await db!.account.delete({ where: { id: account.id } });
      await other.cleanup();
    }
  });

  it("Löschen einer Zahlung wird abgelehnt, wenn danach Rückzahlungen die Eingänge übersteigen", async () => {
    const r = await pay(200);
    await pay(150, { direction: "AUSGANG" });
    await expect(deletePaymentWithAllocations(t.tenantId, r.paymentId, db!)).rejects.toBeInstanceOf(PaymentError);
    expect(await db!.payment.count({ where: { id: r.paymentId } })).toBe(1);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(2);
  });

  it("Löschen der Rückzahlung selbst ist erlaubt", async () => {
    await pay(200);
    const refund = await pay(150, { direction: "AUSGANG" });
    expect(await deletePaymentWithAllocations(t.tenantId, refund.paymentId, db!)).toBe(1);
    expect(await db!.paymentAllocation.count({ where: { paymentId: refund.paymentId } })).toBe(0);
  });
});
