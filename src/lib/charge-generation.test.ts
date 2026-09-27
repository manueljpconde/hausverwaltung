import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";
import { generateMonthlyCharges, isUniqueViolation } from "./charge-generation";

describe("isUniqueViolation (#52)", () => {
  it("nur P2002 / 23505", () => {
    expect(isUniqueViolation(new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "6" }))).toBe(true);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(new Prisma.PrismaClientKnownRequestError("x", { code: "P2003", clientVersion: "6" }))).toBe(false);
    expect(isUniqueViolation(new Error("connection lost"))).toBe(false);
  });
});

let t: Awaited<ReturnType<typeof createTestTenant>>;
let leaseId: string;
let areaId: string;
let buildingId: string;

describeDb("generateMonthlyCharges (#52)", () => {
  beforeEach(async () => {
    t = await createTestTenant();
    // #52: generateMonthlyCharges übernimmt den Filter des bisherigen generateAreaCharges
    // (nur Objekte mit areaModel: true).
    const property = await db!.property.create({ data: { tenantId: t.tenantId, name: "P", street: "S", zip: "1", city: "L", areaModel: true } });
    const building = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: property.id, name: "B" } });
    buildingId = building.id;
    const unit = await db!.unit.create({ data: { tenantId: t.tenantId, buildingId: building.id, label: "A", area: 50 } });
    leaseId = (await db!.lease.create({ data: { tenantId: t.tenantId, unitId: unit.id, startDate: new Date("2026-01-01"), rentCold: 500 } })).id;
    areaId = (await db!.areaAllocation.create({ data: { tenantId: t.tenantId, propertyId: property.id, leaseId, area: 10, pricePerSqm: 5, from: new Date("2026-01-01") } })).id;
  });
  afterEach(() => t.cleanup());

  it("legt Miete und Flächenmiete an; Fläche ohne leaseId", async () => {
    expect(await generateMonthlyCharges(t.tenantId, "2026-09", db!)).toMatchObject({ created: 2 });
    const area = await db!.charge.findFirstOrThrow({ where: { tenantId: t.tenantId, areaAllocationId: areaId } });
    expect(area.leaseId).toBeNull();
  });

  it("zweiter und paralleler Lauf erzeugen keine Duplikate", async () => {
    await Promise.all([generateMonthlyCharges(t.tenantId, "2026-09", db!), generateMonthlyCharges(t.tenantId, "2026-09", db!)]);
    expect(await generateMonthlyCharges(t.tenantId, "2026-09", db!)).toMatchObject({ created: 0 });
    expect(await db!.charge.count({ where: { tenantId: t.tenantId } })).toBe(2);
  });

  it("eine stornierte Miete blockiert die Neuerzeugung nicht", async () => {
    await generateMonthlyCharges(t.tenantId, "2026-09", db!);
    await db!.charge.updateMany({ where: { tenantId: t.tenantId, leaseId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Testabbruch" } });
    expect(await generateMonthlyCharges(t.tenantId, "2026-09", db!)).toMatchObject({ created: 1 });
  });

  it("Vertrag ohne Miete und ohne Komponenten erzeugt keine Sollstellung", async () => {
    const unit = await db!.unit.create({ data: { tenantId: t.tenantId, buildingId, label: "B", area: 0 } });
    const zeroLease = await db!.lease.create({ data: { tenantId: t.tenantId, unitId: unit.id, startDate: new Date("2026-01-01"), rentCold: 0 } });
    expect(await generateMonthlyCharges(t.tenantId, "2026-09", db!)).toMatchObject({ created: 2 }); // bestehender Vertrag + Fläche, nicht der neue
    expect(await db!.charge.count({ where: { tenantId: t.tenantId, leaseId: zeroLease.id } })).toBe(0);
  });
});
