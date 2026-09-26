"use server";

import { getLocale, getTranslations } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/rbac";
import { isAiConfigured, askAssistant } from "@/lib/ai";
import { computeStatement } from "@/server/statements";
import { money } from "@/lib/format";

export type AssistantState = { answer?: string; configured?: boolean; error?: string };

/** Baut einen kompakten Bestands-Kontext (nur Kennzahlen, keine PII) für den Assistenten. */
async function buildContext(tenantId: string) {
  const now = new Date();
  const [properties, units, leases, charges, openTickets, dueMaintenance] = await Promise.all([
    prisma.property.findMany({ where: { tenantId }, select: { name: true, city: true, management: true } }),
    prisma.unit.findMany({ where: { tenantId }, select: { leases: { select: { startDate: true, endDate: true } } } }),
    prisma.lease.findMany({
      where: { tenantId, startDate: { lte: now }, OR: [{ endDate: null }, { endDate: { gte: now } }] },
      include: { components: { select: { amount: true } } },
    }),
    prisma.charge.findMany({ where: { tenantId }, include: { payments: { select: { amount: true } } } }),
    prisma.ticket.count({ where: { tenantId, status: { not: "ERLEDIGT" } } }),
    prisma.maintenanceContract.count({ where: { tenantId, nextDue: { lt: now } } }),
  ]);

  const occupied = units.filter((u) =>
    u.leases.some((l) => l.startDate <= now && (!l.endDate || l.endDate >= now)),
  ).length;
  const monthlyRent = leases.reduce(
    (a, l) => a + Number(l.rentCold) + l.components.reduce((s, c) => s + Number(c.amount), 0),
    0,
  );
  let totalOpen = 0;
  let overdue = 0;
  for (const c of charges) {
    const open = Number(c.amount) - c.payments.reduce((a, p) => a + Number(p.amount), 0);
    if (open > 0.001) {
      totalOpen += open;
      if (c.dueDate < now) overdue++;
    }
  }

  return {
    objekte: properties.length,
    einheiten: units.length,
    vermietet: occupied,
    leerstand: units.length - occupied,
    sollmieteMonatlich: Math.round(monthlyRent * 100) / 100,
    offenePostenSumme: Math.round(totalOpen * 100) / 100,
    ueberfaelligeForderungen: overdue,
    offeneTickets: openTickets,
    faelligeWartungen: dueMaintenance,
    objektliste: properties.map((p) => `${p.name} (${p.city}, ${p.management})`),
  };
}

export async function askAssistantAction(_prev: AssistantState, fd: FormData): Promise<AssistantState> {
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations("assistant");
  const question = String(fd.get("question") ?? "").trim();
  if (!question) return { error: t("emptyQuestion") };

  const ctx = await buildContext(user.tenantId);
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { aiProvider: true, aiBaseUrl: true, aiApiKey: true, aiModel: true },
  });
  const aiCfg = { provider: tenant?.aiProvider, baseUrl: tenant?.aiBaseUrl, apiKey: tenant?.aiApiKey, model: tenant?.aiModel };
  const configured = isAiConfigured(aiCfg);

  if (!configured) {
    // Regelbasierter Fallback ohne LLM: fasst die Kennzahlen zusammen.
    const answer = t("fallbackSummary", {
      properties: String(ctx.objekte),
      units: String(ctx.einheiten),
      occupied: String(ctx.vermietet),
      vacant: String(ctx.leerstand),
      rent: String(ctx.sollmieteMonatlich),
      open: String(ctx.offenePostenSumme),
      overdue: String(ctx.ueberfaelligeForderungen),
      tickets: String(ctx.offeneTickets),
      maintenance: String(ctx.faelligeWartungen),
    });
    return { answer, configured: false };
  }

  try {
    const answer = await askAssistant(JSON.stringify(ctx), question, locale, aiCfg);
    return { answer, configured: true };
  } catch (e) {
    // Anbieterfehler nur serverseitig protokollieren; der Nutzer bekommt die übersetzte Meldung.
    console.error("[ai] request failed:", e instanceof Error ? e.message : e);
    return { error: t("failed"), configured: true };
  }
}

/** Erklärt die Betriebskostenabrechnung eines Objekts/Jahres in Klartext. */
export async function explainStatement(_p: AssistantState, fd: FormData): Promise<AssistantState> {
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations("assistant");
  const propertyId = String(fd.get("propertyId") ?? "");
  const year = Number(fd.get("year")) || new Date().getFullYear();
  if (!propertyId) return { error: t("noProperty") };

  const st = await computeStatement(user.tenantId, propertyId, year);
  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { aiProvider: true, aiBaseUrl: true, aiApiKey: true, aiModel: true } });
  const aiCfg = { provider: tenant?.aiProvider, baseUrl: tenant?.aiBaseUrl, apiKey: tenant?.aiApiKey, model: tenant?.aiModel };

  const ctx = {
    objekt: st.property?.name,
    jahr: year,
    summeUmlagefaehig: st.totalUmlage,
    kosten: st.costs.map((c) => ({ typ: c.type, betrag: c.amount, schluessel: c.method, umlagefaehig: c.umlagefaehig })),
    einheiten: st.units.map((u) => ({ einheit: u.label, umgelegt: u.allocated, vorauszahlung: u.prepayment, saldo: u.balance })),
  };

  if (!isAiConfigured(aiCfg)) {
    const answer = [
      t("fallbackStatement", { year: String(year), property: ctx.objekt ?? "", total: money(st.totalUmlage) }),
      ...st.units.map((u) =>
        t("fallbackStatementUnit", {
          unit: u.label,
          allocated: money(u.allocated),
          prepayment: money(u.prepayment),
          balance: money(u.balance),
          state: t(u.balance >= 0 ? "balanceCredit" : "balanceDue"),
        }),
      ),
    ].join("\n");
    return { answer, configured: false };
  }
  try {
    const answer = await askAssistant(
      JSON.stringify(ctx),
      "Erkläre diese Betriebskostenabrechnung einem Mieter in einfachen, freundlichen Worten: was wurde nach welchem Schlüssel umgelegt, und wie kommt der Saldo je Einheit zustande. Kurz und verständlich.",
      locale,
      aiCfg,
    );
    return { answer, configured: true };
  } catch (e) {
    console.error("[ai] request failed:", e instanceof Error ? e.message : e);
    return { error: t("failed"), configured: true };
  }
}
