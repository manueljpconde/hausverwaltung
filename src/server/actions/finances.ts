"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { requireWriter } from "@/lib/rbac";
import {
  accountSchema,
  chargeSchema,
  paymentSchema,
  mandateSchema,
  generateSchema,
  type ActionState,
} from "@/lib/schemas";
import { parseCamt053 } from "@/lib/adapters/bankImport";
import { ensureDefaultAccounts } from "@/lib/accounts";
import { generateMonthlyCharges } from "@/lib/charge-generation";
import { audit } from "@/lib/audit";
import { simplePdf } from "@/lib/pdf";
import { saveFile } from "@/lib/storage";
import { money } from "@/lib/format";
import { dunningDocument } from "@/lib/dunning";
import { chargeHasHistory, deletePaymentWithAllocations, matchOpenCharge, openChargesForMatching, PaymentError, recordPayment, unappliedPart } from "@/lib/payments";

// Standard-Kontenrahmen für den Mandanten anlegen (idempotent).
export async function seedDefaultAccounts(): Promise<void> {
  const user = await requireWriter();
  await ensureDefaultAccounts(prisma, user.tenantId);
  revalidatePath("/", "layout");
}

function fail(msg?: string): ActionState {
  return { error: msg ?? "Ungültige Eingabe" };
}
function done(): ActionState {
  revalidatePath("/", "layout");
  return { ok: true };
}

// --- Account ---
export async function createAccount(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const r = accountSchema.safeParse(Object.fromEntries(fd));
  if (!r.success) return fail(r.error.issues[0]?.message);
  await prisma.account.create({ data: { ...r.data, tenantId: user.tenantId } });
  return done();
}
export async function updateAccount(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const id = String(fd.get("id") ?? "");
  const r = accountSchema.safeParse(Object.fromEntries(fd));
  if (!r.success) return fail(r.error.issues[0]?.message);
  const acc = await prisma.account.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true } });
  if (!acc) return fail("Konto nicht gefunden");
  await prisma.account.update({ where: { id: acc.id }, data: { name: r.data.name, type: r.data.type, iban: r.data.iban ?? null } });
  return done();
}
export async function deleteAccount(fd: FormData): Promise<void> {
  const user = await requireWriter();
  await prisma.account.deleteMany({ where: { id: String(fd.get("id") ?? ""), tenantId: user.tenantId } });
  revalidatePath("/", "layout");
}

// --- Charge (manuell) ---
export async function createCharge(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const r = chargeSchema.safeParse(Object.fromEntries(fd));
  if (!r.success) return fail(r.error.issues[0]?.message);
  await prisma.charge.create({ data: { ...r.data, tenantId: user.tenantId } });
  return done();
}
export async function deleteCharge(fd: FormData): Promise<void> {
  const user = await requireWriter();
  const id = String(fd.get("id") ?? "");
  if (await chargeHasHistory(user.tenantId, id)) throw new Error("Sollstellung mit Zahlungen oder Mahnungen kann nicht gelöscht werden");
  await prisma.charge.deleteMany({ where: { id, tenantId: user.tenantId } });
  revalidatePath("/", "layout");
}

// --- Sollstellungslauf: Miete für aktive Verträge eines Monats ---
export async function generateCharges(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const r = generateSchema.safeParse(Object.fromEntries(fd));
  if (!r.success) return fail(r.error.issues[0]?.message);
  const { created } = await generateMonthlyCharges(user.tenantId, r.data.month);
  revalidatePath("/", "layout");
  return { ok: true, error: created === 0 ? "Keine neuen Sollstellungen (bereits vorhanden)" : undefined };
}

// --- Payment ---
export async function createPayment(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const r = paymentSchema.safeParse(Object.fromEntries(fd));
  if (!r.success) return fail(r.error.issues[0]?.message);
  let res;
  try {
    res = await recordPayment({ ...r.data, tenantId: user.tenantId });
  } catch (e) {
    if (e instanceof PaymentError) return fail(e.message);
    throw e;
  }
  // Überzahlung: gebucht, aber nur bis zum offenen Betrag zugeordnet — dem Nutzer sagen, was übrig bleibt.
  const rest = unappliedPart(r.data.amount, res.allocated, r.data.chargeId);
  if (rest) {
    revalidatePath("/", "layout");
    const t = await getTranslations("finances");
    return { ok: true, message: t("partiallyApplied", { applied: rest.applied.toFixed(2), unapplied: rest.unapplied.toFixed(2) }) };
  }
  return done();
}
export async function deletePayment(fd: FormData): Promise<void> {
  const user = await requireWriter();
  await deletePaymentWithAllocations(user.tenantId, String(fd.get("id") ?? ""));
  revalidatePath("/", "layout");
}

// Kontobewegung: Notiz + verknüpfte Belege/Dokumente setzen (#23).
export async function updatePaymentDetails(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const id = String(fd.get("id") ?? "");
  const note = String(fd.get("note") ?? "").trim() || null;
  const documentIds = [...new Set(fd.getAll("documentIds").map(String).filter(Boolean))];

  const payment = await prisma.payment.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true } });
  if (!payment) return fail("Buchung nicht gefunden");
  if (documentIds.length) {
    const cnt = await prisma.document.count({ where: { tenantId: user.tenantId, id: { in: documentIds } } });
    if (cnt !== documentIds.length) return fail("Dokument nicht gefunden");
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { note, documents: { set: documentIds.map((docId) => ({ id: docId })) } },
  });
  return done();
}

// --- SEPA-Mandat ---
export async function createMandate(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const r = mandateSchema.safeParse(Object.fromEntries(fd));
  if (!r.success) return fail(r.error.issues[0]?.message);
  const p = await prisma.person.findFirst({ where: { id: r.data.personId, tenantId: user.tenantId }, select: { id: true } });
  if (!p) return fail("Person nicht gefunden");
  await prisma.sepaMandate.create({ data: { ...r.data, tenantId: user.tenantId } });
  return done();
}
export async function deleteMandate(fd: FormData): Promise<void> {
  const user = await requireWriter();
  await prisma.sepaMandate.deleteMany({ where: { id: String(fd.get("id") ?? ""), tenantId: user.tenantId } });
  revalidatePath("/", "layout");
}

// --- camt.053 Bankimport mit naivem Auto-Matching ---
export async function importCamt(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("Keine Datei");
  const accountId = String(fd.get("accountId") ?? "") || null;

  let entries;
  try {
    entries = parseCamt053(await file.text());
  } catch {
    return fail("camt.053 konnte nicht gelesen werden");
  }
  if (entries.length === 0) return fail("Keine Buchungen in der Datei");

  // offene Beträge je Sollstellung für Auto-Matching
  const open = await openChargesForMatching(user.tenantId);

  let matched = 0;
  for (const e of entries) {
    if (e.amount <= 0) continue; // Nullbetrag (z. B. Storno-Zeile) — nichts zu buchen
    const chargeId = e.direction === "EINGANG" ? matchOpenCharge(open, e.amount) : null;
    if (chargeId) matched++;
    await recordPayment({
      tenantId: user.tenantId,
      accountId,
      chargeId,
      date: new Date(e.date),
      amount: e.amount,
      direction: e.direction,
      reference: e.reference,
    });
  }
  revalidatePath("/", "layout");
  return { ok: true, error: `${entries.length} Buchungen, ${matched} zugeordnet` };
}

// --- Mahnung: nächste Stufe für überfällige Sollstellung ---
const DUNNING_FEE: Record<number, number> = { 1: 0, 2: 5, 3: 10 };
const DUNNING_MIN_DAYS = 14; // Mindestabstand zwischen zwei Mahnstufen
export async function createDunning(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const chargeId = String(fd.get("chargeId") ?? "");
  const charge = await prisma.charge.findFirst({
    where: { id: chargeId, tenantId: user.tenantId },
    include: { dunnings: { orderBy: { date: "desc" }, take: 1 } },
  });
  if (!charge) return fail("Sollstellung nicht gefunden");

  // Nächste Stufe erst nach Ablauf der Frist seit der letzten Mahnung.
  const last = charge.dunnings[0];
  if (last) {
    const days = Math.floor((Date.now() - last.date.getTime()) / 86_400_000);
    if (days < DUNNING_MIN_DAYS) {
      const remaining = DUNNING_MIN_DAYS - days;
      return {
        error: `Letzte Mahnung vor ${days} Tag(en) erstellt. Nächste Mahnstufe frühestens in ${remaining} Tag(en) möglich.`,
      };
    }
  }

  const level = Math.min((last?.level ?? 0) + 1, 3);
  await prisma.dunningNotice.create({
    data: { tenantId: user.tenantId, chargeId, level, fee: DUNNING_FEE[level] ?? 0 },
  });
  revalidatePath("/", "layout");
  return { ok: true };
}

// --- Mahnung als PDF an den Mieter mailen (Entwurf im Postausgang) + Ablage ---
export async function emailDunning(_p: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireWriter();
  const chargeId = String(fd.get("chargeId") ?? "");
  const charge = await prisma.charge.findFirst({
    where: { id: chargeId, tenantId: user.tenantId },
    include: {
      payments: { select: { amount: true } },
      dunnings: { orderBy: { level: "desc" }, take: 1 },
      lease: {
        include: {
          unit: { include: { building: { include: { property: { include: { tenant: true } } } } } },
          renters: { include: { person: true } },
        },
      },
    },
  });
  if (!charge || !charge.lease) return fail("Sollstellung nicht gefunden");

  const paid = charge.payments.reduce((a, p) => a + Number(p.amount), 0);
  const open = Number(charge.amount) - paid;
  const dun = charge.dunnings[0];
  const fee = dun ? Number(dun.fee) : 0;
  const level = dun?.level ?? 1;
  const property = charge.lease.unit.building.property;
  const renter = charge.lease.renters[0]?.person;
  if (!renter?.email) return fail("Kein Mieter mit E-Mail-Adresse hinterlegt.");

  const built = dunningDocument({
    level,
    propertyName: property.name,
    unitLabel: charge.lease.unit.label,
    renterName: `${renter.firstName} ${renter.lastName}`,
    tenantName: property.tenant.name,
    chargeTypeLabel: charge.type,
    period: charge.period,
    dueDate: charge.dueDate,
    open,
    fee,
  });
  const title = built.title;
  const total = open + fee;
  const pdf = simplePdf(title, built.lines);
  const name = `${title} - ${charge.lease.unit.label}.pdf`;
  const storageKey = await saveFile(pdf, name);
  const doc = await prisma.document.create({
    data: {
      tenantId: user.tenantId,
      propertyId: property.id,
      name,
      category: "SONSTIGES",
      mime: "application/pdf",
      size: pdf.length,
      storageKey,
    },
  });
  await prisma.emailMessage.create({
    data: {
      tenantId: user.tenantId,
      toAddress: renter.email,
      subject: `${title} · ${property.name}`,
      body: `Sehr geehrte/r ${renter.firstName} ${renter.lastName},\n\nanbei ${title.toLowerCase()} über ${money(total)}.\n\nMit freundlichen Grüßen\n${property.tenant.name}`,
      status: "ENTWURF",
      attachments: { create: [{ documentId: doc.id }] },
    },
  });
  await audit(user, "CREATE", "EmailMessage", null, `${title} ${charge.lease.unit.label}`);
  revalidatePath("/", "layout");
  return { ok: true };
}
