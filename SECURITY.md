# Security Guide

## Client-Visible Configuration

Every `VITE_` value is public: Vite embeds it in the browser or native WebView bundle. Never put a general-purpose provider secret in one. The deliberately client-visible values are:

| Value                                                          | Purpose                 | Required protection                                                                                  |
| -------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL` and publishable/anon key                   | Supabase project access | Row-Level Security, function authorization, bounded public quotas, and least-privilege database RPCs |
| `VITE_MAPBOX_ACCESS_TOKEN`                                     | Maps and directions     | Public-scope token restricted to the production origins and required Mapbox APIs                     |
| `VITE_LINZ_API_KEY`                                            | Public nautical charts  | Provider-side restrictions and no write/account privileges                                           |
| `VITE_SENTRY_DSN`                                              | Error ingestion         | Ingest-only DSN, Sentry project filtering, and no confidential data in event payloads                |
| `VITE_TRANSISTOR_LICENSE_KEY`                                  | Native background GPS   | Vendor/device restrictions; treat bundle extraction as possible                                      |
| `VITE_GOOGLE_OAUTH_CLIENT_ID` and endpoint/feature-flag values | OAuth identity/config   | These are identifiers or configuration, not client secrets                                           |

Paid/general-purpose credentials for OpenWeatherMap, Open-Meteo, StormGlass, WorldTides, Gemini, Rainbow.ai, Spoonacular, WeatherKit, voice providers, and similar services belong in server secrets. OpenWeatherMap tiles use the bounded Vercel `/api/owm-tile` proxy; other active integrations use bounded Supabase/worker proxies. Provider keys are not accepted from the client. Native Pi integration uses a pinned HTTPS lane and a startup-constrained outbound policy; browser, old, and stripped native shells fail closed.

Operationally:

- `npm run build` rejects forbidden provider-secret names in active `.env` files and scans the generated web `dist`; `npm run ship` repeats the artifact scan after Capacitor sync so the copied native assets are covered.
- Restrict every public provider token in its provider dashboard.
- Rotate a token immediately if its permissions or allowed origins are broader than intended.
- Treat RLS and server quotas as the security boundary; client-side throttles are only UX and bandwidth protection.

## Content Security Policy

CSP is defined in both `index.html` (meta tag) and `vercel.json` (HTTP header).

### Accepted Trade-offs

| Directive                                         | Risk   | Reason                                                                                                             |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `script-src 'unsafe-inline'`                      | Medium | The app shell still contains inline startup/error-recovery code used before the React entry loads.                 |
| `style-src 'unsafe-inline'`                       | Medium | The shell and runtime map/UI libraries still generate inline styles.                                               |
| `img-src https: http:` (configured hosted policy) | Medium | User-selected chart/map imagery spans many providers; active content remains blocked.                              |
| `connect-src http:` (native shell)                | Medium | Retained for local development; production Pi traffic uses the native pinned-HTTPS verifier with no HTTP fallback. |

### Mitigations configured in source

- `'unsafe-eval'` **removed** from `script-src` — Vite production builds don't use eval
- The redundant CDN import map was removed; production scripts are self-hosted bundles
- `frame-ancestors 'none'` is present in the configured hosted header to prevent clickjacking; hosted verification is
  still required
- `frame-src 'none'` — no iframes allowed
- `base-uri 'self'` — prevents base tag injection
- `object-src 'none'` and `form-action 'self'` are present in the configured Vercel HTTP policy
- `connect-src` is a constrained allowlist; it still includes required direct Deepgram, Open-Meteo, and Google origins

These are source and hosting-configuration properties, not deployment evidence. The hosted preview must return the
expected headers and pass the release smoke before the HTTP policy can be described as deployed.

## Raspberry Pi public-beta boundary

The native public-beta candidate can use the optional Pi integration only when `PiTlsPlugin` is present. Pairing pins
the Pi public key, subsequent app requests use HTTPS through the native verifier, and there is no plaintext or
unverified fallback. Browser builds and old or stripped native shells therefore cannot discover, pair, configure,
relay private diary data, sync charts, or call Pi-hosted Signal K/AVNav/N2K surfaces. The separate on-device ENC
Library accepts already-converted packs without contacting a Pi, but cannot authenticate their publisher or contents:
they are stored as unverified reference overlays and excluded from hazard queries, route verification, Route Tracer,
and Cast Off.

The companion `pi-cache` server is also fail-closed by default:

- it binds to `127.0.0.1`; `THALASSA_PI_LAN_BIND=1` is required to listen on the LAN;
- CORS is same-origin unless exact origins are listed in `THALASSA_CORS_ORIGINS`; `*` is ignored;
- `/status` contains cache counts and capability state only—no coordinates, owner IDs, relay details, paths, or tokens;
- configuration, cache mutation, generic passthrough, chart, ENC, pairing, diary, OSM route, app-hosting, scheduler, and
  ENC-watcher surfaces require `THALASSA_UNSAFE_ADMIN_API=1`; the watcher additionally requires
  `ENC_WATCHER_ENABLED=true`.

Those environment values enable LAN/private administration; they are not authentication. Never expose that mode to an
untrusted LAN, bypass the native certificate pin, or add a plaintext fallback.

## Production deployment and scheduled-writer boundaries

The checked-in manifests are deliberately deterministic, but they do not prove what an external host is running:

- AIS ingest builds in a Node 22 stage with `npm ci`, compiles to `dist`, prunes development dependencies, and copies
  only the production dependency tree and compiled output into a second Node 22 stage that runs as the non-root `node`
  user. Railway is configured for that Dockerfile and `node dist/index.js`. The privileged Guardian watchdog starts
  only when `GUARDIAN_WATCHDOG_ENABLED` is exactly `true`; absence, case variants, or whitespace keep it off.
- Pi install and redeploy perform clean lockfile installs, compile, and prune to production dependencies. Public-beta
  access requires the native Pi TLS verifier: pairing pins the Pi public key, requests use HTTPS, and builds without
  that verifier fail closed with no plaintext or unverified fallback.
- The retired Railway `vessel-scraper` cannot build or start: its Dockerfile and package start command exit 78, its
  Railway manifest has no cron/start/build command, and its watch pattern is inert. The external Railway project must
  still be inspected and disabled or deleted; source cannot establish remote service state.
- The retired CMEMS Mapbox tile-probe and tileset-status workflows are retained as explicit exit-78 tombstones with
  empty token permissions and no secret, environment, action, or network access. They cannot dump authenticated
  upstream headers or bodies, and they are not part of the immutable release-asset publication path.
- The LINZ/Maritime NZ MSI workflow has read-only repository permission, non-cancelling concurrency, a committed Node
  22 lockfile, audit/tree/tests before the secret-bearing step, sandboxed Chromium, and a browser environment allowlist
  that excludes Supabase credentials. It rejects stale/future pages, duplicate or implausible results, excessive
  payloads, and sudden count collapse, and `DRY_RUN=1` performs no database write. Release still requires a successful
  hosted run against the real Cloudflare page, scoped GitHub secrets, and the intended table. Its current
  upsert-then-delete reconciliation is not atomic; a least-privilege transactional database RPC is the preferred future
  boundary if this advisory feed remains enabled.

## Live marine-data trust boundary

The canonical beta profile currently selects six CMEMS grids plus the MPA overlay. A `true` build flag is not a data
trust boundary. Before those seven overlays can ship, their frozen producer and client contracts must prove immutable
generation assets, manifest-last publication, actual source-time coverage and freshness, byte caps before allocation,
SHA-256 integrity, exact schema/dimension/cadence checks, finite and physically bounded values, attribution, and
fail-closed mixed-generation handling. MPA GeoJSON must pass the same bounded manifest/integrity path before it reaches
Mapbox. If any final local or hosted trust gate fails, the corresponding canonical flag must be false.

Each marine generation is stored under an ISO-week shard; only its rolling manifest is mutable, and that manifest is
published last. CMEMS map clients use manifests for time alignment and fetch one selected immutable frame rather than
the full forecast. Reads are capped before allocation, decoded ownership is limited to two frames / 32 MiB and one
visible CMEMS marine product, and hide/scrub/refresh/failure paths abort and release stale ownership. The waves writer
runs every 12 hours and accepts at most 15-hour-old source data—exactly one three-hour cadence margin—while currents
remain capped at 12 hours.

The routing adapter is deliberately no-network and returns no CMEMS current field in this beta. Display-layer data is
not silently reused as routing authority; a future current-adjusted route requires a separately bounded, signed, and
land-mask-verified regional or tiled source.

CAPAD protection classes are inherently insufficient to determine a legal activity at a particular place and time.
The popup therefore calls each result inferred, directs the skipper to the managing authority for current fishing and
anchoring rules, and states that the overlay is neither legal advice nor navigation. On a generation swap, the old
Mapbox source and parsed cache are removed before replacement bytes are accepted, so stale protection data cannot stay
visible while a new generation is being verified.

## Public-beta backend release boundary

Local migrations and Edge Function source are not evidence that the live Supabase project runs the same code. Release
requires exact local/remote migration parity, an allowlisted deployed Function inventory, and authenticated live
smokes against the frozen versions. At this snapshot that parity is not established:

- `20260805103000_hold_precise_track_sharing.sql`,
  `20260805110000_enforce_traced_route_cast_off_verification.sql`, and
  `20260806120000_account_deletion_durability.sql` were local-only at the latest remote audit. Until they are deployed,
  the precise-track privacy hold, database-authoritative traced-route Cast Off check, and durable account-deletion
  boundary are not live.
- Local `float-plan` source is a `410 Gone` tombstone and local `musickit-token` source returns `503` for this beta, but
  those fail-closed revisions are not yet proved deployed. The latest remote inventory still exposed historical
  handlers, including retired `create-marketplace-payment`, `capture-escrow-payment`, and `sweep-expired-escrows`
  Functions that are absent from the intended beta surface.
- `register-apple-token` and `apple-server-notification` appeared only in local source at the latest Function inventory;
  Apple token-lifecycle capability must be treated as undeployed until remote parity and live behavior are proved.
- Guardian is enabled in the candidate client. The linked migration ledger records
  `20260804191000_guardian_presence_privacy.sql` and `20260804192000_guardian_broadcast_contract.sql` remotely, but
  ledger parity is not authenticated runtime evidence: live arm/disarm/discovery/broadcast smoke remains mandatory.
  The privileged AIS watchdog is a separate exact opt-in and must remain verified off unless deliberately deployed.
- Account deletion remains a release blocker. Approved local source now contains a durable per-user tombstone, dynamic
  write fences, exact owner-linked Storage inventory/verification, atomic survivor scrubbing, and an auth-last resumable
  workflow. None of that is remote evidence: the migration and Function remain undeployed, and the deployed Function is
  older than the local source. The exact boundary must be independently reviewed, deployed, and exercised against
  authenticated concurrent writers, interrupted cleanup, Storage races, and re-authentication before account creation
  may ship. `VITE_ACCOUNT_DELETION_ENABLED` must remain `false` until those checks pass.

Apple's account-deletion guidance states that an app supporting account creation must provide deletion in-app; an
email-only support path is not the release solution for this product. Keep account creation distribution blocked while
the deletion hold is active. See
[Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/).

The candidate privacy-policy URL returned HTTP 200 in the 2026-08-05 read-only check, but the hosted bytes did not
match the revised local terms. On 2026-08-26, Google Admin confirmed `privacy@thalassawx.com` as an alternate address
on the monitored `captain@serene-summer.com` mailbox. Exact candidate deployment, byte verification, and owner/legal
approval remain required.

Do not call this candidate shippable, or describe these controls as live, until the deployment and smoke evidence is
recorded for the frozen commit.

## Error Suppression

The app suppresses iOS WKWebView `TypeError: readonly property` errors at three levels:

1. **`index.html`** global handler — catches before React, limited to `TypeError` only, logs count
2. **`ErrorBoundary.tsx`** — prevents React tree crash for this specific harmless error
3. **`sentry.ts` `beforeSend`** — prevents noise in Sentry, logs breadcrumb instead

All three are scoped to `readonly property` string matching only. A session counter warns at 100+ occurrences.

## Rate Limiting

`utils/rateLimiter.ts` provides a persistent client-side token bucket to reduce accidental repeat calls and satellite-data use. It is bypassable and is **not** an authorization or billing boundary.

Reviewed local Supabase Edge Functions are designed to enforce the authoritative boundary before paid upstream work:
authenticated callers receive bounded quotas, anonymous/public lanes receive smaller quotas, parameters and response
sizes are capped, and cron-only functions require service-role authorization. Those claims apply only to functions
whose exact reviewed version is verified in the remote inventory.

## Dependency Auditing

The root Node 24 CI job performs a strict lockfile install without legacy peer-dependency overrides, requires the
complete tree to pass `npm ls --all`, checks declared and imported dependency hygiene, and runs
`npm audit --audit-level=high`. Both high and critical findings fail the job, and peer-tree failures cannot be hidden by
a successful top-level install. The frozen local Node 24 run completed `npm ci`, `npm ls --all`, the 50/50 dependency
hygiene gate, and the high/critical audit with 0 vulnerabilities; hosted CI for the immutable commit remains pending.
Nested-package results do not prove the root tree.

Workflow supply-chain inputs are source-gated: every `uses:` reference must match a reviewed full commit SHA and retain
its release-version comment, every hosted runner is Ubuntu 24.04, and token permissions are explicit. The edge runtime
is pinned to the locally validated Deno 2.9.4 patch. Supported Node LTS majors deliberately float only within their
selected major so security patches are not held back.

Marine publisher contract fixtures run before any producer credentials enter the job. Both uppercase and lowercase
HTTP(S)/ALL proxy variables point at a closed localhost port, while `NO_PROXY`/`no_proxy` allow only loopback names and
addresses; a wildcard bypass is a source-gate failure.

Independently recorded package evidence uses the production runtime floors rather than the root runtime:

- AIS ingest on Node 22: final audit reported 0 vulnerabilities and `npm ls --all` passed.
- Deepgram proxy on Node 22: final audit reported 0 vulnerabilities and `npm ls --all` passed.
- Pi cache on Node 20.20.2: the full 46/46 suite, TypeScript build, live pinned TLS/SNI request, exact-LAN allowlist,
  and Overpass POST passed. Public-beta access remains restricted to a native shell with the Pi TLS pinning verifier;
  web, old, and stripped shells fail closed.

The release source gate additionally checks the AIS multi-stage/non-root runtime, the Pi clean-install/build/prune
order, both retired service/debug boundaries, the LINZ locked writer boundary, workflow pins/runners/permissions, and
MPA safety wording. These static contracts prevent accidental regression; they are still not remote-deployment
evidence.

These results establish only the named lockfile/runtime boundaries. They do not prove a hosted deployment, Supabase
parity, native artifact parity, signing, or overall release readiness.
