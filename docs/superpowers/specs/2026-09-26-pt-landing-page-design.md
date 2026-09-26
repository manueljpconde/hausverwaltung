# PT landing page at `/marketing` — design

Issue: #33 · Status: wireframe approved by the product owner (2026-09-26); spec awaiting final approval

## Goal

Win customers in Portugal: property managers and condominium administrators land on
`https://realestate.crmware.pt/marketing`, understand what CrmWare does for them, and contact
CrmWare.

Success is measured by outcome, not delivery: **contact requests on crmware.pt whose stored
`referrer` is `https://realestate.crmware.pt`**. This works without any tracking on the landing
page — the page sends the browser-default `strict-origin-when-cross-origin` referrer, and the
crmware.pt lead form stores the referrer origin (`sanitizeReferrer` in the website repo). Baseline
is zero today (no page). **Target: at least 5 such contact requests within 90 days after
publication**; the review date is set on the issue when the page goes live.

Denominator: requests to `/marketing` per day, from a Caddy access log limited to that path, with
client IP, forwarded IP and all request headers (incl. user agent and cookies) deleted by Caddy's
log filter, rotated after 90 days (`roll_keep_for 2160h`), stored in the `caddy-data` volume.
Consequence accepted by the product owner: without the user agent, crawler/bot requests cannot be
filtered out, so the count is an upper bound — used for trend, not as exact visitors.

Delivery conditions: the page is live at `/marketing`, in European
Portuguese, in the CrmWare brand, promises only what works for the PT market today, and every call
to action leads to `https://crmware.pt/pt/contact`.

User validation: a low-fidelity wireframe (desktop 1440 px and mobile 375 px, real pt-PT copy,
section order as in Content) was reviewed and approved by the product owner before the build;
feedback from 3–5 target users follows after launch, read against the referrer metric.

## Scope

In scope:

- New route `/marketing` serving the PT landing page (today `/marketing` returns 404).
- Page content in pt-PT, CrmWare visual identity, hero video with pause control.
- Tests and runtime verification (links, responsive, accessibility, Lighthouse).

Out of scope (separate issues):

- Full Portuguese demo data and a screenshot gallery (this page gets exactly one screenshot, see
  Content).
- AI assistant answering in the UI language (today `src/lib/ai.ts` prompts "auf Deutsch") — until
  fixed, the page does not advertise the assistant.
- Website repo: send `location.pathname + location.search` as `pageContext` so UTM parameters
  survive (today only the pathname is sent), and a product context on the contact form.
- Video controls on the login page.
- Moving product pages to crmware.pt (Astro).
- Changes to the existing DE/EN static page, which stays at `/marketing/index.html`.

Explicitly excluded from the page: pricing, testimonials or customer logos, compliance claims
(the login page claim was removed on purpose), a contact form or any data storage, tracking
scripts, the English brand tagline, and features that are not PT-ready (acertos de despesas,
faturação/SAF-T/e-fatura, IMI).

## Architecture

- `src/app/marketing/layout.tsx` — a separate root layout (the app has no global root layout;
  `[locale]/layout.tsx` renders its own `<html>`). Renders `<html lang="pt-PT">`, loads
  `globals.css`, sets the favicon to `BRAND_ICON_URL`.
- `src/app/marketing/page.tsx` — server component. Texts via
  `getTranslations({ locale: "pt", namespace: "landing" })`; the page is fixed to pt because it
  is the PT market page, independent of browser language or the `NEXT_LOCALE` cookie. Product
  name and logo from `src/lib/brand.ts` (`APP_NAME`, `BRAND_LOGO_URL`). Metadata (title,
  description, Open Graph, canonical `/marketing`) via `generateMetadata`.
- Middleware already excludes `marketing` from locale routing — no change needed.
- `Caddyfile`: access log for path `/marketing` only (`log_skip` for every other path), JSON with
  `format filter` deleting `request>remote_ip`, `request>client_ip`, `request>headers`,
  `resp_headers`; output file in `/data` with `roll_keep_for 2160h`. Applies to
  `docker-compose.prod.yml` and `docker-compose.registry.yml` (same Caddyfile). Count per day with
  `jq` on the server; documented in `docs/deployment/HETZNER.md`.
- `/marketing/` keeps redirecting to `/marketing` (Next.js trailing-slash default).
- `/marketing/index.html` (DE/EN static page from `public/marketing/`) is unaffected.
- Hero video: the existing `BackgroundVideo` component (`src/components/background-video.tsx`)
  gains two optional props — `poster` and `controls` (pause/play button). Defaults keep the
  current behaviour, so login and setup are unchanged. The landing page passes
  `controls` and the poster.
- Video source: first entry of `listBackgroundVideos()` (brand folder, else default).
  Poster: a JPEG still frame next to each video with the same base name
  (`public/videos/<folder>/<name>.jpg`), extracted with ffmpeg. Missing video → poster only;
  missing poster → beige background.
- Icons: a selection of CrmWare Rune icons copied as SVG to `public/brand/crmware/icons/`
  (from the CrmWare website repo `assets/rune-icons/outline/`), rendered as decorative
  `<img alt="">`. Mapping: Arrendamento → `file-text`, Condomínio → `users`, Operações → `clock`,
  Portal → `contact`; Porquê CrmWare: EU hosting → `server`, perfis e auditoria →
  `shield-check`, português de Portugal → `circle-check`, API/MCP → `link`.
- Call to action URL (one constant): `https://crmware.pt/pt/contact?utm_source=realestate&utm_medium=landing`.
  The UTM parameters carry no personal data; attribution does not depend on them (referrer origin,
  see Goal). No `Referrer-Policy` that would strip the origin may be set on this page.
- Product screenshot: one real screenshot of the **dashboard** (`/pt/dashboard`) in pt-PT with
  CrmWare branding — the global view that shows both areas (property list with "Gestão:
  Arrendamento / Condomínio", renda devida, valores em aberto, pedidos). Synthetic dataset
  created for it: one arrendamento property and one condomínio in Lisboa with a few frações,
  contracts, quotas and an assembleia. Stored as optimised WebP in
  `public/brand/crmware/landing/`. No real personal data.

## Content (pt-PT, `messages/pt.json` → `landing`)

1. **Header (sticky):** CrmWare logo (links to `/marketing`); right: link "Iniciar sessão"
   (`/pt/login`) and button "Fale connosco" (CTA URL).
2. **Hero** (video background with dark gradient):
   - Title: "Arrendamentos e condomínios, num só sistema."
   - Subtitle: "Imóveis, frações, contratos, quotas e assembleias organizados num só lugar — com
     portal para inquilinos e condóminos."
   - Fit line: "Para gestores de arrendamento e administradores de condomínios — use apenas as
     áreas de que precisa."
   - Buttons: "Fale connosco sobre a gestão imobiliária" (CTA URL), "Ver funcionalidades"
     (anchor `#funcionalidades`).
   - Video pause/play button with pt label ("Pausar vídeo" / "Reproduzir vídeo").
3. **Funcionalidades** (`id="funcionalidades"`), four cards, each with icon, title and three
   points:
   - Arrendamento — imóveis, frações e contratos · rendas e valores em aberto · cobrança com
     débito direto SEPA
   - Condomínio — permilagem e quotas · fundo comum de reserva · assembleias com ordem de
     trabalhos e votações
   - Operações — pedidos de manutenção e prestadores · documentos organizados · calendário de
     prazos
   - Portal — inquilinos e condóminos comunicam avarias e acompanham os pedidos · consultam valores
     em aberto e histórico de pagamentos · acedem às deliberações e documentos
4. **O produto** — the dashboard screenshot with a one-line caption ("Painel com arrendamentos e
   condomínios, rendas, valores em aberto e pedidos — dados de demonstração.").
5. **Porquê CrmWare**, four statements (the open-source card was removed by the product owner; the source link stays in the footer). They are self-declared on the page (no links); each is **verified before publication** as listed:
   - "Servidores na Alemanha (União Europeia)" — verified: this deployment runs on Hetzner Cloud,
     location nbg1 (Nuremberg).
   - "Acessos por perfil e registo de auditoria das alterações" — verified: role-based access
     (`src/lib/rbac.ts`) and the audit log (`/pt/audit`) exist. No "all changes" absolute, no
     certification claim.
   - "Interface em português de Portugal" — verified by the page and the screenshot.
   - "API REST e servidor MCP, com token pessoal, para ligar ferramentas e assistentes de IA aos
     seus dados" — verified by a functional test (see Testing). No product names (the MCP server
     uses a bearer token; e.g. ChatGPT connectors expect OAuth), and no "read-only" claim for the
     REST API, which also writes (`src/lib/api-write.ts`, `/api/v1/operations`). The MCP server exposes read and write tools (e.g. `create_record`,
     `run_operation`), so the page makes no read-only claim for either.
6. **Closing band:** "Vamos falar sobre a sua gestão imobiliária?" + button "Fale connosco sobre a
   gestão imobiliária".
7. **Footer:** "© 2026 {APP_NAME}", "Aviso legal" (`/pt/legal`), "Código-fonte"
   (`SOURCE_URL`), "Iniciar sessão" (`/pt/login`).

The final wording is the text approved in brainstorming; the product owner (native speaker)
reviews it in the implemented page.

## Visual design (CrmWare brand guidelines)

- Colours: black `#000000` text; teal `#53959c` primary buttons with black text, uppercase,
  bold, 4 px radius, hover `#4a8389`; beige `#e9decf` section backgrounds; neon green
  `#becd2f` only for small highlights; no red, no grey or blue tones.
- Typography: Arial, Helvetica, sans-serif throughout this page.
- Bauhaus: generous whitespace, white cards (8 px radius, `0 2px 8px rgba(0,0,0,.08)`),
  semicircle motifs as decoration, hover `translateY(-2px)` 0.2 s only.
- Logo in the header on a solid background, never on the video.
- Responsive, mobile-first; checked at 375, 768 and 1440 px. Video only from 768 px and without
  `prefers-reduced-motion`; otherwise the poster.
- Accessibility — concrete, verified checks (no blanket conformance claim): full keyboard
  walkthrough with visible focus; skip link to `main`; focus never hidden behind the sticky header
  (`scroll-padding-top`) and `scroll-margin-top` on `#funcionalidades`; `header/main/footer`
  landmarks, one `h1`, ordered headings; reflow at 320 px and 200 % zoom without horizontal
  scrolling; text contrast ≥ 4.5:1 over the poster and over representative video frames (dark
  gradient sized accordingly); decorative images `alt=""`, screenshot with descriptive alt;
  keyboard-operable pause button (WCAG 2.2.2).
- Performance budget: LCP < 2.5 s on mobile (Lighthouse mobile profile); poster ≤ 150 KB,
  screenshot ≤ 200 KB (WebP); video only ≥ 768 px, `preload="none"` until visible; no web fonts
  (Arial); total transfer on mobile ≤ 600 KB.

## Error handling

Static content, no data access. No brand video → poster; no poster → beige background. Missing
`landing.*` key → test fails before merge.

Hero video content (CrmWare video, 10 s, no audio): a business event lobby with a "Visionários do
Imobiliário" banner, an empty reception area, and a stage with the burned-in text "Gestão de
Arrendamento e Gestão de Condomínios" — on-topic for the PT audience. The poster is a frame from
the lobby shot. The video carries its own small CrmWare mark (bottom right).

## Testing

Unit tests (written first):

- Every `landing.*` key used by the page exists in `messages/pt.json`.
- No German law or terms in `landing.*` (BetrKV, HeizkostenV, GoBD, MEA), no pricing or
  testimonial keys, and no mention of the AI assistant or "integrações".
- The CTA constant equals the contact URL with UTM parameters; every "Fale connosco" uses it.
- The page takes name and logo from `brand.ts` (no literal brand name).
- `BackgroundVideo` keeps its current behaviour without the new props.
- Each background video has a poster JPEG next to it.

Functional test of the API/MCP claim (local image, synthetic data, before merge):

- Create a personal API token for a synthetic user; REST: `GET /api/v1/…` returns that tenant's
  data with the token and 401 without it.
- MCP: JSON-RPC `initialize`, `tools/list` and `tools/call portfolio_summary` over HTTP with the
  bearer token return the synthetic portfolio; without the token → 401.

Runtime verification (local image, before merge):

- `/marketing` → 200, `lang="pt-PT"`, title contains `APP_NAME`; `/marketing/index.html` still
  200; all internal and external links 200.
- Screenshots at 375, 768, 1440 px; pause button toggles the video; poster shown with
  `prefers-reduced-motion` and on mobile.
- The accessibility checks listed under Visual design, done by hand (keyboard, 320 px, 200 %
  zoom, contrast over poster and video frames); Lighthouse accessibility, performance and SEO
  reported as an additional signal, not as proof of conformance.
- Performance budget met (LCP, poster/screenshot sizes, mobile transfer).
- Access log: a request to `/marketing` produces exactly one log line without IP, headers or
  cookies; requests to `/pt/login` and `/api/*` produce none; `caddy validate` passes.
- CTA destination: `https://crmware.pt/pt/contact` answers in pt-PT (`lang="pt-PT"`) and shows
  the CrmWare brand.
- Attribution preconditions: the landing response sets no `Referrer-Policy` that strips the origin
  (and no `rel="noreferrer"` on CTA links); the website's lead handling keeps the referrer origin
  (`sanitizeReferrer`, checked in the website repo).

Smoke test after publication (devbox, cannot be done before merge because the origin must be
real):

- One test submission from `https://realestate.crmware.pt/marketing` through the real browser;
  the stored lead shows `referrer: https://realestate.crmware.pt`. Coordinated with the website
  owner; the test lead is marked as a test and deleted.

## Architecture review

Public static page: no tenant data, no queries, no auth, no billing, no locks. Outbound link to
crmware.pt only. Not applicable for tenant isolation, billing atomicity, unscoped queries,
locks, bypassable auth, leaked internal fields.

Personal data (GDPR): the new Caddy access log is limited to `/marketing` and stores no IP
address, no headers, no cookies — only timestamp, method, path, status, size and duration —
with 90-day retention. Leads are collected on crmware.pt under that site's privacy policy and
consent checkbox, not by this app.
