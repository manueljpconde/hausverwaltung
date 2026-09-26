import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #33: Besuchszählung /marketing ohne personenbezogene Daten, 90 Tage.
const caddy = readFileSync(new URL("../../Caddyfile", import.meta.url), "utf8");

describe("Caddy-Zugriffslog /marketing (#33)", () => {
  it("nur /marketing, ohne IP/Header/Cookies, 90 Tage", () => {
    expect(caddy).toContain("output file /data/access-marketing.log");
    expect(caddy).toContain("roll_keep_for 2160h");
    for (const f of ["request>remote_ip delete", "request>client_ip delete", "request>headers delete", "resp_headers delete"]) {
      expect(caddy).toContain(f);
    }
    expect(caddy).toContain("@not_marketing not path /marketing");
    expect(caddy).toContain("log_skip @not_marketing");
  });

  it("ohne Query-String (z. B. gclid) und mit täglicher Rotation, damit die 90 Tage greifen", () => {
    expect(caddy).toContain('request>uri regexp "\\?.*$" ""');
    expect(caddy).toContain("roll_interval 24h");
  });
});
