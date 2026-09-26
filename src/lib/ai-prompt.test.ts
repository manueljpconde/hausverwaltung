import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { systemPrompt } from "./ai-prompt";

// #44: Die KI antwortet in der Sprache der Oberfläche, marktneutral formuliert.
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("KI-Systemprompt je Sprache (#44)", () => {
  it("pt verlangt europäisches Portugiesisch und nennt kein Deutsch", () => {
    const p = systemPrompt("pt");
    expect(p).toMatch(/European Portuguese \(pt-PT\)/);
    expect(p).not.toMatch(/deutsch|german/i);
  });

  it("de → Deutsch, en → Englisch, Unbekanntes → Standardsprache der Marke", () => {
    expect(systemPrompt("de")).toMatch(/Answer in German\./);
    expect(systemPrompt("en")).toMatch(/Answer in English\./);
    expect(systemPrompt("xx")).toBe(systemPrompt("pt"));
  });

  it("gleiche Leitplanken in jeder Sprache, marktneutral", () => {
    for (const l of ["de", "en", "pt"]) {
      const p = systemPrompt(l);
      expect(p).toMatch(/only on the data provided/);
      expect(p).toMatch(/never invent numbers/);
      expect(p).toMatch(/say so/);
      expect(p).not.toMatch(/German property|deutschen Hausverwaltung/i);
    }
  });

  it("Server-Actions geben die Sprache der Anfrage weiter, keine festen deutschen Texte", () => {
    const src = read("src/server/actions/ai.ts");
    expect(src).toMatch(/getLocale\(\)/);
    expect(src.match(/askAssistant\(\s*JSON\.stringify\(ctx\),[\s\S]*?,\s*locale,\s*aiCfg,?\s*\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/Bitte eine Frage|KI-Anfrage fehlgeschlagen|KI-Assistent nicht konfiguriert|Kein Objekt/);
  });

  it("neue Texte gibt es in de, en und pt", () => {
    const keys = ["emptyQuestion", "failed", "noProperty", "fallbackSummary", "fallbackStatement", "fallbackStatementUnit", "balanceCredit", "balanceDue"];
    for (const l of ["de", "en", "pt"]) {
      const a = JSON.parse(read(`messages/${l}.json`)).assistant;
      for (const k of keys) expect(a[k], `${l}.assistant.${k}`).toBeTruthy();
    }
  });
});
