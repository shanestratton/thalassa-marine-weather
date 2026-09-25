# Web release — 25 September 2026

Published at the skipper's explicit request, after the archive completeness,
archive presentation and full-height HUD changes were built and synced locally.
Xcode 26.6 was opened on `ios/App/App.xcworkspace`; no phone installation or
TestFlight upload was performed in this publishing step.

## Delivery

- Vercel project: `thalassa`, existing `serene-summer` team.
- Deployment: `dpl_9KeycKbZYsdEqxR8AMvcWzp9L8KN`.
- Candidate: `https://thalassa-k54bahshc-serene-summer.vercel.app`.
- Previous production / rollback reference:
  `dpl_HFBWehm8sRLgQu4iUGZDsZSfn2VE`,
  `https://thalassa-h9mfd4ahx-serene-summer.vercel.app`.
- Used a separate, current-source release snapshot, excluding native/Pi
  projects, local outputs, photo working directories and environment files.
  Middleware and API proxy source were retained; this was not a static-only
  `dist` upload. No Git commit, push, database migration or Pi deployment.
- `.vercelignore` now also excludes colocated `*.test` / `*.spec` TypeScript
  files. Root `tests/` was already excluded, so those colocated development
  tests otherwise lost their test-only ambient declarations during deployment.
- CLI used Node 24.19.0 and Vercel 60.0.0. The remote production build passed
  TypeScript, Vite and client-secret checks. Existing large-chunk and deprecated
  middleware-runtime advisories remain; no dependency upgrade was attempted.
- Created the candidate using `--prod --skip-domain`, then explicitly promoted
  it after authenticated candidate checks. Deployment protections were not
  disabled. The unauthenticated full candidate smoke correctly stopped at
  Vercel Authentication; candidate document/assets were checked through the
  authenticated CLI instead.

## Verified release markers

- Planner shell: `main-DM6mbLeW.js`.
- Public diary: `logs-D8CTVB9N.js`.
- Archive: `LogPage-C9-JG3Hz.js`, containing complete-voyage summary loading,
  redesigned archive cards and passage restoration.
- Stylesheet: `index-CeSe7yqK.css`, containing measured HUD available height and
  compact density rules.
- Candidate `/plan`, `/logs`, archive bundle and HUD stylesheet passed.
- Local production web-release checks passed. Pre-release canonical hosted
  checks passed, including currents/SST/chlorophyll generations and legacy
  endpoint retirement.
- After promotion, Serene Summer's `.app` and `.com` diaries and `.app/plan` returned HTTP 200
  with the new release markers and `noindex, nofollow, noarchive` retained.

Post-promotion `check:web-release -- --hosted https://www.thalassawx.app` passed
in full: shell routes, security/cache headers, enabled currents/SST/chlorophyll
discovery slots and immutable assets, plus bare/cache-busted legacy 410s.

## Afternoon release — lifetime statistics and all trips

Published after the explicit follow-up request “ok update website changes”.

- New production: `dpl_t5kEZ9s7XWV9vzq6RtSy71JmAQ1k`,
  `https://thalassa-2tjtq9j2p-serene-summer.vercel.app`.
- Website rollback reference: `dpl_9KeycKbZYsdEqxR8AMvcWzp9L8KN`,
  `https://thalassa-k54bahshc-serene-summer.vercel.app` (the morning release above).
- Current-source snapshot: `/tmp/thalassa-web-20260925-trips.vKI7km`.
  Native/Pi runtimes, local output/media working directories, environment files
  and private key files were excluded. Existing middleware/API routes retained.
- Remote build, client-secret checks and protected-candidate checks passed
  before explicit production promotion. Production alias inspection confirms
  the new deployment. No protection or public-sharing settings were changed.
- Planner shell: `main-O2wlTaRd.js`; public diary: `logs-B7XV44S3.js`;
  lifetime Log statistics: `LogPage-C4afFLuc.js`.
- Serene Summer `.app`/`.com` diary URLs and `.app/plan` return HTTP 200 with
  new assets and `noindex, nofollow, noarchive` retained.
- Post-promotion `check:web-release -- --hosted https://www.thalassawx.app`
  passed in full (shell/header/cache checks, live v2 currents/SST/chlorophyll
  generations and bare/cache-busted legacy 410 retirement).
- Matching `voyage-log` Edge Function v72 is ACTIVE. Release-time public API
  checks returned all six eligible shared voyages and 11 posts. See
  `LIFETIME_STATS_PUBLIC_TRIPS_2026-09-25.md` for backend rollback and details.
- No database migrations, Pi deployment, phone installation, TestFlight upload,
  Git commit or Git push.
