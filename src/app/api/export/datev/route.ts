import { auth } from "@/auth";
import { actingTenantId } from "@/lib/acting-tenant";
import { prisma } from "@/lib/prisma";
import { roleAllows } from "@/lib/rbac";
import { toDatevExtf, type DatevRow } from "@/lib/adapters/datev";
import { paymentChargeType } from "@/lib/charges";

export async function GET() {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });
  if (!roleAllows(session.user.role, ["VERWALTER", "BUCHHALTUNG"]))
    return new Response("Forbidden", { status: 403 });

  const payments = await prisma.payment.findMany({
    where: { tenantId: (await actingTenantId(session.user)) },
    include: { allocations: { select: { charge: { select: { type: true } } } } },
    orderBy: { date: "asc" },
  });

  const rows: DatevRow[] = payments.map((p) => {
    const chargeType = paymentChargeType(p.allocations);
    return {
      amount: Number(p.amount),
      debitCredit: p.direction === "EINGANG" ? "S" : "H",
      account: "1200", // Bank
      contraAccount: "8000", // Erlöse (Platzhalter-Kontenrahmen)
      date: p.date.toISOString().slice(0, 10),
      text: p.reference ?? (chargeType === "MIXED" ? "Mehrere Sollstellungen" : chargeType ?? "Zahlung"),
      invoiceField: p.reference ?? undefined,
    };
  });

  const now = new Date();
  const year = rows.length ? Number(rows[0].date.slice(0, 4)) : now.getUTCFullYear();
  const extf = toDatevExtf(rows, {
    wjBeginn: new Date(Date.UTC(year, 0, 1)),
    datumVon: new Date(Date.UTC(year, 0, 1)),
    datumBis: new Date(Date.UTC(year, 11, 31)),
    bezeichnung: `Buchungsstapel ${year}`,
    now,
  });

  // DATEV erwartet Windows-1252 (ANSI), nicht UTF-8.
  const buf = Buffer.from(extf, "latin1");
  return new Response(buf, {
    headers: {
      "Content-Type": "text/csv; charset=windows-1252",
      "Content-Disposition": `attachment; filename="EXTF_Buchungsstapel.csv"`,
    },
  });
}
