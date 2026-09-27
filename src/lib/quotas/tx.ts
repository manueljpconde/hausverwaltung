// #52 R2: Transaktions-Helfer — Retry bei Serialisierungs-/Deadlock-Fehlern, Plan-Sperre.
import { Prisma } from "@prisma/client";
import { QuotaError } from "./errors";

const RETRYABLE = new Set(["40001", "40P01", "P2034"]);

/** Intern: ein Konflikt, dessen Auflösung ein neuer Snapshot braucht — wird wie 40001 wiederholt. */
export class SerializationConflict extends Error {}

function isRetryable(e: unknown): boolean {
  if (e instanceof SerializationConflict) return true;
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (RETRYABLE.has(e.code)) return true;
    const meta = (e.meta ?? {}) as { code?: string };
    return meta.code !== undefined && RETRYABLE.has(meta.code);
  }
  // Modell-Operationen melden 40P01 ohne Code (UnknownRequestError). Nur das SQLSTATE-Feld prüfen, wie beobachtet:
  // `PostgresError { code: "40P01", … }` — Meldung und Detail (z. B. „Failing row contains (…)“) zitieren Werte.
  if (!(e instanceof Prisma.PrismaClientUnknownRequestError)) return false;
  return /PostgresError \{ code: "(40001|40P01)"/.test(e.message);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e)) throw e;
      if (i >= attempts) {
        const cause = e as { code?: string; message?: string };
        throw new QuotaError("RETRY_EXHAUSTED", undefined, { cause: { code: cause.code, message: cause.message } });
      }
      await new Promise((r) => setTimeout(r, 20 * i + Math.floor(Math.random() * 20)));
    }
  }
}

export async function lockPlanShared(tx: Prisma.TransactionClient, tenantId: string, propertyId: string, year: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(plan_lock_key(${tenantId}, ${propertyId}, ${year}::int))`;
}

// #52 R2: Sperrreihenfolge Schritt 1 — Assessment der Mandantin, FOR UPDATE.
export async function lockAssessment(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string; status: "ISSUED" | "CANCELLED"; kind: "ORDINARY" | "EXTRAORDINARY"; totalCents: number; propertyId: string; period: Date }[]>`
    SELECT id, status::text, kind::text, "totalCents", "propertyId", period FROM "CondominiumAssessment" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (rows.length === 0) throw new QuotaError("NOT_FOUND", "assessment");
  return rows[0];
}

// Schritt 2 — Sollstellungen nach id aufsteigend.
export async function lockChargesOrdered(tx: Prisma.TransactionClient, tenantId: string, ids: string[]) {
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "Charge" WHERE id IN (${Prisma.join(ids)}) AND "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
}

// Kanonischer Gesamtstatus: CANCELLED genau dann, wenn keine Sollstellung mehr ISSUED ist (unter der Assessment-Sperre aufrufen).
export async function recomputeAssessmentStatusInTx(tx: Prisma.TransactionClient, tenantId: string, assessmentId: string) {
  const issued = await tx.charge.count({ where: { tenantId, status: "ISSUED", quotaDebtorSnapshot: { line: { assessmentId } } } });
  await tx.condominiumAssessment.update({ where: { id_tenantId: { id: assessmentId, tenantId } }, data: { status: issued === 0 ? "CANCELLED" : "ISSUED" } });
}
