# Portugal market — Phase 1 (+ fiscal workarounds)

Tracked in [#1](https://github.com/manueljpconde/hausverwaltung/issues/1).

## Product

- Single codebase; locales **de | en | pt**
- `Tenant.market` ∈ `{ DE, PT }` (default `DE`) — Settings → General (ADMIN only)
- CrmWare / PT installs: set **Market = Portugal (PT)**

## Ops vocabulary (market=PT)

- Nav: Condomínio (same `/weg` route; DB enum still `WEG`)
- Management labels: Arrendamento / Condomínio
- Empty condominium page: CTA → Properties

## Fiscal workarounds (closes Phase 2 of #1 — not certified engines)

| Need | Workaround in HaVeWa |
|---|---|
| **SAF-T PT** | Reports / CSV exports + REST/MCP → external accounting (DATEV export remains DE-oriented) |
| **E-faturação** | Issue invoices in certified PT software; store PDF/XML under **Documents**; keep charges/payments here |
| **IMI** | **Property tax** screen as a manual register (VPT / rate / note / PDF in documents). Labels stay generic until a dedicated IMI model exists |

No SAF-T generator, AT e-invoice certification, or full IMI engine in this issue.

## Deploy

1. Merge PR → `prisma migrate deploy` (adds `Tenant.market`)
2. Settings → Market = **Portugal (PT)**
3. Optional: UI language **Português**
