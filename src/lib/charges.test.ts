import { describe, expect, it } from "vitest";
import { chargeBalance, chargeLease, chargeSubject } from "./charges";

const alloc = (amount: number, direction: "EINGANG" | "AUSGANG" = "EINGANG") => ({ amount, payment: { direction } });

describe("chargeBalance (#52)", () => {
  it("offen = Betrag − Eingänge + Ausgänge", () => {
    expect(chargeBalance({ amount: 500, status: "ISSUED", allocations: [alloc(200), alloc(100)] })).toEqual({ incoming: 300, outgoing: 0, paid: 300, open: 200 });
  });
  it("eine Rückzahlung (AUSGANG) erhöht den offenen Betrag, zählt nicht als Zahlung", () => {
    expect(chargeBalance({ amount: 500, status: "ISSUED", allocations: [alloc(500), alloc(120, "AUSGANG")] })).toEqual({ incoming: 500, outgoing: 120, paid: 380, open: 120 });
  });
  it("CANCELLED ist nie offen", () => {
    expect(chargeBalance({ amount: 500, status: "CANCELLED", allocations: [] }).open).toBe(0);
  });
  it("Decimal-Strings und Rundung auf Cent", () => {
    expect(chargeBalance({ amount: "0.30", status: "ISSUED", allocations: [{ amount: "0.10", payment: { direction: "EINGANG" } }, { amount: "0.10", payment: { direction: "EINGANG" } }] }).open).toBe(0.1);
  });
});

describe("chargeLease / chargeSubject (#52)", () => {
  const lease = { id: "l1", unit: { label: "1.º Esq." } };
  it("Miete: Vertrag direkt; Fläche: Vertrag der Teilfläche", () => {
    expect(chargeLease({ lease, areaAllocation: null })).toBe(lease);
    expect(chargeLease({ lease: null, areaAllocation: { lease } })).toBe(lease);
    expect(chargeLease({ lease: null, areaAllocation: null })).toBeNull();
  });
  it("Subjekt je Ziel", () => {
    expect(chargeSubject({ lease, areaAllocation: null, quotaDebtorSnapshot: null })).toBe("1.º Esq.");
    expect(chargeSubject({ lease: null, areaAllocation: { label: "Loja", lease }, quotaDebtorSnapshot: null })).toBe("Loja");
    expect(chargeSubject({ lease: null, areaAllocation: null, quotaDebtorSnapshot: { person: { firstName: "Ana", lastName: "Sousa" }, line: { unit: { label: "Fração A" } } } })).toBe("Fração A · Ana Sousa");
  });
});
