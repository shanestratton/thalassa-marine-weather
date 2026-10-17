/** Real PostgreSQL17.6 only. No product connection, HTTP extension or push path. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const exact = 'postgresql://postgres:fixture-only-password@127.0.0.1:5432/anchor_area139_test';
if (
    process.env.THALASSA_DISPOSABLE_ANCHOR_AREA_TEST !== '1' ||
    process.env.ANCHOR_AREA_TEST_DATABASE_URL !== exact ||
    !process.env.PG_MODULE_PATH ||
    Object.keys(process.env).some((k) => /^PG/i.test(k) && k !== 'PG_MODULE_PATH' && process.env[k]) ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_SERVICE_ROLE_KEY
)
    throw Error('Only the exact empty localhost anchor_area139_test fixture is allowed.');
const pg = await import(pathToFileURL(process.env.PG_MODULE_PATH).href);
const Pool = pg.Pool ?? pg.default.Pool;
const pool = new Pool({
    connectionString: exact,
    max: 18,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    query_timeout: 18000,
    application_name: 'anchor-area139-fixture',
});
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const migrationPath = '../migrations/20261017002338_anchor_safe_area.sql';
const migration = await read(migrationPath),
    hash = (v) => createHash('sha256').update(v).digest('hex');
const owner = '10000000-0000-4000-8000-000000000001',
    other = '10000000-0000-4000-8000-000000000002';
const relay = 'fictional-anchor-relay139',
    code = 'Anchor139001',
    otherCode = 'Anchor139002';
const revA = '20000000-0000-4000-8000-000000000001',
    revB = '20000000-0000-4000-8000-000000000002',
    revC = '20000000-0000-4000-8000-000000000003';
const circle = { version: 1, frame: { latitude: -27, longitude: 153, radiusM: 60 }, zone: null };
const areaA = {
    ...circle,
    zone: {
        version: 1,
        kind: 'wedges',
        anchor: { latitude: -27, longitude: 153 },
        exclusions: [{ startDeg: 0, sweepDeg: 45 }],
    },
};
const areaB = { ...circle, frame: { ...circle.frame, radiusM: 65 }, zone: null };
let checks = 0;
const races = [];
const eq = (a, b, label) => {
    assert.deepEqual(a, b, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await pool.query(sql, args)).rows[0] ?? {})[0];
async function connect(role = 'service_role') {
    const c = await pool.connect();
    await c.query("SELECT set_config('request.jwt.claim.role',$1,false)", [role]);
    await c.query(`SET ROLE ${role}`);
    return c;
}
async function done(c) {
    try {
        await c.query('ROLLBACK');
        await c.query('RESET ROLE');
    } finally {
        c.release();
    }
}
async function service(sql, args = []) {
    const c = await connect();
    try {
        return Object.values((await c.query(sql, args)).rows[0] ?? {})[0];
    } finally {
        await done(c);
    }
}
const snapshot = () =>
    scalar(
        "SELECT jsonb_build_object('owner_id',owner_id,'session_code',session_code,'safe_area',safe_area,'safe_area_revision',safe_area_revision,'safe_area_vessel_id',safe_area_vessel_id) FROM pi_anchor_sessions WHERE relay_id=$1",
        [relay],
    );
const authSql = 'SELECT public.authorise_pi_anchor_area($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)';
const authArgs = (
    expected,
    area = null,
    revision = null,
    vessel = null,
    explicit = false,
    who = owner,
    session = code,
) => [
    relay,
    who,
    session,
    expected === null ? null : JSON.stringify(expected),
    explicit,
    area === null ? null : JSON.stringify(area),
    revision,
    vessel,
];
const authorise = (
    expected,
    area = null,
    revision = null,
    vessel = null,
    explicit = false,
    who = owner,
    session = code,
) => service(authSql, authArgs(expected, area, revision, vessel, explicit, who, session));
const beatSql = 'SELECT public.record_pi_anchor_area_heartbeat($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)';
const beatArgs = (s, drag = false, gps = true) => [
    relay,
    s.session_code,
    s.owner_id,
    s.safe_area === null ? null : JSON.stringify(s.safe_area),
    s.safe_area_revision,
    s.safe_area_vessel_id,
    gps,
    drag,
    70,
    s.safe_area?.frame.radiusM ?? 60,
    -27,
    153,
];
const beat = (s, drag = false, gps = true) => service(beatSql, beatArgs(s, drag, gps));
const stopSql = 'SELECT public.stop_pi_anchor_area($1,$2,$3,$4::jsonb)';
const stop = (s) => service(stopSql, [relay, s.session_code, s.owner_id, JSON.stringify(s)]);
async function denied(sql, args = [], role = 'authenticated', state = '42501') {
    const c = await connect(role);
    try {
        await assert.rejects(c.query(sql, args), (e) => e.code === state);
        checks++;
    } finally {
        await done(c);
    }
}
async function invalid(patch, label) {
    const values = { safe_area: circle, safe_area_revision: revA, safe_area_vessel_id: 'boat-a', ...patch };
    await assert.rejects(
        service(
            'UPDATE pi_anchor_sessions SET safe_area=$2::jsonb,safe_area_revision=$3,safe_area_vessel_id=$4 WHERE relay_id=$1 RETURNING true',
            [
                relay,
                values.safe_area === null ? null : JSON.stringify(values.safe_area),
                values.safe_area_revision,
                values.safe_area_vessel_id,
            ],
        ),
        (e) => e.code === '23514',
        label,
    );
    checks++;
}
async function blocked(waiter, holder) {
    const deadline = Date.now() + 5000;
    do {
        const ids = await scalar('SELECT pg_blocking_pids($1)', [waiter]);
        if (ids.includes(holder)) {
            checks++;
            return;
        }
        await new Promise((r) => setTimeout(r, 10));
    } while (Date.now() < deadline);
    throw Error('Actual competing transaction was never observed blocked');
}
async function editWins(label, request, expectedResult) {
    const before = await snapshot(),
        c = await connect(),
        d = await connect();
    try {
        await c.query('BEGIN');
        const changed = (await c.query(authSql, authArgs(before, areaB, revB, 'boat-b', true))).rows[0]
            .authorise_pi_anchor_area;
        eq(changed.authorised, true, label + ' edit accepted before commit');
        const pending = d.query(request.sql, request.args(before));
        void pending.catch(() => {});
        await blocked(d.processID, c.processID);
        await c.query('COMMIT');
        const result = Object.values((await pending).rows[0])[0];
        expectedResult(result);
        eq((await snapshot()).safe_area_revision, revB, label + ' current B retained');
        races.push({ label, blocked: true, completed: true, deadlock: false });
    } finally {
        await done(c);
        await done(d);
    }
}
async function seedA() {
    await pool.query('DELETE FROM pi_anchor_sessions');
    await pool.query('DELETE FROM anchor_alarm_events');
    eq((await authorise(null, areaA, revA, 'boat-a', true)).authorised, true, 'seed A');
    return snapshot();
}
try {
    const pre = await scalar(
        "SELECT jsonb_build_object('database',current_database(),'role',current_user,'version',current_setting('server_version_num'),'relations',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')),'roles',(SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')))",
    );
    eq(
        pre,
        { database: 'anchor_area139_test', role: 'postgres', version: '170006', relations: 0, roles: 0 },
        'empty real PostgreSQL17.6 required',
    );
    await pool.query(await read('anchor-safe-area-base.sql'));
    await pool.query(await read('../migrations/20260829090000_anchor_relay_sessions.sql'));
    await pool.query(`ALTER TABLE pi_anchor_sessions ADD COLUMN last_heartbeat_at timestamptz,ADD COLUMN gps_available boolean NOT NULL DEFAULT false,ADD COLUMN is_dragging boolean NOT NULL DEFAULT false,ADD COLUMN contact_alarm_at timestamptz,ADD COLUMN gps_alarm_at timestamptz,ADD COLUMN expiry_alarm_at timestamptz;
        ALTER TABLE pi_anchor_sessions DROP CONSTRAINT pi_anchor_sessions_expiry_bounded;
        ALTER TABLE pi_anchor_sessions ADD CONSTRAINT pi_anchor_sessions_expiry_bounded CHECK(expires_at>authorised_at AND expires_at<=authorised_at+interval '7 days');
        GRANT SELECT,INSERT,UPDATE,DELETE ON pi_anchor_sessions TO service_role;`);
    const old = await read('../migrations/20261010130000_anchor_watch_keeper_heartbeat.sql');
    const original = old.slice(
        old.indexOf('CREATE OR REPLACE FUNCTION public.record_pi_anchor_heartbeat('),
        old.indexOf('-- A server watchdog is necessary:'),
    );
    assert.ok(original.includes('GRANT EXECUTE ON FUNCTION public.record_pi_anchor_heartbeat'));
    checks++;
    await pool.query(original);
    const heartbeatDef = await scalar(
        "SELECT pg_get_functiondef('public.record_pi_anchor_heartbeat(text,text,uuid,boolean,boolean,real,real,real,real)'::regprocedure)",
    );
    await pool.query('INSERT INTO auth.users VALUES($1),($2)', [owner, other]);
    await pool.query('INSERT INTO pi_diary_relays VALUES($1,$2,true)', [relay, owner]);
    await pool.query(
        "INSERT INTO anchor_watch_sessions VALUES($1,$3,now()+interval '24 hours'),($2,$3,now()+interval '24 hours')",
        [code, otherCode, owner],
    );
    await service(
        "INSERT INTO pi_anchor_sessions(relay_id,owner_id,session_code,expires_at) VALUES($1,$2,$3,now()+interval '5 hours') RETURNING true",
        [relay, owner, code],
    );
    await pool.query(migration);
    eq((await snapshot()).safe_area, null, 'pre-existing old circle remains legacy null');
    eq(
        await scalar(
            "SELECT pg_get_functiondef('public.record_pi_anchor_heartbeat(text,text,uuid,boolean,boolean,real,real,real,real)'::regprocedure)",
        ),
        heartbeatDef,
        'original heartbeat body and signature unchanged',
    );
    eq(
        await scalar("SELECT relrowsecurity FROM pg_class WHERE oid='pi_anchor_sessions'::regclass"),
        true,
        'RLS remains enabled',
    );
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='pi_anchor_sessions'",
        ),
        0,
        'no new permissive client policy',
    );
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('authorise_pi_anchor_area','record_pi_anchor_area_heartbeat','stop_pi_anchor_area') AND NOT prosecdef",
        ),
        3,
        'all new RPCs security invoker',
    );
    for (const role of ['anon', 'authenticated']) {
        await denied('SELECT * FROM pi_anchor_sessions', [], role);
        await denied('UPDATE pi_anchor_sessions SET safe_area=NULL', [], role);
        await denied(
            "INSERT INTO pi_anchor_sessions(relay_id,owner_id,session_code,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
            [relay, owner, code],
            role,
        );
        await denied('DELETE FROM pi_anchor_sessions', [], role);
        await denied(authSql, authArgs(await snapshot()), role);
        await denied(beatSql, beatArgs(await snapshot()), role);
        await denied(stopSql, [relay, code, owner, JSON.stringify(await snapshot())], role);
    }
    eq((await authorise(await snapshot())).authorised, true, 'legacy renewal accepted');
    eq((await beat(await snapshot())) !== null, true, 'legacy circle heartbeat accepted');
    eq(await authorise(await snapshot(), null, null, null, false, other), null, 'foreign owner cannot authorise');
    const a = await seedA();
    eq(
        await authorise(await snapshot(), areaB, revA, 'boat-a', true),
        { conflict: true },
        'changed area cannot reuse old edit UUID',
    );
    for (const patch of [
        { safe_area_revision: revB },
        { safe_area_vessel_id: 'other' },
        { safe_area: { ...areaA, frame: { ...circle.frame, radiusM: 61 } } },
        { safe_area: circle },
    ]) {
        eq(await beat({ ...a, ...patch }, true), null, 'stale/moved/resized/different-vessel report refused');
    }
    eq(await scalar('SELECT count(*)::int FROM anchor_alarm_events'), 0, 'refused reports produce no alarm');
    eq(
        await scalar('SELECT last_heartbeat_at FROM pi_anchor_sessions'),
        null,
        'refused reports do not renew heartbeat',
    );
    eq((await beat(a, true)) !== null, true, 'current A calls actual existing drag path');
    eq(
        await scalar("SELECT count(*)::int FROM anchor_alarm_events WHERE alarm_kind='drag'"),
        1,
        'actual drag insert once',
    );
    eq((await beat(a, false, false)) !== null, true, 'exact no-fix status accepted');
    eq(
        await scalar("SELECT count(*)::int FROM anchor_alarm_events WHERE alarm_kind='gps_lost'"),
        1,
        'actual GPS-lost path',
    );
    await invalid({ safe_area: null }, 'orphan revision/vessel cannot masquerade as legacy');
    for (const patch of [
        { safe_area: [] },
        { safe_area: { ...circle, extra: 1 } },
        { safe_area: { ...circle, version: 2 } },
        { safe_area: { ...circle, frame: null } },
        { safe_area_revision: null },
        { safe_area_revision: 'old' },
        { safe_area_vessel_id: '' },
        { safe_area_vessel_id: 'x'.repeat(129) },
        { safe_area: { ...circle, zone: { padding: 'x'.repeat(8192) } } },
    ])
        await invalid(patch, 'envelope bound');
    eq(
        (await authorise(await snapshot(), circle, revC, null, true)).authorised,
        true,
        'clear requires explicit framed circle and new UUID',
    );
    eq((await snapshot()).safe_area, circle, 'explicit clear stores framed circle, not SQL null');
    eq((await snapshot()).safe_area_vessel_id, null, 'explicit null vessel retained');
    eq(await beat(a, true), null, 'old custom report cannot renew cleared circle');
    eq((await beat(await snapshot())) !== null, true, 'cleared circle exact report accepted');
    await seedA();
    await editWins('B beats stale A heartbeat', { sql: beatSql, args: (s) => beatArgs(s, true) }, (r) =>
        eq(r, null, 'blocked stale A heartbeat refused'),
    );
    eq(await scalar('SELECT count(*)::int FROM anchor_alarm_events'), 0, 'concurrent stale heartbeat no alarm');
    eq(await scalar('SELECT last_heartbeat_at FROM pi_anchor_sessions'), null, 'concurrent stale heartbeat no renewal');
    await seedA();
    await editWins('B beats legacy renewal', { sql: authSql, args: (s) => authArgs(s) }, (r) => {
        eq(r.authorised, true, 'legacy renewal still succeeds');
        eq(r.safe_area_revision, revB, 'legacy response echoes current B');
    });
    await seedA();
    await editWins(
        'B beats stale explicit clear',
        { sql: authSql, args: (s) => authArgs(s, circle, revC, null, true) },
        (r) => eq(r, { conflict: true }, 'stale clear cannot overwrite B'),
    );
    await seedA();
    await editWins('B beats stale stop', { sql: stopSql, args: (s) => [relay, code, owner, JSON.stringify(s)] }, (r) =>
        eq(r, false, 'stale stop cannot delete B'),
    );
    const current = await snapshot();
    eq(await stop({ ...current, owner_id: other }), false, 'foreign owner cannot stop');
    eq(await stop(current), true, 'current exact stop accepted');
    eq(await stop(current), true, 'already stopped is idempotent');
    eq(await scalar('SELECT count(*)::int FROM pi_anchor_sessions'), 0, 'stop removes only exact binding');
    // Opposite order: heartbeat holds binding first, then B must wait. This
    // proves a real serial order rather than two unchecked parallel successes.
    const first = await seedA(),
        c = await connect(),
        d = await connect();
    try {
        await c.query('BEGIN');
        eq(
            Object.values(
                (
                    await c.query('SELECT public.record_pi_anchor_heartbeat($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
                        relay,
                        code,
                        owner,
                        true,
                        false,
                        0,
                        60,
                        -27,
                        153,
                    ])
                ).rows[0],
            )[0] !== null,
            true,
            'legacy heartbeat wins first',
        );
        const pending = d.query(authSql, authArgs(first, areaB, revB, 'boat-b', true));
        void pending.catch(() => {});
        await blocked(d.processID, c.processID);
        await c.query('COMMIT');
        eq(Object.values((await pending).rows[0])[0].authorised, true, 'later B adopts after heartbeat commit');
        eq((await snapshot()).safe_area_revision, revB, 'B current after ordered acceptance');
        races.push({ label: 'original legacy heartbeat before B', blocked: true, completed: true, deadlock: false });
    } finally {
        await done(c);
        await done(d);
    }
    await pool.query('INSERT INTO fixture_tombstones VALUES($1)', [owner]);
    await assert.rejects(authorise(await snapshot()), (e) => e.code === '23514');
    checks++;
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_trigger WHERE tgrelid='pi_anchor_sessions'::regclass AND tgname='account_deletion_write_fence'",
        ),
        1,
        'original write fence retained',
    );
    console.log(
        JSON.stringify({
            status: 'PASS',
            checks,
            races,
            postgres: '17.6',
            migration: migrationPath,
            migrationSha256: hash(migration),
            originalHeartbeatSha256: hash(heartbeatDef),
            productConnections: false,
            notificationsSent: 0,
        }),
    );
} finally {
    await pool.end();
}
