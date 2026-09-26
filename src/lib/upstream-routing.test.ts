import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #7: Nutzer dieser Instanz dürfen nicht zu Upstream (fgilde) geleitet werden —
// weder Fehlerberichte noch Kontakt-/Supportanfragen.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("keine Weiterleitung von Nutzern zu Upstream (#7)", () => {
  it("Info-Drawer verlinkt weder Upstream-Doku, -Webseite noch -Issues", () => {
    const src = read("src/components/info-drawer.tsx");
    for (const target of ["fgilde.github.io", "github.com/fgilde", "havewa.app"]) {
      expect(src).not.toContain(target);
    }
  });

  it("Beta-Hinweis verweist nicht auf den entfernten Issue-Link", () => {
    for (const locale of ["de", "en"]) {
      const about = JSON.parse(read(`messages/${locale}.json`)).about;
      expect(about.issues).toBeUndefined();
      expect(about.betaNote).not.toMatch(/issue/i);
    }
  });

  it("Marketing-Seite hat keinen Kontakt-/Supportkanal zu Upstream", () => {
    const html = read("public/marketing/index.html");
    for (const target of ["connect.gilde.org", "<gilde-contact", "<gilde-support", "hausverwaltung@gilde.org"]) {
      expect(html).not.toContain(target);
    }
  });
});
