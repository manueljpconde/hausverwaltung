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
    for (const locale of ["de", "en", "pt"]) {
      const m = JSON.parse(read(`messages/${locale}.json`));
      expect(m.app.name).toBeUndefined();
      for (const text of [m.about.title, m.setup.welcomeTitle, m.fiscalWorkaround.saft]) {
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

describe("Seitentitel und -beschreibung je Sprache (#18)", () => {
  it("Layout baut Titel aus APP_NAME + übersetztem Tagline, Beschreibung übersetzt", () => {
    const layout = stripComments(read("src/app/[locale]/layout.tsx"));
    expect(layout).toContain("generateMetadata");
    expect(layout).toContain('t("tagline")');
    expect(layout).toContain('t("description")');
    expect(layout).not.toMatch(/Hausverwaltung|Immobilienverwaltung/);
    for (const locale of ["de", "en", "pt"]) {
      const app = JSON.parse(read(`messages/${locale}.json`)).app;
      expect(app.tagline).toBeTruthy();
      expect(app.description).toBeTruthy();
    }
  });
});

describe("Schreibweise der Marke (#24)", () => {
  it("CrmWare — nirgends als CRMware/CRMWare in sichtbaren Texten", () => {
    const files = [
      "messages/de.json", "messages/en.json", "messages/pt.json",
      "README.md", "README.de.md",
      "marketing/index.template.html", "public/marketing/index.html",
      "src/lib/brand.ts",
    ];
    for (const f of files) expect(read(f), f).not.toMatch(/CRMware|CRMWare/);
    expect(APP_NAME).toBe("CrmWare");
    expect(APP_SLUG).toBe("crmware");
  });
});

describe("Login-Überschrift ohne Namen (#24)", () => {
  it("keine doppelten Schlüssel in den Sprachdateien", () => {
    // JSON.parse behält bei doppelten Schlüsseln stillschweigend den letzten — daher je Ebene zählen.
    for (const locale of ["de", "en", "pt"]) {
      const dups: string[] = [];
      const stack: Set<string>[] = [new Set()];
      for (const line of read(`messages/${locale}.json`).split("\n")) {
        const key = line.match(/^\s*"([^"]+)":/)?.[1];
        if (key) {
          const level = stack[stack.length - 1];
          if (level.has(key)) dups.push(`${locale}:${key}`);
          level.add(key);
        }
        if (/\{\s*$/.test(line)) stack.push(new Set());
        if (/^\s*\},?\s*$/.test(line)) stack.pop();
      }
      expect(dups).toEqual([]);
    }
  });

  it("zeigt nur den Gruß, nicht Mandanten- oder Produktname", () => {
    const login = read("src/app/[locale]/login/page.tsx");
    expect(login).toContain('t("login.greeting")');
    expect(login).not.toContain("welcomeTo");
    const greet = { de: "Willkommen", en: "Welcome", pt: "Bem-vindo" } as const;
    for (const [locale, word] of Object.entries(greet)) {
      const l = JSON.parse(read(`messages/${locale}.json`)).login;
      expect(l.greeting).toBe(word);
      expect(l.welcomeTo).toBeUndefined();
    }
  });
});

describe("Marke ist ein Unternehmen, nicht das Produkt (#24)", () => {
  it("Beta-Hinweis nennt keine Marke; pt ohne Artikel vor dem Namen", () => {
    for (const locale of ["de", "en", "pt"]) {
      expect(JSON.parse(read(`messages/${locale}.json`)).about.betaNote).not.toContain("{app}");
    }
    const pt = JSON.parse(read("messages/pt.json"));
    expect(pt.about.title).toBe("Sobre {app}");
    expect(pt.about.betaNote).toBe("Esta aplicação está em fase de testes beta. As funcionalidades podem mudar.");
  });
});

describe("Standardsprache je Marke", () => {
  it("CrmWare startet auf Portugiesisch; Routing nimmt die Standardsprache aus brand.ts", async () => {
    const { APP_DEFAULT_LOCALE } = await import("./brand");
    const { routing } = await import("../i18n/routing");
    expect(APP_DEFAULT_LOCALE).toBe("pt");
    expect(routing.defaultLocale).toBe(APP_DEFAULT_LOCALE);
    expect(routing.locales).toContain(APP_DEFAULT_LOCALE);
  });

  it("Logout führt auf die Login-Seite der aktuellen Sprache, nicht fest auf /de", () => {
    const menu = read("src/components/user-menu.tsx");
    expect(menu).not.toContain('"/de/login"');
    expect(menu).toContain("callbackUrl: `/${locale}/login`");
  });
});
