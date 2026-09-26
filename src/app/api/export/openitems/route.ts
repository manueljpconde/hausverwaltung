import { auth } from "@/auth";
import { actingTenantId } from "@/lib/acting-tenant";
import { prisma } from "@/lib/prisma";
import { toCsv, csvResponse } from "@/lib/csv";
import { ALLOCATIONS_FOR_BALANCE, chargeBalance, chargeLease, chargeSubject } from "@/lib/charges";

export async function GET() {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  const leaseInclude = { unit: { include: { building: { include: { property: true } } } } };
  const charges = await prisma.charge.findMany({
    where: { tenantId: (await actingTenantId(session.user)) },
    include: {
      allocations: ALLOCATIONS_FOR_BALANCE,
      lease: { include: leaseInclude },
      areaAllocation: { select: { label: true, lease: { include: leaseInclude } } },
      quotaDebtorSnapshot: {
        select: { person: { select: { firstName: true, lastName: true } }, line: { select: { unit: { select: { label: true } } } } },
      },
    },
    orderBy: { dueDate: "asc" },
  });

  const rows = charges
    .map((c) => ({ c, open: chargeBalance(c).open, lease: chargeLease(c) }))
    .filter((x) => x.open > 0.001)
    .map(({ c, open, lease }) => [
      lease ? `${lease.unit.building.property.name} · ${chargeSubject(c)}` : chargeSubject(c),
      c.type,
      c.period.toISOString().slice(0, 10),
      c.dueDate.toISOString().slice(0, 10),
      Number(c.amount).toFixed(2).replace(".", ","),
      open.toFixed(2).replace(".", ","),
    ]);
  return csvResponse("offene-posten.csv", toCsv(["Einheit", "Art", "Zeitraum", "Faellig", "Betrag", "Offen"], rows));
}
