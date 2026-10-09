/**
 * The phone's half of the Pi's night watch (build 126, package 126-04a).
 *
 * Arming the collision shield aboard arms the Pi too; disarming stands it
 * down. The phone tells the Pi over the pinned lane (services/PiPairingService
 * pinnedPiRequest, never plain fetch) while it can reach her, and keeps a
 * change it could not send until it can. Acknowledgements travel both ways
 * with the key (kind, MMSI) for the open encounter: silencing on any phone
 * silences the Pi and every other phone aboard. Ashore, the Pi's cloud row
 * carries three `ais_watch*` keys, first in `extra`, so the row's 40-key cap
 * can never drop them.
 *
 * Fictional ships: own boat 'Kestrel' (MMSI 235000101), Nordlicht 211000001,
 * Bay Runner 366000002, a SART 970000003. Waters worldwide.
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
    anchor: { value: 'none' as 'at-anchor' | 'elsewhere' | 'none' },
}));

const DEVICE = 'dev-0f9c2d4e-fictional-kestrel-phone';
vi.mock('../services/skipperDevice', () => ({
    deviceIdReady: async () => DEVICE,
    getDeviceId: () => DEVICE,
}));
// The phone's own anchor watch, as services/collisionAnchorWatch.ts reads it.
vi.mock('../services/AisGuardWatch', () => ({
    readCollisionInputs: () => ({ anchorWatch: mocks.anchor.value }),
}));

vi.mock('../services/PiPairingService', () => ({
    getPairing: () => mocks.pairing.value,
    pinnedPiRequest: async (options: {
        url: string;
        method?: string;
        data?: unknown;
        headers?: Record<string, string>;
    }) => {
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

import { AisGuardAlertStore, type DistressBeacon } from '../services/aisGuardAlertStore';
import { PI_WATCH_RETRY_MS, __resetPiNightWatchForTests, startPiNightWatch } from '../services/piNightWatch';
import { PiNightWatchStatus, aisWatchFromCloudExtra } from '../services/piNightWatchStatus';
import { presentCollisionWatchRow } from '../utils/collisionWatchRow';
import { PiTelemetryService } from '../services/PiTelemetryService';
import { rowToTelemetry } from '../services/CloudTelemetryService';
import { AisNightWatch } from '../pi-cache/src/aisWatch';
import { AisStore } from '../services/AisStore';
import { CloudTelemetryService } from '../services/CloudTelemetryService';
import { NmeaStore } from '../services/NmeaStore';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';
import type { TelemetrySnapshot } from '../pi-cache/src/trackSignalk';

const NOW = Date.parse('2026-10-09T21:00:00Z');
const NORDLICHT = 211_000_001;
const BAY_RUNNER = 366_000_002;
const SART = 970_000_003;

const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function setShield(armed: boolean) {
    mocks.zone.state = { ...mocks.zone.state, enabled: armed, collisionChecked: armed ? true : undefined };
    for (const fn of mocks.zone.listeners) fn(mocks.zone.state);
}

function setPrefs(collisionAlarm: unknown) {
    mocks.settings.value = { ...mocks.settings.value, collisionAlarm };
    for (const fn of mocks.settings.listeners) fn({ settings: mocks.settings.value });
}

interface WireAlarm {
    key: string;
    kind: 'collision' | 'close-quarters' | 'distress';
    mmsi: number;
    name: string;
    cpaNm: number | null;
    tcpaMin: number | null;
    rangeNm: number | null;
    bearingDeg: number | null;
    lat: number | null;
    lon: number | null;
    raisedAt: number;
    ackedAt: number | null;
}

const alarm = (over: Partial<WireAlarm> & Pick<WireAlarm, 'kind' | 'mmsi'>): WireAlarm => ({
    key: `${over.kind}:${over.mmsi}:${NOW - 60_000}`,
    name: 'NORDLICHT',
    cpaNm: 0.05,
    tcpaMin: 4,
    rangeNm: 1.2,
    bearingDeg: 88,
    lat: 50.78,
    lon: -1.17,
    raisedAt: NOW - 60_000,
    ackedAt: null,
    ...over,
});

/** The Pi's /api/telemetry ais_watch, as pi-cache/src/aisWatch.ts describe() gives it. */
const lanWatch = (
    state: 'off' | 'armed' | 'blind' | 'no-fix',
    alarms: WireAlarm[] = [],
    at = Date.now(),
    over: Record<string, unknown> = {},
) => ({
    v: 1,
    state,
    armed: state !== 'off',
    armedAt: state === 'off' ? null : at - 600_000,
    lastPassAt: state === 'off' ? null : at - 1_000,
    servedAt: at,
    atAnchor: false,
    own: 'moving',
    devices: state === 'off' ? 0 : 1,
    alarms,
    ...over,
});

/** One LAN answer, as PiTelemetryService hands it over. */
const hearLan = (watch: unknown) => PiNightWatchStatus.ingestLan(watch, { nowMs: Date.now(), answeredVia: 'lan-host' });

const posts = (path: string) => mocks.requests.filter((r) => r.url.endsWith(path));

let stop: (() => void) | null = null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    mocks.requests.length = 0;
    mocks.respond = null;
    mocks.zone.state = { enabled: false, radiusNm: 2, alerts: [], collisionChecked: undefined };
    mocks.zone.listeners.clear();
    mocks.settings.value = { vessel: { mmsi: '235000101' }, collisionAlarm: undefined };
    mocks.settings.listeners.clear();
    mocks.anchor.value = 'none';
    AisGuardAlertStore.clear();
    PiNightWatchStatus.__resetForTests();
    __resetPiNightWatchForTests();
});

afterEach(() => {
    stop?.();
    stop = null;
    PiTelemetryService.resetForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('the shield arms the Pi too', () => {
    it('arming with the Pi reachable posts the armed state and the skipper’s thresholds, pinned', async () => {
        hearLan(lanWatch('off'));
        stop = startPiNightWatch();
        setShield(true);
        await settle();
        const [post] = posts('/api/ais-watch');
        expect(post).toBeDefined();
        expect(post.url).toBe('https://192.168.1.50:3001/api/ais-watch');
        expect(post.method).toBe('POST');
        expect(post.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(post.data).toEqual({
            armed: true,
            prefs: { offshore: { cpaNm: 0.5, tcpaMin: 15 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } },
            ownMmsi: 235_000_101,
            // This install: the Pi keeps every device that armed it.
            device: DEVICE,
        });
        expect(PiNightWatchStatus.view(Date.now()).pending).toBeNull();
    });

    it('starting up changes nothing on the Pi: only a change made on this phone is sent', async () => {
        mocks.zone.state = { ...mocks.zone.state, enabled: true, collisionChecked: true };
        hearLan(lanWatch('off'));
        stop = startPiNightWatch();
        await settle();
        expect(mocks.requests).toEqual([]);
        // A crew phone with its shield off never stands the Pi down by starting.
        stop();
        mocks.zone.state = { ...mocks.zone.state, enabled: false, collisionChecked: undefined };
        stop = startPiNightWatch();
        hearLan(lanWatch('armed'));
        await settle();
        expect(mocks.requests).toEqual([]);
    });

    it('unreachable: the arm waits, and goes the moment the Pi answers', async () => {
        stop = startPiNightWatch();
        setShield(true);
        await settle();
        expect(mocks.requests).toEqual([]);
        expect(PiNightWatchStatus.view(Date.now()).pending).toBe('arm');
        hearLan(lanWatch('off'));
        await settle();
        expect(posts('/api/ais-watch')).toHaveLength(1);
        expect(posts('/api/ais-watch')[0].data).toMatchObject({ armed: true });
        expect(PiNightWatchStatus.view(Date.now()).pending).toBeNull();
    });

    it('over the tailnet when that is the address that answered', async () => {
        PiNightWatchStatus.ingestLan(lanWatch('off'), { nowMs: Date.now(), answeredVia: 'tailnet-host' });
        stop = startPiNightWatch();
        setShield(true);
        await settle();
        expect(posts('/api/ais-watch')[0].url).toBe('https://100.64.0.7:3001/api/ais-watch');
    });

    it('a change to the thresholds while armed is sent again; while disarmed it is not', async () => {
        hearLan(lanWatch('off'));
        stop = startPiNightWatch();
        setPrefs({ offshore: { cpaNm: 1, tcpaMin: 20 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } });
        await settle();
        expect(mocks.requests).toEqual([]);
        setShield(true);
        await settle();
        setPrefs({ offshore: { cpaNm: 1, tcpaMin: 30 }, inshore: { cpaNm: 0.3, tcpaMin: 6 } });
        await settle();
        const sent = posts('/api/ais-watch');
        expect(sent).toHaveLength(2);
        expect(sent[1].data).toMatchObject({
            armed: true,
            prefs: { offshore: { cpaNm: 1, tcpaMin: 30 }, inshore: { cpaNm: 0.3, tcpaMin: 6 } },
        });
        // An unrelated settings change is not a re-send.
        mocks.settings.value = { ...mocks.settings.value, units: 'metric' };
        for (const fn of mocks.settings.listeners) fn({ settings: mocks.settings.value });
        await settle();
        expect(posts('/api/ais-watch')).toHaveLength(2);
    });

    it('a refused or failed send stays pending and is tried again', async () => {
        hearLan(lanWatch('off'));
        mocks.respond = () => ({ status: 503, data: '{"status":"error"}' });
        stop = startPiNightWatch();
        setShield(true);
        await settle();
        expect(posts('/api/ais-watch')).toHaveLength(1);
        expect(PiNightWatchStatus.view(Date.now()).pending).toBe('arm');
        mocks.respond = null;
        hearLan(lanWatch('off'));
        await vi.advanceTimersByTimeAsync(PI_WATCH_RETRY_MS);
        await settle();
        expect(posts('/api/ais-watch').length).toBeGreaterThanOrEqual(2);
        expect(PiNightWatchStatus.view(Date.now()).pending).toBeNull();
    });

    it('disarmed while the Pi cannot be reached: the row says the Pi is still watching', async () => {
        hearLan(lanWatch('armed'));
        mocks.zone.state = { ...mocks.zone.state, enabled: true, collisionChecked: true };
        stop = startPiNightWatch();
        // Ashore: the LAN has gone quiet; the cloud row still says armed.
        vi.advanceTimersByTime(60_000);
        PiNightWatchStatus.ingestCloud({ state: 'armed', atMs: Date.now() - 4_000, alarms: 0 }, Date.now());
        setShield(false);
        await settle();
        expect(posts('/api/ais-watch')).toEqual([]);
        const view = PiNightWatchStatus.view(Date.now());
        expect(view.pending).toBe('disarm');
        expect(presentCollisionWatchRow({ armed: false }, view, Date.now())?.text).toBe(
            'The Pi is still watching. Stand it down from aboard.',
        );
        // Back aboard: the stand-down goes, for this device's arming.
        hearLan(lanWatch('armed'));
        await settle();
        expect(posts('/api/ais-watch')[0].data).toEqual({ armed: false, device: DEVICE });
    });

    it('every request goes through the pinned transport (no fetch, no CapacitorHttp)', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync('services/piNightWatch.ts', 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(source).toContain('pinnedPiRequest(');
        expect(source).not.toMatch(/(?<![A-Za-z0-9_$])fetch\s*\(|CapacitorHttp|XMLHttpRequest/);
    });
});

describe('acknowledgements travel both ways', () => {
    const collisionCard = (mmsi: number, closeQuarters: boolean) => ({
        mmsi,
        name: mmsi === NORDLICHT ? 'NORDLICHT' : 'BAY RUNNER',
        distanceNm: 1.2,
        bearing: 88,
        sog: 12,
        cog: 270,
        shipType: '70',
        timestamp: NOW,
        collision: { cpaNm: 0.05, tcpaMin: 4, closeQuarters, reportAgeSec: 4, source: 'local' },
    });
    const sartBeacon = (): DistressBeacon => ({
        mmsi: SART,
        name: '',
        kind: 'sart',
        state: 'active',
        source: 'local',
        sounds: true,
        lat: null,
        lon: null,
        heardAt: NOW - 5_000,
        rangeNm: null,
        bearingDeg: null,
    });

    it('a DANGER the Pi was told to silence is muted here for 30 minutes', () => {
        AisGuardAlertStore.setCollision([collisionCard(NORDLICHT, false)], NOW);
        hearLan(lanWatch('armed', [alarm({ kind: 'collision', mmsi: NORDLICHT, ackedAt: NOW - 2_000 })]));
        expect(AisGuardAlertStore.mutedUntil(NORDLICHT)).toBeGreaterThanOrEqual(NOW + 30 * 60_000 - 5_000);
        expect(AisGuardAlertStore.get().some((a) => a.mmsi === NORDLICHT && a.collision)).toBe(false);
    });

    it('close quarters acknowledged on the Pi: acknowledged here for that encounter only', () => {
        const acked = alarm({ kind: 'close-quarters', mmsi: BAY_RUNNER, ackedAt: NOW - 1_000 });
        hearLan(lanWatch('armed', [acked]));
        expect(AisGuardAlertStore.acknowledged(BAY_RUNNER)).toBe(true);
        expect(AisGuardAlertStore.mutedUntil(BAY_RUNNER)).toBeNull(); // never a mute
        // Her encounter on the Pi closes: the next approach is a new one, here too.
        hearLan(lanWatch('armed', []));
        expect(AisGuardAlertStore.acknowledged(BAY_RUNNER)).toBe(false);
        // A Pi gone quiet is not a standing acknowledgement either.
        hearLan(lanWatch('armed', [acked]));
        expect(AisGuardAlertStore.acknowledged(BAY_RUNNER)).toBe(true);
        PiNightWatchStatus.lanLost(Date.now() + 25_000);
        expect(AisGuardAlertStore.acknowledged(BAY_RUNNER)).toBe(false);
    });

    it('a distress silenced on the Pi is silenced here; its card stays', () => {
        AisGuardAlertStore.setDistress([sartBeacon()], NOW);
        expect(AisGuardAlertStore.distressSounding(sartBeacon())).toBe(true);
        hearLan(
            lanWatch('armed', [alarm({ kind: 'distress', mmsi: SART, lat: null, lon: null, ackedAt: NOW - 1_000 })]),
        );
        expect(AisGuardAlertStore.distressSounding(sartBeacon())).toBe(false);
        expect(AisGuardAlertStore.distressCards().map((b) => b.mmsi)).toEqual([SART]);
    });

    it('an acknowledgement made on this phone is sent to the Pi', async () => {
        hearLan(lanWatch('armed'));
        stop = startPiNightWatch();
        AisGuardAlertStore.setCollision([collisionCard(NORDLICHT, false), collisionCard(BAY_RUNNER, true)], NOW);
        AisGuardAlertStore.muteCollision(NORDLICHT);
        AisGuardAlertStore.muteCollision(BAY_RUNNER);
        AisGuardAlertStore.setDistress([sartBeacon()], NOW);
        AisGuardAlertStore.silenceDistress(SART);
        await settle();
        expect(posts('/api/ais-watch/ack').map((r) => r.data)).toEqual([
            { kind: 'collision', mmsi: NORDLICHT },
            { kind: 'close-quarters', mmsi: BAY_RUNNER },
            { kind: 'distress', mmsi: SART },
        ]);
        expect(posts('/api/ais-watch/ack')[0].url).toBe('https://192.168.1.50:3001/api/ais-watch/ack');
    });

    it('an acknowledgement the Pi sent us is not echoed back', async () => {
        hearLan(lanWatch('armed'));
        stop = startPiNightWatch();
        AisGuardAlertStore.setCollision([collisionCard(NORDLICHT, false)], NOW);
        hearLan(lanWatch('armed', [alarm({ kind: 'collision', mmsi: NORDLICHT, ackedAt: NOW })]));
        await settle();
        expect(posts('/api/ais-watch/ack')).toEqual([]);
    });
});

describe("the Pi's own alarms on this phone", () => {
    it('one this phone has not carded shows as a card from the Pi; one it has does not', () => {
        AisGuardAlertStore.setCollision(
            [
                {
                    mmsi: BAY_RUNNER,
                    name: 'BAY RUNNER',
                    distanceNm: 0.4,
                    bearing: 12,
                    sog: 9,
                    cog: 190,
                    shipType: '70',
                    timestamp: NOW,
                    collision: { cpaNm: 0.05, tcpaMin: 2, closeQuarters: true, reportAgeSec: 3, source: 'local' },
                },
            ],
            NOW,
        );
        hearLan(
            lanWatch('armed', [
                alarm({ kind: 'collision', mmsi: NORDLICHT }),
                alarm({ kind: 'close-quarters', mmsi: BAY_RUNNER }),
                alarm({ kind: 'collision', mmsi: 366_000_009, ackedAt: NOW - 3_000 }),
            ]),
        );
        expect(PiNightWatchStatus.piCards(Date.now()).map((a) => a.mmsi)).toEqual([NORDLICHT]);
    });

    it('acknowledging a card from the Pi sends it at once and puts the card away', async () => {
        hearLan(lanWatch('armed', [alarm({ kind: 'close-quarters', mmsi: NORDLICHT })]));
        stop = startPiNightWatch();
        const [card] = PiNightWatchStatus.piCards(Date.now());
        PiNightWatchStatus.acknowledge(card, Date.now());
        await settle();
        expect(posts('/api/ais-watch/ack').map((r) => r.data)).toEqual([{ kind: 'close-quarters', mmsi: NORDLICHT }]);
        expect(PiNightWatchStatus.piCards(Date.now())).toEqual([]);
    });

    it('a LAN answer that is old news shows no card from the Pi', () => {
        hearLan(lanWatch('armed', [alarm({ kind: 'collision', mmsi: NORDLICHT })]));
        expect(PiNightWatchStatus.piCards(Date.now() + 31_000)).toEqual([]);
    });
});

describe('the LAN lane feeds the status', () => {
    it('PiTelemetryService hands the Pi’s ais_watch over on every read', async () => {
        const watch = lanWatch('blind', [alarm({ kind: 'collision', mmsi: NORDLICHT })]);
        mocks.respond = (url) =>
            url.endsWith('/api/telemetry')
                ? {
                      status: 200,
                      data: JSON.stringify({
                          available: false,
                          telemetry: null,
                          ais: [],
                          served_at: new Date(NOW).toISOString(),
                          ais_watch: watch,
                      }),
                  }
                : { status: 404, data: '{}' };
        await PiTelemetryService.pollOnce();
        const view = PiNightWatchStatus.view(Date.now());
        expect(view.reachable).toBe(true);
        expect(view.report).toMatchObject({ state: 'blind', via: 'lan' });
        expect(PiNightWatchStatus.piCards(Date.now()).map((a) => a.mmsi)).toEqual([NORDLICHT]);
    });

    it('an older Pi with no ais_watch still counts as reachable, with no report', async () => {
        mocks.respond = () => ({
            status: 200,
            data: JSON.stringify({
                available: false,
                telemetry: null,
                ais: [],
                served_at: new Date(NOW).toISOString(),
            }),
        });
        await PiTelemetryService.pollOnce();
        const view = PiNightWatchStatus.view(Date.now());
        expect(view.reachable).toBe(true);
        expect(view.report).toBeNull();
    });

    it('rubbish in ais_watch is no report, not a crash', () => {
        for (const junk of [null, 'armed', { state: 'sleeping' }, { state: 'armed', alarms: 'x' }]) {
            PiNightWatchStatus.__resetForTests();
            hearLan(junk);
            expect(PiNightWatchStatus.view(Date.now()).report).toBeNull();
        }
        PiNightWatchStatus.__resetForTests();
        hearLan({
            ...lanWatch('armed'),
            alarms: [{ kind: 'collision', mmsi: 'x' }, alarm({ kind: 'nope' as 'collision', mmsi: 1 })],
        });
        expect(PiNightWatchStatus.piCards(Date.now())).toEqual([]);
    });
});

describe('ashore: the cloud row carries the Pi watch, first in extra', () => {
    /** Every supplement the Pi sends at once, and the full wind history: the worst case. */
    const worstCaseExtra = (): Record<string, number | string> => ({
        gnss_satellites: 25,
        gnss_satellites_at_ms: NOW - 900,
        gnss_hdop: 0.8,
        gnss_hdop_at_ms: NOW - 900,
        gnss_fix_quality: 2,
        gnss_fix_quality_at_ms: NOW - 900,
        gnss_source: 'ydwg-tcp.GP-a-fairly-long-source-name',
        heading_true_deg: 271.4,
        heading_true_at_ms: NOW - 400,
        wind_tws_at_ms: NOW - 700,
        wind_tws_source: 'ydwg-tcp.WI-masthead-unit-with-a-long-name',
        wind_twd_at_ms: NOW - 700,
        heel_at: NOW - 300,
        pitch_at: NOW - 300,
        position_at: NOW - 1_000,
        depth_reference: 'below-transducer',
        depth_offset_m: -1.8,
        pressure_at: NOW - 30_000,
        pressure_3h_hpa: 1012.4,
        pressure_3h_at: NOW - 3 * 3_600_000,
        house_battery_soc_pct: 87.5,
        house_battery_at: NOW - 20_000,
        wind_history_v: 1,
        wind_history_at_ms: NOW,
        wind_history_since_ms: NOW - 3_600_000,
        wind_history_latest_ms: NOW - 700,
        wind_history_samples_1h: 720,
        wind_history_source: 'ydwg-tcp.WI-masthead-unit-with-a-long-name',
        wind_max_1h_kts: 31.2,
        wind_max_1h_at_ms: NOW - 2_400_000,
        wind_gust_10m_kts: 22.9,
        wind_gust_10m_at_ms: NOW - 240_000,
        wind_history_identity: 'pi-0f9c2d4e-6a1b-4c7d-9e3f-5b8a2c1d0e7f',
    });

    it('the three ais_watch keys go first and survive the relay’s 40-key, 4 KiB cap', () => {
        const watch = new AisNightWatch({
            documents: async () => ({ selfDoc: null, vesselsDoc: null, selfAnswer: null, readAt: NOW }),
            atAnchor: () => false,
            now: () => NOW,
        });
        watch.arm({ offshore: { cpaNm: 0.5, tcpaMin: 15 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } });
        const keys = watch.cloudExtra();
        watch.close();
        expect(Object.keys(keys)).toEqual(['ais_watch', 'ais_watch_at_ms', 'ais_watch_alarms']);

        const snapshot: TelemetrySnapshot = {
            reportedAt: new Date(NOW).toISOString(),
            lat: -36.75,
            lon: 174.95,
            sogKts: 0.1,
            cogDeg: null,
            headingDeg: 271,
            stwKts: null,
            twsKts: 14,
            twaDeg: null,
            twdDeg: 200,
            awsKts: null,
            awaDeg: null,
            depthM: 6.2,
            heelDeg: 1,
            pitchDeg: 0,
            waterTempC: 17.5,
            pressureHpa: 1013,
            rudderDeg: null,
            rpm: null,
            voltageV: 12.9,
            extra: worstCaseExtra(),
        };
        const body = buildTelemetryBody(snapshot, 'calypso', keys);
        const extra = body.extra as Record<string, unknown>;
        expect(Object.keys(extra).slice(0, 3)).toEqual(['ais_watch', 'ais_watch_at_ms', 'ais_watch_alarms']);
        expect(Object.keys(extra).length).toBeLessThanOrEqual(40);
        expect(JSON.stringify(extra).length).toBeLessThanOrEqual(4_096);

        const relayed = parseTelemetryBody(body, NOW);
        if (!relayed.ok) throw new Error(relayed.error);
        expect(relayed.row.extra.ais_watch).toBe(keys.ais_watch);
        expect(relayed.row.extra.ais_watch_at_ms).toBe(keys.ais_watch_at_ms);
        expect(relayed.row.extra.ais_watch_alarms).toBe(0);
        // Nothing the Pi already sent was dropped to make room.
        expect(relayed.row.extra.wind_history_identity).toBe('pi-0f9c2d4e-6a1b-4c7d-9e3f-5b8a2c1d0e7f');

        // And the phone reads it back off the row.
        const phone = rowToTelemetry({ owner_id: 'skipper', ...relayed.row } as never, NOW + 1_000);
        expect(phone?.aisWatch).toEqual({ state: keys.ais_watch, atMs: keys.ais_watch_at_ms, alarms: 0 });
        expect(aisWatchFromCloudExtra(relayed.row.extra)).toEqual(phone?.aisWatch);
    });

    it('a row from a Pi before update 2 has no Pi watch', () => {
        expect(aisWatchFromCloudExtra({ position_at: NOW })).toBeNull();
        expect(aisWatchFromCloudExtra({ ais_watch: 'dozing', ais_watch_at_ms: NOW, ais_watch_alarms: 0 })).toBeNull();
        expect(aisWatchFromCloudExtra(null)).toBeNull();
    });

    it('ashore, the cloud row says the Pi is watching', () => {
        PiNightWatchStatus.setPaired(true);
        PiNightWatchStatus.ingestCloud({ state: 'armed', atMs: NOW - 5_000, alarms: 1 }, NOW);
        expect(presentCollisionWatchRow({ armed: false }, PiNightWatchStatus.view(NOW), NOW)?.text).toBe(
            "Watching: the Pi (this phone can't reach it)",
        );
    });
});

// ── Review fixes (126-04a stage 3) ─────────────────────────────────────────

describe('a DANGER muted aboard ends here when it ends aboard', () => {
    const ackedAlarm = (ackedAt: number | null) =>
        alarm({ kind: 'collision', mmsi: NORDLICHT, key: `collision:${NORDLICHT}:${NOW - 120_000}`, ackedAt });

    it('until 30 min after the mute, on the Pi’s clock: never 30 min from when this phone heard it', () => {
        // The Pi's clock runs 7 s ahead of this phone's; the mute was made 10 min ago.
        const piNow = NOW + 7_000;
        hearLan(lanWatch('armed', [ackedAlarm(piNow - 10 * 60_000)], piNow));
        expect(AisGuardAlertStore.mutedUntil(NORDLICHT)).toBe(NOW + 20 * 60_000);
    });

    it('a LAN gap and the same acknowledgement heard again never makes the mute longer', () => {
        hearLan(lanWatch('armed', [ackedAlarm(NOW)]));
        expect(AisGuardAlertStore.mutedUntil(NORDLICHT)).toBe(NOW + 30 * 60_000);
        // A Wi-Fi blip, or the router's weekly reboot: the LAN lane goes stale.
        PiNightWatchStatus.lanLost(NOW + 25_000);
        vi.setSystemTime(NOW + 25 * 60_000);
        hearLan(lanWatch('armed', [ackedAlarm(NOW)]));
        expect(AisGuardAlertStore.mutedUntil(NORDLICHT)).toBe(NOW + 30 * 60_000);
        // At +31 min the Pi sounds her again: here she is no longer muted, and her card shows.
        vi.setSystemTime(NOW + 31 * 60_000);
        hearLan(lanWatch('armed', [ackedAlarm(null)]));
        expect(PiNightWatchStatus.piCards(Date.now()).map((a) => a.mmsi)).toEqual([NORDLICHT]);
    });

    it('muted again aboard before the first mute ran out: the newer 30 min reach this phone too', () => {
        hearLan(lanWatch('armed', [ackedAlarm(NOW)]));
        vi.setSystemTime(NOW + 10 * 60_000);
        // The Pi runs a DANGER's 30 min from its newest mute (pi-cache aisWatch.ts ack()).
        hearLan(lanWatch('armed', [ackedAlarm(NOW + 10 * 60_000)]));
        expect(AisGuardAlertStore.mutedUntil(NORDLICHT)).toBe(NOW + 40 * 60_000);
    });

    it('muted again aboard in the same encounter: muted again here', () => {
        hearLan(lanWatch('armed', [ackedAlarm(NOW)]));
        vi.setSystemTime(NOW + 31 * 60_000);
        hearLan(lanWatch('armed', [ackedAlarm(null)]));
        vi.setSystemTime(NOW + 32 * 60_000);
        hearLan(lanWatch('armed', [ackedAlarm(NOW + 32 * 60_000)]));
        expect(AisGuardAlertStore.mutedUntil(NORDLICHT)).toBe(NOW + 62 * 60_000);
    });
});

describe('a Pi before Pi update 2', () => {
    it('answering the LAN with no ais_watch: nothing is sent, however often it answers, and the row says so', async () => {
        hearLan(undefined);
        stop = startPiNightWatch();
        setShield(true);
        for (let i = 0; i < 31; i += 1) {
            vi.advanceTimersByTime(2_000);
            hearLan(undefined);
            await settle();
        }
        await vi.advanceTimersByTimeAsync(PI_WATCH_RETRY_MS * 3);
        expect(posts('/api/ais-watch')).toEqual([]);
        hearLan(undefined);
        expect(presentCollisionWatchRow({ armed: true }, PiNightWatchStatus.view(Date.now()), Date.now())?.text).toBe(
            'Watching: this phone only (this Pi has no night watch yet)',
        );
    });

    it('a 404 drops the change: no retries, nothing left pending', async () => {
        hearLan(lanWatch('off'));
        mocks.respond = () => ({ status: 404, data: 'Cannot POST /api/ais-watch' });
        stop = startPiNightWatch();
        setShield(true);
        await settle();
        expect(posts('/api/ais-watch')).toHaveLength(1);
        expect(PiNightWatchStatus.view(Date.now()).pending).toBeNull();
        for (let i = 0; i < 10; i += 1) {
            vi.advanceTimersByTime(2_000);
            hearLan(lanWatch('off'));
            await settle();
        }
        await vi.advanceTimersByTimeAsync(PI_WATCH_RETRY_MS * 2);
        expect(posts('/api/ais-watch')).toHaveLength(1);
    });

    it('after a refusal, LAN answers every 2 s do not send again before the 10 s retry', async () => {
        hearLan(lanWatch('off'));
        mocks.respond = () => ({ status: 503, data: '{"status":"error"}' });
        stop = startPiNightWatch();
        setShield(true);
        await settle();
        for (let i = 0; i < 4; i += 1) {
            vi.advanceTimersByTime(2_000);
            hearLan(lanWatch('off'));
            await settle();
        }
        expect(posts('/api/ais-watch')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2_000);
        await settle();
        expect(posts('/api/ais-watch')).toHaveLength(2);
    });
});

describe('one watch, several devices aboard', () => {
    it('with no MMSI typed, the one our transponder reports is sent', async () => {
        mocks.settings.value = { vessel: {}, collisionAlarm: undefined };
        vi.spyOn(AisStore, 'getOwnMmsi').mockReturnValue(235_000_101);
        hearLan(lanWatch('off'));
        stop = startPiNightWatch();
        setShield(true);
        await settle();
        expect(posts('/api/ais-watch')[0].data).toMatchObject({ armed: true, ownMmsi: 235_000_101 });
    });

    it('with this phone’s shield off and the Pi watching, the row offers to stand it down for everyone', async () => {
        hearLan(lanWatch('armed', [], Date.now(), { devices: 2 }));
        stop = startPiNightWatch();
        const row = presentCollisionWatchRow({ armed: false }, PiNightWatchStatus.view(Date.now()), Date.now());
        expect(row).toMatchObject({ text: 'Watching: the Pi', action: 'stand-down-all' });
        PiNightWatchStatus.standDownForEveryone();
        await settle();
        expect(posts('/api/ais-watch')[0].data).toEqual({ armed: false, everyone: true, device: DEVICE });
    });

    it('our own boat is never a card from the Pi', () => {
        vi.spyOn(AisStore, 'getOwnMmsi').mockReturnValue(235_000_199);
        hearLan(
            lanWatch('armed', [
                alarm({ kind: 'close-quarters', mmsi: 235_000_101, name: 'KESTREL' }),
                alarm({ kind: 'close-quarters', mmsi: 235_000_199, name: 'KESTREL' }),
                alarm({ kind: 'collision', mmsi: NORDLICHT }),
            ]),
        );
        expect(PiNightWatchStatus.piCards(Date.now()).map((a) => a.mmsi)).toEqual([NORDLICHT]);
    });
});

describe('an anchor watch the Pi cannot see', () => {
    it('at anchor on this phone, none on the Pi: the row says so in amber', async () => {
        mocks.anchor.value = 'at-anchor';
        stop = startPiNightWatch();
        hearLan(lanWatch('armed', [], Date.now(), { atAnchor: false, own: 'stopped' }));
        await settle();
        expect(PiNightWatchStatus.phoneAnchorWatch()).toBe('at-anchor');
        const row = presentCollisionWatchRow(
            { armed: true, anchorWatch: PiNightWatchStatus.phoneAnchorWatch() },
            PiNightWatchStatus.view(Date.now()),
            Date.now(),
        );
        expect(row).toMatchObject({
            text: "Watching: this phone and the Pi (it can't see the anchor watch)",
            tone: 'warn',
        });
        // Handed to the Pi: it keeps the anchor watch itself, and the row is green again.
        hearLan(lanWatch('armed', [], Date.now(), { atAnchor: true, own: 'stopped' }));
        expect(PiNightWatchStatus.phoneAnchorWatch()).toBe('none');
    });
});

describe('ashore, the AIS key reads the Pi’s watch keys only', () => {
    it('from this account’s own row, and never into the instrument lane', async () => {
        const read = vi.spyOn(CloudTelemetryService, 'readOnce').mockResolvedValue({
            ownerId: 'skipper',
            boatId: null,
            source: 'pi',
            deviceLabel: 'calypso',
            reportedAt: NOW - 5_000,
            receivedAt: NOW,
            snapshot: {} as never,
            aisWatch: { state: 'armed', atMs: NOW - 4_000, alarms: 0 },
        } as never);
        const ingest = vi.spyOn(NmeaStore, 'ingestRemote');
        PiNightWatchStatus.setPaired(true);
        const stopReading = CloudTelemetryService.followPiWatch();
        await settle();
        expect(read).toHaveBeenCalledWith('self');
        expect(PiNightWatchStatus.view(Date.now()).report).toMatchObject({ state: 'armed', via: 'cloud' });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(read).toHaveBeenCalledTimes(2);
        stopReading();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read).toHaveBeenCalledTimes(2);
        expect(ingest).not.toHaveBeenCalled();
        // The key uses that reader, not the instrument lane's retain().
        const { readFileSync } = await import('node:fs');
        const legend = readFileSync('components/map/AisLegend.tsx', 'utf8');
        expect(legend).toContain('CloudTelemetryService.followPiWatch()');
        expect(legend).not.toContain('CloudTelemetryService.retain()');
    });
});
