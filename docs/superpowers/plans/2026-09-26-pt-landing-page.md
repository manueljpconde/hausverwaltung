# PT Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a Portuguese lead-generation landing page for CrmWare at `https://realestate.crmware.pt/marketing`.

**Architecture:** A new top-level route `src/app/marketing/` with its own root layout (`lang="pt-PT"`) and a server-rendered page. Copy lives in `messages/pt.json` → `landing`; page constants (CTA URL, feature/trust lists, asset paths) live in `src/lib/landing.ts`; name/logo come from `src/lib/brand.ts`. The existing `BackgroundVideo` gains opt-in `poster`, `controls` and `mediaQuery` props. Caddy logs `/marketing` requests without personal data as the visit denominator.

**Tech Stack:** Next.js 16 (App Router), TypeScript, next-intl 4, Tailwind v4, Vitest (node environment), Caddy 2.11, Docker, ffmpeg, cwebp.

**Spec:** `docs/superpowers/specs/2026-09-26-pt-landing-page-design.md` (issue #33)

## Global Constraints

- Work only in the worktree `/Users/mjpc/Play/github/hausverwaltung-landing` on branch `feat/pt-landing-page`. Never switch branches, stash, reset or pull in `/Users/mjpc/Play/github/hausverwaltung` (others work there in parallel).
- Run tests in Node 24: `docker run --rm -v "$PWD":/app -v havewa-test-nm:/app/node_modules -w /app node:24-bookworm-slim sh -c "npx prisma generate >/dev/null 2>&1; npx vitest run"`. If `vitest` is missing in the volume, run `npm ci --no-audit --no-fund` in the same container first. Known pre-existing: 3 `tsc` errors in `src/lib/sso.test.ts`; ~85 eslint problems repo-wide — report only new ones.
- Page language: European Portuguese (pt-PT), fixed; independent of browser language and `NEXT_LOCALE`.
- CTA URL (exact): `https://crmware.pt/pt/contact?utm_source=realestate&utm_medium=landing`. No `rel="noreferrer"` on CTA links; no `Referrer-Policy` that strips the origin.
- Never on the page: pricing, testimonials or customer logos, compliance claims, the English brand tagline, the AI assistant, the word "integrações", acertos de despesas, faturação/SAF-T/e-fatura, IMI, BetrKV, HeizkostenV, GoBD, MEA.
- No tracking script, no form, no data storage on the page.
- Brand colours: black `#000000`, teal `#53959c` (hover `#4a8389`), green `#becd2f` (small highlights only), beige `#e9decf`; no red, no grey/blue tones. Font: `Arial, Helvetica, sans-serif`. Buttons: teal, black text, uppercase, bold, 4 px radius. Cards: white, 8 px radius, `0 2px 8px rgba(0,0,0,.08)`.
- Performance budget: LCP < 2.5 s (Lighthouse mobile); poster ≤ 150 KB; screenshot ≤ 200 KB WebP; video only ≥ 768 px and without `prefers-reduced-motion`; no web fonts; mobile transfer ≤ 600 KB.
- Spec note: the spec's "`preload="none"` until visible" is realised by not mounting the `<video>` at all below 768 px or with reduced motion (`mediaQuery`, Task 3). On desktop the hero is above the fold, so the video loads immediately by design; the poster is the LCP candidate.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; commit only with the product owner's approval of the task batch (they approved "go to implementation"; push after each commit).

## Review Focus

1. **Phone visitor on mobile data** must not download the 4.9 MB video — expected: at 375 px no request to any `/videos/*.mp4` (Task 3 runtime check, Task 7 network check).
2. **Keyboard user** jumping via "Ver funcionalidades" or the skip link must not land under the sticky header — expected: target heading fully visible (Task 4 CSS + Task 7 manual check).
3. **Visitor with `prefers-reduced-motion`** must not get an auto-playing video — expected: poster only (Task 3 `mediaQuery`, Task 7 emulation).
4. **Visitor without JavaScript / slow JS** must still read everything and reach the CTA — expected: all copy, poster and links are server-rendered (Task 4 test: page is a server component with no client-only copy; Task 7 JS-disabled check).
5. **Existing links** `/marketing/index.html` (DE/EN page) and `/marketing/` must keep working next to the new route — expected: 200 and 308 → `/marketing` (Task 7 check).

---

### Task 1: Landing content — copy and constants

**Files:**
- Create: `src/lib/landing.ts`
- Modify: `messages/pt.json` (add top-level `landing` object after `legal`)
- Test: `src/lib/landing.test.ts`

**Interfaces:**
- Produces:
  - `LANDING_CTA_URL: string`
  - `LANDING_FEATURES: readonly { key: "rental" | "condo" | "operations" | "portal"; icon: string }[]`
  - `LANDING_TRUST: readonly { key: "hosting" | "access" | "language" | "openSource" | "api"; icon: string }[]`
  - `landingIcon(name: string): string` → `/brand/${APP_SLUG}/icons/${name}.svg`
  - `LANDING_SCREENSHOT: string` → `/brand/${APP_SLUG}/landing/dashboard.webp`
  - `posterFor(videoUrl: string): string` → same path with `.jpg`
  - i18n keys `landing.*` (see Step 3)

- [ ] **Step 1: Write the failing test** — `src/lib/landing.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_SLUG } from "./brand";
import { LANDING_CTA_URL, LANDING_FEATURES, LANDING_TRUST, LANDING_SCREENSHOT, landingIcon, posterFor } from "./landing";

// #33: PT-Landingpage — Texte, Konstanten, Grenzen des Inhalts.
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const landing = JSON.parse(read("messages/pt.json")).landing;
const strings = (o: unknown, path = ""): [string, string][] =>
  typeof o === "string" ? [[path, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));

describe("Landing-Inhalt (#33)", () => {
  it("CTA führt zum pt-Kontakt auf crmware.pt mit UTM", () => {
    expect(LANDING_CTA_URL).toBe("https://crmware.pt/pt/contact?utm_source=realestate&utm_medium=landing");
  });

  it("vier Bereiche und fünf Vertrauensaussagen, jeweils mit Text in pt", () => {
    expect(LANDING_FEATURES.map((f) => f.key)).toEqual(["rental", "condo", "operations", "portal"]);
    for (const f of LANDING_FEATURES) {
      for (const k of ["title", "p1", "p2", "p3"]) expect(landing.features[f.key][k]).toBeTruthy();
    }
    expect(LANDING_TRUST.map((t) => t.key)).toEqual(["hosting", "access", "language", "openSource", "api"]);
    for (const t of LANDING_TRUST) expect(landing.trust[t.key]).toBeTruthy();
  });

  it("Pfade für Icons, Screenshot und Poster", () => {
    expect(landingIcon("users")).toBe(`/brand/${APP_SLUG}/icons/users.svg`);
    expect(LANDING_SCREENSHOT).toBe(`/brand/${APP_SLUG}/landing/dashboard.webp`);
    expect(posterFor("/videos/crmware/a.mp4")).toBe("/videos/crmware/a.jpg");
    expect(posterFor("/videos/default/b.webm")).toBe("/videos/default/b.jpg");
  });

  it("verbotene Inhalte kommen nicht vor", () => {
    const text = strings(landing).map(([, s]) => s).join("\n");
    expect(text).not.toMatch(/BetrKV|HeizkostenV|GoBD|\bMEA\b/);
    expect(text).not.toMatch(/preço|preços|€|plano|testemunho|cliente satisfeito/i);
    expect(text).not.toMatch(/assistente de IA|integraç/i);
    expect(text).not.toMatch(/conformidade|compliant|certificad|RGPD|BUILT/i);
    expect(text).not.toMatch(/todas as alterações/);
  });

  it("Marke nur über {app}, nie als fester Name", () => {
    for (const [path, s] of strings(landing)) expect(s, path).not.toMatch(/CrmWare|HaVeWa/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in the worktree): `docker run --rm -v "$PWD":/app -v havewa-test-nm:/app/node_modules -w /app node:24-bookworm-slim sh -c "npx vitest run src/lib/landing.test.ts"`
Expected: FAIL — `Cannot find module './landing'`.

- [ ] **Step 3: Add the copy** — insert into `messages/pt.json` directly after the `legal` object (keep 2-space indentation, valid JSON):

```json
  "landing": {
    "meta": {
      "title": "{app} — Gestão de arrendamentos e condomínios",
      "description": "Imóveis, frações, contratos, quotas e assembleias num só sistema, com portal para inquilinos e condóminos."
    },
    "skip": "Saltar para o conteúdo",
    "nav": { "login": "Iniciar sessão", "contact": "Fale connosco" },
    "hero": {
      "title": "Arrendamentos e condomínios, num só sistema.",
      "subtitle": "Imóveis, frações, contratos, quotas e assembleias organizados num só lugar — com portal para inquilinos e condóminos.",
      "fit": "Para gestores de arrendamento e administradores de condomínios — use apenas as áreas de que precisa.",
      "cta": "Fale connosco sobre a gestão imobiliária",
      "secondary": "Ver funcionalidades"
    },
    "video": { "pause": "Pausar vídeo", "play": "Reproduzir vídeo" },
    "features": {
      "title": "Funcionalidades",
      "rental": { "title": "Arrendamento", "p1": "Imóveis, frações e contratos", "p2": "Rendas e valores em aberto", "p3": "Cobrança com débito direto SEPA" },
      "condo": { "title": "Condomínio", "p1": "Permilagem e quotas", "p2": "Fundo comum de reserva", "p3": "Assembleias com ordem de trabalhos e votações" },
      "operations": { "title": "Operações", "p1": "Pedidos de manutenção e prestadores", "p2": "Documentos organizados", "p3": "Calendário de prazos" },
      "portal": { "title": "Portal", "p1": "Inquilinos e condóminos comunicam avarias e acompanham os pedidos", "p2": "Consultam valores em aberto e histórico de pagamentos", "p3": "Acedem às deliberações e documentos" }
    },
    "product": {
      "title": "O produto",
      "alt": "Painel da aplicação com imóveis em arrendamento e em condomínio, rendas, valores em aberto e pedidos",
      "caption": "Painel com arrendamentos e condomínios, rendas, valores em aberto e pedidos — dados de demonstração."
    },
    "trust": {
      "title": "Porquê {app}",
      "hosting": "Servidores na Alemanha (União Europeia)",
      "access": "Acessos por perfil e registo de auditoria das alterações",
      "language": "Interface em português de Portugal",
      "openSource": "Código aberto (AGPL-3.0)",
      "openSourceLink": "Ver o código",
      "api": "API REST e servidor MCP, com token pessoal, para ligar ferramentas e assistentes de IA aos seus dados"
    },
    "closing": { "title": "Vamos falar sobre a sua gestão imobiliária?", "cta": "Fale connosco sobre a gestão imobiliária" },
    "footer": { "copyright": "© 2026 {app}", "legal": "Aviso legal", "source": "Código-fonte", "login": "Iniciar sessão" }
  },
```

Note: the `api` trust statement contains "assistentes de IA" (plural, about connecting external tools) — it does not advertise the in-app assistant; the forbidden pattern is `assistente de IA` (singular) and passes.

- [ ] **Step 4: Write `src/lib/landing.ts`**

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass** — same command as Step 2, then the full suite (Global Constraints command). Expected: PASS; full suite green. Also run `src/lib/brand.test.ts` explicitly (duplicate-key check covers `pt.json`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/landing.ts src/lib/landing.test.ts messages/pt.json
git commit -m "feat(#33): landing page copy (pt-PT) and constants"
git push
```

---

### Task 2: Landing assets — icons and video posters

**Files:**
- Create: `public/brand/crmware/icons/{file-text,users,clock,contact,server,shield-check,circle-check,git-branch,link}.svg`
- Create: `public/videos/crmware/intro-vision-imo-crmware.jpg`, `public/videos/default/estate-1.jpg`
- Test: `src/lib/landing-assets.test.ts`

**Interfaces:**
- Consumes: `LANDING_FEATURES`, `LANDING_TRUST`, `landingIcon`, `posterFor` (Task 1); `listBackgroundVideos` (`src/lib/videos.ts`)
- Produces: files at the paths above.

- [ ] **Step 1: Write the failing test** — `src/lib/landing-assets.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { LANDING_FEATURES, LANDING_TRUST, landingIcon, posterFor } from "./landing";
import { listBackgroundVideos } from "./videos";

// #33: Icons und Standbilder der Landingpage liegen im Repo, sind sicher und klein.
const pub = (url: string) => new URL(`../../public${url}`, import.meta.url);

describe("Landing-Assets (#33)", () => {
  it("jedes verwendete Icon existiert und ist ein reines SVG", () => {
    for (const { icon } of [...LANDING_FEATURES, ...LANDING_TRUST]) {
      const file = pub(landingIcon(icon));
      expect(existsSync(file), icon).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg).toMatch(/<svg /);
      expect(svg).not.toMatch(/<script|foreignObject|href=|\son[a-z]+=/i);
    }
  });

  it("jedes Hintergrundvideo hat ein Standbild ≤ 150 KB", async () => {
    const all = [...(await listBackgroundVideos()), ...(await listBackgroundVideos({ slug: "default" }))];
    expect(all.length).toBeGreaterThan(0);
    for (const v of all) {
      const poster = pub(posterFor(v));
      expect(existsSync(poster), v).toBe(true);
      expect(statSync(poster).size, v).toBeLessThanOrEqual(150 * 1024);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/lib/landing-assets.test.ts` (in the container). Expected: FAIL — icons do not exist.

- [ ] **Step 3: Copy the icons** (source is the CrmWare website repo; verified clean black outline SVGs, 24×24)

```bash
mkdir -p public/brand/crmware/icons
for i in file-text users clock contact server shield-check circle-check git-branch link; do
  cp /Users/mjpc/Play/crmware/site/crmware-website/assets/rune-icons/outline/$i.svg public/brand/crmware/icons/$i.svg
done
```

- [ ] **Step 4: Extract the posters** (frame at 1 s; scale to 1280 px wide; JPEG quality tuned to stay ≤ 150 KB)

```bash
ffmpeg -v error -y -ss 1 -i public/videos/crmware/intro-vision-imo-crmware.mp4 -frames:v 1 -vf scale=1280:-2 -q:v 6 public/videos/crmware/intro-vision-imo-crmware.jpg
ffmpeg -v error -y -ss 1 -i public/videos/default/estate-1.mp4 -frames:v 1 -vf scale=1280:-2 -q:v 6 public/videos/default/estate-1.jpg
ls -l public/videos/*/*.jpg
```

If a poster is above 150 KB, rerun that command with `-q:v 8` (higher number = smaller file) and check again. Open each JPEG to confirm it shows the scene (CrmWare: the lobby with the "Visionários do Imobiliário" banner).

- [ ] **Step 5: Run tests to verify they pass** — the test file, then the full suite. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/brand/crmware/icons public/videos/crmware/intro-vision-imo-crmware.jpg public/videos/default/estate-1.jpg src/lib/landing-assets.test.ts
git commit -m "feat(#33): landing icons (CrmWare Rune) and video posters"
git push
```

---

### Task 3: `BackgroundVideo` — poster, pause control, media gating

**Files:**
- Modify: `src/components/background-video.tsx`
- Test: `src/lib/background-video.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BackgroundVideo({ sources, className, poster?, controls?, pauseLabel?, playLabel?, controlsClassName?, mediaQuery? })`
  - `poster?: string` — passed to `<video poster>`
  - `controls?: boolean` (default `false`) — renders a pause/play `<button type="button">` with `aria-pressed`
  - `pauseLabel?: string`, `playLabel?: string` — button text (defaults `"Pause"`, `"Play"`)
  - `controlsClassName?: string` — classes for the button
  - `mediaQuery?: string` — if set, the `<video>` is only mounted in the browser when `window.matchMedia(mediaQuery).matches`; nothing is rendered on the server (so no video download on mobile/reduced motion)
  - Without the new props the rendered output and behaviour are unchanged (login/setup).

- [ ] **Step 1: Write the failing test** — `src/lib/background-video.test.ts` (Vitest runs in `node`; the component is checked by source contract here and by the browser in Task 7)

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #33: BackgroundVideo — neue Optionen sind opt-in; Login/Setup bleiben unverändert.
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("BackgroundVideo (#33)", () => {
  it("bietet poster, controls (Standard aus) und mediaQuery an", () => {
    const src = read("src/components/background-video.tsx");
    expect(src).toMatch(/controls = false/);
    expect(src).toMatch(/poster=\{poster\}/);
    expect(src).toMatch(/aria-pressed=\{paused\}/);
    expect(src).toMatch(/window\.matchMedia\(mediaQuery\)/);
    expect(src).toMatch(/type="button"/);
  });

  it("Login und Setup nutzen keine der neuen Optionen", () => {
    for (const page of ["src/app/[locale]/login/page.tsx", "src/app/[locale]/setup/page.tsx"]) {
      const call = read(page).match(/<BackgroundVideo[^>]*\/>/)?.[0] ?? "";
      expect(call, page).toContain("sources={videos}");
      expect(call, page).not.toMatch(/controls|mediaQuery|poster/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL on the first test (`controls = false` not found).

- [ ] **Step 3: Replace `src/components/background-video.tsx`**

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Spielt Hintergrundvideos stumm ab. Mehrere Quellen → zufällige Reihenfolge,
 * nacheinander in Endlosschleife. Eine Quelle → einfacher Loop.
 * Optional (#33): Standbild (poster), Pause-/Play-Schaltfläche (controls, WCAG 2.2.2)
 * und mediaQuery — das Video wird dann nur im Browser eingebunden, wenn die Abfrage
 * zutrifft (kein Download auf dem Telefon oder bei reduzierter Bewegung).
 */
export function BackgroundVideo({
  sources,
  className,
  poster,
  controls = false,
  pauseLabel = "Pause",
  playLabel = "Play",
  controlsClassName,
  mediaQuery,
}: {
  sources: string[];
  className?: string;
  poster?: string;
  controls?: boolean;
  pauseLabel?: string;
  playLabel?: string;
  controlsClassName?: string;
  mediaQuery?: string;
}) {
  // einmalige zufällige Reihenfolge pro Mount
  const order = useMemo(() => [...sources].sort(() => Math.random() - 0.5), [sources]);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [allowed, setAllowed] = useState(!mediaQuery);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!mediaQuery) return;
    const mq = window.matchMedia(mediaQuery);
    const update = () => setAllowed(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [mediaQuery]);

  if (order.length === 0 || !allowed) return null;
  const single = order.length === 1;

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      setPaused(false);
    } else {
      v.pause();
      setPaused(true);
    }
  };

  return (
    <>
      <video
        ref={ref}
        key={order[i]}
        className={cn("size-full object-cover", className)}
        autoPlay
        muted
        playsInline
        poster={poster}
        loop={single}
        onEnded={() => {
          if (!single) setI((x) => (x + 1) % order.length);
        }}
      >
        <source src={order[i]} />
      </video>
      {controls && (
        <button type="button" onClick={toggle} aria-pressed={paused} className={controlsClassName}>
          {paused ? playLabel : pauseLabel}
        </button>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run tests** — the test file, the full suite, and `npx tsc --noEmit` (only the 3 known `sso.test.ts` errors) and `npx eslint src/components/background-video.tsx`. Expected: PASS / no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/background-video.tsx src/lib/background-video.test.ts
git commit -m "feat(#33): BackgroundVideo — opt-in poster, pause control and media gating"
git push
```

---

### Task 4: The `/marketing` route — layout and page

**Files:**
- Create: `src/app/marketing/layout.tsx`
- Create: `src/app/marketing/landing.css`
- Create: `src/app/marketing/page.tsx`
- Test: `src/lib/landing-page.test.ts`

**Interfaces:**
- Consumes: Task 1 constants and `landing.*` keys; Task 2 assets; Task 3 `BackgroundVideo` props; `APP_NAME`, `BRAND_LOGO_URL`, `BRAND_ICON_URL` (`src/lib/brand.ts`); `SOURCE_URL` (`src/lib/version.ts`); `listBackgroundVideos` (`src/lib/videos.ts`).
- Produces: `GET /marketing` → the PT landing page.

- [ ] **Step 1: Write the failing test** — `src/lib/landing-page.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

// #33: Aufbau der Route /marketing — pt fest, Marke aus brand.ts, zugänglich, ohne Tracking.
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

describe("/marketing (#33)", () => {
  it("eigenes Root-Layout mit lang=pt-PT und Marken-Favicon", () => {
    const layout = read("src/app/marketing/layout.tsx");
    expect(layout).toContain('lang="pt-PT"');
    expect(layout).toContain("BRAND_ICON_URL");
    expect(layout).toContain('import "../globals.css"');
    expect(layout).toContain('import "./landing.css"');
  });

  it("Seite: Server-Komponente, Texte fest pt, Marke aus brand.ts, CTA-Konstante", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).not.toMatch(/^"use client"/m);
    expect(page).toContain('getTranslations({ locale: "pt", namespace: "landing" })');
    for (const needle of ["APP_NAME", "BRAND_LOGO_URL", "LANDING_CTA_URL", "LANDING_SCREENSHOT", "SOURCE_URL", "posterFor("]) {
      expect(page).toContain(needle);
    }
    expect(page).not.toMatch(/CrmWare|HaVeWa|crmware\.pt\/pt\/contact/);
    expect(page).not.toMatch(/noreferrer/);
    expect(page).not.toMatch(/<script|<form/);
  });

  it("Zugänglichkeit: Skip-Link, Landmarken, ein h1, Anker unter dem Kopf sichtbar", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toContain('href="#conteudo"');
    expect(page).toContain('id="conteudo"');
    expect(page).toContain('id="funcionalidades"');
    for (const tag of ["<header", "<main", "<footer"]) expect(page).toContain(tag);
    expect(page.match(/<h1/g)?.length).toBe(1);
    const css = read("src/app/marketing/landing.css");
    expect(css).toMatch(/scroll-padding-top/);
    expect(css).toMatch(/scroll-margin-top/);
  });

  it("Video nur ab 768 px und ohne reduzierte Bewegung, mit Pause", () => {
    const page = read("src/app/marketing/page.tsx");
    expect(page).toContain('mediaQuery="(min-width: 768px) and (prefers-reduced-motion: no-preference)"');
    expect(page).toMatch(/controls\b/);
  });

  it("alte DE/EN-Seite bleibt unter /marketing/index.html", () => {
    expect(existsSync(new URL("public/marketing/index.html", root))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (`src/app/marketing/layout.tsx` missing).

- [ ] **Step 3: Write `src/app/marketing/landing.css`**

```css
/* PT-Landingpage (#33) — CrmWare-Markenwerte. */
.landing {
  --cw-black: #000000;
  --cw-teal: #53959c;
  --cw-teal-dark: #4a8389;
  --cw-green: #becd2f;
  --cw-beige: #e9decf;
  font-family: Arial, Helvetica, sans-serif;
  color: var(--cw-black);
  background: #ffffff;
}
html:has(.landing) {
  scroll-padding-top: 5rem; /* sticky header */
  scroll-behavior: smooth;
}
@media (prefers-reduced-motion: reduce) {
  html:has(.landing) { scroll-behavior: auto; }
}
.landing [id] { scroll-margin-top: 5rem; }
.landing .cw-btn {
  display: inline-block;
  background: var(--cw-teal);
  color: var(--cw-black);
  padding: 12px 24px;
  border-radius: 4px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  text-decoration: none;
  transition: transform 0.2s ease, background 0.2s ease;
}
.landing .cw-btn:hover { background: var(--cw-teal-dark); transform: translateY(-2px); }
.landing .cw-btn-outline {
  display: inline-block;
  border: 2px solid #ffffff;
  color: #ffffff;
  padding: 10px 22px;
  border-radius: 4px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  text-decoration: none;
}
.landing .cw-card {
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  padding: 24px;
}
.landing a:focus-visible,
.landing button:focus-visible {
  outline: 3px solid var(--cw-green);
  outline-offset: 2px;
}
.landing .cw-skip {
  position: absolute;
  left: 16px;
  top: -48px;
  background: var(--cw-teal);
  color: var(--cw-black);
  padding: 8px 12px;
  border-radius: 4px;
  z-index: 100;
}
.landing .cw-skip:focus { top: 8px; }
```

- [ ] **Step 4: Write `src/app/marketing/layout.tsx`**

```tsx
import "../globals.css";
import "./landing.css";
import { BRAND_ICON_URL } from "@/lib/brand";

// Eigenes Root-Layout für die PT-Landingpage (#33): feste Sprache pt-PT, ohne App-Provider.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-PT">
      <head>
        <link rel="icon" href={BRAND_ICON_URL} />
      </head>
      <body className="landing min-h-full">{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Write `src/app/marketing/page.tsx`**

```tsx
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { APP_NAME, BRAND_LOGO_URL } from "@/lib/brand";
import { SOURCE_URL } from "@/lib/version";
import { listBackgroundVideos } from "@/lib/videos";
import { BackgroundVideo } from "@/components/background-video";
import { LANDING_CTA_URL, LANDING_FEATURES, LANDING_TRUST, LANDING_SCREENSHOT, landingIcon, posterFor } from "@/lib/landing";

const texts = () => getTranslations({ locale: "pt", namespace: "landing" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await texts();
  const title = t("meta.title", { app: APP_NAME });
  const description = t("meta.description");
  return {
    metadataBase: process.env.AUTH_URL ? new URL(process.env.AUTH_URL) : undefined,
    title,
    description,
    alternates: { canonical: "/marketing" },
    openGraph: { title, description, url: "/marketing", locale: "pt_PT", type: "website" },
  };
}

// PT-Landingpage (#33) — Kundengewinnung; alle CTAs → crmware.pt/pt/contact.
export default async function MarketingPage() {
  const t = await texts();
  const videos = await listBackgroundVideos();
  const poster = videos[0] ? posterFor(videos[0]) : undefined;

  return (
    <>
      <a href="#conteudo" className="cw-skip">
        {t("skip")}
      </a>

      <header className="sticky top-0 z-50 border-b border-black/10 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <a href="/marketing" aria-label={APP_NAME}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={BRAND_LOGO_URL} alt={APP_NAME} className="h-8 w-auto" />
          </a>
          <nav className="flex items-center gap-4 text-sm">
            <a href="/pt/login" className="hidden underline-offset-4 hover:underline sm:inline">
              {t("nav.login")}
            </a>
            <a href={LANDING_CTA_URL} className="cw-btn">
              {t("nav.contact")}
            </a>
          </nav>
        </div>
      </header>

      <main id="conteudo">
        <section className="relative isolate overflow-hidden text-white">
          {poster && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={poster} alt="" className="absolute inset-0 -z-20 size-full object-cover" />
          )}
          <BackgroundVideo
            sources={videos}
            poster={poster}
            className="absolute inset-0 -z-10"
            mediaQuery="(min-width: 768px) and (prefers-reduced-motion: no-preference)"
            controls
            pauseLabel={t("video.pause")}
            playLabel={t("video.play")}
            controlsClassName="absolute bottom-4 right-4 z-10 rounded border border-white/80 bg-black/50 px-3 py-1 text-xs"
          />
          <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/85 via-black/70 to-black/40" />
          <div className="mx-auto max-w-6xl px-4 py-24 md:py-32">
            <h1 className="max-w-2xl text-3xl font-bold leading-tight md:text-5xl">{t("hero.title")}</h1>
            <p className="mt-4 max-w-2xl text-lg">{t("hero.subtitle")}</p>
            <p className="mt-3 max-w-2xl text-sm text-white/90">{t("hero.fit")}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href={LANDING_CTA_URL} className="cw-btn text-center">
                {t("hero.cta")}
              </a>
              <a href="#funcionalidades" className="cw-btn-outline text-center">
                {t("hero.secondary")}
              </a>
            </div>
          </div>
        </section>

        <section id="funcionalidades" className="mx-auto max-w-6xl px-4 py-16" aria-labelledby="funcionalidades-titulo">
          <h2 id="funcionalidades-titulo" className="text-2xl font-bold">
            {t("features.title")}
          </h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {LANDING_FEATURES.map((f) => (
              <article key={f.key} className="cw-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={landingIcon(f.icon)} alt="" className="size-8" />
                <h3 className="mt-4 text-lg font-bold">{t(`features.${f.key}.title`)}</h3>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                  <li>{t(`features.${f.key}.p1`)}</li>
                  <li>{t(`features.${f.key}.p2`)}</li>
                  <li>{t(`features.${f.key}.p3`)}</li>
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="bg-[var(--cw-beige)]" aria-labelledby="produto-titulo">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 id="produto-titulo" className="text-2xl font-bold">
              {t("product.title")}
            </h2>
            <figure className="mt-8">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={LANDING_SCREENSHOT}
                alt={t("product.alt")}
                width={1440}
                height={900}
                loading="lazy"
                className="h-auto w-full rounded-lg shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
              />
              <figcaption className="mt-3 text-sm">{t("product.caption")}</figcaption>
            </figure>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16" aria-labelledby="porque-titulo">
          <h2 id="porque-titulo" className="text-2xl font-bold">
            {t("trust.title", { app: APP_NAME })}
          </h2>
          <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            {LANDING_TRUST.map((item) => (
              <li key={item.key} className="cw-card text-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={landingIcon(item.icon)} alt="" className="size-7" />
                <p className="mt-3 font-bold">{t(`trust.${item.key}`)}</p>
                {item.key === "openSource" && (
                  <a href={SOURCE_URL} className="mt-2 inline-block underline underline-offset-4">
                    {t("trust.openSourceLink")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="bg-[var(--cw-teal)]" aria-labelledby="fecho-titulo">
          <div className="mx-auto max-w-6xl px-4 py-16 text-center">
            <h2 id="fecho-titulo" className="text-2xl font-bold">
              {t("closing.title")}
            </h2>
            <a href={LANDING_CTA_URL} className="cw-btn mt-6 bg-white hover:bg-[var(--cw-beige)]">
              {t("closing.cta")}
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-black/10">
        <div className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm">
          <span>{t("footer.copyright", { app: APP_NAME })}</span>
          <a href="/pt/legal" className="underline underline-offset-4">
            {t("footer.legal")}
          </a>
          <a href={SOURCE_URL} className="underline underline-offset-4">
            {t("footer.source")}
          </a>
          <a href="/pt/login" className="underline underline-offset-4">
            {t("footer.login")}
          </a>
        </div>
      </footer>
    </>
  );
}
```

- [ ] **Step 6: Run tests** — the test file, the full suite (the `brand.test.ts` scan must not flag a literal brand name), `npx tsc --noEmit`, and `npx eslint src/app/marketing`. Expected: PASS / no new errors. If `eslint` reports `@next/next/no-html-link-for-pages` for `href="/pt/login"`/`/pt/legal`/`/marketing`, switch those three anchors to `next/link` (`import Link from "next/link"`) with the same `href` and `className` — they cross root layouts, so a full page load is expected either way.

- [ ] **Step 7: Commit**

```bash
git add src/app/marketing src/lib/landing-page.test.ts
git commit -m "feat(#33): PT landing page at /marketing"
git push
```

---

### Task 5: Caddy access log for `/marketing` (visit denominator)

**Files:**
- Modify: `Caddyfile`
- Modify: `docs/deployment/HETZNER.md` (new section "Landing page visits")
- Test: `src/lib/caddyfile.test.ts`

**Interfaces:**
- Produces: `/data/access-marketing.log` (JSON lines) in the Caddy container / `caddy-data` volume.

- [ ] **Step 1: Write the failing test** — `src/lib/caddyfile.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #33: Besuchszählung /marketing ohne personenbezogene Daten, 90 Tage.
const caddy = readFileSync(new URL("../../Caddyfile", import.meta.url), "utf8");

describe("Caddy-Zugriffslog /marketing (#33)", () => {
  it("nur /marketing, ohne IP/Header/Cookies, 90 Tage", () => {
    expect(caddy).toContain("output file /data/access-marketing.log");
    expect(caddy).toContain("roll_keep_for 2160h");
    for (const f of ["request>remote_ip delete", "request>client_ip delete", "request>headers delete", "resp_headers delete"]) {
      expect(caddy).toContain(f);
    }
    expect(caddy).toContain("@not_marketing not path /marketing");
    expect(caddy).toContain("log_skip @not_marketing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL (log block missing).

- [ ] **Step 3: Replace `Caddyfile`** (validated with Caddy v2.11.4: `Valid configuration`)

```
# Automatisches HTTPS via Let's Encrypt. DOMAIN kommt aus der Umgebung.
{$DOMAIN} {
	reverse_proxy app:3000
	encode zstd gzip

	# Zugriffslog nur für die Landing Page /marketing (#33): ohne IP, Header, Cookies; 90 Tage.
	log {
		output file /data/access-marketing.log {
			roll_keep_for 2160h
		}
		format filter {
			request>remote_ip delete
			request>client_ip delete
			request>headers delete
			resp_headers delete
		}
	}
	@not_marketing not path /marketing
	log_skip @not_marketing
}
```

- [ ] **Step 4: Validate with Caddy**

```bash
docker run --rm -e DOMAIN=localhost -v "$PWD/Caddyfile":/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expected: last line `Valid configuration`.

- [ ] **Step 5: Document counting** — append to `docs/deployment/HETZNER.md`:

````markdown
## Landing page visits (#33)

Caddy logs only requests to `/marketing` to `/data/access-marketing.log` (volume `caddy-data`) —
without IP address, headers or cookies; rotated files are kept 90 days. Bots cannot be filtered
out (no user agent), so the count is an upper bound. Requests per day:

```bash
ssh -i ~/.ssh/havewa_hetzner_ed25519 root@2.28.113.150 \
  'docker exec havewa-caddy sh -c "cat /data/access-marketing.log; zcat /data/access-marketing-*.log.gz 2>/dev/null"' \
  | jq -r '.ts | floor | strftime("%Y-%m-%d")' | sort | uniq -c
```

Leads: count contact requests on crmware.pt with `referrer: https://realestate.crmware.pt`
(target ≥ 5 in the 90 days after publication).
````

- [ ] **Step 6: Run tests** — test file and full suite. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Caddyfile docs/deployment/HETZNER.md src/lib/caddyfile.test.ts
git commit -m "feat(#33): Caddy access log for /marketing without personal data"
git push
```

---

### Task 6: Synthetic PT data, API/MCP functional test, dashboard screenshot

**Files:**
- Create: `scripts/landing-demo-data.sh`
- Create: `public/brand/crmware/landing/dashboard.webp`
- Test: `src/lib/landing-assets.test.ts` (extend)

**Interfaces:**
- Consumes: REST `POST /api/v1/records/<entity>` (entities `property`, `building`, `unit`, `person`, `owner`, `lease`, `meeting`, `ticket`), `POST /api/v1/operations/run_charge_generation`, `GET /api/v1/properties`, MCP `POST /api/mcp` (JSON-RPC), bearer token.
- Produces: `dashboard.webp` referenced by `LANDING_SCREENSHOT`.

- [ ] **Step 1: Extend the failing test** — append to `src/lib/landing-assets.test.ts` inside the `describe`:

```ts
  it("Dashboard-Screenshot existiert als WebP ≤ 200 KB", () => {
    const shot = pub("/brand/crmware/landing/dashboard.webp");
    expect(existsSync(shot)).toBe(true);
    expect(statSync(shot).size).toBeLessThanOrEqual(200 * 1024);
    expect(readFileSync(shot).subarray(8, 12).toString()).toBe("WEBP");
  });
```

Run it; expected FAIL (file missing).

- [ ] **Step 2: Start a clean local stack from this branch** (bash, not zsh)

```bash
docker build -q -t havewa-landing:local .
S=/private/tmp/claude-504/-Users-mjpc-Play-github-hausverwaltung/05060c5d-a9b0-40b9-ab10-de50ca7c69db/scratchpad/agpl
cd $S
grep -vE '^(ADMIN_EMAIL|ADMIN_PASSWORD|TENANT_NAME|SEED_DEMO|HAVEWA_IMAGE|HAVEWA_TAG)=' .env > .env.n && mv .env.n .env
printf 'HAVEWA_IMAGE=havewa-landing\nHAVEWA_TAG=local\nADMIN_EMAIL=demo@exemplo.pt\nADMIN_PASSWORD=demo-landing-2026\nTENANT_NAME=Gestão Lisboa (demonstração)\n' >> .env
docker compose -f docker-compose.registry.yml -f override.yml down -v
docker compose -f docker-compose.registry.yml -f override.yml up -d app
for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3300/pt/login)" = 200 ] && break; sleep 2; done
docker exec havewa-db psql -U havewa -d havewa -c "update \"Tenant\" set market='PT'"
```

- [ ] **Step 3: Create an API token** — in the browser (chrome-devtools MCP): log in at `http://localhost:3300/pt/login` as `demo@exemplo.pt` / `demo-landing-2026`, open Definições → IA e API, create a token named `landing-demo`, copy it. In the shell: `export TOKEN=<copied token>`.

- [ ] **Step 4: Write `scripts/landing-demo-data.sh`**

```bash
#!/usr/bin/env bash
# Synthetische PT-Demodaten für den Landing-Screenshot (#33) über die REST-API.
# Keine echten Personen. Aufruf: BASE=http://localhost:3300 TOKEN=... bash scripts/landing-demo-data.sh
set -euo pipefail
BASE="${BASE:?BASE fehlt}"; TOKEN="${TOKEN:?TOKEN fehlt}"
post() { # post <path> <json> → id
  local r; r=$(curl -fsS -X POST "$BASE$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2")
  echo "$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id") or d.get("data",{}).get("id") or "")'
}
need() { [ -n "$1" ] || { echo "Anlegen fehlgeschlagen: $2" >&2; exit 1; }; }

# Arrendamento
P1=$(post /api/v1/records/property '{"name":"Edifício Estrela","street":"Rua da Estrela 12","zip":"1200-669","city":"Lisboa","type":"WOHNEN","management":"MIET","feeType":"PAUSCHAL","areaModel":"false"}'); need "$P1" property1
B1=$(post /api/v1/records/building "{\"propertyId\":\"$P1\",\"name\":\"Bloco A\"}"); need "$B1" building1
U11=$(post /api/v1/records/unit "{\"buildingId\":\"$B1\",\"label\":\"1.º Esq.\",\"type\":\"WOHNUNG\",\"area\":78,\"rooms\":\"3\"}"); need "$U11" unit11
U12=$(post /api/v1/records/unit "{\"buildingId\":\"$B1\",\"label\":\"1.º Dto.\",\"type\":\"WOHNUNG\",\"area\":82,\"rooms\":\"3\"}"); need "$U12" unit12
U13=$(post /api/v1/records/unit "{\"buildingId\":\"$B1\",\"label\":\"2.º Esq.\",\"type\":\"WOHNUNG\",\"area\":65,\"rooms\":\"2\"}"); need "$U13" unit13
M1=$(post /api/v1/records/person '{"firstName":"Ana","lastName":"Ferreira","email":"ana.ferreira@exemplo.pt","type":"MIETER"}'); need "$M1" person1
M2=$(post /api/v1/records/person '{"firstName":"Rui","lastName":"Costa","email":"rui.costa@exemplo.pt","type":"MIETER"}'); need "$M2" person2
L1=$(post /api/v1/records/lease "{\"unitId\":\"$U11\",\"personId\":\"$M1\",\"startDate\":\"2025-03-01\",\"rentCold\":1150,\"personCount\":2}"); need "$L1" lease1
L2=$(post /api/v1/records/lease "{\"unitId\":\"$U12\",\"personId\":\"$M2\",\"startDate\":\"2024-09-01\",\"rentCold\":1200,\"personCount\":1}"); need "$L2" lease2

# Condomínio
P2=$(post /api/v1/records/property '{"name":"Condomínio Jardim do Rato","street":"Largo do Rato 5","zip":"1250-186","city":"Lisboa","type":"WOHNEN","management":"WEG","meaTotal":"1000","feeType":"PRO_EINHEIT","feeValue":"12","areaModel":"false"}'); need "$P2" property2
B2=$(post /api/v1/records/building "{\"propertyId\":\"$P2\",\"name\":\"Edifício principal\"}"); need "$B2" building2
U21=$(post /api/v1/records/unit "{\"buildingId\":\"$B2\",\"label\":\"Fração A\",\"type\":\"WOHNUNG\",\"area\":95,\"mea\":\"350\"}"); need "$U21" unit21
U22=$(post /api/v1/records/unit "{\"buildingId\":\"$B2\",\"label\":\"Fração B\",\"type\":\"WOHNUNG\",\"area\":88,\"mea\":\"330\"}"); need "$U22" unit22
U23=$(post /api/v1/records/unit "{\"buildingId\":\"$B2\",\"label\":\"Fração C\",\"type\":\"WOHNUNG\",\"area\":84,\"mea\":\"320\"}"); need "$U23" unit23
O1=$(post /api/v1/records/person '{"firstName":"Marta","lastName":"Sousa","email":"marta.sousa@exemplo.pt","type":"EIGENTUEMER"}'); need "$O1" owner1
O2=$(post /api/v1/records/person '{"firstName":"João","lastName":"Pereira","email":"joao.pereira@exemplo.pt","type":"EIGENTUEMER"}'); need "$O2" owner2
O3=$(post /api/v1/records/person '{"firstName":"Inês","lastName":"Almeida","email":"ines.almeida@exemplo.pt","type":"EIGENTUEMER"}'); need "$O3" owner3
need "$(post /api/v1/records/owner "{\"personId\":\"$O1\",\"unitId\":\"$U21\",\"share\":1000}")" own1
need "$(post /api/v1/records/owner "{\"personId\":\"$O2\",\"unitId\":\"$U22\",\"share\":1000}")" own2
need "$(post /api/v1/records/owner "{\"personId\":\"$O3\",\"unitId\":\"$U23\",\"share\":1000}")" own3
need "$(post /api/v1/records/meeting "{\"propertyId\":\"$P2\",\"title\":\"Assembleia ordinária 2026\",\"date\":\"2026-11-12\",\"location\":\"Sala do condomínio\",\"status\":\"GEPLANT\"}")" meeting

# Operações
need "$(post /api/v1/records/ticket "{\"title\":\"Infiltração na cobertura\",\"category\":\"SCHADEN\",\"priority\":\"HOCH\",\"propertyId\":\"$P2\"}")" ticket1
need "$(post /api/v1/records/ticket "{\"title\":\"Revisão do elevador\",\"category\":\"WARTUNG\",\"priority\":\"MITTEL\",\"propertyId\":\"$P1\"}")" ticket2

# Rendas do mês (valores em aberto)
curl -fsS -X POST "$BASE/api/v1/operations/run_charge_generation" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"month\":\"$(date +%Y-%m)\"}" >/dev/null
echo "Demodaten angelegt."
```

Run: `BASE=http://localhost:3300 TOKEN=$TOKEN bash scripts/landing-demo-data.sh` — expected last line `Demodaten angelegt.`. If an entity is rejected, the script stops with `Anlegen fehlgeschlagen: <name>`; read the JSON error from a manual `curl` of that call and fix the payload in the script (field names follow `src/lib/schemas.ts`).

- [ ] **Step 5: Functional API/MCP test (spec "Testing")**

```bash
B=http://localhost:3300
echo "REST with token:    $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" $B/api/v1/properties)"   # 200
echo "REST without token: $(curl -s -o /dev/null -w '%{http_code}' $B/api/v1/properties)"                                   # 401
curl -s -H "Authorization: Bearer $TOKEN" $B/api/v1/properties | python3 -c 'import sys,json; print([p["name"] for p in json.load(sys.stdin)["data"]])'
M() { curl -s -X POST $B/api/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"; }
M '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -c 200; echo
M '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["result"]["tools"]), "tools")'
M '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"portfolio_summary","arguments":{}}}' | head -c 300; echo
echo "MCP without token: $(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')"   # 401
```

Expected: 200 / 401; the property list contains "Edifício Estrela" and "Condomínio Jardim do Rato"; `initialize` returns `serverInfo.name` = `CrmWare`; `tools/list` returns the tool count; `portfolio_summary` mentions the two properties; MCP without token 401. If the property list's JSON shape differs (`data` key), print the raw body and adjust the one-liner — the check is the names.

- [ ] **Step 6: Take the dashboard screenshot** — chrome-devtools MCP: new isolated page, viewport `1440x900x1`, open `http://localhost:3300/pt/dashboard` (logged in as the demo admin), wait for "Painel", take a PNG screenshot of the viewport to `$S/dashboard.png`. Check it shows both properties with "Arrendamento" and "Condomínio", renda devida, valores em aberto and pedidos, and no German text in the content area. Then:

```bash
mkdir -p public/brand/crmware/landing
cwebp -quiet -q 80 -resize 1440 0 $S/dashboard.png -o public/brand/crmware/landing/dashboard.webp
ls -l public/brand/crmware/landing/dashboard.webp
```

If larger than 200 KB, rerun with `-q 70`.

- [ ] **Step 7: Run tests** — test file and full suite. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/landing-demo-data.sh public/brand/crmware/landing/dashboard.webp src/lib/landing-assets.test.ts
git commit -m "feat(#33): synthetic PT demo data script and dashboard screenshot"
git push
```

---

### Task 7: Pre-merge runtime verification

**Files:** none (verification only; fixes go back to the owning task's files and commit with that task's prefix).

- [ ] **Step 1: Rebuild and start from the final branch state** (same commands as Task 6 Step 2; keep `TENANT_NAME` and market PT).

- [ ] **Step 2: Routes and links** (bash)

```bash
B=http://localhost:3300
for p in /marketing /marketing/index.html /pt/legal /pt/login /api/brand/logo /api/brand/icon /brand/crmware/landing/dashboard.webp /videos/crmware/intro-vision-imo-crmware.jpg; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' $B$p)"; done            # all 200
echo "/marketing/ -> $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $B/marketing/)"   # 308 → /marketing
H=$(curl -s $B/marketing)
grep -oE '<html[^>]*lang="pt-PT"' <<<"$H"; grep -oE '<title>[^<]*</title>' <<<"$H"
grep -c 'crmware.pt/pt/contact?utm_source=realestate&amp;utm_medium=landing' <<<"$H"        # 3 CTAs
grep -ciE 'noreferrer|<script src="http|googletagmanager|plausible' <<<"$H"                    # 0
curl -s -D - -o /dev/null $B/marketing | grep -i referrer-policy || echo "no Referrer-Policy (ok)"
for u in "https://crmware.pt/pt/contact?utm_source=realestate&utm_medium=landing"; do
  curl -s "$u" | grep -oE '<html[^>]*lang="pt-PT"|<title>[^<]*</title>'; done               # pt-PT, CrmWare title
```

Also open `SOURCE_URL` (the `/tree/<sha>` link in the footer) and confirm 200.

- [ ] **Step 3: Visual and responsive** — chrome-devtools MCP screenshots at `375x812x2,mobile,touch`, `768x1024x1`, `1440x900x1` of `/marketing`. Check: CrmWare logo in the header, hero readable, 4 feature cards, screenshot, 5 trust cards, teal closing band, footer; no horizontal scrolling at 375 px.

- [ ] **Step 4: Review Focus checks**
  - Mobile: with viewport 375 px, `list_network_requests` shows **no** request to `*.mp4`; the poster JPEG is loaded. (Review Focus 1)
  - Reduced motion: `emulate` with `prefers-reduced-motion: reduce` at 1440 px → no `<video>` element in the DOM (`evaluate_script`: `document.querySelectorAll('video').length === 0`). (Review Focus 3)
  - JavaScript disabled (`curl` HTML is the server render): the hero title, all feature texts and the three CTA links are present in `$H`. (Review Focus 4)
  - Desktop 1440 px, motion allowed: exactly one `<video>`; clicking "Pausar vídeo" pauses it (`video.paused === true`) and the button then reads "Reproduzir vídeo" with `aria-pressed="true"`.
  - Existing links: Step 2 results for `/marketing/index.html` (200) and `/marketing/` (308). (Review Focus 5)

- [ ] **Step 5: Accessibility by hand** (spec list)
  - Keyboard: from the address bar, Tab through the whole page; the first Tab shows "Saltar para o conteúdo"; every link/button shows the green focus outline; Enter on "Ver funcionalidades" puts the "Funcionalidades" heading fully below the sticky header (Review Focus 2).
  - Reflow: viewport 320 px wide and 1280 px at 200 % zoom (`deviceScaleFactor` 2 on 640 px) — no horizontal scroll, no clipped text.
  - Contrast: measure hero text against the poster and against 3 video frames (0 s, 4 s, 8 s — extract with `ffmpeg -ss N -frames:v 1`) under the gradient; body text ≥ 4.5:1, large text ≥ 3:1. If below, darken the gradient in Task 4 (`from-black/90 via-black/75`).
  - Landmarks and headings: one `h1`, `h2` per section, `header`/`main`/`footer` present (a11y snapshot).

- [ ] **Step 6: Lighthouse and performance budget** — `lighthouse_audit` for `/marketing` in mobile and desktop mode; record accessibility, performance, SEO, LCP and total transfer size. Budget: LCP < 2.5 s mobile, transfer ≤ 600 KB mobile. Lighthouse is a signal, not proof of conformance.

- [ ] **Step 7: Caddy log** — with the production compose (Caddy in front) on the local stack is not available (`override.yml` exposes the app directly). Instead: run a throwaway Caddy with the new Caddyfile in front of the local app on a spare port, request `/marketing`, `/pt/login` and `/api/brand/logo`, then check `/data/access-marketing.log` in that container: exactly one line (for `/marketing`) and it contains no `remote_ip`, `client_ip`, `headers`, `Cookie` or `User-Agent`.

```bash
docker network ls --format '{{.Name}}' | grep agpl   # network of the local stack (e.g. agpl_default)
docker run -d --rm --name caddy-logtest --network agpl_default -e DOMAIN=:8080 -p 3380:8080 \
  -v "$PWD/Caddyfile":/etc/caddy/Caddyfile:ro caddy:2-alpine
sleep 3; for p in /marketing /pt/login /api/brand/logo; do curl -s -o /dev/null http://localhost:3380$p; done; sleep 1
docker exec caddy-logtest cat /data/access-marketing.log
docker stop caddy-logtest
```

The Caddyfile uses `reverse_proxy app:3000`; the local stack's app container must be reachable as `app` on that network (it is, via the compose service name). Expected: one JSON line with `"uri":"/marketing"` and no IP/headers.

- [ ] **Step 8: Clean up** — `docker compose ... down -v` for the local stack; remove the test image; close browser pages.

- [ ] **Step 9: Report** — summarise Steps 2–7 with numbers (status codes, Lighthouse scores, LCP, transfer size, contrast ratios, log line) for the PR description; list anything not met.

---

### Task 8: PR, merge, deploy, post-publication smoke test, follow-ups

**Files:** none (process), plus GitHub issues.

- [ ] **Step 1: Architecture review** in the PR body — public static page, no tenant data/queries/auth/billing/locks; GDPR: Caddy log without IP/headers/cookies, 90 days; leads handled by crmware.pt. State "not applicable" explicitly for tenant isolation, billing atomicity, unscoped queries, locks, bypassable auth, leaked fields.

- [ ] **Step 2: Open the PR** against `main` (`gh pr create -R manueljpconde/hausverwaltung --base main --head feat/pt-landing-page`) with Closes #33, the Task 7 report, and the Global Constraints checklist. Wait for the product owner's review/approval (and an optional Cursor review) before merging.

- [ ] **Step 3: After approval — merge and deploy** (from a directory outside the repo, so `gh` doesn't touch the shared checkout): squash-merge with `--delete-branch`, wait for "Build and push image" on the merge commit, then `ssh -i ~/.ssh/havewa_hetzner_ed25519 root@2.28.113.150 'bash /opt/havewa/deploy/update.sh sha-<short>'`. Copy the new `Caddyfile` to `/opt/havewa/Caddyfile` first and restart Caddy (`docker compose -f docker-compose.registry.yml up -d caddy`), because `update.sh` only restarts the app.

- [ ] **Step 4: Post-publication checks on the devbox**
  - `https://realestate.crmware.pt/marketing` → 200, pt-PT, CrmWare; `/marketing/index.html` → 200.
  - Request `/marketing` once, then confirm one new line in `/data/access-marketing.log` without IP/headers.
  - **Smoke test (coordinated with the website owner):** open `/marketing` in a real browser, click "Fale connosco", submit the contact form with name "TESTE landing #33", a test email and a message "Teste de atribuição — pode apagar". Confirm with the website owner that the stored lead shows `referrer: https://realestate.crmware.pt`; then delete the test lead.
  - Set the review date on #33: publication date + 90 days, target ≥ 5 leads.

- [ ] **Step 5: Follow-up issues** (one each, referencing #33): AI assistant answers in the UI language (`src/lib/ai.ts` prompts "auf Deutsch"); website repo — send `pathname + search` as `pageContext` and add product context to the contact form; full Portuguese demo data + screenshot gallery; video pause control on the login page (brand rule / WCAG 2.2.2).
