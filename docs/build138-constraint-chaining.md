# Build 138: must-pass and leave-side chaining

The planner now sends an explicit via request through a shared ordered-leg
executor before any direct-route shortcut. The actual inshore and offshore
engines retain their existing chart and land verification. This checkpoint
does not yet complete Tracer editing, persistence or reviewed re-plan vias.

Each ordinary via is an exact required vertex. A leave-side mark instead has
an explicit 5–2000 m passing-point offset, shown to the user, and a forbidden
great-circle half-line on the other side. This offset is a user choice, not
charted clearance. No ENC feature properties, licensed layers or provider
records belong in this contract. Side direction derives from the neighbouring
user points; a degenerate reversal is refused. Spherical intersections retain
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

Remaining wiring must carry user constraints through GPX, Tracer save/restore,
per-leg Auto and reviewed re-plans. Generated shape
points must not silently become new user constraints. The actual planner
cannot expose Save/Export/Follow until its complete final verdict passes.
