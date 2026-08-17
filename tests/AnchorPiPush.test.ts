/**
 * The cabin dashboard is read by someone half-asleep, so every wrong state it
 * can show is a real outcome, not a cosmetic one.
 *
 * Two of them matter more than the rest. A 'dragging' that is really just a
 * phone losing its GPS fix is a false alarm beside a bunk at 3am. A 'cleared'
 * that is really a paused watch blanks the circle and says "under way" about a
 * boat that is still on the hook. The app knows the difference — it has five
 * states where the API has three — and these tests pin the translation.
 *
 * The third is delivery: "a single anchor-set that silently fails is the one
 * case that matters" (the API spec). So the outbox is persisted, and a newer
 * state must supersede an older unsent one rather than queue behind it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const prefs = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: prefs.store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            prefs.store.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            prefs.store.delete(key);
        },
    },
}));

const http = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    CapacitorHttp: { post: http.post },
    registerPlugin: () => ({}),
}));

import {
    AnchorPiPush,
    buildAnchorPayload,
    mapAnchorState,
    payloadsEqual,
    postAnchorState,
    writeAnchorPiConfig,
    type AnchorPiPayload,
} from '../services/anchorPiPush';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';

const snap = (over: Partial<AnchorWatchSnapshot> = {}): AnchorWatchSnapshot =>
    ({
        state: 'watching',
        anchorPosition: { latitude: -27.208123456, longitude: 153.087654321, timestamp: 1 },
        vesselPosition: null,
        swingRadius: 42.55,
        distanceFromAnchor: 12.34,
        maxDistanceRecorded: 20,
        bearingToAnchor: 180,
        config: { rodeLength: 45, waterDepth: 6, scopeRatio: 7, rodeType: 'chain', safetyMargin: 5 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: 1,
        gpsAccuracy: 3,
        gpsQuality: 'precision',
        gpsQualityLabel: 'Precision',
        guardianStatus: 'armed',
        setupError: null,
        ...over,
    }) as AnchorWatchSnapshot;

/**
 * offer() kicks its drain off without awaiting — deliberately, so a notify from
 * the anchor watch never blocks on a network call. Tests therefore have to let
 * that in-flight drain finish before asserting, or they race it and read the
 * outbox mid-flight.
 */
const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
    prefs.store.clear();
    http.post.mockReset();
    AnchorPiPush.__resetForTests();
});

describe('anchor state translation', () => {
    it('reports a lost GPS fix as still holding, NOT as dragging', () => {
        // The app raises the same 'alarm' state for a drag and for going
        // blind. Only one of those means the boat moved. Reporting a blind
        // watch as a drag is a false alarm at the worst possible hour.
        const mapped = mapAnchorState(snap({ state: 'alarm', alarmCause: 'gps-lost' }));
        expect(mapped).toEqual({
            state: 'holding',
            watching: false,
            detail: 'No GPS fix — watch is blind',
        });
    });

    it('reports a real drag as dragging', () => {
        expect(mapAnchorState(snap({ state: 'alarm', alarmCause: 'drag' }))).toEqual({
            state: 'dragging',
            watching: true,
        });
    });

    it('keeps the circle on screen when the watch is paused', () => {
        // 'cleared' blanks the panel. The anchor is still down — blanking it
        // would tell the crew the boat is under way.
        const mapped = mapAnchorState(snap({ state: 'paused' }));
        expect(mapped?.state).toBe('holding');
        expect(mapped?.watching).toBe(false);
    });

    it('sends cleared when the watch goes idle, whatever route it took', () => {
        // Weighing anchor is only one of several ways to reach idle. All of
        // them should blank the panel.
        expect(mapAnchorState(snap({ state: 'idle' }))?.state).toBe('cleared');
    });

    it('says nothing at all while the anchor is still being set', () => {
        // There is no anchor position yet; a push here would draw a circle
        // around a boat that has not anchored.
        expect(mapAnchorState(snap({ state: 'setting' }))).toBeNull();
    });
});

describe('payload', () => {
    it('sends the ANCHOR position at 7dp, and metres', () => {
        const p = buildAnchorPayload(snap(), 'thalassa-ios')!;
        expect(p.lat).toBe(-27.2081235);
        expect(p.lon).toBe(153.0876543);
        expect(p.radius_m).toBe(42.6);
        expect(p.rode_m).toBe(45);
        expect(p.depth_m).toBe(6);
        expect(p.source).toBe('thalassa-ios');
    });

    it('still reports cleared once the anchor position is gone', () => {
        // The blanking message must survive the state it describes.
        const p = buildAnchorPayload(snap({ state: 'idle', anchorPosition: null }), 'thalassa-ios');
        expect(p?.state).toBe('cleared');
    });

    it('refuses to push a non-cleared state with no anchor position', () => {
        expect(buildAnchorPayload(snap({ state: 'watching', anchorPosition: null }), 'x')).toBeNull();
    });

    it('does not let a swinging boat turn an event push into a timer', () => {
        // distance_m changes on every fix. If it counted toward equality, the
        // service would post continuously — the exact thing the API asked it
        // not to do, since the Pi derives distance from its own GPS.
        const a = buildAnchorPayload(snap({ distanceFromAnchor: 10 }), 'x');
        const b = buildAnchorPayload(snap({ distanceFromAnchor: 18 }), 'x');
        expect(payloadsEqual(a, b)).toBe(true);
    });

    it('treats a radius change as news', () => {
        const a = buildAnchorPayload(snap({ swingRadius: 40 }), 'x');
        const b = buildAnchorPayload(snap({ swingRadius: 60 }), 'x');
        expect(payloadsEqual(a, b)).toBe(false);
    });
});

describe('delivery', () => {
    const payload: AnchorPiPayload = {
        state: 'holding',
        lat: -27.2,
        lon: 153.1,
        radius_m: 40,
        source: 'test',
        watching: true,
    };
    const config = { endpoint: 'https://pi.example.ts.net/api/anchor', token: 'tok' };

    it('maps the documented responses', async () => {
        http.post.mockResolvedValueOnce({ status: 200 });
        expect(await postAnchorState(payload, config)).toBe('sent');
        http.post.mockResolvedValueOnce({ status: 401 });
        expect(await postAnchorState(payload, config)).toBe('unauthorised');
        http.post.mockResolvedValueOnce({ status: 400 });
        expect(await postAnchorState(payload, config)).toBe('rejected');
        http.post.mockRejectedValueOnce(new Error('offline'));
        expect(await postAnchorState(payload, config)).toBe('unreachable');
    });

    it('sends a bearer token and JSON', async () => {
        http.post.mockResolvedValueOnce({ status: 200 });
        await postAnchorState(payload, config);
        const call = http.post.mock.calls[0][0];
        expect(call.url).toBe(config.endpoint);
        expect(call.headers.Authorization).toBe('Bearer tok');
        expect(call.data).toEqual(payload);
    });

    it('refuses to post a boat position over plaintext http', async () => {
        await writeAnchorPiConfig('http://pi.example.ts.net/api/anchor', 'tok');
        await AnchorPiPush.offer(snap());
        await flush();
        await AnchorPiPush.drain();
        expect(http.post).not.toHaveBeenCalled();
    });
});

describe('outbox', () => {
    it('holds an anchor-set that failed, and delivers it on the next drain', async () => {
        // The case the spec singles out: the push fails and must not be lost.
        await writeAnchorPiConfig('https://pi.example.ts.net/api/anchor', 'tok');
        http.post.mockRejectedValueOnce(new Error('off the tailnet'));
        await AnchorPiPush.offer(snap());
        await flush();
        expect(prefs.store.get('anchor_pi_outbox')).toBeTruthy();

        http.post.mockResolvedValueOnce({ status: 200 });
        await AnchorPiPush.drain();
        expect(prefs.store.get('anchor_pi_outbox')).toBeUndefined();
        expect(http.post.mock.calls[1][0].data.state).toBe('holding');
    });

    it('never resurrects a weighed anchor by replaying an older state', async () => {
        // A FIFO queue would send the stale 'holding' after the 'cleared' and
        // put an anchor back on the dashboard that the skipper already lifted.
        await writeAnchorPiConfig('https://pi.example.ts.net/api/anchor', 'tok');
        http.post.mockRejectedValue(new Error('off the tailnet'));
        await AnchorPiPush.offer(snap({ state: 'watching' }));
        await flush();
        await AnchorPiPush.offer(snap({ state: 'idle', anchorPosition: null }));
        await flush();

        http.post.mockReset();
        http.post.mockResolvedValue({ status: 200 });
        await AnchorPiPush.drain();

        expect(http.post).toHaveBeenCalledTimes(1);
        expect(http.post.mock.calls[0][0].data.state).toBe('cleared');
        expect(prefs.store.get('anchor_pi_outbox')).toBeUndefined();
    });

    it('keeps the state when the dashboard has not been set up yet', async () => {
        // No endpoint or token entered. Holding the state is right; dropping
        // it would mean the first anchor-set after setup never arrives.
        await AnchorPiPush.offer(snap());
        await flush();
        await AnchorPiPush.drain();
        expect(http.post).not.toHaveBeenCalled();
        expect(prefs.store.get('anchor_pi_outbox')).toBeTruthy();
    });

    it('does not spend a request on an unchanged state', async () => {
        await writeAnchorPiConfig('https://pi.example.ts.net/api/anchor', 'tok');
        http.post.mockResolvedValue({ status: 200 });
        await AnchorPiPush.offer(snap());
        await flush();
        await AnchorPiPush.offer(snap({ distanceFromAnchor: 19 }));
        await flush();
        await AnchorPiPush.drain();
        expect(http.post).toHaveBeenCalledTimes(1);
    });
});
