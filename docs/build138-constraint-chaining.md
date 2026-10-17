# Build 138: must-pass and leave-side chaining

The planner now sends an explicit via request through a shared ordered-leg
executor before any direct-route shortcut. The actual inshore and offshore
engines retain their existing chart and land verification. This checkpoint
also retains Tracer editing and saved point intent. Per-leg Auto is visible
with a cold final-geometry check and a bounded cancellation lifetime.

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

GPX via handoff uses the shared cohort. Tracer distinguishes the actual line
from its original mark and generated shape/depth vertices. Local recovery,
account sync, trip aggregation and reversal retain those roles; reversing flips
port/starboard and the fixed bearing while preserving the physical passing
point. Dragging a passing point explicitly clears its side choice. A changed
side or stand-off cannot reuse a geometry-only clearance or acknowledge a side
crossing. Original-mark overlays clear synchronously on account changes.

Saved point pairs remain `[lat, lon]` for legacy ordinary points. A strictly
validated third value retains a generated role or version-1 private mark/name
metadata. Unknown versions or malformed metadata refuse the complete record.
The existing JSONB point storage and geometry clock use the first two numbers;
no schema change is needed. Older clients do not understand the new semantic
metadata and cannot provide leave-side preservation guarantees. No licensed
chart properties are saved in it. Save/Export/Follow still require the complete
final verdict.

Focused codec, account-sync, draft, editor, reference-marker and stale-planner
tests cover these boundaries. Four actual Chrome/WebKit cases at 300/375 px
and 130% text exercise the real editor, local save/reload, reverse/restore and
account switch with zero WAN. They do not prove native devices, actual chart
clearance or deployment of the held replan migration.

Per-leg Auto routes into the selected pin, or the last leg when none is
selected. It reads the confirmed vessel draft and that leg's actual
departure-plus-transit clock. The charted-depth `safest` engine runs once with
no tide ceilings. Missing installed coverage refuses with the Pi-chart
instruction; Auto does not fetch replacement charts, use tide credit or
substitute a straight route. Satellite Mode refuses before any engine/provider
request. The existing 50 NM regional request limit remains; polar/dateline
legs and worker curves extending beyond a 150 NM regional envelope refuse
before the flat Tracer simplifier can create a global chord. This is independent
of the still-parked course-frame entry.

The result needs complete masks and no charted-land finding. After RDP and
segment capping, the final proposed trace must retain all original points and
side choices. Its edited leg then needs the existing complete land backstop
and a fresh `recheckTrace` pass with every final segment graded clear. Caution,
missing data or any refused check leaves the original pins untouched. No prior
acknowledgement is carried into this strict sweep. All stages share a single
60-second service lifetime; cancellation also unblocks an uncancellable native
wait. Generated interior vertices retain `shape`, while both user terminals
are unchanged. No chart resident/cache limit increases.

The hook prevents duplicate same-tick runs and retires work on owner, boat,
draft, Satellite Mode, pin/selection, departure or view changes, including a
boat switched away and back between awaits. Focused service/hook and existing
draft, privacy, lazy-boundary and clearance suites pass 138 cases. Four actual
Chrome/WebKit cases also exercise the real Auto control's zero-WAN Satellite
Mode refusal without changing the saved points. Success and refusal paths
use deterministic service/hook tests with injected engine and grading results;
these browser cases do not claim actual on-device chart clearance or a
performance measurement.
