/** Actual isolated PostgreSQL17.6 proof. No product database or notification path.
 * Only an empty localhost database radar137_test with the explicit opt-in is accepted. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { radarRelayKeyCanonical } from '../utils/radarRelayContract.ts';
const url = new URL(process.env.RADAR_TEST_DATABASE_URL ?? 'http://invalid');
if (
    process.env.THALASSA_DISPOSABLE_RADAR_TEST !== '1' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/radar137_test' ||
    !process.env.PG_MODULE_PATH
)
    throw new Error('Only the explicit empty localhost radar137_test fixture is allowed.');
const pg = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
    Pool = pg.Pool ?? pg.default.Pool;
const pool = new Pool({ connectionString: url.href, max: 18, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
const read = (p) => readFile(new URL('../' + p, import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001',
    relay = 'fictional-relay-identity';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const context = {
    binding: {
        ownerId: owner,
        piDeviceId: '00000000-0000-4000-8000-000000000002',
        pairingId: '',
        deviceId: '00000000-0000-4000-8000-000000000003',
        enrollmentRevision: 'a'.repeat(64),
        feedId: 'pi:00000000-0000-4000-8000-000000000002:' + 'b'.repeat(24),
    },
    configurationRevision: '00000000-0000-4000-8000-000000000004',
    instance: '00000000-0000-4000-8000-000000000005',
    watchEpoch: 'c'.repeat(32),
};
context.binding.pairingId = hash(JSON.stringify([owner, context.binding.piDeviceId, relay]));
let checks = 0;
const eq = (a, b, label) => {
    assert.deepEqual(a, b, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await pool.query(sql, args)).rows[0])[0];
async function service(sql, args = []) {
    const c = await pool.connect();
    try {
        await c.query('SET ROLE service_role');
        return Object.values((await c.query(sql, args)).rows[0])[0];
    } finally {
        await c.query('RESET ROLE');
        c.release();
    }
}
const call = (r) => service('SELECT public.pi_radar_apply($1,$2,$3::jsonb)', [owner, relay, JSON.stringify(r)]);
const alarm = (serial, at) => {
    const a = {
        contactKey: 'radar:pi:' + 'd'.repeat(32) + ':RA:' + serial,
        episodeId: context.watchEpoch + ':' + serial,
        kind: 'radar-collision',
        raisedAt: at - 1000,
        sourceAt: at - 50,
        reportAt: at,
        cpaNm: 0.05,
        tcpaMin: 3,
        rangeNm: 0.5,
        bearingDeg: 0,
        lost: null,
    };
    return { ...a, key: `${a.kind}:${hash(radarRelayKeyCanonical(context, a)).slice(0, 12)}:${a.raisedAt}` };
};
const sync = (revision, upserts, at, profile = context) => ({
    family: 'radar',
    action: 'sync',
    context: profile,
    contextRevision: revision,
    evaluatedAt: at,
    upserts,
    acks: [],
    resolved: [],
    more: false,
});
async function seed(count, resend = false) {
    for (let i = 0; i < count; i++)
        await service(
            'INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,data) VALUES($1,$2,$3::jsonb) RETURNING id',
            [owner, ['collision_alarm', 'distress_alarm', 'underway_alarm'][i % 3], JSON.stringify({ resend })],
        );
}
async function legacy(i, resend) {
    try {
        await service(
            'INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,data) VALUES($1,$2,$3::jsonb) RETURNING id',
            [owner, ['collision_alarm', 'distress_alarm', 'underway_alarm'][i % 3], JSON.stringify({ resend })],
        );
        return 1;
    } catch (e) {
        if (e.code === 'P0001') return 0;
        throw e;
    }
}
try {
    eq(await scalar('SELECT current_database()'), 'radar137_test', 'exact disposable database');
    eq(await scalar("SELECT count(*)::int FROM pg_tables WHERE schemaname='public'"), 0, 'refuse an existing schema');
    const version = String(await scalar('SHOW server_version'));
    assert.match(version, /^17\.6(?:\D|$)/);
    checks++;
    await pool.query(await read('tests/sql/pi-wake-base.sql'));
    await pool.query(await read('supabase/migrations/20261016154726_pi_wake_keeper_relay.sql'));
    const sql = await read('supabase/held-migrations/20261016162758_pi_radar_relay.sql');
    await pool.query(sql);
    eq(await service('SELECT public.pi_alarm_radar_capability()'), 1, 'closed schema capability');
    const revision = (await call({ family: 'radar', action: 'bind', context, expectedContextRevision: null }))
        .contextRevision;
    //16 actual competing statements mix new radar transactions with unchanged legacy
    //queue inserts. Both must participate in the SAME owner lock and unchanged cap.
    await seed(26);
    let at = Date.now();
    const mixed = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
            i % 2 === 0 ? legacy(i, false) : call(sync(revision, [alarm(i + 1, at)], at)).then((r) => r.queued.length),
        ),
    );
    eq(
        mixed.reduce((s, n) => s + n, 0),
        4,
        'exactly four remaining new slots across mixed callers',
    );
    eq(
        await scalar(
            "SELECT count(*)::int FROM public.push_notification_queue WHERE coalesce(data->>'resend','false')='false'",
        ),
        30,
        'shared 30-new budget cannot overshoot',
    );
    await pool.query('DELETE FROM public.push_notification_queue');
    await seed(18, true);
    const resends = await Promise.all(Array.from({ length: 16 }, (_, i) => legacy(i, true)));
    eq(
        resends.reduce((s, n) => s + n, 0),
        2,
        'exactly two remaining resend slots across16 callers',
    );
    eq(await scalar('SELECT count(*)::int FROM public.push_notification_queue'), 20, '20 resends remain separate');
    await pool.query('DELETE FROM public.push_notification_queue');
    at = Date.now();
    const same = alarm(100, at),
        sameResults = await Promise.all(Array.from({ length: 16 }, () => call(sync(revision, [same], at))));
    eq(
        sameResults.reduce((s, r) => s + r.queued.length, 0),
        1,
        'same canonical episode queues once across16 statements',
    );
    eq(
        await scalar('SELECT pushed_count FROM public.pi_radar_events WHERE alarm_key=$1', [same.key]),
        1,
        'event claim matches actual queue',
    );
    const queue = (
        await pool.query("SELECT id FROM public.push_notification_queue WHERE data->>'alarm_key'=$1", [same.key])
    ).rows[0].id;
    eq(
        await service('SELECT public.pi_radar_delivery_current($1)', [queue]),
        true,
        'current attempt initially allowed',
    );
    const alternatives = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'].map(
        (configurationRevision) => ({ ...context, configurationRevision }),
    );
    const binds = await Promise.all(
        alternatives.map((profile) =>
            call({ family: 'radar', action: 'bind', context: profile, expectedContextRevision: revision }),
        ),
    );
    eq(binds.filter((r) => r.bound === true).length, 1, 'one CAS replacement wins');
    eq(binds.filter((r) => r.conflict === true).length, 1, 'losing CAS remains a conflict');
    eq((await call(sync(revision, [same], Date.now()))).conflict, true, 'old context cannot resurrect');
    eq(
        await service('SELECT public.pi_radar_delivery_current($1)', [queue]),
        false,
        'old queue cannot survive a context replacement',
    );
    const winner = binds.findIndex((r) => r.bound),
        current = binds[winner].contextRevision,
        profile = alternatives[winner];
    const retire = await call({ family: 'radar', action: 'retire', context: profile, contextRevision: current });
    eq(retire.retired, true, 'explicit retirement');
    eq(
        (await call(sync(current, [], Date.now(), profile))).conflict,
        true,
        'late empty sync cannot revive retired watch',
    );
    eq(
        await scalar('SELECT count(*)::int FROM public.pi_radar_events WHERE resolved_at IS NULL'),
        0,
        'retired watch has no open radar event',
    );
    eq(await scalar('SELECT count(*)::int FROM public.pi_alarm_events'), 0, 'legacy event records untouched');
    console.log(
        JSON.stringify({
            checks,
            postgres: version,
            parallelTransactions: 16,
            mixedNewSlots: 4,
            resendSlots: 2,
            sameEpisodeQueues: 1,
            competingBinds: 2,
            sourceSha256: hash(sql),
            productDatabaseUsed: false,
            notificationsSent: 0,
        }),
    );
} catch (e) {
    console.error(
        JSON.stringify({
            code: e.code ?? 'assertion',
            message: String(e.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted-db-url]'),
        }),
    );
    process.exitCode = 1;
} finally {
    await pool.end();
}
