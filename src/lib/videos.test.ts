import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listBackgroundVideos } from "./videos";

// #22: Hintergrundvideos je Marke (APP_SLUG), sonst die Standardvideos.
let base: string;
const put = (dir: string, ...files: string[]) => {
  mkdirSync(path.join(base, dir), { recursive: true });
  for (const f of files) writeFileSync(path.join(base, dir, f), "");
};

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "videos-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("listBackgroundVideos (#22)", () => {
  it("nimmt nur die Videos der Marke, wenn vorhanden", async () => {
    put("default", "estate-1.mp4");
    put("acme", "b.webm", "a.mp4", "notes.txt");
    expect(await listBackgroundVideos({ baseDir: base, slug: "acme" })).toEqual(["/videos/acme/a.mp4", "/videos/acme/b.webm"]);
  });

  it("fällt auf default zurück, wenn der Markenordner fehlt oder leer ist", async () => {
    put("default", "estate-1.mp4");
    expect(await listBackgroundVideos({ baseDir: base, slug: "acme" })).toEqual(["/videos/default/estate-1.mp4"]);
    put("acme", "readme.txt");
    expect(await listBackgroundVideos({ baseDir: base, slug: "acme" })).toEqual(["/videos/default/estate-1.mp4"]);
  });

  it("liefert nichts, wenn weder Marke noch default Videos haben", async () => {
    expect(await listBackgroundVideos({ baseDir: base, slug: "acme" })).toEqual([]);
  });

  it("lehnt Slugs ab, die aus dem Videoordner herausführen könnten", async () => {
    put("default", "estate-1.mp4");
    for (const slug of ["../default", "a/b", "..", "", "Acme"]) {
      await expect(listBackgroundVideos({ baseDir: base, slug })).rejects.toThrow(/slug/i);
    }
  });

  it("Standard: echter Ordner — Markenvideo für APP_SLUG, default bleibt erhalten", async () => {
    expect(await listBackgroundVideos()).toEqual(["/videos/crmware/intro-vision-imo-crmware.mp4"]);
    expect(await listBackgroundVideos({ slug: "unbekannt" })).toEqual(["/videos/default/estate-1.mp4"]);
  });
});
