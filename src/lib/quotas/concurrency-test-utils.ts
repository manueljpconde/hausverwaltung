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

/** Prisma-Anfragen sind lazy (PrismaPromise startet erst mit then()): sofort starten, damit sie den Lock wirklich anfordern.
 *  Der leere catch verhindert nur die Meldung „unhandled rejection“ bis zum späteren await; die Ablehnung bleibt erhalten. */
export function started<T>(p: PromiseLike<T>): Promise<T> {
  const q = new Promise<T>((resolve, reject) => { p.then(resolve, reject); }); // then() synchron, nicht erst im Mikrotask wie Promise.resolve
  q.catch(() => {});
  return q;
}
