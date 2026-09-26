import { showHeatingCostNotes, type TenantMarket } from "@/lib/market";

/**
 * Heizkosten-Zeile im PDF der Betriebskostenabrechnung (#25): nur außerhalb des PT-Markts
 * (HeizkostenV ist deutsches Recht) und ohne feste Aufteilung — der Verbrauchsanteil ist
 * je Mandant und Kostenposition konfigurierbar.
 */
export function heatingPdfLine(market: TenantMarket | null | undefined): string | null {
  return showHeatingCostNotes(market)
    ? "Heiz-/Warmwasserkosten nach HeizkostenV anteilig nach Flaeche und Verbrauch verteilt."
    : null;
}
