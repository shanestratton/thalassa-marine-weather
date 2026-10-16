/** Disposable PostgreSQL WASM behavior proof. This is NOT a concurrency proof.
 * PGLITE_MODULE_PATH=<isolated-runtime>/dist/index.js node --import tsx scripts/check-pi-radar-db.mjs
 * No product connection, credentials, provider calls, push delivery or Pi writes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { radarRelayKeyCanonical } from '../utils/radarRelayContract.ts';
const modulePath = process.env.PGLITE_MODULE_PATH;
if (!modulePath) throw new Error('Set PGLITE_MODULE_PATH to an isolated pinned PGlite installation.');
const { PGlite } = await import(pathToFileURL(modulePath).href),
    db = new PGlite();
const read = (p) => readFile(new URL('../' + p, import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001',
    other = '00000000-0000-4000-8000-000000000099',
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
const call = (r) =>
    as('service_role', null, 'SELECT public.pi_radar_apply($1,$2,$3::jsonb)', [owner, relay, JSON.stringify(r)]);
const key = (a) => `${a.kind}:${hash(radarRelayKeyCanonical(context, a)).slice(0, 12)}:${a.raisedAt}`;
const alarm = (kind = 'radar-collision', serial = 1, raisedAt = Date.now()) => {
    const a = {
        contactKey: 'radar:pi:' + 'd'.repeat(32) + ':RA:' + serial,
        episodeId: context.watchEpoch + ':' + serial,
        kind,
        raisedAt,
        reportAt: Date.now(),
        sourceAt: Date.now() - 50,
        cpaNm: 0.05,
        tcpaMin: 3,
        rangeNm: 0.5,
        bearingDeg: 0,
        lost: null,
    };
    return { ...a, key: key(a) };
};
const sync = (revision, upserts = [], acks = [], resolved = [], more = false) => ({
    family: 'radar',
    action: 'sync',
    context,
    contextRevision: revision,
    evaluatedAt: Date.now(),
    upserts,
    acks,
    resolved,
    more,
});
const denied = async (fn, label) => {
    await assert.rejects(fn);
    checks++;
};
try {
    await db.exec(await read('tests/sql/pi-wake-base.sql'));
    await db.exec(await read('supabase/migrations/20261016154726_pi_wake_keeper_relay.sql'));
    await db.exec(await read('supabase/held-migrations/20261016162758_pi_radar_relay.sql'));
    eq(
        await as('service_role', null, 'SELECT public.pi_alarm_radar_capability()'),
        1,
        'schema is held but internally complete',
    );
    for (const role of ['anon', 'authenticated']) {
        eq(
            await scalar("SELECT has_function_privilege($1,'public.pi_radar_apply(uuid,text,jsonb)','EXECUTE')", [
                role,
            ]),
            false,
            role + ' no apply',
        );
        eq(
            await scalar("SELECT has_table_privilege($1,'public.pi_radar_events','INSERT,UPDATE,DELETE')", [role]),
            false,
            role + ' no mutation',
        );
    }
    eq(
        await scalar("SELECT has_table_privilege('anon','public.pi_radar_events','SELECT')"),
        false,
        'anonymous no contact history',
    );
    const fixture = JSON.parse(await read('tests/fixtures/radar-relay137.json'));
    eq(
        await as('service_role', null, 'SELECT public.pi_radar_episode_key($1::jsonb,$2::jsonb)', [
            JSON.stringify(fixture.context),
            JSON.stringify(fixture.alarm),
        ]),
        fixture.alarm.key,
        'exact canonical JS/SQL fixture',
    );
    eq((await call({ family: 'radar', action: 'probe' })).context, null, 'read cannot create or arm context');
    const bound = await call({ family: 'radar', action: 'bind', context, expectedContextRevision: null }),
        revision = bound.contextRevision;
    assert.match(revision, /^[0-9a-f-]{36}$/);
    checks++;
    eq(
        (await call({ family: 'radar', action: 'bind', context, expectedContextRevision: null })).contextRevision,
        revision,
        'bind replay is idempotent',
    );
    const changed = { ...context, configurationRevision: '00000000-0000-4000-8000-000000000006' };
    eq(
        (await call({ family: 'radar', action: 'bind', context: changed, expectedContextRevision: null })).conflict,
        true,
        'stale CAS cannot replace context',
    );
    let a = alarm();
    const first = await call(sync(revision, [a]));
    eq(first.queued.length, 1, 'fresh alarm queues once');
    const queue = first.queued[0];
    eq(
        await as('service_role', null, 'SELECT public.pi_radar_delivery_current($1)', [queue]),
        true,
        'fresh current original evidence can deliver',
    );
    eq(
        await as('service_role', null, "SELECT public.pi_wake_priority_blocked($1,'wake-depth')", [owner]),
        true,
        'radar joins higher priority without modifying wake',
    );
    await call(sync(revision, [], [], [], true));
    eq(
        await scalar('SELECT count(*) FROM public.pi_radar_events WHERE resolved_at IS NULL'),
        1,
        'sparse continuation never resolves',
    );
    eq(
        (
            await call(
                sync(revision, [
                    {
                        ...a,
                        reportAt: Date.now(),
                        sourceAt: Date.now() - 20_000,
                        lost: 'report-too-old',
                        cpaNm: null,
                        tcpaMin: null,
                        rangeNm: null,
                        bearingDeg: null,
                    },
                ]),
            )
        ).queued.length,
        0,
        'unknown never queues',
    );
    eq(
        await as('service_role', null, 'SELECT public.pi_radar_delivery_current($1)', [queue]),
        false,
        'queued fresh data cannot survive current sensor loss',
    );
    a = { ...a, sourceAt: Date.now(), reportAt: Date.now() };
    await call(sync(revision, [a]));
    eq(
        await as('authenticated', other, 'SELECT public.acknowledge_pi_radar_alarm($1,$2)', [a.key, revision]),
        0,
        'foreign ACK affects nothing',
    );
    eq(await as('authenticated', other, 'SELECT count(*) FROM public.pi_radar_events'), 0, 'foreign history RLS');
    eq(await as('authenticated', owner, 'SELECT count(*) FROM public.pi_radar_events'), 1, 'own history RLS');
    eq(
        await as('authenticated', owner, 'SELECT public.acknowledge_pi_radar_alarm($1,$2)', [a.key, revision]),
        1,
        'owner exact ACK accepted',
    );
    eq(
        await as('service_role', null, 'SELECT public.pi_radar_delivery_current($1)', [queue]),
        false,
        'ACK retires attempted delivery',
    );
    const close = alarm('radar-close-quarters', 1);
    eq((await call(sync(revision, [close]))).queued.length, 1, 'close escalation owns a new severity identity');
    eq(
        await scalar('SELECT resolved_reason FROM public.pi_radar_events WHERE alarm_key=$1', [a.key]),
        'escalated',
        'old danger becomes permanently resolved',
    );
    eq(
        (
            await call(
                sync(
                    revision,
                    [close],
                    [
                        {
                            key: a.key,
                            contactKey: a.contactKey,
                            episodeId: a.episodeId,
                            kind: a.kind,
                            ackedAt: Date.now(),
                        },
                    ],
                ),
            )
        ).acked,
        [],
        'late old-severity ACK cannot silence escalation',
    );
    eq(
        await scalar('SELECT acked_at FROM public.pi_radar_events WHERE alarm_key=$1', [close.key]),
        null,
        'escalation stays unacknowledged',
    );
    const invalid = { ...close, sourceAt: Date.now() - 15_001, reportAt: Date.now() };
    await denied(() => call(sync(revision, [invalid])), 'fresh arrival cannot renew stale dependency');
    const before = await scalar('SELECT count(*) FROM public.pi_radar_events');
    await denied(() => call(sync(revision, [close, close])), 'duplicate list rejected');
    eq(
        await scalar('SELECT count(*) FROM public.pi_radar_events'),
        before,
        'invalid transaction leaves no partial writes',
    );
    await call(
        sync(
            revision,
            [],
            [],
            [
                {
                    key: close.key,
                    contactKey: close.contactKey,
                    episodeId: close.episodeId,
                    kind: close.kind,
                    how: 'passed',
                    endedAt: Date.now(),
                },
            ],
        ),
    );
    eq(
        (await call(sync(revision, [{ ...close, sourceAt: Date.now(), reportAt: Date.now() }]))).queued,
        [],
        'resolved episode cannot reopen',
    );
    const acked = alarm('radar-collision', 2),
        ack = {
            key: acked.key,
            contactKey: acked.contactKey,
            episodeId: acked.episodeId,
            kind: acked.kind,
            ackedAt: Date.now(),
        };
    const sameBatchAck = await call(sync(revision, [acked], [ack]));
    eq(sameBatchAck.queued, [], 'simultaneous explicit ACK prevents initial queue');
    eq(
        sameBatchAck.acknowledgements,
        [{ key: acked.key, ackedAt: ack.ackedAt }],
        'same batch returns original explicit ACK clock',
    );
    const laterAck = await call(sync(revision, [{ ...acked, sourceAt: Date.now() + 1, reportAt: Date.now() + 1 }]));
    eq(
        laterAck.acknowledgements,
        [{ key: acked.key, ackedAt: ack.ackedAt }],
        'fresh polling cannot renew cloud ACK clock',
    );
    eq(
        await scalar('SELECT acked_at IS NOT NULL FROM public.pi_radar_events WHERE alarm_key=$1', [acked.key]),
        true,
        'same-batch ACK preserved',
    );
    const expired = alarm('radar-collision', 20, Date.now() - 32 * 60_000);
    await call(sync(revision, [expired]));
    await db.query(
        "UPDATE public.pi_radar_events SET acked_at=now()-interval '31 minutes',last_pushed_at=now()-interval '31 minutes',last_pushed_source_at_ms=$2 WHERE alarm_key=$1",
        [expired.key, Date.now() - 31 * 60_000],
    );
    const refresh = { ...expired, sourceAt: Date.now() + 1, reportAt: Date.now() + 1 };
    const reopened = await call(
        sync(
            revision,
            [refresh],
            [
                {
                    key: expired.key,
                    contactKey: expired.contactKey,
                    episodeId: expired.episodeId,
                    kind: expired.kind,
                    ackedAt: Date.now() - 31 * 60_000,
                },
            ],
        ),
    );
    eq(reopened.acked, [], 'stale ordinary ACK does not renew an expired mute');
    eq(reopened.queued.length, 1, 'fresh evidence reopens ordinary alarm after its30-minute mute');
    eq(
        await as('service_role', null, 'SELECT public.pi_radar_delivery_current($1)', [reopened.queued[0]]),
        true,
        'reopened fresh attempt is current',
    );
    eq(
        await as('authenticated', owner, 'SELECT public.acknowledge_pi_radar_alarm($1,$2)', [expired.key, revision]),
        1,
        'new explicit owner ACK starts a new mute',
    );
    eq(
        await as('service_role', null, 'SELECT public.pi_radar_delivery_current($1)', [reopened.queued[0]]),
        false,
        'new ACK stops reopened queue',
    );
    const oldClose = alarm('radar-close-quarters', 21, Date.now() - 32 * 60_000);
    await call(sync(revision, [oldClose]));
    await db.query(
        "UPDATE public.pi_radar_events SET acked_at=now()-interval '31 minutes',last_pushed_at=now()-interval '31 minutes' WHERE alarm_key=$1",
        [oldClose.key],
    );
    const stillClose = await call(
        sync(revision, [{ ...oldClose, sourceAt: Date.now() + 1, reportAt: Date.now() + 1 }]),
    );
    eq(stillClose.acked, [oldClose.key], 'close-quarters ACK remains bound to its episode');
    eq(stillClose.queued, [], 'close ACK never expires as ordinary danger');
    await denied(
        () =>
            call(
                sync(
                    revision,
                    [],
                    [],
                    [
                        {
                            key: oldClose.key,
                            contactKey: oldClose.contactKey,
                            episodeId: oldClose.episodeId,
                            kind: oldClose.kind,
                            how: null,
                            endedAt: Date.now(),
                        },
                    ],
                ),
            ),
        'null resolution cannot clear a held encounter',
    );
    await denied(
        () => call(sync(revision, [{ ...alarm('radar-collision', 22), sourceAt: Date.now() - 0.5 }])),
        'fractional source timestamp is not an original millisecond clock',
    );
    const tamper = await call(sync(revision, [alarm('radar-collision', 23)]));
    await db.query("UPDATE public.push_notification_queue SET body='Changed facts' WHERE id=$1", [tamper.queued[0]]);
    eq(
        await as('service_role', null, 'SELECT public.pi_radar_delivery_current($1)', [tamper.queued[0]]),
        false,
        'delivery refuses facts changed after canonical formatting',
    );
    await db.exec('DELETE FROM public.push_notification_queue');
    for (let i = 0; i < 30; i++)
        await as(
            'service_role',
            null,
            'INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,data) VALUES($1,$2,$3::jsonb) RETURNING id',
            [owner, ['collision_alarm', 'distress_alarm', 'underway_alarm'][i % 3], JSON.stringify({ resend: false })],
        );
    eq(
        (await call(sync(revision, [alarm('radar-collision', 3)]))).queued,
        [],
        'radar shares existing 30 first-push budget',
    );
    await denied(
        () =>
            as(
                'service_role',
                null,
                "INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,data) VALUES($1,'collision_alarm','{\"resend\":false}'::jsonb) RETURNING id",
                [owner],
            ),
        'unchanged legacy sender cannot overrun shared budget',
    );
    eq(await scalar('SELECT count(*) FROM public.push_notification_queue'), 30, 'no cross-family overshoot');
    for (let i = 0; i < 20; i++)
        await as(
            'service_role',
            null,
            "INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,data) VALUES($1,'radar_alarm','{\"resend\":true}'::jsonb) RETURNING id",
            [owner],
        );
    await denied(
        () =>
            as(
                'service_role',
                null,
                "INSERT INTO public.push_notification_queue(recipient_user_id,notification_type,data) VALUES($1,'underway_alarm','{\"resend\":true}'::jsonb) RETURNING id",
                [owner],
            ),
        '20-resend budget is separate and atomic at insertion',
    );
    const retired = await call({ family: 'radar', action: 'retire', context, contextRevision: revision });
    assert.notEqual(retired.contextRevision, revision);
    checks++;
    eq(
        (await call(sync(revision, [alarm('radar-collision', 4)]))).conflict,
        true,
        'retired context cannot sync or revive',
    );
    eq(
        await as('authenticated', owner, 'SELECT public.acknowledge_pi_radar_alarm($1,$2)', [acked.key, revision]),
        0,
        'retired context ACK cannot borrow new watch',
    );
    const fresh = await call({
        family: 'radar',
        action: 'bind',
        context,
        expectedContextRevision: retired.contextRevision,
    });
    assert.notEqual(fresh.contextRevision, revision);
    checks++;
    await db.exec("UPDATE public.pi_diary_relays SET enabled=false WHERE relay_id='fictional-relay-identity'");
    await denied(
        () => call(sync(fresh.contextRevision, [alarm('radar-collision', 5)])),
        'disabled pairing fails closed',
    );
    console.log(
        JSON.stringify({
            checks,
            passed: true,
            concurrencyProven: false,
            notificationsSent: 0,
            sourceSha256: hash(await read('supabase/held-migrations/20261016162758_pi_radar_relay.sql')),
        }),
    );
} finally {
    await db.close();
}
