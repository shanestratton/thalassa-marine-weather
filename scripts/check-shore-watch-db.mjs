/** Isolated PostgreSQL exercise. Never connects to or changes a Supabase project.
 * PGLITE_MODULE_PATH=/tmp/.../pglite/dist/index.js node scripts/check-shore-watch-db.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001';
try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA extensions;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${owner}'::uuid $$;
      SELECT set_config('request.jwt.claim.role','service_role',false);
      CREATE TABLE pi_diary_relays(relay_id text PRIMARY KEY,owner_id uuid,enabled boolean);
      CREATE TABLE anchor_watch_sessions(session_code text PRIMARY KEY,owner_user_id uuid,expires_at timestamptz);
      CREATE TABLE pi_anchor_sessions(relay_id text PRIMARY KEY,owner_id uuid,session_code text,
          authorised_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
          CHECK(expires_at > authorised_at AND expires_at <= authorised_at + interval '48 hours'));
      CREATE TABLE anchor_alarm_tokens(session_code text,user_id uuid,device_token text);
      ALTER TABLE anchor_alarm_tokens ENABLE ROW LEVEL SECURITY;
      CREATE TABLE anchor_alarm_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_code text,user_id uuid,
          distance_m real NOT NULL,swing_radius_m real NOT NULL,vessel_lat real,vessel_lon real,
          created_at timestamptz DEFAULT now(),notified_at timestamptz,processing_at timestamptz,
          delivery_attempts integer DEFAULT 0,last_error text);
      CREATE FUNCTION is_anchor_watch_member(text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      INSERT INTO pi_diary_relays VALUES('relay-0000000000001','${owner}',true);
      INSERT INTO anchor_watch_sessions VALUES('ABCDEFGH2345','${owner}',now()+interval '2 hours');
      INSERT INTO pi_anchor_sessions(relay_id,owner_id,session_code,expires_at)
          VALUES('relay-0000000000001','${owner}','ABCDEFGH2345',now()+interval '1 hour');
    `);
    const migration = await readFile(
        new URL('../supabase/migrations/20260923170000_shore_watch_reliability.sql', import.meta.url),
        'utf8',
    );
    await db.exec(migration);
    await db.exec(migration); // repeat-safe installation, without creating cron jobs
    const call = async (gps = true, drag = false, code = 'ABCDEFGH2345') =>
        (
            await db.query(
                `SELECT record_pi_anchor_heartbeat('relay-0000000000001',$1,$2,$3,$4,60,50,-20,149) AS lease`,
                [code, owner, gps, drag],
            )
        ).rows[0].lease;
    const lease = await call();
    assert.equal(lease.expires_at, lease.session_expires_at, 'lease capped to existing hard expiry');
    assert.equal(await call(true, false, 'WRONGCODE234'), null, 'wrong session cannot renew');
    await call(true, true);
    await call(true, true);
    const count = async (kind) =>
        Number((await db.query('SELECT count(*) n FROM anchor_alarm_events WHERE alarm_kind=$1', [kind])).rows[0].n);
    assert.equal(await count('drag'), 1, 'drag throttled atomically');
    await call(false, false);
    await call(false, false);
    assert.equal(await count('gps_lost'), 1, 'GPS outage single event');
    await call(true, false);
    assert.equal(
        Number((await db.query('SELECT count(*) n FROM anchor_alarm_events WHERE resolved_at IS NULL')).rows[0].n),
        0,
        'fresh safe heartbeat resolves GPS and drag',
    );
    await call(true, true);
    assert.equal(await count('drag'), 2, 'a recovered/new drag is not throttled by a resolved event');
    await db.exec(
        "UPDATE pi_anchor_sessions SET last_heartbeat_at=now()-interval '61 seconds'; SELECT check_pi_anchor_watch_health(); SELECT check_pi_anchor_watch_health();",
    );
    assert.equal(await count('contact_lost'), 1, 'one contact alert per outage');
    await call(true, false);
    assert.equal(
        Number(
            (
                await db.query(
                    "SELECT count(*) n FROM anchor_alarm_events WHERE alarm_kind='contact_lost' AND resolved_at IS NULL",
                )
            ).rows[0].n,
        ),
        0,
    );
    await db.exec(
        "UPDATE anchor_watch_sessions SET expires_at=now()+interval '10 minutes'; SELECT check_pi_anchor_watch_health(); SELECT check_pi_anchor_watch_health();",
    );
    assert.equal(await count('session_expiring'), 1, 'one finite-session expiry warning');
    await db.exec('UPDATE pi_diary_relays SET enabled=false');
    assert.equal(await call(), null, 'revoked relay cannot renew');
    await db.exec(
        "UPDATE pi_diary_relays SET enabled=true; UPDATE anchor_watch_sessions SET expires_at=now()-interval '1 second'",
    );
    assert.equal(await call(), null, 'hard-expired session cannot renew');
    await db.exec(
        "UPDATE anchor_watch_sessions SET expires_at=now()+interval '1 hour'; UPDATE pi_anchor_sessions SET authorised_at=now()-interval '2 hours',expires_at=now()-interval '1 second'",
    );
    assert.equal(await call(), null, 'expired relay lease cannot revive itself');
    const permissions = (
        await db.query(`SELECT has_function_privilege('anon','check_pi_anchor_watch_health()','EXECUTE') anon,
      has_function_privilege('authenticated','check_pi_anchor_watch_health()','EXECUTE') client,
      has_function_privilege('service_role','check_pi_anchor_watch_health()','EXECUTE') service`)
    ).rows[0];
    assert.deepEqual(permissions, { anon: false, client: false, service: true });
    console.log(
        'Shore Watch PostgreSQL checks passed: idempotency, auth fences, bounded renewal, alarm recovery, watchdog and expiry.',
    );
} finally {
    await db.close();
}
