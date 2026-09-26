import { describe, expect, it } from "vitest";
import { isPtMarket, managementTypeMessageKey, wegNavKey } from "./market";

describe("market helpers", () => {
  it("isPtMarket", () => {
    expect(isPtMarket("PT")).toBe(true);
    expect(isPtMarket("DE")).toBe(false);
    expect(isPtMarket(null)).toBe(false);
  });

  it("message keys", () => {
    expect(managementTypeMessageKey("DE")).toBe("managementType");
    expect(managementTypeMessageKey("PT")).toBe("managementTypePt");
    expect(wegNavKey("DE")).toBe("nav.weg");
    expect(wegNavKey("PT")).toBe("nav.condominio");
  });
});
