import { promises as fs } from "node:fs";
import path from "node:path";
import { APP_SLUG } from "@/lib/brand";

const VIDEO = /\.(mp4|webm)$/i;

async function videosIn(baseDir: string, folder: string): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(baseDir, folder));
    return files
      .filter((f) => VIDEO.test(f))
      .sort()
      .map((f) => `/videos/${folder}/${f}`);
  } catch {
    return [];
  }
}

/**
 * Hintergrundvideos für Login/Setup: public/videos/<APP_SLUG>/ (mp4/webm), falls dort
 * Videos liegen, sonst public/videos/default/. Mehrere Dateien rotieren automatisch.
 */
export async function listBackgroundVideos({
  baseDir = path.join(process.cwd(), "public", "videos"),
  slug = APP_SLUG,
}: { baseDir?: string; slug?: string } = {}): Promise<string[]> {
  const brand = await videosIn(baseDir, slug);
  return brand.length > 0 ? brand : videosIn(baseDir, "default");
}
