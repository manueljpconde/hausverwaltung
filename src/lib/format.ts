/** Map UI locale (`de`/`en`/`pt`) or BCP-47 / `iso` to an Intl locale tag. */
export function toBcp47(fmt: string): string {
  if (fmt === "iso") return "iso";
  if (fmt === "de") return "de-DE";
  if (fmt === "en") return "en-US";
  if (fmt === "pt") return "pt-PT";
  if (fmt.includes("-")) return fmt;
  return "en-US";
}

export function money(value: number | string, locale = "de") {
  const n = typeof value === "string" ? Number(value) : value;
  return new Intl.NumberFormat(toBcp47(locale), {
    style: "currency",
    currency: "EUR",
  }).format(n);
}

// Datumsformat. `fmt` akzeptiert die UI-Sprache ("de"/"en"/"pt", Altverhalten), eine
// BCP-47-Locale ("de-DE", "en-GB", "en-US", "pt-PT") oder "iso" (YYYY-MM-DD). Das erlaubt
// ein vom UI unabhängiges Datumsformat (Mandanten-Einstellung, siehe getDateLocale).
export function date(value: Date | string | null | undefined, fmt = "de") {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (fmt === "iso") return d.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat(toBcp47(fmt)).format(d);
}
