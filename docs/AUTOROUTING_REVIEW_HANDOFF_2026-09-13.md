# Autorouting review and full-chart workspace — 13 September 2026

## Scope and delivery status

The candidate was built, Capacitor-synced, signed and installed as a development
app on the connected iPhone after the user confirmed it was free for testing.
The existing login and data were preserved; no voyage or navigation was started.
This is not a TestFlight delivery. No commit, push, archive or upload is claimed.

The scoped `autorouting-trial` function was deployed as version 2, including the
vessel-profile contract. The exact migration
`20260913120000_saved_autorouting_proposal_evidence.sql` was applied and recorded
transactionally. The nullable evidence column, point/evidence limits and existing
owner RLS were verified. No other function or migration was deployed; the live
`osm-overlay` version 17 was left unchanged.

The shared worktree contains other changes. In particular, do not deploy its
older `osm-overlay` data over the separate daily-maintenance deployment (v17).

## Implemented locally

- The chart fills its phone or split-screen pane. Setup, route review and save
  occupy one bounded, roll-up floating card; a single Mapbox instance remains.
  Close, zoom, attribution and unresolved danger/ENC status remain visible.
  Camera framing measures the header, folded handle and bottom status so
  highlighted geometry is not hidden by those overlays.
- The opening vessel snapshot carries measured, estimated and missing values.
  Exact documented SevenCs mappings for length, beam and air draft are in
  [the vessel profile contract](AUTOROUTING_VESSEL_PROFILE_2026-09-13.md).
  An older server cannot silently discard these dimensions: its missing
  capability blocks a profile-bearing calculation until the server is updated.
- Provider findings retain their own identifiers, provenance and exact point,
  line or polygon geometry, including holes. A locator highlights that geometry,
  not an invented association between a provider feature number and route leg.
  Unsupported/unlocatable reports remain readable without pretending to locate
  them. Hazard inspection never rewrites the route.
- Saving is an explicit, named **planned-route** action into canonical Saved
  Routes, allowing existing Trip Legs workflows to consume it. No voyage,
  navigation or route activation is started; no manual verification is forged.
  Provider-unsafe and local-danger/needs-tide results cannot be saved this way.
  Acknowledgement is tied to the exact current route, vessel and completed chart
  check; a fresh check or changed evidence clears the acknowledgement.
- Historical review evidence is bounded to 1 MiB compact JSON and keeps the
  complete route (2–10,000 points). Overflow refuses explicitly, never silently
  thins a route or drops warnings. The nullable SQL evidence column and expanded
  point limit have a separate migration; without that schema, the full local
  saved plan is retained with cloud schema-pending status.

## Checks and remaining release work

The integrated focused run passed 811 tests. After the final camera-framing
adjustment, the workspace's 70 tests passed again. Scoped lint, formatting and
`git diff --check` passed. The full Chromium/WebKit browser matrix passed 62
cases; all 18 affected exact-hazard cases passed again after the final camera
padding correction, including geometry-extrema checks against the status panel.
Phone dark, split-pane daylight and simulated keyboard screenshots were inspected.
Browser fixtures use a real renderer with synthetic
route/provider data; they are not live ENC/provider or physical-device proof.

The final TypeScript/production build and generated-client secret checks passed.
The local web-release check passed; hosted header enforcement was not exercised.
The bundle remains within unchanged budgets: 12.79 MiB total, 9.32 MiB JavaScript
against a 9.90 MiB cap. Main entry: `assets/main-D5OHqozk.js`. This is a local
web candidate, not a numbered native release.

The signed native build and generated-artifact secret scan passed; the beta
artifact check passed all 140 contracts. Device testing confirmed the authorized
Manual/Auto entry, full-screen ENC workspace and Newport automatic-exit lookup.
The initial installed bundle predated the small pending-capability-message
correction; it was superseded by the resumed installation described below.

### Live-service investigation

The first calculation failed. The Supabase invocation list confirms HTTP 502 at
11:09:18 AEST, with a 14,431 ms duration. Later invocations returned HTTP 200,
including 11:11 and 11:40. Status requests share that endpoint, so a 200 alone
does not prove a calculation or completed chart review.

A route with 869 waypoints was subsequently visible on the phone, but its first
coordinate differed from the intended test input. The exact interaction history
was not established. Do not count this as a verified outbound test, suppress its
charted-land warnings, or infer that its route is safe. Nothing was saved or
activated. The earlier 502 cannot be narrowed to token, provider HTTP, response
parsing or route validation from the historical diagnostics alone.

Before delivery: finish the diagnostic/error-handling checks, rebuild/sync the
final candidate, and complete controlled outbound, inbound, open-water and
failure tests. Do not substitute synthetic browser checks for those
device/live-service checks. Physical testing was paused for the user's lunch;
on return Device Hub reported a phone/VoIP call in progress, so no new device
interaction or app restart was attempted at that point.

### Separate limitations found during the resumed audit

- Local canal construction currently handles departures only. An open-water
  departure with a canal destination is provider-only, not a verified reverse
  Newport connector. The inbound test must not be reported as proving automatic
  canal arrival support.
- The review uses batches of 64 legs. Its inner grading loop does not yield or
  check cancellation between individual legs; a separate grid-worker failure
  path can fall back to synchronous construction. These are responsiveness risks
  requiring dedicated tests, not established causes of the HTTP 502. Do not
  suppress charted-land or incomplete-depth warnings to make review appear done.

### Resumed diagnostic patch

`autorouting-trial` version 3 is active with additive, closed-vocabulary error
references: token HTTP/payload, route HTTP/payload/validation, provider transport,
and timeout. No provider payload, credential, coordinates, raw exception or
additional logging is exposed. Existing validation, access checks, quotas and
deadlines remain unchanged. `osm-overlay` is still version 17.

The matching client selects fixed messages from genuine SDK HTTP response
statuses and reads only an allowlisted reference from a bounded, cancellable
error response. It does not retry automatically. These diagnostics make future
failures distinguishable; they do not retroactively identify or prove a repair
of the historical 11:09 failure. A controlled live calculation remains required.

The resumed integrated run passed 436 routing tests. A separate review/save run
passed 174 tests (these runs overlap; do not add the totals). TypeScript,
production build, generated-client secret checks, bundle budgets and all 140
beta artifact contracts passed. The signed Debug app was reinstalled and
launched successfully at approximately 13:55 AEST, retaining existing data.
All 426 web files exactly matched the embedded app files; signature verification
passed. The new main entry is `assets/main-2rfellJD.js`, SHA-256
`0bfe8579ccc03e40424215eec39fda4462b45be7005786c9bcdf872ac59b0d9f`.
Build number remains 117 for this local development app, not a new TestFlight
release. No archive, upload, commit or push was performed.

The new app was visibly running on Glass with its existing Newport selection.
Device Hub could display it but remote taps did not change the phone page, so
the resumed live calculation was not completed. Keyboard capture was off and
no proposal, voyage, navigation activation or saved test route was created.
Next: retry the same trial on the physical phone, inspect any new allowlisted
error reference, and use that evidence to resolve the specific provider failure.
Diagnostic patching alone is not proof that the intermittent error is fixed.

## Coverage direction: Queensland first, reef lagoons included

The user approved Queensland-first expansion, with Nouméa as a future reef-lagoon
test case. This is a coverage direction, not a claim that either Queensland-wide
or New Caledonian routing is now implemented or licensed.

A reviewed marina/canal exit is **not automatically open ocean**. Model and
validate the connected sections separately: berth/canal or harbour, lagoon
channels where present, an appropriate reef pass, then coastal/open-water route.
The same distinction applies in reverse for arrivals. A destination within a
lagoon does not necessarily require leaving it.

Each restricted section needs appropriate current chart coverage, depth and
obstacle checks, vessel constraints and reviewed handover geometry. Reef passes
can add tide/current, sea-state and local operational restrictions that a static
track alone does not establish. Do not snap universally to a channel centreline,
select an arbitrary nearest gap in a reef, or turn missing evidence into a
straight-line connector. Unresolved coverage or clearance stays explicit and
requires review rather than being treated as an approved route.

Future regional data preparation and cloud scheduling are separate work. This
change does not create a global harvesting job, grant chart redistribution
rights, broaden SevenCs trial access or remove the Mac dependency of the current
daily Newport refresh job.

## Sparse trial waypoints — follow-up

The trial map's numbered markers and review cards now use a separate waypoint
plan: departure, destination, meaningful corners, protected canal handover and
50 NM intervals along long stretches between corners. Corner detection tolerates
5 m of detail along a straight great-circle or rhumb course; it retains reversals
and bounds its work. Spacing marks lie on the original rendered segments, with
distance measured along those segments rather than across a shortcut.

This is presentation only. The original provider/canal coordinates, exact drawn
polyline, complete local chart checks and saved evidence are unchanged. Each
display leg includes every underlying segment's warnings and minimum known
depth; a spacing mark inside an original segment includes that segment on both
sides. Locator buttons retain the exact hazard positions. Unsupported sparse
geometry explicitly falls back to the original points for inspection.

The synthetic straight 240 NM / 1,000-point case displays six waypoints. Actual
passages keep additional corners and canal handovers, so their final count varies.
Canonical Saved Routes and exports still retain the detailed geometry; this
change does not claim to thin plotter/export waypoints or reduce chart checking.

The focused unit/integration run passed 236 tests; the final compact panel rerun
passed all 23 panel cases. Chromium/WebKit passed 30 browser cases, followed by
a successful final compact phone rerun. These fixtures exercise real rendering
with synthetic data, not live provider/chart clearance. TypeScript, production
build, scoped lint/formatting, local web-release verification and unchanged bundle
budgets passed. Initial sandbox cache/localhost restrictions were resolved by
running the normal sync/release checks with the required access.

The final candidate was Capacitor-synced to the local iOS project. Main entry:
`assets/main-C5F-9X_z.js`, SHA-256
`b6b870e1e1fbd3156694d6fdeb999a28c5a0773e4665b0c2c74f961cc3a247bd`.
The web and embedded iOS main asset hashes match. The local `/plan` preview is
available for refresh. No native reinstall, live trial calculation, saved route,
navigation activation, backend deployment or TestFlight upload is part of this
presentation change; the phone needs the next Xcode run to receive it.

## Canal corner preservation — evening follow-up

The user clarified that the desktop 7–8 segment looked acceptable, while the
phone had appeared to cut the corner. The last recorded native installation
still contains `main-2rfellJD.js`; the browser had already received the sparse
display update. This can change waypoint numbering, but it does not establish
the cause of the particular phone observation. No new physical-device comparison
or installation was performed in this follow-up.

A separate reproducible algorithm defect was fixed in the shared canal connector:
its centred Dijkstra path was being reduced by the legacy shortest-visible-line
cleanup. In a synthetic L-shaped canal that reduced an 11-cell bank margin to
2 cells. The connector now requests the raw solver path and uses a bounded,
centre-preserving simplifier (0.75-cell deviation limit), with conservative
checks of every touched grid cell and the solver's eroded bank margin. The
legacy solver's default behavior is unchanged for its other callers; the new
connector avoids computing the unused legacy cleanup at all.

Final GPS segments also undergo continuous water-polygon-union containment,
including exact endpoint joins. Thin holes, peninsulas, shoreline grazes and
corner-only connections are rejected. Genuine tile seams and valid point
contacts between an outer ring and a hole are handled without inventing walls.
Operation/input limits fail unavailable rather than accepting an unchecked
shortcut. These checks concern supplied geometry, not surveyed accuracy, depth,
tide or whole-vessel clearance. Existing chart hazards and review/save gates
remain unchanged. This is not a claim of worldwide marina coverage.

The displayed chart already uses the same imported ENC layers as manual routing.
Attribution now explicitly says ENC and distinguishes reference-only imports;
the imported source identifier is not misrepresented as a hydrographic office.
No chart source, import entitlement or nautical-chart coverage was changed.

The subsequent "No connected canal exit found" screenshot was investigated using
its displayed departure (27°12.884′S, 153°05.394′E) and the exact four reviewed
Newport gate centres. All 27 Mapbox tiles were fetched, and the complete connector
with mapped obstacles succeeded with 174 detailed points; nine sub-metre input
variations also connected. The final connector including vector verification
took about 0.3 seconds on this Mac. The deployed `osm-overlay` was downloaded
read-only: its newer source date (`2026-09-12T20:21:58Z`) has byte-identical
regional geometry to the reproduction, SHA-256
`e583d1ab43642919e6ff48f54a1e7bf4a16dbc29b3adb194b0ab2a81b97dab62`.
No new daily-refresh obstacle explains that failure. Its actual cause remains
unreproduced; do not report the corner patch as proving it fixed.

499 focused tests passed, followed by the final 55 containment/adapter checks.
Eight Chromium/WebKit worker and sparse-review cases passed; all four actual
worker cases passed again with an independent inner-corner-distance assertion.
Production TypeScript/build, scoped lint/formatting, generated-client secret
checks, unchanged bundle budgets and all 140 beta artifact contracts passed.
The bundle is 12.82 MiB total / 9.34 MiB JavaScript (9.90 MiB cap).

The final build was Capacitor-synced. All 426 `dist` files match the embedded
iOS public files. Main entry: `assets/main-DpGQjAFH.js`, SHA-256
`2eee9a182302b1e05b79017da6374e302cd81de6802613e35d88032e32e54807`.
The existing local `/plan` preview was verified to serve that entry. No native
reinstall, backend deployment, navigation activation, saved-route change, commit,
push, archive or TestFlight upload was performed. Next: refresh/recalculate the
browser proposal, then use Xcode Run for the same candidate on the phone and
repeat the reported departure before claiming physical-device resolution.

## Passage overview, Tracer presentation and waypoint edits — evening follow-up

The 18:36 phone screenshot exposed a different chart-display defect: fitting the
whole passage crossed the z6.5 merge / z7 base-layer display floors. The chip
still counted bbox-intersecting imports, so its “23 cells” did not mean those
charts were being drawn. Plotting now supports a bounded z5+ passage overview,
merging only the actual overview viewport. Only chart-base geometry gets the
lower display floor; detailed marks, soundings, leads and contours retain scale
rules. Browsing startup gates, the existing small-cell selection filter,
14-cell/32 MiB budgets and throttling remain. A failed overview merge does not
expose cached harbour geometry as a replacement overview.

The attribution chip now distinguishes renderer state (loading, loaded data,
unavailable, off, or zoom in) from the imported inventory in its drawer. Neither
count is a coverage guarantee. Live manifest v8 was read read-only: twelve
overview-eligible entries intersect the approximate passage bbox. That confirms
server inventory, not phone hydration or complete route coverage. The browser
regression deliberately uses a coarse synthetic reference cell; a separate
fine-only fixture correctly reports no overview rather than weakening guards.

The full-screen trial now uses `TrialTracerShell`: the manual Tracer's 18rem
amber fold-up card, pane-relative bounds and light/dark styling. Close and zoom
stay on the right; one body scrolls inside the card. Trial qualification and
textual danger state stay visible when folded and during waypoint inspection.

Tap a numbered pin (or Select waypoint in review), then Move, tap its proposed
position, and Confirm move or Cancel. An amber two-segment preview is not applied
until confirmation. Integer display pins replace only their original vertex;
fractional 50 NM pins insert a vertex without deleting either original neighbour.
All hidden geometry survives; edited anchors remain visible in the sparse plan.
The camera stays at the edit instead of refitting the whole passage. Departure,
destination and the exact canal handover are changed in setup/recalculation;
internal canal pins are editable.

Every confirmed move creates a new route object and exact geometry key, aborting
old checks and rechecking every detailed segment. Pending candidates are bound to
their originating proposal and path index. Original provider/canal evidence and
hazards remain historical, not clearance for the edited geometry. Saving an edited
trial is explicitly blocked pending a provider-revalidation workflow; no route
is activated and existing saved routes are untouched.

Validation: 288 focused tests and 16 Chromium/WebKit cases passed, including
portrait/short landscape editing, split panes, hidden hazards, cancellation and
overview/no-overview cases. Eight final overview/daylight/night-vision browser
cases also passed. These are synthetic rendering/interaction tests, not a live
SevenCs calculation or a physical-phone navigation check. Production delivery
details follow after build/sync verification.

Production TypeScript/build and Capacitor sync passed. All 426 generated `dist`
files byte-match the embedded iOS public files. Current entry:
`assets/main-BY0dr8Xb.js`, SHA-256
`772412d2e5bbf5cd9d3f82eee889eb5591e1c22985541185ca16964906362b0c`.
The existing local `/plan` server returns that same entry. Bundle budgets remain
unchanged and pass (12.83 MiB total, 9.36 MiB JavaScript / 9.90 MiB cap).
No native phone install/restart, backend deployment, archive or TestFlight
upload was performed. Refresh the browser when ready to discard its current
unsaved trial; use Xcode Run to install this candidate on the phone when no
active recording depends on the running app.

## Tracer interaction polish — final evening pass

The expanded card now separates Setup and Review without creating another
planner or discarding a proposal. The route opens in Review; Calculate and Clear
remain reachable in a Setup footer. Both page changes disarm endpoint placement.
Review disclosures and the save form stay mounted while hidden, retaining a
route name, valid acknowledgement and completed-save state for unchanged input.
Geometry/evidence changes still invalidate consent through the existing save
guard. Compact stats report distance along the full path and displayed pins.

Provider dangers, local hazards, depth and tide conditions remain visible in
Review. Non-urgent findings fold into counted disclosures with their original
locators; chart grades and original-versus-historical provider status are not
changed. A waypoint row is now one clear selection action.

Map taps use the nearest projected pin within a 44 px touch target, including
wrapped-world copies, rather than trusting render order. Pin inspection and
manual pan/zoom no longer cause incidental whole-passage reframing when chart
data or the panel changes. Show on chart measures committed floating controls
and positions the pin in uncovered chart space. Show whole route cancels any
unconfirmed move, clears pin/provider highlights, folds the card and then fits.

Undo is deliberately one immutable checkpoint, not an unbounded route history.
It restores exact previous geometry, clears save/preview state and starts a new
local review attempt so an old completed callback cannot restore green checks.
Undoing a second move retains the first edit and its provider-revalidation save
block. Setup changes, Clear, new calculation and account invalidation remove
the checkpoint. No navigation, provider-clearance or saved-route mutation is
implied by editing or undoing a trial.

Focused source validation: 289 tests passed (200 helper/panel/review/save tests
plus 89 workspace cases), including endpoint-edit disarming, persistent save
form state, undo races, nearest-hit selection and camera ownership. Production
TypeScript/build and client-secret checks passed. Browser and final artifact
delivery checks are recorded below when complete.

Final production build, Capacitor sync, bundle budgets and all 140 artifact
contracts passed. All 426 generated files byte-match `ios/App/App/public`.
Entry `assets/main-CdScsYH_.js`, SHA-256
`dd88d80b664875978d458e5bf98c6402b2e1f7c9ee15b24b03fb015f1fdb52cb`.
The existing `/plan` preview serves that same entry. Bundle: 12.84 MiB total,
9.36 MiB JavaScript (unchanged 9.90 MiB budget), 18.0 KiB main entry.
Build/sync logs: `/tmp/thalassa-tracer-polish.4oPXYY/`.
No backend deployment, native phone installation/restart, archive or TestFlight
upload was performed. Browser refresh and Xcode Run remain explicit user actions.

All 82 distinct Chromium/WebKit browser cases verified: the full run passed 75;
six obsolete daylight-colour expectations and one unsupported mobile-WebKit
mouse-wheel test action were corrected, then the seven cases plus one extra
Chromium landscape repeat passed. Real wheel scrolling was checked in Chromium;
WebKit checked scrollability, button reachability and actual pin interactions.
The cases include 390/430 px phones, 568 px short landscape, split panes, all
three themes, undo, persistent route-name state, focus/whole-route transitions,
44 px pin hit targets, exact provider hazards, ENC overview limits and full-path
preservation behind sparse waypoints. No browser runtime errors were reported.
These remain synthetic fixtures, not real-phone or real-world route clearance.
Screenshots: `/private/tmp/thalassa-autoroute-ux-browser-final` and
`/private/tmp/thalassa-autoroute-ux-browser-recheck`. Root visually inspected
portrait daylight Review, daylight move preview, dark pin inspection and the
short-landscape layout. Scoped lint, formatting and diff checks passed.
