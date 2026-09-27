import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
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

  it("Konten, Eigentümer und Mahnungen sind mandantensicher: A darf nicht auf Konto, Person, Einheit oder Sollstellung von B zeigen", async () => {
    const other = await createTestTenant();
    try {
      const b = await fixtures(other.tenantId);
      const accountB = await db!.account.create({ data: { tenantId: other.tenantId, name: "Konto B" } });
      await expect(db!.payment.create({ data: { tenantId: t.tenantId, accountId: accountB.id, date: month, amount: 10 } })).rejects.toThrow(/Payment_accountId_tenantId_fkey/);
      await expect(db!.deposit.create({ data: { tenantId: t.tenantId, leaseId, type: "BAR", amount: 100, accountId: accountB.id } })).rejects.toThrow(/Deposit_accountId_tenantId_fkey/);
      const connector = await db!.bankConnector.create({ data: { tenantId: t.tenantId, applicationId: "app", privateKeyEnc: "x" } });
      await expect(db!.bankLink.create({ data: { tenantId: t.tenantId, connectorId: connector.id, accountId: accountB.id, aspspName: "N", aspspCountry: "PT", sessionId: "s", accountUid: "u" } })).rejects.toThrow(/BankLink_accountId_tenantId_fkey/);
      const owner = { tenantId: t.tenantId, share: 1000, vigencia: "CONFIRMED" as const, validFrom: month };
      await expect(db!.owner.create({ data: { ...owner, unitId, personId: b.personId } })).rejects.toThrow(/Owner_personId_tenantId_fkey/);
      await expect(db!.owner.create({ data: { ...owner, unitId: b.unitId, personId } })).rejects.toThrow(/Owner_unitId_tenantId_fkey/);
      const chargeB = await db!.charge.create({ data: { tenantId: other.tenantId, leaseId: b.leaseId, type: "MIETE", period: month, dueDate: month, amount: 1 } });
      await expect(db!.dunningNotice.create({ data: { tenantId: t.tenantId, chargeId: chargeB.id, level: 1 } })).rejects.toThrow(/DunningNotice_chargeId_tenantId_fkey/);
    } finally {
      await other.cleanup();
    }
  });

  it("Konto löschen setzt nur Payment.accountId auf NULL, tenantId bleibt", async () => {
    const account = await db!.account.create({ data: { tenantId: t.tenantId, name: "Konto" } });
    const payment = await db!.payment.create({ data: { tenantId: t.tenantId, accountId: account.id, date: month, amount: 10 } });
    await db!.account.delete({ where: { id: account.id } });
    const row = await db!.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.accountId).toBeNull();
    expect(row.tenantId).toBe(t.tenantId);
  });

  it("Sollstellung mit Mahnung lässt sich nicht direkt löschen (Restrict statt Cascade)", async () => {
    const charge = await db!.charge.create({ data: rent() });
    await db!.dunningNotice.create({ data: { tenantId: t.tenantId, chargeId: charge.id, level: 1 } });
    await expect(db!.charge.delete({ where: { id: charge.id } })).rejects.toThrow(/DunningNotice_chargeId_tenantId_fkey/);
    expect(await db!.dunningNotice.count({ where: { chargeId: charge.id } })).toBe(1);
  });

  it("Quota-Zeile: Einheit muss zum Objekt des Assessments gehören", async () => {
    const p2 = await db!.property.create({ data: { tenantId: t.tenantId, name: "P2", street: "S", zip: "1000-001", city: "Lisboa" } });
    const b2 = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: p2.id, name: "B2" } });
    const u2 = await db!.unit.create({ data: { tenantId: t.tenantId, buildingId: b2.id, label: "Z", area: 40 } });
    const assessment = await db!.condominiumAssessment.create({ data: { tenantId: t.tenantId, propertyId, period: month, kind: "ORDINARY", method: "PERMILLAGE", dueDate: month, asOf: month, totalCents: 100 } });
    const line = { tenantId: t.tenantId, assessmentId: assessment.id, amountCents: 100 };
    await expect(db!.condominiumAssessmentLine.create({ data: { ...line, unitId: u2.id } })).rejects.toThrow(/assessment line unit not in assessment property/);
    const ok = await db!.condominiumAssessmentLine.create({ data: { ...line, unitId } });
    await expect(db!.condominiumAssessmentLine.update({ where: { id: ok.id }, data: { unitId: u2.id } })).rejects.toThrow(/assessment line unit not in assessment property/);
  });

  it("Quota-Zeile: Einheit, Gebäude oder Assessment lassen sich nicht nachträglich in ein anderes Objekt verschieben", async () => {
    const { buildingId: b1 } = await db!.unit.findUniqueOrThrow({ where: { id: unitId } });
    const p2 = await db!.property.create({ data: { tenantId: t.tenantId, name: "P2", street: "S", zip: "1000-001", city: "Lisboa" } });
    const b2 = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: p2.id, name: "B2" } });
    const assessment = await db!.condominiumAssessment.create({ data: { tenantId: t.tenantId, propertyId, period: month, kind: "ORDINARY", method: "PERMILLAGE", dueDate: month, asOf: month, totalCents: 100 } });
    await db!.condominiumAssessmentLine.create({ data: { tenantId: t.tenantId, assessmentId: assessment.id, unitId, amountCents: 100 } });
    const msg = /assessment line unit not in assessment property/;
    await expect(db!.unit.update({ where: { id: unitId }, data: { buildingId: b2.id } })).rejects.toThrow(msg);
    await expect(db!.building.update({ where: { id: b1 }, data: { propertyId: p2.id } })).rejects.toThrow(msg);
    await expect(db!.condominiumAssessment.update({ where: { id: assessment.id }, data: { propertyId: p2.id } })).rejects.toThrow(msg);
  });

  it("Einheiten und Gebäude ohne Quota-Zeilen bleiben verschiebbar", async () => {
    const { buildingId: b1 } = await db!.unit.findUniqueOrThrow({ where: { id: unitId } });
    const p2 = await db!.property.create({ data: { tenantId: t.tenantId, name: "P2", street: "S", zip: "1000-001", city: "Lisboa" } });
    const b2 = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: p2.id, name: "B2" } });
    await expect(db!.unit.update({ where: { id: unitId }, data: { buildingId: b2.id } })).resolves.toBeTruthy();
    await expect(db!.building.update({ where: { id: b1 }, data: { propertyId: p2.id } })).resolves.toBeTruthy();
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

// Zwei Verbindungen: Zeile anlegen und Einheit/Gebäude verschieben dürfen sich nicht überholen.
describeDb("Quota-Zeile/Objekt-Invariante unter Nebenläufigkeit (#52)", () => {
  const db2 = new PrismaClient({ datasources: { db: { url: process.env.INTEGRATION_DATABASE_URL } } });
  const msg = /assessment line unit not in assessment property/;
  const txOpts = { timeout: 15_000, maxWait: 5_000 };
  let f: Awaited<ReturnType<typeof fixtures>> & { buildingId: string; assessmentId: string; p2: string; b2: string };

  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };
  // true, wenn das Promise nach `ms` noch offen ist (= wartet auf eine Zeilensperre).
  const blocked = async (p: Promise<unknown>, ms = 700) => {
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, ms));
    return !settled;
  };
  const crossPropertyLines = async () => {
    const [{ n }] = await db!.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "CondominiumAssessmentLine" l
      JOIN "CondominiumAssessment" a ON a.id = l."assessmentId"
      JOIN "Unit" u ON u.id = l."unitId" JOIN "Building" b ON b.id = u."buildingId"
      WHERE l."tenantId" = ${t.tenantId} AND b."propertyId" <> a."propertyId"`;
    return n;
  };
  const lockTimeout = (tx: { $executeRawUnsafe: (q: string) => Promise<number> }) => tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
  const insertLine = (client: PrismaClient, hold?: Promise<void>, started?: () => void) =>
    client.$transaction(async (tx) => {
      await lockTimeout(tx);
      await tx.condominiumAssessmentLine.create({ data: { tenantId: t.tenantId, assessmentId: f.assessmentId, unitId: f.unitId, amountCents: 100 } });
      started?.();
      await hold;
    }, txOpts);
  const move = (client: PrismaClient, what: "building" | "unit", hold?: Promise<void>, started?: () => void) =>
    client.$transaction(async (tx) => {
      await lockTimeout(tx);
      if (what === "building") await tx.building.update({ where: { id: f.buildingId }, data: { propertyId: f.p2 } });
      else await tx.unit.update({ where: { id: f.unitId }, data: { buildingId: f.b2 } });
      started?.();
      await hold;
    }, txOpts);

  beforeEach(async () => {
    t = await createTestTenant();
    const base = await fixtures(t.tenantId);
    const { buildingId } = await db!.unit.findUniqueOrThrow({ where: { id: base.unitId } });
    const p2 = await db!.property.create({ data: { tenantId: t.tenantId, name: "P2", street: "S", zip: "1000-001", city: "Lisboa" } });
    const b2 = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: p2.id, name: "B2" } });
    const a = await db!.condominiumAssessment.create({ data: { tenantId: t.tenantId, propertyId: base.propertyId, period: month, kind: "ORDINARY", method: "PERMILLAGE", dueDate: month, asOf: month, totalCents: 100 } });
    f = { ...base, buildingId, assessmentId: a.id, p2: p2.id, b2: b2.id };
  });
  afterEach(async () => {
    await t.cleanup();
  });
  afterAll(async () => {
    await db2.$disconnect();
  });

  for (const what of ["building", "unit"] as const) {
    it(`Zeile zuerst, dann ${what} verschieben: die Verschiebung wartet und scheitert`, async () => {
      const hold = gate();
      const inserted = gate();
      const a = insertLine(db!, hold.p, inserted.open);
      await inserted.p;
      const b = move(db2, what);
      const wasBlocked = await blocked(b);
      hold.open();
      const [ra, rb] = await Promise.allSettled([a, b]);
      expect(await crossPropertyLines()).toBe(0);
      expect(ra.status).toBe("fulfilled");
      expect(rb.status).toBe("rejected");
      expect(String((rb as PromiseRejectedResult).reason)).toMatch(msg);
      expect(wasBlocked).toBe(true);
    }, 30_000);
  }

  it("Gebäude zuerst verschieben, dann Zeile: die Zeile wartet und scheitert", async () => {
    const hold = gate();
    const moved = gate();
    const b = move(db2, "building", hold.p, moved.open);
    await moved.p;
    const a = insertLine(db!);
    const wasBlocked = await blocked(a);
    hold.open();
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(await crossPropertyLines()).toBe(0);
    expect(rb.status).toBe("fulfilled");
    expect(ra.status).toBe("rejected");
    expect(String((ra as PromiseRejectedResult).reason)).toMatch(msg);
    expect(wasBlocked).toBe(true);
  }, 30_000);
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
