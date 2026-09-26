import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { APP_NAME, APP_SLUG } from "./brand";

// #18: Der sichtbare Produktname kommt aus genau einer Stelle (brand.ts), damit eine
// Umbenennung eine Einzeilen-Änderung ist.
const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

// Kommentare entfernen; "//" nur am Zeilenanfang oder nach Leerraum (nicht in URLs).
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

// Interne Bezeichner, die bewusst bleiben: Änderung würde Daten/Sitzungen brechen bzw. Demo-Seeds.
const ALLOWED = ["havewa-secret-v1", "havewa-dev-secret-change-me", "havewa_acting_tenant", "@havewa.app"];

describe("Produktname aus einer Quelle (#18)", () => {
  it("brand.ts definiert Anzeigename und Slug", () => {
    expect(APP_NAME).toBeTruthy();
    expect(APP_SLUG).toMatch(/^[a-z0-9-]+$/);
  });

  it("Texte nutzen {app} statt eines festen Namens", () => {
    for (const locale of ["de", "en"]) {
      const m = JSON.parse(read(`messages/${locale}.json`));
      expect(m.app.name).toBeUndefined();
      for (const text of [m.about.title, m.about.betaNote, m.setup.welcomeTitle]) {
        expect(text).toContain("{app}");
      }
      // Einzige erlaubte Nennung: das Originalwerk im AGPL-Hinweis — fest, ohne {app},
      // sonst stünde dort bei unverändertem Namen "HaVeWa basiert auf HaVeWa".
      const { copyright, ...legalRest } = m.legal;
      expect(copyright).toContain("Florian Gilde (HaVeWa)");
      expect(copyright).not.toContain("{app}");
      expect(JSON.stringify({ ...m, legal: legalRest })).not.toContain("HaVeWa");
    }
  });

  it("kein fester Produktname im Quellcode (src/, prisma/) außerhalb von brand.ts", () => {
    const list = (dir: string) =>
      (readdirSync(new URL(`${dir}/`, root), { recursive: true }) as string[]).map((f) => `${dir}/${f}`);
    const files = [...list("src"), ...list("prisma")].filter(
      (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== "src/lib/brand.ts",
    );
    const hits: string[] = [];
    for (const f of files) {
      let code = stripComments(read(f));
      for (const ok of ALLOWED) code = code.split(ok).join("");
      if (/havewa/i.test(code)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
