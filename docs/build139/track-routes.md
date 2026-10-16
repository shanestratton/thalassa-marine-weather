# Build 139-02: own-track routes and routing priors

This implements the roadmap's route-from-track action and bounded cost hints from the skipper's own tracks and approved community lanes. Historical travel supplies user geometry, never evidence that the water is safe today. No borrowed chart geometry is retained in the track projection.

## Route from a track

Log's existing overflow menu contains **Make route from track**. Its identity-owned, one-shot intent opens Plan's existing Past voyages picker. Selecting a recorded voyage loads its complete account-owned history, merges matching pending captures by operation ID, and starts a new unsaved tracer draft. Planned routes and community downloads cannot masquerade as the skipper's recorded track. A complete cloud read is required; a failed or incomplete read keeps the existing route, even if a partial display cache is available.

`services/routing/trackRouteDraft.ts` simplifies plain user positions at a fixed, visible 30 m tolerance, retaining the exact endpoints and order. Mercator distance conservatively measures the displayed line. The budget is 20,000 recorded positions and 80 output pins; complexity exceeding either the work or pin budget refuses rather than increasing tolerance. Invalid clocks/positions, non-increasing clocks, gaps over 15 minutes, adjacent jumps over 5 NM and dateline discontinuities refuse the whole conversion. No section across an unresolved gap is silently joined. A user can plot a shorter section by hand.

The adopted draft atomically retires the former route's acknowledgements, sail/share/overwrite arms, verdicts, tide labels, report, saved-route identity, return context, name and Undo history. `useTracerGrading.retireChecks()` also invalidates its in-memory and hydrated verdict reuse, in-flight grading and late tide labels. Even an identical line must receive a fresh chart check before release. The feedback states the input/output counts, tolerance and fresh-check requirement.

`useTrackRouteRead` owns a 20-second latest-request lease. Auth generation, vessel A/B/A changes, leaving tracer mode, geometry changes, hidden/background state, unmount and a competing tracer front-door action retire a pending read. Native foreground state is read conservatively and subscribed; late initial state cannot override a newer background event. Context cancellation cannot replace the current route or show a stale error.

## Optional routing cost hints

The narrow `InshoreRouter.ts` seam collects hints immediately before constructing `routeOpts`, with a whole optional-read budget of two seconds. Missing/slow sources return no hints and ordinary routing proceeds. The request and join keys include auth generation, selected vessel and a vessel-change revision, so account/vessel A/B/A cannot reuse a private prior-bearing result. Private geometry is process-local and per request.

Own tracks come from a bounded recent-history read plus pending local entries. Foreign, planned, imported and recorded-land data cannot contribute. Clock gaps break fragments; each fragment uses the same fixed-tolerance simplifier. Community hints use the existing `traced_routes_near` RPC, whose migration filters `status = 'approved'`; they explicitly bypass the ten-minute display ghost cache. A revoked approval must not remain an active routing hint merely because its old ghost is cached. Community rows with any malformed vertex are rejected whole.

`applyTrackPriors` runs after the chart grid is cloned, hard admission and endpoint work, immediately before A*. It never changes depths, land/berth masks, channel preference or reachability. Only finite positive already-admitted water at the current draft-plus-margin may receive a hint. Chart-preferred channels, unknown water, caution and sub-margin water retain their costs. A 60 m corridor supplies a 10% own-track or 5% approved-lane cost reduction; own tracks win overlaps. The consumer rechecks admission even under a malformed/poisoned mask. A* and refinement share the same factor; the heuristic uses the conservative 0.9 lower bound only when hints exist.

Input and raster work are bounded: 12 priors, 512 vertices each, 4,096 total vertices and two million paint operations. Excess work discards the entire optional mask. Hints never enter the cached chart grid. The generated Pi engine mirror is staged with the repository sync script; no Pi installation, routing endpoint activation, watch action or boat acceptance is performed.

## Verification

- Final focused union: **285 cases / 19 suites pass**, including complete-owner history, fixed-tolerance/gap refusal, auth/vessel A/B/A and native/StrictMode read retirement, fresh identical-line grading, actual Plan picker intent, cached-approval bypass, consistent A\*/refinement cost, and existing land/depth/chart/auto-bank regressions. Log: `work/validation139-track-route-focused-final.log`.
- A final finite-value hardening case was rerun in the five-case engine-prior suite; see `work/validation139-track-prior-finite-final.log`.
- **Four Chrome/WebKit cases pass**, 300/375 px at 130% with wide fonts. These mount the actual Log header, overflow dialog, focus trap and identity-owned intent. They assert readable wrapping, a 44 px action target, menu/page bounds and one-shot intent consumption. No external requests are allowed. Log: `work/track-route139-browser-first.log`; screenshots: `work/track-route139-browser-results`.
- Browser scope is the actual Log menu and intent, not the complete MapHub chart workflow or physical iOS/boat acceptance. Plan handoff, grading and cancellation are covered at component/controller level.
- Earlier local failures were corrected without weakening production safety: a scalar unknown-cost assertion was adjusted to the existing 500 fallback while retaining actual A\* refusal, and a unit fixture's unrelated asynchronous settings boot was isolated. The production vessel subscription remains active.
- Whole-app TypeScript, configured production budget, composed browser acceptance and release remain root-owned. This packet does not claim those gates passed.
