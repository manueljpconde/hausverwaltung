import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_SLUG } from "./brand";
import { LANDING_CTA_URL, LANDING_FEATURES, LANDING_TRUST, LANDING_SCREENSHOT, landingIcon, posterFor, posterSmallFor } from "./landing";

// #33: PT-Landingpage — Texte, Konstanten, Grenzen des Inhalts.
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const landing = JSON.parse(read("messages/pt.json")).landing;
const strings = (o: unknown, path = ""): [string, string][] =>
  typeof o === "string" ? [[path, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));

describe("Landing-Inhalt (#33)", () => {
  it("CTA führt zum pt-Kontakt auf crmware.pt mit UTM", () => {
    expect(LANDING_CTA_URL).toBe("https://crmware.pt/pt/contact?utm_source=realestate&utm_medium=landing");
  });

  it("vier Bereiche und vier Vertrauensaussagen, jeweils mit Text in pt", () => {
    expect(LANDING_FEATURES.map((f) => f.key)).toEqual(["rental", "condo", "operations", "portal"]);
    for (const f of LANDING_FEATURES) {
      for (const k of ["title", "p1", "p2", "p3"]) expect(landing.features[f.key][k]).toBeTruthy();
    }
    expect(LANDING_TRUST.map((t) => t.key)).toEqual(["hosting", "access", "language", "api"]);
    // Karte „Código aberto“ auf Wunsch entfernt; Quellcode-Link bleibt im Fußbereich (AGPL).
    expect(landing.trust.openSource).toBeUndefined();
    expect(landing.trust.openSourceLink).toBeUndefined();
    for (const t of LANDING_TRUST) expect(landing.trust[t.key]).toBeTruthy();
  });

  it("Pfade für Icons, Screenshot und Poster", () => {
    expect(landingIcon("users")).toBe(`/brand/${APP_SLUG}/icons/users.svg`);
    expect(LANDING_SCREENSHOT).toBe(`/brand/${APP_SLUG}/landing/dashboard.webp`);
    expect(posterFor("/videos/crmware/a.mp4")).toBe("/videos/crmware/a.jpg");
    expect(posterFor("/videos/default/b.webm")).toBe("/videos/default/b.jpg");
    expect(posterSmallFor("/videos/crmware/a.mp4")).toBe("/videos/crmware/a-800.jpg");
  });

  it("verbotene Inhalte kommen nicht vor", () => {
    const text = strings(landing).map(([, s]) => s).join("\n");
    expect(text).not.toMatch(/BetrKV|HeizkostenV|GoBD|\bMEA\b/);
    expect(text).not.toMatch(/preço|preços|€|plano|testemunho|cliente satisfeito/i);
    expect(text).not.toMatch(/assistente de IA|integraç/i);
    expect(text).not.toMatch(/conformidade|compliant|certificad|RGPD|BUILT/i);
    expect(text).not.toMatch(/todas as alterações/);
  });

  it("Marke nur über {app}, nie als fester Name", () => {
    for (const [path, s] of strings(landing)) expect(s, path).not.toMatch(/CrmWare|HaVeWa/);
  });
});
