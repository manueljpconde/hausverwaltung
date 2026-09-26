import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CRMWARE_DEMO_ANCHOR,
  CRMWARE_DEMO_SCENARIOS,
  assertDemoSeedAllowed,
  demoDate,
  invalidPtNif,
  isValidPtNif,
  validateScenarioDefinitions,
} from "../../prisma/seed-crmware-demo";

describe("CrmWare Portugal demo seed (#46)", () => {
  it("defines the three deterministic scenarios at the agreed midpoint volumes", () => {
    expect(CRMWARE_DEMO_ANCHOR.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(CRMWARE_DEMO_SCENARIOS.map((scenario) => scenario.key)).toEqual([
      "mixed",
      "condominium",
      "rental",
    ]);

    expect(CRMWARE_DEMO_SCENARIOS.map((scenario) => scenario.targets)).toEqual([
      {
        internalUsers: 10,
        condoProperties: 5,
        rentalProperties: 20,
        units: 115,
        owners: 90,
        landlords: 7,
        activeLeases: 20,
        futureLeases: 4,
        terminatedLeases: 4,
        delinquentLeases: 3,
        availableUnits: 4,
        financialMovements: 450,
        tickets: 28,
        contractors: 8,
        meetings: 8,
        resolutions: 18,
        documents: 140,
      },
      {
        internalUsers: 8,
        condoProperties: 8,
        rentalProperties: 0,
        units: 225,
        owners: 185,
        landlords: 0,
        activeLeases: 0,
        futureLeases: 0,
        terminatedLeases: 0,
        delinquentLeases: 0,
        availableUnits: 0,
        financialMovements: 750,
        tickets: 38,
        contractors: 12,
        meetings: 12,
        resolutions: 30,
        documents: 225,
      },
      {
        internalUsers: 4,
        condoProperties: 0,
        rentalProperties: 12,
        units: 20,
        owners: 1,
        landlords: 1,
        activeLeases: 14,
        futureLeases: 3,
        terminatedLeases: 5,
        delinquentLeases: 2,
        availableUnits: 3,
        financialMovements: 300,
        tickets: 18,
        contractors: 6,
        meetings: 0,
        resolutions: 0,
        documents: 90,
      },
    ]);
  });

  it("uses stable demo-only identities", () => {
    for (const scenario of CRMWARE_DEMO_SCENARIOS) {
      expect(scenario.tenantName).toMatch(/^CrmWare Demo PT - /);
      expect(scenario.emailDomain).toMatch(/\.example$/);
    }
  });

  it("requires an explicit local-only opt-in and an environment password", () => {
    const allowed = {
      ALLOW_DEMO_SEED: "1",
      CRMWARE_DEMO_PASSWORD: "LocalOnly-Password-2026",
      DATABASE_URL: "postgresql://havewa:havewa@localhost:5432/havewa",
      NODE_ENV: "development",
    } as const;
    expect(assertDemoSeedAllowed(allowed)).toBe(allowed.CRMWARE_DEMO_PASSWORD);
    expect(() => assertDemoSeedAllowed({ ...allowed, ALLOW_DEMO_SEED: undefined })).toThrow(/ALLOW_DEMO_SEED/);
    expect(() => assertDemoSeedAllowed({ ...allowed, NODE_ENV: "production" })).toThrow(/produção/);
    expect(() => assertDemoSeedAllowed({ ...allowed, DATABASE_URL: "postgresql://db.internal/havewa" })).toThrow(/local/);
    expect(() => assertDemoSeedAllowed({ ...allowed, CRMWARE_DEMO_PASSWORD: "short" })).toThrow(/password/i);
  });

  it("generates deliberately invalid Portuguese NIF placeholders", () => {
    for (let i = 0; i < 500; i++) {
      const nif = invalidPtNif(2, i);
      expect(nif).toMatch(/^2\d{8}$/);
      expect(isValidPtNif(nif)).toBe(false);
    }
  });

  it("covers exactly 24 calendar months without depending on wall-clock time", () => {
    expect(demoDate(-23, 1).toISOString()).toBe("2024-10-01T12:00:00.000Z");
    expect(demoDate(0, 26).toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(demoDate(1, 5).toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });

  it("accepts the committed definitions", () => {
    expect(validateScenarioDefinitions(CRMWARE_DEMO_SCENARIOS)).toEqual([]);
  });

  it("is exposed through explicit seed and validation scripts", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["db:seed:crmware"]).toBe("tsx prisma/seed-crmware-demo.ts");
    expect(pkg.scripts["db:validate:crmware"]).toBe("tsx prisma/seed-crmware-demo.ts --validate");
    expect(pkg.scripts["test:crmware-demo"]).toBe("vitest run src/lib/crmware-demo-seed.integration.test.ts");
  });

  it("ships an evidence-based operator guide with explicit product limits", () => {
    const guide = readFileSync(new URL("../../docs/crmware-demo.md", import.meta.url), "utf8");
    expect(guide).toContain("## Matriz funcional");
    expect(guide).toContain("## Matriz de personas");
    expect(guide).toContain("## Guião de demonstração");
    expect(guide).toContain("## Limitações confirmadas");
    expect(guide).toContain("não existe isolamento por portefólio de senhorio");
    expect(guide).toContain("npm run db:validate:crmware");
  });

  it("does not commit or print a shared demo password", () => {
    const seed = readFileSync(new URL("../../prisma/seed-crmware-demo.ts", import.meta.url), "utf8");
    const guide = readFileSync(new URL("../../docs/crmware-demo.md", import.meta.url), "utf8");
    expect(seed).not.toContain("CrmWareDemo!2026");
    expect(guide).not.toContain("CrmWareDemo!2026");
    expect(seed).toContain('isDemo: false');
    expect(seed).not.toContain('dateFormat: "en-GB"');
  });
});
