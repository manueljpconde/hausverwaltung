// #52: einzige Formel für den Saldo einer Sollstellung und für „wer/was" sie betrifft.
type Decimalish = number | string | { toString(): string };
const num = (v: Decimalish) => Number(typeof v === "number" ? v : v.toString());
const cents = (v: number) => Math.round(v * 100) / 100;

export const ALLOCATIONS_FOR_BALANCE = { select: { amount: true, payment: { select: { direction: true } } } } as const;

export type BalanceInput = {
  amount: Decimalish;
  status: "ISSUED" | "CANCELLED";
  allocations: { amount: Decimalish; payment: { direction: "EINGANG" | "AUSGANG" } }[];
};

export function chargeBalance(c: BalanceInput) {
  let incoming = 0;
  let outgoing = 0;
  for (const a of c.allocations) {
    if (a.payment.direction === "AUSGANG") outgoing += num(a.amount);
    else incoming += num(a.amount);
  }
  const open = c.status === "CANCELLED" ? 0 : num(c.amount) - incoming + outgoing;
  return { incoming: cents(incoming), outgoing: cents(outgoing), paid: cents(incoming - outgoing), open: cents(open) };
}

// Flächen-Sollstellungen tragen keinen leaseId mehr; der Vertrag hängt an der Teilfläche.
export function chargeLease<L>(c: { lease?: L | null; areaAllocation?: { lease: L | null } | null }): L | null {
  return c.lease ?? c.areaAllocation?.lease ?? null;
}

type SubjectInput = {
  lease?: { unit: { label: string } } | null;
  areaAllocation?: { label: string | null; lease: { unit: { label: string } } | null } | null;
  quotaDebtorSnapshot?: { person: { firstName: string; lastName: string }; line: { unit: { label: string } } } | null;
};

export function chargeSubject(c: SubjectInput): string {
  if (c.quotaDebtorSnapshot) {
    const s = c.quotaDebtorSnapshot;
    return `${s.line.unit.label} · ${s.person.firstName} ${s.person.lastName}`;
  }
  if (c.areaAllocation) return c.areaAllocation.label ?? c.areaAllocation.lease?.unit.label ?? "";
  return c.lease?.unit.label ?? "";
}

// Art(en) der Sollstellungen einer Zahlung: eine → diese, mehrere → MIXED, keine → null.
export function paymentChargeType(allocations: { charge: { type: string } }[]): string | "MIXED" | null {
  const types = new Set(allocations.map((a) => a.charge.type));
  if (types.size === 0) return null;
  return types.size === 1 ? [...types][0] : "MIXED";
}
