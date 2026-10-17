# Build139-06 anchor safe-area backend review

Source preparation only. No live DB/function/Pi change is performed. Supabase CLI2.121.0 `migration new anchor_safe_area` generated `20261017002338_anchor_safe_area.sql` at current UTC. The original held `20261017100000_anchor_safe_area.sql` remains unchanged: 10:00 UTC was still in the future at review. Apply neither a duplicate held version nor a rewritten old canonical migration.

## Actual remote read-only preflight

Project `pcisdplnodrphauixcau` reports PostgreSQL17.6. The latest ledger entry is `20261016194559_overdue_watch`, without the new area migration. `pi_anchor_sessions` has its eleven existing columns and no safe-area fields. RLS is on, with no client policy or `anon`/`authenticated` table grants. Existing `service_role` table grants, owner/relay foreign keys, seven-day expiry constraint and account-deletion write fence remain present.

Deployed `anchor-relay` is version8, `verify_jwt=true`, bundle hash `912bdb156634d3b9fe3fa97b77f1a8969a964704d75bd79b899644bc0f64862e`. Its two source files contain no safe-area admission. The relevant current security-advisor INFO is RLS with no policy, intentional for this service-only table; adding a public policy would weaken it. See the [Supabase linter explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

## Race and narrow repair

The staged relay read boundaryA, validated a report againstA, then awaited the old heartbeat RPC. Owner editB could commit before that RPC locked the row, letting staleA renew or raise an alarm againstB. Authorisation similarly read then upserted its prior area; a legacy renewal or stale clear could overwriteB. Stop had a read/delete gap.

Three new RPCs are `SECURITY INVOKER`, with EXECUTE revoked from PUBLIC/anon/authenticated and granted only to `service_role`:

- `authorise_pi_anchor_area(text,uuid,text,jsonb,boolean,jsonb,text,text)` takes relay, owner, session, original binding snapshot, explicit-area flag, proposed envelope, UUID and selected vessel. Under the actual row lock, explicit edits compare the original owner/session/revision/full frame+boundary/vessel. A changed area/vessel cannot reuse its old UUID. A legacy same-session renewal preserves the **current locked** area, not its stale read. A clear requires a framed circle with `zone:null`, never an unframed null.
- `record_pi_anchor_area_heartbeat(text,text,uuid,jsonb,text,text,boolean,boolean,real,real,real,real)` compares the exact original owner/session/envelope/revision/vessel under that lock, then invokes the unchanged `record_pi_anchor_heartbeat` in the same transaction. A refusal happens before lease/alarm work and before the Edge's publication attempt.
- `stop_pi_anchor_area(text,text,uuid,jsonb)` compares the locked expected area before deletion and alarm resolution. A stale stop cannot deleteB; an already-stopped owner binding remains idempotent.

All three first take the same per-relay transaction advisory lock, then the binding row. Authorisation takes the watch-session lock after the binding, matching the original heartbeat order. The advisory lock also covers absent rows; `INSERT ... ON CONFLICT DO NOTHING` refuses an unexpected first-creation conflict. Existing table RLS/client grants and the old heartbeat source/signature/grants are unchanged. SQL bounds the envelope/metadata; the actual canonical Edge parser still owns geometry and containment validation. See [PostgreSQL17 locking](https://www.postgresql.org/docs/17/explicit-locking.html).

Acceptance is linearized at the database transaction. If B wins first, staleA is refused with no heartbeat/alarm/publication. A report accepted beforeB can already have a network delivery in flight; a later edit cannot retract it. Its original UUID/frame remain in the payload. This packet does not claim distributed transaction semantics between PostgreSQL and the Realtime HTTP request.

## Evidence and prepared real SQL proof

`tests/AnchorAreaHandler139.test.ts` executes the actual compiled Edge handler in an isolated VM with a fake service boundary. It checks legacy circle success, exact proof arguments, a DB-retired report's no-publication path, foreign owner/session/expiry/revision rejection, current-B legacy-renewal echoes, and stale clear/stop refusal. `work/validation139-anchor-backend-handler-first.log` has78 passes across six suites. The final gate proof adds held custom changes without a write, explicit framed clear and enabled custom admission: `work/validation139-anchor-backend-gate-final.log` has79 passes across those six suites. These are not real SQL race results. Migration audit passes227 files; scoped lint, Deno formatting and the DB runner's JavaScript syntax check pass.

`supabase/tests/anchor-safe-area-postgres.mjs` requires the exact empty localhost `anchor_area139_test` database, explicit opt-in and real PostgreSQL17.6; it refuses product configuration. The fixture applies the original canonical table and exact original heartbeat function/grants, then the new migration. Its account-deletion trigger is an explicitly minimal fixture. There is no HTTP extension, push trigger or product credential.

Prepared cases cover constraints, client CRUD/RPC denial, unchanged RLS/old heartbeat body, ownership, legacy renewal/report, framed null clear, no-renew/no-alarm on refusal, and actual competing transactions. Races require `pg_blocking_pids` evidence before releasing the winner, covering B-first versus stale heartbeat/renewal/clear/stop and original-heartbeat-first ordering. No sleep is accepted as proof of blocking.

Workflow `.github/workflows/anchor-safe-area-db.yml` is isolated to the named validation branch or a manual exact reviewed SHA. It uses PostgreSQL17.6, only `pg@8.16.3`, no product secrets, pinned action commits, and retains source/image/client-lock hashes plus success/failure logs. It is prepared but **has not run** at this checkpoint. There is no real local PostgreSQL PASS or deployment claim.

## Precise legacy bypass and drain gate

The old service-only `record_pi_anchor_heartbeat` intentionally remains unchanged. It knows owner/session/expiry but not boundary/revision/vessel. Direct legacy calls can therefore renew or raise an alarm on a row with a custom area. RLS does not stop the trusted service role. Version8 also lacks new area admission. Keeping an old relay version alongside new custom bindings, or rolling back to it, is unsafe. The new Edge path uses the guarded RPC; the old name remains a specific compatibility limitation.

No cutover or drain has happened, so there is **no measured live drain receipt** to report. The new Edge defaults to rejecting explicit non-null custom areas without touching the existing binding. Only root may set `ANCHOR_SAFE_AREA_ADMISSION=enabled-after-drain`, after confirming the new version, zero existing custom bindings and the measured drain below. Legacy circle renewals and explicit framed clear remain available while held. [Hosted Edge limits](https://supabase.com/docs/guides/functions/limits) currently specify150s free/400s paid worker wall clock and150s request idle timeout. A150s response timeout alone is insufficient because old background/async work may outlive it.

At deployment, record the first confirmed new-version cutover UTC, the latest observed old-version invocation start UTC and function version/execution ID, and the actual applicable worker limit. Keep custom admission held for **more than400s**, and beyond any greater known old request/worker lifetime, after the later of those times. Recheck version-specific logs and the live version, and confirm zero existing custom bindings before enablement. Reset the interval if any later old-version invocation is observed. Record actual elapsed duration and observations; do not turn the theoretical limit into a claimed measurement. If the platform cannot demonstrate the old version has stopped serving, keep custom admission held or implement the reviewed DB compatibility gate below. Do not rely on request timeout alone.

## Optional DB compatibility wrapper design — NOT implemented

A further migration could make legacy service calls safe independently of Edge drain:

1. Move the original function object/body to a unique unexposed schema such as `anchor_area_internal`. Preserve its exact implementation, but revoke schema USAGE and delegate EXECUTE from PUBLIC/anon/authenticated/**service_role**. Keeping service-role delegate permission would leave the bypass, including cached calls by the old function OID.
2. Restore the old public nine-argument signature as a narrow service-only wrapper. It locks the binding and refuses any non-null framed area; only a true legacy circle proceeds to the private delegate.
3. Route the new twelve-argument area wrapper to that private delegate only after its complete under-lock owner/session/frame/boundary/revision/vessel comparison. Both paths use the same lock order.
4. Because an invoker wrapper cannot call a private delegate denied to its service caller, those two wrappers would require an explicitly reviewed definer owner/role arrangement. Use a pinned search path, explicit qualified objects, no PUBLIC/client EXECUTE, and a service-caller check based on trusted role context. A dedicated non-login executor with only the needed private-delegate privilege is preferable to handing the service role direct delegate access. RLS interaction and any role/policy grant must be reviewed and tested independently.
5. Prove direct old/cached delegate calls fail, legacy null circles still work, framed circles/custom rows refuse the old signature, guarded current reports work, wrong owner/revision/geometry does nothing, and concurrent old/new calls have a consistent lock order. Retain negative and concurrency receipts before deployment.

That broader privilege/compatibility migration is a proposal for release-owner review, not part of this patch.

## Deployment sequence

First review and run the genuine isolated SQL proof, retaining exact source/run/artifact and failures. Recheck the live ledger/schema and apply only the new canonical migration. Deploy the reviewed relay and canonical shared files with gateway JWT verification retained. Verify RPCs, actual ownership/refusal and the drain gate before allowing custom bindings. Then separately stage/review/install Pi update8 and verify real GPS admission, fresh UUID/frame echoes, distinct-fix drag, recovery and Shore Watch before phone139 handoff. Keep old circular-device behavior supported. Never roll back to version8 while custom rows remain active; retire/clear them through the reviewed owner flow or keep the guarded relay deployed. Leave additive fields/functions in place rather than dropping a live watch.

Root controls live DB/Edge changes, admission enablement and Pi installation. These source tests do not replace real boat/iPhone/Watch acceptance.
