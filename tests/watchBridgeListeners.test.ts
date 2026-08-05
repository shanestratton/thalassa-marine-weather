/**
 * Tests for watchBridgeListeners — verifies the watch→TS routing
 * (mob trigger, alarm ack) and the TS→watch weather coalescing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    preferences: {} as Record<string, string>,
    toastInfo: vi.fn(),
    toastPersistentError: vi.fn(),
}));

// ── Capacitor stub: pretend we're on iOS so the listeners actually wire up.
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'ios',
        isNativePlatform: () => true,
    },
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: harness.preferences[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            harness.preferences[key] = value;
        }),
    },
}));

vi.mock('../components/Toast', () => ({
    toast: {
        info: harness.toastInfo,
        persistentError: harness.toastPersistentError,
    },
}));

// ── watchBridge stubs that capture handler refs we can fire manually.
// vi.mock factories are hoisted, so we can't close over locals — instead
// stash handler refs on globalThis and look them up from inside the
// factory.
vi.mock('../services/native/watchBridge', () => ({
    onMobTriggered: vi.fn(async (h: (event: Record<string, unknown>) => Promise<void>) => {
        (globalThis as Record<string, unknown>).__mobHandler = h;
        return { remove: async () => undefined };
    }),
    onAlarmAck: vi.fn(async (h: () => void) => {
        (globalThis as Record<string, unknown>).__alarmHandler = h;
        return { remove: async () => undefined };
    }),
    pushWeatherSnapshot: vi.fn(async () => undefined),
}));

vi.mock('../services/MobService', () => ({
    MobService: { activate: vi.fn(async () => null) },
}));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { acknowledgeAlarm: vi.fn() },
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { getGpsNavData: vi.fn(() => ({ sogKts: 5.2, cogDeg: 187 })) },
}));

// Pull the actual mock instances post-import so we can assert on them.
const watchBridge = await import('../services/native/watchBridge');
const mobSvc = await import('../services/MobService');
const anchorSvc = await import('../services/AnchorWatchService');
const pushWeather = watchBridge.pushWeatherSnapshot as ReturnType<typeof vi.fn>;
const mobActivate = mobSvc.MobService.activate as ReturnType<typeof vi.fn>;
const ackAlarm = anchorSvc.AnchorWatchService.acknowledgeAlarm as ReturnType<typeof vi.fn>;
function getMobHandler(): (event: Record<string, unknown>) => Promise<void> {
    return (globalThis as Record<string, unknown>).__mobHandler as (event: Record<string, unknown>) => Promise<void>;
}
function getAlarmHandler(): () => void {
    return (globalThis as Record<string, unknown>).__alarmHandler as () => void;
}

import { useWeatherStore } from '../stores/weatherStore';
import {
    _pushWeatherHeartbeatForTests,
    _resetForTests,
    initWatchBridgeListeners,
} from '../services/native/watchBridgeListeners';
import {
    _resetWatchMobRequestSafetyForTests,
    WATCH_MOB_REQUEST_TTL_MS,
} from '../services/native/watchMobRequestSafety';

const REQUEST_A = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_B = '223e4567-e89b-42d3-a456-426614174000';

function makeMobRequest(overrides: Record<string, unknown> = {}, requestedAtMs = Date.now()): Record<string, unknown> {
    return {
        type: 'mob',
        mobRequestVersion: 1,
        mobRequestId: REQUEST_A,
        mobRequestedAtMs: requestedAtMs,
        mobRequestTtlMs: WATCH_MOB_REQUEST_TTL_MS,
        mobRequestExpiresAtMs: requestedAtMs + WATCH_MOB_REQUEST_TTL_MS,
        deliveryChannel: 'immediate',
        ...overrides,
    };
}

function makeWeather(overrides: Record<string, unknown> = {}) {
    // Cast through unknown — we only populate the fields the listener
    // actually reads (current.windSpeed/windDegree/windGust/pressure).
    return {
        locationName: 'Test',
        current: {
            windSpeed: 12,
            windDegree: 90,
            windGust: 18,
            pressure: 1013,
            ...overrides,
        },
        forecast: [],
        hourly: [],
        tides: [],
        boatingAdvice: '',
        generatedAt: new Date().toISOString(),
        modelUsed: 'test',
    } as unknown as NonNullable<ReturnType<typeof useWeatherStore.getState>['weatherData']>;
}

describe('watchBridgeListeners', () => {
    beforeEach(async () => {
        _resetForTests();
        await _resetWatchMobRequestSafetyForTests();
        for (const key of Object.keys(harness.preferences)) delete harness.preferences[key];
        (globalThis as Record<string, unknown>).__mobHandler = null;
        (globalThis as Record<string, unknown>).__alarmHandler = null;
        pushWeather.mockClear();
        mobActivate.mockReset();
        mobActivate.mockResolvedValue({ fixLat: -27, fixLon: 153, fixAccuracy: 12, activatedAt: Date.now() });
        ackAlarm.mockClear();
        harness.toastInfo.mockClear();
        harness.toastPersistentError.mockClear();
        useWeatherStore.setState({ weatherData: null });
        await initWatchBridgeListeners();
    });

    afterEach(() => {
        _resetForTests();
        useWeatherStore.setState({ weatherData: null });
    });

    describe('idempotent boot', () => {
        it('does not re-subscribe on a second init call', async () => {
            const before = getMobHandler();
            await initWatchBridgeListeners();
            // Handler reference unchanged because the second call short-circuited.
            expect(getMobHandler()).toBe(before);
        });
    });

    describe('watch → MOB', () => {
        it('routes a fresh versioned request through MobService.activate', async () => {
            expect(getMobHandler()).not.toBeNull();
            await getMobHandler()(makeMobRequest());
            expect(mobActivate).toHaveBeenCalledTimes(1);
            expect(harness.toastInfo).toHaveBeenCalledWith(expect.stringContaining('confirm the active marker'), 8_000);
        });

        it('survives MobService.activate throwing (does not crash the listener)', async () => {
            mobActivate.mockRejectedValueOnce(new Error('boom'));
            await expect(getMobHandler()(makeMobRequest())).resolves.not.toThrow();
            expect(harness.toastPersistentError).toHaveBeenCalledWith(
                expect.stringContaining('could not create a phone marker'),
            );
        });

        it('never marks the phone current position for an expired queued request', async () => {
            const oldRequest = makeMobRequest({ deliveryChannel: 'queued' }, Date.now() - WATCH_MOB_REQUEST_TTL_MS - 1);

            await getMobHandler()(oldRequest);

            expect(mobActivate).not.toHaveBeenCalled();
            expect(harness.toastPersistentError).toHaveBeenCalledWith(
                expect.stringContaining('expired and was NOT marked'),
            );
        });

        it.each([
            ['missing request ID', { mobRequestId: undefined }],
            ['wrong TTL', { mobRequestTtlMs: WATCH_MOB_REQUEST_TTL_MS * 10 }],
            ['future-dated', null],
        ])('rejects an invalid %s envelope visibly', async (_label, override) => {
            const event =
                override === null
                    ? makeMobRequest({}, Date.now() + 60_000)
                    : makeMobRequest(override as Record<string, unknown>);

            await getMobHandler()(event);

            expect(mobActivate).not.toHaveBeenCalled();
            expect(harness.toastPersistentError).toHaveBeenCalledWith(
                expect.stringContaining('could not be verified and was NOT marked'),
            );
        });

        it('deduplicates the same stable ID across immediate and queued delivery', async () => {
            const requestedAtMs = Date.now();
            await getMobHandler()(makeMobRequest({ deliveryChannel: 'immediate' }, requestedAtMs));
            await getMobHandler()(makeMobRequest({ deliveryChannel: 'queued' }, requestedAtMs));

            expect(mobActivate).toHaveBeenCalledTimes(1);
            expect(harness.toastInfo).toHaveBeenCalledTimes(1);
        });

        it('keeps the ID reservation across a bridge listener re-init', async () => {
            const event = makeMobRequest({ mobRequestId: REQUEST_B });
            await getMobHandler()(event);
            _resetForTests();
            await initWatchBridgeListeners();

            await getMobHandler()({ ...event, deliveryChannel: 'queued' });

            expect(mobActivate).toHaveBeenCalledTimes(1);
        });
    });

    describe('watch → alarm ack', () => {
        it('routes alarmAck through AnchorWatchService.acknowledgeAlarm', async () => {
            expect(getAlarmHandler()).not.toBeNull();
            await getAlarmHandler()();
            expect(ackAlarm).toHaveBeenCalledTimes(1);
        });
    });

    describe('phone → watch weather', () => {
        it('pushes a snapshot when weatherData lands', async () => {
            useWeatherStore.setState({ weatherData: makeWeather() });
            // The subscription handler is async (it lazy-imports ShipLogService).
            // Wait until it actually fires instead of racing a fixed delay — a
            // fixed setTimeout(50) flaked under parallel load when the dynamic
            // import took longer than 50ms.
            await vi.waitFor(() => expect(pushWeather).toHaveBeenCalledTimes(1));
            const snap = pushWeather.mock.calls[0][0];
            expect(snap.windKts).toBe(12);
            expect(snap.windDirDeg).toBe(90);
            expect(snap.gustKts).toBe(18);
            expect(snap.pressureHpa).toBe(1013);
            expect(snap.headingDeg).toBe(187);
            expect(snap.sogKts).toBe(5.2);
        });

        it('coalesces — does not push if wind/heading are unchanged', async () => {
            useWeatherStore.setState({ weatherData: makeWeather() });
            await vi.waitFor(() => expect(pushWeather).toHaveBeenCalledTimes(1));
            const callsAfterFirst = pushWeather.mock.calls.length;
            // Re-set with same content — different object identity, same values.
            useWeatherStore.setState({ weatherData: makeWeather() });
            await new Promise((r) => setTimeout(r, 50)); // negative assertion — allow time for a (non-)push
            expect(pushWeather.mock.calls.length).toBe(callsAfterFirst);
        });

        it('heartbeats unchanged values so durable Watch context cannot look live forever', async () => {
            useWeatherStore.setState({ weatherData: makeWeather() });
            await vi.waitFor(() => expect(pushWeather).toHaveBeenCalledTimes(1));
            const firstGeneratedAt = pushWeather.mock.calls[0][0].generatedAt;

            await _pushWeatherHeartbeatForTests();

            expect(pushWeather).toHaveBeenCalledTimes(2);
            expect(pushWeather.mock.calls[1][0].generatedAt).toBeGreaterThanOrEqual(firstGeneratedAt);
        });

        it('does push when wind speed changes', async () => {
            useWeatherStore.setState({ weatherData: makeWeather({ windSpeed: 12 }) });
            await vi.waitFor(() => expect(pushWeather).toHaveBeenCalledTimes(1));
            useWeatherStore.setState({ weatherData: makeWeather({ windSpeed: 18 }) });
            await vi.waitFor(() => expect(pushWeather).toHaveBeenCalledTimes(2));
        });

        it('skips when wind data is incomplete (would render zeros on the watch)', async () => {
            useWeatherStore.setState({
                weatherData: makeWeather({ windSpeed: null, windDegree: null }),
            });
            await new Promise((r) => setTimeout(r, 50));
            expect(pushWeather).toHaveBeenCalledTimes(0);
        });

        it('does not heartbeat a stale phone forecast into fresh-looking Watch wind', async () => {
            useWeatherStore.setState({
                weatherData: { ...makeWeather(), _stale: true },
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(pushWeather).toHaveBeenCalledTimes(0);
        });
    });
});
