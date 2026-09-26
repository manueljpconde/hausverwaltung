import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { systemPrompt } from "@/lib/ai-prompt";

// KI-Adapter. Unterstützt Anthropic (Claude) und beliebige OpenAI-kompatible
// Anbieter (OpenAI, OpenRouter → Hermes/Llama/…, Groq, Ollama, LM Studio …)
// über Basis-URL. Config kommt aus der Mandanten-Konfiguration, fällt sonst auf
// Umgebungsvariablen zurück. Ohne Schlüssel liefern die Aufrufer eine
// regelbasierte Antwort — die App läuft voll.

export type AiProvider = "anthropic" | "openai";

export interface AiConfig {
  provider?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
}

function resolveProvider(cfg?: AiConfig): AiProvider {
  if (cfg?.provider === "openai" || cfg?.provider === "anthropic") return cfg.provider;
  if (cfg?.baseUrl) return "openai";
  return "anthropic";
}
function resolveKey(cfg?: AiConfig): string | undefined {
  return cfg?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || undefined;
}
function resolveModel(cfg?: AiConfig): string {
  if (cfg?.model) return cfg.model;
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  return resolveProvider(cfg) === "openai" ? "gpt-4o-mini" : "claude-opus-4-8";
}

export function isAiConfigured(cfg?: AiConfig): boolean {
  return !!resolveKey(cfg);
}

async function anthropicChat(cfg: AiConfig, apiKey: string, system: string, user: string, maxTokens: number): Promise<string> {
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: resolveModel(cfg),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function openaiChat(cfg: AiConfig, apiKey: string, system: string, user: string, maxTokens: number): Promise<string> {
  const client = new OpenAI({ apiKey, baseURL: cfg.baseUrl || undefined });
  const res = await client.chat.completions.create({
    model: resolveModel(cfg),
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}

/** Frage an die KI, angereichert mit einem Bestands-Kontext; Antwort in der UI-Sprache. */
export async function askAssistant(context: string, question: string, locale: string, cfg?: AiConfig): Promise<string> {
  const apiKey = resolveKey(cfg);
  if (!apiKey) throw new Error("Kein API-Schlüssel konfiguriert");
  const user = `Portfolio context (JSON):\n${context}\n\nQuestion: ${question}`;
  const system = systemPrompt(locale);
  return resolveProvider(cfg) === "openai"
    ? openaiChat(cfg!, apiKey, system, user, 1024)
    : anthropicChat(cfg ?? {}, apiKey, system, user, 1024);
}

/** Test-Aufruf für die Einstellungen: kurze Anfrage, wirft bei Fehler. */
export async function pingAi(cfg: AiConfig): Promise<string> {
  const apiKey = resolveKey(cfg);
  if (!apiKey) throw new Error("Kein API-Schlüssel konfiguriert");
  return resolveProvider(cfg) === "openai"
    ? openaiChat(cfg, apiKey, systemPrompt("en"), "Reply only with: OK", 16)
    : anthropicChat(cfg, apiKey, systemPrompt("en"), "Reply only with: OK", 16);
}
