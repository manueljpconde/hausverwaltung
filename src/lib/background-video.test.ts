import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #33: BackgroundVideo — neue Optionen sind opt-in; Login/Setup bleiben unverändert.
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("BackgroundVideo (#33)", () => {
  it("bietet poster, controls (Standard aus) und mediaQuery an", () => {
    const src = read("src/components/background-video.tsx");
    expect(src).toMatch(/controls = false/);
    expect(src).toMatch(/poster=\{poster\}/);
    expect(src).toMatch(/aria-pressed=\{paused\}/);
    expect(src).toMatch(/window\.matchMedia\(mediaQuery\)/);
    expect(src).toMatch(/type="button"/);
  });

  it("Login und Setup nutzen keine der neuen Optionen", () => {
    for (const page of ["src/app/[locale]/login/page.tsx", "src/app/[locale]/setup/page.tsx"]) {
      const call = read(page).match(/<BackgroundVideo[^>]*\/>/)?.[0] ?? "";
      expect(call, page).toContain("sources={videos}");
      expect(call, page).not.toMatch(/controls|mediaQuery|poster/);
    }
  });
});
