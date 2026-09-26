import { promises as fs } from "node:fs";
import path from "node:path";
import { APP_SLUG } from "@/lib/brand";

export const BRAND_ASSETS = ["logo", "icon"] as const;
export type BrandAsset = (typeof BRAND_ASSETS)[number];

/** Nur ein einzelnes Pfadsegment — sonst könnte ein Slug aus dem Basisordner herausführen. */
export function assertSlug(slug: string): void {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Ungültiger slug: ${JSON.stringify(slug)}`);
}

/** Dateipfad von Logo/Icon der Marke: public/brand/<slug>/<asset>.svg|.png, sonst default/, sonst null. SVG vor PNG. */
export async function brandAssetPath(
  asset: BrandAsset,
  { baseDir = path.join(process.cwd(), "public", "brand"), slug = APP_SLUG }: { baseDir?: string; slug?: string } = {},
): Promise<string | null> {
  assertSlug(slug);
  for (const folder of [slug, "default"]) {
    for (const ext of ["svg", "png"]) {
      const file = path.join(baseDir, folder, `${asset}.${ext}`);
      try {
        await fs.access(file);
        return file;
      } catch {
        // nächste Datei
      }
    }
  }
  return null;
}
