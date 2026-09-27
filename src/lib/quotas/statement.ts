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

// opts.now: Stichtag für overdueTotal (Tests, reproduzierbare Auszüge); sonst die aktuelle Zeit.
export async function quotaStatement(ctx: { tenantId: string }, raw: StatementQuery, db: PrismaClient = prisma, opts: { now?: Date } = {}) {
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
  const now = opts.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new QuotaError("INVALID_INPUT", "now");
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
