import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// #52 fix round 1: die Meldung zur Teilzuordnung muss den Nutzer erreichen (nicht im
// geschlossenen Dialog verschwinden) und darf revalidatePath nicht überspringen.
vi.mock("next-intl/server", () => ({
  getTranslations: async (ns: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${ns}.${key}(${JSON.stringify(vars)})` : `${ns}.${key}`,
}));
vi.mock("@/lib/rbac", () => ({ requireWriter: async () => ({ id: "u1", tenantId: "t1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
// #52: finances.ts importiert jetzt generateMonthlyCharges aus @/lib/charge-generation
// (kein server-only mehr transitiv, siehe api-ops.ts/mailer.ts vorher) — kein Mock mehr nötig.
vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>("@/lib/payments");
  return { ...actual, recordPayment: vi.fn() };
});

const { createPayment } = await import("./finances");
const { recordPayment } = await import("@/lib/payments");
const { revalidatePath } = await import("next/cache");

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("createPayment: Überzahlung meldet den Rest (#52 fix)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Teilzuordnung: message statt error, trotzdem revalidiert", async () => {
    vi.mocked(recordPayment).mockResolvedValue({ paymentId: "p1", allocated: 100 });
    const r = await createPayment({}, form({ amount: "300", chargeId: "c1", direction: "EINGANG", date: "2026-09-26" }));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.message).toBe('finances.partiallyApplied({"applied":"100.00","unapplied":"200.00"})');
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("voll zugeordnet: normales done(), keine message", async () => {
    vi.mocked(recordPayment).mockResolvedValue({ paymentId: "p2", allocated: 300 });
    const r = await createPayment({}, form({ amount: "300", chargeId: "c1", direction: "EINGANG", date: "2026-09-26" }));
    expect(r).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

describe("CrudDialog zeigt die Erfolgsmeldung der Server-Action (#52 fix)", () => {
  it("toastet state.message, sonst t(\"saved\")", () => {
    const src = read("src/components/crud-dialog.tsx");
    expect(src).toMatch(/toast\.success\(state\.message \?\? t\("saved"\)\)/);
  });
});
