# Build 138: must-pass and leave-side chaining

The planner now sends an explicit via request through a shared ordered-leg
executor before any direct-route shortcut. The actual inshore and offshore
engines retain their existing chart and land verification. This checkpoint
does not yet complete Tracer editing or per-leg Auto.

Each ordinary via is an exact required vertex. A leave-side mark instead has
an explicit 5–2000 m passing-point offset, shown to the user, and a forbidden
great-circle half-line on the other side. This offset is a user choice, not
charted clearance. No ENC feature properties, licensed layers or provider
records belong in this contract. Side direction initially derives from the
neighbouring user points; coincident or antipodal neighbours are refused. The
canonical saved choice freezes that bearing, so a later fix cannot rotate an
accepted side. Spherical intersections retain
short dateline and polar crossings. Every final route must keep the required
points in order, within 1 m, including its exact departure and destination.

The executor injects the existing route engine and final chart verifier. It
does not implement an alternate safety algorithm. All legs share one maximum
60-second budget and cancellation lifetime. Their absolute departures and
forecast offsets use precise modeled node time, rather than the rounded
distance/time summary. A bad clock, missing leg, failed final check or dropped
pin refuses the complete result. Fixed limits are 256 intermediate marks,
8192 final vertices and 50,000 aggregate frontier nodes; no chart resident or
offline cache limit changes.

The offshore engine applies the forbidden-side guard during expansion and
after smoothing/recovery. Inshore results are refused if their line crosses
that guard. A required hop under 15 NM cannot use an offshore shortcut when
the charted engine is unavailable. The final whole-route chart, land,
weather-coverage and ordered-point checks must all pass before route actions
become available. Short/coastal legs retain cruising-speed estimates with
unknown propulsion and local-current caveats.

Planner Save retains its exact full curve and a separate bounded private
constraint note after the geometry's first line. A strict field whitelist
excludes chart/provider properties. Account-scoped fetches and follow
reconstruction preserve independent copies. Legacy absent, explicitly empty
and unreadable metadata remain distinct: corrupt or ambiguous saved choices
hold re-planning closed. Re-plan hands all remaining marks to this same
calculator and checks ordered retention again before offering acceptance.
Accepted constraints are saved through the existing held atomic CAS contract.
Its SQL bytes and actual PostgreSQL proof are unchanged; no live migration or
successful-device acceptance is claimed.

GPX via handoff uses the shared cohort. Remaining wiring is Tracer save/restore
and per-leg Auto. Generated shape points must not silently become new user
constraints. Save/Export/Follow require the complete final verdict.
