# Quotas Foundation (#52, release 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the financial schema in its final form for condominium quotas: `PaymentAllocation` becomes the only payment↔charge link, `Charge` gets a lifecycle status and exactly one target, the quota tables exist (no UI), and every reader and writer uses one balance formula.

**Architecture:** One hand-written Prisma migration creates the final schema (no expand/contract: there is no legacy financial data, and the migration aborts if `Charge` or `Payment` has rows). Partial unique indexes, CHECKs, a GiST exclusion constraint and a trigger live in raw SQL. Application code gets two small libraries — `src/lib/charges.ts` (balance, subject, lease resolution) and `src/lib/payments.ts` (allocating payments with cap and lock) — and every existing reader/writer is moved onto them.

**Tech Stack:** Next.js 16 (App Router, server actions), Prisma 6.19 + PostgreSQL 16, Vitest (node env), Docker for tests.

**Spec:** GitHub issue #52 body (canonical, revisions 2026-09-26 and 2026-09-26 (2)): https://github.com/manueljpconde/hausverwaltung/issues/52 — section "Especificação técnica (canónica)" and "Plano por releases → 1. Fundação".

## Global Constraints

- Work only in the worktree `/Users/mjpc/Play/github/hausverwaltung-r1` (branch `feat/52-release1`). Others work in `/Users/mjpc/Play/github/hausverwaltung` in parallel: never switch branches, stash, reset or pull there.
- Every tenant-owned row and every query is scoped by `tenantId`. Every foreign key this release creates or changes is composite `(x, tenantId) → (id, tenantId)`: `Charge → Lease / AreaAllocation / QuotaDebtorSnapshot`, `PaymentAllocation → Payment / Charge`, `CondominiumAssessment → Property`, `CondominiumAssessmentLine → CondominiumAssessment / Unit`, `QuotaDebtorSnapshot → CondominiumAssessmentLine / Person`. Pre-existing FKs outside the financial boundary (`Lease → Unit`, …) are out of scope.
- `Charge` targets — exactly one: rent (`leaseId`), area (`areaAllocationId`), quota (`quotaDebtorSnapshotId`, `type = HAUSGELD`). Never two. `HAUSGELD` only with a snapshot.
- `Charge.status`: `ISSUED` | `CANCELLED`. No `LEGACY`. All partial uniques are `WHERE status = 'ISSUED'`.
- Balance (only formula, `chargeBalance()`): `incoming = Σ allocation.amount (payment EINGANG)`, `outgoing = Σ allocation.amount (payment AUSGANG)`, `open = amount − incoming + outgoing` for `ISSUED`, `0` for `CANCELLED`. Without `allowCredit`: `outgoing ≤ incoming` and `incoming − outgoing ≤ amount`. `Σ allocations of a payment ≤ payment.amount`.
- Dunning only when `status = ISSUED`, `open > 0.005` and `dueDate` in the past.
- Generators treat only unique violations (Prisma `P2002`, Postgres `23505`) as "already generated"; every other error propagates.
- `Payment.chargeId` does not exist after this release.
- No quota UI, no quota generation, no `voidCharge` (release 2 "Domínio"). `deleteCharge` stays, but refuses charges with allocations.
- Between Task 1 and Task 7 `tsc` is expected to fail in files not yet migrated (Vitest does not type-check). Task 8 makes `tsc` clean; no commit after Task 8 may leave it red.
- Code comments follow the file's existing language (German in `src/`), UI copy via `messages/{de,en,pt}.json`.
- Money in the quota tables is integer cents (`*Cents Int`); `Charge.amount` / `Payment.amount` / `PaymentAllocation.amount` stay `Decimal(10,2)`.

## Decisions taken in this plan (review these)

1. **Rent unique index only for `type = 'MIETE'`.** The spec says `(leaseId, period, type)`. Taken literally, it would forbid two manual `SONSTIGES` (or `KAUTION`) charges on the same lease in the same month, which is legitimate today. The generator only deduplicates `MIETE`, so the index is `WHERE status = 'ISSUED' AND type = 'MIETE' AND leaseId IS NOT NULL`. Cost if wrong: one index predicate.
2. **Payment beyond the open amount:** `recordPayment` allocates `min(payment.amount, open)`; the rest of the payment stays unapplied (spec: "O resto fica por aplicar"). Imports keep the rest silently unapplied; the **manual** `createPayment` tells the user how much was applied and how much stays unapplied. Refunds (`AUSGANG`) are capped at `incoming − outgoing`. `allowCredit` is not exposed yet; the parameter exists and defaults to `false`.
3. **New owners are `CONFIRMED` with a required `validFrom`** from this release on (spec rule), enforced by the database: the migration marks existing rows `UNKNOWN`, then the column default becomes `CONFIRMED`, so a new row without `validFrom` fails the CHECK. The owner dialog gets a "Desde" date input (default today).
4. **`deleteCharge` (UI and API) refuses charges that have allocations or dunning notices** (no financial history is deleted). Release 2 replaces it with `voidCharge`.
5. **`deleteTenant` deletes the tenant's financial rows explicitly** in one transaction (`Charge`/`Payment` have no FK to `Tenant`; today payments are left orphaned), and stops swallowing errors.
6. **The migration locks `Charge` and `Payment` (`ACCESS EXCLUSIVE`) before its empty-table check**, so no writer can insert between the check and dropping `Payment.chargeId`. Postgres runs the multi-statement migration script as one implicit transaction, so the lock holds until the end. The deploy also stops the old app first (`update.sh` recreates the container).
7. **A payment split over several charges** is labelled by all its charges: one type → that type; several types → "mixed" (`finances.mixedCharges`), in Finanças and DATEV.

## Review Focus

1. Two payments for the same charge committed concurrently → the sum of allocations never exceeds the open amount (pinned in Task 4: parallel `recordPayment`).
2. Area charges now have `leaseId = NULL` → they must still appear in the portal, SEPA, dunning, open-items CSV and the dunning letter via `areaAllocation.lease` (pinned in Task 6: area charge visible through `chargeLease`).
3. A `CANCELLED` rent charge must not block regenerating that month (pinned in Task 5 and Task 2's index test).
4. A refund (`AUSGANG`) allocated to a charge increases the open amount instead of counting as a payment (pinned in Task 3 and Task 4).
5. Deleting an organisation removes all its payments, allocations, dunning notices and the whole quota chain — no orphans (pinned in Task 7).
6. A charge, line or snapshot of organisation A pointing at a lease, area, property, unit or person of organisation B is rejected by the database (pinned in Task 1).

---

## File Structure

- `prisma/schema.prisma` — modify: enums, `Charge`, `Payment`, `Owner`, `Tenant`, new models `CondominiumAssessment`, `CondominiumAssessmentLine`, `QuotaDebtorSnapshot`, `PaymentAllocation`.
- `prisma/migrations/20260927100000_quotas_foundation/migration.sql` — create: the whole release in SQL.
- `src/lib/test-db.ts` — create: integration-test helper (client, skip flag, tenant fixture, cleanup).
- `src/lib/charges.ts` — create: `ALLOCATIONS_FOR_BALANCE`, `chargeBalance`, `LEASE_TARGET_INCLUDE`, `chargeLease`, `chargeSubject`.
- `src/lib/payments.ts` — create: `recordPayment`, `deletePaymentWithAllocations`, `openChargesForMatching`, `PaymentError`.
- `src/lib/charge-generation.ts` — create: `isUniqueViolation`, `generateRentCharges` (moved from the two duplicated loops), `generateAreaCharges` (moved from `api-ops.ts`).
- Readers/writers to modify (Tasks 4–8): `src/server/actions/finances.ts`, `src/server/actions/banking.ts`, `src/server/actions/statement-actions.ts`, `src/server/actions/ai.ts`, `src/server/actions/weg.ts`, `src/server/actions/tenants.ts`, `src/lib/api-ops.ts`, `src/lib/api-write.ts`, `src/lib/api-data.ts`, `src/lib/schemas.ts`, `src/app/[locale]/(admin)/finances/page.tsx`, `src/app/[locale]/(admin)/dunning/page.tsx`, `src/app/[locale]/(admin)/reports/page.tsx`, `src/app/[locale]/(admin)/dashboard/page.tsx`, `src/app/[locale]/portal/page.tsx`, `src/app/[locale]/print/dunning/page.tsx`, `src/app/api/export/openitems/route.ts`, `src/app/api/export/sepa/route.ts`, `src/app/api/export/datev/route.ts`, `src/components/finance-dialogs.tsx`, `src/components/weg-dialogs.tsx`, `prisma/seed.ts`, `prisma/seed-crmware-demo.ts`, `.github/workflows/test.yml`, `messages/{de,en,pt}.json`.

## Test commands (used by every task)

Local tests need OpenSSL for the Prisma engine and a Postgres. Created once in Task 0:

```bash
# test image (node 24 + openssl), reused
docker build -t havewa-test:node24 - <<'EOF'
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
EOF
# Postgres for integration tests (default bridge network; host port only on 127.0.0.1)
docker run -d --name r1-pg -p 127.0.0.1:54399:5432 -e POSTGRES_USER=havewa -e POSTGRES_PASSWORD=havewa -e POSTGRES_DB=havewa_test postgres:16-alpine
```

`T` below means (run from the worktree):

```bash
T() { docker run --rm -v "$PWD":/app -v havewa-test-nm:/app/node_modules -w /app \
  -e DATABASE_URL=postgresql://havewa:havewa@host.docker.internal:54399/havewa_test \
  -e INTEGRATION_DATABASE_URL=postgresql://havewa:havewa@host.docker.internal:54399/havewa_test \
  havewa-test:node24 sh -c "npx prisma generate >/dev/null && $*"; }
```

- Apply migrations: `T "npx prisma migrate deploy"`
- Run one file: `T "npx vitest run src/lib/charges.test.ts"`
- Full suite: `T "npx vitest run"`
- Type check: `T "npx tsc --noEmit -p ."` (3 pre-existing errors in `src/lib/sso.test.ts` are accepted)

---

### Task 0: Integration-test harness

**Files:**
- Create: `src/lib/test-db.ts`
- Create: `src/lib/test-db.test.ts`
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Produces: `integrationDb: PrismaClient | null`, `describeDb` (= `describe.skipIf(!integrationDb)`), `createTestTenant(): Promise<{ tenantId: string; cleanup(): Promise<void> }>`.

- [ ] **Step 1: Build the test image and start Postgres** (commands in "Test commands"), then `T "npx prisma migrate deploy"`. Expected: `All migrations have been successfully applied.`

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/test-db.test.ts
import { expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb } from "./test-db";

describeDb("Integrations-DB (#52)", () => {
  it("legt einen isolierten Mandanten an und räumt ihn wieder weg", async () => {
    const { tenantId, cleanup } = await createTestTenant();
    expect(await integrationDb!.tenant.count({ where: { id: tenantId } })).toBe(1);
    await cleanup();
    expect(await integrationDb!.tenant.count({ where: { id: tenantId } })).toBe(0);
  });
});
```

- [ ] **Step 3: Run it.** `T "npx vitest run src/lib/test-db.test.ts"` — Expected: FAIL, `Cannot find module './test-db'`.

- [ ] **Step 4: Implement**

```ts
// src/lib/test-db.ts
// Nur für Tests: echte Postgres-DB (INTEGRATION_DATABASE_URL), sonst werden die Suiten übersprungen.
import { PrismaClient } from "@prisma/client";
import { describe } from "vitest";

const url = process.env.INTEGRATION_DATABASE_URL;
export const integrationDb = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
export const describeDb = describe.skipIf(!integrationDb);

export async function createTestTenant() {
  const db = integrationDb!;
  const tenant = await db.tenant.create({ data: { name: `test-${crypto.randomUUID()}` } });
  const tenantId = tenant.id;
  return {
    tenantId,
    // Finanzdaten haben keine FK auf Tenant → explizit und in Abhängigkeitsreihenfolge löschen.
    async cleanup() {
      await db.$transaction([
        db.paymentAllocation.deleteMany({ where: { tenantId } }),
        db.dunningNotice.deleteMany({ where: { tenantId } }),
        db.payment.deleteMany({ where: { tenantId } }),
        db.charge.deleteMany({ where: { tenantId } }),
        db.quotaDebtorSnapshot.deleteMany({ where: { tenantId } }),
        db.condominiumAssessmentLine.deleteMany({ where: { tenantId } }),
        db.condominiumAssessment.deleteMany({ where: { tenantId } }),
        db.areaAllocation.deleteMany({ where: { tenantId } }),
        db.lease.deleteMany({ where: { tenantId } }),
        db.tenant.delete({ where: { id: tenantId } }),
      ]);
    },
  };
}
```

`paymentAllocation`, `quotaDebtorSnapshot`, `condominiumAssessmentLine`, `condominiumAssessment` only exist after Task 1. Until then, write `cleanup` with just `db.tenant.delete(...)`; Task 1 Step 6 replaces it with the full version above.

- [ ] **Step 5: Run it.** Expected: PASS (1 test).

- [ ] **Step 6: CI** — in `.github/workflows/test.yml`, give the `npm test` step the integration URL:

```yaml
      - run: npm test
        env:
          INTEGRATION_DATABASE_URL: postgresql://havewa:havewa@localhost:5432/havewa_test?schema=public
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/test-db.ts src/lib/test-db.test.ts .github/workflows/test.yml
git commit -m "test(#52): integration-test harness on a real Postgres"
```

---

### Task 1: Final schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260927100000_quotas_foundation/migration.sql`
- Modify: `src/lib/test-db.ts` (full `cleanup`)
- Test: `src/lib/quotas-schema.test.ts`

**Interfaces:**
- Produces (Prisma client): enums `ChargeStatus { ISSUED CANCELLED }`, `OwnerVigencia { CONFIRMED UNKNOWN }`, `QuotaKind { ORDINARY EXTRAORDINARY }`, `AssessmentMethod { PERMILLAGE FIXED CUSTOM }`, `AssessmentStatus { ISSUED CANCELLED }`; `Charge.status`, `Charge.quotaDebtorSnapshotId`, `Charge.allocations`; `Payment.allocations` (no `chargeId`); `Owner.validFrom/validTo/vigencia`; `Tenant.ownerValidityCutoverAt`; models `PaymentAllocation`, `CondominiumAssessment`, `CondominiumAssessmentLine`, `QuotaDebtorSnapshot`.

- [ ] **Step 1: Edit `prisma/schema.prisma`**

`Tenant` — add:
```prisma
  // #52: Stichtag der Eigentümer-Gültigkeit; UNKNOWN-Eigentümer zählen nur ab hier. Trigger: nur NULL → Wert.
  ownerValidityCutoverAt DateTime? @default(now())
```

`Owner` — add:
```prisma
  validFrom DateTime?
  validTo   DateTime?
  vigencia  OwnerVigencia @default(CONFIRMED) // Bestand vor #52 = UNKNOWN (Migration)
```

`Charge` — replace the model with:
```prisma
model Charge {
  id          String         @id @default(cuid())
  tenantId    String
  leaseId     String?
  lease       Lease?         @relation(fields: [leaseId, tenantId], references: [id, tenantId], onDelete: Restrict)
  // Flächenmodell-Miete: Sollstellung aus einer Teilfläche (statt Vertrag).
  areaAllocationId String?
  areaAllocation   AreaAllocation? @relation(fields: [areaAllocationId, tenantId], references: [id, tenantId], onDelete: Restrict)
  // #52: Hausgeld-Sollstellung eines Eigentümers (eingefrorener Schuldner).
  quotaDebtorSnapshotId String?
  quotaDebtorSnapshot   QuotaDebtorSnapshot? @relation(fields: [quotaDebtorSnapshotId, tenantId], references: [id, tenantId], onDelete: Restrict)
  status      ChargeStatus   @default(ISSUED)
  type        ChargeType     @default(MIETE)
  period      DateTime // Monatserster des Abrechnungsmonats
  dueDate     DateTime
  amount      Decimal        @db.Decimal(10, 2)
  description String?
  allocations PaymentAllocation[]
  dunnings    DunningNotice[]
  createdAt   DateTime       @default(now())

  // Eindeutigkeit (nur ISSUED), Ziel-CHECKs und (id, tenantId) liegen im SQL der Migration.
  @@unique([id, tenantId])
  @@index([tenantId])
  @@index([leaseId])
  @@index([areaAllocationId])
  @@index([quotaDebtorSnapshotId])
}
```

`Payment` — remove `chargeId`, `charge` and `@@index([chargeId])`; add:
```prisma
  allocations PaymentAllocation[]
  @@unique([id, tenantId])
```

New models and enums (append):
```prisma
enum ChargeStatus {
  ISSUED
  CANCELLED
}

enum OwnerVigencia {
  CONFIRMED
  UNKNOWN
}

enum QuotaKind {
  ORDINARY
  EXTRAORDINARY
}

enum AssessmentMethod {
  PERMILLAGE
  FIXED
  CUSTOM
}

enum AssessmentStatus {
  ISSUED
  CANCELLED
}

// #52: Zuordnung Zahlung → Sollstellung (einzige Verknüpfung; Saldo nur hieraus).
model PaymentAllocation {
  id        String   @id @default(cuid())
  tenantId  String
  paymentId String
  payment   Payment  @relation(fields: [paymentId, tenantId], references: [id, tenantId], onDelete: Restrict)
  chargeId  String
  charge    Charge   @relation(fields: [chargeId, tenantId], references: [id, tenantId], onDelete: Restrict)
  amount    Decimal  @db.Decimal(10, 2)
  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([paymentId])
  @@index([chargeId])
}

// #52: Hausgeld-Emission je Objekt, Periode und Art (ohne UI in diesem Release).
model CondominiumAssessment {
  id          String           @id @default(cuid())
  tenantId    String
  propertyId  String
  property    Property         @relation(fields: [propertyId, tenantId], references: [id, tenantId], onDelete: Restrict)
  period      DateTime
  kind        QuotaKind
  method      AssessmentMethod
  dueDate     DateTime
  asOf        DateTime
  totalCents  Int
  status      AssessmentStatus @default(ISSUED)
  lines       CondominiumAssessmentLine[]
  createdAt   DateTime         @default(now())

  @@unique([id, tenantId])
  @@index([tenantId])
}

model CondominiumAssessmentLine {
  id           String                @id @default(cuid())
  tenantId     String
  assessmentId String
  assessment   CondominiumAssessment @relation(fields: [assessmentId, tenantId], references: [id, tenantId], onDelete: Restrict)
  unitId       String
  unit         Unit                  @relation(fields: [unitId, tenantId], references: [id, tenantId], onDelete: Restrict)
  amountCents  Int
  snapshots    QuotaDebtorSnapshot[]

  @@unique([assessmentId, unitId])
  @@unique([id, tenantId])
  @@index([tenantId])
}

model QuotaDebtorSnapshot {
  id            String                    @id @default(cuid())
  tenantId      String
  lineId        String
  line          CondominiumAssessmentLine @relation(fields: [lineId, tenantId], references: [id, tenantId], onDelete: Restrict)
  personId      String
  person        Person                    @relation(fields: [personId, tenantId], references: [id, tenantId], onDelete: Restrict)
  shareSnapshot Int
  amountCents   Int
  charges       Charge[]

  @@unique([lineId, personId])
  @@index([tenantId])
}
```

Add the back-relations Prisma requires: `Property.assessments CondominiumAssessment[]`, `Unit.assessmentLines CondominiumAssessmentLine[]`, `Person.quotaSnapshots QuotaDebtorSnapshot[]`.

Composite targets need `@@unique([id, tenantId])` on `Lease`, `AreaAllocation`, `Property`, `Unit` and `Person` (created in the migration).

- [ ] **Step 2: Write the failing tests**

```ts
// src/lib/quotas-schema.test.ts
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

  it("Miete: eine ISSUED je Vertrag/Monat; CANCELLED blockiert nicht", async () => {
    const first = await db!.charge.create({ data: rent() });
    await expect(db!.charge.create({ data: rent() })).rejects.toThrow(/charge_rent_issued_uniq/);
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
    await expect(db!.charge.create({ data: area })).rejects.toThrow(/charge_area_issued_uniq/);
    await db!.charge.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await expect(db!.charge.create({ data: area })).resolves.toBeTruthy();
  });

  it("Quota-Kette: je Snapshot höchstens eine ISSUED-Sollstellung, je Objekt/Periode/Art ein ISSUED-Assessment", async () => {
    const a = { tenantId: t.tenantId, propertyId, period: month, kind: "ORDINARY" as const, method: "PERMILLAGE" as const, dueDate: month, asOf: month, totalCents: 10000 };
    const assessment = await db!.condominiumAssessment.create({ data: a });
    await expect(db!.condominiumAssessment.create({ data: a })).rejects.toThrow(/assessment_issued_uniq/);
    const line = await db!.condominiumAssessmentLine.create({ data: { tenantId: t.tenantId, assessmentId: assessment.id, unitId, amountCents: 10000 } });
    const snap = await db!.quotaDebtorSnapshot.create({ data: { tenantId: t.tenantId, lineId: line.id, personId, shareSnapshot: 1000, amountCents: 10000 } });
    const q = { tenantId: t.tenantId, quotaDebtorSnapshotId: snap.id, type: "HAUSGELD" as const, period: month, dueDate: month, amount: 100 };
    const first = await db!.charge.create({ data: q });
    await expect(db!.charge.create({ data: q })).rejects.toThrow(/charge_quota_issued_uniq/);
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
```

- [ ] **Step 3: Run it.** `T "npx vitest run src/lib/quotas-schema.test.ts"` — Expected: FAIL (unknown fields `status`, `quotaDebtorSnapshotId`, models missing).

- [ ] **Step 4: Write the migration**

```sql
-- prisma/migrations/20260927100000_quotas_foundation/migration.sql
-- #52 Fundação: endgültiges Finanzschema. Keine Altdaten → kein Backfill; Abbruch, falls doch welche existieren.
-- Das Skript läuft als eine implizite Transaktion: die Sperre hält bis zum Ende, kein Schreiber kann zwischen Prüfung und DROP einfügen.
LOCK TABLE "Charge", "Payment" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Charge") OR EXISTS (SELECT 1 FROM "Payment") THEN
    RAISE EXCEPTION '#52: Charge/Payment enthalten Daten; diese Migration setzt eine leere Finanzbasis voraus.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "ChargeStatus" AS ENUM ('ISSUED', 'CANCELLED');
CREATE TYPE "OwnerVigencia" AS ENUM ('CONFIRMED', 'UNKNOWN');
CREATE TYPE "QuotaKind" AS ENUM ('ORDINARY', 'EXTRAORDINARY');
CREATE TYPE "AssessmentMethod" AS ENUM ('PERMILLAGE', 'FIXED', 'CUSTOM');
CREATE TYPE "AssessmentStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- Tenant: Stichtag, für Bestehende = Zeitpunkt dieser Transaktion, für Neue = Anlage.
ALTER TABLE "Tenant" ADD COLUMN "ownerValidityCutoverAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "Tenant" SET "ownerValidityCutoverAt" = transaction_timestamp();
CREATE FUNCTION tenant_cutover_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."ownerValidityCutoverAt" IS NOT NULL
     AND NEW."ownerValidityCutoverAt" IS DISTINCT FROM OLD."ownerValidityCutoverAt" THEN
    RAISE EXCEPTION 'ownerValidityCutoverAt is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tenant_cutover_immutable BEFORE UPDATE OF "ownerValidityCutoverAt" ON "Tenant"
  FOR EACH ROW EXECUTE FUNCTION tenant_cutover_immutable();

-- Owner: Gültigkeit; Bestehende = UNKNOWN, Neue = CONFIRMED (Default) → ohne validFrom scheitert der CHECK.
ALTER TABLE "Owner" ADD COLUMN "validFrom" TIMESTAMP(3), ADD COLUMN "validTo" TIMESTAMP(3),
  ADD COLUMN "vigencia" "OwnerVigencia" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "Owner" ALTER COLUMN "vigencia" SET DEFAULT 'CONFIRMED';
ALTER TABLE "Owner" ADD CONSTRAINT owner_confirmed_needs_valid_from CHECK ("vigencia" <> 'CONFIRMED' OR "validFrom" IS NOT NULL);
ALTER TABLE "Owner" ADD CONSTRAINT owner_valid_range CHECK ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" > "validFrom");
ALTER TABLE "Owner" ADD CONSTRAINT owner_no_overlap EXCLUDE USING gist (
  "unitId" WITH =, "personId" WITH =,
  tsrange(COALESCE("validFrom", '-infinity'::timestamp), COALESCE("validTo", 'infinity'::timestamp), '[)') WITH &&
);

-- Ziele zusammengesetzter FKs (id, tenantId): Mandantengrenzen liegen in der DB.
CREATE UNIQUE INDEX "Lease_id_tenantId_key" ON "Lease"("id", "tenantId");
CREATE UNIQUE INDEX "AreaAllocation_id_tenantId_key" ON "AreaAllocation"("id", "tenantId");
CREATE UNIQUE INDEX "Property_id_tenantId_key" ON "Property"("id", "tenantId");
CREATE UNIQUE INDEX "Unit_id_tenantId_key" ON "Unit"("id", "tenantId");
CREATE UNIQUE INDEX "Person_id_tenantId_key" ON "Person"("id", "tenantId");

-- Quota-Tabellen.
CREATE TABLE "CondominiumAssessment" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "propertyId" TEXT NOT NULL,
  "period" TIMESTAMP(3) NOT NULL, "kind" "QuotaKind" NOT NULL, "method" "AssessmentMethod" NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL, "asOf" TIMESTAMP(3) NOT NULL, "totalCents" INTEGER NOT NULL,
  "status" "AssessmentStatus" NOT NULL DEFAULT 'ISSUED', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT assessment_total_nonneg CHECK ("totalCents" >= 0)
);
CREATE UNIQUE INDEX "CondominiumAssessment_id_tenantId_key" ON "CondominiumAssessment"("id", "tenantId");
CREATE INDEX "CondominiumAssessment_tenantId_idx" ON "CondominiumAssessment"("tenantId");
CREATE UNIQUE INDEX assessment_issued_uniq ON "CondominiumAssessment"("tenantId", "propertyId", "period", "kind") WHERE "status" = 'ISSUED';
ALTER TABLE "CondominiumAssessment" ADD CONSTRAINT "CondominiumAssessment_propertyId_tenantId_fkey"
  FOREIGN KEY ("propertyId", "tenantId") REFERENCES "Property"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CondominiumAssessmentLine" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "assessmentId" TEXT NOT NULL, "unitId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL, CONSTRAINT line_amount_nonneg CHECK ("amountCents" >= 0)
);
CREATE UNIQUE INDEX "CondominiumAssessmentLine_assessmentId_unitId_key" ON "CondominiumAssessmentLine"("assessmentId", "unitId");
CREATE UNIQUE INDEX "CondominiumAssessmentLine_id_tenantId_key" ON "CondominiumAssessmentLine"("id", "tenantId");
CREATE INDEX "CondominiumAssessmentLine_tenantId_idx" ON "CondominiumAssessmentLine"("tenantId");
ALTER TABLE "CondominiumAssessmentLine" ADD CONSTRAINT "CondominiumAssessmentLine_assessmentId_tenantId_fkey"
  FOREIGN KEY ("assessmentId", "tenantId") REFERENCES "CondominiumAssessment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CondominiumAssessmentLine" ADD CONSTRAINT "CondominiumAssessmentLine_unitId_tenantId_fkey"
  FOREIGN KEY ("unitId", "tenantId") REFERENCES "Unit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "QuotaDebtorSnapshot" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "lineId" TEXT NOT NULL, "personId" TEXT NOT NULL,
  "shareSnapshot" INTEGER NOT NULL, "amountCents" INTEGER NOT NULL,
  CONSTRAINT snapshot_share_range CHECK ("shareSnapshot" BETWEEN 1 AND 1000),
  CONSTRAINT snapshot_amount_nonneg CHECK ("amountCents" >= 0)
);
CREATE UNIQUE INDEX "QuotaDebtorSnapshot_lineId_personId_key" ON "QuotaDebtorSnapshot"("lineId", "personId");
CREATE UNIQUE INDEX "QuotaDebtorSnapshot_id_tenantId_key" ON "QuotaDebtorSnapshot"("id", "tenantId");
CREATE INDEX "QuotaDebtorSnapshot_tenantId_idx" ON "QuotaDebtorSnapshot"("tenantId");
ALTER TABLE "QuotaDebtorSnapshot" ADD CONSTRAINT "QuotaDebtorSnapshot_lineId_tenantId_fkey"
  FOREIGN KEY ("lineId", "tenantId") REFERENCES "CondominiumAssessmentLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QuotaDebtorSnapshot" ADD CONSTRAINT "QuotaDebtorSnapshot_personId_tenantId_fkey"
  FOREIGN KEY ("personId", "tenantId") REFERENCES "Person"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Charge: Status, Quota-Ziel, Restrict, genau ein Ziel, Eindeutigkeit nur für ISSUED.
ALTER TABLE "Charge" ADD COLUMN "status" "ChargeStatus" NOT NULL DEFAULT 'ISSUED', ADD COLUMN "quotaDebtorSnapshotId" TEXT;
ALTER TABLE "Charge" DROP CONSTRAINT "Charge_leaseId_fkey";
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_leaseId_tenantId_fkey" FOREIGN KEY ("leaseId", "tenantId") REFERENCES "Lease"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Charge" DROP CONSTRAINT "Charge_areaAllocationId_fkey";
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_areaAllocationId_tenantId_fkey" FOREIGN KEY ("areaAllocationId", "tenantId") REFERENCES "AreaAllocation"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_quotaDebtorSnapshotId_tenantId_fkey"
  FOREIGN KEY ("quotaDebtorSnapshotId", "tenantId") REFERENCES "QuotaDebtorSnapshot"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Charge" ADD CONSTRAINT charge_exactly_one_target CHECK (
  (("leaseId" IS NOT NULL)::int + ("areaAllocationId" IS NOT NULL)::int + ("quotaDebtorSnapshotId" IS NOT NULL)::int) = 1
);
ALTER TABLE "Charge" ADD CONSTRAINT charge_hausgeld_needs_snapshot CHECK (("type" = 'HAUSGELD') = ("quotaDebtorSnapshotId" IS NOT NULL));
DROP INDEX "Charge_areaAllocationId_period_key";
CREATE UNIQUE INDEX "Charge_id_tenantId_key" ON "Charge"("id", "tenantId");
CREATE INDEX "Charge_areaAllocationId_idx" ON "Charge"("areaAllocationId");
CREATE INDEX "Charge_quotaDebtorSnapshotId_idx" ON "Charge"("quotaDebtorSnapshotId");
CREATE UNIQUE INDEX charge_area_issued_uniq ON "Charge"("areaAllocationId", "period") WHERE "status" = 'ISSUED' AND "areaAllocationId" IS NOT NULL;
CREATE UNIQUE INDEX charge_rent_issued_uniq ON "Charge"("leaseId", "period") WHERE "status" = 'ISSUED' AND "type" = 'MIETE' AND "leaseId" IS NOT NULL;
CREATE UNIQUE INDEX charge_quota_issued_uniq ON "Charge"("quotaDebtorSnapshotId") WHERE "status" = 'ISSUED' AND "quotaDebtorSnapshotId" IS NOT NULL;

-- Payment: chargeId entfällt; (id, tenantId) für die Zuordnung.
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_chargeId_fkey";
DROP INDEX "Payment_chargeId_idx";
ALTER TABLE "Payment" DROP COLUMN "chargeId";
CREATE UNIQUE INDEX "Payment_id_tenantId_key" ON "Payment"("id", "tenantId");

CREATE TABLE "PaymentAllocation" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "paymentId" TEXT NOT NULL, "chargeId" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT allocation_amount_positive CHECK ("amount" > 0)
);
CREATE INDEX "PaymentAllocation_tenantId_idx" ON "PaymentAllocation"("tenantId");
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");
CREATE INDEX "PaymentAllocation_chargeId_idx" ON "PaymentAllocation"("chargeId");
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_tenantId_fkey"
  FOREIGN KEY ("paymentId", "tenantId") REFERENCES "Payment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_chargeId_tenantId_fkey"
  FOREIGN KEY ("chargeId", "tenantId") REFERENCES "Charge"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
```

Check the exact names of the existing constraints/indexes before running (`Charge_leaseId_fkey`, `Charge_areaAllocationId_fkey`, `Charge_areaAllocationId_period_key`, `Payment_chargeId_fkey`, `Payment_chargeId_idx`): `grep -rn "Charge_\|Payment_chargeId" prisma/migrations/*/migration.sql`. Use what the earlier migrations created.

- [ ] **Step 5: Apply and generate.** `T "npx prisma migrate deploy"` — Expected: `Applying migration 20260927100000_quotas_foundation` and success. Then `T "npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url \$DATABASE_URL --exit-code"`: the only differences allowed are the raw-SQL objects Prisma cannot express (partial indexes, CHECKs, exclusion, trigger). If it reports a column/relation/enum difference, the schema and SQL disagree — fix before continuing.

- [ ] **Step 6: Full `cleanup` in `src/lib/test-db.ts`** (the version shown in Task 0 Step 4).

- [ ] **Step 7: Run the tests.** `T "npx vitest run src/lib/quotas-schema.test.ts"` — Expected: PASS (13 tests).

- [ ] **Step 8: Migration guard test** — add to `src/lib/quotas-schema.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
```

Run it — Expected: PASS. (Before Step 4 it would have failed with the migration not existing; this test guards the abort.)

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260927100000_quotas_foundation src/lib/test-db.ts src/lib/quotas-schema.test.ts
git commit -m "feat(#52): final financial schema — allocations, charge status, quota tables, DB guarantees"
```

---

### Task 2: `chargeBalance`, `chargeLease`, `chargeSubject`

**Files:**
- Create: `src/lib/charges.ts`
- Test: `src/lib/charges.test.ts`

**Interfaces:**
- Produces:
  - `ALLOCATIONS_FOR_BALANCE = { select: { amount: true, payment: { select: { direction: true } } } }` (for `include: { allocations: ALLOCATIONS_FOR_BALANCE }`)
  - `type BalanceInput = { amount: Decimalish; status: "ISSUED" | "CANCELLED"; allocations: { amount: Decimalish; payment: { direction: "EINGANG" | "AUSGANG" } }[] }` where `Decimalish = number | string | { toString(): string }`
  - `chargeBalance(c: BalanceInput): { incoming: number; outgoing: number; paid: number; open: number }` — all rounded to cents; `paid = incoming − outgoing`
  - `chargeLease<L>(c: { lease?: L | null; areaAllocation?: { lease: L | null } | null }): L | null`
  - `chargeSubject(c: SubjectInput): string` — `"<unit label>"` for rent, `"<area label or unit>"` for area, `"<unit label> · <first last>"` for quota; `""` if nothing is loaded.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/charges.test.ts
import { describe, expect, it } from "vitest";
import { chargeBalance, chargeLease, chargeSubject } from "./charges";

const alloc = (amount: number, direction: "EINGANG" | "AUSGANG" = "EINGANG") => ({ amount, payment: { direction } });

describe("chargeBalance (#52)", () => {
  it("offen = Betrag − Eingänge + Ausgänge", () => {
    expect(chargeBalance({ amount: 500, status: "ISSUED", allocations: [alloc(200), alloc(100)] })).toEqual({ incoming: 300, outgoing: 0, paid: 300, open: 200 });
  });
  it("eine Rückzahlung (AUSGANG) erhöht den offenen Betrag, zählt nicht als Zahlung", () => {
    expect(chargeBalance({ amount: 500, status: "ISSUED", allocations: [alloc(500), alloc(120, "AUSGANG")] })).toEqual({ incoming: 500, outgoing: 120, paid: 380, open: 120 });
  });
  it("CANCELLED ist nie offen", () => {
    expect(chargeBalance({ amount: 500, status: "CANCELLED", allocations: [] }).open).toBe(0);
  });
  it("Decimal-Strings und Rundung auf Cent", () => {
    expect(chargeBalance({ amount: "0.30", status: "ISSUED", allocations: [{ amount: "0.10", payment: { direction: "EINGANG" } }, { amount: "0.10", payment: { direction: "EINGANG" } }] }).open).toBe(0.1);
  });
});

describe("chargeLease / chargeSubject (#52)", () => {
  const lease = { id: "l1", unit: { label: "1.º Esq." } };
  it("Miete: Vertrag direkt; Fläche: Vertrag der Teilfläche", () => {
    expect(chargeLease({ lease, areaAllocation: null })).toBe(lease);
    expect(chargeLease({ lease: null, areaAllocation: { lease } })).toBe(lease);
    expect(chargeLease({ lease: null, areaAllocation: null })).toBeNull();
  });
  it("Subjekt je Ziel", () => {
    expect(chargeSubject({ lease, areaAllocation: null, quotaDebtorSnapshot: null })).toBe("1.º Esq.");
    expect(chargeSubject({ lease: null, areaAllocation: { label: "Loja", lease }, quotaDebtorSnapshot: null })).toBe("Loja");
    expect(chargeSubject({ lease: null, areaAllocation: null, quotaDebtorSnapshot: { person: { firstName: "Ana", lastName: "Sousa" }, line: { unit: { label: "Fração A" } } } })).toBe("Fração A · Ana Sousa");
  });
});
```

- [ ] **Step 2: Run it.** `T "npx vitest run src/lib/charges.test.ts"` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/charges.ts
// #52: einzige Formel für den Saldo einer Sollstellung und für „wer/was“ sie betrifft.
type Decimalish = number | string | { toString(): string };
const num = (v: Decimalish) => Number(typeof v === "number" ? v : v.toString());
const cents = (v: number) => Math.round(v * 100) / 100;

export const ALLOCATIONS_FOR_BALANCE = { select: { amount: true, payment: { select: { direction: true } } } } as const;

export type BalanceInput = {
  amount: Decimalish;
  status: "ISSUED" | "CANCELLED";
  allocations: { amount: Decimalish; payment: { direction: "EINGANG" | "AUSGANG" } }[];
};

export function chargeBalance(c: BalanceInput) {
  let incoming = 0;
  let outgoing = 0;
  for (const a of c.allocations) {
    if (a.payment.direction === "AUSGANG") outgoing += num(a.amount);
    else incoming += num(a.amount);
  }
  const open = c.status === "CANCELLED" ? 0 : num(c.amount) - incoming + outgoing;
  return { incoming: cents(incoming), outgoing: cents(outgoing), paid: cents(incoming - outgoing), open: cents(open) };
}

// Flächen-Sollstellungen tragen keinen leaseId mehr; der Vertrag hängt an der Teilfläche.
export function chargeLease<L>(c: { lease?: L | null; areaAllocation?: { lease: L | null } | null }): L | null {
  return c.lease ?? c.areaAllocation?.lease ?? null;
}

type SubjectInput = {
  lease?: { unit: { label: string } } | null;
  areaAllocation?: { label: string | null; lease: { unit: { label: string } } | null } | null;
  quotaDebtorSnapshot?: { person: { firstName: string; lastName: string }; line: { unit: { label: string } } } | null;
};

export function chargeSubject(c: SubjectInput): string {
  if (c.quotaDebtorSnapshot) {
    const s = c.quotaDebtorSnapshot;
    return `${s.line.unit.label} · ${s.person.firstName} ${s.person.lastName}`;
  }
  if (c.areaAllocation) return c.areaAllocation.label ?? c.areaAllocation.lease?.unit.label ?? "";
  return c.lease?.unit.label ?? "";
}
```

- [ ] **Step 4: Run it.** Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/charges.ts src/lib/charges.test.ts
git commit -m "feat(#52): chargeBalance/chargeLease/chargeSubject — one balance formula"
```

---

### Task 3: `recordPayment` — allocation with cap and lock

**Files:**
- Create: `src/lib/payments.ts`
- Test: `src/lib/payments.test.ts`

**Interfaces:**
- Consumes: `chargeBalance`, `ALLOCATIONS_FOR_BALANCE` (Task 2).
- Produces:
  - `class PaymentError extends Error {}` (messages safe to show)
  - `recordPayment(input: { tenantId: string; accountId?: string | null; chargeId?: string | null; date: Date; amount: number; direction: "EINGANG" | "AUSGANG"; reference?: string | null; externalId?: string | null; note?: string | null; allowCredit?: boolean }, db?: PrismaClient): Promise<{ paymentId: string; allocated: number }>`
  - `deletePaymentWithAllocations(tenantId: string, paymentId: string, db?: PrismaClient): Promise<number>` (rows deleted)
  - `openChargesForMatching(tenantId: string, db?: PrismaClient): Promise<{ id: string; open: number }[]>` (ISSUED, open > 0.005)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/payments.test.ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";
import { deletePaymentWithAllocations, openChargesForMatching, PaymentError, recordPayment } from "./payments";

let t: Awaited<ReturnType<typeof createTestTenant>>;
let chargeId: string;
const day = new Date(Date.UTC(2026, 8, 3));

describeDb("recordPayment (#52)", () => {
  beforeEach(async () => {
    t = await createTestTenant();
    const property = await db!.property.create({ data: { tenantId: t.tenantId, name: "P", street: "S", zip: "1", city: "L" } });
    const building = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: property.id, name: "B" } });
    const unit = await db!.unit.create({ data: { tenantId: t.tenantId, buildingId: building.id, label: "A", area: 50 } });
    const lease = await db!.lease.create({ data: { tenantId: t.tenantId, unitId: unit.id, startDate: day, rentCold: 500 } });
    chargeId = (await db!.charge.create({ data: { tenantId: t.tenantId, leaseId: lease.id, type: "MIETE", period: day, dueDate: day, amount: 500 } })).id;
  });
  afterEach(() => t.cleanup());

  const pay = (amount: number, over: object = {}) =>
    recordPayment({ tenantId: t.tenantId, chargeId, date: day, amount, direction: "EINGANG", ...over }, db!);

  it("ordnet die Zahlung der Sollstellung zu", async () => {
    const r = await pay(200);
    expect(r.allocated).toBe(200);
    expect(await openChargesForMatching(t.tenantId, db!)).toEqual([{ id: chargeId, open: 300 }]);
  });

  it("Überzahlung: nur bis zum offenen Betrag, Rest bleibt unzugeordnet", async () => {
    await pay(400);
    const r = await pay(300);
    expect(r.allocated).toBe(100);
    const p = await db!.payment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect(Number(p.amount)).toBe(300);
  });

  it("Rückzahlung (AUSGANG) höchstens bis zum Nettoeingang", async () => {
    await pay(200);
    const r = await pay(500, { direction: "AUSGANG" });
    expect(r.allocated).toBe(200);
    expect(await openChargesForMatching(t.tenantId, db!)).toEqual([{ id: chargeId, open: 500 }]);
  });

  it("parallele Zahlungen überschreiten den offenen Betrag nie (Lock)", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => pay(200)));
    expect(results.reduce((s, r) => s + r.allocated, 0)).toBe(500);
  });

  it("fremde oder stornierte Sollstellung wird abgelehnt", async () => {
    const other = await createTestTenant();
    try {
      await expect(recordPayment({ tenantId: other.tenantId, chargeId, date: day, amount: 10, direction: "EINGANG" }, db!)).rejects.toBeInstanceOf(PaymentError);
    } finally {
      await other.cleanup();
    }
    await db!.charge.update({ where: { id: chargeId }, data: { status: "CANCELLED" } });
    await expect(pay(10)).rejects.toBeInstanceOf(PaymentError);
  });

  it("ohne Sollstellung: nur die Kontobewegung", async () => {
    const r = await recordPayment({ tenantId: t.tenantId, date: day, amount: 50, direction: "AUSGANG" }, db!);
    expect(r.allocated).toBe(0);
    expect(await db!.paymentAllocation.count({ where: { paymentId: r.paymentId } })).toBe(0);
  });

  it("Löschen einer Zahlung entfernt ihre Zuordnungen", async () => {
    const r = await pay(200);
    expect(await deletePaymentWithAllocations(t.tenantId, r.paymentId, db!)).toBe(1);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run it.** `T "npx vitest run src/lib/payments.test.ts"` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/payments.ts
// #52: Zahlungen anlegen und Sollstellungen zuordnen — Deckel und Zeilensperre, eine Transaktion.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ALLOCATIONS_FOR_BALANCE, chargeBalance } from "@/lib/charges";

export class PaymentError extends Error {}

type RecordInput = {
  tenantId: string;
  accountId?: string | null;
  chargeId?: string | null;
  date: Date;
  amount: number;
  direction: "EINGANG" | "AUSGANG";
  reference?: string | null;
  externalId?: string | null;
  note?: string | null;
  allowCredit?: boolean;
};

export async function recordPayment(input: RecordInput, db: PrismaClient = prisma) {
  const { chargeId, allowCredit = false, ...data } = input;
  if (!(data.amount > 0)) throw new PaymentError("Betrag muss positiv sein");
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.create({ data });
    if (!chargeId) return { paymentId: payment.id, allocated: 0 };

    // Sperre auf die Sollstellung: parallele Zahlungen sehen den aktuellen Saldo.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Charge" WHERE id = ${chargeId} AND "tenantId" = ${data.tenantId} FOR UPDATE`;
    if (locked.length === 0) throw new PaymentError("Sollstellung nicht gefunden");
    const charge = await tx.charge.findUniqueOrThrow({
      where: { id: chargeId },
      select: { amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
    });
    if (charge.status !== "ISSUED") throw new PaymentError("Sollstellung ist storniert");

    const b = chargeBalance(charge);
    const cap = data.direction === "AUSGANG" ? b.paid : allowCredit ? data.amount : Math.max(0, b.open);
    const allocated = Math.round(Math.min(data.amount, cap) * 100) / 100;
    if (allocated > 0) {
      await tx.paymentAllocation.create({ data: { tenantId: data.tenantId, paymentId: payment.id, chargeId, amount: allocated } });
    }
    return { paymentId: payment.id, allocated };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function deletePaymentWithAllocations(tenantId: string, paymentId: string, db: PrismaClient = prisma) {
  const [, deleted] = await db.$transaction([
    db.paymentAllocation.deleteMany({ where: { tenantId, paymentId } }),
    db.payment.deleteMany({ where: { tenantId, id: paymentId } }),
  ]);
  return deleted.count;
}

export async function openChargesForMatching(tenantId: string, db: PrismaClient = prisma) {
  const charges = await db.charge.findMany({
    where: { tenantId, status: "ISSUED" },
    select: { id: true, amount: true, status: true, allocations: ALLOCATIONS_FOR_BALANCE },
    orderBy: { dueDate: "asc" },
  });
  return charges.map((c) => ({ id: c.id, open: chargeBalance(c).open })).filter((c) => c.open > 0.005);
}
```

- [ ] **Step 4: Run it.** Expected: PASS (7 tests). If the concurrency test is flaky, the lock is not effective — do not retry; check that the `FOR UPDATE` query and the balance read are inside the same `tx`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payments.ts src/lib/payments.test.ts
git commit -m "feat(#52): recordPayment — allocation with cap and row lock"
```

---

### Task 4: Every payment writer and deleter uses `payments.ts`

**Files:**
- Modify: `src/server/actions/finances.ts` (`createPayment`, `deletePayment`, `importCamt`, `deleteCharge`), `src/server/actions/banking.ts` (sync), `src/lib/api-ops.ts` (`import_camt`), `src/lib/api-write.ts` (payment create, payment/charge delete), `src/lib/schemas.ts` (`paymentSchema` keeps `chargeId` as input only)
- Test: `src/lib/payment-writers.test.ts`

**Interfaces:**
- Consumes: `recordPayment`, `deletePaymentWithAllocations`, `openChargesForMatching`, `PaymentError` (Task 3).
- Produces (in `src/lib/payments.ts`): `matchOpenCharge(open: { id: string; open: number }[], amount: number): string | null` (exact-amount match, consumes the hit); `unappliedPart(amount: number, allocated: number, chargeId?: string | null): { applied: number; unapplied: number } | null` (null when nothing is left over or no charge was given); `chargeHasHistory(tenantId: string, chargeId: string, db?: PrismaClient): Promise<boolean>` (allocations or dunning notices exist).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/payment-writers.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchOpenCharge, unappliedPart } from "./payments";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("Zahlungs-Schreiber (#52)", () => {
  it("kein Code schreibt mehr payment.create/deleteMany direkt, außer payments.ts und Seeds", () => {
    for (const f of ["src/server/actions/finances.ts", "src/server/actions/banking.ts", "src/lib/api-ops.ts", "src/lib/api-write.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/\.payment\.(create|deleteMany|delete)\(/);
      expect(src, f).not.toMatch(/\.payments\.reduce/);
    }
  });

  it("Abgleich per Betrag verbraucht den Treffer", () => {
    const open = [{ id: "a", open: 100 }, { id: "b", open: 50 }];
    expect(matchOpenCharge(open, 50)).toBe("b");
    expect(matchOpenCharge(open, 50)).toBeNull();
    expect(matchOpenCharge(open, 100.004)).toBe("a");
  });

  it("manuelle Überzahlung meldet den nicht zugeordneten Rest", () => {
    expect(unappliedPart(300, 100, "c1")).toEqual({ applied: 100, unapplied: 200 });
    expect(unappliedPart(300, 300, "c1")).toBeNull();
    expect(unappliedPart(300, 0, null)).toBeNull();
    const src = read("src/server/actions/finances.ts");
    expect(src).toMatch(/unappliedPart\(/);
    expect(src).toMatch(/partiallyApplied/);
  });

  it("deleteCharge (UI und API) prüft Zahlungen UND Mahnungen", () => {
    expect(read("src/server/actions/finances.ts")).toMatch(/chargeHasHistory\(/);
    expect(read("src/lib/api-write.ts")).toMatch(/chargeHasHistory\(/);
  });

  it("generische API: Zahlung und Sollstellung haben eigene Pfade", () => {
    const src = read("src/lib/api-write.ts");
    expect(src).toMatch(/special: "payment"/);
    expect(src).toMatch(/special === "payment"[\s\S]*recordPayment/);
    expect(src).toMatch(/deletePaymentWithAllocations/);
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (direct writes still present, `matchOpenCharge` missing).

- [ ] **Step 3: Add `matchOpenCharge` to `src/lib/payments.ts`**

```ts
// Automatischer Abgleich (camt/Bank-Sync): exakter Betrag, jeder Treffer nur einmal.
export function matchOpenCharge(open: { id: string; open: number }[], amount: number): string | null {
  const hit = open.find((o) => o.open > 0 && Math.abs(o.open - amount) < 0.005);
  if (!hit) return null;
  hit.open = 0;
  return hit.id;
}
```

Also add to `src/lib/payments.ts`:

```ts
export function unappliedPart(amount: number, allocated: number, chargeId?: string | null) {
  const unapplied = Math.round((amount - allocated) * 100) / 100;
  return chargeId && unapplied > 0.005 ? { applied: allocated, unapplied } : null;
}

// Finanzhistorie einer Sollstellung: Zahlungen oder Mahnungen → nicht löschen (bis voidCharge, Release 2).
export async function chargeHasHistory(tenantId: string, chargeId: string, db: PrismaClient = prisma) {
  const [allocations, dunnings] = await Promise.all([
    db.paymentAllocation.count({ where: { tenantId, chargeId } }),
    db.dunningNotice.count({ where: { tenantId, chargeId } }),
  ]);
  return allocations + dunnings > 0;
}
```

And a DB test in `src/lib/payments.test.ts` (import `chargeHasHistory`):

```ts
  it("chargeHasHistory: Zahlung oder Mahnung zählt", async () => {
    expect(await chargeHasHistory(t.tenantId, chargeId, db!)).toBe(false);
    await db!.dunningNotice.create({ data: { tenantId: t.tenantId, chargeId, level: 1 } });
    expect(await chargeHasHistory(t.tenantId, chargeId, db!)).toBe(true);
  });
```

- [ ] **Step 4: Move the writers**

`finances.ts` — `createPayment`:
```ts
export async function createPayment(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const r = paymentSchema.safeParse(Object.fromEntries(fd));
  if (!r.success) return fail(r.error.issues[0]?.message);
  let res;
  try {
    res = await recordPayment({ ...r.data, tenantId: user.tenantId });
  } catch (e) {
    if (e instanceof PaymentError) return fail(e.message);
    throw e;
  }
  // Überzahlung: gebucht, aber nur bis zum offenen Betrag zugeordnet — dem Nutzer sagen, was übrig bleibt.
  const rest = unappliedPart(r.data.amount, res.allocated, r.data.chargeId);
  if (rest) {
    const t = await getTranslations("finances");
    return { ok: true, error: t("partiallyApplied", { applied: rest.applied.toFixed(2), unapplied: rest.unapplied.toFixed(2) }) };
  }
  return done();
}
export async function deletePayment(fd: FormData): Promise<void> {
  const user = await requireWriter();
  await deletePaymentWithAllocations(user.tenantId, String(fd.get("id") ?? ""));
  revalidatePath("/", "layout");
}
```

`finances.ts` — `deleteCharge` (refuses charges with allocations; release 2 brings `voidCharge`):
```ts
export async function deleteCharge(fd: FormData): Promise<void> {
  const user = await requireWriter();
  const id = String(fd.get("id") ?? "");
  if (await chargeHasHistory(user.tenantId, id)) throw new Error("Sollstellung mit Zahlungen oder Mahnungen kann nicht gelöscht werden");
  await prisma.charge.deleteMany({ where: { id, tenantId: user.tenantId } });
  revalidatePath("/", "layout");
}
```
(`DeleteButton` already shows `deleteFailed` on a thrown error.)

`finances.ts` `importCamt`, `banking.ts` sync, `api-ops.ts` `import_camt` — replace the `openMap` block and the `payment.create` in each with:
```ts
const open = await openChargesForMatching(tenantId);
// … per entry:
const chargeId = e.direction === "EINGANG" ? matchOpenCharge(open, e.amount) : null;
if (chargeId) matched++;
await recordPayment({ tenantId, accountId, chargeId, date: new Date(e.date), amount: e.amount, direction: e.direction, reference: e.reference /*, externalId in banking.ts */ });
```
(`tenantId` is `user.tenantId` in server actions and `p.tenantId` in `api-ops.ts`.)

`api-write.ts`:
- REGISTRY: `payment: { model: "payment", create: S.paymentSchema, relations: { accountId: "account" }, special: "payment" }` (the charge check moves into `recordPayment`); add `"payment"` to the `special` union type.
- In `apiCreate`, before the generic create:
```ts
  if (def.special === "payment") {
    try {
      const r = await recordPayment({ ...(data as Parameters<typeof recordPayment>[0]), tenantId });
      return db.payment.findUniqueOrThrow({ where: { id: r.paymentId }, include: { allocations: true } });
    } catch (e) {
      if (e instanceof PaymentError) throw new ApiWriteError(e.message, 400);
      throw e;
    }
  }
```
- In `apiDelete`, before the generic delete:
```ts
  if (entity === "payment") {
    const n = await deletePaymentWithAllocations(p.tenantId, id);
    if (n === 0) throw new ApiWriteError("Nicht gefunden", 404);
    return { id, deleted: n };
  }
  if (entity === "charge" && (await chargeHasHistory(p.tenantId, id))) {
    throw new ApiWriteError("Sollstellung mit Zahlungen oder Mahnungen kann nicht gelöscht werden", 409);
  }
```

Message `partiallyApplied` in the existing finances namespace of `messages/{de,en,pt}.json` (check its name with `grep -n '"finances"' messages/pt.json`): de "{applied} € zugeordnet, {unapplied} € bleiben unzugeordnet", en "{applied} € applied, {unapplied} € left unapplied", pt "{applied} € aplicados, {unapplied} € ficam por aplicar".

- [ ] **Step 5: Run it.** `T "npx vitest run src/lib/payment-writers.test.ts src/lib/payments.test.ts"` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payments.ts src/lib/payments.test.ts src/lib/payment-writers.test.ts src/server/actions/finances.ts src/server/actions/banking.ts src/lib/api-ops.ts src/lib/api-write.ts src/lib/schemas.ts messages
git commit -m "feat(#52): all payment writers allocate via recordPayment; deletes remove allocations"
```

---

### Task 5: Generators — one rent generator, area without `leaseId`, only unique violations swallowed

**Files:**
- Create: `src/lib/charge-generation.ts`
- Modify: `src/server/actions/finances.ts` (`generateCharges`), `src/lib/api-ops.ts` (`run_charge_generation`, remove `generateAreaCharges`), `src/server/actions/statement-actions.ts` (dedupe counts only `ISSUED`)
- Test: `src/lib/charge-generation.test.ts`

**Interfaces:**
- Produces: `isUniqueViolation(e: unknown): boolean`; `generateMonthlyCharges(tenantId: string, month: string /* YYYY-MM */, db?: PrismaClient): Promise<{ created: number; skipped: number }>` (rent + area); `monthBounds(month: string): { first: Date; last: Date; due: Date }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/charge-generation.test.ts
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

describeDb("generateMonthlyCharges (#52)", () => {
  beforeEach(async () => {
    t = await createTestTenant();
    const property = await db!.property.create({ data: { tenantId: t.tenantId, name: "P", street: "S", zip: "1", city: "L" } });
    const building = await db!.building.create({ data: { tenantId: t.tenantId, propertyId: property.id, name: "B" } });
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
    await db!.charge.updateMany({ where: { tenantId: t.tenantId, leaseId }, data: { status: "CANCELLED" } });
    expect(await generateMonthlyCharges(t.tenantId, "2026-09", db!)).toMatchObject({ created: 1 });
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (moves the loop duplicated in `finances.ts` and `api-ops.ts`, and `generateAreaCharges`)

```ts
// src/lib/charge-generation.ts
// Sollstellungslauf (Miete + Flächenmiete). #52: Duplikate verhindert die DB (Teilindizes nur ISSUED);
// nur Eindeutigkeitsverletzungen gelten als „schon vorhanden“, alles andere wird weitergereicht.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export function isUniqueViolation(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code === "P2002";
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

export function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  return { first: new Date(Date.UTC(y, m - 1, 1)), last: new Date(Date.UTC(y, m, 0)), due: new Date(Date.UTC(y, m - 1, 3)) };
}

async function createOnce(db: PrismaClient, data: Prisma.ChargeUncheckedCreateInput): Promise<boolean> {
  try {
    await db.charge.create({ data });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

export async function generateMonthlyCharges(tenantId: string, month: string, db: PrismaClient = prisma) {
  const { first, last, due } = monthBounds(month);
  const leases = await db.lease.findMany({
    where: { tenantId, startDate: { lte: last }, OR: [{ endDate: null }, { endDate: { gte: first } }] },
    include: { components: { select: { amount: true } } },
  });
  let created = 0;
  let skipped = 0;
  for (const l of leases) {
    const warm = Number(l.rentCold) + l.components.reduce((a, c) => a + Number(c.amount), 0);
    if (await createOnce(db, { tenantId, leaseId: l.id, type: "MIETE", period: first, dueDate: due, amount: warm })) created++;
    else skipped++;
  }
  const areas = await db.areaAllocation.findMany({
    where: { tenantId, pricePerSqm: { not: null }, from: { lte: last }, OR: [{ to: null }, { to: { gte: first } }] },
  });
  for (const a of areas) {
    const amount = Math.round(Number(a.area) * Number(a.pricePerSqm) * 100) / 100;
    if (amount <= 0) continue;
    if (await createOnce(db, { tenantId, areaAllocationId: a.id, type: "MIETE", period: first, dueDate: due, amount, description: a.label ?? "Flächenmiete" })) created++;
    else skipped++;
  }
  return { created, skipped };
}
```

Before deleting `generateAreaCharges` from `api-ops.ts`, compare its `where` clause for area allocations with the one above and keep the original filter (active in the month, with a price) if it differs.

- [ ] **Step 4: Use it.** `finances.ts` `generateCharges`: parse `month` as today, then `const { created } = await generateMonthlyCharges(user.tenantId, r.data.month);`. `api-ops.ts` `run_charge_generation`: validate `month`, then `return generateMonthlyCharges(p.tenantId, month);`. Delete `generateAreaCharges` and its import. In `statement-actions.ts`, the dedupe `findFirst` gets `status: "ISSUED"`.

- [ ] **Step 5: Run it.** `T "npx vitest run src/lib/charge-generation.test.ts"` — Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/charge-generation.ts src/lib/charge-generation.test.ts src/server/actions/finances.ts src/lib/api-ops.ts src/server/actions/statement-actions.ts
git commit -m "feat(#52): one charge generator; area charges without leaseId; only unique violations are 'already generated'"
```

---

### Task 6: Every reader uses `chargeBalance` and `chargeLease`

**Files:**
- Modify: `src/lib/api-data.ts` (`listOpenItems` ~121, the charge list ~241, ~453), `src/app/[locale]/(admin)/finances/page.tsx` (~52, ~72, ~97, ~341), `src/app/[locale]/(admin)/dunning/page.tsx` (~31), `src/app/[locale]/(admin)/reports/page.tsx` (~38), `src/app/[locale]/(admin)/dashboard/page.tsx` (~74), `src/app/[locale]/portal/page.tsx` (~31, ~70, ~81), `src/app/[locale]/print/dunning/page.tsx` (~24), `src/app/api/export/openitems/route.ts` (~10), `src/app/api/export/sepa/route.ts` (~23), `src/app/api/export/datev/route.ts` (~25), `src/server/actions/ai.ts` (~22), `src/server/actions/finances.ts` (`createDunning` ~229, dunning letter ~259), `src/lib/api-ops.ts` (`run_dunning` ~115)
- Create: `src/lib/portal-charges.ts` (portal query, testable)
- Test: `src/lib/charge-readers.test.ts`

**Interfaces:**
- Consumes: `ALLOCATIONS_FOR_BALANCE`, `chargeBalance`, `chargeLease`, `chargeSubject` (Task 2).
- Produces: `chargesForLeases(tenantId: string, leaseIds: string[], db?: PrismaClient)` — rent and area charges of those leases with allocations (+ payment id/date/amount/direction) — used by the portal and SEPA; `paymentChargeType(allocations: { charge: { type: string } }[]): string | "MIXED" | null` in `src/lib/charges.ts`.

The rule for every site:
- `include: { payments: { select: { amount: true } } }` → `include: { allocations: ALLOCATIONS_FOR_BALANCE }` (keep other includes).
- `Number(c.amount) - c.payments.reduce(...)` → `chargeBalance(c).open`; `paid` → `chargeBalance(c).paid`.
- A charge's lease: include `areaAllocation: { select: { lease: <the same include as lease> } }` and read `chargeLease(c)` instead of `c.lease`.
- Payment → charge type (finances list ~72/~341, DATEV ~25): `include: { allocations: { select: { charge: { select: { type: true } } } } }` (all allocations) and `paymentChargeType(p.allocations)` from `src/lib/charges.ts`: one distinct type → that type; several → `"MIXED"` (Finanças shows `t("finances.mixedCharges")`, DATEV writes `"Mehrere Sollstellungen"`); none → `null`.
- Dunning (`createDunning`, `run_dunning`, dunning page): only `status: "ISSUED"` in the `where`, and skip unless `open > 0.005 && dueDate < now`.
- Labels of "what/who" a charge is (finances list, open-items CSV, dunning page and letter): `chargeSubject(c)`; include `lease: { include: { unit: true } }`, `areaAllocation: { select: { label: true, lease: { include: { unit: true } } } }` and `quotaDebtorSnapshot: { select: { person: { select: { firstName: true, lastName: true } }, line: { select: { unit: { select: { label: true } } } } } }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/charge-readers.test.ts
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
      expect(src, f).not.toMatch(/\.payments\.(reduce|map)|payments:\s*\{\s*select|\bp\.charge\b|allocations\[0\]|take:\s*1\s*\}/);
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
```

- [ ] **Step 2: Run it.** Expected: FAIL (readers still use `payments`, module missing).

- [ ] **Step 3: Implement `src/lib/portal-charges.ts`**

```ts
// Sollstellungen der Verträge einer Person (Miete + Flächenmiete; Fläche hängt über die Teilfläche am Vertrag).
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export function chargesForLeases(tenantId: string, leaseIds: string[], db: PrismaClient = prisma) {
  if (leaseIds.length === 0) return Promise.resolve([]);
  return db.charge.findMany({
    where: { tenantId, OR: [{ leaseId: { in: leaseIds } }, { areaAllocation: { leaseId: { in: leaseIds } } }] },
    include: { allocations: { select: { amount: true, payment: { select: { id: true, date: true, amount: true, direction: true } } } } },
    orderBy: { dueDate: "desc" },
  });
}
```

Add to `src/lib/charges.ts`:

```ts
// Art(en) der Sollstellungen einer Zahlung: eine → diese, mehrere → MIXED, keine → null.
export function paymentChargeType(allocations: { charge: { type: string } }[]): string | "MIXED" | null {
  const types = new Set(allocations.map((a) => a.charge.type));
  if (types.size === 0) return null;
  return types.size === 1 ? [...types][0] : "MIXED";
}
```
Message `mixedCharges` (finances namespace) = de "Mehrere Sollstellungen", en "Several charges", pt "Várias cobranças".

- [ ] **Step 4: Migrate each reader** following the rule above. Portal: replace `charges: { include: { payments: … } }` inside the lease include with a call to `chargesForLeases(user.tenantId, leaseIds)`, compute `paid`/`open` with `chargeBalance`, and build the payment list from `c.allocations.map((a) => ({ id: a.payment.id, date: a.payment.date, amount: Number(a.amount), type: c.type }))`. SEPA: collect the person's lease ids, then `chargesForLeases` and sum `chargeBalance(c).open`. Dunning page and open-items: group by `chargeLease(c)?.unit.building.property`.

- [ ] **Step 5: Run it.** `T "npx vitest run src/lib/charge-readers.test.ts"` — Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A src/lib src/app src/server messages
git commit -m "feat(#52): all readers use chargeBalance/chargeLease; area charges stay visible; split payments labelled"
```

---

### Task 7: Manual charge form, owners, organisation deletion

**Files:**
- Modify: `src/lib/schemas.ts` (`chargeSchema`, `ownerSchema`), `src/components/finance-dialogs.tsx` (type options), `src/components/weg-dialogs.tsx` (owner "Desde"), `src/server/actions/weg.ts` (`createOwner`), `src/server/actions/tenants.ts` (`deleteTenant`), `messages/{de,en,pt}.json` (`weg.validFrom`)
- Create: `src/lib/tenant-deletion.ts`
- Test: `src/lib/charge-form.test.ts`, `src/lib/tenant-deletion.test.ts`

**Interfaces:**
- Produces: `deleteTenantData(tenantId: string, db?: PrismaClient): Promise<void>` (one transaction, errors propagate).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/charge-form.test.ts
import { describe, expect, it } from "vitest";
import { chargeSchema, ownerSchema } from "./schemas";

const base = { period: "2026-09-01", dueDate: "2026-09-03", amount: "10" };
describe("manuelle Sollstellung (#52)", () => {
  it("HAUSGELD ist manuell nicht erlaubt", () => {
    expect(chargeSchema.safeParse({ ...base, type: "HAUSGELD", leaseId: "l1" }).success).toBe(false);
  });
  it("jede manuelle Sollstellung braucht einen Vertrag", () => {
    for (const type of ["MIETE", "NEBENKOSTEN", "KAUTION", "SONSTIGES"]) {
      expect(chargeSchema.safeParse({ ...base, type }).success, type).toBe(false);
      expect(chargeSchema.safeParse({ ...base, type, leaseId: "l1" }).success, type).toBe(true);
    }
  });
});
describe("Eigentümer (#52)", () => {
  it("validFrom ist Pflicht", () => {
    expect(ownerSchema.safeParse({ personId: "p", unitId: "u", share: "1000" }).success).toBe(false);
    expect(ownerSchema.safeParse({ personId: "p", unitId: "u", share: "1000", validFrom: "2026-09-01" }).success).toBe(true);
  });
});
```

```ts
// src/lib/tenant-deletion.test.ts
import { expect, it } from "vitest";
import { describeDb, integrationDb as db } from "./test-db";
import { deleteTenantData } from "./tenant-deletion";
import { recordPayment } from "./payments";

describeDb("Mandant löschen (#52)", () => {
  it("entfernt Sollstellungen, Zahlungen, Zuordnungen, Mahnungen und die ganze Quota-Kette — keine Waisen", async () => {
    const tenant = await db!.tenant.create({ data: { name: `del-${crypto.randomUUID()}` } });
    const tenantId = tenant.id;
    const property = await db!.property.create({ data: { tenantId, name: "P", street: "S", zip: "1", city: "L" } });
    const building = await db!.building.create({ data: { tenantId, propertyId: property.id, name: "B" } });
    const unit = await db!.unit.create({ data: { tenantId, buildingId: building.id, label: "A", area: 50 } });
    const lease = await db!.lease.create({ data: { tenantId, unitId: unit.id, startDate: new Date("2026-01-01"), rentCold: 500 } });
    const d = new Date("2026-09-01");
    const charge = await db!.charge.create({ data: { tenantId, leaseId: lease.id, type: "MIETE", period: d, dueDate: d, amount: 500 } });
    await recordPayment({ tenantId, chargeId: charge.id, date: d, amount: 200, direction: "EINGANG" }, db!);
    await recordPayment({ tenantId, date: d, amount: 20, direction: "AUSGANG" }, db!);
    await db!.dunningNotice.create({ data: { tenantId, chargeId: charge.id, level: 1 } });
    // vollständige Quota-Kette mit Zahlung
    const person = await db!.person.create({ data: { tenantId, firstName: "Ana", lastName: "Teste" } });
    const assessment = await db!.condominiumAssessment.create({ data: { tenantId, propertyId: property.id, period: d, kind: "ORDINARY", method: "PERMILLAGE", dueDate: d, asOf: d, totalCents: 5000 } });
    const line = await db!.condominiumAssessmentLine.create({ data: { tenantId, assessmentId: assessment.id, unitId: unit.id, amountCents: 5000 } });
    const snap = await db!.quotaDebtorSnapshot.create({ data: { tenantId, lineId: line.id, personId: person.id, shareSnapshot: 1000, amountCents: 5000 } });
    const quota = await db!.charge.create({ data: { tenantId, quotaDebtorSnapshotId: snap.id, type: "HAUSGELD", period: d, dueDate: d, amount: 50 } });
    await recordPayment({ tenantId, chargeId: quota.id, date: d, amount: 50, direction: "EINGANG" }, db!);

    await deleteTenantData(tenantId, db!);

    expect(await db!.tenant.count({ where: { id: tenantId } })).toBe(0);
    const counts = await Promise.all([
      db!.charge.count({ where: { tenantId } }), db!.payment.count({ where: { tenantId } }), db!.paymentAllocation.count({ where: { tenantId } }),
      db!.dunningNotice.count({ where: { tenantId } }), db!.condominiumAssessment.count({ where: { tenantId } }),
      db!.condominiumAssessmentLine.count({ where: { tenantId } }), db!.quotaDebtorSnapshot.count({ where: { tenantId } }),
      db!.person.count({ where: { tenantId } }), db!.lease.count({ where: { tenantId } }), db!.unit.count({ where: { tenantId } }),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement**

`schemas.ts`:
```ts
export const chargeSchema = z.object({
  // #52: manuell nur mit Vertrag; HAUSGELD entsteht nur über eine Emission.
  leaseId: z.string().trim().min(1),
  type: z.enum(["MIETE", "NEBENKOSTEN", "KAUTION", "SONSTIGES"]),
  period: z.coerce.date(),
  dueDate: z.coerce.date(),
  amount: z.coerce.number(),
  description: optionalStr,
});

export const ownerSchema = z.object({
  personId: z.string().min(1),
  unitId: z.string().min(1),
  share: z.coerce.number().int().positive().max(1000),
  validFrom: z.coerce.date(),
});
```

`weg.ts` `createOwner`: `await prisma.owner.create({ data: { ...r.data, tenantId: user.tenantId, vigencia: "CONFIRMED" } });` (the API owner path in `api-write.ts` uses the same schema; add `vigencia: "CONFIRMED"` there via a `special: "owner"` branch or by extending `data` for `entity === "owner"`).

`weg-dialogs.tsx`: `<TextField name="validFrom" label={t("weg.validFrom")} type="date" defaultValue={new Date().toISOString().slice(0, 10)} />`; `messages`: `weg.validFrom` = de "Eigentümer seit", en "Owner since", pt "Proprietário desde".

`finance-dialogs.tsx`: charge type options `["MIETE", "NEBENKOSTEN", "KAUTION", "SONSTIGES"]`; the lease field becomes required.

`src/lib/tenant-deletion.ts`:
```ts
// #52: Finanzdaten haben keine FK auf Tenant — beim Löschen explizit und vollständig entfernen (DSGVO).
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function deleteTenantData(tenantId: string, db: PrismaClient = prisma) {
  await db.$transaction([
    db.paymentAllocation.deleteMany({ where: { tenantId } }),
    db.dunningNotice.deleteMany({ where: { tenantId } }),
    db.payment.deleteMany({ where: { tenantId } }),
    db.charge.deleteMany({ where: { tenantId } }),
    db.quotaDebtorSnapshot.deleteMany({ where: { tenantId } }),
    db.condominiumAssessmentLine.deleteMany({ where: { tenantId } }),
    db.condominiumAssessment.deleteMany({ where: { tenantId } }),
    db.tenant.delete({ where: { id: tenantId } }),
  ]);
}
```
`tenants.ts` `deleteTenant`: replace `await prisma.tenant.delete({ where: { id } }).catch(() => {});` with `await deleteTenantData(id);`.

- [ ] **Step 4: Run them.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas.ts src/lib/tenant-deletion.ts src/lib/charge-form.test.ts src/lib/tenant-deletion.test.ts src/components/finance-dialogs.tsx src/components/weg-dialogs.tsx src/server/actions/weg.ts src/server/actions/tenants.ts src/lib/api-write.ts messages
git commit -m "feat(#52): manual charges need a lease, owners are CONFIRMED with validFrom, tenant deletion removes financial data"
```

---

### Task 8: Seeds, demo validator, type check, CI

**Files:**
- Modify: `prisma/seed.ts` (~141 owner, ~209-222 charges/payment), `prisma/seed-crmware-demo.ts` (owners ~527-535, payments ~691-712, ~873, validator ~966 and every `payments`/`chargeId` read), `docs/crmware-demo.md` (the quotas row stays "não suportado" — release 3 changes it)

- [ ] **Step 1: Seeds.** `seed.ts`: owner with `vigencia: "CONFIRMED", validFrom: new Date("2020-01-01")`; the paid charge's payment via `recordPayment({ tenantId, accountId, chargeId: paidCharge.id, date: new Date("2026-06-02"), amount: 990, direction: "EINGANG", reference: "Miete 06/2026" }, prisma)`. `seed-crmware-demo.ts`: owners get `vigencia: "CONFIRMED"` and `validFrom` = the start of the demo history (`demoDate(-24, 1)`); co-owners at 500/500 share the same `validFrom`. Each `prisma.payment.create({ data: { …, chargeId } })` becomes `recordPayment({ …, chargeId }, prisma)`; payments without a charge stay `recordPayment` without `chargeId`. In `validateSeededScenarios`, replace every `payments { chargeId }` / `charge.payments` read with `allocations` and `chargeBalance`.

- [ ] **Step 2: Demo contract test.** `T "CRMWARE_DEMO_TEST_DATABASE_URL=\$INTEGRATION_DATABASE_URL npm run test:crmware-demo"` — Expected: PASS (seeds twice, validates, collision test).

- [ ] **Step 3: Type check.** `T "npx tsc --noEmit -p ."` — Expected: only the 3 pre-existing `src/lib/sso.test.ts` errors. Fix every other error (they are sites Tasks 4–7 missed; each fix follows the Task 6 rule).

- [ ] **Step 4: Full suite and lint.** `T "npx vitest run"` then `T "npx eslint src prisma"` — Expected: all green; eslint only the pre-existing `Math.random` purity error in `background-video.tsx`.

- [ ] **Step 5: Runtime check.** Build the image (`docker build -t havewa-r1:local .`), run it against an empty Postgres (as in the #44 check, default bridge + host port), then run the demo reset order by hand: `migrate deploy` → seed → `--validate` → start app. Log in as `equipa.001@mista.crmware-demo.example`: Finanças shows open amounts, a payment reduces the open amount, Mahnwesen lists only overdue unpaid charges, the tenant portal shows rent and area charges.

- [ ] **Step 6: Commit**

```bash
git add prisma/seed.ts prisma/seed-crmware-demo.ts docs/crmware-demo.md
git commit -m "feat(#52): seeds and demo validator on allocations; owners with validity"
```

---

## Deployment note (for the PR)

The migration aborts if `Charge` or `Payment` has rows. Devbox: 0 and 0 (checked 2026-09-26). Demo: run the migration on an empty demo database (the reset order does `down -v` first). Check the devbox counts again right before deploying:

```bash
ssh -i ~/.ssh/havewa_hetzner_ed25519 root@2.28.113.150 'docker exec havewa-db psql -U havewa -d havewa -tAc "select (select count(*) from \"Charge\"), (select count(*) from \"Payment\")"'
```
