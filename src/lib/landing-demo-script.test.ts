import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #33: Demodaten-Skript schreibt nur lokal, außer mit ausdrücklicher Freigabe.
const script = new URL("../../scripts/landing-demo-data.sh", import.meta.url).pathname;

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "demo-"));
  const log = join(dir, "curl.log");
  // curl-Attrappe: protokolliert Aufrufe, schickt nichts ins Netz.
  writeFileSync(join(dir, "curl"), `#!/bin/sh\necho "$@" >> "${log}"\necho '{"id":"x"}'\n`);
  chmodSync(join(dir, "curl"), 0o755);
  const r = spawnSync("bash", [script], { env: { NODE_ENV: "test", PATH: `${dir}:${process.env.PATH}`, TOKEN: "t", ...env }, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

describe("landing-demo-data.sh (#33)", () => {
  it("bricht bei nicht lokalem BASE ab, ohne einen Request zu senden", () => {
    const r = run({ BASE: "https://realestate.crmware.pt" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ALLOW_REMOTE=1/);
    expect(r.calls).toBe("");
  });

  it("läuft gegen localhost und mit ALLOW_REMOTE=1 los", () => {
    expect(run({ BASE: "http://localhost:3300" }).calls).toContain("http://localhost:3300/api/v1/");
    expect(run({ BASE: "http://127.0.0.1:3300" }).calls).toContain("http://127.0.0.1:3300/api/v1/");
    expect(run({ BASE: "https://staging.example.com", ALLOW_REMOTE: "1" }).calls).toContain("https://staging.example.com/api/v1/");
  });

  it("nutzt nur reservierte Beispiel-Domains für E-Mails", () => {
    const src = readFileSync(script, "utf8");
    const emails = src.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const e of emails) expect(e).toMatch(/@example\.com$/);
  });
});
