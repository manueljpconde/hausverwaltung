import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";
import { chargesForLeases } from "./portal-charges";
import { recordPayment } from "./payments";
import { paymentChargeType } from "./charges";

const READERS = [
  "src/lib/api-data.ts", "src/app/[locale]/(admin)/finances/page.tsx", "src/app/[locale]/(admin)/dunning/page.tsx",
  "src/app/[locale]/(admin)/reports/page.tsx", "src/app/[locale]/(admin)/dashboard/page.tsx", "src/app/[locale]/portal/page.tsx",
  "src/app/[locale]/print/dunning/page.tsx", "src/app/api/export/openitems/route.ts", "src/app/api/export/sepa/route.ts",
  "src/app/api/export/datev/route.ts", "src/server/actions/ai.ts", "src/server/actions/finances.ts", "src/lib/api-ops.ts",
  "src/app/api/dunning/[chargeId]/pdf/route.ts",
];

describe("paymentChargeType (#52)", () => {
  it("eine Art, mehrere Arten, keine", () => {
    const a = (type: string) => ({ charge: { type } });
    expect(paymentChargeType([a("MIETE"), a("MIETE")])).toBe("MIETE");
    expect(paymentChargeType([a("MIETE"), a("NEBENKOSTEN")])).toBe("MIXED");
    expect(paymentChargeType([])).toBeNull();
  });
});

describe("Leser (#52)", () => {
  it("kein Leser rechnet den Saldo mehr selbst aus", () => {
    for (const f of READERS) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/\.payments\.(reduce|map)|payments:\s*\{\s*select|\bp\.charge\b|allocations\[0\]|allocations:[^;]*take:\s*1/);
    }
  });
});

let t: Awaited<ReturnType<typeof createTestTenant>>;
let leaseId: string;

describeDb("chargesForLeases (#52)", () => {
  beforeEach(async () => {
    t = await createTestTenant();
    const property = await db!.property.create({ data: { tenantId: t.tenantId, name: "P", street: "S", zip: "1", city: "L" } });
    const building = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: property.id, name: "B" } });
    const unit = await db!.unit.create({ data: { tenantId: t.tenantId, buildingId: building.id, label: "A", area: 50 } });
    leaseId = (await db!.lease.create({ data: { tenantId: t.tenantId, unitId: unit.id, startDate: new Date("2026-01-01"), rentCold: 500 } })).id;
    const area = await db!.areaAllocation.create({ data: { tenantId: t.tenantId, propertyId: property.id, leaseId, area: 10, pricePerSqm: 5, from: new Date("2026-01-01") } });
    const d = new Date("2026-09-01");
    await db!.charge.create({ data: { tenantId: t.tenantId, leaseId, type: "MIETE", period: d, dueDate: d, amount: 500 } });
    await db!.charge.create({ data: { tenantId: t.tenantId, areaAllocationId: area.id, type: "MIETE", period: d, dueDate: d, amount: 50 } });
  });
  afterEach(() => t.cleanup());

  it("findet Miete und Flächenmiete des Vertrags, mit Zahlungen", async () => {
    const [rent] = await db!.charge.findMany({ where: { tenantId: t.tenantId, leaseId } });
    await recordPayment({ tenantId: t.tenantId, chargeId: rent.id, date: new Date("2026-09-03"), amount: 500, direction: "EINGANG" }, db!);
    const rows = await chargesForLeases(t.tenantId, [leaseId], db!);
    expect(rows.map((r) => Number(r.amount)).sort((a, b) => a - b)).toEqual([50, 500]);
    expect(rows.find((r) => Number(r.amount) === 500)!.allocations[0].payment.amount.toString()).toBe("500");
  });

  it("anderer Mandant sieht nichts", async () => {
    const other = await createTestTenant();
    try {
      expect(await chargesForLeases(other.tenantId, [leaseId], db!)).toEqual([]);
    } finally {
      await other.cleanup();
    }
  });
});
