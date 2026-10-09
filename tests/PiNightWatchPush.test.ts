/**
 * The Pi keeps the night watch, part 2 (build 126, package 126-04b): a push
 * from the Pi wakes the skipper's locked phone.
 *
 * The Pi's alarm reaches the skipper through pi-alarm-relay and send-push.
 * On the phone: a push for an alarm this phone never saw becomes a card
 * 'from the Pi' (so does an open alarm fetched from pi_alarm_events when the
 * app wakes ashore); Acknowledge goes to the cloud (acknowledge_pi_alarm,
 * which stops the Pi re-sending) and, aboard, to the Pi over the boat LAN
 * too. The AIS key says "The Pi can wake this phone" only when the Pi says
 * the path works ('ready', proved within the hour) AND this phone has a push
 * token AND this account is the one the Pi wakes; otherwise it says why not.
 * Aboard, it offers "Send a test from the Pi", over the pinned lane.
 *
 * Fictional: owner 'skipper-1', crew 'crew-2', own boat 'Kestrel' (MMSI
 * 235000101), Nordlicht 211000001, Bay Runner 366000002, a SART 970000003.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    pairing: { value: { deviceId: 'pi-fictional', boatName: 'Kestrel', publicKeySpki: 'spki' } as unknown },
    requests: [] as Array<{ url: string; method?: string; data?: unknown; headers?: Record<string, string> }>,
    respond: null as null | ((url: string, data: unknown) => { status: number; data: string }),
    zone: {
        state: { enabled: false, radiusNm: 2, alerts: [] as unknown[], collisionChecked: false as boolean | undefined },
        listeners: new Set<(s: unknown) => void>(),
    },
    settings: {
        value: { vessel: { mmsi: '235000101' }, collisionAlarm: undefined as unknown } as Record<string, unknown>,
        listeners: new Set<(s: unknown) => void>(),
    },
    token: { value: 'apns-token-fictional' as string | null },
    /** Registered in push_device_tokens for this account (claim_push_device_token accepted it). */
    registered: { value: true },
    rpc: [] as Array<{ name: string; args: unknown }>,
    rpcError: { value: null as null | { message: string; code?: string } },
    selects: [] as Array<{ table: string; calls: Array<[string, unknown[]]> }>,
    rows: { value: [] as unknown[] },
    selectError: { value: null as null | { message: string; code?: string } },
}));

vi.mock('../services/skipperDevice', () => ({
    deviceIdReady: async () => 'dev-0f9c2d4e-fictional-kestrel-phone',
    getDeviceId: () => 'dev-0f9c2d4e-fictional-kestrel-phone',
}));
vi.mock('../services/AisGuardWatch', () => ({ readCollisionInputs: () => ({ anchorWatch: 'none' }) }));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => mocks.pairing.value,
    pinnedPiRequest: async (options: { url: string; method?: string; data?: unknown }) => {
        mocks.requests.push(options);
        if (mocks.respond) return mocks.respond(options.url, options.data);
        return { status: 200, data: JSON.stringify({ status: 'ok' }) };
    },
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getBaseUrl: () => 'https://192.168.1.50:3001',
        getRemoteBaseUrl: () => 'https://100.64.0.7:3001',
        getStatus: () => ({ reachable: true }),
    },
}));
vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        getState: () => mocks.zone.state,
        subscribe: (fn: (s: unknown) => void) => {
            mocks.zone.listeners.add(fn);
            return () => mocks.zone.listeners.delete(fn);
        },
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: mocks.settings.value }),
        subscribe: (fn: (s: unknown) => void) => {
            mocks.settings.listeners.add(fn);
            return () => mocks.settings.listeners.delete(fn);
        },
    },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/PushNotificationService', () => ({
    PushNotificationService: {
        getToken: () => mocks.token.value,
        getAssociatedToken: () => (mocks.registered.value ? mocks.token.value : null),
    },
}));
vi.mock('../services/supabase', () => {
    const builder = (table: string) => {
        const record = { table, calls: [] as Array<[string, unknown[]]> };
        mocks.selects.push(record);
        const chain: Record<string, unknown> = {};
        for (const method of ['select', 'is', 'in', 'gte', 'order', 'limit', 'eq']) {
            chain[method] = (...args: unknown[]) => {
                record.calls.push([method, args]);
                return chain;
            };
        }
        chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(
                mocks.selectError.value
                    ? { data: null, error: mocks.selectError.value }
                    : { data: mocks.rows.value, error: null },
            ).then(resolve, reject);
        return chain;
    };
    return {
        supabase: {
            from: (table: string) => builder(table),
            rpc: async (name: string, args: unknown) => {
                mocks.rpc.push({ name, args });
                return mocks.rpcError.value ? { data: null, error: mocks.rpcError.value } : { data: 1, error: null };
            },
        },
    };
});

import { AisGuardAlertStore } from '../services/aisGuardAlertStore';
import {
    __resetPiNightWatchForTests,
    refreshPiAlarms,
    startPiAlarmCloud,
    startPiNightWatch,
} from '../services/piNightWatch';
import { PiNightWatchStatus, aisWatchFromCloudExtra } from '../services/piNightWatchStatus';
import {
    PI_WATCH_CAN_WAKE_NOTE,
    PI_WATCH_INTERNET_OFF_NOTE,
    PI_WATCH_LOCKED_PHONE_NOTE,
    PI_WATCH_NO_TOKEN_NOTE,
    PI_WATCH_SKIPPER_ONLY_NOTE,
    presentCollisionWatchRow,
    type PiWatchView,
} from '../utils/collisionWatchRow';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';
import type { TelemetrySnapshot } from '../pi-cache/src/trackSignalk';

const NOW = Date.parse('2026-10-09T16:14:00Z');
const NORDLICHT = 211_000_001;
const BAY_RUNNER = 366_000_002;
const SART = 970_000_003;
const OWNER = 'skipper-1';
const KEY = `collision:${NORDLICHT}:${NOW - 60_000}`;

const settle = async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** A push's custom keys, as send-push spreads pi-alarm-relay's `data` into the APNs payload. */
const pushData = (over: Record<string, unknown> = {}) => ({
    notification_type: 'collision_alarm',
    kind: 'collision',
    alarm_key: KEY,
    mmsi: NORDLICHT,
    name: 'NORDLICHT',
    cpa_nm: 0.08,
    tcpa_min: 4.2,
    range_nm: 1.62,
    bearing_deg: 312,
    lat: 50.8,
    lon: -1.17,
    raised_at_ms: NOW - 60_000,
    ...over,
});

/** The Pi's /api/telemetry ais_watch, with the push word 126-04b adds. */
const lanWatch = (
    alarms: unknown[] = [],
    push: Record<string, unknown> | null = { state: 'ready', checkedAt: NOW - 60_000, ownerId: OWNER },
    at = Date.now(),
) => ({
    v: 1,
    state: 'armed',
    armed: true,
    armedAt: at - 600_000,
    lastPassAt: at - 1_000,
    servedAt: at,
    atAnchor: false,
    own: 'moving',
    devices: 1,
    alarms,
    push,
});
const hearLan = (watch: unknown) => PiNightWatchStatus.ingestLan(watch, { nowMs: Date.now(), answeredVia: 'lan-host' });

const lanAlarm = (over: Record<string, unknown> = {}) => ({
    key: KEY,
    kind: 'collision',
    mmsi: NORDLICHT,
    name: 'NORDLICHT',
    cpaNm: 0.08,
    tcpaMin: 4.2,
    rangeNm: 1.62,
    bearingDeg: 312,
    lat: 50.8,
    lon: -1.17,
    raisedAt: NOW - 60_000,
    ackedAt: null,
    lost: null,
    ...over,
});

const ownCard = (mmsi: number) => ({
    mmsi,
    name: 'NORDLICHT',
    distanceNm: 1.6,
    bearing: 312,
    sog: 12,
    cog: 130,
    shipType: '70',
    timestamp: NOW,
    collision: { cpaNm: 0.08, tcpaMin: 4, closeQuarters: false, reportAgeSec: 4, source: 'local' as const },
});

const posts = (path: string) => mocks.requests.filter((r) => r.url.endsWith(path));

let stop: (() => void) | null = null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    mocks.requests.length = 0;
    mocks.respond = null;
    mocks.token.value = 'apns-token-fictional';
    mocks.registered.value = true;
    mocks.rpc.length = 0;
    mocks.rpcError.value = null;
    mocks.selects.length = 0;
    mocks.rows.value = [];
    mocks.selectError.value = null;
    mocks.zone.listeners.clear();
    mocks.settings.listeners.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope(OWNER);
    AisGuardAlertStore.clear();
    PiNightWatchStatus.__resetForTests();
    __resetPiNightWatchForTests();
});

afterEach(() => {
    stop?.();
    stop = null;
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('a push from the Pi on this phone', () => {
    it('an alarm this phone never saw becomes a card from the Pi', () => {
        const got = PiNightWatchStatus.receivePush(pushData(), NOW);
        expect(got.hadCard).toBe(false);
        expect(got.alarm?.key).toBe(KEY);
        const cards = PiNightWatchStatus.piCards(NOW);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({
            key: KEY,
            kind: 'collision',
            mmsi: NORDLICHT,
            name: 'NORDLICHT',
            cpaNm: 0.08,
            tcpaMin: 4.2,
            rangeNm: 1.62,
            bearingDeg: 312,
            ackedAt: null,
        });
    });

    it('one this phone already cards is not a second card, and says so (no toast)', () => {
        AisGuardAlertStore.setCollision([ownCard(NORDLICHT)], NOW);
        expect(PiNightWatchStatus.receivePush(pushData(), NOW).hadCard).toBe(true);
        expect(PiNightWatchStatus.piCards(NOW)).toEqual([]);

        AisGuardAlertStore.clear();
        hearLan(lanWatch([lanAlarm()]));
        expect(PiNightWatchStatus.receivePush(pushData(), NOW).hadCard).toBe(true);
        expect(PiNightWatchStatus.piCards(NOW).map((c) => c.key)).toEqual([KEY]);
    });

    it('a distress push: a beacon card from the Pi, with or without a position', () => {
        PiNightWatchStatus.receivePush(
            pushData({
                notification_type: 'distress_alarm',
                kind: 'distress',
                alarm_key: `distress:${SART}:${NOW}`,
                mmsi: SART,
                name: '',
                distress_kind: 'sart',
                position_known: false,
                lat: null,
                lon: null,
            }),
            NOW,
        );
        const [card] = PiNightWatchStatus.piCards(NOW);
        expect(card).toMatchObject({ kind: 'distress', mmsi: SART, distressKind: 'sart', positionKnown: false });
    });

    it('rubbish in a push is no card', () => {
        for (const bad of [
            pushData({ alarm_key: 'collision:1:2' }),
            pushData({ kind: 'shout' }),
            pushData({ mmsi: 12 }),
            pushData({ mmsi: BAY_RUNNER }),
            pushData({ alarm_key: `blind::${NOW}`, kind: 'blind' }),
            { notification_type: 'collision_alarm' },
        ]) {
            expect(PiNightWatchStatus.receivePush(bad, NOW).alarm, JSON.stringify(bad)).toBeNull();
        }
        expect(PiNightWatchStatus.piCards(NOW)).toEqual([]);
    });
});

describe('Acknowledge reaches the Pi from anywhere', () => {
    it('ashore: the RPC with the alarm’s key, and the card stays away once it is taken', async () => {
        startPiAlarmCloud();
        PiNightWatchStatus.receivePush(pushData(), NOW);
        const [card] = PiNightWatchStatus.piCards(NOW);
        PiNightWatchStatus.acknowledge(card, NOW);
        await settle();
        expect(mocks.rpc).toEqual([{ name: 'acknowledge_pi_alarm', args: { p_alarm_key: KEY } }]);
        expect(posts('/api/ais-watch/ack')).toEqual([]);
        vi.advanceTimersByTime(60_000);
        expect(PiNightWatchStatus.piCards(Date.now())).toEqual([]);
    });

    it('aboard: the RPC and the LAN acknowledgement both', async () => {
        hearLan(lanWatch([lanAlarm({ kind: 'close-quarters', key: `close-quarters:${NORDLICHT}:${NOW}` })]));
        stop = startPiNightWatch();
        const [card] = PiNightWatchStatus.piCards(Date.now());
        PiNightWatchStatus.acknowledge(card, Date.now());
        await settle();
        expect(posts('/api/ais-watch/ack').map((r) => r.data)).toEqual([{ kind: 'close-quarters', mmsi: NORDLICHT }]);
        expect(mocks.rpc).toEqual([
            { name: 'acknowledge_pi_alarm', args: { p_alarm_key: `close-quarters:${NORDLICHT}:${NOW}` } },
        ]);
    });

    it('this phone’s own card acknowledged: the Pi’s alarm for her is acknowledged in the cloud too', async () => {
        startPiAlarmCloud();
        PiNightWatchStatus.receivePush(pushData(), NOW);
        AisGuardAlertStore.setCollision([ownCard(NORDLICHT)], NOW);
        AisGuardAlertStore.muteCollision(NORDLICHT, NOW);
        await settle();
        expect(mocks.rpc).toEqual([{ name: 'acknowledge_pi_alarm', args: { p_alarm_key: KEY } }]);
    });

    it('a refused RPC: the card comes back, never a silent acknowledgement', async () => {
        startPiAlarmCloud();
        mocks.rpcError.value = { message: 'offline' };
        PiNightWatchStatus.receivePush(
            pushData({ kind: 'close-quarters', alarm_key: `close-quarters:${NORDLICHT}:${NOW}` }),
            NOW,
        );
        const [card] = PiNightWatchStatus.piCards(NOW);
        PiNightWatchStatus.acknowledge(card, NOW);
        await settle();
        expect(PiNightWatchStatus.piCards(NOW + 1_000)).toEqual([]);
        expect(PiNightWatchStatus.piCards(NOW + 31_000).map((c) => c.key)).toEqual([card.key]);
    });

    it('signed out: no RPC at all', async () => {
        setAuthIdentityScope(null);
        startPiAlarmCloud();
        PiNightWatchStatus.receivePush(pushData(), NOW);
        PiNightWatchStatus.acknowledge(PiNightWatchStatus.piCards(NOW)[0], NOW);
        await settle();
        expect(mocks.rpc).toEqual([]);
    });
});

describe('waking ashore: the owner’s open alarms from the cloud', () => {
    const row = (over: Record<string, unknown> = {}) => ({
        alarm_key: KEY,
        kind: 'collision',
        mmsi: NORDLICHT,
        payload: { name: 'NORDLICHT', cpa_nm: 0.08, tcpa_min: 4.2, range_nm: 1.62, bearing_deg: 312 },
        raised_at: new Date(NOW - 60_000).toISOString(),
        acked_at: null,
        resolved_at: null,
        ...over,
    });

    it('open, unacknowledged and recent: a card; gone from the cloud: gone here', async () => {
        mocks.rows.value = [row()];
        await refreshPiAlarms();
        const [select] = mocks.selects;
        expect(select.table).toBe('pi_alarm_events');
        expect(select.calls).toContainEqual(['is', ['resolved_at', null]]);
        expect(select.calls).toContainEqual(['is', ['acked_at', null]]);
        expect(select.calls).toContainEqual(['limit', [20]]);
        expect(PiNightWatchStatus.piCards(Date.now()).map((c) => c.key)).toEqual([KEY]);
        mocks.rows.value = [];
        await refreshPiAlarms();
        expect(PiNightWatchStatus.piCards(Date.now())).toEqual([]);
    });

    it('before the table exists (the DB push not yet run): no card, no error, no more asking', async () => {
        mocks.selectError.value = { message: 'relation "public.pi_alarm_events" does not exist', code: '42P01' };
        await expect(refreshPiAlarms()).resolves.toBeUndefined();
        await refreshPiAlarms();
        expect(mocks.selects).toHaveLength(1);
        expect(PiNightWatchStatus.piCards(Date.now())).toEqual([]);
    });

    it('signed out: nothing is asked', async () => {
        setAuthIdentityScope(null);
        await refreshPiAlarms();
        expect(mocks.selects).toEqual([]);
    });
});

describe('the AIS key says whether the Pi can wake this phone', () => {
    const view = (over: Partial<PiWatchView> = {}): PiWatchView => ({
        paired: true,
        report: { state: 'armed', lastPassAt: NOW - 2_000, via: 'lan', atAnchor: null },
        reachable: true,
        pending: null,
        push: { state: 'ready', forThisAccount: true, tokenHere: true },
        ...over,
    });
    const note = (v: PiWatchView, armed = true) => presentCollisionWatchRow({ armed }, v, NOW)?.note;

    it('only when the Pi proved the path, this phone has a token and this account is the one it wakes', () => {
        expect(note(view())).toBe(PI_WATCH_CAN_WAKE_NOTE);
        expect(note(view(), false)).toBe(PI_WATCH_CAN_WAKE_NOTE);
        expect(note(view({ push: { state: 'ready', forThisAccount: true, tokenHere: false } }))).toBe(
            PI_WATCH_NO_TOKEN_NOTE,
        );
        expect(note(view({ push: { state: 'ready', forThisAccount: false, tokenHere: true } }))).toBe(
            PI_WATCH_SKIPPER_ONLY_NOTE,
        );
        expect(note(view({ push: { state: 'ready', forThisAccount: null, tokenHere: true } }))).toBe(
            PI_WATCH_LOCKED_PHONE_NOTE,
        );
        for (const state of ['unavailable', 'not-paired', null] as const) {
            expect(note(view({ push: { state, forThisAccount: true, tokenHere: true } })), String(state)).toBe(
                PI_WATCH_LOCKED_PHONE_NOTE,
            );
        }
        expect(note(view({ push: undefined }))).toBe(PI_WATCH_LOCKED_PHONE_NOTE);
        expect(note(view({ push: { state: 'internet-off', forThisAccount: true, tokenHere: true } }))).toBe(
            PI_WATCH_INTERNET_OFF_NOTE,
        );
        expect(PI_WATCH_LOCKED_PHONE_NOTE).toBe("The Pi watches, but can't wake a locked phone yet.");
        expect(PI_WATCH_CAN_WAKE_NOTE).toBe('The Pi can wake this phone.');
        expect(PI_WATCH_INTERNET_OFF_NOTE).toBe("The Pi can't wake this phone: internet use is off on the Pi.");
    });

    it('from the LAN: the Pi’s word, its owner against this account, and this phone’s token', async () => {
        stop = startPiNightWatch();
        hearLan(lanWatch());
        await settle();
        expect(note(PiNightWatchStatus.view(Date.now()))).toBe(PI_WATCH_CAN_WAKE_NOTE);
        // A crew member's phone, paired to the skipper's Pi.
        setAuthIdentityScope('crew-2');
        expect(note(PiNightWatchStatus.view(Date.now()))).toBe(PI_WATCH_SKIPPER_ONLY_NOTE);
        setAuthIdentityScope(OWNER);
        // No token here (notifications off, or not registered yet).
        mocks.token.value = null;
        hearLan(lanWatch());
        await settle();
        expect(note(PiNightWatchStatus.view(Date.now()))).toBe(PI_WATCH_NO_TOKEN_NOTE);
        mocks.token.value = 'apns-token-fictional';
        // A token APNs handed over that was never registered for this account
        // (the claim failed at launch): send-push has nothing to wake here.
        mocks.registered.value = false;
        hearLan(lanWatch());
        await settle();
        expect(note(PiNightWatchStatus.view(Date.now()))).toBe(PI_WATCH_NO_TOKEN_NOTE);
        mocks.registered.value = true;
        hearLan(lanWatch());
        await settle();
        expect(note(PiNightWatchStatus.view(Date.now()))).toBe(PI_WATCH_CAN_WAKE_NOTE);
        // A proof over an hour old, on the Pi's own clock, proves nothing now.
        hearLan(lanWatch([], { state: 'ready', checkedAt: NOW - 66 * 60_000, ownerId: OWNER }));
        await settle();
        expect(note(PiNightWatchStatus.view(Date.now()))).toBe(PI_WATCH_LOCKED_PHONE_NOTE);
        // A Pi from before 126-04b says nothing of pushes.
        hearLan(lanWatch([], null));
        expect(note(PiNightWatchStatus.view(Date.now()))).toBe(PI_WATCH_LOCKED_PHONE_NOTE);
    });

    it('ashore: the cloud row’s fourth key, on this account’s own row', async () => {
        stop = startPiNightWatch();
        await settle();
        const report = aisWatchFromCloudExtra({
            ais_watch: 'armed',
            ais_watch_at_ms: NOW - 3_000,
            ais_watch_alarms: 0,
            ais_watch_push: 'ready',
        });
        expect(report?.push).toBe('ready');
        PiNightWatchStatus.ingestCloud(report, NOW);
        expect(note(PiNightWatchStatus.view(NOW))).toBe(PI_WATCH_CAN_WAKE_NOTE);
        PiNightWatchStatus.ingestCloud(
            aisWatchFromCloudExtra({
                ais_watch: 'armed',
                ais_watch_at_ms: NOW - 3_000,
                ais_watch_alarms: 0,
                ais_watch_push: 'internet-off',
            }),
            NOW,
        );
        expect(note(PiNightWatchStatus.view(NOW))).toBe(PI_WATCH_INTERNET_OFF_NOTE);
        expect(
            aisWatchFromCloudExtra({ ais_watch: 'armed', ais_watch_at_ms: NOW, ais_watch_push: 'loud' })?.push,
        ).toBeUndefined();
    });
});

describe('the cloud row’s 40-key cap', () => {
    /** Every supplement the Pi sends at once (as tests/PiNightWatchClient.test.ts): 37 keys. */
    const busyBus = (): Record<string, number | string> => {
        const extra: Record<string, number | string> = {};
        for (let i = 0; i < 36; i += 1) extra[`sensor_${String(i).padStart(2, '0')}`] = i;
        extra.wind_history_identity = 'pi-fictional-identity';
        return extra;
    };
    const snapshot = (extra: Record<string, number | string>): TelemetrySnapshot =>
        ({
            reportedAt: new Date(NOW).toISOString(),
            lat: -36.75,
            lon: 174.95,
            extra,
        }) as unknown as TelemetrySnapshot;
    const leading = { ais_watch: 'armed', ais_watch_at_ms: NOW - 2_000, ais_watch_alarms: 0 };

    it('a full bus keeps every instrument key; the push word is the one dropped, and nothing is claimed', () => {
        const body = buildTelemetryBody(snapshot(busyBus()), 'calypso', leading, { ais_watch_push: 'ready' });
        const relayed = parseTelemetryBody(body, NOW);
        if (!relayed.ok) throw new Error(relayed.error);
        expect(relayed.row.extra.wind_history_identity).toBe('pi-fictional-identity');
        expect(relayed.row.extra.ais_watch_push).toBeUndefined();
        const report = aisWatchFromCloudExtra(relayed.row.extra);
        PiNightWatchStatus.setPaired(true);
        PiNightWatchStatus.setPushTokenHere(true);
        PiNightWatchStatus.ingestCloud(report, NOW);
        expect(presentCollisionWatchRow({ armed: false }, PiNightWatchStatus.view(NOW), NOW)?.note).toBe(
            PI_WATCH_LOCKED_PHONE_NOTE,
        );
    });

    it('with room, the push word reaches the phone ashore', () => {
        const body = buildTelemetryBody(snapshot({ house_battery_soc_pct: 87.5 }), 'calypso', leading, {
            ais_watch_push: 'ready',
        });
        const relayed = parseTelemetryBody(body, NOW);
        if (!relayed.ok) throw new Error(relayed.error);
        expect(aisWatchFromCloudExtra(relayed.row.extra)?.push).toBe('ready');
    });
});

describe('Send a test from the Pi', () => {
    it('aboard: offered on the row, sent over the pinned lane, and its answer returned', async () => {
        mocks.respond = (url) =>
            url.endsWith('/api/ais-watch/test')
                ? { status: 200, data: JSON.stringify({ status: 'ok', push: 'ready', queued: true }) }
                : { status: 200, data: JSON.stringify({ status: 'ok' }) };
        hearLan(lanWatch());
        stop = startPiNightWatch();
        await settle();
        const row = presentCollisionWatchRow({ armed: true }, PiNightWatchStatus.view(Date.now()), Date.now());
        expect(row?.test).toBe(true);
        const result = await PiNightWatchStatus.sendTest();
        expect(result).toEqual({ push: 'ready', queued: true });
        const [sent] = posts('/api/ais-watch/test');
        expect(sent.url).toBe('https://192.168.1.50:3001/api/ais-watch/test');
        expect(sent.method).toBe('POST');
    });

    it('a crew phone paired to the skipper’s Pi: not offered (the test would wake only the skipper)', async () => {
        setAuthIdentityScope('crew-2');
        hearLan(lanWatch());
        stop = startPiNightWatch();
        await settle();
        for (const state of ['ready', 'unavailable'] as const) {
            hearLan(lanWatch([], { state, checkedAt: NOW - 60_000, ownerId: OWNER }));
            const row = presentCollisionWatchRow({ armed: true }, PiNightWatchStatus.view(Date.now()), Date.now());
            expect(row?.test, state).toBeUndefined();
        }
        // Not known whose phone this is (signed out): not offered either.
        setAuthIdentityScope(null);
        const row = presentCollisionWatchRow({ armed: true }, PiNightWatchStatus.view(Date.now()), Date.now());
        expect(row?.test).toBeUndefined();
    });

    it('ashore, or with internet off on the Pi: not offered, and nothing is sent', async () => {
        stop = startPiNightWatch();
        await settle();
        expect(await PiNightWatchStatus.sendTest()).toBeNull();
        expect(posts('/api/ais-watch/test')).toEqual([]);
        hearLan(lanWatch([], { state: 'internet-off', checkedAt: null, ownerId: OWNER }));
        const row = presentCollisionWatchRow({ armed: true }, PiNightWatchStatus.view(Date.now()), Date.now());
        expect(row?.test).toBeUndefined();
    });
});
