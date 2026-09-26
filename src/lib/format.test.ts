import { describe, expect, it } from "vitest";
import { date, money, toBcp47 } from "./format";

describe("toBcp47", () => {
  it("maps UI locales to regional tags", () => {
    expect(toBcp47("de")).toBe("de-DE");
    expect(toBcp47("en")).toBe("en-US");
    expect(toBcp47("pt")).toBe("pt-PT");
  });

  it("passes through BCP-47 tags", () => {
    expect(toBcp47("en-GB")).toBe("en-GB");
    expect(toBcp47("pt-PT")).toBe("pt-PT");
  });

  it("keeps iso as a sentinel (date() short-circuits before Intl)", () => {
    expect(toBcp47("iso")).toBe("iso");
  });

  it("falls back to en-US for unknown short codes", () => {
    expect(toBcp47("fr")).toBe("en-US");
  });
});

describe("money / date with pt", () => {
  it("formats EUR with pt-PT separators", () => {
    const pt = money(1234.56, "pt");
    const en = money(1234.56, "en");
    expect(pt).toContain(",");
    expect(pt).toContain("€");
    expect(pt).not.toBe(en);
    // en-US uses a decimal point; pt-PT uses a decimal comma
    expect(en).toMatch(/1[,.]234\.56|€1,234\.56/);
    expect(pt).toMatch(/1234,56|1\.234,56/);
  });

  it("formats dates with pt-PT and iso", () => {
    const d = new Date(Date.UTC(2026, 8, 26));
    expect(date(d, "iso")).toBe("2026-09-26");
    expect(date(d, "pt")).toMatch(/26/);
  });
});
