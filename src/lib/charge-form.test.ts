import { describe, expect, it } from "vitest";
import { chargeSchema, ownerSchema } from "./schemas";

const base = { period: "2026-09-01", dueDate: "2026-09-03", amount: "10" };
describe("manuelle Sollstellung (#52)", () => {
  it("HAUSGELD ist manuell nicht erlaubt", () => {
    expect(chargeSchema.safeParse({ ...base, type: "HAUSGELD", leaseId: "l1" }).success).toBe(false);
  });
  it("jede manuelle Sollstellung braucht einen Vertrag", () => {
    for (const type of ["MIETE", "NEBENKOSTEN", "KAUTION", "SONSTIGES"]) {
      expect(chargeSchema.safeParse({ ...base, type }).success, type).toBe(false);
      expect(chargeSchema.safeParse({ ...base, type, leaseId: "l1" }).success, type).toBe(true);
    }
  });
});
describe("Sollstellungsbetrag (#52)", () => {
  it("Null und negativ sind keine gültigen Beträge", () => {
    expect(chargeSchema.safeParse({ ...base, type: "MIETE", leaseId: "l1", amount: "0" }).success).toBe(false);
    expect(chargeSchema.safeParse({ ...base, type: "MIETE", leaseId: "l1", amount: "-5" }).success).toBe(false);
  });
});
describe("Eigentümer (#52)", () => {
  it("validFrom ist Pflicht", () => {
    expect(ownerSchema.safeParse({ personId: "p", unitId: "u", share: "1000" }).success).toBe(false);
    expect(ownerSchema.safeParse({ personId: "p", unitId: "u", share: "1000", validFrom: "2026-09-01" }).success).toBe(true);
  });
});
