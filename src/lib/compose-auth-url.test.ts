import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #10: Hinter einem Proxy sieht Auth.js in Next-16-Route-Handlern nur localhost:3000 als
// Request-URL. Ohne AUTH_URL landen Redirects (z. B. nach Logout) auf https://localhost:3000.
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("AUTH_URL in den Produktions-Compose-Dateien (#10)", () => {
  for (const file of ["docker-compose.prod.yml", "docker-compose.registry.yml"]) {
    it(`${file} setzt AUTH_URL auf die öffentliche Domain`, () => {
      expect(read(file)).toContain('AUTH_URL: "https://${DOMAIN}"');
    });
  }
});
