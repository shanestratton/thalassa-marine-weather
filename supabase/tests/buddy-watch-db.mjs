/** Disposable ACL/CAS/quota proof. No real AIS/provider/push connection.
 * Explicit localhost PostgreSQL mode also exercises PostGIS and real races. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { evaluateBuddy, emptyBuddyState } from '../../utils/buddyWatch.ts';
const postgres = process.env.THALASSA_DISPOSABLE_BUDDY_TEST === '1';
let pool, db;
if (postgres) {
    const url = new URL(process.env.BUDDY_TEST_DATABASE_URL ?? 'http://invalid');
    if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/buddy137_test' ||
        !process.env.PG_MODULE_PATH
    ) {
        throw new Error('Only an explicit empty localhost buddy137_test database is allowed');
    }
    const pg = await import(pathToFileURL(process.env.PG_MODULE_PATH).href);
    const Pool = pg.Pool ?? pg.default.Pool;
    pool = new Pool({ connectionString: url.href, max: 18, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    const client = await pool.connect();
    db = {
        exec: (sql) => client.query(sql),
        query: (sql, args) => client.query(sql, args),
        close: async () => {
            client.release();
            await pool.end();
        },
    };
    const existing = await client.query(
        "SELECT count(*)::integer n FROM pg_tables WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema'",
    );
    if (existing.rows[0].n !== 0) {
        await db.close();
        throw new Error('Refusing a nonempty fixture database');
    }
    await db.exec(
        'CREATE SCHEMA extensions;CREATE EXTENSION postgis WITH SCHEMA extensions;GRANT USAGE ON SCHEMA extensions TO PUBLIC',
    );
} else {
    if (!process.env.PGLITE_MODULE_PATH) throw new Error('Outside-repository isolated PGlite required');
    const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
    db = new PGlite();
}
const locationType = postgres ? 'extensions.geography(Point,4326)' : 'point';
const origin = postgres
    ? 'extensions.ST_SetSRID(extensions.ST_MakePoint(0,0),4326)::extensions.geography'
    : 'point(0,0)';
const owner = '10000000-0000-4000-8000-000000000001',
    other = '10000000-0000-4000-8000-000000000002',
    boat = '20000000-0000-4000-8000-000000000001',
    foreignBoat = '20000000-0000-4000-8000-000000000002';
let checks = 0;
const eq = (a, b, label) => {
    assert.deepEqual(a, b, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
async function as(role, uid, sql, args = []) {
    await db.exec(`RESET ROLE;SELECT set_config('request.jwt.claim.sub','${uid ?? ''}',false);SET ROLE ${role};`);
    try {
        return await scalar(sql, args);
    } finally {
        await db.exec('RESET ROLE');
    }
}
const user = (sql, args = []) => as('authenticated', owner, sql, args),
    service = (sql, args = []) => as('service_role', null, sql, args);
const config = (mmsi = 234567890, enabled = false) => ({ mmsi, label: 'Fictional buddy', enabled, area: null });
const list = () => user('SELECT public.buddy_watch_list($1)', [boat]);
const save = (id, expected, c) =>
    user('SELECT public.configure_buddy_watch($1,$2,$3,$4::jsonb)', [
        boat,
        id,
        expected,
        c === null ? null : JSON.stringify(c),
    ]);
const denied = async (fn, code, label) => {
    await assert.rejects(fn, (e) => e.code === code, label);
    checks++;
};
async function enabled() {
    await db.exec(
        "UPDATE private_buddy_watch.control SET enabled=true,licence_reference='fixture-reviewed-independent-notice-rights',entitlement_until=now()+interval '1 day',function_version=1,delivery_version=1,succeeded_at=now();UPDATE public.ais_fleet_control SET enabled=true,licence_reference='fixture-reviewed-display';",
    );
}
async function assess(id, at, sog = 0, nav = 0) {
    await db.query(
        `INSERT INTO public.vessels(mmsi,data_source,position_at,location,sog,nav_status) VALUES(234567890,'aishub',to_timestamp($1::double precision/1000),${origin},$2,$3) ON CONFLICT(mmsi) DO UPDATE SET position_at=excluded.position_at,sog=excluded.sog,nav_status=excluded.nav_status`,
        [at, sog, nav],
    );
    const rows = await service('SELECT public.buddy_watch_work(NULL,32)'),
        r = rows.find((r) => r.id === id);
    const result = evaluateBuddy(r.state ?? emptyBuddyState(), r.facts, r.configuration.area, Date.now());
    await service('SELECT public.buddy_watch_apply($1,$2,$3,$4::jsonb,$5::jsonb)', [
        r.id,
        r.revision,
        r.stateRevision,
        JSON.stringify(r.facts),
        JSON.stringify(result),
    ]);
    return { row: r, result };
}
try {
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
 CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid REFERENCES auth.users,archived_at timestamptz);ALTER TABLE public.boats ENABLE ROW LEVEL SECURITY;GRANT SELECT ON public.boats TO authenticated;CREATE POLICY own_boat ON public.boats FOR SELECT TO authenticated USING(owner_id=auth.uid());
 CREATE TABLE public.vessels(mmsi bigint PRIMARY KEY,data_source text,position_at timestamptz,location ${locationType},sog double precision,nav_status integer);
 CREATE TABLE public.ais_fleet_control(singleton boolean PRIMARY KEY,enabled boolean,licence_reference text);INSERT INTO public.ais_fleet_control VALUES(true,false,NULL);
 CREATE TABLE public.push_device_tokens(user_id uuid);CREATE TABLE public.push_notification_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_user_id uuid,notification_type text,title text,body text,data jsonb,created_at timestamptz DEFAULT now());
 CREATE SCHEMA cron;CREATE TABLE cron.job(jobname text,schedule text,command text,active boolean);INSERT INTO cron.job VALUES('buddy-watch','*/5 * * * *','SELECT public.invoke_edge_function(''buddy-watch'', 25000)',true);
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;
 INSERT INTO auth.users VALUES('${owner}'),('${other}');INSERT INTO public.boats VALUES('${boat}','${owner}'),('${foreignBoat}','${other}');INSERT INTO public.push_device_tokens VALUES('${owner}');`);
    await db.exec(
        await readFile(new URL('../held-migrations/20261016171547_buddy_watch.sql', import.meta.url), 'utf8'),
    );
    eq((await list()).ready, false, 'default held');
    eq((await list()).watches, [], 'empty owner list');
    await denied(() => as('anon', null, 'SELECT public.buddy_watch_list($1)', [boat]), '42501', 'anonymous denied');
    await denied(
        () => as('authenticated', other, 'SELECT public.buddy_watch_list($1)', [boat]),
        '42501',
        'foreign owner denied',
    );
    await denied(() => user('SELECT public.buddy_watch_list($1)', [foreignBoat]), '42501', 'foreign hull denied');
    await denied(() => user('SELECT * FROM private_buddy_watch.states'), '42501', 'no private state grant');
    await denied(
        () =>
            user('INSERT INTO public.vessel_watchlist(owner_id,boat_id,configuration) VALUES($1,$2,$3::jsonb)', [
                owner,
                boat,
                JSON.stringify(config()),
            ]),
        '42501',
        'no direct writes',
    );
    await denied(() => save(null, null, config(234567890, true)), '55000', 'cannot arm held capability');
    const revision = await save(null, null, config()),
        first = (await list()).watches[0],
        id = first.id;
    eq(first.configuration.enabled, false, 'follow starts off');
    eq(first.revision, revision, 'exact saved CAS');
    eq(await as('authenticated', other, 'SELECT count(*)::integer FROM public.vessel_watchlist'), 0, 'owner RLS');
    await denied(
        () => save(id, '30000000-0000-4000-8000-000000000099', config()),
        '40001',
        'stale CAS never overwrites',
    );
    await denied(
        () => save(null, null, { ...config(234567891), rawUrl: 'https://invalid' }),
        '22023',
        'unknown configuration refused',
    );
    await denied(
        () => save(null, null, { ...config(234567891), area: { lat: '', lon: 0, radiusNm: 1, label: 'Bad' } }),
        '22023',
        'blank latitude not zero',
    );
    for (let i = 1; i < 10; i++) await save(null, null, config(234567890 + i));
    await denied(() => save(null, null, config(234567899 + 1)), '54000', 'max ten across owner');
    await enabled();
    eq((await list()).ready, true, 'reviewed rights + exact schedule + fresh completion');
    for (const change of [
        'UPDATE private_buddy_watch.control SET delivery_version=0',
        'UPDATE private_buddy_watch.control SET function_version=0',
        "UPDATE private_buddy_watch.control SET entitlement_until=now()-interval '1 second'",
        "UPDATE private_buddy_watch.control SET succeeded_at=now()-interval '16 minutes'",
        'UPDATE public.ais_fleet_control SET enabled=false',
    ]) {
        await enabled();
        await db.exec(change);
        eq((await list()).ready, false, 'incomplete capability stays held');
    }
    await enabled();
    await db.exec("UPDATE cron.job SET command='SELECT 1'");
    eq((await list()).ready, false, 'unrelated cron not proof');
    await db.exec("UPDATE cron.job SET command='SELECT public.invoke_edge_function(''buddy-watch'', 25000)'");
    const armedRevision = await save(id, revision, config(234567890, true));
    await db.query('UPDATE public.boats SET archived_at=now() WHERE id=$1', [boat]);
    await denied(() => list(), '42501', 'archived hull cannot read or configure');
    eq((await service('SELECT public.buddy_watch_work(NULL,32)')).length, 0, 'archived hull cannot run');
    await db.query('UPDATE public.boats SET archived_at=NULL WHERE id=$1', [boat]);
    const stamp = Date.now() - 180000;
    await assess(id, stamp, 0);
    eq(await scalar('SELECT count(*)::integer FROM public.push_notification_queue'), 0, 'baseline silent');
    await assess(id, stamp + 1000, 4);
    eq(await scalar('SELECT count(*)::integer FROM public.push_notification_queue'), 0, 'minimum original duration');
    const armed = await assess(id, stamp + 121000, 4);
    eq(await scalar('SELECT count(*)::integer FROM public.push_notification_queue'), 1, 'one sustained moving notice');
    const queued = (await db.query('SELECT * FROM public.push_notification_queue')).rows[0];
    eq(queued.notification_type, 'buddy_notice', 'separate ordinary family');
    eq(queued.data.event, 'moving', 'fixed event');
    eq(queued.data.observed_at, stamp + 121000, 'original clock');
    assert(!/lat|lon|mmsi|position|token|url/.test(JSON.stringify(queued.data)));
    checks++;
    eq(await service('SELECT public.buddy_notice_delivery($1)', [queued.id]), true, 'current per-attempt proof');
    await assess(id, stamp + 121000, 4);
    eq(await scalar('SELECT count(*)::integer FROM public.push_notification_queue'), 1, 'frozen report no duplicate');
    eq(
        await service('SELECT public.buddy_watch_apply($1,$2,$3,$4::jsonb,$5::jsonb)', [
            armed.row.id,
            armed.row.revision,
            armed.row.stateRevision,
            JSON.stringify(armed.row.facts),
            JSON.stringify(armed.result),
        ]),
        false,
        'competing state CAS cannot replay',
    );
    const candidateState = {
        observedAt: Date.now() - 180000,
        mode: 'stopped',
        area: 'unknown',
        candidate: 'moving',
        candidateSince: Date.now() - 180000,
        areaCandidate: 'unknown',
        areaSince: null,
        notSeen: false,
    };
    // Fixture-only original reports: a second confirmed transition inside the
    // watch cooldown changes latest state but cannot create another notice.
    await db.query(
        'UPDATE private_buddy_watch.states SET state=$1::jsonb,revision=gen_random_uuid() WHERE watch_id=$2',
        [JSON.stringify(candidateState), id],
    );
    await assess(id, Date.now() - 1000, 4);
    eq(
        await scalar('SELECT count(*)::integer FROM public.push_notification_queue'),
        1,
        'independent30min per-watch notice cooldown',
    );
    eq(
        await service('SELECT public.buddy_notice_delivery($1)', [queued.id]),
        false,
        'newer latest state retires older queued facts',
    );
    for (let n = 0; n < 13; n++) {
        await db.query(
            "UPDATE private_buddy_watch.states SET state=$1::jsonb,revision=gen_random_uuid(),last_notice_at=now()-interval '31 minutes' WHERE watch_id=$2",
            [JSON.stringify(candidateState), id],
        );
        await assess(id, Date.now() - 1000, 4);
    }
    eq(
        await scalar('SELECT count(*)::integer FROM public.push_notification_queue'),
        12,
        'owner daily quota cannot fan out without bound',
    );
    eq(await scalar('SELECT used FROM private_buddy_watch.quotas'), 12, 'independent latest quota row');
    await db.exec("UPDATE public.vessels SET data_source='receiver'");
    eq((await service('SELECT public.buddy_watch_work(NULL,32)'))[0].facts, null, 'unreviewed source never borrowed');
    await db.exec("UPDATE public.vessels SET data_source='aishub'");
    await save(id, armedRevision, config(234567890, false));
    eq(await service('SELECT public.buddy_notice_delivery($1)', [queued.id]), false, 'opt-out retires queued delivery');
    const disabled = (await list()).watches.find((w) => w.id === id);
    eq(disabled.state, null, 'configuration reset retires history');
    await db.query('UPDATE public.boats SET owner_id=$1 WHERE id=$2', [other, boat]);
    await denied(() => list(), '42501', 'boat transfer retires previous account');
    eq((await service('SELECT public.buddy_watch_work(NULL,32)')).length, 0, 'transferred watch cannot work');
    const replacementBoat = '20000000-0000-4000-8000-000000000003';
    await db.query('INSERT INTO public.boats VALUES($1,$2)', [replacementBoat, owner]);
    await user('SELECT public.configure_buddy_watch($1,NULL,NULL,$2::jsonb)', [
        replacementBoat,
        JSON.stringify(config(345678901)),
    ]);
    eq(
        await scalar('SELECT count(*)::integer FROM public.vessel_watchlist'),
        1,
        'new explicit owned edit reclaims hidden transferred-hull slots',
    );
    eq(
        await scalar("SELECT count(*)::integer FROM pg_tables WHERE schemaname='private_buddy_watch'"),
        3,
        'only bounded latest/control/quota tables, no history',
    );
    console.log(
        JSON.stringify({
            checks,
            isolated: true,
            spatialAdapter: 'not exercised without PostGIS',
            productDatabase: false,
            notificationsDelivered: 0,
            fixtureQueueRows: 12,
        }),
    );
} finally {
    await db.close();
}
