/**
 * Moving the anchor after it is down (build 123, must-do #3).
 *
 * The anchor position is taken from wherever the GPS is when the watch is
 * armed, which is usually the BOAT, a full rode away from the anchor. The
 * service has always had `setAnchorAt`, but nothing called it and it refuses a
 * running watch anyway, so the only fix was to weigh anchor and re-arm.
 *
 * `relocateAnchor` moves the centre of a running watch on THIS phone. It is a
 * safety mutation, so it is held to the same rules as a radius change:
 *
 *   - one transaction at a time (runExclusive);
 *   - watching or paused only — never while idle, arming, or sounding an alarm;
 *   - never to a point that puts the boat's latest fix outside the swing circle
 *     (it would alarm at once, and it is what catches a typo of 500 for 50);
 *   - the native fence moves with it, and a failed move puts the old fence back;
 *     if even that fails, monitoring is honestly blocked (paused);
 *   - the recovery record keeps its schema, and the hook keeps its timestamp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationPoint } from '../utils/navigationCalculations';

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

const recovery = vi.hoisted(() => ({
    failWrite: false,
    /** The next write never answers until released (a Keychain that hangs). */
    hangNextWrite: false,
    pending: [] as Array<() => void>,
    writes: [] as string[],
}));

// A boat GPS on the instrument bus (or the Pi), for a watch kept without a
// native fence: the web build on a live NMEA feed.
const nmeaFeed = vi.hoisted(() => ({
    position: null as null | {
        latitude: number;
        longitude: number;
        accuracy: number;
        speed: number;
        heading: number;
        timestamp: number;
    },
    callback: null as null | ((position: Record<string, number>) => void),
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
        getFeedStatus: () => (nmeaFeed.position ? ('live' as const) : ('unavailable' as const)),
        getPosition: () => nmeaFeed.position,
        onPosition: vi.fn((callback: (position: Record<string, number>) => void) => {
            nmeaFeed.callback = callback;
            return watchMocks.unsubscribeNmea;
        }),
    },
}));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: {
        getQuality: () => 'standard',
        getAdaptedThresholds: () => ({ qualityLabel: 'Standard GPS', jitterFilterWindow: 5 }),
        feed: vi.fn(),
    },
}));

// The recovery store is a pair of strings here: the shape of what is written
// is what this suite cares about, not the Keychain adapter (its own suite).
vi.mock('../services/anchorWatchRecoveryStorage', () => ({
    ANCHOR_WATCH_DEVICE_RECOVERY_KEY: 'thalassa_anchor_watch_device_recovery_v1',
    readAnchorWatchRecovery: vi.fn(async () => null),
    hasAnchorWatchRecovery: vi.fn(async () => recovery.writes.length > 0),
    writeAnchorWatchRecovery: vi.fn(async (_scope: unknown, raw: string) => {
        if (recovery.hangNextWrite) {
            recovery.hangNextWrite = false;
            await new Promise<void>((release) => recovery.pending.push(release));
        }
        if (recovery.failWrite) throw new Error('secure recovery write failed');
        recovery.writes.push(raw);
    }),
    clearAnchorWatchRecovery: vi.fn(async () => {
        recovery.writes.length = 0;
    }),
}));

import { AnchorWatchService, calculateSwingRadius, haversineDistance } from '../services/AnchorWatchService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { Capacitor } from '@capacitor/core';

// A rode of 30 m in 5 m of chain-laid water: a 35.1 m circle.
const CONFIG = { rodeLength: 30, waterDepth: 5, scopeRatio: 6, rodeType: 'chain' as const, safetyMargin: 10 };
const RADIUS = calculateSwingRadius(CONFIG);

// Fictional anchorage off the Calanques, Marseille.
const ANCHOR = { latitude: 43.2105, longitude: 5.515 };

const toward = (from: { latitude: number; longitude: number }, bearingDeg: number, metres: number) => {
    const p = destinationPoint(from.latitude, from.longitude, bearingDeg, metres / 1852);
    return { latitude: p.lat, longitude: p.lon };
};

const fix = (at: { latitude: number; longitude: number }) =>
    watchMocks.nativeLocationCallback?.({ ...at, accuracy: 4, speed: 0, timestamp: Date.now() });

/** Wait until every queued safety transaction (alarms included) has run. */
const drain = () =>
    (AnchorWatchService as unknown as { runExclusive: (operation: () => Promise<void>) => Promise<void> }).runExclusive(
        async () => undefined,
    );

const lastPersisted = () => JSON.parse(recovery.writes[recovery.writes.length - 1] ?? 'null');
const lastFence = () => watchMocks.addGeofence.mock.calls[watchMocks.addGeofence.mock.calls.length - 1]?.[0];

async function arm() {
    expect(await AnchorWatchService.setAnchorAt(ANCHOR.latitude, ANCHOR.longitude, CONFIG)).toBe(true);
    expect(AnchorWatchService.getSnapshot().state).toBe('watching');
}

describe('AnchorWatchService.relocateAnchor', () => {
    let hour = 0;
    beforeEach(async () => {
        vi.useFakeTimers();
        // An hour apart per test: the service is a singleton, and the last
        // vessel fix of one test must never pass as a fresh fix in the next.
        vi.setSystemTime(Date.parse('2026-10-07T21:00:00Z') + hour++ * 3_600_000);
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope('skipper-a');
        vi.clearAllMocks();
        recovery.failWrite = false;
        recovery.hangNextWrite = false;
        recovery.pending.length = 0;
        recovery.writes.length = 0;
        nmeaFeed.position = null;
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
        watchMocks.removeGeofence.mockResolvedValue(undefined);
        watchMocks.addGeofence.mockResolvedValue(undefined);
        watchMocks.geofenceExists.mockResolvedValue(true);
        watchMocks.requestStart.mockResolvedValue({
            supported: true,
            active: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });
        watchMocks.requestStop.mockResolvedValue(undefined);
        watchMocks.requireAlwaysLocation.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        recovery.failWrite = false;
        watchMocks.addGeofence.mockResolvedValue(undefined);
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope(null);
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
        vi.useRealTimers();
    });

    describe('the state matrix', () => {
        it('refuses while idle, with nothing native touched and nothing saved', async () => {
            const result = await AnchorWatchService.relocateAnchor(ANCHOR.latitude, ANCHOR.longitude);
            expect(result).toEqual({ ok: false, error: expect.stringMatching(/no anchor watch/i) });
            expect(watchMocks.addGeofence).not.toHaveBeenCalled();
            expect(recovery.writes).toHaveLength(0);
            expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'idle', anchorPosition: null });
        });

        it('waits for an arm in progress instead of running beside it', async () => {
            let releasePermission!: () => void;
            const permission = new Promise<void>((resolve) => (releasePermission = resolve));
            watchMocks.requireAlwaysLocation.mockImplementationOnce(() => permission);
            const arming = AnchorWatchService.setAnchorAt(ANCHOR.latitude, ANCHOR.longitude, CONFIG);
            let settled = false;
            let move: ReturnType<typeof AnchorWatchService.relocateAnchor>;
            try {
                move = AnchorWatchService.relocateAnchor(ANCHOR.latitude, ANCHOR.longitude).then((result) => {
                    settled = true;
                    return result;
                });
                await vi.advanceTimersByTimeAsync(0);
                expect(AnchorWatchService.getSnapshot().state).toBe('setting');
                expect(settled).toBe(false);
            } finally {
                // Never strand the arm: every later transaction queues behind it.
                releasePermission();
            }
            expect(await arming).toBe(true);
            // It ran AFTER the arm: the watch is up, so the refusal is about
            // the fix it has not had yet, not about the arm.
            expect(await move).toEqual({ ok: false, error: expect.stringMatching(/position fix/i) });
        });

        it('refuses a watch that is still arming (defence in depth: the queue normally hides this state)', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const internal = AnchorWatchService as unknown as { state: string };
            internal.state = 'setting';
            try {
                const result = await AnchorWatchService.relocateAnchor(ANCHOR.latitude, ANCHOR.longitude);
                expect(result).toEqual({ ok: false, error: expect.stringMatching(/still starting/i) });
            } finally {
                internal.state = 'watching';
            }
        });

        it('refuses while the alarm sounds: silence it first', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
            await drain();
            expect(AnchorWatchService.getSnapshot().state).toBe('alarm');
            const fences = watchMocks.addGeofence.mock.calls.length;

            const result = await AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 10)));

            expect(result).toEqual({ ok: false, error: expect.stringMatching(/silence the alarm/i) });
            expect(watchMocks.addGeofence).toHaveBeenCalledTimes(fences);
            expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'alarm', anchorPosition: ANCHOR });
        });

        it('moves a watching anchor: new centre, same radius, fence moved, saved, history kept', async () => {
            await arm();
            const armedAt = AnchorWatchService.getSnapshot().anchorPosition!.timestamp;
            // The boat lies 30 m north of where the watch was armed…
            fix(toward(ANCHOR, 0, 30));
            const historyBefore = AnchorWatchService.getSnapshot().positionHistory;
            expect(historyBefore.length).toBeGreaterThan(0);
            // …and the anchor is really 25 m north-east of the boat.
            const boat = AnchorWatchService.getSnapshot().vesselPosition!;
            const moved = toward(boat, 45, 25);

            const result = await AnchorWatchService.relocateAnchor(moved.latitude, moved.longitude);

            expect(result).toEqual({ ok: true });
            const snap = AnchorWatchService.getSnapshot();
            expect(snap.state).toBe('watching');
            expect(snap.anchorPosition).toEqual({ ...moved, timestamp: armedAt });
            expect(snap.swingRadius).toBeCloseTo(RADIUS, 9);
            expect(snap.distanceFromAnchor).toBeCloseTo(25, 1);
            // Bearing from the boat to the new anchor.
            expect(snap.bearingToAnchor).toBeCloseTo(45, 0);
            // The worst swing is re-measured from the new centre: the one fix
            // so far is 25 m from it, not the 30 m it was from the old one.
            expect(snap.maxDistanceRecorded).toBeCloseTo(25, 1);
            expect(snap.positionHistory).toEqual(historyBefore);
            expect(lastFence()).toMatchObject({
                identifier: 'anchor-swing-radius',
                latitude: moved.latitude,
                longitude: moved.longitude,
                radius: RADIUS,
            });
            expect(lastPersisted()).toMatchObject({
                state: 'watching',
                anchorPosition: { ...moved, timestamp: armedAt },
            });
        });

        it('moves a paused anchor without touching the native fence, and stays paused', async () => {
            await arm();
            // A radius change whose fence AND rollback both fail leaves the watch
            // paused with GPS still running — a paused watch that still has fixes.
            watchMocks.addGeofence
                .mockRejectedValueOnce(new Error('new fence refused'))
                .mockRejectedValueOnce(new Error('old fence refused'));
            expect(await AnchorWatchService.updateConfig({ safetyMargin: 12 })).toBe(false);
            const blocked = AnchorWatchService.getSnapshot();
            expect(blocked.state).toBe('paused');
            fix(toward(ANCHOR, 180, 15));
            const fences = watchMocks.addGeofence.mock.calls.length;
            const moved = toward(AnchorWatchService.getSnapshot().vesselPosition!, 180, 20);

            const result = await AnchorWatchService.relocateAnchor(moved.latitude, moved.longitude);

            expect(result).toEqual({ ok: true });
            expect(watchMocks.addGeofence).toHaveBeenCalledTimes(fences);
            const snap = AnchorWatchService.getSnapshot();
            expect(snap).toMatchObject({ state: 'paused', anchorPosition: { ...moved } });
            // The reason monitoring is blocked is still the one on screen.
            expect(snap.setupError).toBe(blocked.setupError);
            expect(lastPersisted()).toMatchObject({ state: 'paused', anchorPosition: { ...moved } });
        });
    });

    describe('the guard', () => {
        it.each([
            ['just outside the circle', RADIUS + 1],
            ['a typo: 500 for 50', 500],
        ])('refuses a point that leaves the boat outside the circle (%s)', async (_label, metres) => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const before = AnchorWatchService.getSnapshot();
            const fences = watchMocks.addGeofence.mock.calls.length;
            const writes = recovery.writes.length;

            const result = await AnchorWatchService.relocateAnchor(
                ...latLon(toward(before.vesselPosition!, 270, metres)),
            );

            // In words for any way the point was given (distance and bearing,
            // a typed position or a drag): the Position tab has no bearing field.
            expect(result).toEqual({
                ok: false,
                error: expect.stringMatching(/outside the swing circle.*Check where you put the anchor\.$/i),
            });
            expect(AnchorWatchService.getSnapshot()).toMatchObject({
                state: 'watching',
                anchorPosition: before.anchorPosition,
                maxDistanceRecorded: before.maxDistanceRecorded,
            });
            expect(watchMocks.addGeofence).toHaveBeenCalledTimes(fences);
            expect(recovery.writes).toHaveLength(writes);
        });

        it('accepts a point right on the edge of the circle', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const boat = AnchorWatchService.getSnapshot().vesselPosition!;
            const edge = toward(boat, 270, RADIUS - 0.01);
            expect(haversineDistance(boat.latitude, boat.longitude, edge.latitude, edge.longitude)).toBeLessThan(
                RADIUS,
            );
            expect(await AnchorWatchService.relocateAnchor(edge.latitude, edge.longitude)).toEqual({ ok: true });
        });

        it('refuses with no fix yet, and with a fix older than 30 s', async () => {
            await arm();
            expect(await AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 5)))).toEqual({
                ok: false,
                error: expect.stringMatching(/position fix/i),
            });

            fix(toward(ANCHOR, 0, 10));
            vi.advanceTimersByTime(30_001);
            expect(await AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 5)))).toEqual({
                ok: false,
                error: expect.stringMatching(/position fix/i),
            });
            expect(AnchorWatchService.getSnapshot().anchorPosition).toMatchObject(ANCHOR);
        });

        it.each([
            ['NaN latitude', Number.NaN, 5.5],
            ['latitude past the pole', 90.0001, 5.5],
            ['longitude past 180', 43.2, 180.0001],
            ['infinite longitude', 43.2, Number.POSITIVE_INFINITY],
        ])('refuses an impossible position (%s)', async (_label, lat, lon) => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            expect(await AnchorWatchService.relocateAnchor(lat, lon)).toEqual({
                ok: false,
                error: expect.stringMatching(/not a real position\. Check where you put the anchor\.$/i),
            });
            expect(AnchorWatchService.getSnapshot().anchorPosition).toMatchObject(ANCHOR);
        });

        it('starts drag counting afresh: outside fixes before the move do not count after it', async () => {
            await arm();
            // Two fixes outside the OLD circle: one short of the alarm.
            const q = toward(ANCHOR, 0, RADIUS + 5);
            fix(q);
            fix(q);
            expect(AnchorWatchService.getSnapshot().state).toBe('watching');

            const moved = toward(q, 0, 20);
            expect(await AnchorWatchService.relocateAnchor(moved.latitude, moved.longitude)).toEqual({ ok: true });

            // Outside the NEW circle: the count starts from zero, so it takes
            // the full three confirmations, not one.
            const r = toward(moved, 0, RADIUS + 5);
            fix(r);
            fix(r);
            await drain();
            expect(AnchorWatchService.getSnapshot().state).toBe('watching');
            fix(r);
            await drain();
            expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
        });
    });

    describe('rollback', () => {
        it('a fence the plugin refuses leaves the old anchor and its fence in place', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const before = AnchorWatchService.getSnapshot();
            watchMocks.addGeofence.mockRejectedValueOnce(new Error('plugin refused the new fence'));

            const result = await AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 20)));

            expect(result).toEqual({ ok: false, error: expect.stringContaining('plugin refused the new fence') });
            expect(result.ok === false && result.error).toMatch(/not moved/i);
            expect(AnchorWatchService.getSnapshot()).toMatchObject({
                state: 'watching',
                anchorPosition: before.anchorPosition,
                distanceFromAnchor: before.distanceFromAnchor,
                setupError: null,
            });
            expect(lastFence()).toMatchObject({ ...ANCHOR, radius: RADIUS });
            expect(lastPersisted().anchorPosition).toMatchObject(ANCHOR);
        });

        it('a save that fails puts the fence back on the old anchor', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            recovery.failWrite = true;

            const moved = toward(ANCHOR, 0, 20);
            const result = await AnchorWatchService.relocateAnchor(moved.latitude, moved.longitude);

            expect(result).toEqual({ ok: false, error: expect.stringContaining('secure recovery write failed') });
            const centres = watchMocks.addGeofence.mock.calls.slice(-2).map(([fence]) => fence.latitude);
            expect(centres).toEqual([moved.latitude, ANCHOR.latitude]);
            expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'watching', anchorPosition: ANCHOR });
            recovery.failWrite = false;
            expect(lastPersisted().anchorPosition).toMatchObject(ANCHOR);
        });

        it('when the old fence cannot be restored either, monitoring is blocked and says so', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            watchMocks.addGeofence
                .mockRejectedValueOnce(new Error('new fence refused'))
                .mockRejectedValueOnce(new Error('old fence refused'));

            const result = await AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 20)));

            expect(result.ok).toBe(false);
            const snap = AnchorWatchService.getSnapshot();
            expect(snap).toMatchObject({ state: 'paused', anchorPosition: ANCHOR });
            expect(snap.setupError).toMatch(/could not be restored/i);
            expect(snap.setupError).toMatch(/blocked/i);
            expect(lastPersisted()).toMatchObject({ state: 'paused', anchorPosition: ANCHOR });
        });
    });

    describe('serialisation', () => {
        it('a move queued behind Weigh Anchor finds no watch to move', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const stop = AnchorWatchService.stopWatch();
            const move = AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 20)));
            await stop;
            expect(await move).toEqual({ ok: false, error: expect.stringMatching(/no anchor watch/i) });
            expect(recovery.writes).toHaveLength(0);
        });

        it('Weigh Anchor queued behind a move waits for it, then clears everything', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const moved = toward(ANCHOR, 0, 20);
            const move = AnchorWatchService.relocateAnchor(moved.latitude, moved.longitude);
            const stop = AnchorWatchService.stopWatch();
            expect(await move).toEqual({ ok: true });
            await stop;
            const fenceAt = watchMocks.addGeofence.mock.invocationCallOrder.at(-1)!;
            expect(fenceAt).toBeLessThan(watchMocks.requestStop.mock.invocationCallOrder.at(-1)!);
            expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'idle', anchorPosition: null });
            expect(recovery.writes).toHaveLength(0);
        });

        it('a move queued behind a drag alarm is refused', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
            const result = await AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 20)));
            expect(result).toEqual({ ok: false, error: expect.stringMatching(/silence the alarm/i) });
            expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'alarm', anchorPosition: ANCHOR });
        });
    });

    // The geofence engine has hung in the field (2026-08-08, "deleted 0 of 1
    // geofences"), which is why every arming step runs under a deadline. A
    // move runs on the same queue as the drag, GPS-lost and geofence-EXIT
    // alarms, so a fence step or a save that never answers must not hold
    // them, or the watch, behind it.
    describe('a native step that never answers', () => {
        /** A promise that never settles until `release` is called. */
        const held = () => {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => (release = resolve));
            return { promise, release };
        };
        const STEP_MS = 15_000;

        it('a fence move that hangs gives up in time: old fence back, still watching, and an alarm behind it fires', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const hung = held();
            watchMocks.addGeofence.mockImplementationOnce(() => hung.promise);
            try {
                let settled = false;
                const move = AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 20))).then((result) => {
                    settled = true;
                    return result;
                });
                // The boat drags meanwhile, and iOS reports the fence EXIT.
                watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });

                await vi.advanceTimersByTimeAsync(STEP_MS + 1);
                expect(settled).toBe(true);
                const result = await move;
                expect(result).toEqual({ ok: false, error: expect.stringMatching(/did not respond within 15s/i) });
                expect(result.ok === false && result.error).toMatch(/not moved/i);
                // The rollback put the verified old fence back.
                expect(lastFence()).toMatchObject({ ...ANCHOR, radius: RADIUS });

                await drain();
                expect(AnchorWatchService.getSnapshot()).toMatchObject({
                    state: 'alarm',
                    alarmCause: 'drag',
                    anchorPosition: ANCHOR,
                });
            } finally {
                hung.release();
            }
        });

        it('when the old fence cannot be put back in time either, monitoring is blocked, and a late answer claims nothing', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const forward = held();
            const back = held();
            watchMocks.addGeofence
                .mockImplementationOnce(() => forward.promise)
                .mockImplementationOnce(() => back.promise);
            const internal = AnchorWatchService as unknown as { anchorGeofenceOwned: boolean };
            try {
                let settled = false;
                const move = AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 0, 20))).then((result) => {
                    settled = true;
                    return result;
                });
                await vi.advanceTimersByTimeAsync(2 * STEP_MS + 2);
                expect(settled).toBe(true);
                expect((await move).ok).toBe(false);
                const snap = AnchorWatchService.getSnapshot();
                expect(snap).toMatchObject({ state: 'paused', anchorPosition: ANCHOR });
                expect(snap.setupError).toMatch(/could not be restored/i);
                expect(snap.setupError).toMatch(/did not respond/i);
                expect(lastPersisted()).toMatchObject({ state: 'paused', anchorPosition: ANCHOR });

                // The engine wakes up and answers both, late. Neither may now
                // claim a fence the watch has already said it cannot vouch for.
                forward.release();
                back.release();
                await vi.advanceTimersByTimeAsync(0);
                await drain();
                expect(internal.anchorGeofenceOwned).toBe(false);
                expect(AnchorWatchService.getSnapshot().state).toBe('paused');
            } finally {
                forward.release();
                back.release();
            }
        });

        it('a save that hangs gives up in time and the old fence goes back', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            recovery.hangNextWrite = true;
            try {
                let settled = false;
                const moved = toward(ANCHOR, 0, 20);
                const move = AnchorWatchService.relocateAnchor(moved.latitude, moved.longitude).then((result) => {
                    settled = true;
                    return result;
                });
                await vi.advanceTimersByTimeAsync(STEP_MS + 1);
                expect(settled).toBe(true);
                expect(await move).toEqual({
                    ok: false,
                    error: expect.stringMatching(/did not respond within 15s/i),
                });
                const centres = watchMocks.addGeofence.mock.calls.slice(-2).map(([fence]) => fence.latitude);
                expect(centres).toEqual([moved.latitude, ANCHOR.latitude]);
                expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'watching', anchorPosition: ANCHOR });
                expect(lastPersisted().anchorPosition).toMatchObject(ANCHOR);
            } finally {
                recovery.pending.forEach((release) => release());
            }
        });

        it('a radius change is bounded the same way, so an alarm behind it is not held', async () => {
            await arm();
            fix(toward(ANCHOR, 0, 10));
            const hung = held();
            watchMocks.addGeofence.mockImplementationOnce(() => hung.promise);
            try {
                let settled = false;
                const change = AnchorWatchService.updateConfig({ safetyMargin: 12 }).then((result) => {
                    settled = true;
                    return result;
                });
                watchMocks.geofenceCallback?.({ identifier: 'anchor-swing-radius', action: 'EXIT' });
                await vi.advanceTimersByTimeAsync(STEP_MS + 1);
                expect(settled).toBe(true);
                expect(await change).toBe(false);
                expect(lastFence()).toMatchObject({ ...ANCHOR, radius: RADIUS });
                await drain();
                expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'alarm', alarmCause: 'drag' });
            } finally {
                hung.release();
            }
        });
    });

    // The web build keeps a watch on a live NMEA or Pi feed with no native
    // fence at all (startGpsMonitoring installs one only on a device), and the
    // web geofence engine registers nothing. A move must not ask it for one.
    describe('a watch with no native fence (the web, on a live NMEA feed)', () => {
        const nmeaFix = (at: { latitude: number; longitude: number }) =>
            nmeaFeed.callback?.({ ...at, accuracy: 3, speed: 0, heading: 0, timestamp: Date.now() });

        beforeEach(() => {
            vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
            vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
            // BgGeoManager off a device: adds are no-ops and nothing ever exists.
            watchMocks.geofenceExists.mockResolvedValue(false);
            nmeaFeed.position = { ...ANCHOR, accuracy: 3, speed: 0, heading: 0, timestamp: Date.now() };
        });

        afterEach(() => {
            nmeaFeed.position = null;
            watchMocks.geofenceExists.mockResolvedValue(true);
        });

        it('moves the anchor and keeps watching, with no fence asked for', async () => {
            await arm();
            nmeaFix(toward(ANCHOR, 0, 10));
            expect(AnchorWatchService.getSnapshot().vesselPosition).toMatchObject(toward(ANCHOR, 0, 10));
            const moved = toward(ANCHOR, 0, 30);

            expect(await AnchorWatchService.relocateAnchor(moved.latitude, moved.longitude)).toEqual({ ok: true });

            expect(watchMocks.addGeofence).not.toHaveBeenCalled();
            expect(AnchorWatchService.getSnapshot()).toMatchObject({
                state: 'watching',
                anchorPosition: { ...moved },
                setupError: null,
            });
            expect(lastPersisted()).toMatchObject({ state: 'watching', anchorPosition: { ...moved } });
        });

        it('a radius change keeps watching too', async () => {
            await arm();
            nmeaFix(toward(ANCHOR, 0, 10));
            expect(await AnchorWatchService.updateConfig({ safetyMargin: 12 })).toBe(true);
            expect(watchMocks.addGeofence).not.toHaveBeenCalled();
            expect(AnchorWatchService.getSnapshot()).toMatchObject({ state: 'watching', setupError: null });
        });
    });

    it('writes the same recovery record shape as before: no new fields, no lost ones', async () => {
        await arm();
        const armed = lastPersisted();
        fix(toward(ANCHOR, 90, 10));
        expect(await AnchorWatchService.relocateAnchor(...latLon(toward(ANCHOR, 90, 25)))).toEqual({ ok: true });
        const moved = lastPersisted();
        expect(Object.keys(moved).sort()).toEqual(Object.keys(armed).sort());
        expect(Object.keys(moved.anchorPosition).sort()).toEqual(['latitude', 'longitude', 'timestamp']);
        expect(moved.anchorPosition.timestamp).toBe(armed.anchorPosition.timestamp);
        expect(moved.watchStartedAt).toBe(armed.watchStartedAt);
        expect(moved.config).toEqual(armed.config);
    });
});

function latLon(point: { latitude: number; longitude: number }): [number, number] {
    return [point.latitude, point.longitude];
}
