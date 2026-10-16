/** ACTUAL disposable PostgreSQL17.6 concurrency proof, no product DB/notifications.
 * Requires an empty localhost database named wake137_test and explicit opt-in.
 * Run with tsx; PG_MODULE_PATH points to an outside-repo pinned node-postgres installation.
 * The source fixture has no HTTP extension, webhook or APNs credentials. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { WAKE_KINDS, wakeRelayAlarmKey } from '../supabase/functions/pi-alarm-relay/wake-contract.ts';
const url = new URL(process.env.WAKE_TEST_DATABASE_URL ?? 'http://invalid');
if (
    process.env.THALASSA_DISPOSABLE_WAKE_TEST !== '1' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/wake137_test' ||
    !process.env.PG_MODULE_PATH
)
    throw new Error('Only the explicit empty localhost wake137_test fixture is allowed.');
const module = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
    Pool = module.Pool ?? module.default.Pool;
const pool = new Pool({ connectionString: url.href, max: 18, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001',
    pi = '00000000-0000-4000-8000-000000000002',
    relay = 'fictional-relay-identity';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const context = {
    binding: {
        ownerId: owner,
        piDeviceId: pi,
        pairingId: hash(JSON.stringify([owner, pi, relay])),
        deviceId: '00000000-0000-4000-8000-000000000003',
        enrollmentRevision: 'a'.repeat(64),
        feedId: `pi:${pi}:` + 'b'.repeat(24),
    },
    rulesDigest: 'c'.repeat(64),
    configurationRevision: '00000000-0000-4000-8000-000000000004',
    instance: '00000000-0000-4000-8000-000000000005',
    rules: Object.keys(WAKE_KINDS).map((kind, i) => ({
        kind,
        enabled: true,
        sourceKey: 'd'.repeat(64),
        threshold: [3, 25, 2, 3, 100, 100, 4000, 12][i],
        quietHours: null,
    })),
};
let checks = 0;
const eq = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await pool.query(sql, args)).rows[0])[0];
async function call(request) {
    const client = await pool.connect();
    try {
        await client.query('SET ROLE service_role');
        return (
            await client.query('SELECT public.pi_wake_apply($1,$2,$3::jsonb) AS answer', [
                owner,
                relay,
                JSON.stringify(request),
            ])
        ).rows[0].answer;
    } finally {
        await client.query('RESET ROLE');
        client.release();
    }
}
async function sync(revision, profile = context, offset = 0, at = Date.now()) {
    const states = Object.keys(WAKE_KINDS).map((kind) => ({ kind, status: 'watching', quiet: false, alarm: null }));
    const raisedAt = at - 1000 - offset,
        sourceKey = 'd'.repeat(64);
    states[1] = {
        kind: 'wake-wind',
        status: 'active',
        quiet: false,
        alarm: {
            key: await wakeRelayAlarmKey(profile, 'wake-wind', sourceKey, raisedAt),
            sourceKey,
            sourceAt: at,
            raisedAt,
            value: 30,
            threshold: 25,
            depthBasis: null,
            ackedAt: null,
        },
    };
    return {
        family: 'wake',
        action: 'sync',
        context: profile,
        contextRevision: revision,
        evaluatedAt: at,
        higherPriority: 'none',
        states,
    };
}
try {
    eq(await scalar('SELECT current_database()'), 'wake137_test', 'isolated fixture name');
    eq(
        await scalar("SELECT count(*)::int FROM pg_tables WHERE schemaname='public'"),
        0,
        'refuse existing product schema',
    );
    const version = String(await scalar('SHOW server_version'));
    assert.match(version, /^17\.6(?:\D|$)/);
    checks++;
    await pool.query(await read('tests/sql/pi-wake-base.sql'));
    await pool.query(await read('supabase/migrations/20261016154726_pi_wake_keeper_relay.sql'));
    const bound = await call({ family: 'wake', action: 'bind', context, expectedContextRevision: null }),
        revision = bound.contextRevision;
    // Same eval clock deliberately avoids the independent out-of-order-clock
    // conflict fence: all16 compete for the four-slot atomic rest budget.
    const at = Date.now(),
        requests = await Promise.all(Array.from({ length: 16 }, (_, i) => sync(revision, context, i, at)));
    const raced = await Promise.all(requests.map(call));
    eq(
        raced.reduce((n, r) => n + (r.queued?.length ?? 0), 0),
        4,
        'exactly four first rest pushes across16 concurrent transactions',
    );
    eq(
        await scalar("SELECT count(*)::int FROM push_notification_queue WHERE notification_type='wake_alarm'"),
        4,
        'queue count matches claimed budget',
    );
    eq(
        await scalar('SELECT count(*)::int FROM pi_wake_events WHERE resolved_at IS NULL'),
        1,
        'one current wind episode after competing revisions',
    );
    const a = { ...context, configurationRevision: '00000000-0000-4000-8000-000000000011' },
        b = { ...context, configurationRevision: '00000000-0000-4000-8000-000000000012' };
    const binds = await Promise.all(
        [a, b].map((profile) =>
            call({ family: 'wake', action: 'bind', context: profile, expectedContextRevision: revision }),
        ),
    );
    eq(binds.filter((r) => r.bound === true).length, 1, 'only one of two CAS replacements commits');
    eq(binds.filter((r) => r.conflict === true).length, 1, 'losing CAS remains reviewable');
    eq((await call(await sync(revision))).conflict, true, 'late old sync cannot resurrect old profile');
    const currentIndex = binds.findIndex((r) => r.bound),
        profile = [a, b][currentIndex],
        next = binds[currentIndex].contextRevision;
    const retire = await call({ family: 'wake', action: 'retire', context: profile, contextRevision: next });
    eq(retire.retired, true, 'retirement CAS committed');
    eq((await call(await sync(next, profile))).conflict, true, 'late active request cannot overtake retirement');
    eq(
        await scalar('SELECT count(*)::int FROM pi_wake_events WHERE resolved_at IS NULL'),
        0,
        'retired profile has no open episode',
    );
    const queueIds = (
        await pool.query("SELECT id FROM push_notification_queue WHERE notification_type='wake_alarm'")
    ).rows.map((r) => r.id);
    for (const id of queueIds)
        eq(
            await scalar('SELECT public.pi_wake_delivery_current($1)', [id]),
            false,
            'old queued episode cannot deliver',
        );
    eq(await scalar('SELECT count(*)::int FROM pi_alarm_events'), 0, 'legacy alarm families untouched');
    console.log(
        JSON.stringify({
            checks,
            postgres: version,
            parallelTransactions: 16,
            quotaQueued: 4,
            competingBinds: 2,
            productDatabaseUsed: false,
            notificationsSent: 0,
        }),
    );
} catch (error) {
    console.error(
        JSON.stringify({
            code: error.code ?? 'assertion',
            message: String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted-db-url]'),
        }),
    );
    process.exitCode = 1;
} finally {
    await pool.end();
}
