import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";
import { chargeHasHistory, deletePaymentWithAllocations, openChargesForMatching, PaymentError, recordPayment, recordPaymentInTx } from "./payments";
import { QuotaError } from "./quotas/errors";

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

  it("Rückzahlung (AUSGANG) unter dem Nettoeingang wird zugeordnet; eine, die ihn auf 0 brächte, wird abgelehnt", async () => {
    await pay(200);
    const r = await pay(150, { direction: "AUSGANG" });
    expect(r.allocated).toBe(150);
    expect(await openChargesForMatching(t.tenantId, db!)).toEqual([{ id: chargeId, open: 450 }]);
    await expect(pay(500, { direction: "AUSGANG" })).rejects.toMatchObject({ code: "USE_REFUND_AND_CANCEL" });
    expect(await openChargesForMatching(t.tenantId, db!)).toEqual([{ id: chargeId, open: 450 }]);
  });

  it("Teilrückzahlung erlaubt; Rückzahlung, die den Nettoeingang auf 0 brächte, wird ohne Schreiben abgelehnt", async () => {
    await pay(300);
    await expect(pay(100, { direction: "AUSGANG" })).resolves.toMatchObject({ allocated: 100 });
    const before = await db!.payment.count({ where: { tenantId: t.tenantId } });
    await expect(pay(200, { direction: "AUSGANG" })).rejects.toMatchObject({ code: "USE_REFUND_AND_CANCEL" });
    expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(before);
  });

  it("parallel: zwei Rückzahlungen, die zusammen auf 0 kämen — höchstens eine wird angenommen", async () => {
    await pay(200);
    const r = await Promise.allSettled([pay(100, { direction: "AUSGANG" }), pay(100, { direction: "AUSGANG" })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "USE_REFUND_AND_CANCEL" });
  });

  it("recordPaymentInTx schreibt keine abgelehnte Rückzahlung, auch wenn der Aufrufer den Fehler fängt und committet", async () => {
    await pay(200);
    const before = await db!.payment.count({ where: { tenantId: t.tenantId } });
    const caught = await db!.$transaction(async (tx) => {
      try {
        await recordPaymentInTx(tx, { tenantId: t.tenantId, chargeId, date: day, amount: 200, direction: "AUSGANG" });
        return null;
      } catch (e) {
        if (e instanceof QuotaError) return e.code;
        throw e;
      }
    });
    expect(caught).toBe("USE_REFUND_AND_CANCEL");
    expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(before);
  });

  it("Löschen eines Eingangs, das die Sollstellung mit Rückzahlungen auf Nettoeingang 0 brächte, wird ohne Schreiben verweigert", async () => {
    const big = await pay(200);
    await pay(100);
    const refund = await pay(100, { direction: "AUSGANG" });
    const payments = await db!.payment.count({ where: { tenantId: t.tenantId } });
    const allocations = await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } });
    await expect(deletePaymentWithAllocations(t.tenantId, big.paymentId, db!)).rejects.toThrow(/vollständig erstattet/);
    expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(payments);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(allocations);
    // Die Rückzahlung selbst zu löschen erhöht den Nettoeingang — erlaubt.
    expect(await deletePaymentWithAllocations(t.tenantId, refund.paymentId, db!)).toBe(1);
  });

  it("Löschen eines einzelnen Eingangs ohne Rückzahlungen bleibt erlaubt (Korrektur, keine Erstattung)", async () => {
    const r = await pay(200);
    expect(await deletePaymentWithAllocations(t.tenantId, r.paymentId, db!)).toBe(1);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("Zahlungen einer stornierten Sollstellung sind unveränderlich: Löschen (Eingang oder Rückzahlung) verweigert", async () => {
    const inn = await pay(200);
    const out = await pay(50, { direction: "AUSGANG" });
    await db!.charge.update({ where: { id: chargeId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "teste" } });
    await expect(deletePaymentWithAllocations(t.tenantId, out.paymentId, db!)).rejects.toThrow(PaymentError);
    await expect(deletePaymentWithAllocations(t.tenantId, inn.paymentId, db!)).rejects.toThrow(PaymentError);
    expect(await db!.paymentAllocation.count({ where: { chargeId } })).toBe(2);
  });

  it("kein exportierter Weg zum Nullstellen: recordPaymentInTx kennt keinen Umgehungs-Parameter", () => {
    const src = readFileSync("src/lib/payments.ts", "utf8");
    expect(src).not.toMatch(/allowZeroing|allowZero|zeroing/i);
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
    await db!.charge.update({ where: { id: chargeId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Testabbruch" } });
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

  it("Fließkomma-Rundung: Löschen, das die Sollstellung vollständig erstattet ließe, wird verweigert", async () => {
    await pay(0.1);
    const b = await pay(0.2);
    await pay(0.1, { direction: "AUSGANG" });
    await expect(deletePaymentWithAllocations(t.tenantId, b.paymentId, db!)).rejects.toThrow(/vollständig erstattet/);
    const err = await deletePaymentWithAllocations(t.tenantId, b.paymentId, db!).catch((e) => e);
    expect(String(err.message)).not.toMatch(/übersteigen/);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(3);
  });

  it("Grenze: Restnetto 0,01 bleibt löschbar", async () => {
    const b = await pay(0.2);
    await pay(0.11);
    await pay(0.1, { direction: "AUSGANG" });
    expect(await deletePaymentWithAllocations(t.tenantId, b.paymentId, db!)).toBe(1);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(2);
  });

  it("Löschen der Rückzahlung selbst ist erlaubt", async () => {
    await pay(200);
    const refund = await pay(150, { direction: "AUSGANG" });
    expect(await deletePaymentWithAllocations(t.tenantId, refund.paymentId, db!)).toBe(1);
    expect(await db!.paymentAllocation.count({ where: { paymentId: refund.paymentId } })).toBe(0);
  });

  it("chargeHasHistory: Zahlung oder Mahnung zählt", async () => {
    expect(await chargeHasHistory(t.tenantId, chargeId, db!)).toBe(false);
    await db!.dunningNotice.create({ data: { tenantId: t.tenantId, chargeId, level: 1 } });
    expect(await chargeHasHistory(t.tenantId, chargeId, db!)).toBe(true);
  });
});
