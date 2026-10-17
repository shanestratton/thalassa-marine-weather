/** Disposable PostgreSQL17.6 only. No product connection/provider/public write. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { crowdFixtureConfig, assertCrowdFixtureFacts } from './crowd-disposable142.mjs';
import { crowdRetirementFixture } from '../../tests/sql/crowdRetirement142.mjs';

const config = crowdFixtureConfig(process.env, process.platform);
const pg = await import(pathToFileURL(config.modulePath).href);
const Pool = pg.Pool ?? pg.default.Pool;
const pool = new Pool({ ...config.connection, max: 4 });
const clients = [];
let checks = 0;
const races = [];
const eq = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
};
const read = async (p) => (await readFile(new URL(p, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const scalar = async (c, sql, args = []) => Object.values((await c.query(sql, args)).rows[0] ?? {})[0];
const owner = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boat = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const batch = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const calibration = () => ({
    schema: 1,
    depthReference: 'T',
    depthSource: 'signalk:belowTransducer',
    sounderProduct: 'FICTIONAL isolated checked sounder',
    measuredAt: Date.now() - 86400000,
    waterlineToTransducerM: 0.8,
    offsetUncertaintyM: 0.1,
    sounderUncertaintyM: 0.2,
    checkedDepthLimitM: 30,
    method: 'measured-offset-and-sounder-check',
});
const grantSQL = 'SELECT public.set_seabed_publication($1,$2,$3,$4,$5,$6::jsonb)';
const args = (n, rev = null, map = true, dcdb = false, cal = calibration(), terms = '2026-10-17-public-1') => [
    boat(n),
    rev,
    map,
    dcdb,
    terms,
    cal === null ? null : JSON.stringify(cal),
];
async function actor(c, n, role = 'authenticated') {
    assert.ok(['authenticated', 'anon', 'service_role'].includes(role));
    await c.query('RESET ROLE');
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)", [
        n ? owner(n) : '',
        role,
    ]);
    await c.query('SET ROLE ' + role);
}
async function as(c, n, sql, values = [], role = 'authenticated') {
    await actor(c, n, role);
    try {
        return await scalar(c, sql, values);
    } finally {
        await c.query('RESET ROLE');
    }
}
async function denied(fn, code, label) {
    await assert.rejects(fn, (e) => e.code === code, label);
    checks++;
}
async function blocked(db, waiting, holding, label) {
    const deadline = performance.now() + 1200;
    while (performance.now() < deadline) {
        if (await scalar(db, 'SELECT $2::int=ANY(pg_blocking_pids($1::int))', [waiting, holding])) {
            checks++;
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error('No actual blocking relationship: ' + label);
}
async function rolled(c) {
    await c.query('ROLLBACK');
    await c.query('RESET ROLE');
}

try {
    for (let i = 0; i < 4; i++) clients.push(await pool.connect());
    const [db, gate, first, second] = clients;
    const facts = (
        await db.query(`SELECT current_database() AS database,current_user AS user,
        current_setting('server_version_num') AS version,
        (SELECT count(*) FROM pg_tables WHERE schemaname !~ '^pg_' AND schemaname<>'information_schema') AS tables,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') AS functions,
        (SELECT count(*) FROM pg_namespace WHERE nspname='auth') AS auth_schema,
        (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) AS auth_roles,
        (SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1','crowd_soundings142_test')) AS databases,
        (SELECT count(*) FROM pg_publication) AS publications`)
    ).rows[0];
    assertCrowdFixtureFacts(facts);
    checks += 9;
    await db.query(`CREATE SCHEMA auth;CREATE SCHEMA storage;
        CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
        GRANT USAGE ON SCHEMA auth,public TO anon,authenticated,service_role;
        CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
            name text NOT NULL DEFAULT 'FICTIONAL fixture boat',archived_at timestamptz,released_at timestamptz);
        GRANT SELECT,UPDATE,DELETE ON public.boats TO authenticated;GRANT ALL ON public.boats TO service_role;
        CREATE TABLE public.account_deletion_jobs(user_id uuid PRIMARY KEY);
        CREATE TABLE public.recipes(id uuid,user_id uuid);CREATE TABLE public.community_recipes(id uuid,user_id uuid);
        CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
        CREATE TABLE storage.objects(bucket_id text,name text,owner_id text);
        CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at:=now();RETURN NEW;END;$$;
        CREATE FUNCTION public.is_boat_owner(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.boats WHERE id=p_id AND owner_id=auth.uid())$$;`);
    const dependencies = crowdRetirementFixture();
    eq(await read('../../tests/sql/crowd-retirement142.sql'), dependencies, 'exact original trigger dependency bodies');
    await db.query(dependencies);
    const legacy = await read('../migrations/20261005130000_seabed_mapping.sql');
    await db.query(legacy);
    const unchangedSQL = `SELECT jsonb_build_object('bucket',(SELECT to_jsonb(b) FROM storage.buckets b WHERE id='seabed-soundings'),
        'inventory',pg_get_functiondef('public.account_deletion_storage_inventory(uuid)'::regprocedure),
        'storageFence',pg_get_functiondef('public.block_tombstoned_storage_write()'::regprocedure),
        'summary',pg_get_functiondef('public.seabed_contribution_summary()'::regprocedure))`;
    const original = await scalar(db, unchangedSQL);
    const migration = await read('../migrations/20261017120000_crowd_soundings_publication.sql');
    await db.query(migration);
    eq(
        await scalar(db, unchangedSQL),
        original,
        'private bucket, capture summary and deletion/storage bodies unchanged',
    );
    eq(
        await scalar(
            db,
            "SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid='public.seabed_publication_consents'::regclass",
        ),
        true,
        'owner table RLS',
    );
    for (const role of ['anon', 'authenticated']) {
        eq(
            await scalar(
                db,
                "SELECT has_table_privilege($1,'public.seabed_publication_consents','INSERT,UPDATE,DELETE')",
                [role],
            ),
            false,
            role + ' cannot write directly',
        );
        for (const fn of ['read_crowd_sounding_candidate(uuid,text)', 'list_crowd_sounding_candidates(text,uuid)'])
            eq(
                await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, 'public.' + fn]),
                false,
                'no client export ' + fn,
            );
    }
    eq(
        await scalar(
            db,
            "SELECT has_function_privilege('anon','public.set_seabed_publication(uuid,uuid,boolean,boolean,text,jsonb)','EXECUTE')",
        ),
        false,
        'no anonymous grant',
    );
    eq(
        await scalar(
            db,
            "SELECT has_function_privilege('service_role','public.set_seabed_publication(uuid,uuid,boolean,boolean,text,jsonb)','EXECUTE')",
        ),
        false,
        'worker cannot grant owner consent',
    );
    const triggerNames = (
        await db.query(
            "SELECT tgname FROM pg_trigger WHERE tgrelid='public.boats'::regclass AND NOT tgisinternal ORDER BY tgname",
        )
    ).rows.map((x) => x.tgname);
    eq(
        triggerNames.slice(0, 2),
        ['aaa_crowd_permission_retirement', 'account_deletion_write_fence'],
        'nonblocking hook precedes genuine automatic boat fence',
    );
    assert.ok(triggerNames.includes('comfort_boat_retirement') && triggerNames.includes('presence_boat_retirement'));
    checks++;
    for (let n = 1; n <= 12; n++) {
        await db.query('INSERT INTO auth.users VALUES($1)', [owner(n)]);
        await db.query('INSERT INTO public.boats(id,owner_id) VALUES($1,$2)', [boat(n), owner(n)]);
    }
    await denied(() => as(db, null, grantSQL, args(1)), '42501', 'anonymous identity cannot grant');
    await denied(() => as(db, 2, grantSQL, args(1)), '42501', 'another actual owner cannot grant');
    await denied(
        () => as(db, 1, grantSQL, args(1, null, true, false, calibration(), '2026-10-05')),
        '40001',
        'legacy private consent is not public permission',
    );
    for (const value of [
        null,
        {},
        [],
        { ...calibration(), draftConfirmed: true },
        { ...calibration(), depthReference: 'Unknown' },
        { ...calibration(), waterlineToTransducerM: '0.8' },
        { ...calibration(), offsetUncertaintyM: 0 },
    ])
        await denied(() => as(db, 1, grantSQL, args(1, null, true, false, value)), '40001', 'invalid calibration held');
    for (const date of [Date.now() + 86400000, Date.now() - 367 * 86400000])
        await denied(
            () => as(db, 1, grantSQL, args(1, null, true, false, { ...calibration(), measuredAt: date })),
            '22023',
            'original calibration clock held',
        );
    let permission = await as(db, 1, grantSQL, args(1));
    eq([permission.map_enabled, permission.dcdb_enabled], [true, false], 'separate public map/DCDB flags');
    eq(
        await as(db, 2, 'SELECT count(*)::int FROM public.seabed_publication_consents'),
        0,
        'actual owner RLS hides other consent',
    );
    eq(
        await as(db, 1, 'SELECT count(*)::int FROM public.seabed_publication_consents'),
        1,
        'actual owner reads own consent',
    );
    await denied(() => as(db, 1, grantSQL, args(1)), '40001', 'stale CAS cannot overwrite');
    const stable = await as(db, 1, grantSQL, args(1, permission.revision, true, false, permission.calibration));
    eq(stable.revision, permission.revision, 'identical reviewed choice preserves revision and future clock');
    permission = await as(db, 1, grantSQL, args(1, permission.revision, true, true, permission.calibration));
    eq(permission.map_effective_from, stable.map_effective_from, 'adding DCDB does not move map clock');
    assert.ok(Date.parse(permission.dcdb_effective_from) >= Date.parse(permission.map_effective_from));
    checks++;
    const off = await as(
        db,
        1,
        grantSQL,
        args(1, '00000000-0000-4000-8000-000000000000', false, false, null, 'obsolete'),
    );
    eq(
        [off.map_enabled, off.dcdb_enabled, off.map_effective_from, off.dcdb_effective_from],
        [false, false, null, null],
        'OFF works with stale revision/terms/calibration',
    );

    // Explicit fictional server history: fresh consent can NEVER admit old captures.
    const platform = await scalar(
        db,
        `INSERT INTO public.seabed_platforms(owner_id,boat_id,enabled,consent_version,consented_at)
        VALUES($1,$2,true,'2026-10-05',clock_timestamp()-interval '60 days') RETURNING id`,
        [owner(1), boat(1)],
    );
    const insertBatch = async (n, startDays = 35) =>
        db.query(
            `INSERT INTO public.seabed_batches(id,owner_id,platform_id,boat_id,device,object_path,content_sha256,
        bytes,row_count,t_start,t_end,min_lat,max_lat,min_lon,max_lon,eligible_after,capture_meta)
        VALUES($1,$2,$3,$4,'pi',$5,$6,100,1,clock_timestamp()-make_interval(days=>$7),clock_timestamp()-make_interval(days=>$7),
        -27,-27,154,154,clock_timestamp()-make_interval(days=>$7)+interval '30 days',
        '{"time_source":"gnss","depth_source":"signalk:belowTransducer","surface_to_transducer_m":0.8}')`,
            [
                batch(n),
                owner(1),
                platform,
                boat(1),
                owner(1) + '/fictional-' + n + '.csv.gz',
                n.toString(16).padStart(64, '0'),
                startDays,
            ],
        );
    await insertBatch(1);
    eq(
        await as(db, null, "SELECT public.read_crowd_sounding_candidate($1,'map')", [batch(1)], 'service_role'),
        null,
        'private legacy capture alone unavailable',
    );
    permission = await as(db, 1, grantSQL, args(1, off.revision));
    eq(
        await as(db, null, "SELECT public.read_crowd_sounding_candidate($1,'map')", [batch(1)], 'service_role'),
        null,
        'new future-only grant cannot release old capture',
    );
    await db.query(
        `UPDATE public.seabed_publication_consents SET map_effective_from=clock_timestamp()-interval '40 days',
        calibration=jsonb_set(calibration,'{measuredAt}',to_jsonb(floor(extract(epoch FROM clock_timestamp()-interval '60 days')*1000))) WHERE owner_id=$1`,
        [owner(1)],
    );
    const candidate = () =>
        as(db, null, "SELECT public.read_crowd_sounding_candidate($1,'map')", [batch(1)], 'service_role');
    let source = await candidate();
    eq(source.batchId, batch(1), 'reviewed fictional historical consent admits eligible candidate');
    eq(source.sentSha256, '1'.padStart(64, '0'), 'legacy sent hash remains explicitly named');
    await db.query(
        'UPDATE public.seabed_platforms SET privacy_zones=\'[{"id":"fictional-home","kind":"home","lat":-27,"lon":154,"radius_m":1000,"jitter_m":0}]\' WHERE id=$1',
        [platform],
    );
    source = await candidate();
    eq(source.privacyZones.length, 1, 'current privacy revision is actually reread');
    await db.query(
        "UPDATE public.seabed_publication_consents SET calibration=jsonb_set(calibration,'{measuredAt}',to_jsonb(floor(extract(epoch FROM clock_timestamp()-interval '367 days')*1000))) WHERE owner_id=$1",
        [owner(1)],
    );
    eq(await candidate(), null, 'expired calibration cannot occupy a work page forever');
    await db.query(
        "UPDATE public.seabed_publication_consents SET calibration=jsonb_set(calibration,'{measuredAt}',to_jsonb(floor(extract(epoch FROM clock_timestamp()-interval '60 days')*1000))) WHERE owner_id=$1",
        [owner(1)],
    );
    for (let n = 2; n <= 34; n++) await insertBatch(n);
    const page = await as(db, null, "SELECT public.list_crowd_sounding_candidates('map',NULL)", [], 'service_role');
    eq(page.ids.length, 32, 'candidate page bounded at32');
    eq(page.hasMore, true, 'overflow is explicit');
    const tail = await as(
        db,
        null,
        "SELECT public.list_crowd_sounding_candidates('map',$1)",
        [page.nextCursor],
        'service_role',
    );
    eq(tail.ids.length, 2, 'strict next cursor does not duplicate');
    await insertBatch(35, 5);
    eq(
        await as(db, null, "SELECT public.read_crowd_sounding_candidate($1,'map')", [batch(35)], 'service_role'),
        null,
        '30day hold remains required',
    );
    await as(db, 1, grantSQL, args(1, null, false, false, null));
    eq(await candidate(), null, 'OFF immediately retires source read');

    const pids = await Promise.all([gate, first, second].map((c) => scalar(c, 'SELECT pg_backend_pid()')));
    // Same owner grants: first waits behind only its bounded consent gate;
    // second refuses account contention. Original confirmation clock follows wait.
    await gate.query('BEGIN');
    await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('thalassa:crowd-permission:'||$1||':'||$2,0))", [
        owner(3),
        boat(3),
    ]);
    await actor(first, 3);
    const pending = first.query(grantSQL, args(3)).then((r) => r.rows[0].set_seabed_publication);
    await blocked(db, pids[1], pids[0], 'grant consent gate');
    await denied(() => as(second, 3, grantSQL, args(3)), '55P03', 'competing grant does not wait in reversed order');
    const releaseClock = await scalar(db, 'SELECT clock_timestamp()');
    await gate.query('COMMIT');
    const accepted = await pending;
    await first.query('RESET ROLE');
    assert.ok(Date.parse(accepted.map_effective_from) >= new Date(releaseClock).getTime());
    checks++;
    races.push('same-owner CAS + post-wait clock');
    await denied(() => as(second, 3, grantSQL, args(3)), '40001', 'committed competing CAS is stale');

    // Grant holds boat SHARE while awaiting consent gate. Real archive row wait
    // is observed, then all real BEFORE/AFTER hooks run after the grant commits.
    await gate.query('BEGIN');
    await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('thalassa:crowd-permission:'||$1||':'||$2,0))", [
        owner(4),
        boat(4),
    ]);
    await actor(first, 4);
    const grantWait = first.query(grantSQL, args(4));
    await blocked(db, pids[1], pids[0], 'grant before archive');
    await actor(second, 4);
    const archive = second.query('UPDATE public.boats SET archived_at=clock_timestamp() WHERE id=$1', [boat(4)]);
    await blocked(db, pids[2], pids[1], 'actual archive boat row');
    await gate.query('COMMIT');
    await grantWait;
    await archive;
    await first.query('RESET ROLE');
    await second.query('RESET ROLE');
    eq(
        await scalar(db, 'SELECT count(*)::int FROM public.seabed_publication_consents WHERE boat_id=$1', [boat(4)]),
        0,
        'archive retires grant after genuine row wait',
    );
    races.push('grant/archive genuine shared trigger graph');

    // Account deletion authority cannot be waited on while retaining boat row.
    // Include metadata-only updates: the real old BEFORE fence otherwise waits.
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,20260806))', [owner(5)]);
    await denied(() => as(first, 5, grantSQL, args(5)), '55P03', 'deletion-first grant busy');
    for (const sql of [
        'UPDATE public.boats SET archived_at=clock_timestamp() WHERE id=$1',
        "UPDATE public.boats SET name='FICTIONAL metadata edit' WHERE id=$1",
    ])
        await denied(() => as(second, 5, sql, [boat(5)]), '55P03', 'early hook refuses before real account fence');
    await gate.query('INSERT INTO public.account_deletion_jobs VALUES($1)', [owner(5)]);
    await gate.query('DELETE FROM public.boats WHERE id=$1', [boat(5)]);
    await gate.query('COMMIT');
    await denied(() => as(first, 5, grantSQL, args(5)), '42501', 'committed tombstone holds later grant');
    races.push('deletion-first + real BEFORE metadata/archive fence');

    // Archive-first holds actual boat write row; consent SHARE NOWAIT refuses.
    const old = await as(db, 6, grantSQL, args(6));
    await actor(gate, 6);
    await gate.query('BEGIN');
    await gate.query('UPDATE public.boats SET archived_at=clock_timestamp() WHERE id=$1', [boat(6)]);
    await denied(() => as(first, 6, grantSQL, args(6, old.revision)), '55P03', 'archive-first NOWAIT');
    await gate.query('COMMIT');
    await gate.query('RESET ROLE');
    await db.query('UPDATE public.boats SET archived_at=NULL WHERE id=$1', [boat(6)]);
    await denied(() => as(db, 6, grantSQL, args(6, old.revision)), '40001', 'archive A/B/A cannot restore revision');
    const renewed = await as(db, 6, grantSQL, args(6));
    assert.notEqual(renewed.revision, old.revision);
    checks++;
    races.push('archive-first + durable A/B/A');
    await db.query('UPDATE public.boats SET owner_id=$2 WHERE id=$1', [boat(6), owner(7)]);
    await db.query('UPDATE public.boats SET owner_id=$2 WHERE id=$1', [boat(6), owner(6)]);
    await denied(() => as(db, 6, grantSQL, args(6, renewed.revision)), '40001', 'owner A/B/A cannot restore revision');
    const newer = await as(db, 6, grantSQL, args(6));
    await db.query('UPDATE public.boats SET released_at=clock_timestamp() WHERE id=$1', [boat(6)]);
    await denied(() => as(db, 6, grantSQL, args(6, null, true)), '42501', 'released boat cannot grant');
    await db.query('UPDATE public.boats SET released_at=NULL WHERE id=$1', [boat(6)]);
    await denied(() => as(db, 6, grantSQL, args(6, newer.revision)), '40001', 'release A/B/A cannot restore revision');
    const final = await as(db, 6, grantSQL, args(6));
    await db.query("UPDATE public.boats SET name='FICTIONAL benign rename' WHERE id=$1", [boat(6)]);
    eq(
        await scalar(db, 'SELECT revision FROM public.seabed_publication_consents WHERE boat_id=$1', [boat(6)]),
        final.revision,
        'uncontended rename preserves permission',
    );
    await db.query('DELETE FROM public.boats WHERE id=$1', [boat(6)]);
    eq(
        await scalar(db, 'SELECT count(*)::int FROM public.seabed_publication_consents WHERE boat_id=$1', [boat(6)]),
        0,
        'delete removes consent',
    );
    eq(
        await scalar(db, 'SELECT count(*)::int FROM public.seabed_batches'),
        35,
        'private captured batch history is preserved',
    );
    process.stdout.write(
        JSON.stringify({
            schema: 1,
            ok: true,
            postgres: '17.6',
            checks,
            races,
            sourceSha: process.env.SOURCE_SHA ?? null,
            sourceHashes: {
                migration: createHash('sha256').update(migration).digest('hex'),
                legacy: createHash('sha256').update(legacy).digest('hex'),
                dependencies: createHash('sha256').update(dependencies).digest('hex'),
            },
            productionConnections: 0,
            providerRequests: 0,
            publicWrites: 0,
            notes: [
                'Full unchanged private seabed migration; exact referenced account/presence/comfort/boat-policy subsets only.',
                'Fictional historical eligible batches explicitly staged by fixture administrator.',
            ],
        }) + '\n',
    );
} finally {
    for (const c of clients) {
        try {
            await rolled(c);
        } catch {}
        c.release();
    }
    await pool.end();
}
