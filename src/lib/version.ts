// Anzeige-Version der App. Werte werden zur Build-Zeit über next.config injiziert.
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
export const APP_BUILD = process.env.NEXT_PUBLIC_APP_BUILD || "dev";
export const APP_SHA = process.env.NEXT_PUBLIC_APP_SHA || "";

/** z. B. "v0.1.0 · Build 42" */
export const APP_VERSION_LABEL = `v${APP_VERSION} · Build ${APP_BUILD}`;
/** ausführlich für title/Tooltip, z. B. "v0.1.0 · Build 42 · a1b2c3d" */
export const APP_VERSION_FULL = APP_SHA ? `${APP_VERSION_LABEL} · ${APP_SHA}` : APP_VERSION_LABEL;

// AGPL-3.0 §13: Quellcode dieses Forks für genau die laufende Version anbieten.
export const SOURCE_REPO = "https://github.com/manueljpconde/hausverwaltung";
export const sourceUrl = (sha: string) => (sha ? `${SOURCE_REPO}/tree/${sha}` : SOURCE_REPO);
export const licenseUrl = (sha: string) => `${SOURCE_REPO}/blob/${sha || "main"}/LICENSE`;
export const SOURCE_URL = sourceUrl(APP_SHA);
export const LICENSE_URL = licenseUrl(APP_SHA);
