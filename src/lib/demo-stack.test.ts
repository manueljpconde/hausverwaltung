import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Demo-Stack realestate-demo: eigene DB/Storage, gleiches Image, Haupt-Stack bleibt unberührt.
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("Demo-Stack", () => {
  const demo = read("docker-compose.demo.yml");

  it("eigene Dienste, die im gemeinsamen Netz nicht mit app/db/caddy kollidieren", () => {
    expect(demo).toMatch(/^name: havewa-demo$/m);
    expect(demo).toMatch(/^  demo-app:$/m);
    expect(demo).toMatch(/^  demo-db:$/m);
    expect(demo).not.toMatch(/^  (app|db|caddy):$/m);
    expect(demo).toContain("container_name: havewa-demo-app");
    expect(demo).toContain("container_name: havewa-demo-db");
  });

  it("Speicher begrenzt, DB nur lokal erreichbar und mit _demo-Namen, keine Bootstrap-Konten", () => {
    expect(demo).toContain("mem_limit: 512m");
    expect(demo).toContain("mem_limit: 256m");
    expect(demo).toContain('"127.0.0.1:5433:5432"');
    expect(demo).not.toMatch(/-\s*"?5433:5432/);
    expect(demo).toContain("POSTGRES_DB: havewa_demo");
    expect(demo).toContain("@demo-db:5432/havewa_demo");
    expect(demo).not.toMatch(/ADMIN_EMAIL|SEED_DEMO/);
  });

  it("nur die App hängt am Caddy-Netz des Haupt-Stacks", () => {
    expect(demo).toMatch(/edge:\n\s+external: true\n\s+name: havewa_default/);
    const db = demo.slice(demo.search(/^  demo-db:$/m), demo.search(/^networks:$/m));
    expect(db).not.toMatch(/- edge/);
  });

  it("Caddy lädt zusätzliche Sites aus /etc/caddy/sites, der Haupt-Stack bindet sie ein", () => {
    expect(read("Caddyfile")).toMatch(/^import \/etc\/caddy\/sites\/\*\.caddy$/m);
    expect(read("docker-compose.registry.yml")).toContain("./sites:/etc/caddy/sites:ro");
    const site = read("deploy/demo/realestate-demo.caddy");
    expect(site).toMatch(/^realestate-demo\.crmware\.pt \{/m);
    expect(site).toContain("reverse_proxy havewa-demo-app:3000");
  });

  it("Reset-Skript fasst nur den Demo-Stack an und seedet nie im Produktionsmodus", () => {
    const sh = read("deploy/demo-reset.sh");
    expect(spawnSync("bash", ["-n", "deploy/demo-reset.sh"], { cwd: new URL("../../", import.meta.url) }).status).toBe(0);
    for (const m of sh.matchAll(/docker compose ([^\n]*)/g)) expect(m[1]).toMatch(/^-f docker-compose\.demo\.yml /);
    expect(sh).toMatch(/cd \/opt\/havewa-demo/);
    expect(sh).toContain("NODE_ENV=development");
    expect(sh).toContain("ALLOW_DEMO_SEED=1");
    expect(sh).toContain("@127.0.0.1:5433/havewa_demo");
    expect(sh).toContain("havewa-demo_demo-storage:/app/storage");
    expect(sh).toMatch(/prisma\/seed-crmware-demo\.ts "\$@"/);
    expect(sh).toMatch(/^seed\nseed --validate$/m);
    expect(sh).not.toMatch(/echo[^\n]*CRMWARE_DEMO_PASSWORD/);
  });
});
