# Isolated autorouting trial — next build 115

The Planning home card opens a separate, disposable chart workspace. Its
endpoints, vessel-input snapshot, request and proposal never enter the normal
planner, saved-route library, passage handoff, active log, public page or Pi.
Close discards the draft. Editing an input invalidates the previous result.
Account changes and cancellation fence late replies. There is deliberately no
Save, Follow, Publish or Cast off action in this first evaluation slice.

## Provider boundary

The authenticated `autorouting-trial` Supabase function is the only SevenCs
caller. It uses the supplied evaluation server and verified OAuth client
credentials flow. Credentials are server secrets, not Vite variables. Access
requires a verified Supabase session, an exact server-provisioned user UUID,
an enabled switch and an unexpired trial. Status is limited to 120/hour per
user; calculations to 12/hour. No paid weather-optimisation service is enabled.

Server configuration:

- `SEVENCS_CLIENT_ID`, `SEVENCS_CLIENT_SECRET`
- `SEVENCS_TRIAL_USER_IDS` — immutable Auth UUID allowlist, provisioned privately
- `SEVENCS_TRIAL_EXPIRES_AT` — required UTC timestamp; currently stops at
  2026-11-10 00:00 UTC, conservatively inside the complimentary 60-day window
- `SEVENCS_TRIAL_ENABLED` — exactly `true` to permit access

Only Shane's verified account is provisioned. No other account, public-beta
flag, mutable email or client-supplied identity grants access. Disabling the
switch or letting the expiry pass stops new provider calls; there is no renewal
or purchasing code. Deploy only `autorouting-trial`, never all functions.

The adapter uses the provider's documented `POST /api/route` JSON request and
response, checked against the evaluation server's OpenAPI document on
2026-09-12 AEST. URLs are fixed; redirects and caller-supplied endpoints are
not accepted. Provider work and response streams have a 35-second deadline
and bounded sizes. Failed POSTs are not automatically retried.

## What the proposal does — and does not — mean

The request supplies a yacht type, selected draft, cruising speed and a fixed
0.5 m clearance in each water-area category. **No predicted tide is credited.**
Beam, air draft and other yacht dimensions are not supplied or checked in this
first trial; the screen and returned warnings explicitly say so. Provider
checker/expander dependencies remain enabled. Paid weather optimisation and
voyage optimisation remain disabled.

The returned line is a **trial proposal, not navigation approval**. Basemap
imagery is not a nautical chart. A provider success flag or a leg marked safe
does not become a Thalassa verified-route badge. Proper chart/licence coverage,
restrictions, vessel dimensions and local conditions still require review.

Every returned geometry is checked for valid coordinates. Track parts must
already join exactly; the adapter never invents a joining leg, reorders,
smooths, snaps or simplifies them. More than 10,000 track points, broken
geometry or a provider endpoint more than 250 m from the requested point is
rejected. Accepted endpoint offsets over 5 m are disclosed as warnings.
Unsafe/danger features and user warnings are surfaced. The original RTZ and
GeoJSON are retained verbatim in memory (4 MiB combined limit), then discarded
with the workspace; they are not written to logs, local storage or route tables.

## Verification record

A live, non-navigational test between two offshore Sunshine Coast points
returned provider request `327000`: success, approximately 14.96 NM in three
seconds. The app adapter accepted all seven returned track coordinates and
retained both RTZ and GeoJSON byte-for-byte. This proves that particular API
exchange, **not** Lady Musgrave entrance suitability or complete Australian
chart coverage.

The private `autorouting-trial` function is deployed (version 1). Live probes
returned 204 for preflight, 405 for GET and 401 for an unauthenticated
calculation. The deployment did not change database tables or other functions.
The verified account allowlist, trial expiry, kill switch and client credentials
are provisioned as server secrets. No signed-in production calculation was
performed by impersonating the user: the authenticated provider exchange above,
deployed unauthenticated rejection and injected-auth contract tests are separate
pieces of evidence, not a claimed end-to-end device test.

Chromium and WebKit passed all 18 layout/interaction cases with no retries or
skips: 390 px and 430 px phones plus a 1024 px split screen, each in daylight,
dark and night modes. These tests use a real Mapbox renderer with a local
basemap/provider fixture. They check every proposal vertex remains visible,
keyboard-safe inputs, visible Close/zoom controls, independent companion-pane
interaction, and draft disposal on close. They do not verify live chart tiles
or provider chart coverage. The final workspace unit suite passed 24 tests.

The bundle also narrows the existing lazy Sentry import to its six used exports.
Error reporting, its privacy filters and its React initialization remain in
place; replay stays disabled. This removes unused SDK exports from the install
payload without increasing the bundle-size budget.

The final full Vitest run passed 1,136 files / 10,477 tests, with the existing
four skipped files, five skipped tests and three expected failures unchanged.
No tests were quarantined or weakened. An initial combined run caught an
incorrect ResizeObserver test stub; its scoped replacement passed both the
24-test focused suite and the fresh full run. Full lint passed (59 existing
warnings), changed-file formatting passed, and the new Edge function passed
Deno type checking and formatting. Source beta contracts passed 126 checks.

Combined build results are recorded after packaging.
Build 114's archive/upload are not part of this change. Build 115 is prepared
locally only until a separate TestFlight release is requested.
