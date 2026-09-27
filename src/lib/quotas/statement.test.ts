import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "../test-db";
import { wegFixture } from "./fixtures";
import { issueQuotas } from "./issue";
import { refundAndCancel, voidCharge } from "./lifecycle";
import { recordPayment } from "../payments";
import { quotaStatement } from "./statement";

let t: Awaited<ReturnType<typeof createTestTenant>>;
let fx: Awaited<ReturnType<typeof wegFixture>>;
const ctx = () => ({ tenantId: t.tenantId, userId: "u", userName: "Teste" });
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
// fester Stichtag: overdueTotal hängt nie an der Wanduhr
const NOW = utc(2026, 9, 1);

async function issue(month: string, propertyId = fx.property.id) {
  await issueQuotas(ctx(), { propertyId, kind: "ORDINARY", month }, db!);
}
async function chargeOf(unitId: string, month: string) {
  const [y, m] = month.split("-").map(Number);
  return db!.charge.findFirstOrThrow({ where: { tenantId: t.tenantId, period: utc(y, m, 1), quotaDebtorSnapshot: { line: { unitId } } } });
}
const pay = (chargeId: string, amount: number, date: Date) =>
  recordPayment({ tenantId: t.tenantId, chargeId, date, amount, direction: "EINGANG" }, db!);

describeDb("Extracto de quotas (#52 R2)", () => {
  beforeEach(async () => { t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(() => t.cleanup());

  it("fracção: quota de Maio emitida, vencida e em aberto", async () => {
    await issue("2026-05");
    const s = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, unitId: fx.units[1].id }, db!, { now: NOW });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: "CHARGE", effect: 60, amount: 60, status: "ISSUED", cancelledAt: null, running: 60 });
    expect(s.entries[0].date).toEqual(utc(2026, 5, 1));
    expect(s.balance).toBe(60);
    expect(s.overdueTotal).toBe(60); // Mai 2026, dueDate 8.5.2026 < NOW
  });

  it("consulta inválida → INVALID_INPUT", async () => {
    const base = { propertyId: fx.property.id };
    const c = { tenantId: t.tenantId };
    await expect(quotaStatement(c, { ...base, unitId: fx.units[0].id, from: "2026-13" }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(quotaStatement(c, { ...base, unitId: fx.units[0].id, from: "2026-06", to: "2026-05" }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(quotaStatement(c, { ...base, unitId: fx.units[0].id, personId: fx.persons[0].id }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(quotaStatement(c, { ...base }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(quotaStatement(c, { ...base, unitId: fx.units[0].id, extra: 1 } as never, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("IDs alheios → NOT_FOUND, nunca um extracto vazio", async () => {
    await issue("2026-05");
    const other = await createTestTenant();
    try {
      const ofx = await wegFixture(db!, other.tenantId);
      const c = { tenantId: t.tenantId };
      // imóvel de outra tenant
      await expect(quotaStatement(c, { propertyId: ofx.property.id, unitId: ofx.units[0].id }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      // fracção de outra tenant
      await expect(quotaStatement(c, { propertyId: fx.property.id, unitId: ofx.units[0].id }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      // condómino de outra tenant
      await expect(quotaStatement(c, { propertyId: fx.property.id, personId: ofx.persons[0].id }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      // fracção de outro imóvel da mesma tenant
      const fx2 = await wegFixture(db!, t.tenantId);
      await expect(quotaStatement(c, { propertyId: fx.property.id, unitId: fx2.units[0].id }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      // id inexistente
      await expect(quotaStatement(c, { propertyId: fx.property.id, unitId: "nope" }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(quotaStatement(c, { propertyId: "nope", unitId: fx.units[0].id }, db!)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { await other.cleanup(); }
  });

  it("condómino da tenant sem snapshot neste imóvel → extracto vazio (válido)", async () => {
    await issue("2026-05");
    const stranger = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "Sem", lastName: "Quota" } });
    const s = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, personId: stranger.id }, db!);
    expect(s).toEqual({ entries: [], balance: 0, overdueTotal: 0 });
  });

  it("ordem: data, quota antes do pagamento, depois id; dois pagamentos no mesmo dia por id de alocação", async () => {
    await issue("2026-05");
    await issue("2026-06");
    const may = await chargeOf(fx.units[1].id, "2026-05");
    const jun = await chargeOf(fx.units[1].id, "2026-06");
    // mesmo dia que o período de Maio, com id de alocação lexicograficamente menor que o da quota:
    // a ordem tem de vir do tipo (quota antes do pagamento), não do id
    const p0 = await db!.payment.create({ data: { tenantId: t.tenantId, date: utc(2026, 5, 1), amount: 10, direction: "EINGANG" } });
    await db!.paymentAllocation.create({ data: { id: "0-same-day", tenantId: t.tenantId, paymentId: p0.id, chargeId: may.id, amount: 10 } });
    expect("0-same-day" < may.id).toBe(true);
    await pay(jun.id, 5, utc(2026, 4, 20)); // antecipado: antes de ambas as quotas
    await pay(may.id, 20, utc(2026, 5, 15));
    await pay(may.id, 7, utc(2026, 5, 15));
    const allocs = await db!.paymentAllocation.findMany({ where: { tenantId: t.tenantId }, include: { payment: true } });
    const sameDayAllocs = allocs.filter((a) => a.payment.date.getTime() === utc(2026, 5, 15).getTime()).sort((x, y) => (x.id < y.id ? -1 : 1));
    const sameDay = sameDayAllocs.map((a) => a.id);
    const early = allocs.find((a) => a.chargeId === jun.id)!;
    const onPeriod = allocs.find((a) => a.payment.date.getTime() === utc(2026, 5, 1).getTime())!;

    const q = { propertyId: fx.property.id, unitId: fx.units[1].id };
    const s = await quotaStatement({ tenantId: t.tenantId }, q, db!);
    expect(s.entries.map((e) => [e.kind, e.eventId])).toEqual([
      ["PAYMENT", early.id],
      ["CHARGE", may.id],
      ["PAYMENT", onPeriod.id],
      ["PAYMENT", sameDay[0]],
      ["PAYMENT", sameDay[1]],
      ["CHARGE", jun.id],
    ]);
    expect(s.entries.map((e) => e.running)).toEqual([-5, 55, 45, 45 - Number(sameDayAllocs[0].amount), 18, 78]);
    expect(s.entries[0]).toMatchObject({ direction: "EINGANG", effect: -5, chargeId: jun.id, amount: 5 });
    expect(s.balance).toBe(78);
    for (let i = 0; i < 3; i++) {
      const again = await quotaStatement({ tenantId: t.tenantId }, q, db!);
      expect(again.entries.map((e) => e.eventId)).toEqual(s.entries.map((e) => e.eventId));
    }
  });

  it("from/to filtra pelo período da quota e inclui todas as alocações (mesmo fora do intervalo)", async () => {
    await issue("2026-05");
    await issue("2026-06");
    const may = await chargeOf(fx.units[0].id, "2026-05");
    const jun = await chargeOf(fx.units[0].id, "2026-06");
    await pay(may.id, 40, utc(2026, 7, 3)); // pagamento de Maio feito em Julho
    await pay(jun.id, 15, utc(2026, 6, 10));
    const c = { tenantId: t.tenantId };
    const onlyMay = await quotaStatement(c, { propertyId: fx.property.id, unitId: fx.units[0].id, from: "2026-05", to: "2026-05" }, db!, { now: NOW });
    expect(onlyMay.entries.map((e) => [e.kind, e.chargeId])).toEqual([["CHARGE", may.id], ["PAYMENT", may.id]]);
    expect(onlyMay.entries[1].date).toEqual(utc(2026, 7, 3));
    expect(onlyMay.balance).toBe(0);
    expect(onlyMay.overdueTotal).toBe(0);
    const fromJun = await quotaStatement(c, { propertyId: fx.property.id, unitId: fx.units[0].id, from: "2026-06" }, db!, { now: NOW });
    expect(fromJun.entries.map((e) => [e.kind, e.chargeId])).toEqual([["CHARGE", jun.id], ["PAYMENT", jun.id]]);
    expect(fromJun.balance).toBe(25);
    expect(fromJun.overdueTotal).toBe(25);
    const toMay = await quotaStatement(c, { propertyId: fx.property.id, unitId: fx.units[0].id, to: "2026-05" }, db!);
    expect(toMay.entries.every((e) => e.chargeId === may.id)).toBe(true);
    const all = await quotaStatement(c, { propertyId: fx.property.id, unitId: fx.units[0].id }, db!);
    expect(all.entries).toHaveLength(4);
    expect(all.balance).toBe(25);
  });

  it("compropriedade 500/500: por fracção todos os titulares; por condómino só os seus snapshots", async () => {
    const u = fx.units[1];
    const b = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "Co", lastName: "Titular" } });
    await db!.owner.updateMany({ where: { tenantId: t.tenantId, unitId: u.id }, data: { share: 500 } });
    await db!.owner.create({ data: { tenantId: t.tenantId, unitId: u.id, personId: b.id, share: 500, vigencia: "CONFIRMED", validFrom: utc(2020, 1, 1) } });
    await issue("2026-05");
    const c = { tenantId: t.tenantId };
    const perUnit = await quotaStatement(c, { propertyId: fx.property.id, unitId: u.id }, db!);
    expect(perUnit.entries.map((e) => e.amount)).toEqual([30, 30]);
    expect(perUnit.balance).toBe(60);
    const perA = await quotaStatement(c, { propertyId: fx.property.id, personId: fx.persons[1].id }, db!);
    const perB = await quotaStatement(c, { propertyId: fx.property.id, personId: b.id }, db!);
    expect(perA.balance).toBe(30);
    expect(perB.balance).toBe(30);
    expect(new Set([...perA.entries, ...perB.entries].map((e) => e.eventId))).toEqual(new Set(perUnit.entries.map((e) => e.eventId)));
    // Mudança posterior do Owner não altera o sujeito: o extracto segue o snapshot.
    await db!.owner.deleteMany({ where: { tenantId: t.tenantId, unitId: u.id, personId: b.id } });
    expect((await quotaStatement(c, { propertyId: fx.property.id, personId: b.id }, db!)).balance).toBe(30);
  });

  it("por condómino: só snapshots deste imóvel, mesmo que seja condómino noutro imóvel da tenant", async () => {
    const fx2 = await wegFixture(db!, t.tenantId);
    await db!.owner.updateMany({ where: { tenantId: t.tenantId, unitId: fx2.units[0].id }, data: { personId: fx.persons[0].id } });
    await issue("2026-05");
    await issue("2026-05", fx2.property.id);
    const s = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, personId: fx.persons[0].id }, db!);
    const mine = await chargeOf(fx.units[0].id, "2026-05");
    expect(s.entries.map((e) => e.eventId)).toEqual([mine.id]);
    expect(s.balance).toBe(40);
  });

  it("anulação sem pagamento: entrada com efeito 0, saldo inalterado", async () => {
    await issue("2026-05");
    const c0 = await chargeOf(fx.units[0].id, "2026-05");
    await voidCharge(ctx(), c0.id, "erro de emissão", db!);
    const s = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, unitId: fx.units[0].id }, db!, { now: NOW });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ kind: "CHARGE", amount: 40, status: "CANCELLED", effect: 0, running: 0 });
    expect(s.entries[0].cancelledAt).toBeInstanceOf(Date);
    expect(s.balance).toBe(0);
    expect(s.overdueTotal).toBe(0);
  });

  it("pagamento + reembolso total via refundAndCancel → saldo 0", async () => {
    await issue("2026-05");
    const c1 = await chargeOf(fx.units[1].id, "2026-05");
    await pay(c1.id, 60, utc(2026, 5, 5));
    await refundAndCancel(ctx(), c1.id, { date: utc(2026, 5, 20), reason: "venda anulada" }, db!);
    const s = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, unitId: fx.units[1].id }, db!, { now: NOW });
    expect(s.entries.map((e) => [e.kind, e.direction ?? null, e.effect, e.running])).toEqual([
      ["CHARGE", null, 0, 0],
      ["PAYMENT", "EINGANG", -60, -60],
      ["PAYMENT", "AUSGANG", 60, 0],
    ]);
    expect(s.entries[0].status).toBe("CANCELLED");
    expect(s.balance).toBe(0);
    expect(s.overdueTotal).toBe(0);
  });

  it("overdueTotal: só ISSUED, vencidas e com aberto > MONEY_EPSILON", async () => {
    await issue("2026-05"); // vencida 8.5.2026
    await issue("2026-06"); // vencida 8.6.2026
    await issue("2026-07"); // vencida 8.7.2026
    // extraordinária com vencimento depois de NOW: aberta mas não vencida
    await issueQuotas(ctx(), { propertyId: fx.property.id, kind: "EXTRAORDINARY", month: "2026-08", totalCents: 100000, asOf: utc(2026, 8, 1), dueDate: utc(2026, 10, 1), description: "Obras" }, db!);
    const u = fx.units[1].id;
    const may = await chargeOf(u, "2026-05");
    const jun = await chargeOf(u, "2026-06");
    const jul = await chargeOf(u, "2026-07");
    await pay(may.id, 60, utc(2026, 5, 8)); // liquidada
    await pay(jun.id, 25, utc(2026, 6, 8)); // parcial: 35 em aberto
    await voidCharge(ctx(), jul.id, "erro", db!); // anulada: não conta
    const s = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, unitId: u }, db!, { now: NOW });
    expect(s.overdueTotal).toBe(35);
    expect(s.balance).toBe(35 + 600);
    const onlyJun = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, unitId: u, from: "2026-06", to: "2026-06" }, db!, { now: NOW });
    expect(onlyJun.overdueTotal).toBe(35);
    const onlyMay = await quotaStatement({ tenantId: t.tenantId }, { propertyId: fx.property.id, unitId: u, to: "2026-05" }, db!, { now: NOW });
    expect(onlyMay.overdueTotal).toBe(0);
  });
  it("overdueTotal: fronteira — dueDate === now não está vencida; 1 ms antes de now está", async () => {
    await issue("2026-05"); // dueDate 8.5.2026 00:00 UTC
    const q = { propertyId: fx.property.id, unitId: fx.units[1].id };
    const due = utc(2026, 5, 8);
    expect((await quotaStatement({ tenantId: t.tenantId }, q, db!, { now: due })).overdueTotal).toBe(0);
    expect((await quotaStatement({ tenantId: t.tenantId }, q, db!, { now: new Date(due.getTime() + 1) })).overdueTotal).toBe(60);
  });

  it("ungültiges now → INVALID_INPUT", async () => {
    await issue("2026-05");
    const q = { propertyId: fx.property.id, unitId: fx.units[1].id };
    await expect(quotaStatement({ tenantId: t.tenantId }, q, db!, { now: new Date(NaN) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reembolso parcial AUSGANG fora de refundAndCancel: −60 depois +20, saldo 20, quota continua ISSUED", async () => {
    await issue("2026-05");
    const c1 = await chargeOf(fx.units[1].id, "2026-05");
    await pay(c1.id, 60, utc(2026, 5, 5));
    await recordPayment({ tenantId: t.tenantId, chargeId: c1.id, date: utc(2026, 5, 20), amount: 20, direction: "AUSGANG" }, db!);
    const q = { propertyId: fx.property.id, unitId: fx.units[1].id };
    const s = await quotaStatement({ tenantId: t.tenantId }, q, db!, { now: NOW });
    expect(s.entries.map((e) => [e.kind, e.direction ?? null, e.effect, e.running])).toEqual([
      ["CHARGE", null, 60, 60],
      ["PAYMENT", "EINGANG", -60, 0],
      ["PAYMENT", "AUSGANG", 20, 20],
    ]);
    expect(s.entries[0].status).toBe("ISSUED");
    expect((await db!.charge.findUniqueOrThrow({ where: { id: c1.id } })).status).toBe("ISSUED");
    expect(s.balance).toBe(20);
    expect(s.overdueTotal).toBe(20);
    // antes do vencimento: aberto, mas não vencido
    expect((await quotaStatement({ tenantId: t.tenantId }, q, db!, { now: utc(2026, 5, 1) })).overdueTotal).toBe(0);
  });
});
