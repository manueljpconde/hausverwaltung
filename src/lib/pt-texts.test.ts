import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { showHeatingCostNotes } from "./market";

// #25: Die portugiesische Oberfläche nennt kein deutsches Recht (Übergangslösung bis
// rechtliche Texte am Tenant.market hängen).
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const strings = (o: unknown, path = ""): [string, string][] =>
  typeof o === "string"
    ? [[path, o]]
    : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));

describe("pt ohne deutsches Recht (#25)", () => {
  it("keine BetrKV, HeizkostenV, GoBD oder MEA in pt.json", () => {
    const hits = strings(JSON.parse(read("messages/pt.json"))).filter(([, s]) =>
      /BetrKV|HeizkostenV|GoBD|\bMEA\b/.test(s),
    );
    expect(hits).toEqual([]);
  });

  it("Login-Fußzeile ohne Compliance-Werbeaussage, in keiner Sprache", () => {
    const login = read("src/app/[locale]/login/page.tsx");
    expect(login).not.toMatch(/DSGVO|GoBD|login\.compliance/);
    for (const locale of ["de", "en", "pt"]) {
      expect(JSON.parse(read(`messages/${locale}.json`)).login.compliance).toBeUndefined();
    }
  });

  it("Heizkosten-Hinweise (deutsches Recht) nur außerhalb des PT-Markts", () => {
    expect(showHeatingCostNotes("DE")).toBe(true);
    expect(showHeatingCostNotes("PT")).toBe(false);
    for (const page of ["src/app/[locale]/print/statement/page.tsx", "src/app/[locale]/(admin)/statements/page.tsx"]) {
      expect(read(page)).toContain("showHeatingCostNotes(");
    }
    for (const locale of ["de", "en", "pt"]) {
      const m = JSON.parse(read(`messages/${locale}.json`));
      expect(m.statements.heatingHint).toBeTruthy();
      expect(m.statements.hint).not.toMatch(/Heiz|heating|aquecimento/i);
    }
  });
});
