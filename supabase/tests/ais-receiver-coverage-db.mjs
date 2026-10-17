/** Source-only140-05 fixture. Real PostGIS, actual full135 AIS migrations.
 * PGlite is a single-session SQL proof; only explicit PG17.6 mode runs races.
 * No provider, product database, timer, socket or live receiver is contacted. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const exact = 'postgresql://postgres:fixture-only-password@127.0.0.1:5432/ais_receiver140_test';
const postgres = process.env.THALASSA_DISPOSABLE_AIS_RECEIVER_TEST === '1';
if (process.env.DATABASE_URL || process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw Error('Product database settings are forbidden in this disposable fixture');
let db, pool;
if (postgres) {
    if (
        process.env.AIS_RECEIVER_TEST_DATABASE_URL !== exact ||
        !process.env.PG_MODULE_PATH ||
        Object.keys(process.env).some((k) => /^PG/i.test(k) && k !== 'PG_MODULE_PATH' && process.env[k])
    )
        throw Error('Only the exact empty localhost ais_receiver140_test fixture is allowed');
    const pg = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
        Pool = pg.Pool ?? pg.default.Pool;
    pool = new Pool({
        connectionString: exact,
        max: 8,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
        query_timeout: 18000,
        application_name: 'ais-receiver140-fixture',
    });
    const client = await pool.connect();
    db = {
        query: (s, a) => client.query(s, a),
        exec: (s) => client.query(s),
        close: async () => {
            client.release();
            await pool.end();
        },
    };
} else {
    if (
        !process.env.PGLITE_MODULE_PATH ||
        !process.env.PGLITE_POSTGIS_MODULE_PATH ||
        process.env.AIS_RECEIVER_TEST_DATABASE_URL ||
        process.env.PG_MODULE_PATH
    )
        throw Error('Explicit isolated PGlite/PostGIS or opted-in exact PostgreSQL fixture required');
    const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
    const { postgis } = await import(pathToFileURL(process.env.PGLITE_POSTGIS_MODULE_PATH).href);
    db = new PGlite({ extensions: { postgis } });
}
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const paths = [
    '../migrations/20260318080000_ais_vessels.sql',
    '../migrations/20261016072703_ais_fleet_budget.sql',
    '../migrations/20261017011825_ais_receiver_coverage.sql',
];
const sources = await Promise.all(paths.map(read));
let checks = 0;
const eq = (a, b, label) => {
    assert.deepEqual(a, b, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
async function as(role, uid, sql, args = []) {
    await db.exec(
        `RESET ROLE;SELECT set_config('request.jwt.claim.sub','${uid ?? ''}',false);SELECT set_config('request.jwt.claim.role','${role}',false);SET ROLE ${role}`,
    );
    try {
        return await scalar(sql, args);
    } finally {
        await db.exec('RESET ROLE');
    }
}
const service = (sql, args) => as('service_role', null, sql, args);
const id = (group, n) => `${group}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = (n) => id('1', n),
    boat = (n) => id('2', n),
    pi = (n) => id('3', n),
    boot = (n) => id('4', n);
const relay = (n) => `fixture-ais-relay-${String(n).padStart(4, '0')}`;
const binding = (n) => ({
    ownerId: owner(n),
    boatId: boat(n),
    piDeviceId: pi(n),
    relayId: relay(n),
    pairingId: 'a'.repeat(64),
    controllerId: id('5', n),
    enrollmentRevision: 'b'.repeat(64),
    sourceKey: 'c'.repeat(64),
});
const key = 'A'.repeat(120),
    token = 'd'.repeat(64),
    grantSql = "SELECT public.set_ais_receiver_consent($1,$2::jsonb,$3,$4,$5,now()+interval '1 day')";
const grant = (n, expected = null, enabled = true, value = binding(n)) =>
    service(grantSql, [owner(n), JSON.stringify(value), expected, enabled, enabled ? key : null]);
const coverage = (box = [-180, -90, 180, 90]) =>
    as('authenticated', owner(1), 'SELECT public.ais_receiver_coverage($1,$2,$3,$4)', box);
const admitSql = `SELECT public.admit_ais_receiver_batch($1::jsonb,$2,$3,$4,$5,$6,clock_timestamp(),$7,
 clock_timestamp()-interval '1 second',clock_timestamp()-interval '2 seconds',$8)`;
const args = (n, rev, seq = 1, cell = 'v1:31:166', heard = true, bootId = boot(1)) => [
    JSON.stringify(binding(n)),
    rev,
    token,
    key,
    bootId,
    seq,
    cell,
    heard,
];
const admit = (n, rev, seq = 1, cell = 'v1:31:166', heard = true, bootId = boot(1)) =>
    service(admitSql, args(n, rev, seq, cell, heard, bootId));
const denied = async (fn, code, label) => {
    await assert.rejects(fn, (e) => e.code === code, label);
    checks++;
};
const resetBudget = () =>
    db.exec(
        'UPDATE public.ais_fleet_control SET day_writes=0,hour_writes=0,day_write_limit=20000,hour_write_limit=1000',
    );
const rights = () =>
    db.exec(`UPDATE public.ais_fleet_control SET enabled=true,licence_reference='FICTIONAL isolated test only';
 UPDATE private_ais_receiver.control SET forwarding_enabled=true,coverage_enabled=true,
 transport_rights_reference='FICTIONAL raw transport only',display_rights_reference='FICTIONAL coarse coverage only'`);
const delayed = () => db.exec(`UPDATE private_ais_receiver.observations SET first_heard_at=now()-interval '6 minutes'`);
const races = [];
try {
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_tables WHERE schemaname !~ '^pg_' AND schemaname<>'information_schema'",
        ),
        0,
        'empty fixture required',
    );
    if (postgres) {
        eq(await scalar('SELECT current_database()'), 'ais_receiver140_test', 'exact fixture database');
        assert.match(await scalar('SHOW server_version'), /^17\.6(?:\D|$)/);
        checks++;
    }
    await db.exec(`CREATE SCHEMA extensions;CREATE EXTENSION postgis WITH SCHEMA extensions;SET search_path=public,extensions;
 CREATE SCHEMA auth; CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_user::text$$;
 GRANT USAGE ON SCHEMA auth,public,extensions TO anon,authenticated,service_role;
 CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,archived_at timestamptz);
 CREATE TABLE public.pi_diary_relays(relay_id text PRIMARY KEY,owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 boat_id uuid REFERENCES public.boats(id) ON DELETE CASCADE,token_hash text NOT NULL,enabled boolean NOT NULL DEFAULT true);
 CREATE TABLE public.vessel_telemetry(owner_id uuid PRIMARY KEY,lat double precision,lon double precision,reported_at timestamptz);
 GRANT SELECT,UPDATE ON public.boats,public.pi_diary_relays TO service_role;
 GRANT SELECT ON public.vessel_telemetry TO service_role;`);
    for (const source of sources) await db.exec(source);
    for (let n = 1; n <= 4; n++) {
        await db.query('INSERT INTO auth.users VALUES($1)', [owner(n)]);
        await db.query('INSERT INTO public.boats(id,owner_id) VALUES($1,$2)', [boat(n), owner(n)]);
        await db.query('INSERT INTO public.pi_diary_relays VALUES($1,$2,$3,$4,true)', [
            relay(n),
            owner(n),
            boat(n),
            token,
        ]);
    }
    eq(
        await scalar(
            "SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN('private_ais_receiver.control'::regclass,'private_ais_receiver.consents'::regclass,'private_ais_receiver.observations'::regclass,'private_ais_receiver.replays'::regclass)",
        ),
        true,
        'all private state RLS',
    );
    for (const role of ['anon', 'authenticated']) {
        for (const table of ['control', 'consents', 'observations', 'replays'])
            eq(
                await scalar("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')", [
                    role,
                    `private_ais_receiver.${table}`,
                ]),
                false,
                'no client private table rights',
            );
        eq(
            await scalar(
                "SELECT has_function_privilege($1,'public.set_ais_receiver_consent(uuid,jsonb,uuid,boolean,text,timestamptz)','EXECUTE')",
                [role],
            ),
            false,
            'no client service consent writes',
        );
        eq(
            await scalar(
                "SELECT has_function_privilege($1,'public.admit_ais_receiver_batch(jsonb,uuid,text,text,uuid,bigint,timestamptz,text,timestamptz,timestamptz,boolean)','EXECUTE')",
                [role],
            ),
            false,
            'no client admission writes',
        );
    }
    await denied(
        () => as('anon', null, 'SELECT public.ais_receiver_coverage(-180,-90,180,90)'),
        '42501',
        'anonymous coverage held',
    );
    await denied(
        () => as('authenticated', null, 'SELECT public.ais_receiver_coverage(-180,-90,180,90)'),
        '42501',
        'missing signed identity held',
    );
    eq((await coverage()).state, 'held', 'default coverage and transport OFF');
    await denied(() => grant(1), '55000', 'default grants held');
    await db.exec('UPDATE private_ais_receiver.control SET forwarding_enabled=true,coverage_enabled=true');
    await denied(() => grant(1), '55000', 'flags alone do not grant rights');
    await rights();
    await denied(() => grant(1, null, true, { ...binding(1), ownerId: owner(2) }), '22023', 'owner body mismatch');
    await denied(() => grant(1, null, true, { ...binding(1), boatId: boat(2) }), '42501', 'other vessel held');
    const grants = [];
    for (let n = 1; n <= 4; n++) grants[n] = await grant(n);
    eq(grants[1].enabled, true, 'explicit grant accepted');
    await denied(() => grant(1), '40001', 'CAS prevents lost grant update');
    eq(await admit(1, grants[1].revision), true, 'first signed batch admitted');
    eq(await admit(1, grants[1].revision), false, 'same sequence replay held');
    eq(await admit(1, grants[1].revision, 2), true, 'strictly increasing sequence accepted');
    eq(
        await service(admitSql, [
            ...args(1, grants[1].revision, 3).slice(0, 2),
            'e'.repeat(64),
            ...args(1, grants[1].revision, 3).slice(3),
        ]),
        false,
        'rotated relay token held',
    );
    eq(await admit(1, grants[2].revision, 3), false, 'another grant revision held');
    eq(
        await scalar('SELECT day_writes FROM public.ais_fleet_control'),
        8,
        'actual private writes debit shared persisted fleet budget',
    );
    eq(await admit(2, grants[2].revision), true, 'second independent receiver admitted');
    await delayed();
    eq((await coverage()).cells, [], 'two receivers cannot publish');
    eq(await admit(3, grants[3].revision), true, 'third independent receiver admitted');
    eq((await coverage()).cells, [], 'third new arrival still waits publication delay');
    await delayed();
    const published = await coverage();
    eq(published.cells, ['v1:31:166'], 'three current independent receivers publish only fixed coarse cell');
    eq(
        Object.keys(published).sort(),
        ['asOf', 'cells', 'expiresAt', 'partial', 'schema', 'state'],
        'public output contains no receiver IDs, positions, counts or per-cell clock',
    );
    eq((await coverage([0, 0, 1, 1])).cells, [], 'actual PostGIS excludes distant cell');
    await db.query('UPDATE private_ais_receiver.consents SET owner_id=$1 WHERE boat_id=$2', [owner(1), boat(3)]);
    await db.query('UPDATE public.boats SET owner_id=$1 WHERE id=$2', [owner(1), boat(3)]);
    await db.query('UPDATE public.pi_diary_relays SET owner_id=$1 WHERE relay_id=$2', [owner(1), relay(3)]);
    eq((await coverage()).cells, [], 'three receivers belonging to two accounts are insufficient');
    await db.query('UPDATE private_ais_receiver.consents SET owner_id=$1 WHERE boat_id=$2', [owner(3), boat(3)]);
    await db.query('UPDATE public.boats SET owner_id=$1 WHERE id=$2', [owner(3), boat(3)]);
    await db.query('UPDATE public.pi_diary_relays SET owner_id=$1 WHERE relay_id=$2', [owner(3), relay(3)]);
    eq(
        await scalar(
            "SELECT last_heard_at<clock_timestamp()-interval '1 second' FROM private_ais_receiver.observations WHERE boat_id=$1",
            [boat(1)],
        ),
        true,
        'receiver observation clock is not redated as server receipt',
    );
    await denied(() => coverage([NaN, 0, 1, 1]), '22023', 'NaN window refused');
    await denied(() => coverage([-180, -91, 180, 90]), '22023', 'out of bounds window refused');
    eq(
        await admit(4, grants[4].revision, 1, 'v1:31:166', false),
        true,
        'ownship/provider-only batch admission is distinct from coverage',
    );
    eq(
        await scalar('SELECT count(*)::int FROM private_ais_receiver.observations'),
        3,
        'no raw receiver observation creates no coverage',
    );
    await db.exec(
        "UPDATE private_ais_receiver.observations SET last_heard_at=now()-interval '11 minutes',first_heard_at=now()-interval '12 minutes' WHERE boat_id='" +
            boat(3) +
            "'",
    );
    eq((await coverage()).cells, [], 'short coverage expiry');
    eq(await admit(3, grants[3].revision, 2), true, 'fresh receiver after lapse admitted');
    eq((await coverage()).cells, [], 'lapse restarts delay');
    await delayed();
    eq(await admit(3, grants[3].revision, 3, 'v1:31:167'), true, 'receiver moves to different coarse cell');
    eq(
        await scalar('SELECT count(*)::int FROM private_ais_receiver.observations WHERE boat_id=$1', [boat(3)]),
        1,
        'movement overwrites current cell; no trail',
    );
    eq((await coverage()).cells, [], 'movement removes previous cell immediately');
    for (let n = 1; n <= 3; n++) await admit(n, grants[n].revision, 4, 'v1:31:0');
    await delayed();
    eq((await coverage([179, -30, -177, -24])).cells, ['v1:31:0'], 'dateline window uses real original fixed cell');
    await db.query('UPDATE public.boats SET owner_id=$1 WHERE id=$2', [owner(4), boat(3)]);
    eq((await coverage()).cells, [], 'vessel transfer retires coverage');
    eq(await admit(3, grants[3].revision, 5), false, 'transfer retires admission');
    await db.query('UPDATE public.boats SET owner_id=$1 WHERE id=$2', [owner(3), boat(3)]);
    await db.query('UPDATE public.pi_diary_relays SET enabled=false WHERE relay_id=$1', [relay(3)]);
    eq((await coverage()).cells, [], 'relay revocation retires public cell');
    eq(await admit(3, grants[3].revision, 5), false, 'relay revocation retires admission');
    await db.query('UPDATE public.pi_diary_relays SET enabled=true WHERE relay_id=$1', [relay(3)]);
    await db.exec('UPDATE public.ais_fleet_control SET hour_write_limit=1,hour_writes=0');
    eq(await admit(1, grants[1].revision, 5), false, 'shared budget prevents private coverage/replay writes');
    eq(
        await scalar(
            'SELECT sequence::integer FROM private_ais_receiver.replays WHERE consent_revision=$1 AND boot_id=$2',
            [grants[1].revision, boot(1)],
        ),
        4,
        'no replay state mutation on budget refusal',
    );
    await resetBudget();
    for (let n = 2; n <= 16; n++)
        eq(await admit(4, grants[4].revision, 1, null, false, boot(n)), true, 'bounded boot slot');
    eq(await admit(4, grants[4].revision, 1, null, false, boot(17)), false, 'seventeenth boot held without eviction');
    eq(
        await admit(4, grants[4].revision, 1, null, false, boot(1)),
        false,
        'A/B/A replay cannot return after boot churn',
    );
    await db.exec(
        'UPDATE public.ais_fleet_control SET enabled=false;UPDATE private_ais_receiver.control SET forwarding_enabled=false',
    );
    const off = await grant(1, grants[1].revision, false);
    eq(off.enabled, false, 'owner withdrawal works while transport held');
    eq(
        await scalar('SELECT count(*)::int FROM private_ais_receiver.observations WHERE boat_id=$1', [boat(1)]),
        0,
        'withdrawal erases private current cell',
    );
    eq(
        await scalar('SELECT count(*)::int FROM private_ais_receiver.replays WHERE consent_revision=$1', [
            grants[1].revision,
        ]),
        0,
        'withdrawal erases old replay state',
    );
    await rights();
    eq(await admit(1, grants[1].revision, 6), false, 'old enabled revision never returns after withdrawal');
    const next = await grant(1, off.revision);
    eq(next.revision === grants[1].revision, false, 're-enable gets new revision');
    await denied(() => grant(1, off.revision, false), '40001', 'late A off cannot overwrite current B');
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner(4)]);
    eq(
        await scalar('SELECT count(*)::int FROM private_ais_receiver.consents WHERE owner_id=$1', [owner(4)]),
        0,
        'account deletion cascades private latest state',
    );
    // Bounded aggregate output, with three genuinely distinct current fixture
    // accounts/Pi identities per cell. These synthetic rows never leave this DB.
    await db.exec(`WITH seeds AS (SELECT i,('60000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid AS owner,
      ('70000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid AS boat,
      ('80000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid AS pi FROM generate_series(1,771) i)
     INSERT INTO auth.users SELECT owner FROM seeds;
     INSERT INTO public.boats(id,owner_id) SELECT ('70000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
      ('60000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid FROM generate_series(1,771) i;
     INSERT INTO public.pi_diary_relays SELECT 'fixture-limit-relay-'||right(id::text,12)::int,owner_id,id,'${token}',true FROM public.boats WHERE id::text LIKE '70000000%';
     INSERT INTO private_ais_receiver.consents(boat_id,owner_id,pi_device_id,relay_id,binding,public_key_spki,enabled,consent_version,issued_at,expires_at)
      SELECT id,owner_id,('80000000'||substring(id::text FROM 9))::uuid,'fixture-limit-relay-'||right(id::text,12)::int,
       '{}'::jsonb,'${key}',true,'2026-10-17-pi-v1',now(),now()+interval '1 day' FROM public.boats WHERE id::text LIKE '70000000%';
     INSERT INTO private_ais_receiver.observations SELECT boat_id,revision,'v1:'||((n/180)::int)||':'||(n%180)::int,
       now()-interval '6 minutes',now()-interval '1 minute' FROM (
        SELECT boat_id,revision,((row_number() OVER(ORDER BY boat_id)-1)/3)::int AS n FROM private_ais_receiver.consents WHERE boat_id::text LIKE '70000000%') q;`);
    const capped = await coverage();
    eq(capped.cells.length, 256, 'actual aggregate response caps at256 fixed cells');
    eq(capped.partial, true, 'extra qualified cells are explicitly partial');
    await db.exec("DELETE FROM auth.users WHERE id::text LIKE '60000000%'");
    if (postgres) {
        const { runAisReceiverRaces } = await import('./ais-receiver-coverage-races.mjs');
        await runAisReceiverRaces({
            pool,
            eq,
            binding,
            owner,
            boat,
            relay,
            key,
            token,
            admitSql,
            args,
            grantSql,
            races,
        });
    }
    console.info(
        JSON.stringify({
            checks,
            runtime: postgres ? 'postgresql17.6' : 'pglite-single-session',
            postgis: await scalar('SELECT extensions.postgis_full_version()'),
            actualPostgresRaces: races,
            productionConnections: 0,
            aisForwarded: 0,
            migrations: paths.map((path, i) => ({
                path,
                sha256: createHash('sha256').update(sources[i]).digest('hex'),
            })),
        }),
    );
} finally {
    await db.close();
}
