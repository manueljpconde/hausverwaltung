import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchOpenCharge, unappliedPart } from "./payments";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("Zahlungs-Schreiber (#52)", () => {
  it("kein Code schreibt mehr payment.create/deleteMany direkt, außer payments.ts und Seeds", () => {
    for (const f of ["src/server/actions/finances.ts", "src/server/actions/banking.ts", "src/lib/api-ops.ts", "src/lib/api-write.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/\.payment\.(create|deleteMany|delete)\(/);
    }
  });

  it("Abgleich per Betrag verbraucht den Treffer", () => {
    const open = [{ id: "a", open: 100 }, { id: "b", open: 50 }];
    expect(matchOpenCharge(open, 50)).toBe("b");
    expect(matchOpenCharge(open, 50)).toBeNull();
    expect(matchOpenCharge(open, 100.004)).toBe("a");
  });

  it("manuelle Überzahlung meldet den nicht zugeordneten Rest", () => {
    expect(unappliedPart(300, 100, "c1")).toEqual({ applied: 100, unapplied: 200 });
    expect(unappliedPart(300, 300, "c1")).toBeNull();
    expect(unappliedPart(300, 0, null)).toBeNull();
    const src = read("src/server/actions/finances.ts");
    expect(src).toMatch(/unappliedPart\(/);
    expect(src).toMatch(/partiallyApplied/);
  });

  it("deleteCharge (UI und API) prüft Zahlungen UND Mahnungen", () => {
    expect(read("src/server/actions/finances.ts")).toMatch(/chargeHasHistory\(/);
    expect(read("src/lib/api-write.ts")).toMatch(/chargeHasHistory\(/);
  });

  it("generische API: Zahlung und Sollstellung haben eigene Pfade", () => {
    const src = read("src/lib/api-write.ts");
    expect(src).toMatch(/special: "payment"/);
    expect(src).toMatch(/special === "payment"[\s\S]*recordPayment/);
    expect(src).toMatch(/deletePaymentWithAllocations/);
    // #52 R2: USE_REFUND_AND_CANCEL wird wie PaymentError als Client-Fehler gemeldet, nicht als 500.
    expect(src).toMatch(/special === "payment"[\s\S]*?e instanceof QuotaError && e\.code === "USE_REFUND_AND_CANCEL"/);
  });

  it("camt-Import überspringt Nullbeträge vor dem Abgleich/Buchen (Fix-Runde 1)", () => {
    for (const [f, loopMarker] of [
      ["src/server/actions/finances.ts", /for \(const e of entries\) \{[\s\S]*?\n {2}\}/],
      ["src/lib/api-ops.ts", /for \(const e of entries\) \{[\s\S]*?\n {6}\}/],
    ] as const) {
      const src = read(f);
      const loop = src.match(loopMarker)?.[0] ?? "";
      expect(loop, f).toMatch(/e\.amount <= 0/);
    }
  });
});
