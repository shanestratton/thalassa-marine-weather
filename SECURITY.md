# Security Guide

## Client-Side API Keys

Thalassa is a single-page application (SPA) — some API keys necessarily end up in the client bundle. This is an inherent SPA trade-off. Below are the exposed keys and their mitigations.

| Key                                       | Service        | Mitigation                                                                                              |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_KEY` | Supabase       | **Anon key** — protected by Row-Level Security (RLS). Cannot access data without authenticated session. |
| `VITE_MAPBOX_ACCESS_TOKEN`                | Mapbox         | Domain-restricted via Mapbox dashboard. Only works from `thalassa.app` and `localhost`.                 |
| `VITE_STORMGLASS_API_KEY`                 | Stormglass     | Free tier with 10 req/day limit. Client-side rate limiter enforces this.                                |
| `VITE_OPEN_METEO_API_KEY`                 | Open-Meteo     | Commercial key with usage-based billing. Protected by rate limiter.                                     |
| `VITE_OWM_API_KEY`                        | OpenWeatherMap | Public weather tiles — low-value target.                                                                |
| `VITE_SENTRY_DSN`                         | Sentry         | Write-only DSN — can only _send_ errors, not read them.                                                 |
| `VITE_TRANSISTOR_LICENSE_KEY`             | Background Geo | Native plugin license — useless outside the app binary.                                                 |

### Future Improvements

- **Proxy Stormglass/Gemini through Supabase edge functions** — keeps API keys server-side
- **Implement per-user request signing** — Supabase function validates auth before forwarding

## Content Security Policy

CSP is defined in both `index.html` (meta tag) and `vercel.json` (HTTP header).

### Accepted Trade-offs

| Directive                    | Risk   | Reason                                                                                                   |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `script-src 'unsafe-inline'` | Medium | Required by Vite dev server and Capacitor WebView bootstrap. Cannot be removed without breaking the app. |
| `script-src https://esm.sh`  | Low    | Importmap loads pinned, exact-version packages from esm.sh CDN. Versions are not semver ranges.          |

### Mitigations Applied

- `'unsafe-eval'` **removed** from `script-src` — Vite production builds don't use eval
- `frame-ancestors 'none'` — prevents clickjacking
- `frame-src 'none'` — no iframes allowed
- `base-uri 'self'` — prevents base tag injection
- `connect-src` whitelist — only known API domains

## Error Suppression

The app suppresses iOS WKWebView `TypeError: readonly property` errors at three levels:

1. **`index.html`** global handler — catches before React, limited to `TypeError` only, logs count
2. **`ErrorBoundary.tsx`** — prevents React tree crash for this specific harmless error
3. **`sentry.ts` `beforeSend`** — prevents noise in Sentry, logs breadcrumb instead

All three are scoped to `readonly property` string matching only. A session counter warns at 100+ occurrences.

## Rate Limiting

Client-side rate limiting via `utils/rateLimiter.ts` (token-bucket algorithm):

| API        | Limit        | Window   |
| ---------- | ------------ | -------- |
| Stormglass | 10 requests  | 24 hours |
| Open-Meteo | 60 requests  | 1 hour   |
| Mapbox     | 100 requests | 1 minute |
| Gemini     | 15 requests  | 1 minute |
| WorldTides | 50 requests  | 24 hours |

Rate limits persist across page refreshes via `localStorage`.

## Dependency Auditing

CI runs `npm audit` in two tiers:

- **Critical vulnerabilities → CI fails** (blocks merge)
- **High vulnerabilities → CI warns** (logged, does not block)
