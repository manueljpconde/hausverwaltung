import { describe, expect, it } from "vitest";
import { allocateCents, computeLines, monthlyFromAnnual, requestKey, resolveHolders } from "./compute";
import { QuotaError } from "./errors";

const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);

describe("allocateCents (#52 R2)", () => {
  it("verteilt exakt nach größtem Rest, nur ganze Cent", () => {
    const r = allocateCents(10000, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }]);
    expect(sum(r)).toBe(10000);
    expect(r.map((x) => x.amountCents)).toEqual([3334, 3333, 3333]);
    expect(r.every((x) => Number.isInteger(x.amountCents))).toBe(true);
  });
  it("Gleichstand: Reihenfolge der Eingabe entscheidet", () => {
    expect(allocateCents(1, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }])).toEqual([{ id: "a", amountCents: 1 }, { id: "b", amountCents: 0 }]);
  });
  it("lehnt Nicht-Ganzzahlen und leere Gewichte ab", () => {
    expect(() => allocateCents(10.5, [{ id: "a", weight: 1 }])).toThrow(QuotaError);
    expect(() => allocateCents(100, [{ id: "a", weight: 0 }])).toThrow(QuotaError);
    expect(() => allocateCents(100, [{ id: "a", weight: 1.5 }, { id: "b", weight: 1 }])).toThrow(QuotaError);
  });
});

describe("monthlyFromAnnual (#52 R2)", () => {
  it("Monate 1–11 gerundet, Monat 12 = Rest; Summe = Jahr", () => {
    const annual = 100001;
    const months = Array.from({ length: 12 }, (_, i) => monthlyFromAnnual(annual, i + 1));
    expect(months.slice(0, 11).every((m) => m === 8333)).toBe(true);
    expect(months[11]).toBe(100001 - 11 * 8333);
    expect(months.reduce((a, b) => a + b, 0)).toBe(annual);
  });
});

describe("computeLines (#52 R2)", () => {
  const units = [{ id: "u2", mea: 600 }, { id: "u1", mea: 400 }];
  it("PERMILLAGE nach mea, nach unitId sortiert, exakte Summe", () => {
    expect(computeLines({ totalCents: 1000, method: "PERMILLAGE", units, meaTotal: 1000 })).toEqual([
      { unitId: "u1", amountCents: 400 }, { unitId: "u2", amountCents: 600 },
    ]);
  });
  it("PERMILLAGE: mea null/0 oder Summe ≠ meaTotal → MEA_INVALID, keine Einheit wird ausgelassen", () => {
    for (const bad of [[{ id: "u1", mea: null }, { id: "u2", mea: 1000 }], [{ id: "u1", mea: 0 }, { id: "u2", mea: 1000 }], [{ id: "u1", mea: 400 }, { id: "u2", mea: 500 }]]) {
      try { computeLines({ totalCents: 1000, method: "PERMILLAGE", units: bad, meaTotal: 1000 }); throw new Error("no throw"); }
      catch (e) { expect((e as QuotaError).code).toBe("MEA_INVALID"); }
    }
  });
  it("FIXED: teilbar ok, sonst FIXED_NOT_DIVISIBLE; ordentlich: Jahr durch 12·n", () => {
    expect(computeLines({ totalCents: 1000, method: "FIXED", units, meaTotal: 1000 }).map((l) => l.amountCents)).toEqual([500, 500]);
    expect(() => computeLines({ totalCents: 1001, method: "FIXED", units, meaTotal: 1000 })).toThrow(/FIXED_NOT_DIVISIBLE/);
    expect(() => computeLines({ totalCents: 1000, method: "FIXED", units, meaTotal: 1000, annualCents: 12001 })).toThrow(/FIXED_NOT_DIVISIBLE/);
  });
  it("CUSTOM: vollständig, ohne Duplikate, Summe = Total; Nullen erlaubt", () => {
    expect(computeLines({ totalCents: 1000, method: "CUSTOM", units, meaTotal: 1000, custom: { u1: 0, u2: 1000 } })).toEqual([
      { unitId: "u1", amountCents: 0 }, { unitId: "u2", amountCents: 1000 },
    ]);
    const customs: Record<string, number>[] = [{ u1: 1000 }, { u1: 500, u2: 400 }, { u1: 500, u2: 500, x: 0 }];
    for (const custom of customs) {
      expect(() => computeLines({ totalCents: 1000, method: "CUSTOM", units, meaTotal: 1000, custom })).toThrow(/CUSTOM_INVALID/);
    }
  });
});

describe("resolveHolders (#52 R2)", () => {
  const d = (s: string) => new Date(s);
  const cutover = d("2026-01-01T00:00:00Z");
  it("CONFIRMED, die asOf überdecken; Summe 1000", () => {
    const r = resolveHolders([
      { personId: "p1", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p2", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p3", share: 1000, vigencia: "UNKNOWN", validFrom: null, validTo: null },
    ], d("2026-05-01"), cutover);
    expect(r).toEqual([{ personId: "p1", share: 500 }, { personId: "p2", share: 500 }]);
  });
  it("UNKNOWN nur ab Stichtag und mit validTo null", () => {
    const owners = [{ personId: "p3", share: 1000, vigencia: "UNKNOWN" as const, validFrom: null, validTo: null }];
    expect(resolveHolders(owners, d("2026-05-01"), cutover)).toEqual([{ personId: "p3", share: 1000 }]);
    expect(resolveHolders(owners, d("2025-05-01"), cutover)).toHaveProperty("error");
    expect(resolveHolders(owners, d("2026-05-01"), null)).toHaveProperty("error");
  });
  it("Summe ≠ 1000 → Fehler", () => {
    expect(resolveHolders([{ personId: "p1", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null }], d("2026-05-01"), cutover)).toHaveProperty("error");
  });
});

describe("requestKey (#52 R2)", () => {
  it("stabil, CUSTOM-Reihenfolge egal, Parameter ändern den Schlüssel", () => {
    const base = { kind: "ORDINARY", period: new Date("2026-05-01T00:00:00Z"), method: "CUSTOM", dueDate: new Date("2026-05-08T00:00:00Z"), asOf: new Date("2026-05-01T00:00:00Z"), totalCents: 1000 };
    expect(requestKey({ ...base, custom: { a: 1, b: 2 } })).toBe(requestKey({ ...base, custom: { b: 2, a: 1 } }));
    expect(requestKey({ ...base, custom: { a: 1, b: 2 } })).not.toBe(requestKey({ ...base, dueDate: new Date("2026-05-09T00:00:00Z"), custom: { a: 1, b: 2 } }));
  });
});

// #52 R2 Hardening (Runde 2): Grenzfälle aus dem Review.

describe("allocateCents Grenzfälle (#52 R2 Hardening)", () => {
  it("lehnt leere parts, negative Gewichte und unsichere Ganzzahlen ab", () => {
    expect(() => allocateCents(100, [])).toThrow(QuotaError);
    expect(() => allocateCents(100, [{ id: "a", weight: -1 }, { id: "b", weight: 1 }])).toThrow(QuotaError);
    expect(() => allocateCents(2 ** 53, [{ id: "a", weight: 1 }])).toThrow(QuotaError);
    expect(() => allocateCents(100, [{ id: "a", weight: 2 ** 53 }])).toThrow(QuotaError);
  });
  it("Gleichstand nach größtem Rest, dann Eingabereihenfolge — je nach Gewicht wechselt der Gewinner", () => {
    expect(allocateCents(10, [{ id: "a", weight: 1 }, { id: "b", weight: 2 }])).toEqual([{ id: "a", amountCents: 3 }, { id: "b", amountCents: 7 }]);
    expect(allocateCents(10, [{ id: "a", weight: 2 }, { id: "b", weight: 1 }])).toEqual([{ id: "a", amountCents: 7 }, { id: "b", amountCents: 3 }]);
  });
});

describe("monthlyFromAnnual Grenzfälle (#52 R2 Hardening)", () => {
  it("validiert annualCents (sicher, ≥0) und month (Ganzzahl 1–12)", () => {
    expect(() => monthlyFromAnnual(100, 0)).toThrow(QuotaError);
    expect(() => monthlyFromAnnual(100, 13)).toThrow(QuotaError);
    expect(() => monthlyFromAnnual(100, 1.5)).toThrow(QuotaError);
    expect(() => monthlyFromAnnual(-1, 1)).toThrow(QuotaError);
    expect(() => monthlyFromAnnual(2 ** 53, 1)).toThrow(QuotaError);
  });
  it("Monat 12 darf nie negativ werden", () => {
    expect(() => monthlyFromAnnual(6, 12)).toThrow(QuotaError);
  });
  it("Aufrundungsfall: Monat 12 < base, Summe bleibt trotzdem korrekt", () => {
    const annual = 100007;
    const base = 8334;
    expect(monthlyFromAnnual(annual, 1)).toBe(base);
    expect(monthlyFromAnnual(annual, 12)).toBe(annual - 11 * base);
    const months = Array.from({ length: 12 }, (_, i) => monthlyFromAnnual(annual, i + 1));
    expect(months.reduce((a, b) => a + b, 0)).toBe(annual);
  });
});

describe("computeLines Grenzfälle (#52 R2 Hardening)", () => {
  const units = [{ id: "u2", mea: 600 }, { id: "u1", mea: 400 }];
  it("totalCents muss eine sichere, nicht-negative Ganzzahl sein", () => {
    expect(() => computeLines({ totalCents: -1000, method: "FIXED", units, meaTotal: 1000 })).toThrow(/INVALID_INPUT/);
    expect(() => computeLines({ totalCents: 10.5, method: "FIXED", units, meaTotal: 1000 })).toThrow(/INVALID_INPUT/);
  });
  it("doppelte unitId → INVALID_INPUT", () => {
    const dup = [{ id: "u1", mea: 400 }, { id: "u1", mea: 600 }];
    expect(() => computeLines({ totalCents: 1000, method: "PERMILLAGE", units: dup, meaTotal: 1000 })).toThrow(/INVALID_INPUT/);
  });
  it("CUSTOM: hasOwn statt in — unitId 'constructor' fehlt im custom-Objekt → CUSTOM_INVALID trotz geerbter Prototype-Eigenschaft", () => {
    const us = [{ id: "constructor", mea: 400 }, { id: "u2", mea: 600 }];
    expect(() => computeLines({ totalCents: 1000, method: "CUSTOM", units: us, meaTotal: 1000, custom: { u2: 1000 } })).toThrow(/CUSTOM_INVALID/);
  });
  it("CUSTOM: Number.isSafeInteger für Werte — 2**53, negativ oder nicht ganzzahlig → CUSTOM_INVALID", () => {
    const us = [{ id: "u1", mea: 400 }, { id: "u2", mea: 600 }];
    for (const custom of [{ u1: 2 ** 53, u2: 0 }, { u1: -1, u2: 1001 }, { u1: 0.5, u2: 999.5 }] as Record<string, number>[]) {
      expect(() => computeLines({ totalCents: 1000, method: "CUSTOM", units: us, meaTotal: 1000, custom })).toThrow(/CUSTOM_INVALID/);
    }
  });
});

describe("resolveHolders Grenzfälle (#52 R2 Hardening)", () => {
  const d = (s: string) => new Date(s);
  const cutover = d("2026-01-01T00:00:00Z");
  it("Anteil außerhalb 0–1000 oder nicht ganzzahlig → Fehler, auch wenn die Summe 1000 ergibt", () => {
    expect(resolveHolders([
      { personId: "p1", share: 1500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p2", share: -500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
    ], d("2026-05-01"), cutover)).toHaveProperty("error");
    expect(resolveHolders([
      { personId: "p1", share: 500.5, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p2", share: 499.5, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
    ], d("2026-05-01"), cutover)).toHaveProperty("error");
    expect(resolveHolders([
      { personId: "p1", share: 0, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p2", share: 1000, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
    ], d("2026-05-01"), cutover)).toHaveProperty("error");
  });
  it("Randfälle: validTo exklusiv, validFrom inklusiv, Stichtag inklusiv, UNKNOWN mit validTo≠null, doppelte personId", () => {
    const p1Full = { personId: "p1", share: 1000, vigencia: "CONFIRMED" as const, validFrom: d("2020-01-01"), validTo: d("2026-05-01") };
    expect(resolveHolders([p1Full], d("2026-05-01"), cutover)).toHaveProperty("error");
    expect(resolveHolders([{ ...p1Full, validTo: null, validFrom: d("2026-05-01") }], d("2026-05-01"), cutover)).toEqual([{ personId: "p1", share: 1000 }]);
    const unknown = { personId: "p3", share: 1000, vigencia: "UNKNOWN" as const, validFrom: null, validTo: null };
    expect(resolveHolders([unknown], cutover, cutover)).toEqual([{ personId: "p3", share: 1000 }]);
    expect(resolveHolders([{ ...unknown, validTo: d("2026-06-01") }], d("2026-05-01"), cutover)).toHaveProperty("error");
    expect(resolveHolders([
      { personId: "p1", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p1", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
    ], d("2026-05-01"), cutover)).toHaveProperty("error");
  });
});

describe("requestKey Grenzfälle (#52 R2 Hardening)", () => {
  const base = { kind: "ORDINARY", period: new Date("2026-05-01T00:00:00Z"), method: "CUSTOM", dueDate: new Date("2026-05-08T00:00:00Z"), asOf: new Date("2026-05-01T00:00:00Z"), totalCents: 1000, custom: { a: 1, b: 2 } };
  it("CUSTOM-Kodierung ohne Ambiguität: {'a=1,b':2} und {a:1,b:2} liefern unterschiedliche Schlüssel", () => {
    const ambiguous = { ...base, custom: { "a=1,b": 2 } };
    const clean = { ...base, custom: { a: 1, b: 2 } };
    expect(requestKey(ambiguous)).not.toBe(requestKey(clean));
  });
  it("description, resolutionId oder ein custom-Wert ändern jeweils den Schlüssel", () => {
    expect(requestKey(base)).not.toBe(requestKey({ ...base, description: "x" }));
    expect(requestKey(base)).not.toBe(requestKey({ ...base, resolutionId: "r1" }));
    expect(requestKey(base)).not.toBe(requestKey({ ...base, custom: { a: 2, b: 2 } }));
  });
});
