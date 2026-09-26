import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { CRMWARE_DEMO_ANCHOR, CRMWARE_DEMO_SCENARIOS, validateSeededScenarios } from "../../prisma/seed-crmware-demo";

const databaseUrl = process.env.CRMWARE_DEMO_TEST_DATABASE_URL;
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const client = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const demoPassword = `Local-${randomBytes(18).toString("base64url")}`;

function runSeed() {
  return spawnSync("npm", ["run", "db:seed:crmware"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      ALLOW_DEMO_SEED: "1",
      CRMWARE_DEMO_PASSWORD: demoPassword,
    },
    encoding: "utf8",
  });
}

describe.skipIf(!databaseUrl)("CrmWare demo seed database contract (#46)", () => {
  afterAll(async () => client?.$disconnect());

  it("is idempotent, validates its invariants and refuses a non-demo name collision", async () => {
    const first = runSeed();
    expect(first.status, first.stderr || first.stdout).toBe(0);
    const partialScenario = CRMWARE_DEMO_SCENARIOS[0];
    await client!.tenant.create({
      data: {
        name: partialScenario.tenantName,
        market: "PT",
        smtpFrom: `demo-seed@${partialScenario.emailDomain}`,
      },
    });
    const second = runSeed();
    expect(second.status, second.stderr || second.stdout).toBe(0);

    const validation = await validateSeededScenarios(client!);
    expect(validation.map((row) => row.errors)).toEqual([[], [], []]);

    const seededTenants = await client!.tenant.findMany({
      where: { name: { in: CRMWARE_DEMO_SCENARIOS.map((item) => item.tenantName) } },
      select: { id: true, name: true },
    });
    expect(seededTenants).toHaveLength(CRMWARE_DEMO_SCENARIOS.length);
    const tenantIds = seededTenants.map((tenant) => tenant.id);
    const charges = await client!.charge.findMany({
      where: { tenantId: { in: tenantIds }, leaseId: { not: null } },
      select: { leaseId: true, period: true },
    });
    const chargeMonths = charges.map((charge) => `${charge.leaseId}:${charge.period.toISOString().slice(0, 7)}`);
    expect(new Set(chargeMonths).size).toBe(chargeMonths.length);
    expect(await client!.charge.count({
      where: { tenantId: { in: tenantIds }, dunnings: { some: {} }, payments: { some: {} } },
    })).toBe(0);
    expect(await client!.payment.count({
      where: { tenantId: { in: tenantIds }, account: { name: "Conta de rendas" }, chargeId: null },
    })).toBe(0);
    const rentalTenantId = seededTenants.find((tenant) => tenant.name === CRMWARE_DEMO_SCENARIOS[2].tenantName)!.id;
    expect(await client!.payment.count({
      where: { tenantId: rentalTenantId, account: { name: "Conta operacional" }, chargeId: null },
    })).toBe(78);

    const mixedTenantId = seededTenants.find((tenant) => tenant.name === CRMWARE_DEMO_SCENARIOS[0].tenantName)!.id;
    expect(await client!.ticket.count({ where: { tenantId: mixedTenantId, reporterId: { not: null } } })).toBeGreaterThan(0);
    expect(await client!.person.count({
      where: { tenantId: { in: tenantIds }, note: { startsWith: "Condómino" }, owners: { none: {} } },
    })).toBe(0);
    expect(await client!.account.count({
      where: { tenantId: { in: tenantIds }, name: { startsWith: "Conta - " }, payments: { none: {} } },
    })).toBe(0);

    const resolutions = await client!.resolution.findMany({
      where: { tenantId: { in: tenantIds } },
      select: {
        votesYes: true,
        votesNo: true,
        votesAbstain: true,
        property: { select: { buildings: { select: { units: { select: { id: true } } } } } },
      },
    });
    expect(resolutions.every((resolution) => {
      const unitCount = resolution.property.buildings.reduce((total, building) => total + building.units.length, 0);
      const totalVotes = resolution.votesYes + resolution.votesNo + resolution.votesAbstain;
      return totalVotes <= unitCount;
    })).toBe(true);

    const resolutionSemantics = await client!.resolution.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { result: true, votesYes: true, votesNo: true, votesAbstain: true },
    });
    expect(resolutionSemantics.every((resolution) => resolution.result === "VERTAGT"
      ? resolution.votesYes + resolution.votesNo + resolution.votesAbstain === 0
      : resolution.result === "ANGENOMMEN"
        ? resolution.votesYes > resolution.votesNo
        : resolution.votesYes <= resolution.votesNo)).toBe(true);

    const reportedTickets = await client!.ticket.findMany({
      where: { tenantId: { in: tenantIds }, reporterId: { not: null } },
      select: {
        createdAt: true,
        reporter: { select: { personId: true } },
        unit: { select: { leases: { select: { startDate: true, endDate: true, renters: { select: { personId: true } } } } } },
      },
    });
    expect(reportedTickets.every((ticket) => ticket.unit?.leases.some((lease) =>
      lease.renters.some((renter) => renter.personId === ticket.reporter?.personId)
      && lease.startDate <= ticket.createdAt
      && (!lease.endDate || lease.endDate >= ticket.createdAt),
    ))).toBe(true);

    const linkedInvoices = await client!.document.findMany({
      where: { tenantId: { in: tenantIds }, invoiceTotal: { not: null }, payments: { some: {} } },
      select: { invoiceTotal: true, createdAt: true, payments: { select: { amount: true, date: true } } },
    });
    expect(linkedInvoices.length).toBeGreaterThan(0);
    expect(linkedInvoices.every((document) => document.payments.every((payment) =>
      Number(document.invoiceTotal) === Number(payment.amount)
      && document.createdAt.getTime() === payment.date.getTime(),
    ))).toBe(true);

    const futureCounts = await Promise.all([
      client!.payment.count({ where: { tenantId: { in: tenantIds }, date: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client!.ticket.count({ where: { tenantId: { in: tenantIds }, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client!.document.count({ where: { tenantId: { in: tenantIds }, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client!.notification.count({ where: { tenantId: { in: tenantIds }, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client!.auditLog.count({ where: { tenantId: { in: tenantIds }, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client!.reserveTransaction.count({ where: { tenantId: { in: tenantIds }, date: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client!.task.count({ where: { tenantId: { in: tenantIds }, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
      client!.appointment.count({ where: { tenantId: { in: tenantIds }, createdAt: { gt: CRMWARE_DEMO_ANCHOR } } }),
    ]);
    expect(futureCounts).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const chargeToDuplicate = await client!.charge.findFirstOrThrow({
      where: { tenantId: mixedTenantId, leaseId: { not: null } },
      select: { tenantId: true, leaseId: true, type: true, period: true, dueDate: true, amount: true, description: true },
    });
    const duplicate = await client!.charge.create({ data: chargeToDuplicate });
    try {
      const corrupted = await validateSeededScenarios(client!);
      expect(corrupted.find((row) => row.scenario === "mixed")?.errors.join(" ")).toMatch(/cobrado 2 vezes/);
    } finally {
      await client!.charge.delete({ where: { id: duplicate.id } });
    }

    const notification = await client!.notification.findFirstOrThrow({ where: { tenantId: mixedTenantId } });
    await client!.notification.update({ where: { id: notification.id }, data: { createdAt: new Date(CRMWARE_DEMO_ANCHOR.getTime() + 86_400_000) } });
    try {
      const corrupted = await validateSeededScenarios(client!);
      expect(corrupted.find((row) => row.scenario === "mixed")?.errors.join(" ")).toMatch(/data futura/);
    } finally {
      await client!.notification.update({ where: { id: notification.id }, data: { createdAt: notification.createdAt } });
    }

    const leasedUnit = await client!.unit.findFirstOrThrow({
      where: { tenantId: mixedTenantId, leases: { some: { endDate: { not: null } } } },
      select: { leases: { orderBy: { startDate: "asc" }, select: { id: true, startDate: true, endDate: true } } },
    });
    const terminatedLease = leasedUnit.leases.find((lease) => lease.endDate)!;
    const followingLease = leasedUnit.leases.find((lease) => lease.startDate > terminatedLease.startDate)!;
    await client!.lease.update({ where: { id: terminatedLease.id }, data: { endDate: followingLease.startDate } });
    try {
      const corrupted = await validateSeededScenarios(client!);
      expect(corrupted.find((row) => row.scenario === "mixed")?.errors.join(" ")).toMatch(/contratos sobrepostos/);
    } finally {
      await client!.lease.update({ where: { id: terminatedLease.id }, data: { endDate: terminatedLease.endDate } });
    }

    const tenantIdsBeforeCollision = await client!.tenant.findMany({
      where: { name: { in: CRMWARE_DEMO_SCENARIOS.map((item) => item.tenantName) } },
      orderBy: { name: "asc" },
      select: { id: true },
    });
    const scenario = CRMWARE_DEMO_SCENARIOS[1];
    const collision = await client!.tenant.create({ data: { name: scenario.tenantName, market: "PT" } });
    await client!.user.create({
      data: {
        tenantId: collision.id,
        email: "collision@not-a-demo.example",
        name: "Tenant real com nome coincidente",
        passwordHash: "not-a-real-password-hash",
        role: "ADMIN",
        locale: "pt",
      },
    });

    try {
      const rejected = runSeed();
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("Colisão de tenant não-demo");
      expect(await client!.tenant.count({ where: { id: collision.id } })).toBe(1);
      const tenantIdsAfterCollision = await client!.tenant.findMany({
        where: { id: { in: tenantIdsBeforeCollision.map((tenant) => tenant.id) } },
        orderBy: { name: "asc" },
        select: { id: true },
      });
      expect(tenantIdsAfterCollision).toEqual(tenantIdsBeforeCollision);
      const managed = await client!.tenant.findMany({
        where: { name: scenario.tenantName },
        select: { users: { select: { email: true } } },
      });
      expect(managed.some((tenant) => tenant.users.some((user) => user.email.endsWith(`@${scenario.emailDomain}`)))).toBe(true);
    } finally {
      await client!.tenant.delete({ where: { id: collision.id } });
    }
  }, 60_000);
});
