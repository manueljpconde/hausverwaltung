import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_NAME } from "./brand";
import { renderMarketing } from "./marketing";

// #18: Die Marketing-Seite ist statisch; der Produktname kommt per Build-Schritt aus brand.ts.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Marketing-Seite aus Vorlage (#18)", () => {
  it("setzt den Produktnamen ein", () => {
    expect(renderMarketing("<title>{{APP_NAME}}</title> {{APP_NAME}}", "Acme")).toBe("<title>Acme</title> Acme");
  });

  it("bricht bei unbekannten Platzhaltern ab", () => {
    expect(() => renderMarketing("{{APP_NAME}} {{OTHER}}", "Acme")).toThrow(/OTHER/);
  });

  it("Vorlage enthält keinen festen Produktnamen", () => {
    const template = read("marketing/index.template.html");
    expect(template).toContain("{{APP_NAME}}");
    expect(template).not.toContain("HaVeWa");
  });

  it("ausgelieferte Seite ist aktuell (npm run build:marketing)", () => {
    const template = read("marketing/index.template.html");
    expect(read("public/marketing/index.html")).toBe(renderMarketing(template, APP_NAME));
  });
});
