// #52 R2: reine Berechnung der Quoten — nur ganze Cent, keine DB.
import { createHash } from "node:crypto";
import { QuotaError } from "./errors";

export function allocateCents(totalCents: number, parts: { id: string; weight: number }[]) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new QuotaError("INVALID_INPUT", "totalCents");
  const sumW = parts.reduce((s, p) => s + p.weight, 0);
  // Gewichte sind mea, share oder 1 — immer ganzzahlig; der Rest-Vergleich (%) setzt das voraus.
  if (parts.length === 0 || sumW <= 0 || parts.some((p) => !Number.isSafeInteger(p.weight) || p.weight < 0)) throw new QuotaError("INVALID_INPUT", "weights");
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
  if (!Number.isSafeInteger(annualCents) || annualCents < 0) throw new QuotaError("INVALID_INPUT", "annualCents");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new QuotaError("INVALID_INPUT", "month");
  const base = Math.round(annualCents / 12);
  if (month < 12) return base;
  const rest = annualCents - 11 * base;
  if (rest < 0) throw new QuotaError("INVALID_INPUT", "annual too small");
  return rest;
}

type Method = "PERMILLAGE" | "FIXED" | "CUSTOM";
export function computeLines(input: { totalCents: number; method: Method; units: { id: string; mea: number | null }[]; meaTotal: number; custom?: Record<string, number>; annualCents?: number }) {
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents < 0) throw new QuotaError("INVALID_INPUT", "totalCents");
  const units = [...input.units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (units.length === 0) throw new QuotaError("INVALID_INPUT", "keine Frações");
  const unitIds = units.map((u) => u.id);
  if (new Set(unitIds).size !== unitIds.length) throw new QuotaError("INVALID_INPUT", "doppelte unitId");
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
  // Object.hasOwn statt `in`: `in` liest auch geerbte Prototype-Eigenschaften (z. B. unitId "constructor").
  const missing = units.filter((u) => !Object.hasOwn(custom, u.id)).map((u) => u.id);
  const foreign = keys.filter((k) => !ids.has(k));
  const invalid = keys.filter((k) => !Number.isSafeInteger(custom[k]) || custom[k] < 0);
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
    if (!Number.isSafeInteger(h.share) || h.share <= 0 || h.share > 1000) return { error: `share inválido para ${h.personId}` };
    if (byPerson.has(h.personId)) return { error: `intervalos sobrepostos para ${h.personId}` };
    byPerson.set(h.personId, h.share);
  }
  const total = [...byPerson.values()].reduce((a, b) => a + b, 0);
  if (total !== 1000) return { error: `soma das quotas-partes = ${total}` };
  return [...byPerson.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([personId, share]) => ({ personId, share }));
}

export function requestKey(r: { kind: string; period: Date; method: string; dueDate: Date; asOf: Date; totalCents: number; custom?: Record<string, number>; resolutionId?: string | null; description?: string | null }) {
  // JSON.stringify statt "k=v,"-Join: ein Schlüssel wie "a=1,b" wäre sonst mit {a:1,b:2} verwechselbar.
  const customJson = r.custom ? JSON.stringify(Object.keys(r.custom).sort().map((k) => [k, r.custom![k]])) : "";
  const customHash = customJson ? createHash("sha256").update(customJson).digest("hex") : "";
  return [r.kind, r.period.toISOString(), r.method, r.dueDate.toISOString(), r.asOf.toISOString(), r.totalCents, customHash, r.resolutionId ?? "", r.description ?? ""].join("|");
}
