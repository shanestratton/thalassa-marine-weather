# Build 133 underway alarm relay

Status: staged server support. No database migration or function deployment has been performed. The existing AIS relay remains compatible. The app/Pi watch and physical locked-phone acceptance are separate work.

The dedicated Pi client sends `family: 'underway'` on probe, raise and sync. The two kinds are `off-route` and `chart-ahead`, with keys `kind::<raisedAtMs>` and no MMSI. Each warning keeps its encounter key until it clears. Only the kind, key, raised time and resend flag enter a push. Chart coordinates, depths, distances, names, cell IDs, ETAs and evidence stay aboard; both the parser and new database constraint enforce the empty evidence payload.

An explicit underway probe returns `underway: { v: 1, enabled: boolean }`. Enabled requires the service-role-only schema RPC to return exactly 1 and the same project's deployed send-push service to confirm its new delivery contract and APNs configuration. Missing/error/old support disables the new family; it does not disable AIS. Old AIS probes retain their shape. Both the query and handler scope sync resolution to the requested family, so one watch cannot close the other's alarms. New and repeat pushes share the existing owner caps; acknowledgements last for the encounter.

## Deployment and rollback

1. Inspect the latest live migration/function state and preserve any newer fixes. Review the new held file `supabase/held-migrations/20261015220000_underway_alarm_kinds.sql` by itself. Existing held migrations remain held. Obtain the specific database approval before applying it; do not run a blanket push.
2. Replay the old table migration and this new migration in an ephemeral PostgreSQL database with `psql -v ON_ERROR_STOP=1 -f tests/sql/underway-alarm-replay.sql`. The fixture creates roles and an auth schema: never run it on a real project.
3. Apply only the reviewed migration, deploy the matching send-push config/handler, then deploy the matching pi-alarm-relay source. Verify the explicit probe, with no test alarm, before enabling the Pi client. A successful probe is not a delivered-push check.
4. Install the app before the staged Pi update, with no active anchor watch. Verify an owned test on a locked phone, acknowledgements aboard/ashore, offline aboard notification and recovery. Keep chart evidence aboard.
5. To roll back, first disable the Pi underway client and confirm no pending underway pushes. Restore the previous edge relay and push handler. Keep the additive database constraints and rows until reviewed retention/cleanup permits a separate rollback; do not delete alarm history or narrow constraints while new kinds remain. The old client ignores the absent capability.

## Validation

`deno test supabase/functions/pi-alarm-relay/relay_test.ts supabase/functions/pi-alarm-relay/underway-capability_test.ts supabase/functions/send-push/config_test.ts` passes all 46 behavior tests under Deno 2.9.4. These include all existing relay and APNs policy cases plus new privacy, family isolation, capability, acknowledgement, resend interval and shared owner cap cases. Deno formatting passes. Full edge entry-point checks require dependency access and are included in the focused CI; ephemeral PostgreSQL replay is also required before integration.
