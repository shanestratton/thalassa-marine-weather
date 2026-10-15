/**
 * pi-alarm-relay (build 126, package 126-04b): the boat's Pi wakes the
 * skipper's locked phone.
 *
 * The Pi proves who it is with its pairing credential (the same bearer the
 * diary relay issued, _shared/pi-relay-auth.ts), and the function turns its
 * alarm into a row in push_notification_queue for the Pi's owner, which
 * send-push delivers. The text is built here from bounded numbers; the only
 * words the Pi sends are the vessel's AIS name, cleaned and capped. The
 * re-send rules live here too, so a busy anchorage cannot storm the phone.
 *
 * Fictional data only: owner 'skipper-1', relay 'relay-kestrel-0001-fictional',
 * Nordlicht 211000001, Bay Runner 366000002, a SART 970000003. Waters: the
 * Solent and the Hauraki Gulf.
 */
import { sha256Hex } from '../_shared/pi-relay-auth.ts';
import { handlePiAlarmRelay, type PiAlarmEvent, type PiAlarmStore, type QueuedPush } from './relay.ts';
import { cleanName, isUnderwayKind, MAX_BODY_BYTES, type PiAlarmFamily } from './parse.ts';

function assertEquals(actual: unknown, expected: unknown, note = ''): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`${note} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function assert(condition: unknown, note = ''): asserts condition {
    if (!condition) throw new Error(`assertion failed ${note}`);
}

const OWNER = 'skipper-1';
const RELAY = 'relay-kestrel-0001-fictional';
const TOKEN = 'a'.repeat(64);
const DISABLED = 'relay-disabled-0002-fictional';
const NORDLICHT = 211_000_001;
const BAY_RUNNER = 366_000_002;
const SART = 970_000_003;
/** 16:14 UTC: 02:14 aboard at UTC+10. */
const T0 = Date.UTC(2026, 9, 9, 16, 14, 0);
const MIN = 60_000;

/** The fake pi_diary_relays lookup authenticatePiRelay makes (the real auth code runs). */
async function relayTable() {
    const hash = await sha256Hex(TOKEN);
    const rows: Record<string, { owner_id: string; token_hash: string; enabled: boolean }> = {
        [RELAY]: { owner_id: OWNER, token_hash: hash, enabled: true },
        [DISABLED]: { owner_id: OWNER, token_hash: hash, enabled: false },
    };
    return {
        from: (_table: string) => ({
            select: () => ({
                eq: (_column: string, relayId: string) => ({
                    maybeSingle: () => Promise.resolve({ data: rows[relayId] ?? null, error: null }),
                }),
            }),
        }),
    };
}

/** pi_alarm_events and push_notification_queue, in memory. */
class MemoryStore implements PiAlarmStore {
    events: PiAlarmEvent[] = [];
    queue: Array<QueuedPush & { createdAt: number }> = [];
    devices = 2;
    touched = 0;
    failNext = false;
    underway = false;
    failUnderwayProbe = false;
    constructor(private readonly clock: () => number) {}
    private check() {
        if (this.failNext) {
            this.failNext = false;
            throw new Error('store down');
        }
    }
    countDevices(_ownerId: string) {
        this.check();
        return Promise.resolve(this.devices);
    }
    findEvents(relayId: string, keys: string[]) {
        this.check();
        return Promise.resolve(
            this.events.filter((e) => e.relayId === relayId && keys.includes(e.alarmKey)).map((e) => ({ ...e })),
        );
    }
    openEvents(relayId: string, family: PiAlarmFamily = 'ais') {
        return Promise.resolve(
            this.events
                .filter(
                    (e) =>
                        e.relayId === relayId &&
                        e.resolvedAt === null &&
                        (isUnderwayKind(e.kind) === (family === 'underway')) &&
                        ['collision', 'close-quarters', 'distress', 'off-route', 'chart-ahead'].includes(e.kind),
                )
                .map((e) => ({ ...e })),
        );
    }
    insertEvent(e: Omit<PiAlarmEvent, 'id'>) {
        if (this.events.some((x) => x.relayId === e.relayId && x.alarmKey === e.alarmKey)) {
            return Promise.resolve(null);
        }
        const row = { ...e, id: `ev-${this.events.length + 1}` };
        this.events.push(row);
        return Promise.resolve({ ...row });
    }
    updateEvent(id: string, patch: Partial<PiAlarmEvent>, expectPushedCount?: number) {
        const row = this.events.find((e) => e.id === id);
        if (!row) return Promise.resolve(false);
        if (expectPushedCount !== undefined && row.pushedCount !== expectPushedCount) return Promise.resolve(false);
        Object.assign(row, patch);
        return Promise.resolve(true);
    }
    resolveEvents(ids: string[], at: number) {
        for (const e of this.events) if (ids.includes(e.id)) e.resolvedAt = at;
        return Promise.resolve();
    }
    lastPushedAt(relayId: string, kind: string) {
        const times = this.events
            .filter((e) => e.relayId === relayId && e.kind === kind && e.lastPushedAt !== null)
            .map((e) => e.lastPushedAt as number);
        return Promise.resolve(times.length ? Math.max(...times) : null);
    }
    countPushedSince(relayId: string, kind: string, sinceMs: number) {
        return Promise.resolve(
            this.events.filter(
                (e) => e.relayId === relayId && e.kind === kind && e.lastPushedAt !== null && e.lastPushedAt >= sinceMs,
            ).length,
        );
    }
    alarmPushesSince(ownerId: string, sinceMs: number, resends?: boolean) {
        return Promise.resolve(
            this.queue.filter(
                (q) =>
                    q.recipient_user_id === ownerId &&
                    ['collision_alarm', 'distress_alarm', 'underway_alarm'].includes(q.notification_type) &&
                    q.createdAt >= sinceMs &&
                    (resends === undefined || q.data.resend === resends),
            ).length,
        );
    }
    enqueuePush(push: QueuedPush) {
        this.queue.push({ ...push, createdAt: this.clock() });
        return Promise.resolve(true);
    }
    pruneResolved(relayId: string, beforeMs: number, limit: number) {
        let left = limit;
        this.events = this.events.filter((e) => {
            const old = e.relayId === relayId && e.resolvedAt !== null && e.resolvedAt < beforeMs;
            if (old && left > 0) {
                left -= 1;
                return false;
            }
            return true;
        });
        return Promise.resolve();
    }
    touchRelay(_relayId: string) {
        this.touched += 1;
    }
}

async function harness() {
    let now = T0;
    const store = new MemoryStore(() => now);
    const admin = await relayTable();
    const { authenticatePiRelay } = await import('../_shared/pi-relay-auth.ts');
    const deps = {
        authenticate: (credential: { relayId: string; token: string } | null) =>
            authenticatePiRelay(admin, credential, () => undefined),
        store,
        now: () => now,
        underwayEnabled: () => {
            if (store.failUnderwayProbe) throw new Error('capability RPC unavailable');
            return Promise.resolve(store.underway);
        },
    };
    const call = async (
        body: unknown,
        opts: { relayId?: string; token?: string; method?: string; raw?: string } = {},
    ) => {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            apikey: 'anon-public',
            Authorization: 'Bearer anon-public',
        };
        if (opts.relayId !== '') headers['X-Thalassa-Pi-Relay-Id'] = opts.relayId ?? RELAY;
        if (opts.token !== '') headers['X-Thalassa-Pi-Relay-Token'] = opts.token ?? TOKEN;
        const res = await handlePiAlarmRelay(
            new Request('https://example.supabase.co/functions/v1/pi-alarm-relay', {
                method: opts.method ?? 'POST',
                headers,
                ...(opts.method === 'GET' || opts.method === 'OPTIONS'
                    ? {}
                    : { body: opts.raw ?? JSON.stringify(body) }),
            }),
            deps,
        );
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return {
        store,
        call,
        advance(ms: number) {
            now += ms;
        },
        get now() {
            return now;
        },
    };
}

const nordlicht = (over: Record<string, unknown> = {}) => ({
    key: `collision:${NORDLICHT}:${T0 - 30_000}`,
    kind: 'collision',
    mmsi: NORDLICHT,
    name: 'NORDLICHT',
    cpa_nm: 0.08,
    tcpa_min: 4.2,
    range_nm: 1.62,
    bearing_deg: 312,
    lat: 50.8,
    lon: -1.17,
    lost: null,
    acked_ms_ago: null,
    ...over,
});

const underwayAlarm = (kind = 'chart-ahead', over: Record<string, unknown> = {}) => ({
    kind,
    key: `${kind}::${T0}`,
    mmsi: null,
    acked_ms_ago: null,
    ...over,
});

Deno.test('underway capability is explicit; old AIS probe remains compatible', async () => {
    const h = await harness();
    assertEquals((await h.call({ action: 'probe' })).body, { ok: true, devices: 2 });
    assertEquals((await h.call({ action: 'probe', family: 'underway' })).body, {
        ok: true,
        devices: 2,
        underway: { v: 1, enabled: false },
    });
    h.store.underway = true;
    assertEquals((await h.call({ action: 'probe', family: 'underway' })).body.underway, { v: 1, enabled: true });
    assertEquals(h.store.queue.length, 0);
    assertEquals((await h.call({ action: 'probe', family: 'unknown' })).status, 400);
    assertEquals((await h.call({ action: 'test', family: 'underway' })).status, 400);
});

Deno.test('underway raise and sync fail closed until schema support is positively detected', async () => {
    const h = await harness();
    assertEquals((await h.call({ action: 'raise', family: 'underway', alarm: underwayAlarm() })).status, 503);
    assertEquals((await h.call({ action: 'sync', family: 'underway', alarms: [underwayAlarm()] })).status, 503);
    assertEquals(h.store.events.length, 0);
    assertEquals(h.store.queue.length, 0);
    assertEquals((await h.call({ action: 'raise', alarm: nordlicht() })).body.pushed, true, 'AIS remains available');
    h.store.underway = true;
    h.store.failUnderwayProbe = true;
    assertEquals((await h.call({ action: 'probe', family: 'underway' })).body.underway.enabled, false);
    assertEquals((await h.call({ action: 'raise', family: 'underway', alarm: underwayAlarm() })).status, 503);
    assertEquals(h.store.events.length, 1, 'a failed capability probe wrote no underway rows');
});

Deno.test('underway pushes contain generic words and no chart evidence, even from hostile input', async () => {
    const h = await harness();
    h.store.underway = true;
    for (const kind of ['off-route', 'chart-ahead']) {
        const alarm = underwayAlarm(kind, {
            name: 'PRIVATE CHART FEATURE',
            lat: 45.12345,
            lon: 12.54321,
            cpa_nm: 0.1,
            tcpa_min: 8,
            range_nm: 0.3,
            bearing_deg: 77,
            depth_m: 1.2,
            eta: 'private',
            xte_m: 300,
            cell_id: 'private',
            position_basis: 'dead-reckoned',
            uncertainty_nm: 0.5,
        });
        const res = await h.call({ action: 'raise', family: 'underway', alarm });
        assertEquals(res.status, 200);
        assertEquals(res.body.pushed, true);
        const row = h.store.queue.at(-1)!;
        assertEquals(row.notification_type, 'underway_alarm');
        assertEquals(row.recipient_user_id, OWNER);
        assertEquals(row.title, kind === 'off-route' ? 'Off route' : 'Charted danger ahead');
        assertEquals(
            row.body,
            kind === 'off-route'
                ? 'Check the course you are following aboard.'
                : 'Check the chart and water ahead aboard.',
        );
        assertEquals(row.data, { kind, alarm_key: alarm.key, raised_at_ms: h.now, resend: false });
        const payload = h.store.events.at(-1)!.payload;
        assertEquals(payload.name, '');
        assert(Object.values(payload).every((v) => v === '' || v === null), 'only empty/null evidence stored');
    }
});

Deno.test('no synthetic MMSI and no cross-family alarm request can pass the parser', async () => {
    const h = await harness();
    h.store.underway = true;
    for (
        const alarm of [
            underwayAlarm('off-route', { mmsi: NORDLICHT }),
            underwayAlarm('off-route', {
                key: `off-route:${NORDLICHT}:${T0}`,
            }),
        ]
    ) {
        assertEquals((await h.call({ action: 'raise', family: 'underway', alarm })).status, 400);
    }
    assertEquals((await h.call({ action: 'raise', alarm: underwayAlarm() })).status, 400);
    assertEquals((await h.call({ action: 'raise', family: 'underway', alarm: nordlicht() })).status, 400);
    assertEquals((await h.call({ action: 'sync', alarms: [nordlicht(), underwayAlarm()] })).status, 400);
    assertEquals(
        (await h.call({ action: 'sync', family: 'underway', alarms: [underwayAlarm(), nordlicht()] })).status,
        400,
    );
    assertEquals(h.store.events.length, 0);
    assertEquals(h.store.queue.length, 0);
});

Deno.test('AIS and underway sync close only their own family, including an empty sync', async () => {
    const h = await harness();
    h.store.underway = true;
    const ais = nordlicht();
    const watch = underwayAlarm();
    await h.call({ action: 'raise', alarm: ais });
    await h.call({ action: 'raise', family: 'underway', alarm: watch });
    assertEquals((await h.call({ action: 'sync', alarms: [] })).body.resolved, 1);
    assertEquals(h.store.events.find((e) => e.alarmKey === watch.key)!.resolvedAt, null);
    await h.call({ action: 'raise', alarm: ais });
    assertEquals((await h.call({ action: 'sync', family: 'underway', alarms: [] })).body.resolved, 1);
    assertEquals(h.store.events.find((e) => e.alarmKey === ais.key)!.resolvedAt, null);
});

Deno.test('underway alarms obey resend interval, acknowledgement and encounter identity', async () => {
    const h = await harness();
    h.store.underway = true;
    const alarm = underwayAlarm('off-route');
    await h.call({ action: 'raise', family: 'underway', alarm });
    h.advance(MIN);
    assertEquals((await h.call({ action: 'sync', family: 'underway', alarms: [alarm] })).body.pushed, 0);
    h.advance(MIN);
    assertEquals((await h.call({ action: 'sync', family: 'underway', alarms: [alarm] })).body.pushed, 1);
    h.store.events[0].ackedAt = h.now;
    h.store.events[0].ackedBy = OWNER;
    h.advance(30 * MIN);
    const ack = await h.call({ action: 'sync', family: 'underway', alarms: [alarm] });
    assertEquals(ack.body.acked, [alarm.key]);
    assertEquals(ack.body.pushed, 0, 'ack persists for this encounter');
    await h.call({ action: 'sync', family: 'underway', alarms: [] });
    const next = underwayAlarm('off-route', { key: `off-route::${h.now}` });
    assertEquals((await h.call({ action: 'raise', family: 'underway', alarm: next })).body.pushed, true);
});

Deno.test('underway and AIS first pushes share the existing owner hourly cap', async () => {
    const h = await harness();
    h.store.underway = true;
    for (let i = 0; i < 29; i++) {
        const mmsi = NORDLICHT + i;
        await h.call({ action: 'raise', alarm: nordlicht({ mmsi, key: `collision:${mmsi}:${T0}` }) });
    }
    assertEquals(
        (await h.call({ action: 'raise', family: 'underway', alarm: underwayAlarm('off-route') })).body.pushed,
        true,
    );
    const held = await h.call({ action: 'raise', family: 'underway', alarm: underwayAlarm() });
    assertEquals(held.body.pushed, false);
    assertEquals(held.body.held, 'hourly');
    assertEquals(h.store.queue.length, 30);
});

// ── The front door ─────────────────────────────────────────────────────────

Deno.test('a bad, unknown or disabled relay gets one 401, the same answer every time', async () => {
    const h = await harness();
    const raise = { action: 'raise', alarm: nordlicht() };
    const answers = [
        await h.call(raise, { token: 'b'.repeat(64) }),
        await h.call(raise, { relayId: 'relay-nobody-0003-fictional' }),
        await h.call(raise, { relayId: DISABLED }),
        await h.call(raise, { relayId: '', token: '' }),
        await h.call(raise, { token: 'not-hex' }),
    ];
    for (const a of answers) {
        assertEquals(a.status, 401);
        assertEquals(a.body, { error: 'unauthorised' });
    }
    assertEquals(h.store.queue.length, 0, 'nothing queued');
    assertEquals(h.store.events.length, 0, 'nothing recorded');
});

Deno.test('a body over 8 KiB is refused with 413 before anything else; GET is 405, OPTIONS 204', async () => {
    const h = await harness();
    const big = JSON.stringify({ action: 'probe', pad: 'x'.repeat(MAX_BODY_BYTES) });
    assertEquals((await h.call(null, { raw: big })).status, 413);
    assertEquals((await h.call(null, { raw: big, token: 'b'.repeat(64) })).status, 413);
    assertEquals((await h.call(null, { method: 'GET' })).status, 405);
    assertEquals((await h.call(null, { method: 'OPTIONS' })).status, 204);
    assertEquals((await h.call(null, { raw: '{not json' })).status, 400);
    assertEquals((await h.call({ action: 'shout' })).status, 400);
});

// ── raise ──────────────────────────────────────────────────────────────────

Deno.test('a new collision alarm: one queue row for the owner, its words built from the numbers', async () => {
    const h = await harness();
    const res = await h.call({ action: 'raise', utc_offset_min: 600, alarm: nordlicht() });
    assertEquals(res.status, 200);
    assertEquals(res.body.ok, true);
    assertEquals(res.body.pushed, true);
    assertEquals(h.store.queue.length, 1);
    const [row] = h.store.queue;
    assertEquals(row.recipient_user_id, OWNER, 'the Pi’s owner, and only the owner');
    assertEquals(row.notification_type, 'collision_alarm');
    assertEquals(row.title, 'Collision risk: NORDLICHT');
    assertEquals(row.body, 'CPA 0.08 NM in 4 min, bearing 312°, 1.6 NM. From your boat’s Pi, 02:14.');
    assertEquals(row.data.kind, 'collision');
    assertEquals(row.data.mmsi, NORDLICHT);
    assertEquals(row.data.alarm_key, `collision:${NORDLICHT}:${T0 - 30_000}`);
    assertEquals(row.data.cpa_nm, 0.08);
    assertEquals(h.store.events.length, 1);
    assertEquals(h.store.events[0].pushedCount, 1);
    assertEquals(h.store.events[0].ownerId, OWNER);
});

Deno.test('the same alarm again inside 2 min queues nothing; after 2 min unacked, again; once acked, never', async () => {
    const h = await harness();
    const raise = { action: 'raise', alarm: nordlicht() };
    await h.call(raise);
    h.advance(MIN);
    const soon = await h.call(raise);
    assertEquals(soon.body.pushed, false);
    assertEquals(h.store.queue.length, 1, 'inside 2 min');
    h.advance(MIN);
    const due = await h.call(raise);
    assertEquals(due.body.pushed, true);
    assertEquals(h.store.queue.length, 2, 'after 2 min, unacked');
    // The skipper acknowledges from ashore (acknowledge_pi_alarm sets acked_at).
    h.store.events[0].ackedAt = h.now;
    h.store.events[0].ackedBy = OWNER;
    h.advance(3 * MIN);
    const acked = await h.call(raise);
    assertEquals(acked.body.pushed, false);
    assertEquals(acked.body.acked, true);
    assertEquals(h.store.queue.length, 2, 'acknowledged: no more');
});

Deno.test('close quarters re-sends every 60 s', async () => {
    const h = await harness();
    const cq = nordlicht({ key: `close-quarters:${NORDLICHT}:${T0}`, kind: 'close-quarters', cpa_nm: 0.02 });
    await h.call({ action: 'raise', alarm: cq });
    assertEquals(h.store.queue[0].title, 'Close quarters: NORDLICHT');
    h.advance(59_000);
    await h.call({ action: 'sync', alarms: [cq] });
    assertEquals(h.store.queue.length, 1);
    h.advance(1_000);
    await h.call({ action: 'sync', alarms: [cq] });
    assertEquals(h.store.queue.length, 2);
});

Deno.test('at most 10 re-sends: the 11th is refused', async () => {
    const h = await harness();
    const alarm = nordlicht();
    await h.call({ action: 'raise', alarm });
    for (let i = 0; i < 10; i += 1) {
        h.advance(2 * MIN);
        const res = await h.call({ action: 'sync', alarms: [alarm] });
        assertEquals(res.body.pushed, 1, `re-send ${i + 1}`);
    }
    assertEquals(h.store.queue.length, 11);
    h.advance(2 * MIN);
    const eleventh = await h.call({ action: 'sync', alarms: [alarm] });
    assertEquals(eleventh.body.pushed, 0);
    assertEquals(h.store.queue.length, 11);
});

Deno.test('at most 30 new alarms pushed an hour: the 31st is held, a new hour starts again', async () => {
    const h = await harness();
    for (let i = 0; i < 30; i += 1) {
        const mmsi = 211_000_100 + i;
        const res = await h.call({
            action: 'raise',
            alarm: nordlicht({ key: `collision:${mmsi}:${T0}`, mmsi }),
        });
        assertEquals(res.body.pushed, true, `push ${i + 1}`);
        h.advance(1_000);
    }
    const thirtyFirst = await h.call({
        action: 'raise',
        alarm: nordlicht({ key: `collision:${BAY_RUNNER}:${T0}`, mmsi: BAY_RUNNER }),
    });
    assertEquals(thirtyFirst.body.pushed, false);
    assertEquals(h.store.queue.length, 30);
    h.advance(60 * MIN);
    const later = await h.call({
        action: 'sync',
        alarms: [nordlicht({ key: `collision:${BAY_RUNNER}:${T0}`, mmsi: BAY_RUNNER })],
    });
    assertEquals(later.body.pushed, 1, 'the held alarm goes once the hour has passed');
});

Deno.test('a DANGER muted 30 min ago and sounding again on the Pi is pushed again', async () => {
    const h = await harness();
    const alarm = nordlicht();
    await h.call({ action: 'raise', alarm });
    h.store.events[0].ackedAt = h.now;
    h.advance(10 * MIN);
    assertEquals((await h.call({ action: 'raise', alarm })).body.pushed, false, 'muted');
    h.advance(20 * MIN);
    const again = await h.call({ action: 'raise', alarm });
    assertEquals(again.body.pushed, true, 'the mute ran out aboard');
    assertEquals(h.store.events[0].ackedAt, null);
});

Deno.test('a DANGER acknowledged aboard, its mute run out and the raise lost: the next sync pushes it, never mutes it again', async () => {
    const h = await harness();
    const alarm = nordlicht();
    await h.call({ action: 'raise', alarm });
    // 02:15: acknowledged on a phone aboard; the Pi's sync records it.
    h.advance(MIN);
    await h.call({ action: 'sync', alarms: [{ ...alarm, acked_ms_ago: 0 }] });
    assert(h.store.events[0].ackedAt !== null, 'recorded');
    // 30 min on she is still closing: the Pi lets the mute go and raises her,
    // but that raise is lost (a night-time 4G blip). The next sync lists her sounding.
    h.advance(30 * MIN);
    const res = await h.call({ action: 'sync', alarms: [alarm] });
    assertEquals(res.body.acked, [], 'never answered as acknowledged: that would mute her for another 30 min');
    assertEquals(res.body.pushed, 1, 'pushed afresh');
    assertEquals(h.store.events[0].ackedAt, null);
    assertEquals(h.store.queue.length, 2);

    // The same from ashore: acknowledged with acknowledge_pi_alarm, 30 min on, raise lost.
    const b = nordlicht({ key: `collision:${BAY_RUNNER}:${T0}`, mmsi: BAY_RUNNER, name: 'BAY RUNNER' });
    await h.call({ action: 'raise', alarm: b });
    const row = h.store.events.find((e) => e.mmsi === BAY_RUNNER)!;
    row.ackedAt = h.now;
    row.ackedBy = OWNER;
    h.advance(15_000);
    assertEquals((await h.call({ action: 'sync', alarms: [b] })).body.acked, [b.key], 'a fresh ack from ashore');
    h.advance(30 * MIN);
    const later = await h.call({ action: 'sync', alarms: [b] });
    assertEquals(later.body.acked, [], 'an ack older than the mute is never answered');
    assertEquals(later.body.pushed, 1);
});

Deno.test('a sync built before the mute ran out, arriving after the raise pushed her afresh, does not acknowledge her again', async () => {
    const h = await harness();
    const alarm = nordlicht();
    await h.call({ action: 'raise', alarm });
    h.advance(MIN);
    await h.call({ action: 'sync', alarms: [{ ...alarm, acked_ms_ago: 0 }] });
    // 30 min on: the raise for the end of the mute lands first...
    h.advance(30 * MIN);
    assertEquals((await h.call({ action: 'raise', alarm })).body.pushed, true);
    // ...then a sync built 2 s before the mute ran out, still saying acknowledged.
    const stale = await h.call({ action: 'sync', alarms: [{ ...alarm, acked_ms_ago: 30 * MIN - 2_000 }] });
    assertEquals(stale.body.acked, []);
    assertEquals(h.store.events[0].ackedAt, null, 'the stale acknowledgement is not written back');
    assertEquals(h.store.queue.length, 2, 'and pushes nothing');
    // The next sync lists her sounding: not acknowledged, and re-sent on the usual clock.
    h.advance(15_000);
    const next = await h.call({ action: 'sync', alarms: [alarm] });
    assertEquals(next.body.acked, []);
    assertEquals(next.body.pushed, 0, 'too soon');
    h.advance(2 * MIN);
    assertEquals((await h.call({ action: 'sync', alarms: [alarm] })).body.pushed, 1);
    // A real acknowledgement aboard after the fresh push is recorded as ever.
    h.advance(5_000);
    await h.call({ action: 'sync', alarms: [{ ...alarm, acked_ms_ago: 1_000 }] });
    assertEquals(h.store.events[0].ackedAt, h.now - 1_000);
});

Deno.test('three close-quarters alarms re-sending for 10 min never hold a new vessel’s first push', async () => {
    const h = await harness();
    const cqs = [211_000_101, 211_000_102, 211_000_103].map((mmsi) =>
        nordlicht({ key: `close-quarters:${mmsi}:${T0}`, kind: 'close-quarters', mmsi, cpa_nm: 0.02 })
    );
    for (const alarm of cqs) await h.call({ action: 'raise', alarm });
    for (let i = 0; i < 10; i += 1) {
        h.advance(MIN);
        await h.call({ action: 'sync', alarms: cqs });
    }
    const bayRunner = nordlicht({ key: `collision:${BAY_RUNNER}:${h.now}`, mmsi: BAY_RUNNER, name: 'BAY RUNNER' });
    const res = await h.call({ action: 'raise', alarm: bayRunner });
    assertEquals(res.body.pushed, true, 'a new DANGER is never held behind re-sends');
    assertEquals(h.store.queue.at(-1)?.title, 'Collision risk: BAY RUNNER');
    const resends = h.store.queue.filter((q) => q.data.resend === true).length;
    assert(resends <= 20, `re-sends capped at 20 an hour (${resends})`);
    assertEquals(h.store.queue.filter((q) => q.data.resend === false).length, 4, 'each first push marked as one');
});

Deno.test('a close-quarters CPA already passed is said as passed, opening; a range under 0.05 NM keeps its digits', async () => {
    const h = await harness();
    const cq = nordlicht({
        key: `close-quarters:${NORDLICHT}:${T0}`,
        kind: 'close-quarters',
        cpa_nm: 0.03,
        tcpa_min: -2.5,
        range_nm: 0.04,
    });
    await h.call({ action: 'raise', utc_offset_min: 600, alarm: cq });
    assertEquals(
        h.store.queue[0].body,
        'CPA 0.03 NM passed, opening, bearing 312°, 0.04 NM. From your boat’s Pi, 02:14.',
    );
    await h.call({
        action: 'raise',
        utc_offset_min: 600,
        alarm: nordlicht({ key: `collision:${BAY_RUNNER}:${T0}`, mmsi: BAY_RUNNER, tcpa_min: 0.4, range_nm: 0.3 }),
    });
    assertEquals(
        h.store.queue[1].body,
        'CPA 0.08 NM within a minute, bearing 312°, 0.30 NM. From your boat’s Pi, 02:14.',
    );
});

Deno.test('one bad entry in a sync is skipped and counted; the rest go on', async () => {
    const h = await harness();
    const good = nordlicht();
    // A zero-padded URN read as MMSI 12345: no radio sends it, the relay refuses it.
    const bad = nordlicht({ key: `close-quarters:12345:${T0}`, kind: 'close-quarters', mmsi: 12_345 });
    const res = await h.call({ action: 'sync', alarms: [bad, good, 'junk'] });
    assertEquals(res.status, 200);
    assertEquals(res.body.pushed, 1);
    assertEquals(res.body.skipped, 2);
    assertEquals(h.store.events.length, 1);
    // An acknowledgement from ashore still gets back to the Pi past the bad entry.
    h.store.events[0].ackedAt = h.now;
    h.store.events[0].ackedBy = OWNER;
    h.advance(15_000);
    assertEquals((await h.call({ action: 'sync', alarms: [bad, good] })).body.acked, [good.key]);
});

// ── sync ───────────────────────────────────────────────────────────────────

Deno.test('sync returns the keys acknowledged from ashore and resolves the ones the Pi no longer sends', async () => {
    const h = await harness();
    const a = nordlicht();
    const b = nordlicht({ key: `collision:${BAY_RUNNER}:${T0}`, mmsi: BAY_RUNNER, name: 'BAY RUNNER' });
    await h.call({ action: 'raise', alarm: a });
    await h.call({ action: 'raise', alarm: b });
    h.store.events[0].ackedAt = h.now;
    h.store.events[0].ackedBy = OWNER;
    h.advance(10_000);
    const res = await h.call({ action: 'sync', alarms: [a] });
    assertEquals(res.status, 200);
    assertEquals(res.body.acked, [a.key]);
    assertEquals(res.body.resolved, 1);
    assert(h.store.events[1].resolvedAt !== null, 'Bay Runner resolved');
    assertEquals(h.store.events[0].resolvedAt, null);
});

Deno.test('sync: an alarm the relay never heard is raised; one acknowledged aboard is kept quiet', async () => {
    const h = await harness();
    const a = nordlicht();
    const res = await h.call({ action: 'sync', alarms: [a] });
    assertEquals(res.body.pushed, 1, 'a raise that never arrived is not lost');
    // Acknowledged on a phone aboard 20 s ago: the Pi says so, no more pushes.
    h.advance(2 * MIN);
    await h.call({ action: 'sync', alarms: [{ ...a, acked_ms_ago: 20_000 }] });
    assertEquals(h.store.queue.length, 1);
    assertEquals(h.store.events[0].ackedAt, h.now - 20_000);
    assertEquals(h.store.events[0].ackedBy, null, 'aboard, not a signed-in account');
    h.advance(2 * MIN);
    await h.call({ action: 'sync', alarms: [a] });
    assertEquals(h.store.queue.length, 1, 'acknowledged stays acknowledged');
    const quiet = nordlicht({ key: `collision:${BAY_RUNNER}:${T0}`, mmsi: BAY_RUNNER, acked_ms_ago: 1_000 });
    await h.call({ action: 'sync', alarms: [a, quiet] });
    assertEquals(h.store.queue.length, 1, 'raised already acknowledged aboard');
});

Deno.test('sync carries at most 20 alarms, and only alarms', async () => {
    const h = await harness();
    const many = Array.from(
        { length: 21 },
        (_, i) => nordlicht({ key: `collision:${211_000_200 + i}:${T0}`, mmsi: 211_000_200 + i }),
    );
    assertEquals((await h.call({ action: 'sync', alarms: many })).status, 400);
    // A notice is news once, never an open alarm: skipped, nothing recorded or pushed.
    const notice = { key: `blind::${T0}`, kind: 'blind' };
    const res = await h.call({ action: 'sync', alarms: [notice] });
    assertEquals(res.status, 200);
    assertEquals(res.body.skipped, 1);
    assertEquals(h.store.events.length, 0);
    assertEquals(h.store.queue.length, 0);
});

// ── distress, notices, probe and test ──────────────────────────────────────

Deno.test('a SART heard by the Pi: a distress alarm, its own type and words', async () => {
    const h = await harness();
    const sart = {
        key: `distress:${SART}:${T0}`,
        kind: 'distress',
        mmsi: SART,
        name: '',
        distress_kind: 'sart',
        position_known: true,
        lat: -36.75,
        lon: 174.95,
        range_nm: 0.8,
        bearing_deg: 45,
    };
    await h.call({ action: 'raise', utc_offset_min: 780, alarm: sart });
    const [row] = h.store.queue;
    assertEquals(row.notification_type, 'distress_alarm');
    assertEquals(row.title, 'Distress: AIS-SART active');
    assertEquals(row.body, `MMSI ${SART}, bearing 045°, 0.80 NM. Heard by your boat’s Pi, 05:14.`);
    const noPosition = {
        ...sart,
        key: `distress:972000004:${T0}`,
        mmsi: 972_000_004,
        distress_kind: 'mob',
        position_known: false,
        lat: null,
        lon: null,
        range_nm: null,
        bearing_deg: null,
    };
    await h.call({ action: 'raise', alarm: noPosition });
    assertEquals(h.store.queue[1].title, 'Distress: man overboard beacon active');
    assertEquals(
        h.store.queue[1].body,
        'MMSI 972000004: position not yet received. Heard by your boat’s Pi, 16:14 UTC.',
    );
});

Deno.test('the Pi gone blind: one ordinary notice, then none for 30 min', async () => {
    const h = await harness();
    const blind = (at: number) => ({ key: `blind::${at}`, kind: 'blind', silent_min: 10 });
    const res = await h.call({ action: 'raise', alarm: blind(T0) });
    assertEquals(res.body.pushed, true);
    assertEquals(h.store.queue[0].notification_type, 'pi_watch_notice');
    assertEquals(
        h.store.queue[0].body,
        'Your boat’s Pi can’t see AIS traffic (no reports for 10 min). The night watch is blind.',
    );
    h.advance(20 * MIN);
    assertEquals((await h.call({ action: 'raise', alarm: blind(h.now) })).body.pushed, false);
    h.advance(11 * MIN);
    assertEquals((await h.call({ action: 'raise', alarm: blind(h.now) })).body.pushed, true);
    const fix = await h.call({ action: 'raise', alarm: { key: `no-fix::${h.now}`, kind: 'no-fix', cause: 'fix' } });
    assertEquals(fix.body.pushed, true, 'no fix is its own notice');
    assertEquals(h.store.queue.at(-1)?.title, 'Night watch: no position');
});

Deno.test('probe answers ok with how many devices can be woken, and tidies month-old rows', async () => {
    const h = await harness();
    await h.call({ action: 'raise', alarm: nordlicht() });
    h.store.events[0].resolvedAt = h.now;
    h.advance(31 * 24 * 60 * MIN);
    const res = await h.call({ action: 'probe' });
    assertEquals(res.status, 200);
    assertEquals(res.body, { ok: true, devices: 2 });
    assertEquals(h.store.events.length, 0, 'resolved over 30 days ago: gone');
    assert(h.store.touched > 0, 'the relay heartbeat');
    assertEquals(h.store.queue.length, 1, 'a probe pushes nothing');
});

Deno.test('test: one ordinary notice labelled TEST; a second inside a minute is held', async () => {
    const h = await harness();
    const res = await h.call({ action: 'test', utc_offset_min: 600 });
    assertEquals(res.status, 200);
    assertEquals(res.body.queued, true);
    assertEquals(res.body.devices, 2);
    assertEquals(h.store.queue.length, 1);
    assertEquals(h.store.queue[0].notification_type, 'pi_watch_notice');
    assert(h.store.queue[0].title.startsWith('TEST'), h.store.queue[0].title);
    assert(h.store.queue[0].body.includes('02:14'), h.store.queue[0].body);
    assertEquals(h.store.queue[0].data.kind, 'test');
    h.advance(30_000);
    assertEquals((await h.call({ action: 'test' })).body.queued, false);
    assertEquals(h.store.queue.length, 1);
});

Deno.test('a name with control characters or 200 letters is cleaned and capped; nothing else is words', async () => {
    assertEquals(cleanName('NORD\u0000LICHT\u0007 <b>II</b>'), 'NORDLICHT II');
    assertEquals(cleanName('Z'.repeat(200)).length, 40);
    assertEquals(cleanName(42), '');
    const h = await harness();
    await h.call({
        action: 'raise',
        alarm: nordlicht({
            name: `\u0001${'W'.repeat(200)}`,
            cpa_nm: 'very close',
            bearing_deg: 999,
            extra: 'ignored',
        }),
    });
    const [row] = h.store.queue;
    assertEquals(row.title, `Collision risk: ${'W'.repeat(40)}`);
    assertEquals(row.body, 'CPA unknown, 1.6 NM. From your boat’s Pi, 16:14 UTC.');
    assert(!('extra' in row.data), 'unknown fields dropped');
});

Deno.test('a key that is not an alarm key, or names a different vessel, is refused', async () => {
    const h = await harness();
    for (
        const alarm of [
            nordlicht({ key: 'collision:211000001:12' }),
            nordlicht({ key: `collision:${BAY_RUNNER}:${T0}` }),
            nordlicht({ kind: 'distress' }),
            nordlicht({ mmsi: 12 }),
            { key: `blind:${NORDLICHT}:${T0}`, kind: 'blind' },
        ]
    ) {
        assertEquals((await h.call({ action: 'raise', alarm })).status, 400, JSON.stringify(alarm));
    }
    assertEquals(h.store.queue.length, 0);
});

Deno.test('a store that fails answers 503 and queues nothing', async () => {
    const h = await harness();
    h.store.failNext = true;
    const res = await h.call({ action: 'probe' });
    assertEquals(res.status, 503);
    assertEquals(h.store.queue.length, 0);
});
