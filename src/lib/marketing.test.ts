import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_NAME, APP_SLUG } from "./brand";
import { renderMarketing } from "./marketing";

// #18: Die Marketing-Seite ist statisch; der Produktname kommt per Build-Schritt aus brand.ts.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Marketing-Seite aus Vorlage (#18)", () => {
  it("setzt Produktname und Slug ein", () => {
    expect(renderMarketing("<title>{{APP_NAME}}</title> app.{{APP_SLUG}}.app/x", { name: "Acme", slug: "acme" })).toBe(
      "<title>Acme</title> app.acme.app/x",
    );
  });

  it("bricht bei unbekannten Platzhaltern ab", () => {
    expect(() => renderMarketing("{{APP_NAME}} {{OTHER}}", { name: "Acme", slug: "acme" })).toThrow(/OTHER/);
  });

  it("Vorlage enthält keinen festen Produktnamen", () => {
    const template = read("marketing/index.template.html");
    expect(template).toContain("{{APP_NAME}}");
    expect(template).not.toContain("HaVeWa");
    // Deko-Adressleisten der Screenshots folgen dem Slug (app.<slug>.app).
    expect(template).toContain("app.{{APP_SLUG}}.app/");
    expect(template).not.toMatch(/\.havewa\./);
  });

  it("ausgelieferte Seite ist aktuell (npm run build:marketing)", () => {
    const template = read("marketing/index.template.html");
    expect(read("public/marketing/index.html")).toBe(renderMarketing(template, { name: APP_NAME, slug: APP_SLUG }));
  });
});
