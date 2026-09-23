# OBS and diary handoff — 20 September 2026

## Local app changes

- Passage HUD overview includes the full followed Log route and actual GPS fix,
  including off-route starts. Genuine pan/zoom/Locate pauses overview; Whole route
  restores it. HUD/collapsed tab and scrubber padding are measured. Waypoint dots
  and zoom-dependent numbers use one GeoJSON source, not thousands of DOM nodes.
- Scrubber remains when HUD is collapsed. Forecast coverage/attribution and the
  squall key now live in the existing blue information button, not under the
  scrubber or across the chart.
- OBS → Sea → Tides exposes chart stations. Selected-station card shows sampled
  predicted tide, actual reported datum, next high/low, local timezone, and
  explicitly labelled ECMWF forecast wind (not live buoy observations). Toggling
  tides preserves wind/rain/squall selections. The supplied Raymarine PDF informed
  the compact gauge: `/Users/shanestratton/Desktop/IMG_1990.pdf`.
- Pressure adds genuine 2 hPa detail above zoom 3 while retaining 4 hPa overview.
  Provider UTC axes, refresh/retry/resume, live-time versus manual selection, stale
  heatmap run identity and captions are corrected. Coarse fallback explicitly
  uses GFS. This does not promise an exact Windy match: model/run/grid/valid UTC
  must match before comparing.
- Diary display reconciliation matches owner + stable client operation ID, not
  only the temporary/cloud row ID. Higher revisions win; genuinely separate
  identical posts remain separate. Functional React updates resolve in reducer
  order. Cached, polled, and individual reads also honor operation-ID deletion
  tombstones, preventing a deleted offline entry's cloud twin from resurfacing.
  Durable outbox records are not removed by display de-duplication.
- Public diary has map-overlaid voyage information and clearer Map / Diary /
  Instruments navigation, with map state preserved. Guest comments require the
  skipper's approval. See `DIARY_GUEST_COMMENTS_2026-09-20.md` for backend contract.

## Deployment / delivery

- Local `npm run build` and `npm run cap:sync` passed. Main asset
  `main-DBJ8qE2g.js`, public renderer `logs-CRyxbn-U.js`; both match the iOS copy.
  No build-number bump, archive, TestFlight upload or physical-phone install.
- Isolated `proxy-tides` deployment version 38 adds bounded sampled heights only;
  existing extremes-only callers retain behavior. Live Mackay Outer Harbour
  probe: 145 height samples, 12 extrema, reported LAT datum, HTTP 200. WorldTides
  API key remains server-side, cache is private for sampled predictions.
- Comments migration `20260920120000` and isolated `diary-comments` version 1 are
  deployed. RLS and empty initial table verified; anonymous origin/error probes
  passed. No test content posted to real diary entries.
- Public website published after explicit approval: Vercel deployment
  `dpl_D1P6gYc1d4guNsPZBYzvom8D3S9E`,
  `https://thalassa-h4v8z4x9e-serene-summer.vercel.app`. Both public boat domains
  serve `logs-C2Yi6yUr.js`. The release used an isolated archive of the previously
  live commit `2b5fa8d18f4ef03aaba5334af32c15e7347c9127` plus only eight public
  runtime files, preserving the live app/planner source and shared stylesheet.
  The unrelated dirty worktree was not published. Native build/sync above was
  not changed by this web release.
- Rollback reference: previous deployment `dpl_EuUUgRNt4o6sVKfcVfCRQ3oVJWJq`
  (`https://thalassa-pn2tiyzip-serene-summer.vercel.app`). Candidate was built with
  `--prod --skip-domain`, checked through authenticated Vercel CLI requests,
  then explicitly promoted. No authentication protections were disabled.
- All five existing Codex scheduled tasks are PAUSED, including daily Newport
  data refresh. No replacement scheduler or automatic holiday-resume created.

## Verification

- Final combined suite: 46 test files, **520 tests passed**. Log:
  `/private/tmp/thalassa-sept20-final-tests.log`.
- Public responsive UI: 16 browser cases in Chromium/WebKit including 320/390/430
  phone widths, short landscape, tablet and desktop. Mocked data/imagery; not a
  live phone observation. Separate HUD/tide/pressure screenshots reviewed.
- Real comment migration: 49 executable PostgreSQL assertions using isolated
  PGlite (real RLS/roles/functions; fixture auth/quota helpers), plus linked-schema
  rollback dry-run. No concurrency stress-test claim.
- Full TypeScript, scoped ESLint, migration audit (168), client-secret artifact
  scan and local production web-release verification passed. Existing MapHub
  lint warnings and large-bundle advisories remain; not introduced as failures.
- Build/sync logs: `/private/tmp/thalassa-sept20-build.log`,
  `/private/tmp/thalassa-sept20-cap-sync.log`. Live probes:
  `/private/tmp/thalassa-tides-live-probe.log`,
  `/private/tmp/thalassa-comments-live-probe.log`.
- Isolated public release: 60 unit tests and 16 Chromium/WebKit responsive
  journeys passed against the previous production baseline, including its old
  shared CSS. Candidate `/plan`, public document, JS and CSS assets passed
  authenticated HTTP/header checks. After promotion, `.app` and `.com` public
  boat domains returned the new public bundle and retained noindex/noarchive;
  `/plan` retained the isolated baseline app. A real public entry was opened in
  the browser: map, navigation and credentialless comment read/form loaded
  without an error. No comments were submitted as part of verification.
  Evidence: `/private/tmp/thalassa-public-diary-{unit,browser,promote}.log` and
  `/private/tmp/thalassa-public-audit-*`.
- Full hosted release verification passed on the canonical
  `https://www.thalassawx.app` after promotion, including shell routes, security
  headers, immutable assets, live v2 currents/SST/chlorophyll generations, and
  bare/cache-busted legacy 410 retirement. Log:
  `/private/tmp/thalassa-public-diary-production-hosted.log`. The apex redirects
  to `www`; the initial apex-only probe was not a valid direct-origin test.
