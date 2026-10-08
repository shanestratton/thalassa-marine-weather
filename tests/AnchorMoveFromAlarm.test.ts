/**
 * Move the anchor from the alarm (build 125, package 125-03).
 *
 * The watch is armed wherever the GPS is, usually the boat, a rode-length from
 * the hook. When a wind shift swings her round the real anchor and out of that
 * misplaced circle, the alarm sounds although nothing has moved, and W1-04's
 * Move anchor refused to help ("silence it first") while every silence
 * re-alarmed within three fixes. `relocateAnchorFromAlarm` moves the mark and
 * stops the alarm in one transaction, and ONLY when her swing trail backs it
 * up (services/anchorLateSet.ts):
 *
 *  - a fresh fix, the boat inside the new circle, the new point within the
 *    rode's reach of where the watch was set, the 10 minutes before the alarm
 *    seen without a break, and her whole track since the watch was set (or the
 *    app restarted) fitting a swing round the new point;
 *  - never for a GPS-lost alarm, an alarm with no fresh fix, or a watch kept
 *    by the Pi (the alarm screen offers no button then; see
 *    GlobalAnchorAlarmGate.test.tsx);
 *  - a refusal leaves the alarm sounding exactly as it was;
 *  - after an accepted move a drift watch stays on for an hour: if she keeps
 *    moving away from the new mark, the alarm sounds again, inside the circle.
 *
 * The app cannot always tell a late set from a drag. These are the cases it
 * can. Fictional anchorages worldwide: Bequia, Phang Nga Bay, Taveuni and
 * Vanua Levu (Fiji), astride and near 180°.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateDistance, destinationPoint } from '../utils/navigationCalculations';

const watchMocks = vi.hoisted(() => ({
    keepAwake: vi.fn().mockResolvedValue(undefined),
    allowSleep: vi.fn().mockResolvedValue(undefined),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    nativeLocationCallback: null as
        | null
        | ((position: {
              latitude: number;
              longitude: number;
              accuracy: number;
              speed: number;
              timestamp: number;
          }) => void),
    geofenceCallback: null as null | ((event: { identifier: string; action: string }) => void),
    unsubscribeLocation: vi.fn(),
    unsubscribeNmea: vi.fn(),
    unsubscribeGeofence: vi.fn(),
    subscribeLocation: vi.fn(),
    subscribeGeofence: vi.fn(),
    removeGeofence: vi.fn().mockResolvedValue(undefined),
    addGeofence: vi.fn().mockResolvedValue(undefined),
    geofenceExists: vi.fn().mockResolvedValue(true),
    requestStart: vi.fn(),
    requestStop: vi.fn().mockResolvedValue(undefined),
    requireAlwaysLocation: vi.fn().mockResolvedValue(undefined),
    requireNotificationReadiness: vi.fn().mockResolvedValue({ ready: true }),
    cancelSafetyNotifications: vi.fn().mockResolvedValue(true),
    scheduleSafetyNotifications: vi.fn().mockResolvedValue(true),
    checkNotifications: vi.fn().mockResolvedValue({ display: 'granted' }),
    requestNotifications: vi.fn().mockResolvedValue({ display: 'granted' }),
    acquireAlarm: vi.fn().mockResolvedValue('anchor-token'),
    releaseAlarm: vi.fn().mockResolvedValue(undefined),
}));

const recovery = vi.hoisted(() => ({ failWrite: false, writes: [] as string[], restoreRaw: null as string | null }));

const shoreAndPi = vi.hoisted(() => ({
    shore: { sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null },
}));

vi.mock('@capacitor-community/keep-awake', () => ({
    KeepAwake: { keepAwake: watchMocks.keepAwake, allowSleep: watchMocks.allowSleep },
}));

vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        checkPermissions: watchMocks.checkNotifications,
        requestPermissions: watchMocks.requestNotifications,
        schedule: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        ensureReady: watchMocks.ensureReady,
        requireAlwaysLocationAuthorization: watchMocks.requireAlwaysLocation,
        subscribeLocation: watchMocks.subscribeLocation,
        subscribeGeofence: watchMocks.subscribeGeofence,
        removeGeofence: watchMocks.removeGeofence,
        tryRemoveGeofence: async (id: string) => {
            try {
                await watchMocks.removeGeofence(id);
                return true;
            } catch {
                return false;
            }
        },
        geofenceExists: watchMocks.geofenceExists,
        addGeofence: watchMocks.addGeofence,
        requestStart: watchMocks.requestStart,
        requestStop: watchMocks.requestStop,
    },
}));

vi.mock('../services/AnchorSafetyNotificationService', () => ({
    AnchorSafetyNotificationService: {
        requireReadiness: watchMocks.requireNotificationReadiness,
        scheduleAlarm: watchMocks.scheduleSafetyNotifications,
        cancelAlarm: watchMocks.cancelSafetyNotifications,
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({ AnchorWatchSyncService: { sendAlarmPush: vi.fn() } }));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: { acquire: watchMocks.acquireAlarm, release: watchMocks.releaseAlarm, forceStop: vi.fn() },
}));

vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: {
        getFeedStatus: () => 'unavailable' as const,
        getPosition: () => null,
        onPosition: vi.fn(() => watchMocks.unsubscribeNmea),
    },
}));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: {
        getQuality: () => 'standard',
        getAdaptedThresholds: () => ({ qualityLabel: 'Standard GPS', jitterFilterWindow: 5 }),
        feed: vi.fn(),
    },
}));

vi.mock('../services/anchorWatchRecoveryStorage', () => ({
    ANCHOR_WATCH_DEVICE_RECOVERY_KEY: 'thalassa_anchor_watch_device_recovery_v1',
    // A restart: the next restore reads `restoreRaw` (a record the watch wrote earlier).
    readAnchorWatchRecovery: vi.fn(async () =>
        recovery.restoreRaw ? { raw: recovery.restoreRaw, deviceRecovery: false } : null,
    ),
    hasAnchorWatchRecovery: vi.fn(async () => recovery.writes.length > 0),
    writeAnchorWatchRecovery: vi.fn(async (_scope: unknown, raw: string) => {
        if (recovery.failWrite) throw new Error('secure recovery write failed');
        recovery.writes.push(raw);
    }),
    clearAnchorWatchRecovery: vi.fn(async () => {
        recovery.writes.length = 0;
    }),
}));

// The collision alarm reads the anchor watch through the one truth table
// (services/collisionAnchorWatch.ts). Only this phone's own watch is in play.
vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: { getSnapshot: () => shoreAndPi.shore },
}));
vi.mock('../services/anchorPiWatchKeeper', () => ({
    AnchorPiWatchKeeper: { keepingSessionCode: () => null, isKeeping: () => false },
}));

import {
    AnchorWatchService,
    calculateSwingRadius,
    haversineDistance,
    type AnchorWatchConfig,
} from '../services/AnchorWatchService';
import { AFTER_MOVE_WATCH_MS, FURTHER_AFTER_MOVE } from '../services/anchorLateSet';
import { __resetCollisionAnchorWatchForTests, readCollisionAnchorWatch } from '../services/collisionAnchorWatch';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { Capacitor } from '@capacitor/core';

type LatLon = { latitude: number; longitude: number };

const MIN = 60_000;
const STEP = 4_000;

// 40 m of chain in 8 m: a 39.2 m reach, she lies 33.3 m off, in a 43.3 m circle.
const CONFIG: AnchorWatchConfig = { rodeLength: 40, waterDepth: 8, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 };
const RADIUS = calculateSwingRadius(CONFIG);
const lieOf = (config: AnchorWatchConfig) => Math.sqrt(config.rodeLength ** 2 - config.waterDepth ** 2) * 0.85;
const LIE = lieOf(CONFIG);

// Admiralty Bay, Bequia (west of Greenwich).
const BEQUIA = { latitude: 13.005, longitude: -61.245 };
// Phang Nga Bay, Thailand.
const PHANG_NGA = { latitude: 8.276, longitude: 98.5 };
// Off Taveuni, Fiji: 21 m west of the antimeridian.
const TAVEUNI = { latitude: -16.85, longitude: 179.9998 };

const toward = (from: LatLon, bearingDeg: number, metres: number): LatLon => {
    const p = destinationPoint(from.latitude, from.longitude, bearingDeg, metres / 1852);
    return { latitude: p.lat, longitude: p.lon };
};
const metres = (a: LatLon, b: LatLon) => calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1852;

const fix = (at: LatLon, accuracy = 4) =>
    watchMocks.nativeLocationCallback?.({ ...at, accuracy, speed: 0, timestamp: Date.now() });

/** Wait until every queued safety transaction (alarms included) has run. */
const drain = () =>
    (AnchorWatchService as unknown as { runExclusive: (operation: () => Promise<void>) => Promise<void> }).runExclusive(
        async () => undefined,
    );

/**
 * A fix every 4 s for `ms`, at where(fraction of the leg). Each fix's queued
 * safety work (an alarm it raises) runs before the next, as it would aboard,
 * so the alarm is stamped when it sounded, not when the leg ends.
 */
async function sail(ms: number, where: (fraction: number) => LatLon) {
    for (let t = STEP; t <= ms; t += STEP) {
        vi.advanceTimersByTime(STEP);
        fix(where(t / ms));
        await drain();
    }
}

const lastPersisted = () => JSON.parse(recovery.writes[recovery.writes.length - 1] ?? 'null');
const lastFence = () => watchMocks.addGeofence.mock.calls[watchMocks.addGeofence.mock.calls.length - 1]?.[0];
const snap = () => AnchorWatchService.getSnapshot();
const internal = () =>
    AnchorWatchService as unknown as { outsideCircleCount: number; listeners: Set<unknown>; state: string };

async function arm(at: LatLon, config: AnchorWatchConfig = CONFIG) {
    expect(await AnchorWatchService.setAnchorAt(at.latitude, at.longitude, config)).toBe(true);
    expect(snap().state).toBe('watching');
}

/**
 * A late set: armed at the boat, the anchor `lie` upwind of her (wind from
 * 060°T). She yaws for 14 minutes, then the wind backs `shiftDeg` over 16 and
 * swings her round the anchor and out of the circle. The alarm sounds.
 */
async function lateSetAlarm(origin: LatLon, config: AnchorWatchConfig = CONFIG, shiftDeg = 120) {
    await arm(origin, config);
    const lie = lieOf(config);
    const anchor = toward(origin, 60, lie);
    await sail(14 * MIN, (f) => toward(anchor, 240 + 6 * Math.sin(f * 12), lie));
    expect(snap().state).toBe('watching');
    await sail(16 * MIN, (f) => toward(anchor, 240 + shiftDeg * f, lie));
    expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
    return { anchor, lie, heading: (240 + shiftDeg + 180) % 360 };
}

/** Nothing about the alarm or the watch changed: it is still sounding where it was. */
function expectStillSounding(origin: LatLon, fences: number) {
    expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
    expect(snap().anchorPosition).toMatchObject(origin);
    expect(watchMocks.releaseAlarm).not.toHaveBeenCalled();
    expect(watchMocks.cancelSafetyNotifications).not.toHaveBeenCalled();
    expect(watchMocks.addGeofence).toHaveBeenCalledTimes(fences);
}

describe('AnchorWatchService.relocateAnchorFromAlarm', () => {
    let hour = 0;
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-10-09T02:00:00Z') + hour++ * 3_600_000);
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope('skipper-a');
        vi.clearAllMocks();
        __resetCollisionAnchorWatchForTests();
        recovery.failWrite = false;
        recovery.writes.length = 0;
        recovery.restoreRaw = null;
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        watchMocks.subscribeLocation.mockImplementation((callback) => {
            watchMocks.nativeLocationCallback = callback;
            return watchMocks.unsubscribeLocation;
        });
        watchMocks.subscribeGeofence.mockImplementation((callback) => {
            watchMocks.geofenceCallback = callback;
            return watchMocks.unsubscribeGeofence;
        });
        watchMocks.addGeofence.mockResolvedValue(undefined);
        watchMocks.geofenceExists.mockResolvedValue(true);
        watchMocks.requestStart.mockResolvedValue({
            supported: true,
            active: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });
        watchMocks.acquireAlarm.mockResolvedValue('anchor-token');
        watchMocks.releaseAlarm.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        recovery.failWrite = false;
        watchMocks.addGeofence.mockResolvedValue(undefined);
        watchMocks.releaseAlarm.mockResolvedValue(undefined);
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope(null);
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
        vi.useRealTimers();
    });

    describe('a late set', () => {
        it('moves the mark to the real anchor and stops the alarm, in one transaction, then logs it', async () => {
            const warn = vi.spyOn(console, 'warn');
            const { anchor } = await lateSetAlarm(BEQUIA);
            const armedAt = snap().anchorPosition!.timestamp;
            const trail = snap().positionHistory.length;
            vi.clearAllMocks();

            // The sheet's live check is the move's own judgement, and only reads.
            expect(AnchorWatchService.checkMoveFromAlarm(anchor.latitude, anchor.longitude)).toMatchObject({
                ok: true,
            });
            expect(snap()).toMatchObject({ state: 'alarm', anchorPosition: BEQUIA });
            expect(watchMocks.releaseAlarm).not.toHaveBeenCalled();

            const result = await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);

            expect(result).toEqual({ ok: true });
            const after = snap();
            expect(after).toMatchObject({
                state: 'watching',
                alarmCause: null,
                alarmTriggeredAt: null,
                setupError: null,
                anchorPosition: { ...anchor, timestamp: armedAt },
            });
            expect(after.distanceFromAnchor).toBeCloseTo(LIE, 0);
            // The trail is kept across the move: it is her history, not the mark's.
            expect(after.positionHistory).toHaveLength(trail);
            expect(internal().outsideCircleCount).toBe(0);
            // The alarm's own outputs, released: its audio lease and its notifications.
            expect(watchMocks.releaseAlarm).toHaveBeenCalledWith('anchor-token');
            expect(watchMocks.cancelSafetyNotifications).toHaveBeenCalledTimes(1);
            // The fence follows, and the move is saved as a plain watch.
            expect(lastFence()).toMatchObject({ ...anchor, radius: RADIUS, identifier: 'anchor-swing-radius' });
            expect(lastPersisted()).toMatchObject({
                state: 'watching',
                alarmCause: null,
                alarmTriggeredAt: null,
                anchorPosition: { ...anchor, timestamp: armedAt },
            });
            // The anchor log: how far and which way it moved, and that the alarm stopped.
            const logged = warn.mock.calls.map((args) => args.join(' ')).join('\n');
            warn.mockRestore();
            expect(logged).toMatch(/Anchor moved from the alarm: 33 m at 060°T; alarm stopped/);
        });

        it('keeps watching afterwards: a swing round the new mark is quiet, a boat leaving it still alarms', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            expect(await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).toEqual({
                ok: true,
            });
            // The wind backs on round: she swings, the mark holds.
            await sail(10 * MIN, (f) => toward(anchor, 0 + 60 * f, LIE));
            expect(snap().state).toBe('watching');
            // The circle is the ordinary circle round the new mark.
            const out = toward(anchor, 60, RADIUS + 15);
            for (let i = 0; i < 5; i++) {
                vi.advanceTimersByTime(STEP);
                fix(out);
            }
            await drain();
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
        });

        it('across 180° off Taveuni, Fiji', async () => {
            const { anchor } = await lateSetAlarm(TAVEUNI);
            expect(anchor.longitude).toBeLessThan(-179.99);
            expect(await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).toEqual({
                ok: true,
            });
            expect(snap()).toMatchObject({ state: 'watching', anchorPosition: { ...anchor } });
            expect(snap().distanceFromAnchor).toBeCloseTo(LIE, 0);
            expect(lastFence()).toMatchObject({ longitude: anchor.longitude, radius: RADIUS });
        });

        it('the collision alarm still reads her at anchor, through the move, on the one subscription', async () => {
            const own = { lat: BEQUIA.latitude, lon: BEQUIA.longitude, source: 'nmea' as const };
            const { anchor } = await lateSetAlarm(BEQUIA);
            expect(readCollisionAnchorWatch(own)).toBe('at-anchor');
            const listeners = internal().listeners.size;
            expect(await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).toEqual({
                ok: true,
            });
            expect(readCollisionAnchorWatch(own)).toBe('at-anchor');
            expect(internal().listeners.size).toBe(listeners);
        });

        it('writes the same recovery record shape as before: no new fields, no lost ones', async () => {
            await arm(PHANG_NGA);
            const armed = lastPersisted();
            const anchor = toward(PHANG_NGA, 60, LIE);
            await sail(14 * MIN, (f) => toward(anchor, 240 + 6 * Math.sin(f * 12), LIE));
            await sail(16 * MIN, (f) => toward(anchor, 240 + 120 * f, LIE));
            expect(await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).toEqual({
                ok: true,
            });
            const moved = lastPersisted();
            expect(Object.keys(moved).sort()).toEqual(Object.keys(armed).sort());
            expect(moved.watchStartedAt).toBe(armed.watchStartedAt);
            expect(moved.config).toEqual(armed.config);
        });
    });

    describe('what it refuses, leaving the alarm sounding', () => {
        it('a slow drag smaller than the rode reach (the mark put where the anchor now is)', async () => {
            // 50 m of chain in 10 m, a 5 m margin: a 49 m reach, a 41.6 m lie, a
            // 46.6 m circle. Armed at the boat; then the anchor drags at 3 m/min
            // until she leaves the circle, 46.6 m on: less than the reach.
            const config: AnchorWatchConfig = {
                rodeLength: 50,
                waterDepth: 10,
                scopeRatio: 5,
                rodeType: 'chain',
                safetyMargin: 5,
            };
            await arm(PHANG_NGA, config);
            await sail(12 * MIN, (f) => toward(PHANG_NGA, 240, 1.5 * Math.sin(f * 9)));
            await sail(16 * MIN, (f) => toward(PHANG_NGA, 240, 48.5 * f));
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            const boat = snap().vesselPosition!;
            expect(metres(boat, PHANG_NGA)).toBeLessThan(Math.sqrt(50 ** 2 - 10 ** 2));
            const fences = watchMocks.addGeofence.mock.calls.length;
            const writes = recovery.writes.length;
            const target = toward(boat, 60, lieOf(config));

            const result = await AnchorWatchService.relocateAnchorFromAlarm(target.latitude, target.longitude);

            expect(result).toEqual({ ok: false, error: expect.stringMatching(/drag/i) });
            expectStillSounding(PHANG_NGA, fences);
            expect(recovery.writes).toHaveLength(writes);
        });

        it('a real drag: further from where the watch was set than the rode can reach', async () => {
            await arm(PHANG_NGA);
            await sail(12 * MIN, () => PHANG_NGA);
            await sail(8 * MIN, (f) => toward(PHANG_NGA, 240, 150 * f));
            expect(snap().state).toBe('alarm');
            const boat = snap().vesselPosition!;
            const fences = watchMocks.addGeofence.mock.calls.length;
            for (const target of [toward(boat, 60, LIE), boat]) {
                const result = await AnchorWatchService.relocateAnchorFromAlarm(target.latitude, target.longitude);
                expect(result).toEqual({ ok: false, error: expect.stringMatching(/re-anchor/i) });
            }
            expectStillSounding(PHANG_NGA, fences);
        });

        it('under 10 minutes of trail: too early to tell a late set from a drag', async () => {
            await arm(BEQUIA);
            const anchor = toward(BEQUIA, 60, LIE);
            await sail(3 * MIN, () => BEQUIA);
            await sail(5 * MIN, (f) => toward(anchor, 240 + 130 * f, LIE));
            expect(snap().state).toBe('alarm');
            const fences = watchMocks.addGeofence.mock.calls.length;
            const result = await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
            expect(result).toEqual({
                ok: false,
                error: expect.stringMatching(/too early to tell a late set from a drag/i),
            });
            expectStillSounding(BEQUIA, fences);
        });

        it('a fix more than 30 s old, and an alarm raised by the fence with no fix at all', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            const fences = watchMocks.addGeofence.mock.calls.length;
            vi.advanceTimersByTime(30_001);
            expect(await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).toEqual({
                ok: false,
                error: expect.stringMatching(/no recent position fix/i),
            });
            expectStillSounding(BEQUIA, fences);

            await AnchorWatchService.stopWatch();
            await arm(PHANG_NGA);
            watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
            await drain();
            // Raised by the fence alone: no fix has come in for this watch.
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            expect(snap().positionHistory).toHaveLength(0);
            const result = await AnchorWatchService.relocateAnchorFromAlarm(...latLon(toward(PHANG_NGA, 60, 20)));
            expect(result).toEqual({ ok: false, error: expect.stringMatching(/no recent position fix/i) });
            expect(snap().state).toBe('alarm');
        });

        it('a GPS-lost alarm: the watch is blind, so a move cannot be judged', async () => {
            await arm(BEQUIA);
            await sail(12 * MIN, () => BEQUIA);
            // The fixes stop; the watchdog raises the blind-watch alarm.
            await vi.advanceTimersByTimeAsync(120_000);
            await drain();
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'gps-lost' });
            const result = await AnchorWatchService.relocateAnchorFromAlarm(...latLon(toward(BEQUIA, 60, 20)));
            expect(result).toEqual({ ok: false, error: expect.stringMatching(/GPS/) });
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'gps-lost', anchorPosition: BEQUIA });
            expect(watchMocks.releaseAlarm).not.toHaveBeenCalled();
        });

        it('no alarm sounding: the watch-page Move anchor is the way, and idle has nothing to move', async () => {
            expect(await AnchorWatchService.relocateAnchorFromAlarm(...latLon(BEQUIA))).toEqual({
                ok: false,
                error: expect.stringMatching(/no anchor watch/i),
            });
            await arm(BEQUIA);
            fix(toward(BEQUIA, 0, 5));
            expect(await AnchorWatchService.relocateAnchorFromAlarm(...latLon(toward(BEQUIA, 0, 10)))).toEqual({
                ok: false,
                error: expect.stringMatching(/not sounding/i),
            });
            expect(snap()).toMatchObject({ state: 'watching', anchorPosition: BEQUIA });
        });

        it('a point that would leave the boat outside its circle', async () => {
            const { heading } = await lateSetAlarm(BEQUIA);
            const boat = snap().vesselPosition!;
            const result = await AnchorWatchService.relocateAnchorFromAlarm(
                ...latLon(toward(boat, heading, RADIUS + 5)),
            );
            expect(result).toEqual({ ok: false, error: expect.stringMatching(/outside the swing circle/i) });
            expect(snap().state).toBe('alarm');
        });

        it('the watch-page move still refuses while the alarm sounds', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            expect(await AnchorWatchService.relocateAnchor(anchor.latitude, anchor.longitude)).toEqual({
                ok: false,
                error: expect.stringMatching(/silence the alarm/i),
            });
        });

        it('a squall drags her 66 m off Vanua Levu, Fiji, and the anchor bites: the sheet’s mark is refused', async () => {
            // 40 m of chain in 8 m. Armed at the boat; she holds 14 minutes, a
            // squall drags her 66 m (twice her lie) downwind in a minute, and the
            // anchor bites again. The sheet's mark, her lie up her heading, is
            // where the anchor now is: her start and her end are the same
            // distance from it. The minute in between is not.
            const vanuaLevu = { latitude: -17.6, longitude: 177.4 };
            await arm(vanuaLevu);
            await sail(14 * MIN, () => vanuaLevu);
            await sail(1 * MIN, (f) => toward(vanuaLevu, 240, 66 * f));
            const end = toward(vanuaLevu, 240, 66);
            await sail(2 * MIN, () => end);
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            const target = toward(end, 60, LIE);
            expect(AnchorWatchService.checkMoveFromAlarm(...latLon(target))).toMatchObject({
                ok: false,
                refusal: 'moving',
            });
            const fences = watchMocks.addGeofence.mock.calls.length;

            const result = await AnchorWatchService.relocateAnchorFromAlarm(...latLon(target));

            expect(result).toEqual({ ok: false, error: expect.stringMatching(/drag/i) });
            expectStillSounding(vanuaLevu, fences);
        });

        it.each([
            [
                '50 m of chain in 10 m, a 5 m margin, at 0.5 m/min',
                { rodeLength: 50, waterDepth: 10, scopeRatio: 5, rodeType: 'chain', safetyMargin: 5 },
                0.5,
            ],
            [
                'the app’s default rode (30 m of chain in 5 m), at 0.3 m/min',
                { rodeLength: 30, waterDepth: 5, scopeRatio: 6, rodeType: 'chain', safetyMargin: 10 },
                0.3,
            ],
        ] as Array<[string, AnchorWatchConfig, number]>)(
            'a slow creep through a long night, longer than the trail on screen: %s',
            async (_name, config, perMin) => {
                // Settled an hour and a half, then the anchor creeps (soft mud,
                // weed) until she leaves the circle, and the sheet puts the mark
                // where it now is. The 500-point trail on screen holds well under
                // an hour; her track since the watch was set holds all of it.
                await arm(PHANG_NGA, config);
                await sail(90 * MIN, () => PHANG_NGA);
                const creepM = calculateSwingRadius(config) + 2;
                await sail((creepM / perMin) * MIN, (f) => toward(PHANG_NGA, 240, creepM * f));
                expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
                expect(snap().positionHistory[0].timestamp).toBeGreaterThan(Date.now() - 60 * MIN);
                const target = toward(snap().vesselPosition!, 60, lieOf(config));
                const fences = watchMocks.addGeofence.mock.calls.length;

                const result = await AnchorWatchService.relocateAnchorFromAlarm(...latLon(target));

                expect(result).toEqual({ ok: false, error: expect.stringMatching(/drag/i) });
                expectStillSounding(PHANG_NGA, fences);
            },
        );

        it('a break in her track: the app asleep two hours, then the fence wakes it 50 m away', async () => {
            // The app's default rode. Half an hour seen; then iOS suspends the
            // app (no fixes, no timers) and the fence EXIT wakes it with her
            // 50 m from where the watch was set. Twenty seconds of fixes there
            // say nothing about how she got there.
            const config: AnchorWatchConfig = {
                rodeLength: 30,
                waterDepth: 5,
                scopeRatio: 6,
                rodeType: 'chain',
                safetyMargin: 10,
            };
            await arm(PHANG_NGA, config);
            await sail(30 * MIN, () => PHANG_NGA);
            vi.setSystemTime(Date.now() + 120 * MIN);
            const away = toward(PHANG_NGA, 240, 50);
            fix(away);
            watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
            await drain();
            await sail(20_000, () => away);
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            const target = toward(away, 60, lieOf(config));
            const fences = watchMocks.addGeofence.mock.calls.length;

            const result = await AnchorWatchService.relocateAnchorFromAlarm(...latLon(target));

            expect(result).toEqual({
                ok: false,
                error: expect.stringMatching(/only 0 min of her track before the alarm/i),
            });
            expect(result).toEqual({ ok: false, error: expect.stringMatching(/fixes stopped/i) });
            expectStillSounding(PHANG_NGA, fences);
        });
    });

    describe('after the app restarts, her track starts again', () => {
        /** The app dies at anchor (iOS takes its memory): the saved record survives, nothing else. */
        async function restartAfter(minutes: number) {
            recovery.restoreRaw = recovery.writes[recovery.writes.length - 1];
            expect(recovery.restoreRaw).toBeTruthy();
            await AnchorWatchService.stopWatch();
            vi.setSystemTime(Date.now() + minutes * MIN);
            expect(await AnchorWatchService.restoreWatchState()).toBe(true);
        }

        it('an alarm soon after the restart: this phone did not see how she left the circle', async () => {
            // Set at dusk. In the night the app is killed; a squall drags her
            // 50 m while it is dead, the anchor bites, and the restarted watch
            // sounds within three fixes. Twelve quiet minutes later her track
            // since the restart fits a swing round the sheet's mark; it cannot
            // show how she got there.
            await arm(PHANG_NGA);
            await sail(20 * MIN, () => PHANG_NGA);
            await restartAfter(8 * 60);
            expect(snap().state).toBe('watching');
            const end = toward(PHANG_NGA, 240, 50);
            const restoredAt = Date.now();
            await sail(12 * MIN, () => end);
            expect(snap().alarmTriggeredAt! - restoredAt).toBeLessThan(MIN);
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            const target = toward(end, 60, LIE);

            const result = await AnchorWatchService.relocateAnchorFromAlarm(...latLon(target));

            expect(result).toEqual({
                ok: false,
                error: expect.stringMatching(/only 0 min of her track before the alarm\. .*\(the app restarted/i),
            });
            expect(snap()).toMatchObject({ state: 'alarm', anchorPosition: PHANG_NGA });
        });

        it('an alarm that was already sounding when the app restarted', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            const boat = snap().vesselPosition!;
            await restartAfter(3);
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            await sail(12 * MIN, () => boat);

            const result = await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);

            expect(result).toEqual({
                ok: false,
                error: expect.stringMatching(/only 0 min of her track before the alarm/i),
            });
            expect(snap()).toMatchObject({ state: 'alarm', anchorPosition: BEQUIA });
        });
    });

    describe('after an accepted move, a drift watch', () => {
        // A 30 m margin: a 63.3 m circle round a 33.3 m lie, so a boat can
        // drag a long way inside it. The drift watch is what speaks first.
        const WIDE: AnchorWatchConfig = { ...CONFIG, safetyMargin: 30 };
        const WIDE_RADIUS = calculateSwingRadius(WIDE);

        it('sounds the alarm again if she keeps moving away from the new mark, inside the circle', async () => {
            const { anchor, heading } = await lateSetAlarm(BEQUIA, WIDE, 170);
            expect(await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).toEqual({
                ok: true,
            });
            const away = (heading + 180) % 360;
            // The anchor was dragging after all: 3 m/min, straight downwind.
            await sail(8.5 * MIN, (f) => toward(anchor, away, LIE + 25.5 * f));
            const after = snap();
            expect(after).toMatchObject({ state: 'alarm', alarmCause: 'drag', alarmDetail: FURTHER_AFTER_MOVE });
            // A measurement, not a verdict: she may be lying longer in more wind.
            expect(FURTHER_AFTER_MOVE).toBe('She is further from the anchor than when it was moved.');
            // Before the circle would have.
            expect(
                haversineDistance(
                    after.vesselPosition!.latitude,
                    after.vesselPosition!.longitude,
                    anchor.latitude,
                    anchor.longitude,
                ),
            ).toBeLessThan(WIDE_RADIUS);
            // Silenced, it does not sound again for the same drift: the drift
            // watch was one-shot, and the circle carries on.
            await AnchorWatchService.acknowledgeAlarm();
            expect(snap()).toMatchObject({ state: 'watching', alarmDetail: null });
            await sail(1 * MIN, () => toward(anchor, away, LIE + 25.5));
            expect(snap().state).toBe('watching');
        });

        it('ends after an hour, leaving the circle: hours later a longer lie in more wind is not a drag', async () => {
            // 50 m of rope in 10 m, a 5 m margin (a 51.6 m circle). A late set in
            // light air, lying 28 m off; the mark is moved. An hour on, a front
            // lies her out to 49 m, inside the circle round the right mark.
            const ROPE: AnchorWatchConfig = {
                rodeLength: 50,
                waterDepth: 10,
                scopeRatio: 5,
                rodeType: 'rope',
                safetyMargin: 5,
            };
            await arm(BEQUIA, ROPE);
            const anchor = toward(BEQUIA, 60, 28);
            await sail(14 * MIN, (f) => toward(anchor, 240 + 6 * Math.sin(f * 12), 28));
            await sail(16 * MIN, (f) => toward(anchor, 240 + 170 * f, 28));
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            expect((await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).ok).toBe(true);
            await sail(AFTER_MOVE_WATCH_MS + MIN, () => toward(anchor, 50, 28));
            await sail(6 * MIN, (f) => toward(anchor, 50, 28 + 21 * Math.min(1, f * 3)));
            expect(snap()).toMatchObject({ state: 'watching', alarmDetail: null });
        });

        it('stays quiet while she swings round the new mark', async () => {
            const { anchor, heading } = await lateSetAlarm(BEQUIA, WIDE, 170);
            expect((await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude)).ok).toBe(true);
            const at = (heading + 180) % 360;
            await sail(12 * MIN, (f) => toward(anchor, at + 50 * Math.sin(f * 3), LIE + 2 * Math.sin(f * 7)));
            expect(snap()).toMatchObject({ state: 'watching' });
        });
    });

    describe('a tick that arrives mid-move', () => {
        const held = () => {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => (release = resolve));
            return { promise, release };
        };

        it('GPS fixes during the fence step neither count toward a drag nor lose the move', async () => {
            const { anchor, heading } = await lateSetAlarm(BEQUIA);
            const hung = held();
            watchMocks.addGeofence.mockImplementationOnce(() => hung.promise);
            try {
                const move = AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
                const boatSide = (heading + 180) % 360;
                for (let i = 0; i < 2; i++) {
                    await vi.advanceTimersByTimeAsync(STEP);
                    fix(toward(anchor, boatSide, LIE));
                }
                hung.release();
                expect(await move).toEqual({ ok: true });
            } finally {
                hung.release();
            }
            expect(snap()).toMatchObject({ state: 'watching', anchorPosition: { ...anchor } });
            expect(internal().outsideCircleCount).toBe(0);
        });

        it('a fence EXIT that arrived during the move, from the old circle, does not re-sound a boat inside the new one', async () => {
            const { anchor, heading } = await lateSetAlarm(BEQUIA);
            const hung = held();
            watchMocks.addGeofence.mockImplementationOnce(() => hung.promise);
            try {
                const move = AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
                await vi.advanceTimersByTimeAsync(STEP);
                fix(toward(anchor, (heading + 180) % 360, LIE));
                watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
                hung.release();
                expect(await move).toEqual({ ok: true });
            } finally {
                hung.release();
            }
            await drain();
            expect(snap().state).toBe('watching');

            // One that arrives AFTER the move is the new fence's, and sounds.
            watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
            await drain();
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
        });

        it('…but with no fresh fix to say she is inside, the EXIT sounds (fail safe)', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            const hung = held();
            watchMocks.addGeofence.mockImplementationOnce(() => hung.promise);
            try {
                const move = AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
                watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
                await vi.advanceTimersByTimeAsync(13_000);
                hung.release();
                expect(await move).toEqual({ ok: true });
            } finally {
                hung.release();
            }
            await drain();
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
        });

        it('Silence queued behind a move finds the alarm already stopped; a move queued behind Silence is refused', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            const move = AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
            const silence = AnchorWatchService.acknowledgeAlarm();
            expect(await move).toEqual({ ok: true });
            await silence;
            expect(snap()).toMatchObject({ state: 'watching', anchorPosition: { ...anchor } });
            expect(watchMocks.releaseAlarm).toHaveBeenCalledTimes(1);

            await AnchorWatchService.stopWatch();
            const second = await lateSetAlarm(PHANG_NGA);
            const silenceFirst = AnchorWatchService.acknowledgeAlarm();
            const late = AnchorWatchService.relocateAnchorFromAlarm(second.anchor.latitude, second.anchor.longitude);
            await silenceFirst;
            expect(await late).toEqual({ ok: false, error: expect.stringMatching(/not sounding/i) });
            expect(snap()).toMatchObject({ state: 'watching', anchorPosition: PHANG_NGA });
        });
    });

    describe('when a step fails, the alarm stays loud and the old mark stays put', () => {
        it('a fence the plugin refuses', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            watchMocks.addGeofence.mockRejectedValueOnce(new Error('plugin refused the new fence'));
            const result = await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
            expect(result).toEqual({ ok: false, error: expect.stringContaining('plugin refused the new fence') });
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag', anchorPosition: BEQUIA });
            expect(watchMocks.releaseAlarm).not.toHaveBeenCalled();
            expect(lastFence()).toMatchObject({ ...BEQUIA, radius: RADIUS });
        });

        it('an audio lease that will not let go: the fence goes back and the warnings are put back', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            watchMocks.releaseAlarm.mockRejectedValueOnce(
                new Error('iOS did not confirm that alarm playback stopped.'),
            );
            watchMocks.scheduleSafetyNotifications.mockClear();
            const result = await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
            expect(result).toEqual({ ok: false, error: expect.stringMatching(/did not confirm/i) });
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag', anchorPosition: BEQUIA });
            expect(lastFence()).toMatchObject({ ...BEQUIA, radius: RADIUS });
            // The locked-screen notifications that were cancelled alongside are rescheduled.
            expect(watchMocks.scheduleSafetyNotifications).toHaveBeenCalled();
        });

        it('a save that fails: the alarm is restarted, the fence goes back', async () => {
            const { anchor } = await lateSetAlarm(BEQUIA);
            watchMocks.acquireAlarm.mockClear();
            recovery.failWrite = true;
            const result = await AnchorWatchService.relocateAnchorFromAlarm(anchor.latitude, anchor.longitude);
            expect(result).toEqual({ ok: false, error: expect.stringContaining('secure recovery write failed') });
            expect(snap()).toMatchObject({ state: 'alarm', alarmCause: 'drag', anchorPosition: BEQUIA });
            expect(watchMocks.acquireAlarm).toHaveBeenCalledTimes(1);
            expect(lastFence()).toMatchObject({ ...BEQUIA, radius: RADIUS });
        });
    });

    it('the jitter filter keeps a boat astride 180° where she is, not averaged to 0° longitude', async () => {
        // 2 m west of 180°, her fixes 6 m round it, either side of the line.
        const anchor = toward(TAVEUNI, 90, 19);
        await arm(anchor);
        // Fixes either side of the antimeridian, a few metres apart.
        await sail(2 * MIN, (f) => toward(anchor, (f * 720) % 360, 6));
        expect(snap().state).toBe('watching');
        expect(snap().distanceFromAnchor).toBeLessThan(10);
        expect(Math.abs(snap().vesselPosition!.longitude)).toBeGreaterThan(179.99);
    });
});

function latLon(point: LatLon): [number, number] {
    return [point.latitude, point.longitude];
}
