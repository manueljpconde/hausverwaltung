import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { SerializationConflict, withRetry } from "./tx";

// Fehlerformen wie in Prisma 6.19 gegen PostgreSQL 16 beobachtet (#52 R2, Task 4).
const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "6.19", meta });
const unknown = (pg: string) => new Prisma.PrismaClientUnknownRequestError(
  `\nInvalid \`tx.unit.update()\` invocation:\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(${pg}), transient: false })`,
  { clientVersion: "6.19" },
);
const observedDeadlock = 'PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR", detail: Some("Process 1261 waits for ShareLock on transaction 17219; blocked by process 1262.\\nProcess 1262 waits for ShareLock on transaction 17218; blocked by process 1261."), column: None, hint: Some("See server log for query details.") }';
const shapes: [string, () => Error][] = [
  ["$queryRaw/$executeRaw 40001 → P2010 meta.code", () => known("P2010", { code: "40001" })],
  ["$executeRaw 40P01 → P2010 meta.code", () => known("P2010", { code: "40P01" })],
  ["Modell-Operation 40001 → P2034", () => known("P2034", { modelName: "Unit" })],
  ["Modell-Operation 40P01 → UnknownRequestError (beobachteter Text)", () => unknown(observedDeadlock)],
  ["Modell-Operation 40001 → UnknownRequestError", () => unknown('PostgresError { code: "40001", message: "could not serialize access due to concurrent update", severity: "ERROR", detail: None, column: None, hint: None }')],
  ["Konfliktzeile verschwunden → SerializationConflict", () => new SerializationConflict("conflict row vanished")],
];

describe("withRetry (#52 R2)", () => {
  for (const [label, make] of shapes) {
    it(`${label}: wiederholt`, async () => {
      let n = 0;
      await expect(withRetry(async () => { if (++n < 3) throw make(); return "ok"; })).resolves.toBe("ok");
      expect(n).toBe(3);
    });
  }
  it("nach 3 Versuchen → RETRY_EXHAUSTED mit Ursache", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw known("P2010", { code: "40001" }); }))
      .rejects.toMatchObject({ code: "RETRY_EXHAUSTED", details: { cause: { code: "P2010", message: "x" } } });
    expect(n).toBe(3);
  });
  it("andere Fehler → sofort durchgereicht (auch mit 40001/deadlock im Text)", async () => {
    // beobachtete Form einer CHECK-Verletzung aus einer Modell-Operation; die Zeilenwerte stehen im Detail
    const check = unknown('PostgresError { code: "23514", message: "new row for relation \\"CondominiumAssessment\\" violates check constraint \\"assessment_total_nonneg\\"", severity: "ERROR", detail: Some("Failing row contains (cm1, cm2, 40001, -1, ISSUED, 40P01 could not serialize deadlock detected)."), column: None, hint: None }');
    for (const e of [known("P2002"), known("P2010", { code: "23505" }), new Prisma.PrismaClientValidationError("Argument totalCents: 40001", { clientVersion: "6.19" }), check]) {
      let n = 0;
      await expect(withRetry(async () => { n++; throw e; })).rejects.toBe(e);
      expect(n).toBe(1);
    }
  });
});
