# Quotas Domain (#52, release 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue condominium quotas and give every charge a safe lifecycle (void, atomic refund-and-cancel, corrections) plus a per-fraction / per-owner account statement — domain services and internal server actions only, no UI.

**Architecture:** One new migration (R2 schema: cancellation fields with CHECK, assessment metadata + request key, resolution link with two-way same-property triggers, EconomicPlan lock trigger on advisory locks). A pure calculation module (`src/lib/quotas/compute.ts`: integer `allocateCents`, monthly split, method validation, owner resolution, request key). Transaction primitives `…InTx(tx, ctx, …)` in `src/lib/quotas/` and `src/lib/payments.ts` that share one lock order; public wrappers open the transaction (issuance in `REPEATABLE READ` with retry). Server actions in `src/server/actions/quotas.ts` enforce the three role levels.

**Tech Stack:** Next.js 16 server actions, Prisma 6.19 + PostgreSQL 16 (advisory locks, `ON CONFLICT … DO NOTHING`, triggers), Vitest (node env) with real-Postgres integration tests.

**Spec:** GitHub issue #52 body, section **"Release 2 — Domínio (especificação canónica)"** (final version approved with Codex, incl. the refund rule `USE_REFUND_AND_CANCEL`), plus the general sections of the body (Titularidade, Saldo e pagamentos, Cancelamento, Arredondamento). Read it with `gh issue view 52 -R manueljpconde/hausverwaltung --json body -q .body`.

## Global Constraints

- Work only in the worktree `/Users/mjpc/Play/github/hausverwaltung-r2` (branch `feat/52-release2`). Never touch `/Users/mjpc/Play/github/hausverwaltung` (shared checkout, others work there).
- Scope: no UI screens, no REST/MCP operations for quotas, no quota dunning letters/PDF/grouping, no portal/SEPA/CSV quota output (all Release 3). The only API change: `delete_record` of `charge` voids instead of deleting.
- Every primitive receives `tenantId` from the session (never from the request body); every lock and lookup uses `(id, tenantId)`.
- Global lock order: (0a) the `EconomicPlan` row (issuer `FOR SHARE`; a plan edit's own row lock), then (0b) the plan advisory lock — a plan edit takes its row lock before its BEFORE trigger runs, so every plan-dependent path that locks the plan row must lock it **before** the advisory lock; paths that do not lock the plan row (extraordinary issuance, `reissueCharge`) take only (0b); (1) `CondominiumAssessment`; (2) charges by `id` ascending; (3) snapshots/lines by `id`. `recordPayment` locks only the charge (step 2).
- Money in quota computation is integer cents end to end (`allocateCents`); `Charge.amount = snapshot.amountCents / 100`.
- Issuance: `REPEATABLE READ`; retry on `40001` and `40P01`, at most 3 attempts with short backoff, then an explicit error. `40P01` is a defence, not the normal path.
- Aggregate assessment status (canonical): `CANCELLED` only when all its charges are `CANCELLED`; recomputed under the assessment lock in the same transaction.
- Cancellation always records `cancelledAt` and a non-empty `cancelReason` (DB CHECK).
- A refund that would bring a charge's net paid to zero is only possible through `refundAndCancel` (`recordPayment` returns `USE_REFUND_AND_CANCEL`).
- Roles: management (issue, `cancelAssessment`, `reissueCharge`, `replaceDebtor`) = ADMIN, VERWALTER; financial (payments, `refundAndCancel`, `voidCharge`) = ADMIN, VERWALTER, BUCHHALTUNG; nominal read (`quotaStatement`) = ADMIN, VERWALTER, BUCHHALTUNG. BEIRAT: none of these.
- Code comments in the file's language (German in `src/`); UI/error copy via `messages/{de,en,pt}.json` (three locales in sync).
- The migration of this release aborts if any `CondominiumAssessment` exists (checked on the devbox before deploy; demo is recreated).
- **Git checkpoint (Manuel's rule: never commit or push without explicit approval).** Nobody commits until Manuel approves. Execution runs Task 1 through its verification step, then STOPS and presents the diff (`git diff --stat` + full diff file) and the verification output. Only after Manuel's explicit approval: commit, then `git push -u origin feat/52-release2`. The same approval covers the later tasks' commit steps only if Manuel says so explicitly at that checkpoint; otherwise every task stops at its commit step the same way. Every commit is followed by a push.
- **Before the PR:** architecture review stated explicitly in the PR body — tenant isolation, billing atomicity, unscoped queries, missing locks, bypassable auth, leaked internal fields — each with its result.
- **Input at the boundary:** every external input (server action `FormData`, REST body/query, MCP args) is parsed with a strict Zod schema (enums exact, dates valid, integers where cents, fields allowed/required per `kind`); the domain services validate again (defence in depth) and throw `QuotaError("INVALID_INPUT")`. No cast from string to enum anywhere.
- **One money tolerance:** `MONEY_EPSILON = 0.005` (exported from `src/lib/charges.ts`) is the only settled/open threshold — payments, refund rule, dunning, finances status, statement all compare with it. No literal `0.001`/`0.005` in new or touched code.
- **Concurrency tests prove blocking, never rely on timing:** two connections with distinct `application_name`; the first operation runs its `…InTx` primitive inside a manual transaction and stops at an explicit gate after taking its locks; the test waits (polling `pg_stat_activity`, bounded 5 s) until the second connection is in `wait_event_type = 'Lock'`, asserts the second promise is still pending, releases the gate, and asserts the outcome. No `setTimeout` as synchronisation.

## Decisions taken in this plan (review these)

1. **The void reason is mandatory everywhere, no technical fallback.** UI: the charge row's generic delete button is replaced by a `VoidChargeButton` (same `AlertDialog`, plus a required reason textarea; the action refuses an empty reason). REST: `DELETE /api/v1/records/charge/:id` requires `reason` (JSON body `{ "reason": "…" }` or query `?reason=`) → 400 without it. MCP: `delete_record` gains an optional `reason` argument that `apiDelete` requires when `entity = "charge"`. `apiDelete(p, entity, id, opts?: { reason?: string })` is the single place that enforces it. Other entities are unaffected.
2. **Audit inside the transaction.** Primitives write `AuditLog` with `tx.auditLog.create` (not the fire-and-forget `audit()` helper), so the audit row commits or rolls back with the operation.
3. **Portal hides refunds.** `AUSGANG` allocations are excluded from the portal payment history (the spec forbids showing them as payments; showing them as refunds is release-3 UI).
4. **Finanças status for cancelled charges (and one tolerance):** the finances status now uses `MONEY_EPSILON = 0.005` instead of the page's old `0.001` — a charge with 0.004 open reads PAID everywhere. Also: a new status `CANCELLED` (badge "Anulada"/"Storniert"/"Cancelled") instead of `PAID`; it is filterable like the others.
5. **Owner selection query window:** owners are loaded for the property's units once, then resolved per unit in memory (`resolveHolders`), not with one query per unit.

## Review Focus

1. A second issuance request for the same property/month/kind with different parameters (e.g. another `dueDay`) must fail with `ALREADY_ISSUED_CONFLICT`, never silently return the old assessment (pinned in Task 4).
2. An `EconomicPlan` edit racing the first ordinary issuance of that year must end with either the edit refused or the issuance using the new plan — never an issued month on an edited plan (pinned in Task 1 trigger test + Task 4 two-connection test).
3. A co-owned fraction (500/500) where one owner's charge is voided keeps the assessment `ISSUED` and still blocks `reissueCharge` from exceeding the line (pinned in Task 5).
4. A full refund entered as a normal payment must be refused without writing anything, and no exported function can zero a charge's net paid while leaving it `ISSUED` (pinned in Task 3 + Task 5).
8. A payment allocated to a `CANCELLED` charge (e.g. the refund written by `refundAndCancel`) can never be deleted — otherwise the charge stays cancelled with money received and not returned (pinned in Task 3 + Task 5, sequential and gated).
5. A fraction with `mea` null or 0 must block the whole issuance with `MEA_INVALID`, not be skipped (pinned in Task 2 + Task 4).
6. A malformed request (`kind: "ORDNARY"`, unknown `method`, `dueDay: "abc"`, `totalCents: 1.5`, invalid date, ordinary with `totalCents`) is refused with `INVALID_INPUT` — never coerced into a different financial operation (pinned in Task 4 + Task 7).
7. A statement asked for a unit or person of another tenant (or a unit of another property) returns `NOT_FOUND`, not an empty statement (pinned in Task 6).

---

## File Structure

- `prisma/schema.prisma` — modify: `Charge.cancelledAt/cancelReason`, `CondominiumAssessment.description/resolutionId/requestKey` + relation, `Resolution` `@@unique([id, tenantId])` + back-relation.
- `prisma/migrations/20260928100000_quotas_domain/migration.sql` — create.
- `src/lib/quotas/compute.ts` — create: pure calculation (no DB).
- `src/lib/quotas/errors.ts` — create: `QuotaError` with codes.
- `src/lib/quotas/input.ts` — create: Zod schemas `issueInputSchema` (discriminated on `kind`), `statementQuerySchema`, `reasonSchema`, `parseOrThrow`.
- `src/lib/quotas/concurrency-test-utils.ts` — create (test-only): `deferred`, `clientFor(appName)`, `waitUntilBlocked`, `isPending`.
- `src/components/void-charge-button.tsx` — create: reason dialog for voiding a charge.
- `src/lib/quotas/tx.ts` — create: `withRetry`, `planLockKey`, lock helpers, `recomputeAssessmentStatusInTx`.
- `src/lib/quotas/issue.ts` — create: `issueQuotasInTx`, `issueQuotas`, `issueQuotasRange`.
- `src/lib/quotas/lifecycle.ts` — create: `voidChargeInTx`, `refundAndCancelInTx`, `cancelAssessmentInTx`, `reissueChargeInTx`, `replaceDebtorInTx` + public wrappers.
- `src/lib/quotas/statement.ts` — create: `quotaStatement`.
- `src/lib/payments.ts` — modify: `recordPaymentInTx` + wrapper, refund rule.
- `src/server/actions/quotas.ts` — create: server actions with role levels.
- `src/server/actions/finances.ts`, `src/lib/api-write.ts`, `src/app/api/v1/records/[entity]/[id]/route.ts`, `src/app/api/mcp/route.ts`, `src/lib/api-data.ts`, `src/app/[locale]/portal/page.tsx`, `src/app/[locale]/(admin)/finances/page.tsx`, `src/lib/rbac.ts` — modify (Tasks 7–8).
- `messages/{de,en,pt}.json` — error codes and the `CANCELLED` status label.
- Tests next to the code: `src/lib/quotas/*.test.ts`, `src/lib/quotas-domain-schema.test.ts`.

## Test commands (every task)

One-time (the R1 image `havewa-test:node24` exists; recreate the DB container):

```bash
docker run -d --name r2-pg -p 127.0.0.1:54398:5432 -e POSTGRES_USER=havewa -e POSTGRES_PASSWORD=havewa -e POSTGRES_DB=havewa_test postgres:16-alpine
```

```bash
T() { docker run --rm -v "$PWD":/app -v havewa-test-nm:/app/node_modules -w /app \
  -e DATABASE_URL=postgresql://havewa:havewa@host.docker.internal:54398/havewa_test \
  -e INTEGRATION_DATABASE_URL=postgresql://havewa:havewa@host.docker.internal:54398/havewa_test \
  havewa-test:node24 sh -c "npx prisma generate >/dev/null && $*"; }
```

- Migrate: `T "npx prisma migrate deploy"`
- One file: `T "npx vitest run src/lib/quotas/compute.test.ts"`
- Full suite: `T "npx vitest run"`; type check: `T "npx tsc --noEmit -p ."` (3 pre-existing `src/lib/sso.test.ts` errors accepted)
- Demo contract (seed guard needs localhost): `docker run --rm --network container:r2-pg -v "$PWD":/app -v havewa-test-nm:/app/node_modules -w /app -e CRMWARE_DEMO_TEST_DATABASE_URL=postgresql://havewa:havewa@127.0.0.1:5432/havewa_seed_test -e DATABASE_URL=postgresql://havewa:havewa@127.0.0.1:5432/havewa_seed_test havewa-test:node24 sh -c "npx prisma generate >/dev/null && npx prisma migrate deploy && npm run test:crmware-demo"` (create `havewa_seed_test` first: `docker exec r2-pg psql -U havewa -d postgres -c "CREATE DATABASE havewa_seed_test"`).
- Changing the migration file after applying it: recreate both test DBs (`DROP DATABASE … WITH (FORCE)` / `CREATE DATABASE`) and migrate again.

Concurrency helpers (create in Task 4 as `src/lib/quotas/concurrency-test-utils.ts`, test-only):

```ts
// Nur für Tests: Nebenläufigkeit beweisen statt timen — Gates und Warten auf echte Lock-Wartezustände.
import { PrismaClient } from "@prisma/client";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export function clientFor(appName: string) {
  const url = new URL(process.env.INTEGRATION_DATABASE_URL!);
  url.searchParams.set("application_name", appName);
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

/** Wartet (max. 5 s), bis eine Sitzung mit diesem application_name auf einen Lock wartet. */
export async function waitUntilBlocked(observer: PrismaClient, appName: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await observer.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = ${appName} AND wait_event_type = 'Lock'`;
    if (Number(rows[0].n) > 0) return;
    if (Date.now() > deadline) throw new Error(`${appName} never blocked on a lock`);
    await new Promise((r) => setImmediate(r));
  }
}

/** true, solange p nicht erledigt ist. Eine bereits erledigte Promise löst ihr then() in Mikrotasks auf,
 *  die vor dem Makrotask setImmediate laufen — daher gewinnt der Timer nur, wenn p wirklich noch offen ist. */
export async function isPending(p: Promise<unknown>) {
  return Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setImmediate(() => r(true)))]);
}
```

(`setImmediate` in `waitUntilBlocked` only yields between polls; the synchronisation is the observed `pg_stat_activity` state. Task 4 adds a self-test for the helper in `src/lib/quotas/concurrency-test-utils.test.ts`: `isPending(new Promise(() => {}))` → `true`; `isPending(Promise.resolve(1))` → `false`; a rejected promise (with a no-op `catch` attached) → `false`.)

Shared test fixture used by several tasks (create in Task 1 as `src/lib/quotas/fixtures.ts`, test-only):

```ts
// Nur für Tests: WEG-Objekt mit Einheiten, Eigentümern und Wirtschaftsplan.
import type { PrismaClient } from "@prisma/client";

export async function wegFixture(db: PrismaClient, tenantId: string, opts: { meas?: number[]; annual?: number; year?: number } = {}) {
  const meas = opts.meas ?? [400, 600];
  const year = opts.year ?? 2026;
  const property = await db.property.create({ data: { tenantId, name: "Cond", street: "S", zip: "1000-001", city: "Lisboa", management: "WEG", meaTotal: meas.reduce((a, b) => a + b, 0) } });
  const building = await db.building.create({ data: { tenantId, propertyId: property.id, name: "B" } });
  const units = [];
  const persons = [];
  for (let i = 0; i < meas.length; i++) {
    const unit = await db.unit.create({ data: { tenantId, buildingId: building.id, label: `F${i + 1}`, area: 50, mea: meas[i] } });
    const person = await db.person.create({ data: { tenantId, firstName: `P${i + 1}`, lastName: "Teste" } });
    await db.owner.create({ data: { tenantId, unitId: unit.id, personId: person.id, share: 1000, vigencia: "CONFIRMED", validFrom: new Date(Date.UTC(2020, 0, 1)) } });
    units.push(unit);
    persons.push(person);
  }
  const plan = await db.economicPlan.create({ data: { tenantId, propertyId: property.id, year, totalAmount: opts.annual ?? 1200 } });
  return { property, building, units, persons, plan };
}
```

`createTestTenant().cleanup()` (in `src/lib/test-db.ts`) must also delete `owner`, `economicPlan`, `resolution`, `auditLog` rows of the tenant before the tenant (add in Task 1; persons/units cascade from the tenant via property/building, but owners/plans with RESTRICT paths must go first — check the order against the FKs and document it).

---

### Task 1: R2 schema — cancellation fields, assessment metadata, resolution link, plan lock

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260928100000_quotas_domain/migration.sql`
- Create: `src/lib/quotas/fixtures.ts` (code above)
- Modify: `src/lib/test-db.ts` (cleanup), `src/lib/quotas-schema.test.ts` and `src/lib/tenant-deletion.test.ts` (assessments now need `requestKey`)
- Test: `src/lib/quotas-domain-schema.test.ts`

**Interfaces:**
- Produces (Prisma): `Charge.cancelledAt DateTime?`, `Charge.cancelReason String?`; `CondominiumAssessment.description String?`, `resolutionId String?`, `resolution Resolution?`, `requestKey String`; `Resolution.assessments CondominiumAssessment[]`, `@@unique([id, tenantId])`.
- Produces (DB): CHECK `charge_cancel_consistency`; triggers `assessment_resolution_same_property`, `resolution_move_keeps_assessments`, `economic_plan_locked_by_issued_ordinary`; SQL function `plan_lock_key(tenant text, property text, yr int) returns bigint`.

- [ ] **Step 1: Write the failing tests** — `src/lib/quotas-domain-schema.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "./test-db";
import { wegFixture } from "./quotas/fixtures";

let t: Awaited<ReturnType<typeof createTestTenant>>;
let fx: Awaited<ReturnType<typeof wegFixture>>;
const may = new Date(Date.UTC(2026, 4, 1));
const assessment = (over: object = {}) => ({
  tenantId: t.tenantId, propertyId: fx.property.id, period: may, kind: "ORDINARY" as const, method: "PERMILLAGE" as const,
  dueDate: may, asOf: may, totalCents: 10000, requestKey: "k", ...over,
});

describeDb("R2-Schema (#52)", () => {
  beforeEach(async () => { t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(() => t.cleanup());

  it("CANCELLED braucht cancelledAt und einen nicht leeren Grund; ISSUED keines von beiden", async () => {
    const lease = await db!.lease.create({ data: { tenantId: t.tenantId, unitId: fx.units[0].id, startDate: may, rentCold: 100 } });
    const base = { tenantId: t.tenantId, leaseId: lease.id, type: "SONSTIGES" as const, period: may, dueDate: may, amount: 10 };
    await expect(db!.charge.create({ data: { ...base, status: "CANCELLED", cancelledAt: new Date() } })).rejects.toThrow(/charge_cancel_consistency/);
    await expect(db!.charge.create({ data: { ...base, status: "CANCELLED", cancelledAt: new Date(), cancelReason: "   " } })).rejects.toThrow(/charge_cancel_consistency/);
    await expect(db!.charge.create({ data: { ...base, cancelReason: "x" } })).rejects.toThrow(/charge_cancel_consistency/);
    await expect(db!.charge.create({ data: { ...base, status: "CANCELLED", cancelledAt: new Date(), cancelReason: "erro" } })).resolves.toBeTruthy();
  });

  it("Deliberação muss zum Objekt des Assessments gehören — beim Schreiben des Assessments und beim Verschieben der Deliberação", async () => {
    const other = await db!.property.create({ data: { tenantId: t.tenantId, name: "Outro", street: "S", zip: "1", city: "L", management: "WEG" } });
    const resOther = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: other.id, number: 1, title: "x", text: "x", date: may } });
    await expect(db!.condominiumAssessment.create({ data: assessment({ kind: "EXTRAORDINARY", resolutionId: resOther.id }) })).rejects.toThrow(/assessment resolution not in assessment property/);
    const res = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: fx.property.id, number: 1, title: "x", text: "x", date: may } });
    await db!.condominiumAssessment.create({ data: assessment({ kind: "EXTRAORDINARY", resolutionId: res.id }) });
    await expect(db!.resolution.update({ where: { id: res.id }, data: { propertyId: other.id } })).rejects.toThrow(/assessment resolution not in assessment property/);
  });

  it("Wirtschaftsplan ist gesperrt, solange eine ordentliche ISSUED-Emission des Jahres existiert", async () => {
    const a = await db!.condominiumAssessment.create({ data: assessment() });
    await expect(db!.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 1300 } })).rejects.toThrow(/plan locked by issued ordinary assessments/);
    await expect(db!.economicPlan.delete({ where: { id: fx.plan.id } })).rejects.toThrow(/plan locked by issued ordinary assessments/);
    await db!.condominiumAssessment.update({ where: { id: a.id }, data: { status: "CANCELLED" } });
    await expect(db!.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 1300 } })).resolves.toBeTruthy();
  });

  it("Notiz-Änderung am Plan bleibt erlaubt", async () => {
    await db!.condominiumAssessment.create({ data: assessment() });
    await expect(db!.economicPlan.update({ where: { id: fx.plan.id }, data: { note: "nota" } })).resolves.toBeTruthy();
  });
});
```

Also add `requestKey: "k"` to every `condominiumAssessment.create` in `src/lib/quotas-schema.test.ts` and `src/lib/tenant-deletion.test.ts`.

- [ ] **Step 2: Run it.** `T "npx vitest run src/lib/quotas-domain-schema.test.ts"` — Expected: FAIL (unknown fields `cancelledAt`, `requestKey`, …).

- [ ] **Step 3: Schema** — in `prisma/schema.prisma`:
  - `Charge`: `cancelledAt DateTime?` and `cancelReason String?` (comment: `// #52 R2: gesetzt genau dann, wenn status = CANCELLED (CHECK in SQL)`).
  - `CondominiumAssessment`: `description String?`, `resolutionId String?`, `resolution Resolution? @relation(fields: [resolutionId, tenantId], references: [id, tenantId], onDelete: Restrict)`, `requestKey String` (comment: `// kanonische Anfrage-Identität (Idempotenz)`).
  - `Resolution`: `assessments CondominiumAssessment[]` and `@@unique([id, tenantId])`.

- [ ] **Step 4: Migration** — `prisma/migrations/20260928100000_quotas_domain/migration.sql`:

```sql
-- #52 Release 2 (Domínio). Voraussetzung: noch keine Emissionen (Fundação hat keinen Generator).
LOCK TABLE "CondominiumAssessment" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CondominiumAssessment") THEN
    RAISE EXCEPTION '#52 R2: CondominiumAssessment enthält Daten; diese Migration setzt keine Emissionen voraus.';
  END IF;
END $$;

-- Stornierung: Zeitpunkt und Grund genau bei CANCELLED.
ALTER TABLE "Charge" ADD COLUMN "cancelledAt" TIMESTAMP(3), ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "Charge" ADD CONSTRAINT charge_cancel_consistency CHECK (
  ("status" = 'ISSUED' AND "cancelledAt" IS NULL AND "cancelReason" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND btrim("cancelReason") <> '')
);

-- Assessment: Beschreibung, Deliberação, Anfrage-Identität.
ALTER TABLE "CondominiumAssessment" ADD COLUMN "description" TEXT, ADD COLUMN "resolutionId" TEXT, ADD COLUMN "requestKey" TEXT NOT NULL;
CREATE UNIQUE INDEX "Resolution_id_tenantId_key" ON "Resolution"("id", "tenantId");
ALTER TABLE "CondominiumAssessment" ADD CONSTRAINT "CondominiumAssessment_resolutionId_tenantId_fkey"
  FOREIGN KEY ("resolutionId", "tenantId") REFERENCES "Resolution"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deliberação und Assessment im selben Objekt, in beide Richtungen, mit FOR SHARE gegen Nebenläufigkeit.
CREATE FUNCTION assessment_resolution_same_property() RETURNS trigger AS $$
DECLARE res_property TEXT;
BEGIN
  IF NEW."resolutionId" IS NULL THEN RETURN NEW; END IF;
  SELECT r."propertyId" INTO res_property FROM "Resolution" r
    WHERE r.id = NEW."resolutionId" AND r."tenantId" = NEW."tenantId" FOR SHARE;
  -- fehlende/fremde Deliberação meldet die zusammengesetzte FK
  IF res_property IS NOT NULL AND res_property <> NEW."propertyId" THEN
    RAISE EXCEPTION 'assessment resolution not in assessment property';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER assessment_resolution_same_property BEFORE INSERT OR UPDATE OF "resolutionId", "propertyId" ON "CondominiumAssessment"
  FOR EACH ROW EXECUTE FUNCTION assessment_resolution_same_property();

CREATE FUNCTION resolution_move_keeps_assessments() RETURNS trigger AS $$
BEGIN
  IF NEW."propertyId" IS DISTINCT FROM OLD."propertyId" AND EXISTS (
    SELECT 1 FROM "CondominiumAssessment" a
    WHERE a."resolutionId" = NEW.id AND a."tenantId" = NEW."tenantId" AND a."propertyId" <> NEW."propertyId"
  ) THEN
    RAISE EXCEPTION 'assessment resolution not in assessment property';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER resolution_move_keeps_assessments BEFORE UPDATE OF "propertyId" ON "Resolution"
  FOR EACH ROW EXECUTE FUNCTION resolution_move_keeps_assessments();

-- Wirtschaftsplan gesperrt, solange ordentliche ISSUED-Emissionen des Jahres existieren.
-- Gemeinsamer Serialisierungspunkt mit der Emission: Advisory-Lock je (tenant, Objekt, Jahr);
-- Kollisionen des Hashes serialisieren nur zu viel, nie zu wenig.
CREATE FUNCTION plan_lock_key(tenant TEXT, property TEXT, yr INT) RETURNS BIGINT AS $$
  SELECT hashtextextended(tenant || ':' || property || ':' || yr::text, 0)
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION economic_plan_locked_by_issued_ordinary() RETURNS trigger AS $$
DECLARE k_old BIGINT; k_new BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."totalAmount" = OLD."totalAmount" AND NEW."year" = OLD."year" AND NEW."propertyId" = OLD."propertyId" THEN
    RETURN NEW; -- z. B. nur Notiz geändert
  END IF;
  k_old := plan_lock_key(OLD."tenantId", OLD."propertyId", OLD."year");
  IF TG_OP = 'UPDATE' THEN
    k_new := plan_lock_key(NEW."tenantId", NEW."propertyId", NEW."year");
    -- feste Reihenfolge (bigint aufsteigend) gegen Deadlocks bei gegenläufigen Änderungen
    PERFORM pg_advisory_xact_lock(LEAST(k_old, k_new));
    IF k_new <> k_old THEN PERFORM pg_advisory_xact_lock(GREATEST(k_old, k_new)); END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(k_old);
  END IF;
  -- erst unter der Sperre prüfen
  IF EXISTS (
    SELECT 1 FROM "CondominiumAssessment" a
    WHERE a."tenantId" = OLD."tenantId" AND a.kind = 'ORDINARY' AND a.status = 'ISSUED'
      AND ((a."propertyId" = OLD."propertyId" AND EXTRACT(YEAR FROM a.period) = OLD."year")
        OR (TG_OP = 'UPDATE' AND a."propertyId" = NEW."propertyId" AND EXTRACT(YEAR FROM a.period) = NEW."year"))
  ) THEN
    RAISE EXCEPTION 'plan locked by issued ordinary assessments';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER economic_plan_locked_by_issued_ordinary BEFORE UPDATE OR DELETE ON "EconomicPlan"
  FOR EACH ROW EXECUTE FUNCTION economic_plan_locked_by_issued_ordinary();
```

- [ ] **Step 5: Extend `cleanup()`** in `src/lib/test-db.ts` with `owner`, `economicPlan`, `resolution`, `auditLog` deletes of the tenant (owners before the tenant; plans/resolutions after assessments because of the new FK; audit anywhere). Create `src/lib/quotas/fixtures.ts`.

- [ ] **Step 6: Apply and test.** `T "npx prisma migrate deploy"`, then `T "npx vitest run src/lib/quotas-domain-schema.test.ts src/lib/quotas-schema.test.ts src/lib/tenant-deletion.test.ts"` — Expected: PASS. Then `prisma migrate diff` against a scratch DB on r2-pg (like R1): only raw-SQL objects may differ.

- [ ] **Step 7: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "feat(#52): R2 schema — cancellation fields, assessment metadata, resolution link, plan lock"` then `git push -u origin feat/52-release2`.

---

### Task 2: Pure calculation — `allocateCents`, monthly split, methods, holders, request key

**Files:**
- Create: `src/lib/quotas/compute.ts`, `src/lib/quotas/errors.ts`
- Test: `src/lib/quotas/compute.test.ts`

**Interfaces:**
- Produces:
  - `class QuotaError extends Error { constructor(public code: QuotaErrorCode, message?: string, public details?: unknown) }`; `type QuotaErrorCode = "PLAN_MISSING" | "PLAN_CHANGED" | "MEA_INVALID" | "FIXED_NOT_DIVISIBLE" | "CUSTOM_INVALID" | "HOLDERS_INVALID" | "ALREADY_ISSUED_CONFLICT" | "SNAPSHOT_SUPERSEDED" | "HAS_PAYMENTS" | "USE_REFUND_AND_CANCEL" | "NOT_FOUND" | "INVALID_INPUT" | "RETRY_EXHAUSTED"`.
  - `allocateCents(totalCents: number, parts: { id: string; weight: number }[]): { id: string; amountCents: number }[]`
  - `monthlyFromAnnual(annualCents: number, month: number /* 1–12 */): number`
  - `computeLines(input: { totalCents: number; method: "PERMILLAGE" | "FIXED" | "CUSTOM"; units: { id: string; mea: number | null }[]; meaTotal: number; custom?: Record<string, number>; annualCents?: number /* FIXED ordinary */ }): { unitId: string; amountCents: number }[]` (throws `QuotaError`; units sorted by id inside)
  - `resolveHolders(owners: { personId: string; share: number; vigencia: "CONFIRMED" | "UNKNOWN"; validFrom: Date | null; validTo: Date | null }[], asOf: Date, cutover: Date | null): { personId: string; share: number }[] | { error: string }`
  - `requestKey(r: { kind: string; period: Date; method: string; dueDate: Date; asOf: Date; totalCents: number; custom?: Record<string, number>; resolutionId?: string | null; description?: string | null }): string`

- [ ] **Step 1: Write the failing tests** — `src/lib/quotas/compute.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allocateCents, computeLines, monthlyFromAnnual, requestKey, resolveHolders } from "./compute";
import { QuotaError } from "./errors";

const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);

describe("allocateCents (#52 R2)", () => {
  it("verteilt exakt nach größtem Rest, nur ganze Cent", () => {
    const r = allocateCents(10000, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }]);
    expect(sum(r)).toBe(10000);
    expect(r.map((x) => x.amountCents)).toEqual([3334, 3333, 3333]);
    expect(r.every((x) => Number.isInteger(x.amountCents))).toBe(true);
  });
  it("Gleichstand: Reihenfolge der Eingabe entscheidet", () => {
    expect(allocateCents(1, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }])).toEqual([{ id: "a", amountCents: 1 }, { id: "b", amountCents: 0 }]);
  });
  it("lehnt Nicht-Ganzzahlen und leere Gewichte ab", () => {
    expect(() => allocateCents(10.5, [{ id: "a", weight: 1 }])).toThrow(QuotaError);
    expect(() => allocateCents(100, [{ id: "a", weight: 0 }])).toThrow(QuotaError);
    expect(() => allocateCents(100, [{ id: "a", weight: 1.5 }, { id: "b", weight: 1 }])).toThrow(QuotaError);
  });
});

describe("monthlyFromAnnual (#52 R2)", () => {
  it("Monate 1–11 gerundet, Monat 12 = Rest; Summe = Jahr", () => {
    const annual = 100001;
    const months = Array.from({ length: 12 }, (_, i) => monthlyFromAnnual(annual, i + 1));
    expect(months.slice(0, 11).every((m) => m === 8333)).toBe(true);
    expect(months[11]).toBe(100001 - 11 * 8333);
    expect(months.reduce((a, b) => a + b, 0)).toBe(annual);
  });
});

describe("computeLines (#52 R2)", () => {
  const units = [{ id: "u2", mea: 600 }, { id: "u1", mea: 400 }];
  it("PERMILLAGE nach mea, nach unitId sortiert, exakte Summe", () => {
    expect(computeLines({ totalCents: 1000, method: "PERMILLAGE", units, meaTotal: 1000 })).toEqual([
      { unitId: "u1", amountCents: 400 }, { unitId: "u2", amountCents: 600 },
    ]);
  });
  it("PERMILLAGE: mea null/0 oder Summe ≠ meaTotal → MEA_INVALID, keine Einheit wird ausgelassen", () => {
    for (const bad of [[{ id: "u1", mea: null }, { id: "u2", mea: 1000 }], [{ id: "u1", mea: 0 }, { id: "u2", mea: 1000 }], [{ id: "u1", mea: 400 }, { id: "u2", mea: 500 }]]) {
      try { computeLines({ totalCents: 1000, method: "PERMILLAGE", units: bad, meaTotal: 1000 }); throw new Error("no throw"); }
      catch (e) { expect((e as QuotaError).code).toBe("MEA_INVALID"); }
    }
  });
  it("FIXED: teilbar ok, sonst FIXED_NOT_DIVISIBLE; ordentlich: Jahr durch 12·n", () => {
    expect(computeLines({ totalCents: 1000, method: "FIXED", units, meaTotal: 1000 }).map((l) => l.amountCents)).toEqual([500, 500]);
    expect(() => computeLines({ totalCents: 1001, method: "FIXED", units, meaTotal: 1000 })).toThrow(/FIXED_NOT_DIVISIBLE/);
    expect(() => computeLines({ totalCents: 1000, method: "FIXED", units, meaTotal: 1000, annualCents: 12001 })).toThrow(/FIXED_NOT_DIVISIBLE/);
  });
  it("CUSTOM: vollständig, ohne Duplikate, Summe = Total; Nullen erlaubt", () => {
    expect(computeLines({ totalCents: 1000, method: "CUSTOM", units, meaTotal: 1000, custom: { u1: 0, u2: 1000 } })).toEqual([
      { unitId: "u1", amountCents: 0 }, { unitId: "u2", amountCents: 1000 },
    ]);
    for (const custom of [{ u1: 1000 }, { u1: 500, u2: 400 }, { u1: 500, u2: 500, x: 0 }]) {
      expect(() => computeLines({ totalCents: 1000, method: "CUSTOM", units, meaTotal: 1000, custom })).toThrow(/CUSTOM_INVALID/);
    }
  });
});

describe("resolveHolders (#52 R2)", () => {
  const d = (s: string) => new Date(s);
  const cutover = d("2026-01-01T00:00:00Z");
  it("CONFIRMED, die asOf überdecken; Summe 1000", () => {
    const r = resolveHolders([
      { personId: "p1", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p2", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null },
      { personId: "p3", share: 1000, vigencia: "UNKNOWN", validFrom: null, validTo: null },
    ], d("2026-05-01"), cutover);
    expect(r).toEqual([{ personId: "p1", share: 500 }, { personId: "p2", share: 500 }]);
  });
  it("UNKNOWN nur ab Stichtag und mit validTo null", () => {
    const owners = [{ personId: "p3", share: 1000, vigencia: "UNKNOWN" as const, validFrom: null, validTo: null }];
    expect(resolveHolders(owners, d("2026-05-01"), cutover)).toEqual([{ personId: "p3", share: 1000 }]);
    expect(resolveHolders(owners, d("2025-05-01"), cutover)).toHaveProperty("error");
    expect(resolveHolders(owners, d("2026-05-01"), null)).toHaveProperty("error");
  });
  it("Summe ≠ 1000 → Fehler", () => {
    expect(resolveHolders([{ personId: "p1", share: 500, vigencia: "CONFIRMED", validFrom: d("2020-01-01"), validTo: null }], d("2026-05-01"), cutover)).toHaveProperty("error");
  });
});

describe("requestKey (#52 R2)", () => {
  it("stabil, CUSTOM-Reihenfolge egal, Parameter ändern den Schlüssel", () => {
    const base = { kind: "ORDINARY", period: new Date("2026-05-01T00:00:00Z"), method: "CUSTOM", dueDate: new Date("2026-05-08T00:00:00Z"), asOf: new Date("2026-05-01T00:00:00Z"), totalCents: 1000 };
    expect(requestKey({ ...base, custom: { a: 1, b: 2 } })).toBe(requestKey({ ...base, custom: { b: 2, a: 1 } }));
    expect(requestKey({ ...base, custom: { a: 1, b: 2 } })).not.toBe(requestKey({ ...base, dueDate: new Date("2026-05-09T00:00:00Z"), custom: { a: 1, b: 2 } }));
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/lib/quotas/errors.ts`:

```ts
// #52 R2: fachliche Fehler der Quoten mit stabilem Code (Übersetzung in der UI über messages).
export type QuotaErrorCode =
  | "PLAN_MISSING" | "PLAN_CHANGED" | "MEA_INVALID" | "FIXED_NOT_DIVISIBLE" | "CUSTOM_INVALID" | "HOLDERS_INVALID"
  | "ALREADY_ISSUED_CONFLICT" | "SNAPSHOT_SUPERSEDED" | "HAS_PAYMENTS" | "USE_REFUND_AND_CANCEL"
  | "NOT_FOUND" | "INVALID_INPUT" | "RETRY_EXHAUSTED";

export class QuotaError extends Error {
  constructor(public code: QuotaErrorCode, message?: string, public details?: unknown) {
    super(message ? `${code}: ${message}` : code);
  }
}
```

and `src/lib/quotas/compute.ts`:

```ts
// #52 R2: reine Berechnung der Quoten — nur ganze Cent, keine DB.
import { createHash } from "node:crypto";
import { QuotaError } from "./errors";

export function allocateCents(totalCents: number, parts: { id: string; weight: number }[]) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new QuotaError("INVALID_INPUT", "totalCents");
  const sumW = parts.reduce((s, p) => s + p.weight, 0);
  // Gewichte sind mea, share oder 1 — immer ganzzahlig; der Rest-Vergleich (%) setzt das voraus.
  if (parts.length === 0 || sumW <= 0 || parts.some((p) => !Number.isInteger(p.weight) || p.weight < 0)) throw new QuotaError("INVALID_INPUT", "weights");
  // exakt in BigInt-freier Ganzzahl-Arithmetik: Zähler totalCents*weight, Nenner sumW (Gewichte sind ganzzahlig: mea, share, 1)
  const raw = parts.map((p) => ({ id: p.id, num: totalCents * p.weight }));
  const floors = raw.map((r) => Math.floor(r.num / sumW));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r.num % sumW })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  const cents = floors.slice();
  for (const { i } of order) { if (remainder <= 0) break; cents[i] += 1; remainder -= 1; }
  return parts.map((p, i) => ({ id: p.id, amountCents: cents[i] }));
}

export function monthlyFromAnnual(annualCents: number, month: number) {
  const base = Math.round(annualCents / 12);
  return month === 12 ? annualCents - 11 * base : base;
}

type Method = "PERMILLAGE" | "FIXED" | "CUSTOM";
export function computeLines(input: { totalCents: number; method: Method; units: { id: string; mea: number | null }[]; meaTotal: number; custom?: Record<string, number>; annualCents?: number }) {
  const units = [...input.units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (units.length === 0) throw new QuotaError("INVALID_INPUT", "keine Frações");
  if (input.method === "PERMILLAGE") {
    const bad = units.filter((u) => !Number.isInteger(u.mea) || (u.mea as number) <= 0).map((u) => u.id);
    const total = units.reduce((s, u) => s + (u.mea ?? 0), 0);
    if (bad.length > 0 || total !== input.meaTotal) throw new QuotaError("MEA_INVALID", undefined, { units: bad, sum: total, meaTotal: input.meaTotal });
    return allocateCents(input.totalCents, units.map((u) => ({ id: u.id, weight: u.mea as number }))).map((x) => ({ unitId: x.id, amountCents: x.amountCents }));
  }
  if (input.method === "FIXED") {
    const n = units.length;
    if (input.totalCents % n !== 0 || (input.annualCents !== undefined && input.annualCents % (12 * n) !== 0)) throw new QuotaError("FIXED_NOT_DIVISIBLE");
    return units.map((u) => ({ unitId: u.id, amountCents: input.totalCents / n }));
  }
  const custom = input.custom ?? {};
  const keys = Object.keys(custom);
  const ids = new Set(units.map((u) => u.id));
  const missing = units.filter((u) => !(u.id in custom)).map((u) => u.id);
  const foreign = keys.filter((k) => !ids.has(k));
  const invalid = keys.filter((k) => !Number.isInteger(custom[k]) || custom[k] < 0);
  const total = keys.reduce((s, k) => s + (custom[k] ?? 0), 0);
  if (missing.length || foreign.length || invalid.length || total !== input.totalCents) {
    throw new QuotaError("CUSTOM_INVALID", undefined, { missing, foreign, invalid, sum: total });
  }
  return units.map((u) => ({ unitId: u.id, amountCents: custom[u.id] }));
}

type OwnerRow = { personId: string; share: number; vigencia: "CONFIRMED" | "UNKNOWN"; validFrom: Date | null; validTo: Date | null };
export function resolveHolders(owners: OwnerRow[], asOf: Date, cutover: Date | null): { personId: string; share: number }[] | { error: string } {
  const covers = (o: OwnerRow) => o.validFrom !== null && o.validFrom <= asOf && (o.validTo === null || asOf < o.validTo);
  const confirmed = owners.filter((o) => o.vigencia === "CONFIRMED" && covers(o));
  let holders: OwnerRow[];
  if (confirmed.length > 0) holders = confirmed;
  else if (cutover !== null && asOf >= cutover) holders = owners.filter((o) => o.vigencia === "UNKNOWN" && o.validTo === null);
  else return { error: "sem titular válido no asOf" };
  const byPerson = new Map<string, number>();
  for (const h of holders) {
    if (byPerson.has(h.personId)) return { error: `intervalos sobrepostos para ${h.personId}` };
    byPerson.set(h.personId, h.share);
  }
  const total = [...byPerson.values()].reduce((a, b) => a + b, 0);
  if (total !== 1000) return { error: `soma das quotas-partes = ${total}` };
  return [...byPerson.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([personId, share]) => ({ personId, share }));
}

export function requestKey(r: { kind: string; period: Date; method: string; dueDate: Date; asOf: Date; totalCents: number; custom?: Record<string, number>; resolutionId?: string | null; description?: string | null }) {
  const custom = r.custom ? Object.keys(r.custom).sort().map((k) => `${k}=${r.custom![k]}`).join(",") : "";
  const customHash = custom ? createHash("sha256").update(custom).digest("hex") : "";
  return [r.kind, r.period.toISOString(), r.method, r.dueDate.toISOString(), r.asOf.toISOString(), r.totalCents, customHash, r.resolutionId ?? "", r.description ?? ""].join("|");
}
```

(`allocateCents` enforces integer weights — `mea`, `share` and `1` are integers; a fractional weight is `INVALID_INPUT`, tested above.)

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "feat(#52): R2 pure quota calculation — allocateCents, monthly split, methods, holders, request key"` then `git push -u origin feat/52-release2`.

---

### Task 3: Payment primitive in a caller's transaction; full refunds only via refund-and-cancel

**Files:**
- Modify: `src/lib/payments.ts`
- Test: `src/lib/payments.test.ts` (extend)

**Interfaces:**
- Consumes: `QuotaError` (Task 2).
- Produces: `recordPaymentInTx(tx: Prisma.TransactionClient, input: RecordInput): Promise<{ paymentId: string; allocated: number }>`; `recordPayment(input, db?)` = `db.$transaction((tx) => recordPaymentInTx(tx, input), { isolationLevel: ReadCommitted })`. **No flag or mode can zero a charge's net paid**: a refund that would bring it to ≤ `MONEY_EPSILON` always throws `QuotaError("USE_REFUND_AND_CANCEL")`. The full refund is written only inside `refundAndCancelInTx` (Task 5), privately. `deletePaymentWithAllocationsInTx(tx, tenantId, paymentId)` (the current body, moved) + wrapper `deletePaymentWithAllocations(tenantId, paymentId, db?)` = `db.$transaction((tx) => deletePaymentWithAllocationsInTx(tx, tenantId, paymentId))`; it refuses when any allocated charge is `CANCELLED` (`PaymentError`).
- `MONEY_EPSILON` exported from `src/lib/charges.ts`.

- [ ] **Step 1: Write the failing tests** — add to `src/lib/payments.test.ts`:

```ts
  it("Teilrückzahlung erlaubt; Rückzahlung, die den Nettoeingang auf 0 brächte, wird ohne Schreiben abgelehnt", async () => {
    await pay(300);
    await expect(pay(100, { direction: "AUSGANG" })).resolves.toMatchObject({ allocated: 100 });
    const before = await db!.payment.count({ where: { tenantId: t.tenantId } });
    await expect(pay(200, { direction: "AUSGANG" })).rejects.toMatchObject({ code: "USE_REFUND_AND_CANCEL" });
    expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(before);
  });

  it("parallel: zwei Rückzahlungen, die zusammen auf 0 kämen — höchstens eine wird angenommen", async () => {
    await pay(200);
    const r = await Promise.allSettled([pay(100, { direction: "AUSGANG" }), pay(100, { direction: "AUSGANG" })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
  });
```

```ts
  it("Zahlungen einer stornierten Sollstellung sind unveränderlich: Löschen (Eingang oder Rückzahlung) verweigert", async () => {
    const inn = await pay(200);
    const out = await pay(50, { direction: "AUSGANG" });
    await db!.charge.update({ where: { id: chargeId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "teste" } });
    await expect(deletePaymentWithAllocations(t.tenantId, out.paymentId, db!)).rejects.toThrow(PaymentError);
    await expect(deletePaymentWithAllocations(t.tenantId, inn.paymentId, db!)).rejects.toThrow(PaymentError);
    expect(await db!.paymentAllocation.count({ where: { chargeId } })).toBe(2);
  });

  it("kein exportierter Weg zum Nullstellen: recordPaymentInTx kennt keinen Umgehungs-Parameter", () => {
    const src = readFileSync("src/lib/payments.ts", "utf8");
    expect(src).not.toMatch(/allowZeroing|allowZero|zeroing/i);
  });
```

(The old test "Rückzahlung (AUSGANG) höchstens bis zum Nettoeingang" that refunds 500 after paying 200 now expects `USE_REFUND_AND_CANCEL` — update it: a refund of 150 after paying 200 allocates 150; a refund of 500 is refused.)

- [ ] **Step 2: Run it.** Expected: FAIL (no `code`, zeroing accepted).

- [ ] **Step 3: Implement** — move the body of the current transaction into `recordPaymentInTx(tx, input)`; keep all checks. Replace the cap block with:

```ts
    const b = chargeBalance(charge);
    let allocated: number;
    if (data.direction === "AUSGANG") {
      allocated = Math.round(Math.min(data.amount, Math.max(0, b.paid)) * 100) / 100;
      // #52 R2: den Nettoeingang auf 0 bringen darf nur refundAndCancel (gleiche Transaktion wie CANCELLED).
      if (allocated > 0 && b.paid - allocated <= MONEY_EPSILON) {
        throw new QuotaError("USE_REFUND_AND_CANCEL");
      }
    } else {
      allocated = Math.round(Math.min(data.amount, allowCredit ? data.amount : Math.max(0, b.open)) * 100) / 100;
    }
```

Add `export const MONEY_EPSILON = 0.005; // einzige Toleranz für offen/beglichen (#52 R2)` to `src/lib/charges.ts` and replace the four `0.005` literals in `src/lib/payments.ts` (lines ~74, 91, 96, 104) with it. Note the throw happens after `tx.payment.create` — the caller's transaction rolls back, so nothing is written (the test counts payments). Split `deletePaymentWithAllocations` into `deletePaymentWithAllocationsInTx(tx, tenantId, paymentId)` (the current transaction body) plus the wrapper; in the `InTx` body, right after the existing `FOR UPDATE` on the charges and the `findMany` (which already selects `status`), add:

```ts
      // #52 R2: Zahlungen einer stornierten Sollstellung sind Historie — sonst bliebe sie storniert mit nicht erstattetem Geld.
      if (charges.some((c) => c.status === "CANCELLED")) {
        throw new PaymentError("Zahlung einer stornierten Sollstellung kann nicht gelöscht werden");
      }
```

Lock order stays the same as `recordPayment`: charges only (by id), never the assessment — no cycle with the lifecycle primitives (assessment → charge). `recordPayment` keeps its signature; server actions and API that catch `PaymentError` must also map `QuotaError("USE_REFUND_AND_CANCEL")` to a user message (Task 7 adds the message; here make `createPayment` / `apiCreate` payment branch treat `QuotaError` like `PaymentError`).

- [ ] **Step 4: Run it.** `T "npx vitest run src/lib/payments.test.ts src/lib/payment-writers.test.ts"` — Expected: PASS.

- [ ] **Step 5: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "feat(#52): recordPaymentInTx; a zeroing refund only via refund-and-cancel"` then `git push -u origin feat/52-release2`.

---

### Task 4: Issuance — `issueQuotasInTx`, `issueQuotas`, `issueQuotasRange`

**Files:**
- Create: `src/lib/quotas/tx.ts`, `src/lib/quotas/issue.ts`, `src/lib/quotas/input.ts`, `src/lib/quotas/concurrency-test-utils.ts` (code in "Test commands")
- Test: `src/lib/quotas/issue.test.ts`, `src/lib/quotas/input.test.ts`, `src/lib/quotas/concurrency-test-utils.test.ts`

**Interfaces:**
- Consumes: Task 2 (`computeLines`, `monthlyFromAnnual`, `resolveHolders`, `allocateCents`, `requestKey`, `QuotaError`), Task 1 fixture.
- Produces:
  - `withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T>` (retries Prisma/PG errors with code `40001`/`40P01` or `P2034`; after the last attempt throws `QuotaError("RETRY_EXHAUSTED")`).
  - `planLockSql(tenantId, propertyId, year)` helper that runs `SELECT pg_advisory_xact_lock_shared(plan_lock_key($1,$2,$3))`.
  - `type IssueInput = { propertyId: string; kind: "ORDINARY" | "EXTRAORDINARY"; month: string; method?: "PERMILLAGE" | "FIXED" | "CUSTOM"; custom?: Record<string, number>; dueDay?: number; totalCents?: number; asOf?: Date; dueDate?: Date; description?: string; resolutionId?: string }`
  - `type IssueResult = { assessmentId: string; created: boolean; lines: number; charges: number }`
  - `issueQuotasInTx(tx, ctx: { tenantId: string; userId: string; userName: string | null }, input: IssueInput): Promise<IssueResult>`
  - `issueQuotas(ctx, input, db?): Promise<IssueResult>` — `withRetry(() => db.$transaction((tx) => issueQuotasInTx(tx, ctx, input), { isolationLevel: RepeatableRead }))`
  - `input.ts`: `issueInputSchema` (Zod, discriminated union on `kind`), `parseOrThrow<T>(schema, value): T` (Zod failure → `QuotaError("INVALID_INPUT", undefined, issues)`); later tasks add `statementQuerySchema` and `reasonSchema` here.
  - `issueQuotasRange(ctx, input & { from: string; to: string }, db?): Promise<{ month: string; result?: IssueResult; error?: { code: string; details?: unknown } }[]>` — max 12 months (`INVALID_INPUT` otherwise); each month separately.

- [ ] **Step 1: Write the failing tests** — `src/lib/quotas/issue.test.ts` (use `wegFixture`; `ctx = { tenantId, userId: "u", userName: "Teste" }`):

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createTestTenant, describeDb, integrationDb as db } from "../test-db";
import { wegFixture } from "./fixtures";
import { Prisma } from "@prisma/client";
import { issueQuotas, issueQuotasInTx, issueQuotasRange } from "./issue";
import { clientFor, deferred, isPending, waitUntilBlocked } from "./concurrency-test-utils";
import { withRetry } from "./tx";

let t: Awaited<ReturnType<typeof createTestTenant>>;
let fx: Awaited<ReturnType<typeof wegFixture>>;
const ctx = () => ({ tenantId: t.tenantId, userId: "u", userName: "Teste" });

describeDb("Emissão de quotas (#52 R2)", () => {
  beforeEach(async () => { t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId, { meas: [400, 600], annual: 1200 }); });
  afterEach(() => t.cleanup());

  it("ordinária: linhas por mea, snapshots, charges HAUSGELD; Σ exacto; vencimento dia 8", async () => {
    const r = await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!);
    expect(r).toMatchObject({ created: true, lines: 2, charges: 2 });
    const charges = await db!.charge.findMany({ where: { tenantId: t.tenantId }, orderBy: { amount: "asc" } });
    expect(charges.map((c) => Number(c.amount))).toEqual([40, 60]);
    expect(charges.every((c) => c.type === "HAUSGELD" && c.dueDate.toISOString() === "2026-05-08T00:00:00.000Z")).toBe(true);
    const a = await db!.condominiumAssessment.findFirstOrThrow({ where: { id: r.assessmentId } });
    expect(a.totalCents).toBe(10000);
  });

  it("idempotente com o mesmo pedido; pedido diferente → ALREADY_ISSUED_CONFLICT", async () => {
    const input = { propertyId: fx.property.id, kind: "ORDINARY" as const, month: "2026-05" };
    const a = await issueQuotas(ctx(), input, db!);
    await expect(issueQuotas(ctx(), input, db!)).resolves.toMatchObject({ assessmentId: a.assessmentId, created: false });
    await expect(issueQuotas(ctx(), { ...input, dueDay: 9 }, db!)).rejects.toMatchObject({ code: "ALREADY_ISSUED_CONFLICT" });
    expect(await db!.charge.count({ where: { tenantId: t.tenantId } })).toBe(2);
  });

  it("em paralelo: um só assessment", async () => {
    const input = { propertyId: fx.property.id, kind: "ORDINARY" as const, month: "2026-06" };
    const r = await Promise.all([issueQuotas(ctx(), input, db!), issueQuotas(ctx(), input, db!)]);
    expect(new Set(r.map((x) => x.assessmentId)).size).toBe(1);
    expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(1);
  });

  it("sem plano → PLAN_MISSING; mea inválido → MEA_INVALID e nada escrito", async () => {
    await expect(issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2027-01" }, db!)).rejects.toMatchObject({ code: "PLAN_MISSING" });
    await db!.unit.update({ where: { id: fx.units[0].id }, data: { mea: null } });
    await expect(issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!)).rejects.toMatchObject({ code: "MEA_INVALID" });
    expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("copropriedade 500/500: dois snapshots de 2000, duas charges", async () => {
    const u1 = fx.units[0];
    await db!.owner.deleteMany({ where: { unitId: u1.id } });
    const [a, b] = await Promise.all(["A", "B"].map((n) => db!.person.create({ data: { tenantId: t.tenantId, firstName: n, lastName: "X" } })));
    const vf = new Date(Date.UTC(2020, 0, 1));
    for (const p of [a, b]) await db!.owner.create({ data: { tenantId: t.tenantId, unitId: u1.id, personId: p.id, share: 500, vigencia: "CONFIRMED", validFrom: vf } });
    await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!);
    const snaps = await db!.quotaDebtorSnapshot.findMany({ where: { tenantId: t.tenantId, line: { unitId: u1.id } }, orderBy: { personId: "asc" } });
    expect(snaps.map((x) => [x.shareSnapshot, x.amountCents])).toEqual([[500, 2000], [500, 2000]]);
  });

  it("copropriedade 333/333/334; soma ≠ 1000 → HOLDERS_INVALID, tudo-ou-nada", async () => {
    const [u1] = fx.units;
    await db!.owner.deleteMany({ where: { unitId: u1.id } });
    const people = await Promise.all([1, 2, 3].map((i) => db!.person.create({ data: { tenantId: t.tenantId, firstName: `C${i}`, lastName: "X" } })));
    const vf = new Date(Date.UTC(2020, 0, 1));
    for (const [i, s] of [333, 333, 334].entries()) await db!.owner.create({ data: { tenantId: t.tenantId, unitId: u1.id, personId: people[i].id, share: s, vigencia: "CONFIRMED", validFrom: vf } });
    const r = await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!);
    const snaps = await db!.quotaDebtorSnapshot.findMany({ where: { tenantId: t.tenantId, line: { unitId: u1.id } } });
    expect(snaps.reduce((s, x) => s + x.amountCents, 0)).toBe(4000);
    expect(r.charges).toBe(4);
    await db!.owner.updateMany({ where: { unitId: u1.id, personId: people[2].id }, data: { share: 300 } });
    await expect(issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-06" }, db!)).rejects.toMatchObject({ code: "HOLDERS_INVALID" });
  });

  it("troca de proprietário após emissão não altera o devedor emitido", async () => {
    await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!);
    const before = await db!.quotaDebtorSnapshot.findMany({ where: { tenantId: t.tenantId }, select: { personId: true } });
    await db!.owner.updateMany({ where: { unitId: fx.units[0].id }, data: { validTo: new Date(Date.UTC(2026, 4, 15)) } });
    const after = await db!.quotaDebtorSnapshot.findMany({ where: { tenantId: t.tenantId }, select: { personId: true } });
    expect(after).toEqual(before);
  });

  it("extraordinária com totalCents, asOf e deliberação do mesmo imóvel", async () => {
    const res = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: fx.property.id, number: 1, title: "Obras", text: "x", date: new Date() } });
    const r = await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "EXTRAORDINARY", month: "2026-07", totalCents: 50000, asOf: new Date(Date.UTC(2026, 6, 1)), dueDate: new Date(Date.UTC(2026, 6, 31)), description: "Obras", resolutionId: res.id }, db!);
    expect(r.charges).toBe(2);
  });

  it("lote: no máximo 12 meses, resultado por mês", async () => {
    const base = { propertyId: fx.property.id, kind: "ORDINARY" as const };
    await expect(issueQuotasRange(ctx(), { ...base, month: "2026-01", from: "2026-01", to: "2027-01" }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const r = await issueQuotasRange(ctx(), { ...base, month: "2026-01", from: "2026-01", to: "2026-12" }, db!);
    expect(r).toHaveLength(12);
    const sums = await db!.condominiumAssessment.findMany({ where: { tenantId: t.tenantId }, select: { totalCents: true } });
    expect(sums.reduce((s, a) => s + a.totalCents, 0)).toBe(120000);
  });

  it("deliberação de outra tenant ou de outro imóvel → INVALID_INPUT, nada escrito", async () => {
    const other = await createTestTenant();
    try {
      const otherProp = await db!.property.create({ data: { tenantId: other.tenantId, name: "X", street: "S", zip: "1", city: "L", management: "WEG" } });
      const foreign = await db!.resolution.create({ data: { tenantId: other.tenantId, propertyId: otherProp.id, number: 1, title: "x", text: "x", date: new Date() } });
      const sibling = await db!.property.create({ data: { tenantId: t.tenantId, name: "Y", street: "S", zip: "1", city: "L", management: "WEG" } });
      const wrongProp = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: sibling.id, number: 1, title: "x", text: "x", date: new Date() } });
      const asOf = new Date(Date.UTC(2026, 6, 1));
      for (const resolutionId of [foreign.id, wrongProp.id]) {
        await expect(issueQuotas(ctx(), { propertyId: fx.property.id, kind: "EXTRAORDINARY", month: "2026-07", totalCents: 1000, asOf, dueDate: asOf, description: "Obras", resolutionId }, db!))
          .rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
      expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
    } finally { await other.cleanup(); }
  });

  it("isolamento: lote (issueQuotasRange) de outra tenant → NOT_FOUND em cada mês, nada escrito", async () => {
    const other = await createTestTenant();
    try {
      const r = await issueQuotasRange({ ...ctx(), tenantId: other.tenantId }, { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-01", from: "2026-01", to: "2026-03" }, db!);
      expect(r.map((m) => m.error?.code)).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
      expect(await db!.condominiumAssessment.count()).toBe(await db!.condominiumAssessment.count({ where: { tenantId: { not: other.tenantId } } }));
    } finally { await other.cleanup(); }
  });

  it("isolamento: imóvel de outra tenant → NOT_FOUND, nada escrito", async () => {
    const other = await createTestTenant();
    try {
      await expect(issueQuotas({ ...ctx(), tenantId: other.tenantId }, { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { await other.cleanup(); }
  });
});

describeDb("Titularidade no asOf, em PostgreSQL (#52 R2)", () => {
  // Tenant de teste: ownerValidityCutoverAt = momento da criação (default da migração R1).
  beforeEach(async () => { t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(() => t.cleanup());
  const unknownOnly = async () => {
    await db!.owner.deleteMany({ where: { unitId: fx.units[0].id } });
    await db!.owner.create({ data: { tenantId: t.tenantId, unitId: fx.units[0].id, personId: fx.persons[0].id, share: 1000, vigencia: "UNKNOWN" } });
  };
  const extra = (asOf: Date) => ({ propertyId: fx.property.id, kind: "EXTRAORDINARY" as const, month: `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`, totalCents: 1000, asOf, dueDate: asOf, description: "x" });

  it("UNKNOWN antes do cutover → HOLDERS_INVALID", async () => {
    await unknownOnly();
    await expect(issueQuotas(ctx(), extra(new Date(Date.UTC(2020, 5, 1))), db!)).rejects.toMatchObject({ code: "HOLDERS_INVALID" });
  });
  it("UNKNOWN depois do cutover → devedor registado no snapshot", async () => {
    await unknownOnly();
    const asOf = new Date(Date.now() + 86400000);
    await issueQuotas(ctx(), extra(asOf), db!);
    const snap = await db!.quotaDebtorSnapshot.findFirstOrThrow({ where: { tenantId: t.tenantId, line: { unitId: fx.units[0].id } } });
    expect(snap.personId).toBe(fx.persons[0].id);
  });
  it("CONFIRMED que cobre o asOf tem precedência sobre UNKNOWN", async () => {
    const other = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "U", lastName: "X" } });
    await db!.owner.create({ data: { tenantId: t.tenantId, unitId: fx.units[0].id, personId: other.id, share: 1000, vigencia: "UNKNOWN" } });
    await issueQuotas(ctx(), extra(new Date(Date.now() + 86400000)), db!);
    const snaps = await db!.quotaDebtorSnapshot.findMany({ where: { tenantId: t.tenantId, line: { unitId: fx.units[0].id } } });
    expect(snaps.map((x) => x.personId)).toEqual([fx.persons[0].id]);
  });
  it("validTo é exclusivo: no próprio instante vale o novo proprietário", async () => {
    const cut = new Date(Date.UTC(2026, 4, 1));
    await db!.owner.updateMany({ where: { unitId: fx.units[0].id }, data: { validTo: cut } });
    const buyer = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "B", lastName: "X" } });
    await db!.owner.create({ data: { tenantId: t.tenantId, unitId: fx.units[0].id, personId: buyer.id, share: 1000, vigencia: "CONFIRMED", validFrom: cut } });
    await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!); // asOf = 2026-05-01T00:00Z
    const snap = await db!.quotaDebtorSnapshot.findFirstOrThrow({ where: { tenantId: t.tenantId, line: { unitId: fx.units[0].id } } });
    expect(snap.personId).toBe(buyer.id);
  });
});

describeDb("Entrada inválida nunca vira outra operação (#52 R2)", () => {
  beforeEach(async () => { t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(() => t.cleanup());
  const bad: [string, Record<string, unknown>][] = [
    ["kind desconhecido", { kind: "ORDNARY", month: "2026-05" }],
    ["method desconhecido", { kind: "ORDINARY", month: "2026-05", method: "EQUAL" }],
    ["mês 13", { kind: "ORDINARY", month: "2026-13" }],
    ["dueDay não numérico", { kind: "ORDINARY", month: "2026-05", dueDay: "abc" }],
    ["dueDay 29", { kind: "ORDINARY", month: "2026-05", dueDay: 29 }],
    ["ordinária com totalCents", { kind: "ORDINARY", month: "2026-05", totalCents: 1000 }],
    ["ordinária com description", { kind: "ORDINARY", month: "2026-05", description: "x" }],
    ["ordinária com resolutionId", { kind: "ORDINARY", month: "2026-05", resolutionId: "r" }],
    ["extraordinária sem asOf", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 1000, dueDate: new Date(), description: "x" }],
    ["totalCents fraccionário", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 10.5, asOf: new Date(), dueDate: new Date(), description: "x" }],
    ["totalCents 0", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 0, asOf: new Date(), dueDate: new Date(), description: "x" }],
    ["data inválida", { kind: "EXTRAORDINARY", month: "2026-05", totalCents: 1000, asOf: new Date("x"), dueDate: new Date(), description: "x" }],
    ["CUSTOM sem mapa", { kind: "ORDINARY", month: "2026-05", method: "CUSTOM" }],
  ];
  for (const [label, input] of bad) {
    it(`${label} → INVALID_INPUT, nada escrito`, async () => {
      await expect(issueQuotas(ctx(), { propertyId: fx.property.id, ...input } as never, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
    });
  }
});

describeDb("Emissão × plano em concorrência, com gates (#52 R2)", () => {
  let dbA: PrismaClient, dbB: PrismaClient, dbC: PrismaClient;
  beforeEach(async () => {
    dbA = clientFor("r2_a"); dbB = clientFor("r2_b"); dbC = clientFor("r2_c");
    t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId);
  });
  afterEach(async () => { await t.cleanup(); await Promise.all([dbA.$disconnect(), dbB.$disconnect(), dbC.$disconnect()]); });
  const may = () => ({ propertyId: fx.property.id, kind: "ORDINARY" as const, month: "2026-05" });

  it("plano alterado primeiro (lock tomado, retido) → emissão fica bloqueada → depois usa o plano novo", async () => {
    const gate = deferred(); const locked = deferred();
    const edit = dbA.$transaction(async (tx) => {
      await tx.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } }); // trigger: advisory exclusivo
      locked.resolve(); await gate.promise;
    }, { timeout: 20000 });
    await locked.promise;
    const issuing = issueQuotas(ctx(), may(), dbB);
    await waitUntilBlocked(db!, "r2_b");
    expect(await isPending(issuing)).toBe(true);
    gate.resolve(); await edit;
    const r = await issuing;
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: r.assessmentId } })).totalCents).toBe(20000);
  }, 30000);

  it("emissão primeiro (lock partilhado tomado, retida) → alteração fica bloqueada → depois é recusada", async () => {
    const gate = deferred(); const locked = deferred();
    const issuing = dbA.$transaction(async (tx) => {
      const r = await issueQuotasInTx(tx, ctx(), may());
      locked.resolve(); await gate.promise; return r;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
    await locked.promise;
    const edit = dbB.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } });
    await waitUntilBlocked(db!, "r2_b");
    expect(await isPending(edit)).toBe(true);
    gate.resolve(); await issuing;
    await expect(edit).rejects.toThrow(/plan locked by issued ordinary assessments/);
    expect(Number((await db!.economicPlan.findUniqueOrThrow({ where: { id: fx.plan.id } })).totalAmount)).toBe(1200);
  }, 30000);

  it("edição do plano à espera do advisory (detido por outra emissão) × emissão ordinária → sem deadlock; emissão usa o plano novo", async () => {
    // C detém o advisory partilhado (como uma emissão extraordinária em curso). B altera o plano: tem a linha e espera o advisory exclusivo.
    // A emite a ordinária: tem de esperar a linha (FOR SHARE) ANTES de pedir o advisory — na ordem inversa formaria um ciclo com B.
    const gate = deferred(); const locked = deferred();
    const holder = dbC.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(plan_lock_key(${t.tenantId}, ${fx.property.id}, 2026))`;
      locked.resolve(); await gate.promise;
    }, { timeout: 20000 });
    await locked.promise;
    const edit = dbB.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } });
    await waitUntilBlocked(db!, "r2_issue_b");
    const issuing = issueQuotas(ctx(), may(), dbA);
    await waitUntilBlocked(db!, "r2_issue_a");
    gate.resolve(); await holder;
    await edit;
    const r = await issuing; // 40001 → Retry → neuer Plan; nie 40P01
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: r.assessmentId } })).totalCents).toBe(20000);
  }, 30000);

  it("movimentos opostos de plano (ano/imóvel) nunca terminam em deadlock", async () => {
    // Plano X: (P, 2026) → (P, 2027); plano Y: (P, 2027) → (P, 2026). Um terceiro detém ambas as chaves,
    // os dois ficam à espera no trigger; ao libertar, a ordem ascendente das chaves impede o ciclo.
    const y = await db!.economicPlan.create({ data: { tenantId: t.tenantId, propertyId: fx.property.id, year: 2027, totalAmount: 1200 } });
    const gate = deferred(); const locked = deferred();
    const holder = dbC.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(plan_lock_key(${t.tenantId}, ${fx.property.id}, 2026)), pg_advisory_xact_lock(plan_lock_key(${t.tenantId}, ${fx.property.id}, 2027))`;
      locked.resolve(); await gate.promise;
    }, { timeout: 20000 });
    await locked.promise;
    const moveX = dbA.economicPlan.update({ where: { id: fx.plan.id }, data: { year: 2027 } });
    const moveY = dbB.economicPlan.update({ where: { id: y.id }, data: { year: 2026 } });
    await waitUntilBlocked(db!, "r2_a"); await waitUntilBlocked(db!, "r2_b");
    gate.resolve(); await holder;
    const results = await Promise.allSettled([moveX, moveY]);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).not.toMatch(/deadlock|40P01/i);
  }, 30000);

  it("Owner e mea alterados depois do snapshot da emissão: resultado coerente (tudo antigo, ou 40001 → retry → tudo novo)", async () => {
    // A fixa o snapshot RR e pára; B muda mea (400/600 → 500/500) e o titular de F1 numa só transacção e faz commit;
    // A continua. Nunca pode sair uma mistura (mea novo com titular antigo ou vice-versa).
    const buyer = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "Comprador", lastName: "X" } });
    const gate = deferred(); const snapped = deferred(); let attempts = 0;
    const issuing = withRetry(() => dbA.$transaction(async (tx) => {
      attempts++;
      await tx.$queryRaw`SELECT 1`; // erste Anweisung fixiert den RR-Snapshot
      if (attempts === 1) { snapped.resolve(); await gate.promise; }
      return issueQuotasInTx(tx, ctx(), may());
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 }));
    await snapped.promise;
    const cut = new Date(Date.UTC(2026, 3, 1));
    await dbB.$transaction([
      dbB.unit.update({ where: { id: fx.units[0].id }, data: { mea: 500 } }),
      dbB.unit.update({ where: { id: fx.units[1].id }, data: { mea: 500 } }),
      dbB.owner.updateMany({ where: { unitId: fx.units[0].id }, data: { validTo: cut } }),
      dbB.owner.create({ data: { tenantId: t.tenantId, unitId: fx.units[0].id, personId: buyer.id, share: 1000, vigencia: "CONFIRMED", validFrom: cut } }),
    ]);
    gate.resolve();
    const r = await issuing;
    const line = await db!.condominiumAssessmentLine.findFirstOrThrow({ where: { assessmentId: r.assessmentId, unitId: fx.units[0].id }, include: { snapshots: true } });
    const allOld = line.amountCents === 4000 && line.snapshots[0].personId === fx.persons[0].id;
    const allNew = line.amountCents === 5000 && line.snapshots[0].personId === buyer.id;
    expect(allOld || allNew).toBe(true);
    if (allNew) expect(attempts).toBeGreaterThan(1); // nur über 40001 + Retry
  }, 30000);

  it("deliberação movida primeiro (retida) → emissão bloqueia → 40001/retry → INVALID_INPUT, nada escrito", async () => {
    const res = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: fx.property.id, number: 1, title: "Obras", text: "x", date: new Date() } });
    const sibling = await db!.property.create({ data: { tenantId: t.tenantId, name: "Outro", street: "S", zip: "1", city: "L", management: "WEG" } });
    const gate = deferred(); const locked = deferred();
    const move = dbA.$transaction(async (tx) => {
      await tx.resolution.update({ where: { id: res.id }, data: { propertyId: sibling.id } });
      locked.resolve(); await gate.promise;
    }, { timeout: 20000 });
    await locked.promise;
    const asOf = new Date(Date.UTC(2026, 6, 1));
    const issuing = issueQuotas(ctx(), { propertyId: fx.property.id, kind: "EXTRAORDINARY", month: "2026-07", totalCents: 50000, asOf, dueDate: asOf, description: "Obras", resolutionId: res.id }, dbB);
    await waitUntilBlocked(db!, "r2_b");
    expect(await isPending(issuing)).toBe(true);
    gate.resolve(); await move;
    await expect(issuing).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  }, 30000);

  it("emissão com deliberação primeiro (retida) → mover a deliberação bloqueia → depois é recusado", async () => {
    const res = await db!.resolution.create({ data: { tenantId: t.tenantId, propertyId: fx.property.id, number: 1, title: "Obras", text: "x", date: new Date() } });
    const sibling = await db!.property.create({ data: { tenantId: t.tenantId, name: "Outro", street: "S", zip: "1", city: "L", management: "WEG" } });
    const asOf = new Date(Date.UTC(2026, 6, 1));
    const gate = deferred(); const locked = deferred();
    const issuing = dbA.$transaction(async (tx) => {
      const r = await issueQuotasInTx(tx, ctx(), { propertyId: fx.property.id, kind: "EXTRAORDINARY", month: "2026-07", totalCents: 50000, asOf, dueDate: asOf, description: "Obras", resolutionId: res.id });
      locked.resolve(); await gate.promise; return r;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
    await locked.promise;
    const move = dbB.resolution.update({ where: { id: res.id }, data: { propertyId: sibling.id } });
    await waitUntilBlocked(db!, "r2_b");
    expect(await isPending(move)).toBe(true);
    gate.resolve(); await issuing;
    await expect(move).rejects.toThrow(/assessment resolution not in assessment property/);
    expect((await db!.resolution.findUniqueOrThrow({ where: { id: res.id } })).propertyId).toBe(fx.property.id);
  }, 30000);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (module not found).

- [ ] **Step 3a: Implement `src/lib/quotas/input.ts`** (Zod 4 is already a dependency; see `src/lib/schemas.ts` for house style):

```ts
// #52 R2: strikte Eingabe-Schemas — nichts wird still in eine andere Finanzoperation umgedeutet.
import { z } from "zod";
import { QuotaError } from "./errors";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const date = z.date().refine((d) => !Number.isNaN(d.getTime()), "invalid date");
const cents = z.number().int().positive();
const id = z.string().min(1);
const method = z.enum(["PERMILLAGE", "FIXED", "CUSTOM"]);
const custom = z.record(z.string().min(1), z.number().int().nonnegative());

// Nur Felder, die beide Arten haben; description/resolutionId sind der extraordinária vorbehalten.
const common = { propertyId: id, month, method: method.default("PERMILLAGE"), custom: custom.optional() };
const withCustomRule = <T extends { method: string; custom?: unknown }>(v: T, ctx: z.RefinementCtx) => {
  if ((v.method === "CUSTOM") !== (v.custom !== undefined)) ctx.addIssue({ code: "custom", message: "custom map iff method CUSTOM" });
};

export const issueInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ORDINARY"), ...common, dueDay: z.number().int().min(1).max(28).optional() }),
  z.strictObject({ kind: z.literal("EXTRAORDINARY"), ...common, totalCents: cents, asOf: date, dueDate: date,
    description: z.string().trim().min(1).max(500), resolutionId: id.optional() }),
]).superRefine(withCustomRule);
export type ParsedIssueInput = z.infer<typeof issueInputSchema>;

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new QuotaError("INVALID_INPUT", undefined, r.error.issues);
  return r.data;
}
```

`src/lib/quotas/input.test.ts` asserts the same thirteen bad inputs as the DB block above fail `issueInputSchema`, and that a minimal valid ORDINARY and EXTRAORDINARY input parse (method defaulted to `PERMILLAGE`). `issueQuotasInTx` starts with `const input = parseOrThrow(issueInputSchema, raw);` and uses only the parsed value (so `issueQuotasRange` re-validates each month). The server action (Task 7) coerces `FormData` strings to numbers/dates with `z.coerce` wrappers built from the same field definitions, then calls the service — the service validates again.

- [ ] **Step 3b: Implement `src/lib/quotas/tx.ts`**:

```ts
// #52 R2: Transaktions-Helfer — Retry bei Serialisierungs-/Deadlock-Fehlern, Plan-Sperre.
import { Prisma } from "@prisma/client";
import { QuotaError } from "./errors";

const RETRYABLE = new Set(["40001", "40P01", "P2034"]);
function isRetryable(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE.has(e.code)) return true;
    const meta = (e.meta ?? {}) as { code?: string };
    return meta.code !== undefined && RETRYABLE.has(meta.code);
  }
  const msg = String((e as { message?: string })?.message ?? "");
  return /40001|40P01|could not serialize|deadlock detected/.test(msg);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e)) throw e;
      if (i >= attempts) throw new QuotaError("RETRY_EXHAUSTED");
      await new Promise((r) => setTimeout(r, 20 * i + Math.floor(Math.random() * 20)));
    }
  }
}

export async function lockPlanShared(tx: Prisma.TransactionClient, tenantId: string, propertyId: string, year: number) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(plan_lock_key(${tenantId}, ${propertyId}, ${year}::int))`;
}
```

- [ ] **Step 4: Implement `src/lib/quotas/issue.ts`** (algorithm; keep each step as written):

```ts
// #52 R2: Emission von Quoten — ein Snapshot (REPEATABLE READ), Plan-Sperre, Idempotenz über requestKey.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allocateCents, computeLines, monthlyFromAnnual, requestKey, resolveHolders } from "./compute";
import { QuotaError } from "./errors";
import { issueInputSchema, parseOrThrow } from "./input";
import { lockPlanShared, withRetry } from "./tx";

export type IssueInput = {
  propertyId: string; kind: "ORDINARY" | "EXTRAORDINARY"; month: string;
  method?: "PERMILLAGE" | "FIXED" | "CUSTOM"; custom?: Record<string, number>; dueDay?: number;
  totalCents?: number; asOf?: Date; dueDate?: Date; description?: string; resolutionId?: string;
};
export type IssueResult = { assessmentId: string; created: boolean; lines: number; charges: number };
type Ctx = { tenantId: string; userId: string; userName: string | null };

function parseMonth(month: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new QuotaError("INVALID_INPUT", "month");
  return { year: Number(m[1]), month: Number(m[2]), period: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) };
}

export async function issueQuotasInTx(tx: Prisma.TransactionClient, ctx: Ctx, raw: IssueInput): Promise<IssueResult> {
  const input = parseOrThrow(issueInputSchema, raw);
  const { year, month, period } = parseMonth(input.month);
  const method = input.method;
  const description = input.kind === "EXTRAORDINARY" ? input.description : null;
  const resolutionId = input.kind === "EXTRAORDINARY" ? input.resolutionId ?? null : null;
  const property = await tx.property.findFirst({ where: { id: input.propertyId, tenantId: ctx.tenantId }, select: { id: true, management: true, meaTotal: true } });
  if (!property) throw new QuotaError("NOT_FOUND", "property");
  if (property.management !== "WEG") throw new QuotaError("INVALID_INPUT", "property is not a condominium");

  let totalCents: number, asOf: Date, dueDate: Date, annualCents: number | undefined;
  if (input.kind === "ORDINARY") {
    // Reihenfolge wie eine Planänderung: erst die Planzeile (FOR SHARE; nach dem Snapshot geändert → 40001 → Retry),
    // dann der Advisory-Lock. Umgekehrt entstünde ein Deadlock mit dem Trigger (Zeilensperre → Advisory).
    const plans = await tx.$queryRaw<{ totalAmount: Prisma.Decimal }[]>`
      SELECT "totalAmount" FROM "EconomicPlan" WHERE "tenantId" = ${ctx.tenantId} AND "propertyId" = ${property.id} AND year = ${year} FOR SHARE`;
    if (plans.length === 0) throw new QuotaError("PLAN_MISSING");
    await lockPlanShared(tx, ctx.tenantId, property.id, year);
    annualCents = Math.round(Number(plans[0].totalAmount) * 100);
    totalCents = monthlyFromAnnual(annualCents, month);
    asOf = period;
    const dueDay = input.dueDay ?? 8;
    dueDate = new Date(Date.UTC(year, month - 1, dueDay));
  } else {
    await lockPlanShared(tx, ctx.tenantId, property.id, year);
    totalCents = input.totalCents; asOf = input.asOf; dueDate = input.dueDate; // durch das Schema garantiert
  }

  if (resolutionId) {
    // Deliberação desta tenant e deste imóvel; FOR SHARE: eine gleichzeitige Verschiebung wartet bzw. führt zu 40001 → Retry.
    const res = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Resolution" WHERE id = ${resolutionId} AND "tenantId" = ${ctx.tenantId} AND "propertyId" = ${property.id} FOR SHARE`;
    if (res.length === 0) throw new QuotaError("INVALID_INPUT", "resolution");
  }

  const key = requestKey({ kind: input.kind, period, method, dueDate, asOf, totalCents, custom: input.custom, resolutionId: resolutionId, description: description });

  // Idempotenz: nur über den Teilindex; bestehende Emission unter Sperre vergleichen.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "CondominiumAssessment" (id, "tenantId", "propertyId", period, kind, method, "dueDate", "asOf", "totalCents", "requestKey", description, "resolutionId")
    VALUES (gen_random_uuid()::text, ${ctx.tenantId}, ${property.id}, ${period}, ${input.kind}::"QuotaKind", ${method}::"AssessmentMethod", ${dueDate}, ${asOf}, ${totalCents}, ${key}, ${description}, ${resolutionId})
    ON CONFLICT ("tenantId", "propertyId", period, kind) WHERE status = 'ISSUED' DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) {
    const existing = await tx.$queryRaw<{ id: string; requestKey: string }[]>`
      SELECT id, "requestKey" FROM "CondominiumAssessment"
      WHERE "tenantId" = ${ctx.tenantId} AND "propertyId" = ${property.id} AND period = ${period} AND kind = ${input.kind}::"QuotaKind" AND status = 'ISSUED' FOR UPDATE`;
    if (existing.length === 0) throw new QuotaError("RETRY_EXHAUSTED", "conflict row vanished"); // gleichzeitig storniert → Aufrufer wiederholt
    if (existing[0].requestKey !== key) throw new QuotaError("ALREADY_ISSUED_CONFLICT");
    return { assessmentId: existing[0].id, created: false, lines: 0, charges: 0 };
  }
  const assessmentId = inserted[0].id;
  await tx.$queryRaw`SELECT id FROM "CondominiumAssessment" WHERE id = ${assessmentId} FOR UPDATE`;

  const [units, owners, tenant] = await Promise.all([
    tx.unit.findMany({ where: { tenantId: ctx.tenantId, building: { propertyId: property.id } }, select: { id: true, mea: true } }),
    tx.owner.findMany({ where: { tenantId: ctx.tenantId, unit: { building: { propertyId: property.id } } }, select: { unitId: true, personId: true, share: true, vigencia: true, validFrom: true, validTo: true } }),
    tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { ownerValidityCutoverAt: true } }),
  ]);
  const lines = computeLines({ totalCents, method, units, meaTotal: property.meaTotal, custom: input.custom, annualCents: method === "FIXED" && input.kind === "ORDINARY" ? annualCents : undefined });

  const failures: { unitId: string; reason: string }[] = [];
  const holdersByUnit = new Map<string, { personId: string; share: number }[]>();
  for (const l of lines) {
    const h = resolveHolders(owners.filter((o) => o.unitId === l.unitId), asOf, tenant.ownerValidityCutoverAt);
    if ("error" in h) failures.push({ unitId: l.unitId, reason: h.error });
    else holdersByUnit.set(l.unitId, h);
  }
  if (failures.length > 0) throw new QuotaError("HOLDERS_INVALID", undefined, failures); // Rollback: nichts geschrieben

  let charges = 0;
  for (const l of lines) {
    const line = await tx.condominiumAssessmentLine.create({ data: { tenantId: ctx.tenantId, assessmentId, unitId: l.unitId, amountCents: l.amountCents } });
    if (l.amountCents === 0) continue;
    const holders = holdersByUnit.get(l.unitId)!;
    const parts = allocateCents(l.amountCents, holders.map((h) => ({ id: h.personId, weight: h.share })));
    for (const p of parts) {
      const share = holders.find((h) => h.personId === p.id)!.share;
      const snap = await tx.quotaDebtorSnapshot.create({ data: { tenantId: ctx.tenantId, lineId: line.id, personId: p.id, shareSnapshot: share, amountCents: p.amountCents } });
      if (p.amountCents === 0) continue;
      await tx.charge.create({ data: { tenantId: ctx.tenantId, quotaDebtorSnapshotId: snap.id, type: "HAUSGELD", period, dueDate, amount: p.amountCents / 100, description: description } });
      charges++;
    }
  }
  await tx.auditLog.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, userName: ctx.userName, action: "CREATE", entity: "CondominiumAssessment", entityId: assessmentId, summary: `${input.kind} ${input.month} ${method} ${totalCents}` } });
  return { assessmentId, created: true, lines: lines.length, charges };
}

export function issueQuotas(ctx: Ctx, input: IssueInput, db: PrismaClient = prisma) {
  return withRetry(() => db.$transaction((tx) => issueQuotasInTx(tx, ctx, input), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 }));
}

export async function issueQuotasRange(ctx: Ctx, input: IssueInput & { from: string; to: string }, db: PrismaClient = prisma) {
  const from = parseMonth(input.from); const to = parseMonth(input.to);
  const count = (to.year - from.year) * 12 + (to.month - from.month) + 1;
  if (count < 1 || count > 12) throw new QuotaError("INVALID_INPUT", "range 1–12 months");
  const out: { month: string; result?: IssueResult; error?: { code: string; details?: unknown } }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(from.year, from.month - 1 + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    try { out.push({ month, result: await issueQuotas(ctx, { ...input, month }, db) }); }
    catch (e) { if (e instanceof QuotaError) out.push({ month, error: { code: e.code, details: e.details } }); else throw e; }
  }
  return out;
}
```

Implementation notes:
- `computeLines` already enforces "all units": `units` is every unit of the property.
- Snapshots with 0 cents: the spec says a zero **line** has no snapshots or charges; a holder whose rounded share is 0 on a non-zero line still gets a snapshot (Σ snapshots = line) but no charge. Keep as coded.
- A charge row per snapshot with 0 cents is never created (`amount > 0` CHECK).
- If `P2002` occurs on any insert other than the assessment's `ON CONFLICT`, it propagates (never treated as success).

- [ ] **Step 5: Run it.** `T "npx vitest run src/lib/quotas/issue.test.ts src/lib/quotas/input.test.ts"` — Expected: PASS; run the gated block 5 times (`--repeat` via a loop) — every run must pass (no timing dependency).

- [ ] **Step 6: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "feat(#52): quota issuance — single snapshot, plan lock, idempotent request key, all-or-nothing"` then `git push -u origin feat/52-release2`.

---

### Task 5: Lifecycle — void, refund-and-cancel, cancel assessment, reissue, replace debtor

**Files:**
- Create: `src/lib/quotas/lifecycle.ts`
- Modify: `src/lib/quotas/tx.ts` (add `recomputeAssessmentStatusInTx`, `lockAssessment`, `lockChargesOrdered`)
- Test: `src/lib/quotas/lifecycle.test.ts`

**Interfaces:**
- Consumes: `MONEY_EPSILON`, `ALLOCATIONS_FOR_BALANCE`, `chargeBalance` (`src/lib/charges.ts`), `recordPaymentInTx` and `deletePaymentWithAllocations` (Task 3, tests only), `issueQuotas` (Task 4, to build test data), `QuotaError`, `withRetry`, `lockPlanShared`, `monthlyFromAnnual`.
- Produces (all `…InTx(tx, ctx, …)` plus a public wrapper `name(ctx, …, db?)` opening a `ReadCommitted` transaction):
  - `voidChargeInTx(tx, ctx, chargeId: string, reason: string): Promise<void>`
  - `refundAndCancelInTx(tx, ctx, chargeId: string, p: { accountId?: string | null; date: Date; reference?: string | null; reason: string }): Promise<{ paymentId: string | null }>`
  - `cancelAssessmentInTx(tx, ctx, assessmentId: string, reason: string): Promise<void>`
  - `reissueChargeInTx(tx, ctx, chargeId: string): Promise<{ chargeId: string }>`
  - `replaceDebtorInTx(tx, ctx, lineId: string, fromPersonId: string, toPersonId: string, reason: string): Promise<{ chargeId: string }>`
  - helpers in `tx.ts`: `lockAssessment(tx, tenantId, id)`, `lockChargesOrdered(tx, tenantId, ids: string[])`, `recomputeAssessmentStatusInTx(tx, tenantId, assessmentId)`.

- [ ] **Step 1: Write the failing tests** — `src/lib/quotas/lifecycle.test.ts` (build an issued ordinary month with `issueQuotas`, and a co-owned unit where needed):

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "../test-db";
import { wegFixture } from "./fixtures";
import { issueQuotas } from "./issue";
import { Prisma, type PrismaClient } from "@prisma/client";
import { cancelAssessment, cancelAssessmentInTx, refundAndCancel, refundAndCancelInTx, reissueCharge, replaceDebtor, voidCharge } from "./lifecycle";
import { deletePaymentWithAllocations, deletePaymentWithAllocationsInTx, PaymentError, recordPayment, recordPaymentInTx } from "../payments";
import { clientFor, deferred, isPending, waitUntilBlocked } from "./concurrency-test-utils";

let t: Awaited<ReturnType<typeof createTestTenant>>;
let fx: Awaited<ReturnType<typeof wegFixture>>;
const ctx = () => ({ tenantId: t.tenantId, userId: "u", userName: "Teste" });
async function issueMay() {
  const r = await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, db!);
  const charges = await db!.charge.findMany({ where: { tenantId: t.tenantId }, orderBy: { amount: "asc" } });
  return { assessmentId: r.assessmentId, charges };
}

describeDb("Ciclo de vida (#52 R2)", () => {
  beforeEach(async () => { t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(() => t.cleanup());

  it("voidCharge: sem pagamentos → CANCELLED com motivo e auditoria; com pagamentos → HAS_PAYMENTS", async () => {
    const { charges, assessmentId } = await issueMay();
    await voidCharge(ctx(), charges[0].id, "erro de emissão", db!);
    const c0 = await db!.charge.findUniqueOrThrow({ where: { id: charges[0].id } });
    expect(c0).toMatchObject({ status: "CANCELLED", cancelReason: "erro de emissão" });
    expect(c0.cancelledAt).not.toBeNull();
    expect(await db!.auditLog.count({ where: { tenantId: t.tenantId, entity: "Charge", entityId: charges[0].id } })).toBe(1);
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).status).toBe("ISSUED"); // uma charge ainda ISSUED
    await recordPayment({ tenantId: t.tenantId, chargeId: charges[1].id, date: new Date(), amount: 10, direction: "EINGANG" }, db!);
    await expect(voidCharge(ctx(), charges[1].id, "erro", db!)).rejects.toMatchObject({ code: "HAS_PAYMENTS" });
  });

  it("refundAndCancel: reembolsa o líquido e cancela atomicamente; falha injectada → nada escrito", async () => {
    const { charges } = await issueMay();
    await recordPayment({ tenantId: t.tenantId, chargeId: charges[1].id, date: new Date(), amount: 60, direction: "EINGANG" }, db!);
    const r = await refundAndCancel(ctx(), charges[1].id, { date: new Date(), reason: "venda anulada" }, db!);
    expect(r.paymentId).not.toBeNull();
    expect((await db!.charge.findUniqueOrThrow({ where: { id: charges[1].id } })).status).toBe("CANCELLED");
    // falha injectada: conta de outra tenant → PaymentError após criar nada
    const before = await db!.payment.count({ where: { tenantId: t.tenantId } });
    const other = await createTestTenant();
    try {
      const acc = await db!.account.create({ data: { tenantId: other.tenantId, name: "X" } });
      await recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: 40, direction: "EINGANG" }, db!);
      await expect(refundAndCancel(ctx(), charges[0].id, { accountId: acc.id, date: new Date(), reason: "erro" }, db!)).rejects.toThrow();
      expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(before + 1);
      expect((await db!.charge.findUniqueOrThrow({ where: { id: charges[0].id } })).status).toBe("ISSUED");
    } finally { await other.cleanup(); }
  });

  it("refundAndCancel com líquido 0 pré-existente: só cancela, sem Payment de valor zero", async () => {
    const { charges } = await issueMay();
    // estado pré-R2 simulado: entrada e saída iguais por SQL directo
    const p1 = await db!.payment.create({ data: { tenantId: t.tenantId, date: new Date(), amount: 10, direction: "EINGANG" } });
    const p2 = await db!.payment.create({ data: { tenantId: t.tenantId, date: new Date(), amount: 10, direction: "AUSGANG" } });
    await db!.paymentAllocation.createMany({ data: [{ tenantId: t.tenantId, paymentId: p1.id, chargeId: charges[0].id, amount: 10 }, { tenantId: t.tenantId, paymentId: p2.id, chargeId: charges[0].id, amount: 10 }] });
    const before = await db!.payment.count({ where: { tenantId: t.tenantId } });
    await expect(refundAndCancel(ctx(), charges[0].id, { date: new Date(), reason: "limpeza" }, db!)).resolves.toMatchObject({ paymentId: null });
    expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(before);
  });

  it("cancelAssessment: anula tudo; recusa com pagamentos; estado agregado CANCELLED", async () => {
    const { assessmentId, charges } = await issueMay();
    await cancelAssessment(ctx(), assessmentId, "plano errado", db!);
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).status).toBe("CANCELLED");
    expect(await db!.charge.count({ where: { tenantId: t.tenantId, status: "ISSUED" } })).toBe(0);
    const again = await issueMay(); // nova emissão possível depois de cancelar
    await recordPayment({ tenantId: t.tenantId, chargeId: again.charges.find((c) => c.status === "ISSUED")!.id, date: new Date(), amount: 1, direction: "EINGANG" }, db!);
    await expect(cancelAssessment(ctx(), again.assessmentId, "erro", db!)).rejects.toMatchObject({ code: "HAS_PAYMENTS" });
    void charges;
  });

  it("reissueCharge: repõe no mesmo snapshot; SNAPSHOT_SUPERSEDED após replaceDebtor; PLAN_CHANGED após alterar o plano; ALREADY_ISSUED_CONFLICT com substituto", async () => {
    const { assessmentId, charges } = await issueMay();
    await voidCharge(ctx(), charges[0].id, "erro", db!);
    await expect(reissueCharge(ctx(), charges[0].id, db!)).resolves.toBeTruthy();
    // replaceDebtor A→B e depois tentar reactivar A
    const snapA = await db!.quotaDebtorSnapshot.findFirstOrThrow({ where: { tenantId: t.tenantId, charges: { some: { id: charges[1].id } } } });
    const b = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "B", lastName: "X" } });
    await replaceDebtor(ctx(), snapA.lineId, snapA.personId, b.id, "devedor errado", db!);
    await expect(reissueCharge(ctx(), charges[1].id, db!)).rejects.toMatchObject({ code: "SNAPSHOT_SUPERSEDED" });
    // plano alterado depois de cancelar tudo
    await cancelAssessment(ctx(), assessmentId, "refazer", db!);
    await db!.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } });
    const anyCharge = await db!.charge.findFirstOrThrow({ where: { tenantId: t.tenantId, status: "CANCELLED", quotaDebtorSnapshot: { line: { assessmentId } } } });
    await expect(reissueCharge(ctx(), anyCharge.id, db!)).rejects.toMatchObject({ code: "PLAN_CHANGED" });
    // substituto emitido → conflito
    await db!.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 1200 } });
    await issueMay();
    await expect(reissueCharge(ctx(), anyCharge.id, db!)).rejects.toMatchObject({ code: "ALREADY_ISSUED_CONFLICT" });
  });

  it("replaceDebtor: troca atómica; toPersonId com snapshot anterior na linha → recusado", async () => {
    const { charges } = await issueMay();
    const snap = await db!.quotaDebtorSnapshot.findFirstOrThrow({ where: { tenantId: t.tenantId, charges: { some: { id: charges[0].id } } } });
    const b = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "B", lastName: "X" } });
    await replaceDebtor(ctx(), snap.lineId, snap.personId, b.id, "erro", db!);
    const active = await db!.charge.findMany({ where: { tenantId: t.tenantId, status: "ISSUED", quotaDebtorSnapshot: { lineId: snap.lineId } } });
    expect(active.reduce((s, c) => s + Number(c.amount), 0)).toBe(Number(charges[0].amount));
    await expect(replaceDebtor(ctx(), snap.lineId, b.id, snap.personId, "volta", db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("isolamento: todas as operações com ids de outra tenant → NOT_FOUND, nada escrito", async () => {
    const { assessmentId, charges } = await issueMay();
    const snap = await db!.quotaDebtorSnapshot.findFirstOrThrow({ where: { tenantId: t.tenantId, charges: { some: { id: charges[0].id } } } });
    await voidCharge(ctx(), charges[1].id, "para reissue", db!);
    const other = await createTestTenant();
    try {
      const oc = { ...ctx(), tenantId: other.tenantId };
      const stranger = await db!.person.create({ data: { tenantId: other.tenantId, firstName: "S", lastName: "X" } });
      const before = { charges: await db!.charge.count({ where: { tenantId: t.tenantId } }), audit: await db!.auditLog.count({ where: { tenantId: t.tenantId } }) };
      await expect(voidCharge(oc, charges[0].id, "erro", db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(refundAndCancel(oc, charges[0].id, { date: new Date(), reason: "erro" }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(cancelAssessment(oc, assessmentId, "erro", db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(reissueCharge(oc, charges[1].id, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(replaceDebtor(oc, snap.lineId, snap.personId, stranger.id, "erro", db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      // própria linha, mas pessoa de outra tenant
      await expect(replaceDebtor(ctx(), snap.lineId, snap.personId, stranger.id, "erro", db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await db!.charge.count({ where: { tenantId: t.tenantId } })).toBe(before.charges);
      expect(await db!.auditLog.count({ where: { tenantId: t.tenantId } })).toBe(before.audit);
      expect(await db!.charge.count({ where: { tenantId: other.tenantId } })).toBe(0);
    } finally { await other.cleanup(); }
  });

  it("copropriedade 500/500: anular um titular mantém ISSUED; reissue nunca excede a linha", async () => {
    const u = fx.units[0];
    await db!.owner.deleteMany({ where: { unitId: u.id } });
    const [a, b, c] = await Promise.all(["A", "B", "C"].map((n) => db!.person.create({ data: { tenantId: t.tenantId, firstName: n, lastName: "X" } })));
    const vf = new Date(Date.UTC(2020, 0, 1));
    for (const p of [a, b]) await db!.owner.create({ data: { tenantId: t.tenantId, unitId: u.id, personId: p.id, share: 500, vigencia: "CONFIRMED", validFrom: vf } });
    const { assessmentId } = await issueMay();
    const line = await db!.condominiumAssessmentLine.findFirstOrThrow({ where: { assessmentId, unitId: u.id } });
    const chargeOf = (personId: string) => db!.charge.findFirstOrThrow({ where: { status: "ISSUED", quotaDebtorSnapshot: { lineId: line.id, personId } } });
    const originalA = await chargeOf(a.id);
    await voidCharge(ctx(), originalA.id, "erro de titular", db!);
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).status).toBe("ISSUED");
    await reissueCharge(ctx(), originalA.id, db!); // B 2000 + A 2000 = linha 4000
    await replaceDebtor(ctx(), line.id, a.id, c.id, "devedor errado", db!); // anula A, cria C 2000
    await expect(reissueCharge(ctx(), originalA.id, db!)).rejects.toMatchObject({ code: "SNAPSHOT_SUPERSEDED" });
    const issued = await db!.charge.findMany({ where: { status: "ISSUED", quotaDebtorSnapshot: { lineId: line.id } } });
    expect(issued.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0)).toBe(line.amountCents);
  });

  it("refundAndCancel: a devolução não pode ser apagada depois (nem o recebimento)", async () => {
    const { charges } = await issueMay();
    const inn = await recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: Number(charges[0].amount), direction: "EINGANG" }, db!);
    const r = await refundAndCancel(ctx(), charges[0].id, { date: new Date(), reason: "venda anulada" }, db!);
    await expect(deletePaymentWithAllocations(t.tenantId, r.paymentId!, db!)).rejects.toThrow(PaymentError);
    await expect(deletePaymentWithAllocations(t.tenantId, inn.paymentId, db!)).rejects.toThrow(PaymentError);
  });
});

describeDb("Ciclo de vida em concorrência, com gates (#52 R2)", () => {
  let dbA: PrismaClient, dbB: PrismaClient;
  beforeEach(async () => { dbA = clientFor("r2_a"); dbB = clientFor("r2_b"); t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(async () => { await t.cleanup(); await Promise.all([dbA.$disconnect(), dbB.$disconnect()]); });
  const RC = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 };

  /** Führt first(tx) in dbA aus und hält die Transaktion nach dem Sperren offen; startet second() in dbB,
   *  beweist, dass second blockiert, gibt frei und liefert beide Ergebnisse. */
  async function race<A>(first: (tx: Prisma.TransactionClient) => Promise<A>, second: () => Promise<unknown>) {
    const gate = deferred(); const locked = deferred();
    const a = dbA.$transaction(async (tx) => { const r = await first(tx); locked.resolve(); await gate.promise; return r; }, RC);
    await locked.promise;
    const b = second();
    await waitUntilBlocked(db!, "r2_b");
    expect(await isPending(b)).toBe(true);
    gate.resolve();
    return Promise.allSettled([a, b]);
  }

  it("cancelAssessment retido × recordPayment → pagamento recusado, nada escrito", async () => {
    const { assessmentId, charges } = await issueMay();
    const before = await db!.payment.count({ where: { tenantId: t.tenantId } });
    const [a, b] = await race((tx) => cancelAssessmentInTx(tx, ctx(), assessmentId, "refazer"),
      () => recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: 5, direction: "EINGANG" }, dbB));
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(before);
  }, 30000);

  it("cancelAssessment retido × voidCharge → void vira no-op, uma só auditoria de anulação", async () => {
    const { assessmentId, charges } = await issueMay();
    const [a, b] = await race((tx) => cancelAssessmentInTx(tx, ctx(), assessmentId, "refazer"), () => voidCharge(ctx(), charges[0].id, "duplicado", dbB));
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    expect((await db!.charge.findUniqueOrThrow({ where: { id: charges[0].id } })).cancelReason).toBe("refazer");
    expect(await db!.auditLog.count({ where: { tenantId: t.tenantId, entity: "Charge", entityId: charges[0].id } })).toBe(0);
  }, 30000);

  it("cancelAssessment retido × refundAndCancel → reembolso recusado (já anulada), nada escrito", async () => {
    const { assessmentId, charges } = await issueMay();
    const [a, b] = await race((tx) => cancelAssessmentInTx(tx, ctx(), assessmentId, "refazer"),
      () => refundAndCancel(ctx(), charges[0].id, { date: new Date(), reason: "venda anulada" }, dbB));
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { code: "INVALID_INPUT" } });
    expect(await db!.payment.count({ where: { tenantId: t.tenantId, direction: "AUSGANG" } })).toBe(0);
  }, 30000);

  it("recordPayment retido × cancelAssessment → HAS_PAYMENTS, assessment continua ISSUED", async () => {
    const { assessmentId, charges } = await issueMay();
    const [a, b] = await race((tx) => recordPaymentInTx(tx, { tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: 5, direction: "EINGANG" }),
      () => cancelAssessment(ctx(), assessmentId, "refazer", dbB));
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { code: "HAS_PAYMENTS" } });
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).status).toBe("ISSUED");
  }, 30000);

  it("refundAndCancel retido × cancelAssessment → cancelAssessment espera e anula o resto; estado CANCELLED", async () => {
    const { assessmentId, charges } = await issueMay();
    await recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: Number(charges[0].amount), direction: "EINGANG" }, db!);
    const [a, b] = await race((tx) => refundAndCancelInTx(tx, ctx(), charges[0].id, { date: new Date(), reason: "venda anulada" }),
      () => cancelAssessment(ctx(), assessmentId, "refazer", dbB));
    expect(a.status).toBe("fulfilled");
    // charges[0] já está CANCELLED (com entrada + saída); cancelAssessment só olha para as ISSUED.
    expect(b.status).toBe("fulfilled");
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).status).toBe("CANCELLED");
  }, 30000);

  it("refundAndCancel retido × apagar o recebimento → bloqueia → depois recusado (charge CANCELLED)", async () => {
    const { charges } = await issueMay();
    const inn = await recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: Number(charges[0].amount), direction: "EINGANG" }, db!);
    const [a, b] = await race((tx) => refundAndCancelInTx(tx, ctx(), charges[0].id, { date: new Date(), reason: "venda anulada" }),
      () => deletePaymentWithAllocations(t.tenantId, inn.paymentId, dbB));
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(await db!.paymentAllocation.count({ where: { chargeId: charges[0].id } })).toBe(2);
  }, 30000);

  it("apagar o recebimento retido × refundAndCancel → bloqueia → depois só anula (sem Payment de zero)", async () => {
    const { charges } = await issueMay();
    const inn = await recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: Number(charges[0].amount), direction: "EINGANG" }, db!);
    const [a, b] = await race((tx) => deletePaymentWithAllocationsInTx(tx, t.tenantId, inn.paymentId),
      () => refundAndCancel(ctx(), charges[0].id, { date: new Date(), reason: "venda anulada" }, dbB));
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "fulfilled", value: { paymentId: null } });
    expect(await db!.payment.count({ where: { tenantId: t.tenantId, direction: "AUSGANG" } })).toBe(0);
  }, 30000);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (module not found).

- [ ] **Step 3: Implement** helpers in `tx.ts`:

```ts
export async function lockAssessment(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string; kind: string; totalCents: number; propertyId: string; period: Date }[]>`
    SELECT id, status::text, kind::text, "totalCents", "propertyId", period FROM "CondominiumAssessment" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (rows.length === 0) throw new QuotaError("NOT_FOUND", "assessment");
  return rows[0];
}
export async function lockChargesOrdered(tx: Prisma.TransactionClient, tenantId: string, ids: string[]) {
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "Charge" WHERE id IN (${Prisma.join(ids)}) AND "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
}
export async function recomputeAssessmentStatusInTx(tx: Prisma.TransactionClient, tenantId: string, assessmentId: string) {
  const issued = await tx.charge.count({ where: { tenantId, status: "ISSUED", quotaDebtorSnapshot: { line: { assessmentId } } } });
  await tx.condominiumAssessment.update({ where: { id: assessmentId }, data: { status: issued === 0 ? "CANCELLED" : "ISSUED" } });
}
```

and `src/lib/quotas/lifecycle.ts` following the spec §2.2 exactly, with this skeleton for each primitive (lock order: assessment of the charge if it is a quota → charges by id):

```ts
// #52 R2: Lebenszyklus der Sollstellungen — nie physisch löschen; Sperrreihenfolge Assessment → Charges (id aufsteigend).
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ALLOCATIONS_FOR_BALANCE, chargeBalance, MONEY_EPSILON } from "@/lib/charges";
import { QuotaError } from "./errors";
import { lockAssessment, lockChargesOrdered, lockPlanShared, recomputeAssessmentStatusInTx } from "./tx";
import { monthlyFromAnnual } from "./compute";
import { parseOrThrow, reasonSchema } from "./input";

type Ctx = { tenantId: string; userId: string; userName: string | null };
const RC = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 };

async function chargeContext(tx: Prisma.TransactionClient, tenantId: string, chargeId: string) {
  const c = await tx.charge.findFirst({ where: { id: chargeId, tenantId }, select: { id: true, quotaDebtorSnapshot: { select: { id: true, lineId: true, amountCents: true, line: { select: { assessmentId: true, amountCents: true } } } } } });
  if (!c) throw new QuotaError("NOT_FOUND", "charge");
  return c;
}
async function audit(tx: Prisma.TransactionClient, ctx: Ctx, entity: string, entityId: string, summary: string) {
  await tx.auditLog.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, userName: ctx.userName, action: "UPDATE", entity, entityId, summary } });
}
// Grund: getrimmt, 3–500 Zeichen (reasonSchema in input.ts: z.string().trim().min(3).max(500)).
const requireReason = (reason: string) => parseOrThrow(reasonSchema, reason);

export async function voidChargeInTx(tx: Prisma.TransactionClient, ctx: Ctx, chargeId: string, reason: string) {
  reason = requireReason(reason);
  const c = await chargeContext(tx, ctx.tenantId, chargeId);
  const assessmentId = c.quotaDebtorSnapshot?.line.assessmentId;
  if (assessmentId) await lockAssessment(tx, ctx.tenantId, assessmentId);
  await lockChargesOrdered(tx, ctx.tenantId, [chargeId]);
  const cur = await tx.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { status: true, _count: { select: { allocations: true } } } });
  if (cur.status === "CANCELLED") return;
  if (cur._count.allocations > 0) throw new QuotaError("HAS_PAYMENTS");
  await tx.charge.update({ where: { id: chargeId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason } });
  await audit(tx, ctx, "Charge", chargeId, `CANCELLED: ${reason}`);
  if (assessmentId) await recomputeAssessmentStatusInTx(tx, ctx.tenantId, assessmentId);
}
export const voidCharge = (ctx: Ctx, chargeId: string, reason: string, db: PrismaClient = prisma) =>
  db.$transaction((tx) => voidChargeInTx(tx, ctx, chargeId, reason), RC);
```

The other primitives follow the same shape:
- **`refundAndCancelInTx`**: `reasonSchema` on `reason`; context + locks as above; a charge already `CANCELLED` → `QuotaError("INVALID_INPUT", "already cancelled")`; `cur` with `ALLOCATIONS_FOR_BALANCE`; `paid = Math.round(chargeBalance(cur).paid * 100) / 100`; if `paid > MONEY_EPSILON`, write the full refund **here, privately** (no exported primitive can zero a charge):

  ```ts
  // Vollständige Rückzahlung nur hier: gleiche Transaktion wie CANCELLED (Charge ist bereits gesperrt).
  // Konto einer fremden tenant scheitert an der zusammengesetzten FK (accountId, tenantId).
  const payment = await tx.payment.create({ data: { tenantId: ctx.tenantId, accountId: p.accountId ?? null, date: p.date, amount: paid, direction: "AUSGANG", reference: p.reference ?? null } });
  await tx.paymentAllocation.create({ data: { tenantId: ctx.tenantId, paymentId: payment.id, chargeId, amount: paid } });
  ```

  (use the `Payment` field names from `prisma/schema.prisma` — check `reference` exists; if the model names it differently, use that name.) Then set `CANCELLED` + audit + recompute; return `{ paymentId }`, or `{ paymentId: null }` when `paid ≤ MONEY_EPSILON`.
- **`cancelAssessmentInTx`**: `reasonSchema`; `lockAssessment`; ids of its `ISSUED` charges (charges already `CANCELLED` are left as they are — their allocations do not block); `lockChargesOrdered(ids)`; if any has allocations → `HAS_PAYMENTS`; update all to `CANCELLED` (+ `cancelledAt`, `cancelReason`); assessment `CANCELLED`; one audit row for the assessment.
- **`reissueChargeInTx`**: context; if the assessment is `ORDINARY`, first `lockPlanShared(tenant, propertyId, year)` (step 0), then `lockAssessment`, then lock the charge; checks in this order: charge `CANCELLED`; snapshot has no other `ISSUED` charge; `Σ amountCents of ISSUED charges of the other snapshots of the line + candidate ≤ line.amountCents` else `SNAPSHOT_SUPERSEDED`; if the assessment is `CANCELLED` and `ORDINARY`: the plan exists and `monthlyFromAnnual(round(plan*100), month) === assessment.totalCents` else `PLAN_CHANGED`; create a new charge on the same snapshot (same `amount`, `period`, `dueDate`, `description`); if the assessment was `CANCELLED`, set it `ISSUED` — catch `P2002` on that update and throw `ALREADY_ISSUED_CONFLICT`; audit; return `{ chargeId }`.
- **`replaceDebtorInTx`**: `lockAssessment` of the line's assessment; `toPersonId` must belong to the tenant and have **no** snapshot on this line (else `INVALID_INPUT`); the `fromPersonId` snapshot's `ISSUED` charge must exist and have no allocations (else `HAS_PAYMENTS`); lock that charge; cancel it (`cancelReason = reason`); create the new snapshot (`shareSnapshot`, `amountCents` copied) and its charge; audit; return `{ chargeId }`.

Every public wrapper = `db.$transaction((tx) => …InTx(tx, ctx, …), RC)`.

- [ ] **Step 4: Run it.** `T "npx vitest run src/lib/quotas/lifecycle.test.ts"` — Expected: PASS; run the gated block 5× — all green.

- [ ] **Step 5: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "feat(#52): charge lifecycle — void, refund-and-cancel, cancel assessment, reissue, replace debtor"` then `git push -u origin feat/52-release2`.

---

### Task 6: Account statement — `quotaStatement`

**Files:**
- Create: `src/lib/quotas/statement.ts`
- Test: `src/lib/quotas/statement.test.ts`

**Interfaces:**
- Produces: `quotaStatement(ctx: { tenantId: string }, q: { propertyId: string; unitId?: string; personId?: string; from?: string; to?: string /* YYYY-MM */ }, db?): Promise<{ entries: StatementEntry[]; balance: number; overdueTotal: number }>` with `type StatementEntry = { kind: "CHARGE" | "PAYMENT"; eventId: string /* charge id or allocation id */; date: Date; chargeId: string; amount: number; status?: "ISSUED" | "CANCELLED"; cancelledAt?: Date | null; direction?: "EINGANG" | "AUSGANG"; effect: number; running: number }`. Exactly one of `unitId` / `personId` required (`INVALID_INPUT`).

- [ ] **Step 1: Write the failing tests** — cover: invalid query (`from: "2026-13"`, `from > to`, both or neither of `unitId`/`personId`) → `INVALID_INPUT`; `unitId` of another tenant, `unitId` of another property of the same tenant, `personId` of another tenant → `NOT_FOUND` (never an empty statement); two payments on the same day for the same charge appear in allocation-id order on every run; void without payment (entry with `effect 0`, balance unchanged); payment + full refund via `refundAndCancel` (balance 0); `overdueTotal` counts only ISSUED, past due, open > `MONEY_EPSILON`; ordering by date, then charge before payment, then id; `from`/`to` filter on the charge period but include all allocations of those charges; per person only that person's snapshots; per unit all holders; another tenant's property → `NOT_FOUND`.

```ts
// Kern der Erwartungen (vollständige Datei wie in Task 5 mit issueMay aufbauen):
const s = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, unitId: fx.units[1].id }, db!);
expect(s.entries[0]).toMatchObject({ kind: "CHARGE", effect: 60 });
expect(s.balance).toBe(60);
expect(s.overdueTotal).toBe(60); // Mai 2026, dueDate 8.5.2026 < now
```

- [ ] **Step 2: Run it.** Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Add to `src/lib/quotas/input.ts`:

```ts
export const statementQuerySchema = z.strictObject({
  propertyId: id, unitId: id.optional(), personId: id.optional(), from: month.optional(), to: month.optional(),
}).superRefine((v, ctx) => {
  if (!!v.unitId === !!v.personId) ctx.addIssue({ code: "custom", message: "unitId xor personId" });
  if (v.from && v.to && v.from > v.to) ctx.addIssue({ code: "custom", message: "from > to" });
});
export type StatementQuery = z.input<typeof statementQuerySchema>;
```

(`reasonSchema = z.string().trim().min(3).max(500)` was added to `input.ts` in Task 5.) Then `src/lib/quotas/statement.ts`:

```ts
// #52 R2: Konto-Auszug der Quoten — Stand heute; Schuldner immer über den Snapshot, nie über Owner.
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { chargeBalance, MONEY_EPSILON } from "@/lib/charges";
import { QuotaError } from "./errors";
import { parseOrThrow, statementQuerySchema, type StatementQuery } from "./input";

export type StatementEntry = {
  kind: "CHARGE" | "PAYMENT"; eventId: string; date: Date; chargeId: string; amount: number;
  status?: "ISSUED" | "CANCELLED"; cancelledAt?: Date | null; direction?: "EINGANG" | "AUSGANG";
  effect: number; running: number;
};

const monthStart = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function quotaStatement(ctx: { tenantId: string }, raw: StatementQuery, db: PrismaClient = prisma) {
  const q = parseOrThrow(statementQuerySchema, raw);
  const property = await db.property.findFirst({ where: { id: q.propertyId, tenantId: ctx.tenantId }, select: { id: true } });
  if (!property) throw new QuotaError("NOT_FOUND", "property");
  // Zugehörigkeit prüfen: fremde oder falsche IDs sind NOT_FOUND, nie ein leerer Auszug.
  if (q.unitId && !(await db.unit.findFirst({ where: { id: q.unitId, tenantId: ctx.tenantId, building: { propertyId: property.id } }, select: { id: true } }))) {
    throw new QuotaError("NOT_FOUND", "unit");
  }
  if (q.personId && !(await db.person.findFirst({ where: { id: q.personId, tenantId: ctx.tenantId }, select: { id: true } }))) {
    throw new QuotaError("NOT_FOUND", "person");
  }
  const period: { gte?: Date; lte?: Date } = {};
  if (q.from) period.gte = monthStart(q.from);
  if (q.to) period.lte = monthStart(q.to);
  const charges = await db.charge.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(q.from || q.to ? { period } : {}),
      quotaDebtorSnapshot: {
        ...(q.personId ? { personId: q.personId } : {}),
        line: { ...(q.unitId ? { unitId: q.unitId } : {}), assessment: { propertyId: property.id } },
      },
    },
    select: {
      id: true, amount: true, status: true, cancelledAt: true, dueDate: true, period: true,
      allocations: { select: { id: true, amount: true, payment: { select: { date: true, direction: true } } } },
    },
  });
  const now = new Date();
  const entries: Omit<StatementEntry, "running">[] = [];
  let overdueTotal = 0;
  for (const c of charges) {
    const amount = Number(c.amount);
    entries.push({ kind: "CHARGE", eventId: c.id, date: c.period, chargeId: c.id, amount, status: c.status, cancelledAt: c.cancelledAt, effect: c.status === "ISSUED" ? amount : 0 });
    for (const a of c.allocations) {
      const v = Number(a.amount);
      entries.push({ kind: "PAYMENT", eventId: a.id, date: a.payment.date, chargeId: c.id, amount: v, direction: a.payment.direction, effect: a.payment.direction === "EINGANG" ? -v : v });
    }
    const { open } = chargeBalance(c);
    if (c.status === "ISSUED" && c.dueDate < now && open > MONEY_EPSILON) overdueTotal += open;
  }
  // deterministisch: Datum, dann Sollstellung vor Zahlung, dann stabile Ereignis-ID
  entries.sort((x, y) => x.date.getTime() - y.date.getTime() || (x.kind === y.kind ? 0 : x.kind === "CHARGE" ? -1 : 1) || cmp(x.eventId, y.eventId));
  let running = 0;
  const out = entries.map((e) => { running = Math.round((running + e.effect) * 100) / 100; return { ...e, running }; });
  return { entries: out, balance: running, overdueTotal: Math.round(overdueTotal * 100) / 100 };
}
```

- [ ] **Step 4: Run it.** `T "npx vitest run src/lib/quotas/statement.test.ts"` — Expected: PASS.

- [ ] **Step 5: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "feat(#52): quota account statement per fraction and per owner"` then `git push -u origin feat/52-release2`.

---

### Task 7: Server actions, roles, void replaces delete (UI and API)

**Files:**
- Create: `src/server/actions/quotas.ts`
- Modify: `src/lib/rbac.ts` (role sets), `src/server/actions/finances.ts` (`deleteCharge` removed; `createPayment` maps `QuotaError`), `src/app/[locale]/(admin)/finances/page.tsx` (charge row uses `VoidChargeButton`), `src/lib/api-write.ts` (`apiDelete(p, entity, id, opts)` voids charges, reason required), `src/app/api/v1/records/[entity]/[id]/route.ts` (DELETE reads `reason`), `src/app/api/mcp/route.ts` (`delete_record` gains `reason`), `messages/{de,en,pt}.json` (`quotaErrors.*`, void dialog copy)
- Create: `src/components/void-charge-button.tsx`
- Test: `src/server/actions/quotas.test.ts`, extend `src/lib/payment-writers.test.ts`

**Interfaces:**
- Produces: `QUOTA_MANAGE_ROLES = ["VERWALTER"]`, `FINANCE_ROLES = ["VERWALTER", "BUCHHALTUNG"]`, `QUOTA_READ_ROLES = ["VERWALTER", "BUCHHALTUNG"]` in `rbac.ts` (ADMIN always allowed via `roleAllows`); server actions `issueQuotasAction`, `issueQuotasRangeAction`, `voidChargeAction`, `refundAndCancelAction`, `cancelAssessmentAction`, `reissueChargeAction`, `replaceDebtorAction`, `quotaStatementAction` — each `(_p: ActionState, fd: FormData) => Promise<ActionState & { data?: unknown }>`, building `ctx` from `requireRole(...)`'s user (`tenantId`, `id`, `name`).

- [ ] **Step 1: Write the failing tests** — `src/server/actions/quotas.test.ts`, mocking `@/lib/auth-guard` (or wherever `requireRole` lives — follow `src/server/actions/ai.test.ts`) so that `requireRole(allowed)` throws unless the mocked user's role is ADMIN or in `allowed`, and mocking `@/lib/quotas/issue` / `@/lib/quotas/lifecycle` / `@/lib/quotas/statement` with `vi.fn()` that resolve:

```ts
const MATRIX: [string, Record<string, boolean>][] = [
  ["issueQuotasAction",       { ADMIN: true, VERWALTER: true, BUCHHALTUNG: false, BEIRAT: false }],
  ["issueQuotasRangeAction",  { ADMIN: true, VERWALTER: true, BUCHHALTUNG: false, BEIRAT: false }],
  ["cancelAssessmentAction",  { ADMIN: true, VERWALTER: true, BUCHHALTUNG: false, BEIRAT: false }],
  ["reissueChargeAction",     { ADMIN: true, VERWALTER: true, BUCHHALTUNG: false, BEIRAT: false }],
  ["replaceDebtorAction",     { ADMIN: true, VERWALTER: true, BUCHHALTUNG: false, BEIRAT: false }],
  ["voidChargeAction",        { ADMIN: true, VERWALTER: true, BUCHHALTUNG: true,  BEIRAT: false }],
  ["refundAndCancelAction",   { ADMIN: true, VERWALTER: true, BUCHHALTUNG: true,  BEIRAT: false }],
  ["quotaStatementAction",    { ADMIN: true, VERWALTER: true, BUCHHALTUNG: true,  BEIRAT: false }],
];
for (const [name, roles] of MATRIX) for (const [role, allowed] of Object.entries(roles)) {
  it(`${name} × ${role} → ${allowed ? "erlaubt" : "verweigert"}`, async () => {
    setRole(role);
    const mod = await import("./quotas");
    const call = (mod as Record<string, (p: unknown, fd: FormData) => Promise<unknown>>)[name]({}, validFormFor(name));
    if (allowed) await expect(call).resolves.not.toMatchObject({ error: expect.stringMatching(/Berechtigung|forbidden/i) });
    else await expect(call).rejects.toThrow();
  });
}
it("QuotaError wird auf quotaErrors.<CODE> übersetzt", async () => {
  setRole("VERWALTER");
  issueQuotasMock.mockRejectedValueOnce(new QuotaError("MEA_INVALID"));
  const { issueQuotasAction } = await import("./quotas");
  await expect(issueQuotasAction({}, validFormFor("issueQuotasAction"))).resolves.toMatchObject({ error: "quotaErrors.MEA_INVALID" });
});
it("tenantId kommt aus der Sitzung, nie aus dem Formular", async () => {
  setRole("VERWALTER");
  const fd = validFormFor("voidChargeAction"); fd.set("tenantId", "fremd");
  const { voidChargeAction } = await import("./quotas");
  await voidChargeAction({}, fd);
  expect(voidChargeMock.mock.calls[0][0].tenantId).toBe(SESSION_TENANT);
});
```

(`setRole`, `validFormFor`, `SESSION_TENANT` are small helpers in the test file; `validFormFor` returns a `FormData` with the fields each action parses. The mocked `getTranslations` returns the key, so errors compare as keys.) Add source guards to `src/lib/payment-writers.test.ts`:

```ts
it("Sollstellungen werden nie physisch gelöscht (#52 R2)", () => {
  const fin = readFileSync("src/server/actions/finances.ts", "utf8");
  const api = readFileSync("src/lib/api-write.ts", "utf8");
  expect(fin).not.toMatch(/charge\.delete(Many)?\(/);
  expect(api).not.toMatch(/charge\.delete(Many)?\(/);
  expect(fin).not.toMatch(/export async function deleteCharge/);
  expect(api).toMatch(/voidCharge\(/);
});
```

- [ ] **Step 2: Run it.** `T "npx vitest run src/server/actions/quotas.test.ts src/lib/payment-writers.test.ts"` — Expected: FAIL (module not found; guards fail).

- [ ] **Step 3: Implement.** In `src/lib/rbac.ts` below `WRITE_ROLES`:

```ts
/** #52 R2: Quoten-Verwaltung (Emission, Storno der Emission, Korrekturen). ADMIN über roleAllows. */
export const QUOTA_MANAGE_ROLES: UserRole[] = ["VERWALTER"];
/** #52 R2: finanzielle Operationen (Zahlungen, Rückzahlung+Storno, Storno einer Sollstellung). */
export const FINANCE_ROLES: UserRole[] = ["VERWALTER", "BUCHHALTUNG"];
/** #52 R2: namentliche Konto-Auszüge. BEIRAT ausdrücklich nicht. */
export const QUOTA_READ_ROLES: UserRole[] = ["VERWALTER", "BUCHHALTUNG"];
```

`src/server/actions/quotas.ts` — one shape for every action. `FormData` becomes a plain object and is parsed with a Zod form schema that only coerces types (strings → numbers/dates/JSON); value ranges, enums and required fields are then enforced by the service schemas (`issueInputSchema`, `reasonSchema`, `statementQuerySchema`). Nothing is cast:

```ts
"use server";
// #52 R2: Server Actions der Quoten — ohne UI in dieser Release; tenantId immer aus der Sitzung.
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { requireRole, QUOTA_MANAGE_ROLES, FINANCE_ROLES, QUOTA_READ_ROLES } from "@/lib/rbac";
import { QuotaError } from "@/lib/quotas/errors";
import { parseOrThrow, reasonSchema } from "@/lib/quotas/input";
import { issueQuotas } from "@/lib/quotas/issue";
import { voidCharge } from "@/lib/quotas/lifecycle";

type Result = { ok?: boolean; error?: string; data?: unknown };
type Ctx = { tenantId: string; userId: string; userName: string | null };

/** FormData → Objekt; leere Felder fehlen (statt "" als Wert). */
function formObject(fd: FormData) {
  const o: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && v.trim() !== "") o[k] = v.trim();
  return o;
}
const int = z.coerce.number().int();
const day = z.coerce.date();
const json = z.string().transform((s, ctx) => {
  try { return JSON.parse(s) as unknown; } catch { ctx.addIssue({ code: "custom", message: "json" }); return z.NEVER; }
});

// Nur Typumwandlung; Wertebereiche/Enums/Pflichtfelder prüft issueInputSchema im Service.
const issueForm = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ORDINARY"), propertyId: z.string(), month: z.string(), method: z.string().optional(),
    custom: json.optional(), dueDay: int.optional(), description: z.string().optional(), resolutionId: z.string().optional() }),
  z.strictObject({ kind: z.literal("EXTRAORDINARY"), propertyId: z.string(), month: z.string(), method: z.string().optional(),
    custom: json.optional(), totalCents: int, asOf: day, dueDate: day, description: z.string(), resolutionId: z.string().optional() }),
]);

async function run(roles: Parameters<typeof requireRole>[0], fn: (ctx: Ctx) => Promise<unknown>): Promise<Result> {
  const user = await requireRole(roles);
  try {
    return { ok: true, data: await fn({ tenantId: user.tenantId, userId: user.id, userName: user.name ?? null }) };
  } catch (e) {
    if (e instanceof QuotaError) {
      const t = await getTranslations("quotaErrors");
      return { error: t(e.code) };
    }
    throw e;
  }
}

export async function issueQuotasAction(_p: Result, fd: FormData): Promise<Result> {
  // issueQuotas validiert erneut mit issueInputSchema (unbekannte method, dueDay 29 … → INVALID_INPUT)
  return run(QUOTA_MANAGE_ROLES, (ctx) => issueQuotas(ctx, parseOrThrow(issueForm, formObject(fd)) as Parameters<typeof issueQuotas>[1]));
}

export async function voidChargeAction(_p: Result, fd: FormData): Promise<Result> {
  const f = formObject(fd);
  return run(FINANCE_ROLES, (ctx) => voidCharge(ctx, f.chargeId ?? "", parseOrThrow(reasonSchema, f.reason ?? "")));
}
```

The other six actions follow exactly this shape, each with its own `z.strictObject` form schema and role set:
- `issueQuotasRangeAction`: `QUOTA_MANAGE_ROLES`, `issueForm` fields plus `from`/`to`.
- `cancelAssessmentAction`: `QUOTA_MANAGE_ROLES`, `assessmentId`, `reason`.
- `reissueChargeAction`: `QUOTA_MANAGE_ROLES`, `chargeId`.
- `replaceDebtorAction`: `QUOTA_MANAGE_ROLES`, `lineId`, `fromPersonId`, `toPersonId`, `reason`.
- `refundAndCancelAction`: `FINANCE_ROLES`, `chargeId`, `accountId?`, `date` (`day`), `reference?`, `reason`.
- `quotaStatementAction`: `QUOTA_READ_ROLES`, `propertyId`, `unitId?`, `personId?`, `from?`, `to?`.

`strictObject` rejects unknown fields: a `tenantId` in the form gives `INVALID_INPUT`, and the session tenant is used in every case. The role-matrix test's `validFormFor` supplies the minimal valid fields per action. Extend the action tests with the thirteen bad inputs from Task 4, sent as `FormData`: each returns `{ error: "quotaErrors.INVALID_INPUT" }`.

`src/components/void-charge-button.tsx` replaces the charge row's delete button with a void dialog that requires a reason:

```tsx
"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { voidChargeAction } from "@/server/actions/quotas";

export function VoidChargeButton({ chargeId }: { chargeId: string }) {
  const t = useTranslations("finances");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(voidChargeAction, {});
  useEffect(() => {
    if (state.ok) { setOpen(false); toast.success(t("voided")); router.refresh(); }
    else if (state.error) toast.error(state.error);
  }, [state, router, t]);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="icon" aria-label={t("void")} title={t("void")}><Ban className="size-4" /></Button>}
      />
      <AlertDialogContent>
        <form action={action}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("voidTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("voidDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <input type="hidden" name="chargeId" value={chargeId} />
          <textarea name="reason" required minLength={3} maxLength={500} aria-label={t("voidReason")} placeholder={t("voidReason")}
            className="w-full rounded-md border px-3 py-2 text-sm" />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <Button type="submit" disabled={pending}>{t("void")}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

(Before writing it, check for an existing `Textarea` component (`grep -rn "Textarea" src/components/ui`); if there is one, use it instead of the bare `textarea`.)

On the finances page, replace `<DeleteButton action={deleteCharge} id={c.id} />` with `<VoidChargeButton chargeId={c.id} />`. Remove `deleteCharge` from `finances.ts` and from the page import; no shim is left behind.

Add the keys `finances.void`, `voidTitle`, `voidDesc`, `voidReason` and `voided` in de, en and pt. The pt values are "Anular", "Anular cobrança", "A cobrança fica anulada e visível no histórico. Indique o motivo.", "Motivo" and "Cobrança anulada". Reuse an existing `cancel` key if the namespace already has one.

In `src/lib/api-write.ts`, `apiDelete` gets an options argument and the charge branch voids instead of deleting. The existing `chargeHasHistory` branch and the `deleteMany` path for charges both go away:

```ts
export async function apiDelete(p: ApiPrincipal, entity: string, id: string, opts: { reason?: unknown } = {}) {
  // … unverändert bis vor den payment-Zweig …
  if (entity === "charge") {
    // #52 R2: Sollstellungen werden nie gelöscht — Storno mit Pflicht-Begründung.
    const reason = reasonSchema.safeParse(opts.reason);
    if (!reason.success) throw new ApiWriteError("reason (3–500 Zeichen) ist für das Stornieren einer Sollstellung Pflicht", 400);
    try {
      await voidCharge({ tenantId: p.tenantId, userId: p.userId, userName: p.name }, id, reason.data);
    } catch (e) {
      if (e instanceof QuotaError && e.code === "HAS_PAYMENTS") throw new ApiWriteError("Sollstellung hat Zahlungen; zuerst erstatten", 409);
      if (e instanceof QuotaError && e.code === "NOT_FOUND") throw new ApiWriteError("Nicht gefunden", 404);
      throw e;
    }
    return { id, voided: true };
  }
  // … Rest unverändert …
}
```

`requireWrite(p)` stays in front of it. It already limits access to ADMIN, VERWALTER and BUCHHALTUNG, which matches `FINANCE_ROLES`.

The REST route's `DELETE` handler:

```ts
export async function DELETE(req: Request, { params }: Ctx) {
  const p = await authenticateBearer(req);
  if (!p) return unauthorized();
  const { entity, id } = await params;
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = body.reason ?? new URL(req.url).searchParams.get("reason") ?? undefined;
  try {
    return Response.json(await apiDelete(p, entity, id, { reason }));
  } catch (e) {
    if (e instanceof ApiWriteError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
```

MCP `delete_record`:

```ts
  {
    name: "delete_record",
    description: "Datensatz löschen. entity + id. Mandanten-gescopt. Sollstellungen (charge) werden nicht gelöscht, sondern storniert: reason ist dann Pflicht.",
    inputSchema: obj({ entity: entityEnum, id: str, reason: str }, ["entity", "id"]),
    run: (p, a) => apiDelete(p, String(a.entity), String(a.id), { reason: a.reason }),
  },
```

Tests (add these to Step 1, before implementing) go in `src/lib/api-write.test.ts`, or in the existing API test file if one covers `apiDelete`:
- No reason: `apiDelete(p, "charge", id)` throws `ApiWriteError` 400, and the charge is still `ISSUED`.
- `{ reason: "  " }` → 400.
- `{ reason: "duplicada" }` → returns `{ voided: true }`; the row is `CANCELLED` with that reason.
- A charge with payments → 409.
- An id from another tenant → 404.

Source guards:
- The MCP `delete_record` schema contains `reason`.
- The REST `DELETE` handler passes `{ reason }`.
- The finances page no longer imports `deleteCharge`.

Add `quotaErrors` to `messages/de.json`, `en.json` and `pt.json`, with one key per `QuotaErrorCode`. The pt texts:

```json
"quotaErrors": {
  "PLAN_MISSING": "Não existe orçamento para este ano.",
  "PLAN_CHANGED": "O orçamento mudou desde a emissão; anule e emita de novo.",
  "MEA_INVALID": "Permilagens inválidas: todas as frações precisam de permilagem e a soma tem de ser igual ao total.",
  "FIXED_NOT_DIVISIBLE": "O valor não se divide exactamente pelas frações.",
  "CUSTOM_INVALID": "Distribuição personalizada inválida: todas as frações, soma igual ao total.",
  "HOLDERS_INVALID": "Há frações sem titulares válidos (soma das quotas-partes ≠ 1000).",
  "ALREADY_ISSUED_CONFLICT": "Já existe uma emissão deste mês com outros parâmetros.",
  "SNAPSHOT_SUPERSEDED": "Esta quota foi substituída por outro devedor.",
  "HAS_PAYMENTS": "Tem pagamentos associados; reembolse primeiro.",
  "USE_REFUND_AND_CANCEL": "Reembolso total: use \"Reembolsar e anular\".",
  "NOT_FOUND": "Registo não encontrado.",
  "INVALID_INPUT": "Dados inválidos.",
  "RETRY_EXHAUSTED": "Operação em conflito com outra; tente de novo."
}
```

The de and en texts carry the same meaning. `createPayment` in `finances.ts` catches `QuotaError` the same way it catches `PaymentError` and returns `t("quotaErrors." + e.code)`.

- [ ] **Step 4: Run it.** `T "npx vitest run src/server/actions/quotas.test.ts src/lib/payment-writers.test.ts src/lib/i18n*.test.ts"` — Expected: PASS (the messages parity test, if present, stays green).

- [ ] **Step 5: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "feat(#52): quota server actions with role levels; void replaces delete for charges"` then `git push -u origin feat/52-release2`.

---

### Task 8: Generic lifecycle fixes in readers

**Files:**
- Modify: `src/server/actions/finances.ts` (`emailDunning`), `src/app/[locale]/(admin)/finances/page.tsx` (status), `src/lib/api-data.ts` (`listCharges`), `src/app/[locale]/portal/page.tsx` (refunds), `messages/{de,en,pt}.json` (`finances.statusCANCELLED` or the existing status key pattern)
- Test: `src/lib/charge-readers.test.ts` (extend)

- [ ] **Step 1: Write the failing tests.** Unit test in `src/lib/charges.test.ts`:

```ts
describe("chargeStatus (#52 R2)", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const past = new Date("2026-05-08T00:00:00Z"), future = new Date("2026-07-08T00:00:00Z");
  const alloc = (amount: number, direction: "EINGANG" | "AUSGANG" = "EINGANG") => ({ amount, payment: { direction } });
  it("CANCELLED hat Vorrang — nie PAID", () => {
    expect(chargeStatus({ status: "CANCELLED", amount: 10, dueDate: past, allocations: [] }, now)).toBe("CANCELLED");
    expect(chargeStatus({ status: "CANCELLED", amount: 10, dueDate: past, allocations: [alloc(10), alloc(10, "AUSGANG")] }, now)).toBe("CANCELLED");
  });
  it("eine Toleranz: 0,004 offen ist PAID (MONEY_EPSILON)", () => {
    expect(chargeStatus({ status: "ISSUED", amount: 10, dueDate: past, allocations: [alloc(9.996)] }, now)).toBe("PAID");
  });
  it("ISSUED: PAID / OVERDUE / PARTIAL / OPEN wie bisher", () => {
    expect(chargeStatus({ status: "ISSUED", amount: 10, dueDate: past, allocations: [alloc(10)] }, now)).toBe("PAID");
    expect(chargeStatus({ status: "ISSUED", amount: 10, dueDate: past, allocations: [] }, now)).toBe("OVERDUE");
    expect(chargeStatus({ status: "ISSUED", amount: 10, dueDate: future, allocations: [alloc(4)] }, now)).toBe("PARTIAL");
    expect(chargeStatus({ status: "ISSUED", amount: 10, dueDate: future, allocations: [] }, now)).toBe("OPEN");
  });
});
```

Source guards in `src/lib/charge-readers.test.ts`:

```ts
it("Finanzen nutzen chargeStatus; listCharges liefert status; Portal zeigt keine Rückzahlungen; emailDunning prüft offen+fällig (#52 R2)", () => {
  const page = readFileSync("src/app/[locale]/(admin)/finances/page.tsx", "utf8");
  const apiData = readFileSync("src/lib/api-data.ts", "utf8");
  const portal = readFileSync("src/app/[locale]/portal/page.tsx", "utf8");
  const fin = readFileSync("src/server/actions/finances.ts", "utf8");
  expect(page).toMatch(/chargeStatus\(/);
  expect(page).not.toMatch(/open <= 0\.001\) status = "PAID"/);
  expect(apiData).toMatch(/status: c\.status/);
  expect(portal).toMatch(/direction === "EINGANG"/);
  expect(fin).toMatch(/emailDunning[\s\S]*status !== "ISSUED"[\s\S]*open <= MONEY_EPSILON[\s\S]*dueDate/);
  expect(fin).not.toMatch(/0\.00[15]/); // eine Toleranz, keine Literale
});
```

and a DB test: create a lease charge, void it with `voidCharge`, call `listCharges` for the tenant, expect the row to have `status: "CANCELLED"`.

- [ ] **Step 2: Run it.** `T "npx vitest run src/lib/charges.test.ts src/lib/charge-readers.test.ts"` — Expected: FAIL (`chargeStatus` not exported; guards fail).

- [ ] **Step 3: Implement.** In `src/lib/charges.ts`:

```ts
export type ChargeStatusLabel = "CANCELLED" | "PAID" | "OVERDUE" | "PARTIAL" | "OPEN";
/** #52 R2: Anzeige-Status; eine stornierte Sollstellung ist nie „bezahlt“. */
export function chargeStatus(c: BalanceInput & { status: "ISSUED" | "CANCELLED"; dueDate: Date }, now: Date): ChargeStatusLabel {
  if (c.status === "CANCELLED") return "CANCELLED";
  const { paid, open } = chargeBalance(c);
  if (open <= MONEY_EPSILON) return "PAID";
  if (c.dueDate < now) return "OVERDUE";
  return paid > 0 ? "PARTIAL" : "OPEN";
}
```

(if `BalanceInput` already includes `status`, drop it from the intersection). Finanças page: replace the inline `let status…` block with `const status = chargeStatus(c, now);`, add `"CANCELLED"` to `STATUSES`, add `totalOpen` only over non-cancelled rows (`r.status === "CANCELLED" ? 0 : …`), and add the label key next to the existing status labels in all three `messages` files (`Anulada` / `Storniert` / `Cancelled`). `listCharges` in `src/lib/api-data.ts`: add `status: c.status` (and `cancelledAt`, `cancelReason`) to each returned row. Portal page: filter the allocations mapped at line ~77 with `.filter((a) => a.payment.direction === "EINGANG")`. `emailDunning`: right after the `lease` check:

```ts
  const { open } = chargeBalance(charge);
  // #52 R2: nur offene, fällige, nicht stornierte Sollstellungen mahnen.
  if (charge.status !== "ISSUED" || open <= MONEY_EPSILON || charge.dueDate >= new Date()) return fail("Sollstellung ist nicht offen und fällig.");
```

(the existing `const { open } = chargeBalance(charge);` line moves up to here; the `open > 0.005` literal at line ~204 becomes `open > MONEY_EPSILON`; import `MONEY_EPSILON` from `@/lib/charges`.)

- [ ] **Step 4: Run it.** `T "npx vitest run src/lib/charges.test.ts src/lib/charge-readers.test.ts src/lib/portal-charges.test.ts"` — Expected: PASS.

- [ ] **Step 5: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "fix(#52): cancelled charges are never "paid"; emailDunning only for open overdue charges; portal hides refunds; listCharges exposes status"` then `git push -u origin feat/52-release2`.

---

### Task 9: Seeds, type check, full verification

**Files:**
- Modify (only if needed): `prisma/seed-crmware-demo.ts` (assessments need `requestKey` if the seed creates any — it does not in R2; the validator must accept `cancelledAt/cancelReason`)

- [ ] **Step 1:** `T "npx tsc --noEmit -p ."` → only the 3 `sso.test.ts` errors. Fix the rest.
- [ ] **Step 2:** full suite `T "npx vitest run"`; demo contract test (command above); `prisma migrate diff` against a scratch DB (only raw-SQL objects).
- [ ] **Step 3:** eslint on changed files: no new errors vs. `main`.
- [ ] **Step 4:** runtime check on a built image with an empty Postgres (default bridge, host ports, unique names `r2rt-db`/`r2rt-app`): migrate; seed the demo; call `issueQuotasAction` through a small script with the image (`npx tsx -e …` using `issueQuotas` directly against the DB) for one demo condominium and one month; verify charges exist, `quotaStatement` returns the expected balance, `voidCharge` works; remove the containers.
- [ ] **Step 5: Checkpoint, then commit and push** — present the diff and this task's verification output; commit only after Manuel's explicit approval (see Global Constraints → Git checkpoint): `git commit -m "chore(#52): R2 verification fixes"` then `git push -u origin feat/52-release2` (only if anything changed).

- [ ] **Step 6: Architecture review (before the PR).** Write in the PR body, each with its result and evidence (file:line or test name): tenant isolation (every new query scoped by `tenantId` from the session; cross-tenant tests), billing atomicity (issuance all-or-nothing, refund-and-cancel one transaction, failure-injection tests), unscoped queries (`grep` of new `findMany`/`$queryRaw` without `tenantId`), missing locks (lock-order table vs. code), bypassable auth (role matrix test; REST/MCP use `requireWrite`), leaked internal fields (no new fields in portal/API beyond `status`, `cancelledAt`, `cancelReason`). "Not applicable" must be stated, not omitted.

## Deployment note (for the PR)

The migration aborts if any `CondominiumAssessment` exists. Devbox: expected 0 (no generator before R2) — check right before deploying. Demo: reset in the safe order (DB → migrate → seed → validate → app).
