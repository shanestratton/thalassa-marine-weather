# Build 138: must-pass and leave-side chaining

The first core checkpoint defines bounded user-authored constraints and a
shared ordered-leg executor. It is preparation for wiring the planner and
tracer; an unreferenced helper alone does not complete 138-08.

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

Remaining wiring must carry user constraints through GPX, Tracer save/restore,
per-leg Auto and reviewed re-plans, and must apply the forbidden-side segment
guard during expansion and after every chart/smoothing pass. Generated shape
points must not silently become new user constraints. The actual planner
cannot expose Save/Export/Follow until its complete final verdict passes.
