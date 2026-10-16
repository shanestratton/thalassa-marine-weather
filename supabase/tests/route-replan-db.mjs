/** Disposable syntax/ownership/CAS proof. Never accepts a product database. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const owner = '10000000-0000-4000-8000-000000000001',
    other = '10000000-0000-4000-8000-000000000002';
const boat = '20000000-0000-4000-8000-000000000001',
    otherBoat = '20000000-0000-4000-8000-000000000002';
const voyage = '30000000-0000-4000-8000-000000000001',
    session = '40000000-0000-4000-8000-000000000001';
const otherSession = '40000000-0000-4000-8000-000000000002';
const originalStamp = '2026-10-16T00:00:00.000Z',
    geometry = '[[150,-30],[150.1,-30]]';
const geometryHash = createHash('sha256').update(geometry).digest('hex');
const migration = await readFile(
    new URL('../held-migrations/20261016182725_reviewed_route_replan.sql', import.meta.url),
    'utf8',
);
let db, Pool, pool;
if (process.env.PGLITE_MODULE_PATH) {
    const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
    db = new PGlite();
} else {
    if (process.env.THALASSA_DISPOSABLE_REPLAN_TEST !== '1' || !process.env.PG_MODULE_PATH || !process.env.DATABASE_URL)
        throw Error('Explicit isolated PGlite or opted-in local disposable PostgreSQL required');
    const url = new URL(process.env.DATABASE_URL);
    if (
        url.protocol !== 'postgresql:' ||
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/route_replan138_test'
    )
        throw Error('Refusing a non-fixture database');
    const pg = await import(pathToFileURL(process.env.PG_MODULE_PATH).href);
    Pool = pg.Pool ?? pg.default.Pool;
    pool = new Pool({ connectionString: url.href, max: 18 });
    db = await pool.connect();
    db.exec = (sql) => db.query(sql);
}
let checks = 0;
const eq = (actual, want, label) => {
    assert.deepEqual(actual, want, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
async function as(uid, sql, args = [], role = 'authenticated') {
    await db.exec(
        `RESET ROLE;SET ROLE ${role};SELECT set_config('request.jwt.claim.sub','${uid ?? ''}',false);SELECT set_config('request.jwt.claim.session_id','${uid === other ? otherSession : session}',false);`,
    );
    try {
        return await scalar(sql, args);
    } finally {
        await db.exec('RESET ROLE');
    }
}
const signature =
    'public.accept_reviewed_route_replan(uuid,uuid,uuid,text,text,timestamptz,text,text,text,text,timestamptz,timestamptz,text,integer,text,jsonb,text)';
const sql =
    'SELECT public.accept_reviewed_route_replan(' + Array.from({ length: 17 }, (_, i) => `$${i + 1}`).join(',') + ')';
const clock = new Date().toISOString();
const args = (patch = {}) =>
    Object.values({
        request: randomUUID(),
        boat,
        voyage,
        expected: 'old',
        device: 'dev-original',
        stamp: originalStamp,
        plan: 'new',
        writer: 'dev-reviewed',
        label: 'Fictional review device',
        session,
        reviewedAt: clock,
        fixAt: clock,
        source: 'fictional-model:valid-clock',
        rows: 2,
        geometryHash,
        authority: { mode: 'confirm', deviceId: null, claimedAt: null },
        expectedGeometryHash: geometryHash,
        ...patch,
    });
const call = (patch = {}) => as(owner, sql, args(patch));
async function resetLink() {
    await db.exec(
        `ALTER TABLE public.voyage_plan_links DISABLE TRIGGER voyage_plan_links_touch;UPDATE public.voyage_plan_links SET plan_voyage_id='old',device_id='dev-original',updated_at='${originalStamp}';ALTER TABLE public.voyage_plan_links ENABLE TRIGGER voyage_plan_links_touch;DELETE FROM public.route_replan_receipts;`,
    );
}
try {
    await db.exec(`
        CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA auth;
        CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;
        GRANT USAGE ON SCHEMA auth TO authenticated,anon;
        GRANT EXECUTE ON FUNCTION auth.uid(),auth.jwt() TO authenticated,anon;
        CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid,archived_at timestamptz);
        CREATE TABLE public.user_active_vessels(user_id uuid PRIMARY KEY,boat_id uuid);
        CREATE TABLE public.voyages(id uuid PRIMARY KEY,user_id uuid,boat_id uuid,status text);
        CREATE TABLE public.user_settings(user_id uuid PRIMARY KEY,settings jsonb);
        CREATE TABLE public.ship_logs(user_id uuid,boat_id uuid,voyage_id text,source text,notes text);
        CREATE INDEX ON public.ship_logs(user_id,voyage_id);
        CREATE TABLE public.voyage_plan_links(user_id uuid,voyage_id text,plan_voyage_id text,device_id text,device_name text,updated_at timestamptz,PRIMARY KEY(user_id,voyage_id));
        INSERT INTO auth.users VALUES('${owner}'),('${other}');
        INSERT INTO auth.sessions VALUES('${session}','${owner}'),('${otherSession}','${other}');
        INSERT INTO public.boats VALUES('${boat}','${owner}',NULL),('${otherBoat}','${other}',NULL);
        INSERT INTO public.user_active_vessels VALUES('${owner}','${boat}');
        INSERT INTO public.user_settings VALUES('${owner}','{}');
        INSERT INTO public.voyages VALUES('${voyage}','${owner}','${boat}','active');
        INSERT INTO public.voyage_plan_links VALUES('${owner}','${voyage}','old','dev-original','Original fictional device','${originalStamp}');
    `);
    for (const plan of ['new', 'old'])
        for (let i = 0; i < 2; i++)
            await db.query('INSERT INTO public.ship_logs VALUES($1,$2,$3,$4,$5)', [
                owner,
                boat,
                plan,
                'planned_route',
                i === 0 ? '__route_geometry__::' + geometry + '\nFictional route' : null,
            ]);
    await db.exec(
        await readFile(
            new URL('../migrations/20260908150000_voyage_plan_links_author_stamp.sql', import.meta.url),
            'utf8',
        ),
    );
    await db.exec(migration);
    eq(await scalar("SELECT has_function_privilege('anon',$1,'execute')", [signature]), false, 'anonymous RPC denied');
    eq(
        await scalar(
            "SELECT has_table_privilege('authenticated','public.route_replan_receipts','insert,update,delete')",
        ),
        false,
        'no direct receipt writes',
    );
    eq(
        await scalar("SELECT relrowsecurity FROM pg_class WHERE oid='public.route_replan_receipts'::regclass"),
        true,
        'receipt RLS',
    );
    eq((await call({ rows: 3 })).reason, 'plan-not-ready', 'partial plan refused');
    await db.query("UPDATE public.ship_logs SET boat_id=$1 WHERE voyage_id='new'", [otherBoat]);
    eq((await call()).reason, 'plan-not-ready', 'saved rows must belong to the reviewed boat');
    await db.query("UPDATE public.ship_logs SET boat_id=$1 WHERE voyage_id='new'", [boat]);
    await db.exec(
        `INSERT INTO public.ship_logs SELECT '${owner}','${boat}','overflow','planned_route',NULL FROM generate_series(1,259)`,
    );
    eq((await call({ plan: 'overflow', rows: 258 })).reason, 'plan-not-ready', 'bounded saved-row overflow refused');
    await db.exec("DELETE FROM public.ship_logs WHERE voyage_id='overflow'");
    eq((await call({ geometryHash: '0'.repeat(64) })).reason, 'plan-not-ready', 'different saved geometry refused');
    eq(
        (await call({ expectedGeometryHash: '0'.repeat(64) })).reason,
        'original-route-changed',
        'different original route refused even with the current link ID',
    );
    eq((await call({ stamp: '2026-10-15T00:00:00Z' })).reason, 'link-changed', 'stale stamp refused');
    eq((await call({ device: 'dev-other' })).reason, 'link-changed', 'different link author refused');
    await db.query('UPDATE public.user_settings SET settings=$1', [
        { routeAuthority: 'skipper', skipperDevice: { deviceId: 'dev-other', claimedAt: clock } },
    ]);
    eq((await call()).reason, 'authority-changed', 'cloud authority change refused');
    eq(
        (await call({ authority: { mode: 'skipper', deviceId: 'dev-other', claimedAt: clock } })).reason,
        'authority-changed',
        'non-skipper cannot replace even with current stamp',
    );
    await db.exec("UPDATE public.user_settings SET settings='{}'");
    eq(
        (await call({ reviewedAt: '2020-01-01T00:00:00Z', fixAt: '2020-01-01T00:00:00Z' })).reason,
        'review-expired',
        'old review refused',
    );
    eq((await call({ fixAt: '2020-01-01T00:00:00Z' })).reason, 'review-expired', 'old fix refused');
    eq(
        (await as(other, sql, args({ session: otherSession }))).reason,
        'context-changed',
        'foreign account cannot replace',
    );
    eq(
        await as(other, 'SELECT count(*)::int FROM public.route_replan_receipts'),
        0,
        'other owner cannot read receipts',
    );
    await assert.rejects(call({ session: randomUUID() }), /session/i);
    checks++;
    await db.exec('DELETE FROM auth.sessions');
    await assert.rejects(call(), /session/i);
    checks++;
    await db.exec(
        `INSERT INTO auth.sessions VALUES('${session}','${owner}');UPDATE public.user_active_vessels SET boat_id='${otherBoat}';`,
    );
    eq((await call()).reason, 'context-changed', 'selection race refused');
    await db.exec(
        `UPDATE public.user_active_vessels SET boat_id='${boat}';UPDATE public.voyages SET status='completed';`,
    );
    eq((await call()).reason, 'context-changed', 'completed voyage refused');
    await db.exec("UPDATE public.voyages SET status='active'");
    eq(
        await scalar('SELECT plan_voyage_id FROM public.voyage_plan_links'),
        'old',
        'every refusal preserved old public link',
    );
    eq(
        (await call({ reviewedAt: new Date(Date.now() - 240000).toISOString() })).applied,
        true,
        'a four-minute candidate still requires a current fresh fix',
    );
    await resetLink();
    const request = randomUUID(),
        payload = args({ request });
    eq((await as(owner, sql, payload)).applied, true, 'reviewed replacement applied');
    eq((await as(owner, sql, payload)).repeated, true, 'same request is idempotent');
    eq(await scalar('SELECT count(*)::int FROM public.route_replan_receipts'), 1, 'one logical receipt');
    await assert.rejects(as(owner, sql, args({ request, source: 'changed-source' })), /identity conflict/i);
    checks++;
    await db.exec("UPDATE public.voyage_plan_links SET device_id='dev-newer',updated_at=clock_timestamp()");
    eq((await as(owner, sql, payload)).reason, 'link-changed', 'old repeated request cannot override later author');
    eq(await scalar('SELECT device_id FROM public.voyage_plan_links'), 'dev-newer', 'later link remains valid');
    await resetLink();
    await db.exec(
        `INSERT INTO public.route_replan_receipts SELECT '${owner}',md5('fixture:'||n)::uuid,'${boat}','${voyage}','${session}','fixture','old','dev-original','2020-01-01'::timestamptz FROM generate_series(1,512) n`,
    );
    eq((await call()).applied, true, 'new reviewed request at the receipt quota');
    eq(await scalar('SELECT count(*)::int FROM public.route_replan_receipts'), 512, 'receipt ledger remains bounded');
    if (Pool) {
        // These are genuinely independent PostgreSQL sessions. PGlite does
        // not establish concurrency and deliberately does not run this lane.
        await resetLink();
        const race = async (shared) =>
            Promise.all(
                Array.from({ length: 16 }, async () => {
                    const client = await pool.connect();
                    try {
                        await client.query(
                            `SET ROLE authenticated;SELECT set_config('request.jwt.claim.sub','${owner}',false);SELECT set_config('request.jwt.claim.session_id','${session}',false);`,
                        );
                        return (await client.query(sql, args({ request: shared ?? randomUUID() }))).rows[0]
                            .accept_reviewed_route_replan;
                    } finally {
                        await client.query('RESET ROLE');
                        client.release();
                    }
                }),
            );
        const distinct = await race();
        eq(distinct.filter((r) => r.applied).length, 1, 'sixteen distinct sessions only one replacement');
        eq(
            distinct.filter((r) => r.reason === 'link-changed').length,
            15,
            'fifteen stale competing replacements refused',
        );
        await resetLink();
        const same = await race(randomUUID());
        eq(same.filter((r) => r.applied).length, 16, 'sixteen retries of one request acknowledged');
        eq(same.filter((r) => r.repeated === false).length, 1, 'sixteen same-request sessions one actual write');
        eq(
            await scalar('SELECT count(*)::int FROM public.route_replan_receipts'),
            1,
            'one receipt after real concurrency',
        );
    }
    process.stdout.write(
        JSON.stringify({
            checks,
            engine: Pool ? 'PostgreSQL16-session races' : 'PGlite sequential only',
            migrationSha256: createHash('sha256').update(migration).digest('hex'),
            productionMutations: false,
        }) + '\n',
    );
} finally {
    if (Pool) {
        db.release();
        await pool.end();
    } else await db.close();
}
