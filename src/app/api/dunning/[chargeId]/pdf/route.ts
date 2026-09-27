import { auth } from "@/auth";
import { actingTenantId } from "@/lib/acting-tenant";
import { roleAllows } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { simplePdf } from "@/lib/pdf";
import { dunningDocument } from "@/lib/dunning";
import { ALLOCATIONS_FOR_BALANCE, chargeBalance, chargeLease, chargeSubject } from "@/lib/charges";

// Mahnung / Zahlungserinnerung zu einer Sollstellung direkt als PDF (statt der
// HTML-Vorschauseite; umgeht auch das Darkmode-Darstellungsproblem). Spiegelt
// die zuletzt erstellte Mahnstufe wider.
export async function GET(_req: Request, { params }: { params: Promise<{ chargeId: string }> }) {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });
  if (!roleAllows(session.user.role, ["VERWALTER", "BUCHHALTUNG"])) return new Response("Forbidden", { status: 403 });

  const { chargeId } = await params;
  const tenantId = await actingTenantId(session.user);
  const leaseInclude = {
    unit: { include: { building: { include: { property: { include: { tenant: { select: { name: true } } } } } } } },
    renters: { include: { person: true } },
  };
  const charge = await prisma.charge.findFirst({
    where: { id: chargeId, tenantId },
    include: {
      dunnings: { orderBy: { level: "desc" }, take: 1 },
      allocations: ALLOCATIONS_FOR_BALANCE,
      lease: { include: leaseInclude },
      areaAllocation: { select: { label: true, lease: { include: leaseInclude } } },
      quotaDebtorSnapshot: {
        select: { person: { select: { firstName: true, lastName: true } }, line: { select: { unit: { select: { label: true } } } } },
      },
    },
  });
  const lease = charge ? chargeLease(charge) : null;
  if (!charge || !lease) return new Response("Not found", { status: 404 });

  const { open } = chargeBalance(charge);
  const dun = charge.dunnings[0];
  const property = lease.unit.building.property;
  const renter = lease.renters[0]?.person;

  const doc = dunningDocument({
    level: dun?.level ?? 1,
    propertyName: property.name,
    unitLabel: chargeSubject(charge),
    renterName: renter ? `${renter.firstName} ${renter.lastName}` : "",
    tenantName: property.tenant.name,
    chargeTypeLabel: charge.type,
    period: charge.period,
    dueDate: charge.dueDate,
    open,
    fee: dun ? Number(dun.fee) : 0,
  });

  const pdf = simplePdf(doc.title, doc.lines);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${doc.title.replace(/[^\x20-\x7e]/g, "_")}.pdf"`,
    },
  });
}
