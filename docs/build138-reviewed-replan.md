# Build 138: reviewed underway re-plan

This first checkpoint supports a followed saved route on the selected boat's
active Cast Off passage, with no remaining intermediate constraints. An ad hoc
text-ID track without the server's active passage stays unchanged. The HUD offers one
explicit re-plan action. An actual new forecast generation, a live ETA slip of
at least 30 minutes, or the existing conservative inshore XTE limit may suggest
review; none starts a job or changes the followed route automatically. A
provider's first valid hour or fetch clock is not presented as a model run.

Preparation captures the authenticated account generation, selected boat,
tracking voyage and its immutable cast-off boat binding, original follow identity/geometry, routing policy, route
authority and the exact device/server-stamped public link. It acquires a fresh
receiver/phone fix without extrapolation. It asks explicitly for one selected
global model's regional forecast, at most a 20° route span plus 2° padding,
168 forecast hours, 2° grid resolution and 8 MiB of decoded arrays. Preparation
and candidate computation share a 60-second eligibility deadline. Satellite
Mode refuses this fresh-network action. Missing clocks/cells are unavailable.

The handoff uses the existing passage planner and its final displayed
chart/land/environment verdict. The original grey dashed reference is drawn
beside the proposed line; the original follow store and public link stay
unchanged. The re-plan uses its private fetched wind grid and a strict absolute
time sampler. It cannot take the legacy single-frame, inferred-clock wind
fallback. Final geometry and modeled clocks must match, and the complete
bounded wind check includes endpoints, hourly checkpoints and actual forecast
knots. A failed/cancelled/expired candidate has no follow or publication side
effect. Coastal geometry still uses the existing chart verifier and its coarse
ETA doctrine; the weather field cannot certify a channel.

Accept is an explicit review naming the current link's device. It rechecks the
account, boat, follow identity, policy, authority, displayed candidate and sign-in
session through the save and commit. A fresh fix more than 0.1 NM from the
reviewed origin requires another re-plan. The preview expires after five
minutes. Save may leave a private draft if the subsequent replacement is
refused; the previous route is retained.

The held migration was created with Supabase CLI 2.121.0 `migration new
reviewed_route_replan`, then moved to
`supabase/held-migrations/20261016182725_reviewed_route_replan.sql`. It is not
deployed by source checkout or a normal migration push. Its authenticated RPC
checks the still-live `auth.sessions` row, same owner, active selected boat,
active voyage and cloud route-authority snapshot under row locks. It compares
the old plan ID, author device and exact server timestamp. Cast Off's local
passage UUID may differ from its public planned-route mirror ID, so it also
requires the original exact geometry SHA-256. It locks at most 259 owner-scoped
rows per original/new plan and verifies the new boat binding, expected row
count and geometry SHA-256, then updates the link and inserts
one idempotent receipt in that transaction. A
changed or missing condition leaves the old link intact. The candidate's original
departure clock remains the five-minute review clock; save latency cannot renew
it, and the acceptance fix must still be current. No unconditional
upsert, legacy fallback or offline acceptance queue exists. The receipt table
has owner-only reads, no authenticated direct writes and a 512-row account
bound. It stores identifiers, a review-payload hash and clocks, not chart features or
forecast grids. The existing author-stamp trigger remains unchanged.

An absent held RPC or ambiguous network result leaves the original local route
and asks for a current-link check; it never pretends to know whether a timed-out
server commit landed. No signing, publishing, provider activation or live DDL
is performed by this feature's tests.

## Remaining gates

At this checkpoint, the focused policy/service/preview/source-boundary checks
pass (34 tests), as do three suggestion-control tests and 30 sequential PGlite
checks. Four actual Chrome/WebKit comparison checks pass at 300/375 px with
130% text and no remote requests. Those browser checks exercise the comparison
screen and refusal of a forged ready state; they do not prove a successful
database acceptance, a native device or the map reference's framebuffer.

- Real multi-session PostgreSQL proof is required before deployment. The
  disposable harness supports PGlite for sequential syntax/privacy checks and
  opted-in `localhost/route_replan138_test` PostgreSQL for two 16-session races.
  Its minimal schema includes the actual existing author-stamp migration, but
  does not replace live schema/role/trigger preflight.
- The current planner stores/display vias without using them in computation.
  This checkpoint refuses every remaining accepted via and ambiguous repeated
  visit. A saved manual curve without represented constraints is also held.
  Build 138-08 must add shared verified waypoint/leave-side chaining,
  then integrate it here before claiming full 138-04 route coverage.
- Final combined 137/138 native, bundle, full-suite, source and device gates
  remain required. This is an isolated 136-based foundation, not full 138 ship.

Supabase's [session documentation](https://supabase.com/docs/guides/auth/sessions)
defines the relationship between the JWT session ID and `auth.sessions`;
[database-function guidance](https://supabase.com/docs/guides/database/functions)
documents privilege and search-path handling. The current changelog's
PostgreSQL index/legacy-cipher changes and upcoming TLS-CBC retirement were
reviewed; this migration adds no affected index or cipher and changes no TLS
configuration.
