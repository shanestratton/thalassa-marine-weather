/** Isolated owner/RLS/read-shape proof only. No product connection,
 * provider, raw frames, Pi install, queue delivery or external messaging.
 * Default PGLITE_MODULE_PATH=<outside-repo>/.../dist/index.js; actual PostgreSQL
 * requires the exact disposable localhost opt-in below. Neither is a race proof. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const actualPostgres = process.env.THALASSA_DISPOSABLE_RADAR_SNAPSHOT_TEST === '1';
let postgresVersion = null;
async function isolatedDatabase() {
    if (!actualPostgres) {
        if (
            !process.env.PGLITE_MODULE_PATH ||
            process.env.RADAR_SNAPSHOT_TEST_DATABASE_URL ||
            process.env.PG_MODULE_PATH
        )
            throw new Error('Explicit isolated PGlite module or opted-in disposable PostgreSQL fixture required.');
        const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
        return new PGlite();
    }
    const url = new URL(process.env.RADAR_SNAPSHOT_TEST_DATABASE_URL ?? 'http://invalid');
    if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.port !== '5432' ||
        url.pathname !== '/radar137_snapshot_test' ||
        url.username !== 'postgres' ||
        url.password !== 'fixture-only-password' ||
        url.search ||
        url.hash ||
        !process.env.PG_MODULE_PATH
    )
        throw new Error('Only the explicit empty localhost radar137_snapshot_test fixture is allowed.');
    const module = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
        Client = module.Client ?? module.default.Client;
    const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    await client.connect();
    try {
        const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
        const tables = (
            await client.query("SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname IN ('public','auth')")
        ).rows[0].count;
        postgresVersion = (await client.query('SHOW server_version')).rows[0].server_version;
        if (database !== 'radar137_snapshot_test' || tables !== 0 || !/^17\.6(?:\D|$)/.test(postgresVersion))
            throw new Error('Refuse a nonempty or different PostgreSQL fixture.');
        return {
            exec: (sql) => client.query(sql),
            query: (sql, args) => client.query(sql, args),
            close: () => client.end(),
        };
    } catch (error) {
        await client.end();
        throw error;
    }
}
const db = await isolatedDatabase();
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001',
    other = '00000000-0000-4000-8000-000000000099',
    pi = '00000000-0000-4000-8000-000000000002',
    otherPi = '00000000-0000-4000-8000-000000000022',
    relay = 'fictional-relay-identity';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const contextFor = (who = owner, device = pi, selected = relay) => ({
    binding: {
        ownerId: who,
        piDeviceId: device,
        pairingId: hash(JSON.stringify([who, device, selected])),
        deviceId: '00000000-0000-4000-8000-000000000003',
        enrollmentRevision: 'a'.repeat(64),
        feedId: `pi:${device}:` + 'b'.repeat(24),
    },
    configurationRevision: '00000000-0000-4000-8000-000000000004',
    instance: '00000000-0000-4000-8000-000000000005',
    watchEpoch: 'c'.repeat(32),
});
const context = contextFor();
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
const snapshot = (uid = owner, device = pi) =>
    as('authenticated', uid, 'SELECT public.pi_radar_owner_snapshot($1)', [device]);
const call = (request) =>
    as('service_role', null, 'SELECT public.pi_radar_apply($1,$2,$3::jsonb)', [owner, relay, JSON.stringify(request)]);
const denied = async (fn, label) => {
    await assert.rejects(fn, (error) => error.code === '42501', label);
    checks++;
};
async function unavailable(label, uid = owner, device = pi) {
    const s = await snapshot(uid, device);
    eq(s.owner, null, label + ' owner unavailable');
    eq(s.alarms, [], label + ' no facts');
    eq(
        [s.context, s.contextRevision, s.evaluatedAt, s.retired, s.more],
        [null, null, null, false, false],
        label + ' never positive OFF',
    );
    return s;
}
async function fresh(revision) {
    await db.query(
        'UPDATE public.pi_radar_contexts SET retired=false,evaluated_at_ms=$1,updated_at=now(),profile=$2::jsonb WHERE relay_id=$3',
        [Date.now(), JSON.stringify(context), relay],
    );
    return revision;
}
async function alarm(serial, kind = 'radar-collision') {
    const at = Date.now(),
        a = {
            contactKey: 'radar:pi:' + 'd'.repeat(32) + ':RA:' + serial,
            episodeId: context.watchEpoch + ':' + serial,
            kind,
            raisedAt: at - 600000 + serial,
            sourceAt: at - 1000,
            reportAt: at - 500,
            cpaNm: 0.05,
            tcpaMin: 3,
            rangeNm: 0.5,
            bearingDeg: 0,
            lost: null,
        };
    return {
        ...a,
        key: await scalar('SELECT public.pi_radar_episode_key($1::jsonb,$2::jsonb)', [
            JSON.stringify(context),
            JSON.stringify(a),
        ]),
    };
}
try {
    await db.exec(await read('../../tests/sql/pi-wake-base.sql'));
    await db.exec(
        "ALTER TABLE public.pi_diary_relays ADD COLUMN token_hash text;UPDATE public.pi_diary_relays SET token_hash=repeat('e',64);ALTER TABLE public.pi_diary_relays ENABLE ROW LEVEL SECURITY;DELETE FROM public.push_device_tokens;",
    );
    await db.exec(await read('../migrations/20261016154726_pi_wake_keeper_relay.sql'));
    await db.exec(await read('../migrations/20261016171434_pi_radar_relay.sql'));
    await db.exec(await read('../migrations/20261016171437_pi_radar_owner_snapshot.sql'));
    eq(
        await scalar("SELECT prosecdef FROM pg_proc WHERE oid='public.pi_radar_owner_snapshot(uuid)'::regprocedure"),
        false,
        'public read remains invoker/RLS',
    );
    eq(
        await scalar(
            "SELECT prosecdef FROM pg_proc WHERE oid='thalassa_radar_private.owner_relay_enabled(text)'::regprocedure",
        ),
        true,
        'only fixed ownership boolean is definer',
    );
    for (const role of ['anon', 'authenticated']) {
        eq(
            await scalar("SELECT has_table_privilege($1,'public.pi_diary_relays','SELECT')", [role]),
            false,
            role + ' no credential table grant',
        );
        eq(
            await scalar("SELECT has_column_privilege($1,'public.pi_diary_relays','token_hash','SELECT')", [role]),
            false,
            role + ' no credential column grant',
        );
        eq(
            await scalar("SELECT has_table_privilege($1,'public.pi_radar_events','INSERT,UPDATE,DELETE')", [role]),
            false,
            role + ' cannot change radar facts',
        );
    }
    await denied(() => as('anon', null, 'SELECT public.pi_radar_owner_snapshot($1)', [pi]), 'anonymous RPC denied');
    await denied(
        () => as('anon', null, 'SELECT thalassa_radar_private.owner_relay_enabled($1)', [relay]),
        'anonymous helper denied',
    );
    await denied(
        () => as('authenticated', owner, 'SELECT token_hash FROM public.pi_diary_relays'),
        'owner still cannot read pairing secret',
    );
    eq(
        await as('authenticated', owner, 'SELECT thalassa_radar_private.owner_relay_enabled($1)', [relay]),
        true,
        'own enabled relay boolean',
    );
    eq(
        await as('authenticated', other, 'SELECT thalassa_radar_private.owner_relay_enabled($1)', [relay]),
        false,
        'foreign relay boolean false',
    );
    eq(
        await as('authenticated', null, 'SELECT thalassa_radar_private.owner_relay_enabled($1)', [relay]),
        false,
        'missing owner boolean false',
    );
    eq(
        await as('authenticated', owner, 'SELECT thalassa_radar_private.owner_relay_enabled($1)', [null]),
        false,
        'null relay boolean false',
    );
    const empty = await unavailable('no saved context');
    eq(
        Object.keys(empty).sort(),
        [
            'schema',
            'checkedAt',
            'owner',
            'context',
            'contextRevision',
            'retired',
            'evaluatedAt',
            'more',
            'alarms',
        ].sort(),
        'fixed bounded header',
    );
    eq(empty.schema, 1, 'version1');
    assert(Number.isSafeInteger(empty.checkedAt) && Math.abs(Date.now() - empty.checkedAt) < 2000);
    checks++;
    await unavailable('null requested Pi', owner, null);
    await unavailable('no authenticated UID', null);
    const bound = await call({ family: 'radar', action: 'bind', context, expectedContextRevision: null }),
        revision = bound.contextRevision;
    await unavailable('configured without post-bind evaluation');
    await call({
        family: 'radar',
        action: 'sync',
        context,
        contextRevision: revision,
        evaluatedAt: Date.now(),
        upserts: [],
        acks: [],
        resolved: [],
        more: false,
    });
    const active = await snapshot();
    eq(
        active.owner,
        { ownerId: owner, piDeviceId: pi, pairingId: context.binding.pairingId, feedId: context.binding.feedId },
        'only exact current owner/Pi/feed identity',
    );
    eq(active.context, context, 'exact validated context');
    eq(active.contextRevision, revision, 'current revision');
    eq(active.retired, false, 'empty sync is not OFF');
    eq(active.alarms, [], 'no fabricated facts');
    await unavailable('different selected Pi', owner, otherPi);
    await unavailable('foreign account', other);
    eq(await as('authenticated', other, 'SELECT count(*)::integer FROM public.pi_radar_contexts'), 0, 'context RLS');
    eq(await as('authenticated', other, 'SELECT count(*)::integer FROM public.pi_radar_events'), 0, 'event RLS');
    await db.exec('UPDATE public.pi_diary_relays SET enabled=false');
    await unavailable('disabled relay');
    await db.exec('UPDATE public.pi_diary_relays SET enabled=true');
    await db.query('UPDATE public.pi_diary_relays SET owner_id=$1', [other]);
    await unavailable('relay owner changed');
    await db.query('UPDATE public.pi_diary_relays SET owner_id=$1', [owner]);
    for (const [label, sql, args] of [
        ['old context update', "UPDATE public.pi_radar_contexts SET updated_at=now()-interval '31 seconds'", []],
        ['future context update', "UPDATE public.pi_radar_contexts SET updated_at=now()+interval '2 seconds'", []],
        ['old original evaluation', 'UPDATE public.pi_radar_contexts SET evaluated_at_ms=$1', [Date.now() - 31000]],
        ['future original evaluation', 'UPDATE public.pi_radar_contexts SET evaluated_at_ms=$1', [Date.now() + 2000]],
        ['missing original evaluation', 'UPDATE public.pi_radar_contexts SET evaluated_at_ms=NULL', []],
        ['incoherent retired evaluation', 'UPDATE public.pi_radar_contexts SET retired=true', []],
    ]) {
        await fresh(revision);
        await db.query(sql, args);
        await unavailable(label);
    }
    await fresh(revision);
    await db.query(
        "UPDATE public.pi_radar_contexts SET profile=jsonb_set(profile,'{binding,pairingId}',to_jsonb($1::text))",
        ['f'.repeat(64)],
    );
    await unavailable('pairing digest mismatch');
    await fresh(revision);
    const shadow = 'fictional-shadow-identity',
        shadowContext = contextFor(owner, pi, shadow);
    await db.query('INSERT INTO public.pi_diary_relays(relay_id,owner_id,enabled) VALUES($1,$2,true)', [shadow, owner]);
    await db.query(
        'INSERT INTO public.pi_radar_contexts(relay_id,owner_id,profile,evaluated_at_ms) VALUES($1,$2,$3::jsonb,$4)',
        [shadow, owner, JSON.stringify(shadowContext), Date.now()],
    );
    await unavailable('two fresh enabled aliases');
    await db.query("UPDATE public.pi_radar_contexts SET updated_at=now()-interval '1 day' WHERE relay_id=$1", [shadow]);
    await unavailable('cannot choose newest over an old enabled alias');
    await db.query('UPDATE public.pi_diary_relays SET enabled=false WHERE relay_id=$1', [shadow]);
    eq((await snapshot()).owner?.piDeviceId, pi, 'explicitly disabled alias does not compete');
    await db.query('UPDATE public.pi_diary_relays SET enabled=true,owner_id=$1 WHERE relay_id=$2', [other, shadow]);
    eq((await snapshot()).owner?.piDeviceId, pi, 'another owner relay cannot compete');
    const a = await alarm(1);
    await call({
        family: 'radar',
        action: 'sync',
        context,
        contextRevision: revision,
        evaluatedAt: Date.now(),
        upserts: [a],
        acks: [],
        resolved: [],
        more: false,
    });
    const first = (await snapshot()).alarms[0];
    eq(first, { ...a, ackedAt: null }, 'original fixed facts and clocks');
    eq(
        Object.keys(first).sort(),
        [
            'key',
            'contactKey',
            'episodeId',
            'kind',
            'raisedAt',
            'sourceAt',
            'reportAt',
            'cpaNm',
            'tcpaMin',
            'rangeNm',
            'bearingDeg',
            'lost',
            'ackedAt',
        ].sort(),
        'no raw frames/names/positions/URLs',
    );
    eq(
        await as('authenticated', other, 'SELECT public.acknowledge_pi_radar_alarm($1,$2)', [a.key, revision]),
        0,
        'foreign ACK cannot mutate',
    );
    eq(
        await as('authenticated', owner, 'SELECT public.acknowledge_pi_radar_alarm($1,$2)', [a.key, revision]),
        1,
        'existing exact owner ACK',
    );
    const acked = await snapshot();
    assert(Number.isSafeInteger(acked.alarms[0].ackedAt));
    checks++;
    await new Promise((r) => setTimeout(r, 20));
    eq((await snapshot()).alarms[0].ackedAt, acked.alarms[0].ackedAt, 'new receipt never restarts ACK mute clock');
    const originalSource = Date.now() - 60000;
    await db.query('UPDATE public.pi_radar_events SET source_at_ms=$1,report_at_ms=$1 WHERE alarm_key=$2', [
        originalSource,
        a.key,
    ]);
    eq((await snapshot()).alarms[0].sourceAt, originalSource, 'stale assessment stays dated old under fresh context');
    eq((await snapshot()).alarms[0].lost, null, 'read never invents feed-state measurement');
    await db.query(
        "UPDATE public.pi_radar_events SET lost='report-too-old',cpa_nm=NULL,tcpa_min=NULL,range_nm=NULL,bearing_deg=NULL WHERE alarm_key=$1",
        [a.key],
    );
    eq((await snapshot()).alarms[0].lost, 'report-too-old', 'stored unknown/lost reason preserved');
    eq((await snapshot()).alarms[0].cpaNm, null, 'unknown never blank-zero');
    const batch = [];
    for (let i = 2; i <= 54; i++) batch.push(await alarm(i, i % 3 === 0 ? 'radar-close-quarters' : 'radar-collision'));
    for (let i = 0; i < batch.length; i += 8)
        await call({
            family: 'radar',
            action: 'sync',
            context,
            contextRevision: revision,
            evaluatedAt: Date.now(),
            upserts: batch.slice(i, i + 8),
            acks: [],
            resolved: [],
            more: true,
        });
    const capped = await snapshot();
    eq(capped.alarms.length, 20, '54 open contacts stay under20 fact bound');
    eq(capped.more, true, 'overflow is explicit');
    eq(capped.alarms[0].kind, 'radar-close-quarters', 'danger priority first');
    const kept = capped.alarms[0];
    await as('authenticated', owner, 'SELECT public.acknowledge_pi_radar_alarm($1,$2)', [kept.key, revision]);
    eq(
        (await snapshot()).alarms.some((f) => f.key === kept.key && f.ackedAt !== null),
        true,
        'ACKed active rows still reported within bounded priority cohort',
    );
    const countBefore = await scalar('SELECT count(*)::integer FROM public.pi_radar_events');
    await snapshot();
    eq(
        await scalar('SELECT count(*)::integer FROM public.pi_radar_events'),
        countBefore,
        'snapshot cannot alter events',
    );
    await db.exec("UPDATE public.pi_radar_events SET resolved_at=now(),resolved_reason='passed'");
    eq((await snapshot()).alarms, [], 'resolved rows excluded');
    eq((await snapshot()).more, false, 'exact empty bound');
    const retired = await call({ family: 'radar', action: 'retire', context, contextRevision: revision });
    const off = await snapshot();
    eq(off.retired, true, 'fresh explicit retirement can prove OFF');
    eq(off.context, context, 'same reviewed profile retained');
    eq(off.contextRevision, retired.contextRevision, 'retirement revision exact');
    eq(off.evaluatedAt, null, 'retired is not an evaluated sensor state');
    eq(off.alarms, [], 'retirement has no current alarm facts');
    await db.exec(
        "UPDATE public.pi_radar_contexts SET updated_at=now()-interval '31 seconds' WHERE relay_id='fictional-relay-identity'",
    );
    await unavailable('old retirement cannot keep saying OFF');
    eq(
        await scalar('SELECT count(*)::integer FROM public.push_notification_queue'),
        0,
        'fixture sent/queued no notification',
    );
    console.log(
        JSON.stringify({
            checks,
            fixtureContacts: 54,
            maxSnapshotFacts: 20,
            isolated: true,
            postgres: postgresVersion,
            postgresConcurrency: false,
            productWrites: 0,
            notifications: 0,
        }),
    );
} finally {
    await db.close();
}
