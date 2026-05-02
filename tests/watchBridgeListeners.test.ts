/**
 * Tests for watchBridgeListeners — verifies the watch→TS routing
 * (mob trigger, alarm ack) and the TS→watch weather coalescing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Capacitor stub: pretend we're on iOS so the listeners actually wire up.
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'ios',
        isNativePlatform: () => true,
    },
}));

// ── watchBridge stubs that capture handler refs we can fire manually.
// vi.mock factories are hoisted, so we can't close over locals — instead
// stash handler refs on globalThis and look them up from inside the
// factory.
vi.mock('../services/native/watchBridge', () => ({
    onMobTriggered: vi.fn(async (h: () => void) => {
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
function getMobHandler(): () => void {
    return (globalThis as Record<string, unknown>).__mobHandler as () => void;
}
function getAlarmHandler(): () => void {
    return (globalThis as Record<string, unknown>).__alarmHandler as () => void;
}

import { useWeatherStore } from '../stores/weatherStore';
import { _resetForTests, initWatchBridgeListeners } from '../services/native/watchBridgeListeners';

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
        generatedAt: '2026-05-02T06:00:00Z',
        modelUsed: 'test',
    } as unknown as Parameters<typeof useWeatherStore.setState>[0]['weatherData'];
}

describe('watchBridgeListeners', () => {
    beforeEach(async () => {
        _resetForTests();
        (globalThis as Record<string, unknown>).__mobHandler = null;
        (globalThis as Record<string, unknown>).__alarmHandler = null;
        pushWeather.mockClear();
        mobActivate.mockClear();
        ackAlarm.mockClear();
        useWeatherStore.setState({ weatherData: null });
        await initWatchBridgeListeners();
    });

    afterEach(() => {
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
        it('routes mobTriggered through MobService.activate', async () => {
            expect(getMobHandler()).not.toBeNull();
            await getMobHandler()();
            expect(mobActivate).toHaveBeenCalledTimes(1);
        });

        it('survives MobService.activate throwing (does not crash the listener)', async () => {
            mobActivate.mockRejectedValueOnce(new Error('boom'));
            await expect(getMobHandler()()).resolves.not.toThrow();
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
            // The subscription handler is async (it lazy-imports
            // ShipLogService), so let microtasks settle.
            await new Promise((r) => setTimeout(r, 50));
            expect(pushWeather).toHaveBeenCalledTimes(1);
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
            await new Promise((r) => setTimeout(r, 50));
            const callsAfterFirst = pushWeather.mock.calls.length;
            // Re-set with same content — different object identity, same values.
            useWeatherStore.setState({ weatherData: makeWeather() });
            await new Promise((r) => setTimeout(r, 50));
            expect(pushWeather.mock.calls.length).toBe(callsAfterFirst);
        });

        it('does push when wind speed changes', async () => {
            useWeatherStore.setState({ weatherData: makeWeather({ windSpeed: 12 }) });
            await new Promise((r) => setTimeout(r, 50));
            useWeatherStore.setState({ weatherData: makeWeather({ windSpeed: 18 }) });
            await new Promise((r) => setTimeout(r, 50));
            expect(pushWeather).toHaveBeenCalledTimes(2);
        });

        it('skips when wind data is incomplete (would render zeros on the watch)', async () => {
            useWeatherStore.setState({
                weatherData: makeWeather({ windSpeed: null, windDegree: null }),
            });
            await new Promise((r) => setTimeout(r, 50));
            expect(pushWeather).toHaveBeenCalledTimes(0);
        });
    });
});
