# Security Guide

## Client-Visible Configuration

Every `VITE_` value is public: Vite embeds it in the browser or native WebView bundle. Never put a general-purpose provider secret in one. The deliberately client-visible values are:

| Value                                                          | Purpose                 | Required protection                                                                                  |
| -------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL` and publishable/anon key                   | Supabase project access | Row-Level Security, function authorization, bounded public quotas, and least-privilege database RPCs |
| `VITE_MAPBOX_ACCESS_TOKEN`                                     | Maps and directions     | Public-scope token restricted to the production origins and required Mapbox APIs                     |
| `VITE_OWM_API_KEY`                                             | Public weather tiles    | Provider-side origin/API restrictions and a deliberately low-privilege tile-only account             |
| `VITE_LINZ_API_KEY`                                            | Public nautical charts  | Provider-side restrictions and no write/account privileges                                           |
| `VITE_SENTRY_DSN`                                              | Error ingestion         | Ingest-only DSN, Sentry project filtering, and no confidential data in event payloads                |
| `VITE_TRANSISTOR_LICENSE_KEY`                                  | Native background GPS   | Vendor/device restrictions; treat bundle extraction as possible                                      |
| `VITE_GOOGLE_OAUTH_CLIENT_ID` and endpoint/feature-flag values | OAuth identity/config   | These are identifiers or configuration, not client secrets                                           |

Paid/general-purpose credentials for Open-Meteo, StormGlass, WorldTides, Gemini, Rainbow.ai, Spoonacular, WeatherKit, voice providers, and similar services belong in server secrets. Installed-app and Pi requests reach them through bounded Supabase/worker proxies; provider keys are not accepted from the client.

Operationally:

- `npm run build` rejects forbidden provider-secret names in active `.env` files and scans the generated web/native assets; `npm run ship` repeats the scan after Capacitor sync.
- Restrict every public provider token in its provider dashboard.
- Rotate a token immediately if its permissions or allowed origins are broader than intended.
- Treat RLS and server quotas as the security boundary; client-side throttles are only UX and bandwidth protection.

## Content Security Policy

CSP is defined in both `index.html` (meta tag) and `vercel.json` (HTTP header).

### Accepted Trade-offs

| Directive                         | Risk   | Reason                                                                                             |
| --------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `script-src 'unsafe-inline'`      | Medium | The app shell still contains inline startup/error-recovery code used before the React entry loads. |
| `style-src 'unsafe-inline'`       | Medium | The shell and runtime map/UI libraries still generate inline styles.                               |
| `img-src https: http:` (deployed) | Medium | User-selected chart/map imagery spans many providers; active content remains blocked.              |
| `connect-src http:` (native only) | Medium | The meta policy permits a boat-LAN Pi over HTTP; the deployed Vercel header does not.              |

### Mitigations Applied

- `'unsafe-eval'` **removed** from `script-src` — Vite production builds don't use eval
- The redundant CDN import map was removed; production scripts are self-hosted bundles
- `frame-ancestors 'none'` — prevents clickjacking
- `frame-src 'none'` — no iframes allowed
- `base-uri 'self'` — prevents base tag injection
- `object-src 'none'` and `form-action 'self'` are enforced by the deployed HTTP policy
- `connect-src` excludes direct paid-provider origins now handled by server proxies

## Error Suppression

The app suppresses iOS WKWebView `TypeError: readonly property` errors at three levels:

1. **`index.html`** global handler — catches before React, limited to `TypeError` only, logs count
2. **`ErrorBoundary.tsx`** — prevents React tree crash for this specific harmless error
3. **`sentry.ts` `beforeSend`** — prevents noise in Sentry, logs breadcrumb instead

All three are scoped to `readonly property` string matching only. A session counter warns at 100+ occurrences.

## Rate Limiting

`utils/rateLimiter.ts` provides a persistent client-side token bucket to reduce accidental repeat calls and satellite-data use. It is bypassable and is **not** an authorization or billing boundary.

Supabase Edge Functions enforce the authoritative boundary before paid upstream work: authenticated callers receive bounded quotas, anonymous/public lanes receive smaller quotas, parameters and response sizes are capped, and cron-only functions require service-role authorization.

## Dependency Auditing

CI runs `npm audit` in two tiers:

- **Critical vulnerabilities → CI fails** (blocks merge)
- **High vulnerabilities → CI warns** (logged, does not block)
