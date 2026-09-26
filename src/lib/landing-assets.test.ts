import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { LANDING_FEATURES, LANDING_TRUST, landingIcon, posterFor, posterSmallFor } from "./landing";
import { listBackgroundVideos } from "./videos";

// #33: Icons und Standbilder der Landingpage liegen im Repo, sind sicher und klein.
const pub = (url: string) => new URL(`../../public${url}`, import.meta.url);

describe("Landing-Assets (#33)", () => {
  it("jedes verwendete Icon existiert und ist ein reines SVG", () => {
    for (const { icon } of [...LANDING_FEATURES, ...LANDING_TRUST]) {
      const file = pub(landingIcon(icon));
      expect(existsSync(file), icon).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg).toMatch(/<svg /);
      expect(svg).not.toMatch(/<script|foreignObject|href=|\son[a-z]+=/i);
    }
  });

  it("jedes Hintergrundvideo hat ein Standbild ≤ 150 KB", async () => {
    const all = [...(await listBackgroundVideos()), ...(await listBackgroundVideos({ slug: "default" }))];
    expect(all.length).toBeGreaterThan(0);
    for (const v of all) {
      const poster = pub(posterFor(v));
      expect(existsSync(poster), v).toBe(true);
      expect(statSync(poster).size, v).toBeLessThanOrEqual(150 * 1024);
      const small = pub(posterSmallFor(v));
      expect(existsSync(small), v).toBe(true);
      expect(statSync(small).size, v).toBeLessThanOrEqual(40 * 1024);
    }
  });

  it("Dashboard-Screenshot existiert als WebP ≤ 200 KB", () => {
    const shot = pub("/brand/crmware/landing/dashboard.webp");
    expect(existsSync(shot)).toBe(true);
    expect(statSync(shot).size).toBeLessThanOrEqual(200 * 1024);
    expect(readFileSync(shot).subarray(8, 12).toString()).toBe("WEBP");
  });

  it("Rune-Icons (Apache-2.0) werden mit Lizenztext und Herkunft ausgeliefert", () => {
    const license = readFileSync(pub("/brand/crmware/icons/LICENSE"), "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");
    const prov = JSON.parse(readFileSync(pub("/brand/crmware/icons/provenance.json"), "utf8"));
    expect(prov.license).toBe("Apache-2.0");
    expect(prov.repository).toMatch(/runeicons/);
  });
});
