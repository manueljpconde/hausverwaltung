import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_SLUG, BRAND_LOGO_URL, BRAND_ICON_URL } from "./brand";
import { brandAssetPath } from "./brand-assets";

// #24: Logo und Icon je Marke (public/brand/<APP_SLUG>/), sonst public/brand/default/.
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

let base: string;
const put = (dir: string, ...files: string[]) => {
  mkdirSync(path.join(base, dir), { recursive: true });
  for (const f of files) writeFileSync(path.join(base, dir, f), "");
};
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "brand-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("brandAssetPath (#24)", () => {
  it("nimmt die Datei der Marke, sonst default, sonst null", async () => {
    put("default", "logo.png", "icon.png");
    put("acme", "logo.png");
    expect(await brandAssetPath("logo", { baseDir: base, slug: "acme" })).toBe(path.join(base, "acme", "logo.png"));
    expect(await brandAssetPath("icon", { baseDir: base, slug: "acme" })).toBe(path.join(base, "default", "icon.png"));
    rmSync(path.join(base, "default"), { recursive: true });
    expect(await brandAssetPath("icon", { baseDir: base, slug: "acme" })).toBeNull();
  });

  it("bevorzugt SVG vor PNG, je Ordner", async () => {
    put("default", "logo.png", "icon.svg", "icon.png");
    put("acme", "logo.svg", "logo.png");
    expect(await brandAssetPath("logo", { baseDir: base, slug: "acme" })).toBe(path.join(base, "acme", "logo.svg"));
    expect(await brandAssetPath("icon", { baseDir: base, slug: "acme" })).toBe(path.join(base, "default", "icon.svg"));
  });

  it("lehnt Slugs ab, die aus public/brand herausführen könnten", async () => {
    for (const slug of ["../default", "a/b", "..", "", "Acme"]) {
      await expect(brandAssetPath("logo", { baseDir: base, slug })).rejects.toThrow(/slug/i);
    }
  });

  it("echtes Repo: Marke hat Logo und Icon, default bleibt als Rückfall", async () => {
    for (const asset of ["logo", "icon"] as const) {
      expect(await brandAssetPath(asset)).toMatch(new RegExp(`public/brand/${APP_SLUG}/${asset}\\.(svg|png)$`));
      expect(existsSync(new URL(`public/brand/default/${asset}.png`, root))).toBe(true);
    }
  });
});

describe("Logo/Icon nur über /api/brand/* (#24)", () => {
  it("kein Code und keine Marketing-Vorlage verweist direkt auf die alten Bilddateien", () => {
    const files = (readdirSync(new URL("src/", root), { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => `src/${f}`);
    const hits = [...files, "marketing/index.template.html"].filter((f) =>
      /["'](?:\/|\.\/)(?:marketing\/)?(?:logo|icon)\.png["']/.test(read(f)),
    );
    expect(hits).toEqual([]);
    expect(BRAND_LOGO_URL).toBe("/api/brand/logo");
    expect(BRAND_ICON_URL).toBe("/api/brand/icon");
  });

  it("Favicon kommt aus der Marke statt aus src/app/icon.png", () => {
    expect(existsSync(new URL("src/app/icon.png", root))).toBe(false);
    expect(read("src/app/[locale]/layout.tsx")).toContain("BRAND_ICON_URL");
  });
});

describe("CrmWare nutzt die offiziellen Vektordateien (#24)", () => {
  it("Symbol und Logo sind die SVGs der CrmWare-Website, ohne Skript oder externe Verweise", () => {
    for (const asset of ["icon", "logo"]) {
      const svg = read(`public/brand/crmware/${asset}.svg`);
      expect(svg).toMatch(/^<\?xml[^>]*>\s*<svg /);
      expect(svg).not.toMatch(/<script|foreignObject|href=|\son[a-z]+=/i);
      expect(existsSync(new URL(`public/brand/crmware/${asset}.png`, root))).toBe(false);
    }
  });
});

describe("Kein Logo über dem Hintergrundvideo (#24)", () => {
  it("Login und Setup legen kein Marken-Icon über das Video (das Video trägt die Marke selbst)", () => {
    for (const page of ["src/app/[locale]/login/page.tsx", "src/app/[locale]/setup/page.tsx"]) {
      expect(read(page)).not.toContain("BRAND_ICON_URL");
    }
  });
});
