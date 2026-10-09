/**
 * The GPS antenna is not at the bow (build 126, 126-07c).
 *
 * The watch marks the anchor wherever the GPS is. On a boat whose own GPS
 * antenna is on the pushpit, 12 m aft of the bow, that is 12 m from where the
 * anchor went down, and as she swings round the antenna can lie up to 12 m
 * further from the hook than her bow does. Settings → Vessel → Dimensions now
 * carries "GPS antenna to bow" (the page hands it to setAnchor as gpsToBowM),
 * and when the BOAT's GPS (the instruments, or the Pi) marks the anchor:
 *
 *  - with a true heading no more than 10 s old, the mark goes at the bow (the
 *    fix moved forward along the heading) and the circle allows the antenna's
 *    distance once;
 *  - without one, the mark stays at the antenna, the circle allows for it
 *    twice over (the antenna can end up on the far side of the hook), and the
 *    watch says so (markedAtGps).
 *
 * A phone has no fixed place aboard: its fix is unchanged. No distance, or 0,
 * is exactly today's watch. The allowance is part of the watch's own saved
 * config (antennaAllowanceM), so a restart draws the same circle whatever the
 * profile says by then, and a saved watch from before has no allowance.
 *
 * Fictional boats in real waters, worldwide: off Lyttelton (New Zealand),
 * Taveuni (Fiji) astride 180°, and Longyearbyen (Svalbard) at 78° N.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateBearing, calculateDistance, destinationPoint } from '../utils/navigationCalculations';

const watchMocks = vi.hoisted(() => ({
    keepAwake: vi.fn().mockResolvedValue(undefined),
    allowSleep: vi.fn().mockResolvedValue(undefined),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    getFreshPosition: vi.fn(),
    nativeLocationCallback: null as
        | null
        | ((position: {
              latitude: number;
              longitude: number;
              accuracy: number;
              speed: number;
              timestamp: number;
          }) => void),
    unsubscribe: vi.fn(),
    subscribeLocation: vi.fn(),
    subscribeGeofence: vi.fn(),
    removeGeofence: vi.fn().mockResolvedValue(undefined),
    addGeofence: vi.fn().mockResolvedValue(undefined),
    geofenceExists: vi.fn().mockResolvedValue(true),
    requestStart: vi.fn(),
    requestStop: vi.fn().mockResolvedValue(undefined),
    requireAlwaysLocation: vi.fn().mockResolvedValue(undefined),
    checkNotifications: vi.fn().mockResolvedValue({ display: 'granted' }),
}));

/** What the boat's own receivers say: the instrument bus, the Pi, and her compass. */
const boat = vi.hoisted(() => ({
    nmea: null as null | {
        latitude: number;
        longitude: number;
        accuracy: number;
        heading: number;
        speed: number;
        timestamp: number;
    },
    pi: null as null | { latitude: number; longitude: number; timestamp: number; rung: 'pi'; source: string },
    state: {
        headingTrue: { value: null as number | null, lastUpdated: 0, freshness: 'dead' },
        remote: null as null | { source: 'pi'; via: 'lan' | 'cloud' },
    },
}));

const recovery = vi.hoisted(() => ({ writes: [] as string[], restoreRaw: null as string | null }));

vi.mock('@capacitor-community/keep-awake', () => ({
    KeepAwake: { keepAwake: watchMocks.keepAwake, allowSleep: watchMocks.allowSleep },
}));

vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        checkPermissions: watchMocks.checkNotifications,
        requestPermissions: watchMocks.checkNotifications,
        schedule: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        ensureReady: watchMocks.ensureReady,
        getFreshPosition: watchMocks.getFreshPosition,
        requireAlwaysLocationAuthorization: watchMocks.requireAlwaysLocation,
        subscribeLocation: watchMocks.subscribeLocation,
        subscribeGeofence: watchMocks.subscribeGeofence,
        removeGeofence: watchMocks.removeGeofence,
        tryRemoveGeofence: async (id: string) => {
            await watchMocks.removeGeofence(id);
            return true;
        },
        geofenceExists: watchMocks.geofenceExists,
        addGeofence: watchMocks.addGeofence,
        requestStart: watchMocks.requestStart,
        requestStop: watchMocks.requestStop,
    },
}));

vi.mock('../services/AnchorSafetyNotificationService', () => ({
    AnchorSafetyNotificationService: {
        requireReadiness: vi.fn().mockResolvedValue({ ready: true }),
        scheduleAlarm: vi.fn().mockResolvedValue(true),
        cancelAlarm: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({ AnchorWatchSyncService: { sendAlarmPush: vi.fn() } }));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        acquire: vi.fn().mockResolvedValue('anchor-token'),
        release: vi.fn().mockResolvedValue(undefined),
        forceStop: vi.fn(),
    },
}));

vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: {
        getFeedStatus: () => (boat.nmea ? ('live' as const) : ('unavailable' as const)),
        getPosition: () => (boat.nmea ? { ...boat.nmea } : null),
        onPosition: vi.fn(() => watchMocks.unsubscribe),
    },
}));

vi.mock('../services/boatPositionChain', () => ({ piFix: vi.fn(async () => (boat.pi ? { ...boat.pi } : null)) }));

// Her compass, as the instruments (or the Pi) report it.
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => boat.state } }));

vi.mock('../services/shiplog/GpsPrecisionTracker', () => ({
    GpsPrecision: {
        getQuality: () => 'standard',
        getAdaptedThresholds: () => ({ qualityLabel: 'Standard GPS', jitterFilterWindow: 5 }),
        feed: vi.fn(),
    },
}));

vi.mock('../services/anchorWatchRecoveryStorage', () => ({
    ANCHOR_WATCH_DEVICE_RECOVERY_KEY: 'thalassa_anchor_watch_device_recovery_v1',
    readAnchorWatchRecovery: vi.fn(async () =>
        recovery.restoreRaw ? { raw: recovery.restoreRaw, deviceRecovery: false } : null,
    ),
    hasAnchorWatchRecovery: vi.fn(async () => recovery.writes.length > 0),
    writeAnchorWatchRecovery: vi.fn(async (_scope: unknown, raw: string) => {
        recovery.writes.push(raw);
    }),
    clearAnchorWatchRecovery: vi.fn(async () => {
        recovery.writes.length = 0;
    }),
}));

vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: {
        getSnapshot: () => ({ sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null }),
    },
}));
vi.mock('../services/anchorPiWatchKeeper', () => ({
    AnchorPiWatchKeeper: { keepingSessionCode: () => null, isKeeping: () => false },
}));

import {
    ANTENNA_ALLOWANCE_MAX_M,
    ANTENNA_TO_BOW_MAX_M,
    AnchorWatchService,
    calculateSwingRadius,
    validateAndNormalizeAnchorWatchConfig,
    type AnchorWatchConfig,
} from '../services/AnchorWatchService';
import { GPS_TO_BOW_MAX_M } from '../utils/gpsAntenna';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { Capacitor } from '@capacitor/core';

type LatLon = { latitude: number; longitude: number };

// A 14 m boat, her GPS antenna on the pushpit 12 m aft of the bow; 40 m of
// chain in 8 m with a 10 m margin: a 39.2 m reach, 33.3 m lying to it.
const O = 12;
const CONFIG: AnchorWatchConfig = { rodeLength: 40, waterDepth: 8, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 };
const LIE = Math.sqrt(40 ** 2 - 8 ** 2) * 0.85;
const PLAIN_RADIUS = LIE + 10;

const LYTTELTON = { latitude: -43.61, longitude: 172.72 };
// 5.3 m west of the antimeridian.
const TAVEUNI = { latitude: -16.8, longitude: 179.99995 };
const LONGYEARBYEN = { latitude: 78.23, longitude: 15.6 };

const metres = (a: LatLon, b: LatLon) => calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1852;
const toward = (from: LatLon, bearingDeg: number, distanceM: number): LatLon => {
    const p = destinationPoint(from.latitude, from.longitude, bearingDeg, distanceM / 1852);
    return { latitude: p.lat, longitude: p.lon };
};

const snap = () => AnchorWatchService.getSnapshot();
const lastPersisted = () => JSON.parse(recovery.writes[recovery.writes.length - 1] ?? 'null');
const centreAtSet = () => (AnchorWatchService as unknown as { watchCentreAtSet: LatLon | null }).watchCentreAtSet;

function nmeaFix(at: LatLon) {
    boat.nmea = { ...at, accuracy: 3, heading: 0, speed: 0, timestamp: Date.now() - 1_000 };
}
function piFixAt(at: LatLon) {
    boat.pi = { ...at, timestamp: Date.now() - 1_000, rung: 'pi', source: 'ydwg-tcp.YD' };
}
function phoneFixAt(at: LatLon) {
    watchMocks.getFreshPosition.mockResolvedValue({ ...at, accuracy: 5, speed: 0, timestamp: Date.now() - 500 });
}
function compass(deg: number | null, ageMs = 2_000, remote: (typeof boat.state)['remote'] = null) {
    boat.state.headingTrue = {
        value: deg,
        lastUpdated: deg === null ? 0 : Date.now() - ageMs,
        freshness: deg === null ? 'dead' : 'live',
    };
    boat.state.remote = remote;
}

async function setAnchor(gpsToBowM?: number) {
    const options = gpsToBowM === undefined ? { ...CONFIG } : { ...CONFIG, gpsToBowM };
    expect(await AnchorWatchService.setAnchor(options)).toBe(true);
    expect(snap().state).toBe('watching');
}

/** The app dies at anchor: the saved record survives, nothing else. */
async function restartWith(raw: string) {
    recovery.restoreRaw = raw;
    await AnchorWatchService.stopWatch();
    expect(await AnchorWatchService.restoreWatchState()).toBe(true);
}

describe('the GPS antenna aft of the bow (126-07c)', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-10-10T08:00:00Z'));
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope('skipper-nz');
        vi.clearAllMocks();
        boat.nmea = null;
        boat.pi = null;
        compass(null);
        recovery.writes.length = 0;
        recovery.restoreRaw = null;
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        watchMocks.getFreshPosition.mockResolvedValue(null);
        watchMocks.subscribeLocation.mockImplementation((callback) => {
            watchMocks.nativeLocationCallback = callback;
            return watchMocks.unsubscribe;
        });
        watchMocks.subscribeGeofence.mockImplementation(() => watchMocks.unsubscribe);
        watchMocks.geofenceExists.mockResolvedValue(true);
        watchMocks.requestStart.mockResolvedValue({
            supported: true,
            active: true,
            activeLeaseCount: 1,
            nativeTrackingEnabled: true,
        });
    });

    afterEach(async () => {
        await AnchorWatchService.stopWatch();
        setAuthIdentityScope(null);
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
        vi.useRealTimers();
    });

    describe('marked by the boat’s own GPS, with a fresh true heading', () => {
        it('heading 090 off Taveuni: the mark goes 12 m east to the bow, across 180°', async () => {
            nmeaFix(TAVEUNI);
            compass(90);

            await setAnchor(O);

            const mark = snap().anchorPosition!;
            expect(mark.longitude).toBeCloseTo(-179.99994, 5);
            expect(mark.longitude).toBeGreaterThanOrEqual(-180);
            expect(mark.latitude).toBeCloseTo(TAVEUNI.latitude, 6);
            expect(Math.abs(metres(TAVEUNI, mark) - O)).toBeLessThan(0.05);
            expect(snap().config.antennaAllowanceM).toBe(O);
            expect(snap().swingRadius).toBeCloseTo(LIE + O + 10, 6);
            expect(snap().markedAtGps).toBe(false);
            // The fence is the circle the watch reckons.
            const fence = watchMocks.addGeofence.mock.calls.at(-1)?.[0];
            expect(fence).toMatchObject({ latitude: mark.latitude, longitude: mark.longitude });
            expect(fence.radius).toBeCloseTo(LIE + O + 10, 6);
        });

        it('heading 000 off Longyearbyen, at 78° N: the mark goes 12 m north, never aft', async () => {
            nmeaFix(LONGYEARBYEN);
            compass(0);

            await setAnchor(O);

            const mark = snap().anchorPosition!;
            expect(mark.latitude).toBeGreaterThan(LONGYEARBYEN.latitude);
            expect(mark.longitude).toBeCloseTo(LONGYEARBYEN.longitude, 9);
            expect(Math.abs(metres(LONGYEARBYEN, mark) - O)).toBeLessThan(0.05);
            expect(
                calculateBearing(LONGYEARBYEN.latitude, LONGYEARBYEN.longitude, mark.latitude, mark.longitude),
            ).toBeCloseTo(0, 3);
            expect(snap().swingRadius).toBeCloseTo(LIE + O + 10, 6);
        });

        it('the Pi’s fix is the boat’s GPS too: the same mark at the bow, the same circle', async () => {
            piFixAt(LYTTELTON);
            compass(225, 3_000, { source: 'pi', via: 'lan' });

            await setAnchor(O);

            const bow = toward(LYTTELTON, 225, O);
            expect(metres(snap().anchorPosition!, bow)).toBeLessThan(0.01);
            expect(snap().config.antennaAllowanceM).toBe(O);
            expect(snap().swingRadius).toBeCloseTo(LIE + O + 10, 6);
            expect(snap().markedAtGps).toBe(false);
        });
    });

    describe('marked by the boat’s own GPS, with no fresh heading', () => {
        it.each([
            ['no heading at all', null, 0],
            ['a heading 11 s old', 30, 11_000],
        ])('%s: the mark stays at the GPS, and the circle allows for it twice over', async (_name, deg, age) => {
            nmeaFix(LYTTELTON);
            compass(deg, age);

            await setAnchor(O);

            expect(snap().anchorPosition).toMatchObject(LYTTELTON);
            expect(snap().config.antennaAllowanceM).toBe(2 * O);
            expect(snap().swingRadius).toBeCloseTo(LIE + 2 * O + 10, 6);
            expect(snap().markedAtGps).toBe(true);
        });

        it('the Pi’s fix with no heading: the same', async () => {
            piFixAt(LYTTELTON);
            await setAnchor(O);
            expect(snap().anchorPosition).toMatchObject(LYTTELTON);
            expect(snap().config.antennaAllowanceM).toBe(2 * O);
            expect(snap().markedAtGps).toBe(true);
        });
    });

    describe('exactly today’s watch', () => {
        it('a phone fix: the phone has no fixed place aboard, so no allowance and no shift', async () => {
            phoneFixAt(LYTTELTON);
            compass(90);

            await setAnchor(O);

            expect(snap().anchorPosition).toMatchObject(LYTTELTON);
            expect(snap().config).toEqual(CONFIG);
            expect(snap().swingRadius).toBeCloseTo(PLAIN_RADIUS, 9);
            expect(snap().swingRadius).toBe(calculateSwingRadius(CONFIG));
            expect(snap().markedAtGps).toBe(false);
        });

        it.each([
            ['no distance entered', undefined],
            ['0', 0],
            ['an impossible one (NaN)', Number.NaN],
            ['a negative one', -3],
            ['one longer than any yacht (61 m)', 61],
        ])('the boat’s GPS with %s: the fix, today’s circle, today’s config', async (_name, gpsToBowM) => {
            nmeaFix(TAVEUNI);
            compass(90);

            await setAnchor(gpsToBowM);

            expect(snap().anchorPosition).toMatchObject(TAVEUNI);
            expect(snap().config).toEqual(CONFIG);
            expect(snap().swingRadius).toBe(calculateSwingRadius(CONFIG));
            expect(snap().markedAtGps).toBe(false);
            expect(lastPersisted().config).toEqual(CONFIG);
        });

        it('a point chosen on the chart after an antenna watch: no allowance is carried over', async () => {
            nmeaFix(LYTTELTON);
            await setAnchor(O);
            expect(snap().config.antennaAllowanceM).toBe(2 * O);
            await AnchorWatchService.stopWatch();

            expect(await AnchorWatchService.setAnchorAt(LYTTELTON.latitude, LYTTELTON.longitude, { ...CONFIG })).toBe(
                true,
            );

            expect(snap().config).toEqual(CONFIG);
            expect(snap().swingRadius).toBe(calculateSwingRadius(CONFIG));
            expect(snap().markedAtGps).toBe(false);
        });
    });

    describe('once the watch is running', () => {
        it('a move keeps the circle (the looser one is the safe side) and the mark is no longer at the GPS', async () => {
            piFixAt(LYTTELTON);
            await setAnchor(O);
            const radius = snap().swingRadius;
            watchMocks.nativeLocationCallback?.({ ...LYTTELTON, accuracy: 4, speed: 0, timestamp: Date.now() });
            const hook = toward(LYTTELTON, 300, LIE + O);

            expect(await AnchorWatchService.relocateAnchor(hook.latitude, hook.longitude)).toEqual({ ok: true });

            expect(snap().swingRadius).toBe(radius);
            expect(snap().config.antennaAllowanceM).toBe(2 * O);
            expect(snap().markedAtGps).toBe(false);
            expect(lastPersisted()).toMatchObject({ markedAtGps: false, config: { antennaAllowanceM: 2 * O } });
        });

        it('a new margin keeps the allowance: the radius is the rode, the allowance and the new margin', async () => {
            nmeaFix(LYTTELTON);
            await setAnchor(O);

            expect(await AnchorWatchService.updateConfig({ safetyMargin: 15 })).toBe(true);

            expect(snap().config.antennaAllowanceM).toBe(2 * O);
            expect(snap().swingRadius).toBeCloseTo(LIE + 2 * O + 15, 6);
        });
    });

    describe('saved, and restored after a restart', () => {
        it('the allowance, the first centre and where it was marked are saved, and come back', async () => {
            nmeaFix(LYTTELTON);
            await setAnchor(O);
            const saved = lastPersisted();
            expect(saved.config.antennaAllowanceM).toBe(2 * O);
            expect(saved.markedAtGps).toBe(true);
            expect(saved.centreAtSet).toEqual(LYTTELTON);

            await restartWith(JSON.stringify(saved));

            expect(snap().state).toBe('watching');
            expect(snap().config.antennaAllowanceM).toBe(2 * O);
            expect(snap().swingRadius).toBeCloseTo(LIE + 2 * O + 10, 6);
            expect(snap().markedAtGps).toBe(true);
        });

        it('a watch saved by 125 (none of the new fields) restores with exactly its old circle', async () => {
            nmeaFix(LYTTELTON);
            await setAnchor();
            const record = lastPersisted();
            delete record.centreAtSet;
            delete record.markedAtGps;
            expect(record.config).toEqual(CONFIG);

            await restartWith(JSON.stringify(record));

            expect(snap().state).toBe('watching');
            expect(snap().swingRadius).toBe(calculateSwingRadius(CONFIG));
            expect(snap().config).toEqual(CONFIG);
            expect(snap().markedAtGps).toBe(false);
            expect(centreAtSet()).toEqual({ latitude: LYTTELTON.latitude, longitude: LYTTELTON.longitude });
        });

        it('a restore that cannot resume (paused, retained) keeps the first centre, not the last move', async () => {
            nmeaFix(LYTTELTON);
            await setAnchor();
            // Saved after a move from the alarm: the mark 30 m east, the first centre where it was set.
            const record = lastPersisted();
            const moved = toward(LYTTELTON, 90, 30);
            record.anchorPosition = { ...record.anchorPosition, ...moved };
            expect(record.centreAtSet).toEqual(LYTTELTON);
            // Always-location was turned off while the app was down: native preflight fails.
            watchMocks.requireAlwaysLocation.mockRejectedValueOnce(new Error('Always location is off'));

            await restartWith(JSON.stringify(record));

            expect(snap().state).toBe('paused');
            expect(snap().setupError).toMatch(/could not resume verified monitoring/);
            expect(snap().anchorPosition).toMatchObject(moved);
            expect(centreAtSet()).toEqual(LYTTELTON);
            // And the retained record the retry will read still judges from there.
            expect(lastPersisted()).toMatchObject({ anchorPosition: moved, centreAtSet: LYTTELTON });
        });

        it('a saved allowance of 500 m is corrupt: the watch is blocked, never armed on it', async () => {
            nmeaFix(LYTTELTON);
            await setAnchor(O);
            const record = lastPersisted();
            record.config.antennaAllowanceM = 500;
            watchMocks.addGeofence.mockClear();

            await restartWith(JSON.stringify(record));

            expect(snap().state).toBe('paused');
            expect(snap().setupError).toMatch(/Saved Anchor Watch is blocked/);
            expect(snap().setupError).toMatch(/antenna/i);
            expect(watchMocks.addGeofence).not.toHaveBeenCalled();
        });

        it.each([
            ['off the globe', { latitude: 95, longitude: 172.72 }],
            ['not a position', 'Lyttelton'],
            ['half a position', { latitude: -43.61 }],
        ])('a first centre that is %s falls back to the anchor, and never blocks the watch', async (_name, bad) => {
            nmeaFix(LYTTELTON);
            await setAnchor();
            const record = lastPersisted();
            record.centreAtSet = bad;

            await restartWith(JSON.stringify(record));

            expect(snap().state).toBe('watching');
            expect(snap().setupError).toBeNull();
            expect(centreAtSet()).toEqual({ latitude: LYTTELTON.latitude, longitude: LYTTELTON.longitude });
        });
    });
});

describe('the allowance at the configuration boundary', () => {
    it('bounds the watch by the Vessel settings’ own limit: 60 m, twice over 120 m', () => {
        expect(ANTENNA_TO_BOW_MAX_M).toBe(GPS_TO_BOW_MAX_M);
        expect(ANTENNA_ALLOWANCE_MAX_M).toBe(120);
    });

    it('adds to the circle: reach × 0.85 + allowance + margin', () => {
        expect(calculateSwingRadius({ ...CONFIG, antennaAllowanceM: O })).toBeCloseTo(LIE + O + 10, 9);
        expect(calculateSwingRadius(CONFIG)).toBeCloseTo(PLAIN_RADIUS, 9);
    });

    it('is optional, kept from the base on a partial update, and left out when 0', () => {
        const withAllowance = validateAndNormalizeAnchorWatchConfig({ ...CONFIG, antennaAllowanceM: 24 });
        expect(withAllowance).toEqual({ ok: true, config: { ...CONFIG, antennaAllowanceM: 24 } });
        if (!withAllowance.ok) throw new Error('unreachable');
        expect(validateAndNormalizeAnchorWatchConfig({ safetyMargin: 5 }, withAllowance.config)).toEqual({
            ok: true,
            config: { ...CONFIG, safetyMargin: 5, antennaAllowanceM: 24 },
        });
        expect(validateAndNormalizeAnchorWatchConfig(CONFIG)).toEqual({ ok: true, config: CONFIG });
        expect(validateAndNormalizeAnchorWatchConfig({ ...CONFIG, antennaAllowanceM: 0 })).toEqual({
            ok: true,
            config: CONFIG,
        });
        expect(validateAndNormalizeAnchorWatchConfig({ ...CONFIG, antennaAllowanceM: 120 })).toMatchObject({
            ok: true,
        });
    });

    it.each([120.5, 500, -1, Number.NaN, Number.POSITIVE_INFINITY, '12', null])('refuses %s', (antennaAllowanceM) => {
        expect(validateAndNormalizeAnchorWatchConfig({ ...CONFIG, antennaAllowanceM })).toEqual({
            ok: false,
            error: expect.stringMatching(/antenna/i),
        });
    });
});
