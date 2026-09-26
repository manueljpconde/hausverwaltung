import type { TenantMarket } from "@prisma/client";

export type { TenantMarket };

export function isPtMarket(market: TenantMarket | null | undefined): boolean {
  return market === "PT";
}

/** i18n key for property management type under the tenant market. */
export function managementTypeMessageKey(market: TenantMarket): "managementType" | "managementTypePt" {
  return market === "PT" ? "managementTypePt" : "managementType";
}

/** Nav label key for the HOA / WEG module. */
export function wegNavKey(market: TenantMarket): "nav.weg" | "nav.condominio" {
  return market === "PT" ? "nav.condominio" : "nav.weg";
}

/** Heizkosten-Hinweise beziehen sich auf die deutsche HeizkostenV — im PT-Markt nicht anwendbar (#25). */
export function showHeatingCostNotes(market: TenantMarket | null | undefined): boolean {
  return market !== "PT";
}
