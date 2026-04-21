# Costea Web UI — Design & End-to-End Flow

> Version: v1.2 · 2026-04-21

---

## Position

Costea is cost infrastructure for the LLM-era agent stack — the role
Stripe plays for payments, Costea plays for tokens. A user should be
able to learn what a task will cost *before* they spend compute on it,
reconcile actuals *after* it runs, and audit aggregate spend across
every major runtime. The UI is the front door to that promise, so its
job is to make prediction feel as routine as checking out.

---

## Visual system

### Principles

1. **One signature, modern chrome.** The paper-receipt aesthetic is
   Costea's signature and stays — but only as an accent. The rest of
   the surface speaks the same language as Stripe / Linear / Vercel
   dashboards: soft elevation, gradient accents, glass surfaces,
   pristine typography.
2. **Every estimate is shareable.** The product is not just the model
   — it's the artifact the model produces. The receipt has a copyable
   URL, a plaintext ASCII variant, and a JSON variant.
3. **No false precision.** Confidence is plotted as a *band*, not a
   single number. The conformal p10/p50/p90 intervals are rendered on
   the page. The model behind the prediction is named.

### Tokens

All tokens live in `web/src/app/globals.css` and are consumed via
`@theme inline` so Tailwind utilities resolve to them.

| Layer | Token | Role |
|---|---|---|
| Background | `--background`, `--background-tint` | cream page canvas |
| Brand ramp | `--brand-a` indigo `--brand-b` coral `--brand-c` teal `--brand-d` amber | gradient mesh, chart fills, focus rings |
| Elevation | `--shadow-sm` → `--shadow-lg` + `--shadow-brand` | card + button |
| Radii | `--radius-sm` 6 → `--radius-xl` 22 | input → hero wrap |
| Motion | `--ease-out` | everything that isn't `linear` |

### Primitives

- `.card` / `.card-interactive` — the default container, a light
  surface with soft shadow and border-soft.
- `.glass` — translucent + backdrop-blurred; used for the
  HeroEstimator widget that floats over the mesh background.
- `.stat-tile` — a uniform tile for dashboard / accuracy stats
  (label, tabular-nums value, optional hint line).
- `.btn-primary` / `.btn-secondary` / `.btn-ghost` — pill-shaped
  buttons with a gradient glow on primary hover.
- `.pill` / `.pill-brand` / `.pill-positive` / `.pill-warn` — status
  and platform chips.
- `.gradient-text` — indigo → coral → teal text ramp, used for the
  hero word that needs to pop.
- `.mesh` — radial-gradient aurora background, mildly animated
  (22s drift cycle), only applied to hero sections.
- `.grid-dots` — subtle dotted overlay for hero sections on top
  of `.mesh`.
- `.codeblock` — surface-elevated + gradient ring for inline code.
- `.marquee-track` — infinite scroll row (used on the model shelf).

### Receipt (preserved accent)

The receipt card is kept verbatim: monospaced Courier, dashed rules,
double-line total, ASCII barcode. It appears in two places:

- **Landing hero** — as a static decorative artifact ringed by a conic
  gradient glow.
- **/estimate** — as the live render next to the prediction
  intervals and provider chart.

The skill's `receipt.sh` produces the same boxed layout, and the
Share menu on the web can copy the exact ASCII variant to clipboard
via `plaintextReceipt()`. CLI and Web are visually identical.

---

## Pages

| Route | Purpose |
|---|---|
| `/` | Landing. Mesh hero, live estimator widget, ensemble explainer, pricing table, install strip. |
| `/estimate` | Live predictor. 5-up stat tiles, conformal interval bars, provider chart, receipt, share menu. Accepts `?task=` deep-link. |
| `/dashboard` | Sessions ledger. Search, platform-tinted pills, sort. |
| `/analytics` | Cost over time (gradient area chart), cost/tokens by model, daily breakdown. |
| `/accuracy` | Scatter plots of predicted vs actual (cost, input, output, total), error distribution. |
| `/settings/training` | Retraining + schedule + history. |

---

## End-to-end flow

The product is a single prediction artifact that can start in either
surface and continue in the other.

```
   ┌───────────────────────────┐          ┌───────────────────────────┐
   │   Claude Code / Codex     │          │       Web UI              │
   │   /costea <task>          │          │   /estimate?task=<…>      │
   └────────────┬──────────────┘          └─────────────┬─────────────┘
                │                                       │
                │ fitting.Predictor.predict()           │ /api/estimate
                │ — same ensemble —                     │ — same ensemble —
                ▼                                       ▼
      receipt.sh (ASCII)  ◄──── plaintextReceipt() ────► ShareEstimate
                │                                       │
                │  COSTEA_WEB_URL set?                  │  Copy link / JSON
                ▼                                       ▼
     footer: "View interactive receipt: …" ──► /estimate deep-link
```

### CLI → Web

In the skill, the user runs `/costea refactor the auth module`. If
`COSTEA_WEB_URL=http://localhost:3000` is exported, `receipt.sh`
appends a footer with a direct `/estimate?task=…` URL. The script
`scripts/open-in-web.sh` is available for scripted opening (via
`open` / `xdg-open` / `start`), or in `--print` mode for piping.

### Web → CLI

On `/estimate`, the Share menu offers three copy actions:

1. **Copy link** — `/estimate?task=…` URL that replays the same input.
2. **Copy plaintext receipt** — ASCII-art box matching `receipt.sh`
   verbatim, pasteable into Slack, GitHub issues, a terminal.
3. **Copy JSON** — the `/api/estimate` response shape, for piping
   into other tooling.

---

## Prediction surface

Prediction is the product. The UI therefore surfaces the mechanism,
not just the answer:

- **Method badge** near the confidence tile names the active model
  (`GBDT`, `MLP`, `Linear`, or `ensemble`) with a brand-tinted pill
  when it's an ML method and a neutral pill when it's the heuristic
  fallback.
- **Conformal intervals** are rendered as one gradient bar per
  dimension (cost / input / output / cache_read / tools). p10 and
  p90 label the ends; a solid marker pins the median. Users read
  the *width* of the band to sense uncertainty, not just a scalar.
- **Provider comparison** is a horizontal bar chart sorted by cost,
  with the cheapest row winning a brand gradient + a `best` pill.

---

## Skeletons & loading

Every page that fetches data has a pulsed skeleton matching the
post-load layout — eyebrow + h1 + stat-tile row + card placeholders.
This avoids layout shift when data arrives and gives a clear signal
that something is happening. `/estimate` uses this skeleton while the
ensemble is running; the caption reads:

> Running ensemble prediction through GBDT · MLP · Linear…

---

## Mobile

A side-sheet drawer carries the full nav below the `md:` breakpoint,
with backdrop tap + Escape to dismiss and body-scroll lock while
open. Hero typography steps down to 36px on narrow viewports. The
pricing table sets a `min-width: 620px` so it horizontal-scrolls
inside its card on phones rather than squishing numeric columns.

---

## File map

```
web/src/app/
  globals.css              design tokens + chrome primitives
  layout.tsx               nav (with <MobileNav/>), footer
  page.tsx                 landing — mesh hero + live estimator + pricing
  estimate/page.tsx        /estimate — predictor, intervals, share
  dashboard/page.tsx       /dashboard — ledger
  analytics/page.tsx       /analytics — charts
  accuracy/page.tsx        /accuracy — scatter + error distribution
  settings/training/…      /settings/training — retrain

web/src/components/
  HeroEstimator.tsx        client-side live widget on the landing
  ShareEstimate.tsx        share menu + plaintext formatter
  MobileNav.tsx            hamburger + side-sheet
  PlatformIcon.tsx         per-source icon

skills/costea/scripts/
  receipt.sh               ASCII receipt — appends Web URL when
                           COSTEA_WEB_URL is set
  open-in-web.sh           open/print /estimate?task=… URL
```
