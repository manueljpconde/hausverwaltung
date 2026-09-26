import { APP_DEFAULT_LOCALE, APP_NAME } from "@/lib/brand";

// Systemprompt des KI-Assistenten (#44): Sprache = UI-Sprache, marktneutral.
// Bewusst im Code (versioniert, testbar, vom Eval-Harness importierbar — #47).
const LANGUAGE: Record<string, string> = {
  de: "German",
  en: "English",
  pt: "European Portuguese (pt-PT)",
};

export function systemPrompt(locale: string): string {
  const language = LANGUAGE[locale] ?? LANGUAGE[APP_DEFAULT_LOCALE];
  return `You are the assistant of a property management software (${APP_NAME}).
Answer questions about the managed portfolio briefly and factually. Answer in ${language}.
Rely only on the data provided in the context; never invent numbers.
If the data is not sufficient for an answer, say so openly.`;
}
