import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";

// #52: Die Garantien liegen in der Datenbank, nicht nur in der Anwendung.
let t: Awaited<ReturnType<typeof createTestTenant>>;
let leaseId: string;
let areaId: string;
let propertyId: string;
let unitId: string;
let personId: string;

async function fixtures(tenantId: string) {
  const property = await db!.property.create({ data: { tenantId, name: "P", street: "S", zip: "1000-001", city: "Lisboa" } });
  const building = await db!.building.create({ data: { tenantId, propertyId: property.id, name: "B" } });
  const unit = await db!.unit.create({ data: { tenantId, buildingId: building.id, label: "A", area: 50 } });
  const person = await db!.person.create({ data: { tenantId, firstName: "Ana", lastName: "Teste" } });
  const lease = await db!.lease.create({ data: { tenantId, unitId: unit.id, startDate: new Date("2026-01-01"), rentCold: 500 } });
  const area = await db!.areaAllocation.create({ data: { tenantId, propertyId: property.id, leaseId: lease.id, area: 10, pricePerSqm: 5, from: new Date("2026-01-01") } });
  return { propertyId: property.id, unitId: unit.id, personId: person.id, leaseId: lease.id, areaId: area.id };
}
const month = new Date(Date.UTC(2026, 8, 1));
// Prisma meldet bei (partiellen) Unique-Indizes nicht den Indexnamen, sondern dessen Spalten (P2002).
const uniq = (...cols: string[]) => new RegExp(`Unique constraint failed on the fields: \\(${cols.map((c) => `\`${c}\``).join(",")}\\)`);
const rent = (over: object = {}) => ({ tenantId: t.tenantId, leaseId, type: "MIETE" as const, period: month, dueDate: month, amount: 500, ...over });

describeDb("Schema-Garantien (#52)", () => {
  beforeEach(async () => {
    t = await createTestTenant();
    ({ leaseId, areaId, propertyId, unitId, personId } = await fixtures(t.tenantId));
  });
  afterEach(async () => {
    await db!.owner.deleteMany({ where: { tenantId: t.tenantId } });
    await t.cleanup();
  });

  it("genau ein Ziel: nicht Vertrag und Fläche zugleich, nicht ohne Ziel", async () => {
    await expect(db!.charge.create({ data: rent({ areaAllocationId: areaId }) })).rejects.toThrow(/charge_exactly_one_target/);
    await expect(db!.charge.create({ data: rent({ leaseId: null, type: "SONSTIGES" }) })).rejects.toThrow(/charge_exactly_one_target/);
  });

  it("HAUSGELD nur mit Snapshot", async () => {
    await expect(db!.charge.create({ data: rent({ type: "HAUSGELD" }) })).rejects.toThrow(/charge_hausgeld_needs_snapshot/);
  });

  it("Betrag muss positiv sein: 0 und negativ verstoßen gegen den CHECK", async () => {
    await expect(db!.charge.create({ data: rent({ amount: 0 }) })).rejects.toThrow(/charge_amount_positive/);
    await expect(db!.charge.create({ data: rent({ amount: -1 }) })).rejects.toThrow(/charge_amount_positive/);
  });

  it("Miete: eine ISSUED je Vertrag/Monat; CANCELLED blockiert nicht", async () => {
    const first = await db!.charge.create({ data: rent() });
    await expect(db!.charge.create({ data: rent() })).rejects.toThrow(uniq("leaseId", "period"));
    await db!.charge.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await expect(db!.charge.create({ data: rent() })).resolves.toBeTruthy();
  });

  it("zwei manuelle SONSTIGES im selben Monat bleiben erlaubt", async () => {
    await db!.charge.create({ data: rent({ type: "SONSTIGES" }) });
    await expect(db!.charge.create({ data: rent({ type: "SONSTIGES" }) })).resolves.toBeTruthy();
  });

  it("Fläche: eine ISSUED je Teilfläche/Monat; CANCELLED blockiert nicht", async () => {
    const area = { tenantId: t.tenantId, areaAllocationId: areaId, type: "MIETE" as const, period: month, dueDate: month, amount: 50 };
    const first = await db!.charge.create({ data: area });
    await expect(db!.charge.create({ data: area })).rejects.toThrow(uniq("areaAllocationId", "period"));
    await db!.charge.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await expect(db!.charge.create({ data: area })).resolves.toBeTruthy();
  });

  it("Quota-Kette: je Snapshot höchstens eine ISSUED-Sollstellung, je Objekt/Periode/Art ein ISSUED-Assessment", async () => {
    const a = { tenantId: t.tenantId, propertyId, period: month, kind: "ORDINARY" as const, method: "PERMILLAGE" as const, dueDate: month, asOf: month, totalCents: 10000 };
    const assessment = await db!.condominiumAssessment.create({ data: a });
    await expect(db!.condominiumAssessment.create({ data: a })).rejects.toThrow(uniq("tenantId", "propertyId", "period", "kind"));
    const line = await db!.condominiumAssessmentLine.create({ data: { tenantId: t.tenantId, assessmentId: assessment.id, unitId, amountCents: 10000 } });
    const snap = await db!.quotaDebtorSnapshot.create({ data: { tenantId: t.tenantId, lineId: line.id, personId, shareSnapshot: 1000, amountCents: 10000 } });
    const q = { tenantId: t.tenantId, quotaDebtorSnapshotId: snap.id, type: "HAUSGELD" as const, period: month, dueDate: month, amount: 100 };
    const first = await db!.charge.create({ data: q });
    await expect(db!.charge.create({ data: q })).rejects.toThrow(uniq("quotaDebtorSnapshotId"));
    await db!.charge.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await expect(db!.charge.create({ data: q })).resolves.toBeTruthy();
  });

  it("Zuordnung über Mandanten hinweg ist unmöglich (zusammengesetzte FK)", async () => {
    const other = await createTestTenant();
    try {
      const charge = await db!.charge.create({ data: rent() });
      const payment = await db!.payment.create({ data: { tenantId: other.tenantId, date: month, amount: 10 } });
      await expect(db!.paymentAllocation.create({ data: { tenantId: t.tenantId, paymentId: payment.id, chargeId: charge.id, amount: 10 } })).rejects.toThrow();
      await expect(db!.paymentAllocation.create({ data: { tenantId: other.tenantId, paymentId: payment.id, chargeId: charge.id, amount: 10 } })).rejects.toThrow();
    } finally {
      await other.cleanup();
    }
  });

  it("jede Finanzgrenze ist mandantensicher: A darf nicht auf Vertrag, Fläche, Objekt, Einheit oder Person von B zeigen", async () => {
    const other = await createTestTenant();
    try {
      const b = await fixtures(other.tenantId);
      const d = { tenantId: t.tenantId, type: "MIETE" as const, period: month, dueDate: month, amount: 1 };
      await expect(db!.charge.create({ data: { ...d, leaseId: b.leaseId } })).rejects.toThrow(/Charge_leaseId_tenantId_fkey/);
      await expect(db!.charge.create({ data: { ...d, areaAllocationId: b.areaId } })).rejects.toThrow(/Charge_areaAllocationId_tenantId_fkey/);
      const a = { tenantId: t.tenantId, period: month, kind: "ORDINARY" as const, method: "PERMILLAGE" as const, dueDate: month, asOf: month, totalCents: 100 };
      await expect(db!.condominiumAssessment.create({ data: { ...a, propertyId: b.propertyId } })).rejects.toThrow(/CondominiumAssessment_propertyId_tenantId_fkey/);
      const own = await db!.condominiumAssessment.create({ data: { ...a, propertyId } });
      await expect(db!.condominiumAssessmentLine.create({ data: { tenantId: t.tenantId, assessmentId: own.id, unitId: b.unitId, amountCents: 100 } })).rejects.toThrow(/CondominiumAssessmentLine_unitId_tenantId_fkey/);
      const line = await db!.condominiumAssessmentLine.create({ data: { tenantId: t.tenantId, assessmentId: own.id, unitId, amountCents: 100 } });
      await expect(db!.quotaDebtorSnapshot.create({ data: { tenantId: t.tenantId, lineId: line.id, personId: b.personId, shareSnapshot: 1000, amountCents: 100 } })).rejects.toThrow(/QuotaDebtorSnapshot_personId_tenantId_fkey/);
    } finally {
      await other.cleanup();
    }
  });

  it("neuer Eigentümer ohne Angabe ist CONFIRMED und braucht deshalb validFrom (DB-Default)", async () => {
    await expect(db!.owner.create({ data: { tenantId: t.tenantId, unitId, personId, share: 1000 } })).rejects.toThrow(/owner_confirmed_needs_valid_from/);
  });

  it("Zuordnungsbetrag muss positiv sein", async () => {
    const charge = await db!.charge.create({ data: rent() });
    const payment = await db!.payment.create({ data: { tenantId: t.tenantId, date: month, amount: 10 } });
    await expect(db!.paymentAllocation.create({ data: { tenantId: t.tenantId, paymentId: payment.id, chargeId: charge.id, amount: 0 } })).rejects.toThrow(/allocation_amount_positive/);
  });

  it("Vertrag mit Sollstellungen lässt sich nicht direkt löschen (Restrict)", async () => {
    await db!.charge.create({ data: rent() });
    await expect(db!.lease.delete({ where: { id: leaseId } })).rejects.toThrow();
  });

  it("Stichtag: NULL → Wert einmal; ändern oder leeren wird abgelehnt", async () => {
    await db!.$executeRaw`UPDATE "Tenant" SET "ownerValidityCutoverAt" = NULL WHERE id = ${t.tenantId}`.catch(() => {});
    const row = await db!.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(row.ownerValidityCutoverAt).not.toBeNull(); // gesetzt bei Anlage, Leeren abgelehnt
    await expect(db!.tenant.update({ where: { id: t.tenantId }, data: { ownerValidityCutoverAt: new Date("2030-01-01") } })).rejects.toThrow(/ownerValidityCutoverAt is immutable/);
    await expect(db!.tenant.update({ where: { id: t.tenantId }, data: { ownerValidityCutoverAt: null } })).rejects.toThrow(/ownerValidityCutoverAt is immutable/);
  });

  it("Eigentümer: gleiche Person/Einheit darf sich zeitlich nicht überschneiden; CONFIRMED braucht validFrom", async () => {
    const base = { tenantId: t.tenantId, unitId, personId, share: 1000, vigencia: "CONFIRMED" as const };
    await db!.owner.create({ data: { ...base, validFrom: new Date("2026-01-01"), validTo: new Date("2026-07-01") } });
    await expect(db!.owner.create({ data: { ...base, validFrom: new Date("2026-06-01") } })).rejects.toThrow(/owner_no_overlap/);
    await expect(db!.owner.create({ data: { ...base, validFrom: new Date("2026-07-01") } })).resolves.toBeTruthy();
    const other = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "Rui", lastName: "Teste" } });
    await expect(db!.owner.create({ data: { ...base, personId: other.id, validFrom: null } })).rejects.toThrow(/owner_confirmed_needs_valid_from/);
  });
});

describeDb("Migration #52 bricht bei vorhandenen Finanzdaten ab", () => {
  it("lässt eine DB mit einer Sollstellung unverändert und meldet den Grund", async () => {
    const admin = process.env.INTEGRATION_DATABASE_URL!;
    const dbName = `mig52_${Date.now()}`;
    await db!.$executeRawUnsafe(`CREATE DATABASE ${dbName}`);
    const url = admin.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const dir = mkdtempSync(path.join(tmpdir(), "mig52-"));
    try {
      cpSync("prisma", dir, { recursive: true });
      rmSync(path.join(dir, "migrations", "20260927100000_quotas_foundation"), { recursive: true });
      const run = (schemaDir: string) =>
        spawnSync("npx", ["prisma", "migrate", "deploy", "--schema", path.join(schemaDir, "schema.prisma")], {
          env: { ...process.env, DATABASE_URL: url }, encoding: "utf8",
        });
      expect(run(dir).status).toBe(0); // Stand vor #52
      const { PrismaClient } = await import("@prisma/client");
      const old = new PrismaClient({ datasources: { db: { url } } });
      await old.$executeRawUnsafe(`INSERT INTO "Charge" (id, "tenantId", type, period, "dueDate", amount) VALUES ('c1', 't1', 'MIETE', now(), now(), 1)`);
      await old.$disconnect();
      const res = run("prisma");
      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toMatch(/Charge\/Payment enthalten Daten/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await db!.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    }
  });
});
