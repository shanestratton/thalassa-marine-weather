# Build 139-01: bounded automatic berth approaches

For an Auto request beyond 50 NM, the phone can now compose a chart-checked
departure approach, a forecast-routed offshore middle and a chart-checked arrival
approach. Passage uses this new branch only when the existing **Auto route
(trial)** switch is on and there are no explicit VIA points. The switch is never
enabled by the solver. With Auto off, the existing manual Passage path, terminal
expansion and final verified-commit guard remain in place. Explicit VIA requests
retain the build 138 ordered-leg contract. Short Auto requests keep their existing
50 NM router and review behavior.

This is source implementation and synthetic verification, not evidence that a
particular real harbour has qualifying charts or that a production passage has
been benchmarked. Native build identifiers remain 138 until release composition.

## One bounded request

- Direct endpoint distance must be greater than 50 NM and at most 1200 NM. The
  completed route must also remain within 1200 NM, 8192 route nodes and 50000
  wavefront nodes. A single 90 s wall/monotonic deadline includes module loading,
  chart preparation, every solve and final verification.
- Each berth-to-portal request is at most 45 NM, retaining the existing 50 NM
  per-grid limit. Each endpoint contributes at most four admitted portals; at
  most two departure approaches are attempted, then a ranked arrival portal is
  fixed before the offshore solve. A failure does not substitute a guessed gate.
- All stage endpoints must exactly equal their requested berth/shared portal
  coordinates. The existing gluer additionally checks turn reversal, boundary
  depth and masks. Its numerical tolerance cannot hide a concatenation gap.
- The offshore middle uses the ordinary constrained forecast solver with its
  direct-shortcut branch disabled. Its departure is the exact unrounded tail
  clock of the departure approach. Arrival uses the exact offshore tail clock.
  Rounded UI summaries never rebase a forecast.
- The complete terminal-expanded line undergoes current chart/depth/land
  verification. Independent pre-await geometry, per-node clock/distance and
  summary snapshots prevent both returned-copy and in-place verifier mutation.
  A refusal, timeout or changed source returns no accepted partial route.

## Portal facts and lifetime

Coarse relief supplies candidates only: two requests of at most 48 points, on
5/15/30/43 NM rings. The first four observed deep candidates at each end receive
bounded two-mile chart windows, split at the dateline. No heuristic sea-buoy or
straight harbour leg qualifies a portal.

Each complete safety cohort retains the existing 14-cell/32 MiB merge bounds,
requires current NOAA agreement or paired boat-LAN access as appropriate, and
requires structure-aware extraction. The read is also bounded to 10000 features.
Only an existing chart-trusted clear lead endpoint with no review, unresolved
direction, uncovered interval or charted land, and original charted lower depth
of at least max(10 m, measured draft + 0.5 m), can qualify. OSM, unknown survey,
shallow and tide-dependent leads do not qualify. There is no new tide, holding
ground, bridge or datum authority.

Both endpoints finish authorized boat chart opening before their source cohort
is captured. Current owner, vessel/settings policy, model, pairing revision,
pairing identity, LAN and chart cohort/lease are fenced across asynchronous work.
Raw chart reads and compiled graphs are request-owned RAM and released after
deriving bounded portal facts; facts retire with the request. No chart extract,
boat position, forecast response or private profile is written by these modules.

## Disclosure and adoption

The selected vessel profile, measured draft and routing polar are used; no yacht
model is hardcoded. Approach time is a cruising-speed estimate, and its local
wind/current effects and propulsion remain explicitly unresolved. The offshore
forecast's environmental omissions remain attached. Approach state/survey/
shallow intervals retain exact segment indices through concatenation; offshore
water is disclosed separately. Forecast water is not relabelled as a charted
inshore grid.

Auto still returns a planned-only proposal with its existing independent review
and save gates. A verified calculation does not arm a watch, start navigation,
adopt a wait or silently save a route. Passage retains its existing explicit
adoption behavior and shows an unverified whole-request preview on a new solver
failure. Missing evidence can conservatively refuse a usable harbour; this
bounded search does not promise exhaustive harbour coverage.

## Verification record

Synthetic tests exercise exact stage clocks, both endpoints and joins, masks,
source retirement, cancellation/late leases, monotonic deadlines, oversized or
unknown portals, coherent verifier mutation and final refusal. Production adapter
tests replace transport/source modules with fictional inputs. No provider or
installed licensed-chart query was made.

- 140 cases / 10 suites passed after the final-verifier alias repair:
  `work/validation13901-release-focused-repair.log` outside the checkout.
- 21 actual planner/manual-polar/land-refusal/verification regression cases passed:
  `work/validation13901-planner-regression.log`. These include two new enabled
  berth planner cases and preserve ordered VIA priority.
- The later exact shared-coordinate guard and sub-metre gap regression passed
  19 core/adapter cases: `work/validation13901-exact-seam.log`.
- After normal composition with 139-02 track priors and root 138 checkpoint
  `63720f496`, 182 cases / 15 suites passed in
  `work/validation13901-composed-track-repair.log`. The first composed run is
  retained in `work/validation13901-composed-track-focused.log`: an existing
  getState-only engine-test store mock lacked the store's `subscribe` method
  now used by the real prior context fence. The mock now exposes a no-op
  subscription; all original engine and prior assertions remain unchanged.
- The first focused run's 136 passes and one harness manifest failure are retained
  in `work/validation13901-release-focused.log`. The TSX harness was removed from
  the data-file manifest because that manifest explicitly excludes source code;
  all original provenance assertions remain unchanged.

The development-only browser harness uses invented equatorial geometry and the
actual bounded core plus production review/save components. Its cases require
300/375 px at 130% text, 44 px targets, unchanged document bounds, refusal after
missing final verification, no unexpected external requests and zero unfiltered
page errors. All four actual Chrome/WebKit phone cases pass after composition
with root checkpoint `100b4bb03`, recorded in
`work/validation13901-phone-named-status.log` and
`work/berth139-named-status-browser` outside the checkout. The original three
failed traces remain in `work/berth139-browser-proof`: their first assertion
selected both the fixture's join status and the production chart-check status.
The fixture now names its join status explicitly and selects that exact role;
all clocks, Save, 44 px, document-bound and error guards and deadlines are
unchanged. Visual review then found that the fixture's outer white foreground
did not inherit through the modal portal. Its existing inner content div now
sets the intended foreground locally; the production ModalSheet and layout
stay unchanged. All four cases pass again in
`work/validation13901-phone-portal-foreground.log`, with screenshots in
`work/berth139-portal-foreground-browser`. These invented routes do not prove
real passage timing or source availability. The newly composed whole-app
compiler, production size checks and real passage timing remain pending.
