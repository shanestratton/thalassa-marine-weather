/** Isolated PostgreSQL WASM syntax/behavior proof. Single session is NOT concurrency proof.
 * PGLITE_MODULE_PATH=<outside-repo>/.../dist/index.js node --import tsx scripts/check-pi-wake-db.mjs
 * No credentials, product database, provider requests or notifications. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { wakeRelayAlarmKey, WAKE_KINDS } from '../supabase/functions/pi-alarm-relay/wake-contract.ts';
const modulePath = process.env.PGLITE_MODULE_PATH;
if (!modulePath) throw new Error('Set PGLITE_MODULE_PATH to an isolated pinned PGlite installation.');
const { PGlite } = await import(pathToFileURL(modulePath).href),
    db = new PGlite();
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001',
    other = '00000000-0000-4000-8000-000000000099',
    pi = '00000000-0000-4000-8000-000000000002',
    relay = 'fictional-relay-identity';
const hash = (s) => createHash('sha256').update(s).digest('hex');
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
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const scalar = async (sql, params = []) => Object.values((await query(sql, params))[0])[0];
const as = async (role, uid, sql, params = []) => {
    await db.exec(`RESET ROLE;SELECT set_config('request.jwt.claim.sub','${uid ?? ''}',false);SET ROLE ${role};`);
    try {
        return await scalar(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
};
const call = (request) =>
    as('service_role', null, 'SELECT public.pi_wake_apply($1,$2,$3::jsonb)', [owner, relay, JSON.stringify(request)]);
const states = () => Object.keys(WAKE_KINDS).map((kind) => ({ kind, status: 'watching', quiet: false, alarm: null }));
async function sync(
    revision,
    profile = context,
    active = ['wake-wind'],
    sourceAt = Date.now(),
    raisedAt = sourceAt - 1000,
) {
    const rows = states();
    for (const kind of active) {
        const row = rows.find((r) => r.kind === kind);
        row.status = 'active';
        row.alarm = {
            key: await wakeRelayAlarmKey(profile, kind, 'd'.repeat(64), raisedAt),
            sourceKey: 'd'.repeat(64),
            raisedAt,
            sourceAt,
            value: {
                'wake-depth': 1,
                'wake-wind': 30,
                'wake-speed': 1,
                'wake-pressure': 4,
                'wake-coolant': 110,
                'wake-oil': 50,
                'wake-rpm': 5000,
                'wake-battery': 10,
            }[kind],
            threshold: {
                'wake-depth': 3,
                'wake-wind': 25,
                'wake-speed': 2,
                'wake-pressure': 3,
                'wake-coolant': 100,
                'wake-oil': 100,
                'wake-rpm': 4000,
                'wake-battery': 12,
            }[kind],
            depthBasis: kind === 'wake-depth' ? 'conservative-full-draft' : null,
            ackedAt: null,
        };
    }
    return {
        family: 'wake',
        action: 'sync',
        context: profile,
        contextRevision: revision,
        evaluatedAt: sourceAt,
        higherPriority: 'none',
        states: rows,
    };
}
try {
    await db.exec(await read('tests/sql/pi-wake-base.sql'));
    await db.exec(await read('supabase/migrations/20261016154726_pi_wake_keeper_relay.sql'));
    eq(await as('service_role', null, 'SELECT public.pi_alarm_wake_capability()'), 1, 'reviewed schema capability');
    for (const role of ['anon', 'authenticated']) {
        eq(
            await scalar("SELECT has_function_privilege($1,'public.pi_wake_apply(uuid,text,jsonb)','EXECUTE')", [role]),
            false,
            `${role} cannot apply`,
        );
        eq(
            await scalar("SELECT has_table_privilege($1,'public.pi_wake_events','INSERT,UPDATE,DELETE')", [role]),
            false,
            `${role} cannot mutate events`,
        );
    }
    eq(
        await as(
            'anon',
            null,
            "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='pi_wake_events' AND privilege_type='SELECT'",
        ),
        0,
        'anonymous no read grant',
    );
    const probe = await call({ family: 'wake', action: 'probe' });
    eq(probe.context, null, 'initial no old context');
    eq(probe.devices, 1, 'registered devices counted');
    const bound = await call({ family: 'wake', action: 'bind', context, expectedContextRevision: null }),
        revision = bound.contextRevision;
    assert.match(revision, /^[a-f0-9-]{36}$/);
    checks++;
    eq(
        (await call({ family: 'wake', action: 'bind', context, expectedContextRevision: null })).contextRevision,
        revision,
        'lost bind response retry idempotent',
    );
    let request = await sync(revision),
        answer = await call(request);
    eq(answer.queued.length, 1, 'first qualified alarm queued');
    const key = request.states.find((s) => s.alarm)?.alarm.key,
        queue = answer.queued[0];
    eq(
        await as('service_role', null, 'SELECT public.pi_wake_delivery_current($1)', [queue]),
        true,
        'fresh exact episode deliverable',
    );
    eq((await call(request)).queued.length, 0, 'repeat original sample no duplicate push');
    // Check the real SQL clock policy independently from Pi's quiet boolean.
    const night = { startMinute: 1380, endMinute: 360, utcOffsetMinutes: 600 };
    for (const [utc, expected] of [
        ['2026-10-17T12:59:59Z', false],
        ['2026-10-17T13:00:00Z', true],
        ['2026-10-17T19:59:59Z', true],
        ['2026-10-17T20:00:00Z', false],
    ]) {
        eq(
            await scalar('SELECT public.pi_wake_quiet($1::jsonb,$2::timestamptz)', [JSON.stringify(night), utc]),
            expected,
            `fixed offset quiet boundary ${utc}`,
        );
    }
    const minute = await scalar('SELECT mod(floor(extract(epoch FROM now())/60),1440)::int');
    const quietContext = structuredClone(context);
    quietContext.rules[1].quietHours = { startMinute: minute, endMinute: (minute + 1) % 1440, utcOffsetMinutes: 0 };
    // Isolated service fixture simulates a queued row crossing the quiet boundary
    // without sleeping or changing a product clock. The queue's quiet flag stays false.
    await db.query('UPDATE public.pi_wake_contexts SET profile=$1::jsonb WHERE relay_id=$2', [
        JSON.stringify(quietContext),
        relay,
    ]);
    eq(
        await as('service_role', null, 'SELECT public.pi_wake_delivery_current($1)', [queue]),
        false,
        'retry guard enforces current quiet policy even when earlier Pi flag was false',
    );
    await db.query('UPDATE public.pi_wake_contexts SET profile=$1::jsonb WHERE relay_id=$2', [
        JSON.stringify(context),
        relay,
    ]);
    const text = await scalar('SELECT body FROM public.push_notification_queue WHERE id=$1', [queue]);
    assert.match(text, /True wind 30\.00 kn; setting 25\.00 kn/);
    checks++;
    eq(
        await as('authenticated', other, 'SELECT public.acknowledge_pi_wake_alarm($1,$2)', [key, context.rulesDigest]),
        0,
        'foreign owner cannot acknowledge',
    );
    eq(await as('authenticated', other, 'SELECT count(*) FROM public.pi_wake_events'), 0, 'foreign owner RLS');
    eq(await as('authenticated', owner, 'SELECT count(*) FROM public.pi_wake_events'), 1, 'own event readable');
    const unknown = structuredClone(request);
    unknown.evaluatedAt = Date.now();
    unknown.states.find((s) => s.kind === 'wake-wind').status = 'unknown';
    unknown.states.find((s) => s.kind === 'wake-wind').alarm.value = null;
    eq((await call(unknown)).queued.length, 0, 'unknown never fires');
    eq(
        await scalar('SELECT resolved_at FROM public.pi_wake_events WHERE alarm_key=$1', [key]),
        null,
        'unknown never clears',
    );
    eq(
        await as('service_role', null, 'SELECT public.pi_wake_delivery_current($1)', [queue]),
        false,
        'unknown refuses already queued delivery',
    );
    request = await sync(
        revision,
        context,
        ['wake-wind'],
        Date.now(),
        request.states.find((s) => s.alarm).alarm.raisedAt,
    );
    await call(request);
    eq(
        await as('authenticated', owner, 'SELECT public.acknowledge_pi_wake_alarm($1,$2)', [key, context.rulesDigest]),
        1,
        'owner exact digest acknowledges',
    );
    eq(
        await as('service_role', null, 'SELECT public.pi_wake_delivery_current($1)', [queue]),
        false,
        'ack immediately refuses queue',
    );
    eq((await call(request)).acked, [key], 'ack propagates only current wake episode');
    await db.exec(
        `INSERT INTO public.pi_alarm_events(owner_id,kind) VALUES('${owner}','collision'),('${owner}','off-route');`,
    );
    const oldLegacy = await scalar('SELECT count(*) FROM public.pi_alarm_events');
    const replacement = { ...context, configurationRevision: '00000000-0000-4000-8000-000000000006' };
    const next = await call({
        family: 'wake',
        action: 'bind',
        context: replacement,
        expectedContextRevision: revision,
    });
    assert.notEqual(next.contextRevision, revision);
    checks++;
    eq(
        (await call({ family: 'wake', action: 'bind', context, expectedContextRevision: revision })).conflict,
        true,
        'delayed old bind cannot overtake replacement',
    );
    eq((await call(await sync(revision))).conflict, true, 'delayed old sync cannot fire');
    answer = await call(await sync(next.contextRevision, replacement));
    eq(answer.queued.length, 0, 'collision priority suppresses wake');
    await db.exec("UPDATE public.pi_alarm_events SET acked_at=now() WHERE kind='collision'");
    const legacySnapshot = await query('SELECT * FROM public.pi_alarm_events ORDER BY kind');
    const quiet = await sync(next.contextRevision, replacement, ['wake-wind'], Date.now());
    quiet.states.find((s) => s.kind === 'wake-wind').quiet = true;
    eq((await call(quiet)).queued.length, 0, 'quiet suppresses delivery');
    const all = await sync(next.contextRevision, replacement, Object.keys(WAKE_KINDS), Date.now());
    answer = await call(all);
    eq(answer.queued.length, 1, 'depth wins and suppresses other wake presets in same batch');
    const depthKey = all.states.find((s) => s.kind === 'wake-depth').alarm.key;
    await as('authenticated', owner, 'SELECT public.acknowledge_pi_wake_alarm($1,$2)', [
        depthKey,
        replacement.rulesDigest,
    ]);
    answer = await call(all);
    eq(answer.queued.length, 3, 'four new rest pushes/hour includes the earlier wind push; depth has its own budget');
    const noRows = states();
    await call({ ...all, evaluatedAt: Date.now(), states: noRows });
    eq(
        await scalar('SELECT count(*) FROM public.pi_wake_events WHERE resolved_at IS NULL'),
        0,
        'fresh clear retires only wake events',
    );
    eq(oldLegacy, 2, 'legacy families existed');
    eq(
        await query('SELECT * FROM public.pi_alarm_events ORDER BY kind'),
        legacySnapshot,
        'wake clear never touches AIS/underway event or ack state',
    );
    const invalid = await sync(next.contextRevision, replacement);
    invalid.states[1].alarm.value = -10;
    await assert.rejects(call(invalid));
    checks++;
    eq(
        await scalar('SELECT count(*) FROM public.pi_wake_events WHERE resolved_at IS NULL'),
        0,
        'invalid batch is atomic',
    );
    const retired = await call({
        family: 'wake',
        action: 'retire',
        context: replacement,
        contextRevision: next.contextRevision,
    });
    eq(retired.retired, true, 'explicit stand-down leaves a durable context tombstone');
    assert.notEqual(retired.contextRevision, next.contextRevision);
    checks++;
    eq((await call({ family: 'wake', action: 'probe' })).retired, true, 'probe distinguishes retired context');
    eq(
        (await call(await sync(next.contextRevision, replacement))).conflict,
        true,
        'delayed active sync cannot overtake retirement',
    );
    eq(
        (
            await call({
                family: 'wake',
                action: 'bind',
                context: replacement,
                expectedContextRevision: next.contextRevision,
            })
        ).conflict,
        true,
        'old bind cannot overtake retirement',
    );
    const rebound = await call({
        family: 'wake',
        action: 'bind',
        context: replacement,
        expectedContextRevision: retired.contextRevision,
    });
    eq(rebound.bound, true, 'fresh exact CAS can explicitly bind after retirement');
    eq(
        (await call({ family: 'wake', action: 'retire', context: replacement, contextRevision: next.contextRevision }))
            .conflict,
        true,
        'delayed old retirement cannot clear replacement',
    );
    const silent = structuredClone(replacement);
    silent.configurationRevision = '00000000-0000-4000-8000-000000000007';
    silent.rules[1].quietHours = { startMinute: minute, endMinute: (minute + 1) % 1440, utcOffsetMinutes: 0 };
    const silentBind = await call({
        family: 'wake',
        action: 'bind',
        context: silent,
        expectedContextRevision: rebound.contextRevision,
    });
    eq(
        (await call(await sync(silentBind.contextRevision, silent))).queued.length,
        0,
        'server quiet schedule suppresses enqueue even if Pi sends quiet false',
    );
    await db.exec(`UPDATE public.pi_diary_relays SET enabled=false WHERE relay_id='${relay}'`);
    await assert.rejects(call({ family: 'wake', action: 'probe' }));
    checks++;
    console.log(
        JSON.stringify({
            checks,
            engine: 'PGlite0.5.8',
            concurrencyProven: false,
            productDatabaseUsed: false,
            notificationsSent: 0,
        }),
    );
} catch (error) {
    const source = await read('supabase/migrations/20261016154726_pi_wake_keeper_relay.sql');
    console.error(
        JSON.stringify({
            message: error.message,
            code: error.code,
            position: error.position,
            where: error.where,
            sourceContext: error.position
                ? source.slice(Math.max(0, Number(error.position) - 100), Number(error.position) + 100)
                : undefined,
        }),
    );
    process.exitCode = 1;
} finally {
    await db.close();
}
