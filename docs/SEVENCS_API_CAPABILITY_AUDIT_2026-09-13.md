# SevenCs API capability audit — 13 September 2026

**Local audit draft; documentation review complete.** Every rendered endpoint
and recursively referenced request schema was reviewed, including NAPA and DTN
alternatives. This is documentation coverage, not a claim that every endpoint,
a production deployment, or a real voyage has been tested. Wrapper and provider
diagnostic improvements are being implemented separately in the local tree;
they are not live and must be verified before the baseline gaps below are closed.

## Local implementation follow-through

The following changes now exist in the local tree, without production deployment:

- Track advisories identify the actual finite chart feature, distinguish
  crossings from sustained alignment and group repeated advisories. Depth,
  obstacle and other non-track warnings remain per-leg and locatable.
- The trial can request one bounded SevenCs recalculation using ordered
  `mustGo` points from a separately reviewed Newport track. It validates the
  returned geometry and rechecks the complete resulting route; it never
  post-snaps a line while retaining the old provider report. This is **not**
  universal channel-centreline routing. (The Newport track policy and its review were retired and removed on 10 October 2026.)
- Provider reports now have a bounded structured unsafe/caution/not-reported
  summary. Explicit `safe: false` remains red; documented Info/Warning/Danger
  severity is preserved. A prominent provider banner is separate from local
  chart colours. Older replies recover findings from the original source and
  legacy warning text. Unknown or missing information never becomes provider
  clearance. Exact provider hazard geometry/provenance and locators remain a
  follow-up rather than being guessed from feature indexes.
- Review state is fenced by exact route, draft and recheck attempt before
  rendering, including cancellation, changed charts and late responses.
- **645 focused tests in 15 suites pass**, covering geometry, transport,
  provider reports, local review, canal joins, lifecycle and workspace wiring.
  Scoped ESLint, formatting and whitespace checks pass. The normal production
  build (including TypeScript and client-secret scans) passes, with entry
  `main-BJwTlWe7.js`. Bundle budgets pass (9.30 MB JS / 9.90 MB limit), and
  local production deep-link/asset verification passes. Real navigation and
  provider field trials are not established by these tests.

The baseline gap table below records what the audit found; its safety-display
row is partially addressed above. Known vessel dimensions, estimated-draft
handling, richer provider geometry and schedule integration are still open.
The new client requires explicit backend `channelGuidance: true`; deployment
of that capability remains pending. No paid option or entitlement was changed.

Reference: authenticated [Route Network Service documentation](https://aws-rnw-03.chartworld.com/documentation),
service version **3.3.2.29 (18.03.2026), API v1**. Documentation facts below were
checked in the main task; implementation evidence comes from the current local
source. See also [the isolated trial's scope and validation history](AUTOROUTING_TRIAL.md).

## Documentation coverage checklist

- [x] Every endpoint rendered in the documentation, including synchronous and
      asynchronous routing, modified-RTZ input/check/expand workflows and
      `inputrtz` retrieval, conversions, network/chart-library information,
      updates/version, and usage/invoice diagnostics.
- [x] The complete recursively expanded request model: positions/geometries,
      network, vessel, safety, schedule, processing/finalization flags,
      route constraints, notices, and NAPA/DTN weather/voyage/CII/cost alternatives.
- [x] Ordered `mustGo` points/areas; `noGo` geometries; `stayAway` controls for
      internal waters, 12 nm zones, ECA and custom Allow/Avoid/Disable/cost
      treatment; and the separate via-area facilities. Their existence does
      not authorize exposing arbitrary geometry or cost controls in the trial.
- [x] Result formats and diagnostics: original RTZ/GeoJSON, tracks, danger
      features, geometry/UUID/dataset/provider provenance, CATZOC, corridor
      polygons, XTD limits and operational metadata.
- [x] All **11** worked-example downloads under the service's public `/examples`
      URLs were fetched and inspected. The large `modified.json`, containing
      RTZ and 520 via entries, received structural inspection only. No example
      was submitted or executed against the provider.

Rendered endpoint inventory (brace notation groups documented paths):

| Method | Paths                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/token` (external OAuth issuer also documented separately)                                        |
| GET    | `/api/documentation/swagger.json`, `/api/monitor/status`                                                |
| GET    | `/api/network/{viaareas,ports,pilotstations,shiptypes}`                                                 |
| POST   | `/api/route`, `/api/route/check`, `/api/route/expand`                                                   |
| GET    | `/api/route/{id}`, `/api/route/{id}/{request,status,inputrtz,rtz,strippedrtz,geojson,viaareainfos}`     |
| POST   | `/api/route/convert/rtz/geojson`                                                                        |
| GET    | `/api/route/costprofile/{name}`, `/api/route/costprofile/list`                                          |
| GET    | `/api/statistics/invoice`                                                                               |
| GET    | `/api/visualization/{item}`, `/api/visualization/tile/{x}/{y}/{z}`, `/api/visualization/{item}/version` |
| GET    | `/api/visualization/ntms/{id}`, `/api/visualization/currentntms`                                        |

The 11 public example files were `hamburg_newyork.json`,
`disabled_viaareas.json`, `hamburg_newyork_pilot_station.json`,
`hamburg_newyork_napa.json`, `hamburg_newyork_dtn.json`, `modified.json`,
`stay_away_areas.json`, `nogo.json`, `mustgo.json`, `customcosts.json` and
`cargo.json`, each under `https://aws-rnw-03.chartworld.com/examples/`.
The authenticated Swagger-download endpoint was identified, but a standalone
Swagger download was not obtained with the browser tools; coverage comes from
the fully expanded rendered documentation, not an asserted downloaded schema.

The chart-library, network, update/version and usage/invoice endpoints have
integration value for coverage/provenance and operational support. They are
not currently consumed by the isolated route request, and none should be
described as tested merely because its documentation was read.

## Verified implementation

- The edge adapter uses token authentication and synchronous `POST /api/route`.
  Trial enablement, exact account allowlist, expiry, credentials, quota,
  cancellation and response bounds remain server-controlled. This is an
  isolated, disposable proposal, not a saved or active navigation route.
  Evidence: [`trialAccess` and `createAutoroutingTrialHandler`](../supabase/functions/_shared/autorouting-trial.ts),
  [`AutoroutingTrialWorkspace`](../components/autorouting/AutoroutingTrialWorkspace.tsx).
- [`buildSevenCsRequest`](../supabase/functions/_shared/autorouting-trial.ts)
  sends departure/arrival, `vessel.type: 'Yacht'`, the supplied draft and a fixed
  **0.5 m** clearance in berthing/confined/coastal/open-sea areas. It calculates
  **leaving now**: `schedule.etd` is the server time; sea and river speed use the
  supplied cruising speed, and berthing speed is capped at 3 knots. This
  deliberately overrides the documented defaults of 25 knots at sea/river
  and 3 knots berthing. Network is omitted, retaining the documented approved
  **Static** network. Safety also documents vertical clearance, default zero;
  the current water-area under-keel settings do not establish overhead
  clearance for this yacht.
- The request already enables `routeCleanerSimplified`, `routeCleanerXTD`,
  `splitGreatCircle`, `confinedWaterFinder`, `openSeaFinder`,
  `radioCallingPointFinder`, `routeExpander`, `routeScheduler`,
  `restrictionChecker`, `routeChecker`, `minSpotSoundingFinder` and
  `routeFinalizer`. `weatherOptimization` and `calculateVoyage` remain false.
  The documented route-checking prerequisites—expansion and confined/open-sea
  classification—are therefore requested. Enabling a flag does not establish
  that its complete output is presented to the user.
- New **local transport support** accepts 1–8 explicitly ordered, valid,
  distinct coordinate-only `chartTrackConstraints` and maps them to documented
  `mustGo` objects: `{ position: 'lat lon', id: index, name: 'Chart track N' }`.
  Inputs are cloned before asynchronous authentication. Unknown edge fields,
  arbitrary RTZ, geometry and cost/profile overrides are rejected. Omission
  preserves the previous request body. Only ready, entitled status advertises
  `channelGuidance: true`; an older server without that explicit capability
  must not receive guided requests. Caller integration is a separate check.
  Evidence: [`AutoroutingTrialRequest` and limits](../types/autorouting.ts),
  [`snapshotRequest`/status validation](../services/autoroutingTrial.ts),
  [`validateTrialInput`/`buildSevenCsRequest`](../supabase/functions/_shared/autorouting-trial.ts).
- The parser validates geometry and bounded payloads, preserves the original
  RTZ and GeoJSON strings, and retains returned track vertices without local
  simplification. It joins only already-identical adjacent endpoints and
  rejects gaps. `safe: false` and danger/warning/restriction/obstruction/hazard
  feature types produce provider warning text: they are **not silently ignored**.
  Evidence: [`parseSevenCsResult`](../supabase/functions/_shared/autorouting-trial.ts),
  [`AutoroutingTrialRoute.source`](../types/autorouting.ts).
- Independent local ENC review uses `gradeLegs` with `chartedDepthOnly: true`.
  Repeated explicit chart-track cautions are grouped for presentation only;
  per-leg hazards, colours, markers and locating controls remain intact.
  Evidence: [`reviewAutoroutingProposal`, `trialChartTrackAdvisories`, `trialReviewFeatures`](../services/autoroutingReview.ts),
  [`TrialRouteReviewPanel`](../components/autorouting/TrialRouteReviewPanel.tsx).

## Bounded gaps and priorities

| Priority                   | Current gap and repository evidence                                                                                                                                                                                                                                                                                                                                                                       | Proposed next step                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — safety presentation   | Provider `safe: false` and danger features become generic amber text. Structured severity/category/identity/provenance and feature geometry do not reach the review panel or map. `trialReviewFeatures` colours reflect local review alone, so a locally green leg can coexist with a provider unsafe warning. See `parseSevenCsResult` and `proposal.warnings` rendering in `AutoroutingTrialWorkspace`. | Normalize a bounded, typed provider-check layer; retain severity, source identity and location; make checks locatable and visibly distinguish provider findings from local review. A local clear result must not override a provider unsafe result. |
| P1 — vessel completeness   | The provider receives only vessel type and draft, despite profile `length`, `beam` and optional `airDraft` in [`types/vessel.ts`](../types/vessel.ts). The documented omitted dimensions/air draft default to zero; this does not mean this yacht has zero dimensions or confirmed overhead clearance.                                                                                                    | Add explicit bounded dimension inputs with the established feet-to-metres conversion. Preserve missing/estimated status. Do not invent a turning radius: no existing turning-radius profile input was found.                                        |
| P1 — estimated draft       | [`RoutingModeDialog`](../components/autorouting/RoutingModeDialog.tsx) snapshots numeric draft/speed only; local review supplies `draftAssumed: false`. The existing [`vesselDraftIsAssumed`](../services/units.ts) distinguishes estimated draft, and Vessel settings warns that estimates are guesses.                                                                                                  | Carry the measured/estimated distinction into trial eligibility and review. Require confirmation or show an explicit incomplete state; do not silently treat an estimated draft as measured.                                                        |
| P2 — corridor policy       | `routeCleanerXTD` is enabled while `maxXTD`, beam and minimum turning radius are omitted. The documentation gives `maxXTD` a 2,000 m default, describes removal of vertices within a corridor, and relates minimum XTD to half the beam.                                                                                                                                                                  | Define yacht-specific corridor/cleaning/turning requirements before changing defaults. Compare controlled fixture results and preserved raw output. These settings alone do not prove why a particular observed route was off-track.                |
| P2 — useful checker output | Track `tag`, `safety_depth`, `height`, `xtd_starboard`, `xtd_portside`, `min_depth`, `catzoc`, `length`, `leggeometrytype` and `speed`; danger severity/category/UUID/class/dataset/provider; corridor polygons and XTD limits remain in raw source rather than typed review UI.                                                                                                                          | Confirm nullability/units/discriminators against the detailed schema, then expose selected fields with provenance and conservative unknown-state handling. Keep original payloads unchanged.                                                        |
| P2 — departure schedule    | The trial uses server-now, not Planning home's scheduled departure stored by [`DepartControl`](../components/passage/DepartControl.tsx). Returned timing/speed detail is not presented.                                                                                                                                                                                                                   | Make “leave now” versus selected departure an explicit product decision; snapshot/validate that time and expose schedule assumptions. Do not silently reuse a stale departure or add tide credit.                                                   |

The documentation confirms exact lowercase GeoJSON feature discriminators
`properties.type: 'track'` and `'danger'`; `tag` is a separate attribute. The
parser's exact `track` check matches that contract. Unrecognised geometry must
not become an invented route.

## Policy and licence boundaries — not enabled by this audit

- **Chart ownership:** displayed/downloaded ENC coverage and the provider's
  licensed routing-chart coverage, editions and entitlements are separate.
  A visible local chart neither proves provider coverage nor grants a routing
  licence. Local review and provider checks must retain their own provenance.
- **Network selection:** Static is the documented approved network.
  Dynamic/AIS can introduce uncontrolled AIS legs whose quality is not
  guaranteed. `None` is limited to 50 nm. The deprecated
  `forceDirectBerthing` must remain false, not become a bypass. These options
  require a deliberate routing policy, not an automatic network upgrade.
- **Notices and paid services:** the documented NtM `consider`/`warn`/`ignore`
  modes require the designated licence; omitted NtM configuration means
  notices are ignored, not implicitly checked. NAPA/DTN weather, CII and
  voyage/cost options need explicit entitlement, cost and safety-policy review.
  No switch was enabled.
- **Tides:** no tide input was found in the reviewed API. Do not automatically
  add a tidal height to charted/LAT depth.
  Time, vertical datum, location, source authority and uncertainty require a
  separate design. The present fixed clearance has **no tide credit**.
- **Chart-track following:** no universal “snap/follow all leads” switch was
  found in the documentation reviewed. Ordered `mustGo` points are explicit
  constraints, not universal lead adherence or permission to rewrite provider
  geometry. No universal centreline guarantee was found. Clearing/transit
  lines must not be mistaken for navigation tracks.

## Documentation contradictions and compatibility cautions

- The asynchronous introduction describes **503 + Retry-After** while the
  result endpoint declares **302** for “not ready.” Confirm the actual contract
  before implementing polling; do not choose one silently.
- DTN `hurricaneDistance` is described in **knots**, which is a speed unit.
  Its intended distance unit needs provider clarification before use.
- Downloaded examples use older **2.3/2.2** schemas versus the current **3.3**
  documentation. Differences include DTN sample `waveHeight` versus schema
  `totalWaveHeight`, fuel/RPM-curve placement and NAPA cost-field placement.
  Examples illustrate workflows, not a safe current-schema template. Validate
  any adopted field against the current contract; do not copy them wholesale.

## Proposed phased rollout

1. **Resolve contract ambiguities, without deployment:** retain the completed
   documentation inventory, clarify the contradictions above before using
   affected features, and keep fail-closed transport and unsupported-server
   behaviour. Documentation coverage is not runtime certification.
2. **Make existing results honest and useful:** normalize provider checks and
   locations, reconcile their display with local leg status, propagate estimated
   draft, and add validated known yacht dimensions. Keep source payloads and
   native/manual routing unchanged.
3. **Evaluate bounded guidance and corridor policy:** use explicit server
   capability plus reviewed chart-track provenance; test ordered constraints,
   geometry preservation, failure paths and phone/desktop locating. A failed or
   unsupported guided calculation must remain an honest notice, not a snapped
   or straight-line replacement route.
4. **Consider optional services separately:** select schedule, network, NtM,
   turning/corridor and paid-service policies only after requirements and
   licences are confirmed. Any deployment/provider experiment needs its own
   authorization and release verification.

## Evidence limits

Focused local transport validation passed **170 service/edge tests**, including
malformed/excess constraints, snapshot/order preservation, exact `mustGo`
mapping, unknown fields and capability gating. A synthetic parser probe
confirmed that unsafe/danger warnings survive, raw source is unchanged, and
structured provider checks are absent from the normalized result. **Four**
compiled Chromium/WebKit phone/desktop fixture cases passed for grouped track
advisories, preserved hazards and locating; settled screenshots were inspected.
These used synthetic data, not licensed provider responses or a sea trial.

This audit made no code changes, deployment, live route request, licence change,
or claim of complete endpoint testing. Earlier build/deployment facts in the
trial history are separate from this read-only capability review.
