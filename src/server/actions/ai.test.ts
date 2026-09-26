import { describe, it, expect, vi, beforeEach } from "vitest";

// #44: Fehler des KI-Anbieters erreichen den Nutzer nie im Original (Sprache, interne Details).
vi.mock("next-intl/server", () => ({
  getLocale: async () => "pt",
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock("@/lib/rbac", () => ({ requireUser: async () => ({ id: "u1", tenantId: "t1" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    property: { findMany: async () => [] },
    unit: { findMany: async () => [] },
    lease: { findMany: async () => [] },
    charge: { findMany: async () => [] },
    ticket: { count: async () => 0 },
    maintenanceContract: { count: async () => 0 },
    tenant: { findUnique: async () => ({ aiProvider: "anthropic", aiBaseUrl: null, aiApiKey: "k", aiModel: null }) },
  },
}));
vi.mock("@/server/statements", () => ({
  computeStatement: async () => ({ property: { name: "P" }, costs: [], units: [], totalUmlage: 0 }),
}));
const providerError = new Error("401 {\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}");
vi.mock("@/lib/ai", () => ({
  isAiConfigured: () => true,
  askAssistant: async () => {
    throw providerError;
  },
}));

const { askAssistantAction, explainStatement } = await import("./ai");

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("KI-Server-Actions: Anbieterfehler (#44)", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("Assistent zeigt die übersetzte Meldung, protokolliert den Fehler nur serverseitig", async () => {
    const r = await askAssistantAction({}, form({ question: "Quantas frações?" }));
    expect(r).toEqual({ error: "assistant.failed", configured: true });
    expect(console.error).toHaveBeenCalled();
  });

  it("Abrechnungserklärung ebenso", async () => {
    const r = await explainStatement({}, form({ propertyId: "p1", year: "2026" }));
    expect(r).toEqual({ error: "assistant.failed", configured: true });
    expect(console.error).toHaveBeenCalled();
  });
});
