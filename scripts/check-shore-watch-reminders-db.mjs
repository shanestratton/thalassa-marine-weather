/** Isolated PostgreSQL regression checks. Never connects to a real project.
 * PGLITE_MODULE_PATH=/tmp/.../pglite/dist/index.js node scripts/check-shore-watch-reminders-db.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const firstPhone = '00000000-0000-0000-0000-000000000011';
const secondPhone = '00000000-0000-0000-0000-000000000012';
const oldPhone = '00000000-0000-0000-0000-000000000013';
const session = 'ABCDEFGH2345';
let checks = 0;
const equal = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
};
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const scalar = async (sql, params = []) => Object.values((await query(sql, params))[0])[0];
const role = async (user = owner, name = 'service_role') => {
    await query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)", [
        user,
        name,
    ]);
};
const heartbeat = async (gps = true, drag = false) =>
    scalar(`SELECT record_pi_anchor_heartbeat('relay-0000000000001',$1,$2,$3,$4,60,50,-20,149)`, [
        session,
        owner,
        gps,
        drag,
    ]);
const claim = (event, phone = firstPhone) => scalar('SELECT claim_anchor_alarm_delivery($1,$2)', [event, phone]);
const current = (delivery, phone = firstPhone) =>
    scalar('SELECT anchor_alarm_delivery_is_current($1,$2,$3)', [delivery.incident_id, phone, delivery.claim_id]);
const finish = (delivery, accepted = true, phone = firstPhone) =>
    scalar('SELECT finish_anchor_alarm_delivery($1,$2,$3,$4)', [
        delivery.incident_id,
        phone,
        delivery.claim_id,
        accepted,
    ]);
const ack = (incident, phone = firstPhone) => scalar('SELECT acknowledge_anchor_alarm($1,$2)', [incident, phone]);
const events = (kind = 'drag') =>
    query('SELECT * FROM anchor_alarm_events WHERE alarm_kind=$1 ORDER BY created_at,id', [kind]);
try {
    await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA vault; CREATE SCHEMA net;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role',true),'') $$;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
        INSERT INTO vault.decrypted_secrets VALUES('supabase_url','https://example.invalid'),('service_role_key','synthetic-test-key');
        CREATE TABLE public.http_calls(body jsonb);
        CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
            BEGIN INSERT INTO public.http_calls VALUES(body); RETURN 1; END; $$;
        CREATE TABLE pi_diary_relays(relay_id text PRIMARY KEY,owner_id uuid,enabled boolean);
        CREATE TABLE anchor_watch_sessions(session_code text PRIMARY KEY,owner_user_id uuid,expires_at timestamptz);
        CREATE TABLE anchor_watch_members(session_code text,user_id uuid,role text,PRIMARY KEY(session_code,user_id));
        CREATE TABLE pi_anchor_sessions(relay_id text PRIMARY KEY,owner_id uuid,session_code text,
            authorised_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
        CREATE TABLE anchor_alarm_tokens(id uuid PRIMARY KEY,session_code text,user_id uuid,device_token text,platform text DEFAULT 'ios');
        ALTER TABLE anchor_alarm_tokens ENABLE ROW LEVEL SECURITY;
        CREATE TABLE anchor_alarm_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_code text,user_id uuid,
            distance_m real NOT NULL,swing_radius_m real NOT NULL,vessel_lat real,vessel_lon real,
            created_at timestamptz DEFAULT now(),notified_at timestamptz,processing_at timestamptz,
            delivery_attempts integer DEFAULT 0,last_error text);
        CREATE FUNCTION is_anchor_watch_member(text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
        INSERT INTO pi_diary_relays VALUES('relay-0000000000001','${owner}',true);
        INSERT INTO anchor_watch_sessions VALUES('${session}','${owner}',now()+interval '2 hours');
        INSERT INTO anchor_watch_members VALUES('${session}','${owner}','shore'),('${session}','${other}','shore');
        INSERT INTO pi_anchor_sessions(relay_id,owner_id,session_code,expires_at)
            VALUES('relay-0000000000001','${owner}','${session}',now()+interval '1 hour');
        INSERT INTO anchor_alarm_tokens(id,session_code,user_id,device_token) VALUES
            ('${firstPhone}','${session}','${owner}','first-phone'),
            ('${secondPhone}','${session}','${other}','second-phone'),
            ('${oldPhone}','${session}','${owner}','old-phone');
    `);
    await role();
    await db.exec(
        await readFile(
            new URL('../supabase/migrations/20260923170000_shore_watch_reliability.sql', import.meta.url),
            'utf8',
        ),
    );
    const migration = await readFile(
        new URL('../supabase/migrations/20260924090000_shore_watch_alarm_reminders.sql', import.meta.url),
        'utf8',
    );
    await db.exec(migration);
    await db.exec(migration);
    equal(
        await scalar('SELECT count(*)::integer FROM anchor_alarm_tokens WHERE supports_reminders'),
        0,
        'legacy tokens remain opted out',
    );
    await query('UPDATE anchor_alarm_tokens SET supports_reminders=true WHERE id IN ($1,$2)', [
        firstPhone,
        secondPhone,
    ]);
    await heartbeat(true, true);
    const incident = (await events())[0];
    equal(incident.incident_id, incident.id, 'first event becomes stable incident');
    equal(await claim(incident.id, oldPhone), null, 'legacy device never claims repeated delivery');
    const initial = await claim(incident.id);
    equal(initial.incident_id, incident.id, 'initial and reminder use same device claim');
    equal(
        new Date(initial.incident_started_at).toISOString(),
        new Date(incident.created_at).toISOString(),
        'push receives immutable incident start',
    );
    equal(await current(initial), true, 'claimed current condition is deliverable');
    equal(await claim(incident.id), null, 'concurrent delivery is suppressed');
    equal(await finish(initial), true, 'accepted APNs completes the claim');
    equal(await claim(incident.id), null, 'accepted delivery waits at least one minute');
    await query("UPDATE anchor_alarm_device_deliveries SET next_due_at=now()-interval '1 second' WHERE token_id=$1", [
        firstPhone,
    ]);
    const repeating = await claim(incident.id);
    equal(!!repeating, true, 'same still-live incident becomes due again');
    equal(await current(initial), false, 'old claim cannot be reused');
    await role(owner, 'authenticated');
    equal(await ack(incident.id), true, 'phone acknowledges its own incident');
    await role();
    equal(await current(repeating), false, 'acknowledgement invalidates an in-flight delivery before APNs');
    await finish(repeating);
    equal(await claim(incident.id), null, 'completion cannot remove acknowledgement');
    equal(!!(await claim(incident.id, secondPhone)), true, 'one phone cannot silence the other');
    await query("UPDATE anchor_alarm_events SET created_at=now()-interval '11 minutes' WHERE id=$1", [incident.id]);
    await heartbeat(true, true);
    const sameCondition = (await events()).find((e) => e.id !== incident.id);
    equal(sameCondition.incident_id, incident.id, 'ten-minute legacy event keeps incident identity');
    equal(await claim(sameCondition.id), null, 'ten-minute event cannot bypass acknowledgement');
    await role(other, 'authenticated');
    equal(await ack(incident.id), false, 'other account cannot acknowledge first phone');
    await role(owner, 'authenticated');
    equal(
        (
            await query('SELECT * FROM list_active_anchor_alarm_incidents($1,$2,$3)', [
                session,
                'first-phone',
                '2000-01-01',
            ])
        ).length,
        0,
        'cutoff cannot include a later incident',
    );
    equal(
        (await query('SELECT * FROM list_active_anchor_alarm_incidents($1,$2,now())', [session, 'second-phone']))
            .length,
        0,
        'read RPC does not expose other phone incidents',
    );
    equal(
        (await query('SELECT * FROM list_active_anchor_alarm_incidents($1,$2,now())', [session, 'first-phone'])).length,
        1,
        'read RPC returns own current incident',
    );
    equal(
        (
            await query("SELECT * FROM list_active_anchor_alarm_incidents($1,$2,now()+interval '1 second')", [
                session,
                'first-phone',
            ])
        ).length,
        0,
        'future cutoff fails closed rather than acknowledging a later incident',
    );
    await role();
    await heartbeat(true, false);
    equal(
        await scalar('SELECT anchor_alarm_incident_is_current($1)', [incident.id]),
        false,
        'recovery stops all repetitions',
    );
    await heartbeat(true, true);
    const newIncident = (await events()).find((e) => e.resolved_at === null);
    equal(newIncident.id !== incident.id, true, 'fresh drag after recovery is a new incident');
    equal(!!(await claim(newIncident.id)), true, 'old acknowledgement never suppresses new drag');
    await query("UPDATE anchor_watch_members SET role='vessel' WHERE user_id=$1", [owner]);
    await role(owner, 'authenticated');
    equal(await ack(newIncident.id), false, 'vessel role cannot ACK shore device');
    await role();
    await query("UPDATE anchor_watch_members SET role='shore' WHERE user_id=$1", [owner]);
    await heartbeat(false, false);
    const gps = (await events('gps_lost'))[0];
    equal(!!(await claim(gps.id)), true, 'live GPS loss supports reminders');
    await query("UPDATE pi_anchor_sessions SET last_heartbeat_at=now()-interval '61 seconds'");
    equal(
        await scalar('SELECT anchor_alarm_incident_is_current($1)', [gps.id]),
        false,
        'stale GPS outage replaced by contact loss, not repeated as fresh GPS',
    );
    await role('', ''); // pg_cron executes as the database owner, without a JWT.
    await db.exec('SELECT check_pi_anchor_watch_health()');
    const contact = (await events('contact_lost'))[0];
    equal(contact.incident_id, contact.id, 'database-owner watchdog without JWT attaches an incident');
    await role();
    equal(!!(await claim(contact.id)), true, 'live contact loss supports reminders');
    await query(
        "UPDATE anchor_alarm_device_deliveries SET processing_until=NULL,next_due_at=now()-interval '1 second'",
    );
    await db.exec('SELECT queue_anchor_alarm_reminders()');
    const calls = await query('SELECT body FROM http_calls');
    equal(calls.length, 1, 'sweeper queues only current condition, once per incident');
    equal(calls[0].body, { record: { id: contact.id }, reminder: true }, 'sweeper requests separate reminder path');
    await query('UPDATE pi_diary_relays SET enabled=false');
    equal(await claim(contact.id), null, 'relay revoke stops repetitions');
    await query('UPDATE pi_diary_relays SET enabled=true');
    await query("UPDATE anchor_watch_sessions SET expires_at=now()-interval '1 second'");
    equal(await claim(contact.id), null, 'session expiry stops repetitions');
    const permissions = (
        await query(`SELECT
        has_function_privilege('anon','acknowledge_anchor_alarm(uuid,uuid)','EXECUTE') AS anon_ack,
        has_function_privilege('authenticated','claim_anchor_alarm_delivery(uuid,uuid)','EXECUTE') AS client_claim,
        has_function_privilege('authenticated','queue_anchor_alarm_reminders()','EXECUTE') AS client_sweep,
        has_function_privilege('authenticated','acknowledge_anchor_alarm(uuid,uuid)','EXECUTE') AS client_ack,
        has_table_privilege('authenticated','anchor_alarm_device_deliveries','UPDATE') AS client_direct_write`)
    )[0];
    equal(
        permissions,
        { anon_ack: false, client_claim: false, client_sweep: false, client_ack: true, client_direct_write: false },
        'RPC and table permission boundaries',
    );
    await query('DELETE FROM anchor_alarm_tokens WHERE id=$1', [firstPhone]);
    equal(
        await scalar('SELECT count(*)::integer FROM anchor_alarm_device_deliveries WHERE token_id=$1', [firstPhone]),
        0,
        'unregistered phone delivery state is removed',
    );
    console.log(
        `Shore Watch reminder PostgreSQL checks passed (${checks}): claims, interval, ACK isolation, recovery, stale/revoked/expired fences, legacy gating and permissions.`,
    );
} finally {
    await db.close();
}
