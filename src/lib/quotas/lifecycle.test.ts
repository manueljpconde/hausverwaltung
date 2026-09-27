import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestTenant, describeDb, integrationDb as db } from "../test-db";
import { wegFixture } from "./fixtures";
import { issueQuotas } from "./issue";
import { Prisma, type PrismaClient } from "@prisma/client";
import { cancelAssessment, cancelAssessmentInTx, refundAndCancel, refundAndCancelInTx, reissueCharge, reissueChargeInTx, replaceDebtor, voidCharge } from "./lifecycle";
import { deletePaymentWithAllocations, deletePaymentWithAllocationsInTx, PaymentError, recordPayment, recordPaymentInTx } from "../payments";
import { clientFor, deferred, isPending, started, waitUntilBlocked } from "./concurrency-test-utils";

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
  it("refundAndCancelInTx: a transacção falha depois de escrever → rollback total", async () => {
    const { charges } = await issueMay();
    await recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: 40, direction: "EINGANG" }, db!);
    const before = { alloc: await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } }), audit: await db!.auditLog.count({ where: { tenantId: t.tenantId } }) };
    await expect(db!.$transaction(async (tx) => {
      await refundAndCancelInTx(tx, ctx(), charges[0].id, { date: new Date(), reason: "venda anulada" });
      throw new Error("injected");
    })).rejects.toThrow("injected");
    expect(await db!.payment.count({ where: { tenantId: t.tenantId, direction: "AUSGANG" } })).toBe(0);
    expect(await db!.paymentAllocation.count({ where: { tenantId: t.tenantId } })).toBe(before.alloc);
    expect((await db!.charge.findUniqueOrThrow({ where: { id: charges[0].id } })).status).toBe("ISSUED");
    expect(await db!.auditLog.count({ where: { tenantId: t.tenantId } })).toBe(before.audit);
  });

  it("refundAndCancel valida a entrada: accountId vazio e data inválida → INVALID_INPUT, nada escrito", async () => {
    const { charges } = await issueMay();
    await recordPayment({ tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: 40, direction: "EINGANG" }, db!);
    const before = await db!.payment.count({ where: { tenantId: t.tenantId } });
    await expect(refundAndCancel(ctx(), charges[0].id, { accountId: "", date: new Date(), reason: "venda anulada" }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(refundAndCancel(ctx(), charges[0].id, { date: new Date("x"), reason: "venda anulada" }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(refundAndCancel(ctx(), charges[0].id, { date: new Date(), reference: "r".repeat(141), reason: "venda anulada" }, db!)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await db!.payment.count({ where: { tenantId: t.tenantId } })).toBe(before);
    expect((await db!.charge.findUniqueOrThrow({ where: { id: charges[0].id } })).status).toBe("ISSUED");
  });

  it("reissueCharge duas vezes sobre a mesma original → ALREADY_ISSUED_CONFLICT, nada escrito", async () => {
    const { charges } = await issueMay();
    await voidCharge(ctx(), charges[0].id, "erro", db!);
    await reissueCharge(ctx(), charges[0].id, db!);
    const before = { charges: await db!.charge.count({ where: { tenantId: t.tenantId } }), audit: await db!.auditLog.count({ where: { tenantId: t.tenantId } }) };
    await expect(reissueCharge(ctx(), charges[0].id, db!)).rejects.toMatchObject({ code: "ALREADY_ISSUED_CONFLICT" });
    expect(await db!.charge.count({ where: { tenantId: t.tenantId, status: "ISSUED", quotaDebtorSnapshotId: charges[0].quotaDebtorSnapshotId } })).toBe(1);
    expect(await db!.charge.count({ where: { tenantId: t.tenantId } })).toBe(before.charges);
    expect(await db!.auditLog.count({ where: { tenantId: t.tenantId } })).toBe(before.audit);
  });

  it("charges de arrendamento: voidCharge e refundAndCancel sem snapshot nem assessment", async () => {
    const lease = await db!.lease.create({ data: { tenantId: t.tenantId, unitId: fx.units[0].id, startDate: new Date("2026-01-01"), rentCold: 500 } });
    const mk = (m: number) => db!.charge.create({ data: { tenantId: t.tenantId, leaseId: lease.id, type: "MIETE", period: new Date(Date.UTC(2026, m, 1)), dueDate: new Date(Date.UTC(2026, m, 3)), amount: 500 } });
    const c1 = await mk(4); const c2 = await mk(5);
    await voidCharge(ctx(), c1.id, "erro de emissão", db!);
    expect(await db!.charge.findUniqueOrThrow({ where: { id: c1.id } })).toMatchObject({ status: "CANCELLED", cancelReason: "erro de emissão" });
    expect(await db!.auditLog.count({ where: { tenantId: t.tenantId, entity: "Charge", entityId: c1.id } })).toBe(1);
    await recordPayment({ tenantId: t.tenantId, chargeId: c2.id, date: new Date(), amount: 500, direction: "EINGANG" }, db!);
    const r = await refundAndCancel(ctx(), c2.id, { date: new Date(), reason: "contrato anulado" }, db!);
    const out = await db!.payment.findUniqueOrThrow({ where: { id: r.paymentId! } });
    expect({ direction: out.direction, amount: Number(out.amount) }).toEqual({ direction: "AUSGANG", amount: 500 });
    expect((await db!.charge.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe("CANCELLED");
    expect(await db!.condominiumAssessment.count({ where: { tenantId: t.tenantId } })).toBe(0);
  });
});

describeDb("Ciclo de vida em concorrência, com gates (#52 R2)", () => {
  let dbA: PrismaClient, dbB: PrismaClient;
  beforeEach(async () => { dbA = clientFor("r2_life_a"); dbB = clientFor("r2_life_b"); t = await createTestTenant(); fx = await wegFixture(db!, t.tenantId); });
  afterEach(async () => { await t.cleanup(); await Promise.all([dbA.$disconnect(), dbB.$disconnect()]); });
  const RC = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 };

  /** Führt first(tx) in dbA aus und hält die Transaktion nach dem Sperren offen; startet second() in dbB,
   *  beweist, dass second blockiert, gibt frei und liefert beide Ergebnisse. */
  async function race<A>(first: (tx: Prisma.TransactionClient) => Promise<A>, second: () => Promise<unknown>) {
    const gate = deferred(); const locked = deferred();
    const a = dbA.$transaction(async (tx) => { const r = await first(tx); locked.resolve(); await gate.promise; return r; }, RC);
    await locked.promise;
    const b = second();
    await waitUntilBlocked(db!, "r2_life_b");
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
  it("recordPayment retido × replaceDebtor → bloqueia, depois HAS_PAYMENTS; nada trocado", async () => {
    const { charges } = await issueMay();
    const snap = await db!.quotaDebtorSnapshot.findFirstOrThrow({ where: { id: charges[0].quotaDebtorSnapshotId! } });
    const b = await db!.person.create({ data: { tenantId: t.tenantId, firstName: "B", lastName: "X" } });
    const snaps = await db!.quotaDebtorSnapshot.count({ where: { tenantId: t.tenantId } });
    const [a, r] = await race((tx) => recordPaymentInTx(tx, { tenantId: t.tenantId, chargeId: charges[0].id, date: new Date(), amount: 5, direction: "EINGANG" }),
      () => replaceDebtor(ctx(), snap.lineId, snap.personId, b.id, "devedor errado", dbB));
    expect(a.status).toBe("fulfilled");
    expect(r).toMatchObject({ status: "rejected", reason: { code: "HAS_PAYMENTS" } });
    expect((await db!.charge.findUniqueOrThrow({ where: { id: charges[0].id } })).status).toBe("ISSUED");
    expect(await db!.quotaDebtorSnapshot.count({ where: { tenantId: t.tenantId } })).toBe(snaps);
  }, 30000);

  it("reissueCharge retido (assessment ORDINARY CANCELLED) × alterar o plano → espera, depois recusado; plano igual", async () => {
    const { assessmentId, charges } = await issueMay();
    await cancelAssessment(ctx(), assessmentId, "refazer", db!);
    const [a, b] = await race((tx) => reissueChargeInTx(tx, ctx(), charges[0].id),
      () => started(dbB.economicPlan.update({ where: { id: fx.plan.id }, data: { totalAmount: 2400 } })));
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(String((b as PromiseRejectedResult).reason)).toContain("plan locked by issued ordinary assessments");
    expect(Number((await db!.economicPlan.findUniqueOrThrow({ where: { id: fx.plan.id } })).totalAmount)).toBe(1200);
    expect((await db!.condominiumAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).status).toBe("ISSUED");
  }, 30000);

  it("reissueCharge retido × emissão do mesmo mês → sem deadlock; a emissão repete a reactivada (mesma requestKey)", async () => {
    const { assessmentId, charges } = await issueMay();
    await cancelAssessment(ctx(), assessmentId, "refazer", db!);
    const [a, b] = await race((tx) => reissueChargeInTx(tx, ctx(), charges[0].id),
      () => issueQuotas(ctx(), { propertyId: fx.property.id, kind: "ORDINARY", month: "2026-05" }, dbB));
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "fulfilled", value: { assessmentId, created: false } });
    const issued = await db!.condominiumAssessment.findMany({ where: { tenantId: t.tenantId, kind: "ORDINARY", period: new Date(Date.UTC(2026, 4, 1)), status: "ISSUED" } });
    expect(issued.map((x) => x.id)).toEqual([assessmentId]);
  }, 30000);
});
