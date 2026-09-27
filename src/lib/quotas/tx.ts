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
