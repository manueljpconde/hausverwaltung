import { auth } from "@/auth";
import { actingTenantId } from "@/lib/acting-tenant";
import { prisma } from "@/lib/prisma";
import { roleAllows } from "@/lib/rbac";
import { toPain008, type SepaEntry } from "@/lib/adapters/sepa";
import { APP_NAME, APP_SLUG } from "@/lib/brand";
import { chargeBalance } from "@/lib/charges";
import { chargesForLeases } from "@/lib/portal-charges";

export async function GET() {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });
  if (!roleAllows(session.user.role, ["VERWALTER", "BUCHHALTUNG"]))
    return new Response("Forbidden", { status: 403 });

  const tenantId = (await actingTenantId(session.user));
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

  const mandates = await prisma.sepaMandate.findMany({
    where: { tenantId, active: true },
    include: {
      person: {
        include: {
          renters: { select: { leaseId: true } },
        },
      },
    },
  });

  const entries: SepaEntry[] = [];
  for (const m of mandates) {
    const leaseIds = m.person.renters.map((r) => r.leaseId);
    const charges = await chargesForLeases(tenantId, leaseIds);
    let open = 0;
    for (const c of charges) {
      open += chargeBalance(c).open;
    }
    open = Math.round(open * 100) / 100;
    if (open > 0) {
      entries.push({
        mandateRef: m.mandateRef,
        iban: m.iban,
        debtorName: `${m.person.firstName} ${m.person.lastName}`,
        amount: open,
        reference: `Einzug ${tenant?.name ?? APP_NAME}`,
      });
    }
  }

  const xml = toPain008(entries, {
    creditorName: tenant?.name ?? APP_NAME,
    creditorIban: "DE00000000000000000000",
    creditorId: "DE00ZZZ00000000000",
    msgId: `${APP_SLUG.toUpperCase()}-${Date.now()}`,
    createdAt: new Date().toISOString(),
  });

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="sepa-lastschrift.xml"`,
    },
  });
}
