import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SOURCE_REPO, sourceUrl, licenseUrl } from "./version";

// #14: AGPL-3.0 — jede Nutzerin im Netz muss den Quellcode der laufenden Version angeboten
// bekommen (§13) und die rechtlichen Hinweise sehen (§5d).
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("AGPL-3.0: Quellcode-Angebot und rechtliche Hinweise (#14)", () => {
  it("Quellcode-Link zeigt auf exakt den laufenden Commit dieses Forks", () => {
    expect(SOURCE_REPO).toBe("https://github.com/manueljpconde/hausverwaltung");
    expect(sourceUrl("abc1234")).toBe(`${SOURCE_REPO}/tree/abc1234`);
    expect(sourceUrl("")).toBe(SOURCE_REPO);
    expect(licenseUrl("abc1234")).toBe(`${SOURCE_REPO}/blob/abc1234/LICENSE`);
    expect(licenseUrl("")).toBe(`${SOURCE_REPO}/blob/main/LICENSE`);
  });

  it("Hinweistexte nennen Upstream-Copyright, Änderungen und AGPL ohne Gewährleistung", () => {
    for (const locale of ["de", "en"]) {
      const legal = JSON.parse(read(`messages/${locale}.json`)).legal;
      expect(legal.copyright).toContain("Florian Gilde");
      expect(legal.copyright).toContain("CRMware");
      expect(legal.warranty).toMatch(/Affero General Public License/);
      expect(legal.source).toBeTruthy();
      expect(legal.license).toMatch(/AGPL-3\.0/);
    }
  });

  it("Info-Drawer (Verwaltung und Portal) zeigt alle Hinweise und beide Links", () => {
    const src = read("src/components/info-drawer.tsx");
    for (const needle of ["SOURCE_URL", "LICENSE_URL", 'legal("copyright"', 'legal("warranty")', 'legal("source")', 'legal("license")']) {
      expect(src).toContain(needle);
    }
  });

  it("Login-Seite bietet Quellcode und Lizenz schon vor der Anmeldung an", () => {
    const src = read("src/app/[locale]/login/page.tsx");
    for (const needle of ["SOURCE_URL", "LICENSE_URL", 't("legal.source")', 't("legal.license")']) {
      expect(src).toContain(needle);
    }
  });
});
