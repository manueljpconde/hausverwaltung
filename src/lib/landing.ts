import { APP_SLUG } from "@/lib/brand";

// PT-Landingpage (#33): Konstanten der Seite. Texte in messages/pt.json → landing.

/** Kontakt auf crmware.pt; Attribution über den Referrer-Ursprung, UTM zusätzlich. */
export const LANDING_CTA_URL = "https://crmware.pt/pt/contact?utm_source=realestate&utm_medium=landing";

export const LANDING_FEATURES = [
  { key: "rental", icon: "file-text" },
  { key: "condo", icon: "users" },
  { key: "operations", icon: "clock" },
  { key: "portal", icon: "contact" },
] as const;

export const LANDING_TRUST = [
  { key: "hosting", icon: "server" },
  { key: "access", icon: "shield-check" },
  { key: "language", icon: "circle-check" },
  { key: "openSource", icon: "git-branch" },
  { key: "api", icon: "link" },
] as const;

export const landingIcon = (name: string) => `/brand/${APP_SLUG}/icons/${name}.svg`;

export const LANDING_SCREENSHOT = `/brand/${APP_SLUG}/landing/dashboard.webp`;

/** Standbild zu einem Hintergrundvideo: gleicher Pfad, Endung .jpg. */
export const posterFor = (videoUrl: string) => videoUrl.replace(/\.(mp4|webm)$/i, ".jpg");
