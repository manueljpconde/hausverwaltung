import { describe, expect, it } from "vitest";
import { QuotaError } from "./errors";
import { issueInputSchema, parseOrThrow } from "./input";

const bad: [string, Record<string, unknown>][] = [
  ["kind desconhecido", { kind: "ORDNARY", month: "2026-05" }],
  ["method desconhecido", { kind: "ORDINARY", month: "2026-05", method: "EQUAL" }],
  ["mês 13", { kind: "ORDINARY", month: "2026-13" }],
  ["dueDay não numérico", { kind: "ORDINARY", month: "2026-05", dueDay: "abc" }],
  ["dueDay 29", { kind: "ORDINARY", month: "2026-05", dueDay: 29 }],
  ["ordinária com totalCents", { kind: "ORDINARY", month: "2026-05", totalCents: 1000 }],
  ["ordinária com description", { kind: "ORDINARY", month: "2026-05", description: "x" }],
  ["ordinária com resolutionId", { kind: "ORDINARY", month: "2026-05", resolutionId: "r" }],
  ["extraordinária sem asOf", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 1000, dueDate: new Date(), description: "x" }],
  ["totalCents fraccionário", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 10.5, asOf: new Date(), dueDate: new Date(), description: "x" }],
  ["totalCents 0", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 0, asOf: new Date(), dueDate: new Date(), description: "x" }],
  ["data inválida", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 1000, asOf: new Date("x"), dueDate: new Date(), description: "x" }],
  ["CUSTOM sem mapa", { kind: "ORDINARY", month: "2026-05", method: "CUSTOM" }],
];

describe("issueInputSchema (#52 R2)", () => {
  for (const [label, input] of bad) {
    it(`${label} → INVALID_INPUT`, () => {
      expect(issueInputSchema.safeParse({ propertyId: "p", ...input }).success).toBe(false);
      try {
        parseOrThrow(issueInputSchema, { propertyId: "p", ...input });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(QuotaError);
        expect((e as QuotaError).code).toBe("INVALID_INPUT");
        expect(Array.isArray((e as QuotaError).details)).toBe(true);
      }
    });
  }

  it("ordinária mínima: method por omissão PERMILLAGE", () => {
    expect(parseOrThrow(issueInputSchema, { propertyId: "p", kind: "ORDINARY", month: "2026-05" }))
      .toEqual({ propertyId: "p", kind: "ORDINARY", month: "2026-05", method: "PERMILLAGE" });
  });

  it("extraordinária mínima: method por omissão PERMILLAGE", () => {
    const d = new Date(Date.UTC(2026, 6, 1));
    expect(parseOrThrow(issueInputSchema, { propertyId: "p", kind: "EXTRAORDINARY", month: "2026-07", totalCents: 1000, asOf: d, dueDate: d, description: "Obras" }))
      .toEqual({ propertyId: "p", kind: "EXTRAORDINARY", month: "2026-07", method: "PERMILLAGE", totalCents: 1000, asOf: d, dueDate: d, description: "Obras" });
  });
});
