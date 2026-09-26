import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

// #33: Aufbau der Route /marketing — pt fest, Marke aus brand.ts, zugänglich, ohne Tracking.
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

describe("/marketing (#33)", () => {
  it("eigenes Root-Layout mit lang=pt-PT und Marken-Favicon", () => {
    const layout = read("src/app/marketing/layout.tsx");
    expect(layout).toContain('lang="pt-PT"');
    expect(layout).toContain("BRAND_ICON_URL");
    expect(layout).toContain('import "../globals.css"');
    expect(layout).toContain('import "./landing.css"');
  });

  it("Seite: Server-Komponente, Texte fest pt, Marke aus brand.ts, CTA-Konstante", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).not.toMatch(/^"use client"/m);
    expect(page).toContain('getTranslations({ locale: "pt", namespace: "landing" })');
    for (const needle of ["APP_NAME", "BRAND_LOGO_URL", "LANDING_CTA_URL", "LANDING_SCREENSHOT", "SOURCE_URL", "posterFor("]) {
      expect(page).toContain(needle);
    }
    expect(page).not.toMatch(/CrmWare|HaVeWa|crmware\.pt\/pt\/contact/);
    expect(page).not.toMatch(/noreferrer/);
    expect(page).not.toMatch(/<script|<form/);
  });

  it("Zugänglichkeit: Skip-Link, Landmarken, ein h1, Anker unter dem Kopf sichtbar", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toContain('href="#conteudo"');
    expect(page).toContain('id="conteudo"');
    expect(page).toContain('id="funcionalidades"');
    for (const tag of ["<header", "<main", "<footer"]) expect(page).toContain(tag);
    expect(page.match(/<h1/g)?.length).toBe(1);
    const css = read("src/app/marketing/landing.css");
    expect(css).toMatch(/scroll-padding-top/);
    expect(css).toMatch(/scroll-margin-top/);
  });

  it("Video nur ab 768 px und ohne reduzierte Bewegung, mit Pause", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toContain('mediaQuery="(min-width: 768px) and (prefers-reduced-motion: no-preference)"');
    expect(page).toMatch(/controls\b/);
  });

  it("alte DE/EN-Seite bleibt unter /marketing/index.html", () => {
    expect(existsSync(new URL("public/marketing/index.html", root))).toBe(true);
  });

  it("wird pro Anfrage gerendert, damit Canonical/OG-URL absolut aus AUTH_URL kommen", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("metadataBase: process.env.AUTH_URL");
  });

  it("Schluss-CTA hebt sich vom Teal-Band ab (heller Button)", () => {
    const page = read("src/app/marketing/page.tsx");
    const closing = page.slice(page.indexOf('aria-labelledby="fecho-titulo"'));
    expect(closing).toMatch(/className="cw-btn cw-btn-light/);
    const css = read("src/app/marketing/landing.css");
    expect(css).toMatch(/\.landing \.cw-btn\.cw-btn-light\s*\{[^}]*background:\s*#ffffff/);
  });

  it("Hero-Kontrast: gleichmäßig dunkel unter 1024 px, Verlauf erst ab lg", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toContain('className="absolute inset-0 -z-10 bg-black/75 lg:bg-transparent lg:bg-gradient-to-r lg:from-black/85 lg:via-black/70 lg:to-black/40"');
  });

  it("Standbild im Hero ist das LCP-Element und wird priorisiert geladen", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toMatch(/fetchPriority="high"/);
    expect(page).toContain("srcSet={`${posterSmall} 800w, ${poster} 1280w`}");
    expect(page).toContain('sizes="100vw"');
  });

  it("keine Karte „Código aberto“, Quellcode-Link nur im Fußbereich", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).not.toContain("openSource");
    expect(page.match(/href=\{SOURCE_URL\}/g)?.length).toBe(1);
  });

  it("Standbild wird im <head> vorab geladen (vor den JS-Chunks)", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toContain('import { preload } from "react-dom"');
    expect(page).toMatch(/preload\(poster, \{ as: "image", fetchPriority: "high", imageSrcSet: `\$\{posterSmall\} 800w, \$\{poster\} 1280w`, imageSizes: "100vw" \}\)/);
  });

  it("Kopfzeile: Login auf dem Telefon als Symbol mit Namen, ab sm als Text", () => {
    const page = read("src/app/marketing/page.tsx");
    const header = page.slice(page.indexOf("<header"), page.indexOf("</header>"));
    // Telefon: Symbol-Link, zugänglicher Name, Ziel ≥ 40 px
    const icon = header.match(/<Link href="\/pt\/login" aria-label=\{t\("nav\.login"\)\} className="([^"]*)">/)?.[1] ?? "";
    expect(icon.split(" ")).toEqual(expect.arrayContaining(["sm:hidden", "size-10", "shrink-0"]));
    expect(header).toMatch(/<UserRound aria-hidden="true"/);
    // ab 640 px: Textlink wie bisher
    expect(header).toMatch(/<Link href="\/pt\/login" className="hidden[^"]*sm:inline[^"]*">/);
    // Platz für das Symbol: kleineres Logo auf dem Telefon
    expect(header).toContain('className="h-6 w-auto sm:h-8"');
  });
});
