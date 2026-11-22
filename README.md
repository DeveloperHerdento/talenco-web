# talenco-web

> Marketing site, bilingual (ja/en) registration wizard, and embedded Xendit card-payment flow for
> the TalenCo Global Career Starter Program (client: LBI).

**Owner:** @DeveloperHerdento (TODO(owner): confirm team) · **Status:** live, maintenance only — payment-service integration in progress

## Getting started

Requirements: Node 24 (see `.nvmrc`).

```bash
git clone https://github.com/DeveloperHerdento/talenco-web.git && cd talenco-web
cp .env.example .env          # fill in real values (ask the owner)
npm ci
npm run dev                   # http://127.0.0.1:3000
```

## Common tasks

| Task | Command |
|---|---|
| Run locally | `npm run dev` |
| Lint | `npm run lint` |
| Format | `npm run format` (CI runs `npm run format:check`) |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Build | `npm run build` |

> Next.js 16 has breaking changes compared with older versions (e.g. `proxy.ts` replaces `middleware.ts`).
> Check the docs bundled in `node_modules/next/dist/docs/` before changing framework-level code.

## Run with Docker

Production-like container (Next.js standalone, external Supabase, no database container). Details,
build args and rollback: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

```bash
docker build -t talenco-web:local \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
  --build-arg NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000 .
docker run --rm --env-file .env -p 127.0.0.1:3000:3000 talenco-web:local
curl -fsS http://127.0.0.1:3000/api/health   # {"status":"ok"}
```

On a server use `docker-compose.yml` (`IMAGE`, `PORT` and every key from `.env.example` in `.env`, then `docker compose up -d`).

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19 |
| Styling | Tailwind CSS v4 |
| Database | Supabase (Postgres + service-role client) |
| Payments | Xendit **Sessions API** (`mode: COMPONENTS`, embedded card form) |
| Email | Resend |
| Bot protection | Cloudflare Turnstile |
| Rate limiting | Upstash Redis (no-op in local dev — see `lib/ratelimit.ts`) |
| i18n | Custom dictionary lookup (`lib/i18n/`), ja/en, locale in the URL path |
| Deployment | Netlify (current); Docker image + compose also available (`docs/DEPLOYMENT.md`) |

## Project Structure

```
app/
  [lang]/                        Locale-prefixed routes (/ja, /en) — see "i18n" below
    page.tsx                     Landing page
    layout.tsx                   Locale-scoped layout
    course/page.tsx              Program curriculum / scheme details
    register/page.tsx            4-step registration wizard
    my/page.tsx                  Token-based status page — payment entry point + installment panel
    (legal)/privacy/page.tsx     Privacy policy
    (legal)/terms/page.tsx       Terms of service
  api/
    health/route.ts              GET  — liveness check for the Docker healthcheck
    register/route.ts            POST — validates, verifies Turnstile, inserts registration
    payment/
      checkout/route.ts          POST — creates the order + payment session in payment-service
      order/route.ts             GET  — polled by the client to confirm the payment landed
      webhook/route.ts           POST — legacy: peeka relays Xendit's webhook here (old direct-Xendit registrations)
      installment-charge-now/route.ts    POST — legacy installments: user-initiated "pay next"/"pay all remaining"
      installment-status/route.ts        GET  — polled installment progress
    payments/
      webhook/route.ts           POST — signed events from payment-service; sole authority for marking paid
    admin/
      login/route.ts               POST — admin session login
      logout/route.ts              POST — admin session logout
  admin/
    login/page.tsx                 Admin login screen
    page.tsx                       Registrations/inquiries dashboard (tables, pagination, search)
    layout.tsx                     Auth-gated admin shell
  global-not-found.tsx
  robots.ts / sitemap.ts
  globals.css

components/
  course/     Program/curriculum content sections
  layout/     Navbar, footer, language toggle, mobile drawer
  payment/    PaymentStep, InstallmentPaymentPanel, PaymentSuccessBadge, shared Xendit Components hook
  register/   RegisterForm, RegisterSidebar
  admin/      AdminTable, InquiriesTable + shared bits (SearchInput, TableSkeletonRows, EmptyTableRow, Pager, Banner)
  sections/   Landing page sections (Hero, FAQ, Testimonials, ...)
  ui/         Small shared primitives (Button, Reveal, SectionHeading, HoverIconBadge, ...)
  docs/       Layout pieces for the course/curriculum pages

lib/
  constants/       Static content + PROGRAM_FEES/pricing logic (payment.ts)
  i18n/             get-dictionary.ts + dictionaries/{en,ja}.ts, locales.ts
  admin/            Admin auth/session status, useLoadingPulse, usePaginatedList
  env.ts            Server-only env var validation — throws at import time if anything's missing
  supabase.ts       Supabase client (service-role key, bypasses RLS, server-only)
  xendit.ts         createCardPaymentSession() — POST https://api.xendit.co/sessions
  xendit-payments.ts Payments API client (installment plan — saved-card, auto-charged)
  installments.ts   claimAndChargeInstallments() — shared atomic-claim-then-charge logic
  admin-auth.ts     Admin session verification
  resend.ts         Resend client
  emails/           Transactional email templates
  ratelimit.ts      Upstash rate limiters (no-op in dev)
  redis.ts          Upstash Redis client
  logger.ts         Structured JSON logger
  request.ts        getClientIp()
  html.ts           htmlEscape() — XSS prevention for emails
  timing-safe.ts    Constant-time comparisons for secrets/tokens
  fonts.ts          Shared next/font/google setup (site + admin variants)
  alerts.ts         Ops/error alerting

hooks/              useMobile, useScrolled
proxy.ts            Locale routing — redirects "/" to a cookie/default locale, rewrites unknown
                     locale segments to the 404 page, sets the locale cookie (replaces middleware.ts)
```

`app/[lang]/` and `proxy.ts` are the whole i18n mechanism — there's no separate `locales/` JSON
tree or `i18next` runtime. See `lib/i18n/dictionaries/{en,ja}.ts`.

## Environment Variables

The required list is enforced at startup by `lib/env.ts` — it throws on import if anything's
missing, so a misconfigured deploy fails the whole build rather than one request at a time.

Every variable is listed in [`.env.example`](.env.example) with a comment and a dummy value. Real values go in
`.env`, which git ignores.

Full variable-by-variable reference, sensitivity, and where to get each one:
**`docs/env-troubleshooting.md`**.

## Database

Three tables: `registrations` (one row per applicant) and, for the installment path,
`installment_plans` + `installments`. Full migration SQL is in **`docs/testing-payment.md`, steps
1 and 1b** — that's the copy-pasteable source of truth, not duplicated here. RLS is optional
defense-in-depth only; every query goes through the service-role client server-side (see "RLS" in
`docs/payment.md`).

## Local Development

Rate limiting is skipped entirely in `NODE_ENV=development` (no Upstash account needed to run
locally — see `lib/ratelimit.ts`). Turnstile has a dev-bypass path too when no site key is
configured. To test the Xendit webhook locally you need a public URL — see `docs/testing-payment.md`
for the full ngrok + test-mode walkthrough.

```bash
npm run typecheck
npm run test        # Vitest — pure-logic unit tests, no network/DB required
```

Test coverage today is deliberately narrow: pricing/installment math
(`lib/constants/payment.ts`), the admin status derivation
(`lib/admin/status.ts`), and the constant-time token comparison
(`lib/timing-safe.ts`) — the logic that's cheapest to get wrong silently and
cheapest to test without mocking Supabase/Xendit. The API routes themselves
have no automated coverage yet.

## Payment Flow (short version)

```
Register wizard → POST /api/register → registrations row created, confirmation email sent
                   with a /[lang]/my?token=<accessToken> link

/my (token page) → PaymentStep → POST /api/payment/checkout → payment-service POST /v1/checkouts
                   → embedded card form (Xendit Components, no redirect) → session-complete event
                   → client polls /api/payment/order until payment-service reports the order paid

Xendit → peeka (peekainsight.com) → POST /api/payment/webhook → verifies peeka's HMAC
         forward signature → atomically marks the matching registration paid → sends
         confirmation email

If payment_type = "installment": /my instead shows InstallmentPaymentPanel — a fixed 4x
saved-card plan on a separate Xendit surface (Payments API). See docs/payment.md → "Installment plan."
```

Full architecture, every security decision, and why each one was made:
**`docs/payment.md`** — read this before touching anything under `app/api/payment/`,
`components/payment/`, or `lib/xendit.ts`.

## Other Docs

| Doc | What it's for |
|---|---|
| `docs/payment.md` | Xendit payment architecture, security decisions, known gaps |
| `docs/testing-payment.md` | Step-by-step checklist to run the payment flow end-to-end, incl. the DB migration SQL |
| `docs/DEPLOYMENT.md` | Docker deployment (build, run, verify, rollback) |
| `docs/deployment-netlify.md` | Netlify launch checklist, in order (current hosting) |
| `docs/env-troubleshooting.md` | Every env var, what it's for, and symptom → cause → fix |
| `docs/database-migration.md` | Full Supabase schema reference (SQL applied by hand in the SQL Editor) |
| `docs/developer-documentation.md` | Project hand-over document (scope, architecture, status) |
| `docs/notes/` | Local working notes, git-ignored (plans, archived drafts) |
| `docs/adr/` | Architecture decision records (copy `0000-template.md`) |
| `docs/learn.md` | Deep-dive teaching guide — Next.js concepts + how this specific codebase works |

## Contributing

Branch from `develop` (`feat/…`, `fix/…`), keep pull requests small, and fill in the PR template.
Commit messages follow `type(scope): description`. Notable changes go in [`CHANGELOG.md`](CHANGELOG.md).
