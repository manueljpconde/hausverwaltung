import { promises as fs } from "node:fs";
import { BRAND_ASSETS, brandAssetPath, type BrandAsset } from "@/lib/brand-assets";

// Logo/Icon der Marke (#24) — öffentlich, auch vor der Anmeldung (Login, Favicon, Marketing-Seite).
export async function GET(_req: Request, { params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  if (!(BRAND_ASSETS as readonly string[]).includes(asset)) return new Response("Not found", { status: 404 });
  const file = await brandAssetPath(asset as BrandAsset);
  if (!file) return new Response("Not found", { status: 404 });
  const svg = file.endsWith(".svg");
  return new Response(new Uint8Array(await fs.readFile(file)), {
    headers: {
      "Content-Type": svg ? "image/svg+xml" : "image/png",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // SVG direkt aufgerufen: niemals Skript ausführen, nichts nachladen.
      ...(svg ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
}
