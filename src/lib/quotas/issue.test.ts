import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { createTestTenant, describeDb, integrationDb as db } from "../test-db";
import { wegFixture } from "./fixtures";
import { issueQuotas, issueQuotasInTx, issueQuotasRange } from "./issue";
import { clientFor, deferred, isPending, started, waitUntilBlocked } from "./concurrency-test-utils";
import { withRetry } from "./tx";
import { requestKey } from "./compute";

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
    expect(a).toMatchObject({ created: true, lines: 2, charges: 2 });
    await expect(issueQuotas(ctx(), input, db!)).resolves.toEqual({ assessmentId: a.assessmentId, created: false, lines: 2, charges: 2 });
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

  it("lote só para ordinárias: EXTRAORDINARY com from/to → um único INVALID_INPUT, nada escrito", async () => {
    const asOf = new Date(Date.UTC(2026, 6, 1));
    await expect(issueQuotasRange(ctx(), { propertyId: fx.property.id, kind: "EXTRAORDINARY", month: "2026-07", totalCents: 1000, asOf, dueDate: asOf, description: "Obras", from: "2026-07", to: "2026-09" }, db!))
      .rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringMatching(/range only for ordinary/) });
    expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("lote: campos comuns inválidos → uma só rejeição, sem array por mês", async () => {
    const r = issueQuotasRange(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-01", method: "EQUAL", from: "2026-01", to: "2026-03" } as never, db!);
    await expect(r).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });

  it("lote: erro inesperado num mês → meses já emitidos mantidos, UNEXPECTED registado, lote pára", async () => {
    let n = 0;
    // Injektion nur über den vorhandenen db-Parameter: der zweite Monat scheitert mit einem Nicht-QuotaError.
    const flaky = { $transaction: (fn: never, o: never) => (++n === 2 ? Promise.reject(new Error("boom")) : db!.$transaction(fn, o)) } as unknown as PrismaClient;
    const r = await issueQuotasRange(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-01", from: "2026-01", to: "2026-04" }, flaky);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ month: "2026-01", result: { created: true } });
    expect(r[1]).toEqual({ month: "2026-02", error: { code: "UNEXPECTED", details: { message: "boom" } } });
    expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(1);
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
      expect(await db!.condominiumAssessment.count({ where: { tenantId: other.tenantId } })).toBe(0);
      expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
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
    dbA = clientFor("r2_issue_a"); dbB = clientFor("r2_issue_b"); dbC = clientFor("r2_issue_c");
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
    await waitUntilBlocked(db!, "r2_issue_b");
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
    const edit = started(dbB.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } }));
    await waitUntilBlocked(db!, "r2_issue_b");
    expect(await isPending(edit)).toBe(true);
    gate.resolve(); await issuing;
    await expect(edit).rejects.toThrow(/plan locked by issued ordinary assessments/);
    expect(Number((await db!.economicPlan.findUniqueOrThrow({ where: { id: fx.plan.id } })).totalAmount)).toBe(1200);
  }, 30000);

  it("edição do plano à espera do advisory (detido por outra emissão) × emissão ordinária → sem deadlock; emissão usa o plano novo", async () => {
    // C detém o advisory partilhado (como uma emissão extraordinária em curso). B altera o plano: tem a linha e espera o advisory exclusivo.
    // A emite a ordinária e espera a linha (FOR SHARE). Aqui não há ciclo em nenhuma ordem (o pedido partilhado de A ficaria
    // atrás do exclusivo já em espera de B); a ordem linha → advisory prova-a o teste seguinte.
    const gate = deferred(); const locked = deferred();
    const holder = dbC.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(plan_lock_key(${t.tenantId}, ${fx.property.id}, 2026))`;
      locked.resolve(); await gate.promise;
    }, { timeout: 20000 });
    await locked.promise;
    const edit = started(dbB.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } }));
    await waitUntilBlocked(db!, "r2_issue_b");
    // Erster Versuch OHNE withRetry: nur so ist beobachtbar, ob die Emission 40001 (erwartet) oder 40P01 (Deadlock) erleidet.
    const first = dbA.$transaction((tx) => issueQuotasInTx(tx, ctx(), may()), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
    const firstError = first.then(() => null, (e: unknown) => String((e as { message?: string })?.message ?? e));
    await waitUntilBlocked(db!, "r2_issue_a");
    expect(await isPending(first)).toBe(true);
    gate.resolve(); await holder;
    await edit; // Planänderung abgeschlossen
    const msg = await firstError;
    expect(msg).toMatch(/40001|could not serialize/i);
    expect(msg).not.toMatch(/40P01|deadlock/i);
    // zweiter, expliziter Versuch nutzt den neuen Plan
    const r = await issueQuotas(ctx(), may(), dbA);
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: r.assessmentId } })).totalCents).toBe(20000);
  }, 30000);

  it("ordem linha → advisory: emissão à espera do advisory exclusivo, edição do plano atrás → sem deadlock, edição recusada", async () => {
    // C detém o advisory EXCLUSIVO. A (emissão) fica à espera dele — já com a linha do plano FOR SHARE. B altera o plano e
    // espera a linha (detida por A). Na ordem inversa, A esperaria o advisory sem a linha, B obteria a linha e ficaria atrás
    // de A no advisory; ao libertar C, A pediria a linha a B e B o advisory a A → 40P01.
    const gate = deferred(); const locked = deferred();
    const holder = dbC.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(plan_lock_key(${t.tenantId}, ${fx.property.id}, 2026))`;
      locked.resolve(); await gate.promise;
    }, { timeout: 20000 });
    await locked.promise;
    // Ohne withRetry: ein 40P01 muss sichtbar werden, nicht still wiederholt.
    const issuing = started(dbA.$transaction((tx) => issueQuotasInTx(tx, ctx(), may()), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 }));
    await waitUntilBlocked(db!, "r2_issue_a");
    const edit = started(dbB.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } }));
    await waitUntilBlocked(db!, "r2_issue_b");
    expect(await isPending(issuing)).toBe(true);
    expect(await isPending(edit)).toBe(true);
    gate.resolve(); await holder;
    const r = await issuing;
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: r.assessmentId } })).totalCents).toBe(10000);
    await expect(edit).rejects.toThrow(/plan locked by issued ordinary assessments/);
  }, 30000);

  it("movimentos opostos de plano (ano/imóvel) nunca terminam em deadlock", async () => {
    // Plano X: (P, 2026) → (P, 2027); plano Y: (P, 2027) → (P, 2026). Um terceiro detém ambas as chaves,
    // os dois ficam à espera no trigger; ao libertar, a ordem ascendente das chaves impede o ciclo.
    const y = await db!.economicPlan.create({ data: { tenantId: t.tenantId, propertyId: fx.property.id, year: 2027, totalAmount: 1200 } });
    const gate = deferred(); const locked = deferred();
    const holder = dbC.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(plan_lock_key(${t.tenantId}, ${fx.property.id}, 2026)), pg_advisory_xact_lock(plan_lock_key(${t.tenantId}, ${fx.property.id}, 2027))`;
      locked.resolve(); await gate.promise;
    }, { timeout: 20000 });
    await locked.promise;
    const moveX = started(dbA.economicPlan.update({ where: { id: fx.plan.id }, data: { year: 2027 } }));
    const moveY = started(dbB.economicPlan.update({ where: { id: y.id }, data: { year: 2026 } }));
    await waitUntilBlocked(db!, "r2_issue_a"); await waitUntilBlocked(db!, "r2_issue_b");
    gate.resolve(); await holder;
    const results = await Promise.allSettled([moveX, moveY]);
    // Wer zuerst die Schlüssel erhält, trifft auf die festgeschriebene Zeile des anderen Plans (@@unique propertyId+year)
    // und scheitert; nach dessen Rollback trifft der zweite ebenso auf sie. Beide: P2002, keiner 40P01; Pläne unverändert.
    for (const r of results) {
      expect(r.status).toBe("rejected");
      const e = (r as PromiseRejectedResult).reason as { code?: string; message?: string };
      expect(e.code).toBe("P2002");
      expect(String(e.message)).not.toMatch(/deadlock|40P01/i);
    }
    const plans = await db!.economicPlan.findMany({ where: { tenantId: t.tenantId }, select: { id: true, year: true } });
    expect(new Map(plans.map((p) => [p.id, p.year]))).toEqual(new Map([[fx.plan.id, 2026], [y.id, 2027]]));
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
    await waitUntilBlocked(db!, "r2_issue_b");
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
    const move = started(dbB.resolution.update({ where: { id: res.id }, data: { propertyId: sibling.id } }));
    await waitUntilBlocked(db!, "r2_issue_b");
    expect(await isPending(move)).toBe(true);
    gate.resolve(); await issuing;
    await expect(move).rejects.toThrow(/assessment resolution not in assessment property/);
    expect((await db!.resolution.findUniqueOrThrow({ where: { id: res.id } })).propertyId).toBe(fx.property.id);
  }, 30000);
});

describe("Konfliktzeile verschwunden (#52 R2)", () => {
  it("wird wiederholt (nicht an den Aufrufer gemeldet); der Wiederholungsversuch findet die Emission", async () => {
    // Test-Double für tx: dieser Zweig ist in PostgreSQL unter RR praktisch nicht erreichbar (dort kommt vorher 40001).
    const period = new Date(Date.UTC(2026, 4, 1));
    const key = requestKey({ kind: "ORDINARY", period, method: "PERMILLAGE", dueDate: new Date(Date.UTC(2026, 4, 8)), asOf: period, totalCents: 10000, resolutionId: null, description: null });
    let attempts = 0;
    const tx = {
      property: { findFirst: async () => ({ id: "p", management: "WEG", meaTotal: 1000 }) },
      $executeRaw: async () => 0,
      $queryRaw: async (sql: TemplateStringsArray) => {
        const q = sql.join("?");
        if (q.includes('FROM "EconomicPlan"')) return [{ totalAmount: new Prisma.Decimal(1200) }];
        if (q.includes("INSERT INTO")) return [];
        if (q.includes('SELECT id, "requestKey"')) return attempts === 1 ? [] : [{ id: "a1", requestKey: key }];
        throw new Error(`unexpected SQL ${q}`);
      },
      condominiumAssessmentLine: { count: async () => 2 },
      charge: { count: async () => 2 },
    };
    const fake = { $transaction: (fn: (t: unknown) => Promise<unknown>) => { attempts++; return fn(tx); } } as unknown as PrismaClient;
    await expect(issueQuotas({ tenantId: "t", userId: "u", userName: null }, { propertyId: "p", kind: "ORDINARY", month: "2026-05" }, fake))
      .resolves.toEqual({ assessmentId: "a1", created: false, lines: 2, charges: 2 });
    expect(attempts).toBe(2);
  });
});
