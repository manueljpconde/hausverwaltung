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
      expect(legal.copyright).toContain("CrmWare");
      expect(legal.warranty).toMatch(/Affero General Public License/);
      expect(legal.source).toBeTruthy();
      expect(legal.license).toMatch(/AGPL-3\.0/);
      expect(legal.notice).toBeTruthy();
    }
  });

  it("Seite „Aviso legal“ zeigt Copyright, Gewährleistungsausschluss, Lizenz und Quellcode", () => {
    const src = read("src/app/[locale]/legal/page.tsx");
    for (const needle of ["SOURCE_URL", "LICENSE_URL", 't("legal.copyright")', 't("legal.warranty")', 't("legal.source")', 't("legal.license")', 't("legal.notice")']) {
      expect(src).toContain(needle);
    }
    // öffentlich: kein Login-Zwang (auch für Portal-Nutzer vor der Anmeldung)
    expect(src).not.toMatch(/requireUser|auth\(\)/);
  });

  it("Info-Drawer (Verwaltung und Portal): Aviso legal aufklappbar im Drawer, ohne Seitenwechsel; kein Gilde-Kasten", () => {
    const src = read("src/components/info-drawer.tsx");
    for (const needle of ["SOURCE_URL", "LICENSE_URL", "<details", "<summary", 'legal("notice")', 'legal("copyright")', 'legal("warranty")', 'legal("source")', 'legal("license")']) {
      expect(src).toContain(needle);
    }
    expect(src).not.toContain('href="/legal"');
    expect(src).not.toMatch(/gilde|madeBy/i);
    for (const locale of ["de", "en", "pt"]) {
      expect(JSON.parse(read(`messages/${locale}.json`)).about.madeBy).toBeUndefined();
    }
  });

  it("Login-Seite zeigt keine AGPL-Links (Angebot bleibt über /legal und Info-Drawer)", () => {
    const src = read("src/app/[locale]/login/page.tsx");
    for (const needle of ["SOURCE_URL", "LICENSE_URL", 't("legal.source")', 't("legal.license")', 'href="/legal"', 't("legal.notice")']) {
      expect(src).not.toContain(needle);
    }
  });
});
