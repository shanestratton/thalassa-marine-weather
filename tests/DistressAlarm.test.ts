/**
 * The distress alarm (build 125, package 125-02): an AIS-SART, AIS man
 * overboard or EPIRB-AIS beacon that the boat's own radio hears going active
 * sounds at any range, through the shared safety path.
 *
 *  - Real !AIVDM sentences through the decoder and the store, then the watch's
 *    collect step and the alarm service: the plan's fixtures (status 15 before
 *    message 14, message 14 only, message 1 with status 14, internet-only 970).
 *  - Sound under its own 'distress-watch' lease, so the anchor alarm keeps
 *    priority and the collision alarm never fights it; the lock-screen alert
 *    through the shared safety path with the DISTRESS kind and its own ids.
 *  - Silence stops the sound and keeps the card; a new MMSI or a test-to-active
 *    change sounds again. There is no per-target mute.
 *  - A beacon is graded by this rule, never by the collision rule: steering to
 *    a SART must not sound close quarters on it.
 *
 * Fictional MMSIs only (970/972/974 with manufacturer 00; MID 123). Positions
 * worldwide: Aberdeen, off Cape Town, Fiji across the antimeridian.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    audio: {
        startAlarm: vi.fn().mockResolvedValue({ playing: true }),
        stopAlarm: vi.fn().mockResolvedValue({ stopped: true }),
        isAlarmPlaying: vi.fn().mockResolvedValue({ playing: true }),
    },
    notify: {
        checkReadiness: vi.fn(),
        scheduleAlarm: vi.fn(),
        cancelAlarm: vi.fn(),
        scheduleSafetyAlert: vi.fn().mockResolvedValue({ scheduled: 3, interruptionLevel: 'timeSensitive' }),
        cancelSafetyAlert: vi.fn().mockResolvedValue({ cancelled: true }),
    },
}));

vi.mock('@capacitor/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@capacitor/core')>()),
    // The alarm's native paths: iOS, with the two plugins this file watches.
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => false },
    registerPlugin: (name: string) => (name === 'AlarmAudio' ? mocks.audio : mocks.notify),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { processAisSentence } from '../services/AisDecoder';
import { AisStore } from '../services/AisStore';
import { AlarmAudioService } from '../services/AlarmAudioService';
import { AisGuardAlertStore, DISTRESS_RELAYED_WORDS, distressLines } from '../services/aisGuardAlertStore';
import { DistressAlarmService, collectDistressBeacons } from '../services/DistressAlarmService';
import { gradeCollisionTargets, startAisGuardWatch } from '../services/AisGuardWatch';
import { encodeAisPositionReport, encodeAisSafetyText } from '../services/debug/aisInjector';
import { DEFAULT_COLLISION_PREFS } from '../utils/collisionRule';

const T0 = Date.UTC(2026, 9, 9, 6, 0, 0);
const OWN = { lat: 57.14, lon: -2.08 }; // off Aberdeen
const SART = 970_000_301;
const SART_2 = 970_000_302;
const MOB = 972_000_303;
const EPIRB = 974_000_304;

function hear(sentence: string): void {
    const decoded = processAisSentence(sentence);
    if (decoded) AisStore.ingest(decoded, false);
}

function position(mmsi: number, navStatus: number, lat = OWN.lat + 0.05, lon = OWN.lon + 0.05): string {
    return encodeAisPositionReport({ mmsi, navStatus, sogKn: 0.6, lat, lon, cogDeg: 95, headingDeg: null });
}

/** One pass of the distress watch at `nowMs`, with whatever the chart's internet layer offered. */
function pass(nowMs = Date.now(), internet: GeoJSON.Feature[] = []) {
    const beacons = collectDistressBeacons({ own: OWN, ownMmsis: new Set(), internet, nowMs });
    DistressAlarmService.update(beacons, nowMs);
    return beacons;
}

function cloudFeature(mmsi: number, navStatus: number, ageMin: number): GeoJSON.Feature {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [OWN.lon + 0.4, OWN.lat + 0.3] },
        properties: {
            mmsi,
            name: '',
            navStatus,
            sog: 0.4,
            cog: 120,
            source: 'cloud',
            updatedAt: new Date(Date.now() - ageMin * 60_000).toISOString(),
            staleMinutes: ageMin,
        },
    };
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    mocks.audio.startAlarm.mockClear();
    mocks.audio.stopAlarm.mockClear();
    mocks.notify.scheduleSafetyAlert.mockClear();
    mocks.notify.cancelSafetyAlert.mockClear();
    mocks.notify.scheduleAlarm.mockClear();
    mocks.notify.cancelAlarm.mockClear();
    AisStore.stop();
    AisStore.start();
    AisGuardAlertStore.clear();
    DistressAlarmService.__resetForTests();
    await AlarmAudioService.forceStop();
    mocks.audio.stopAlarm.mockClear();
});

afterEach(() => {
    AisStore.stop();
    vi.useRealTimers();
});

const settle = () => DistressAlarmService.whenIdle();
/** The watch's pass on an AIS report runs once per burst, a microtask later; then its side effects. */
const flushPass = async () => {
    await Promise.resolve();
    await settle();
};

describe("the plan's fixtures, through the real decoder and store", () => {
    it('status 15 heard before its message 14: shown as a test, never an alarm', async () => {
        hear(position(SART, 15));
        let [beacon] = pass();
        expect(beacon).toMatchObject({ mmsi: SART, kind: 'sart', state: 'test', sounds: false });
        vi.setSystemTime(T0 + 30_000);
        hear(encodeAisSafetyText(SART, 'SART TEST'));
        [beacon] = pass();
        expect(beacon).toMatchObject({ state: 'test', sounds: false });
        await settle();
        expect(mocks.audio.startAlarm).not.toHaveBeenCalled();
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
        // A test beacon is drawn on the chart, not carded.
        expect(AisGuardAlertStore.getDistress().filter((b) => b.state !== 'test')).toEqual([]);
    });

    it("a message 14 alone sounds, as 'position not yet received', with no Go-to", async () => {
        hear(encodeAisSafetyText(MOB, 'MOB ACTIVE'));
        const [beacon] = pass();
        expect(beacon).toMatchObject({ mmsi: MOB, kind: 'mob', state: 'active', sounds: true, lat: null, lon: null });
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
        const lines = distressLines(beacon, T0);
        expect(lines.where).toBe('Position not yet received');
        expect(lines.canGoTo).toBe(false);
        const [, title, body] = [
            null,
            mocks.notify.scheduleSafetyAlert.mock.calls[0][0].title,
            mocks.notify.scheduleSafetyAlert.mock.calls[0][0].body,
        ];
        expect(title).toBe('Distress: man overboard beacon active');
        expect(body).toContain('position not yet received');
    });

    it('a message 1 with status 14 sounds at any range, 80 NM off included', async () => {
        hear(position(EPIRB, 14, OWN.lat + 80 / 60, OWN.lon));
        const [beacon] = pass();
        expect(beacon).toMatchObject({ kind: 'epirb', state: 'active', sounds: true, source: 'local' });
        expect(beacon.rangeNm).toBeCloseTo(80, 0);
        expect(beacon.bearingDeg).toBeCloseTo(0, 0);
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
        expect(mocks.notify.scheduleSafetyAlert).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'distress', title: 'Distress: EPIRB-AIS beacon active' }),
        );
        // The shared path, never the anchor's own ids.
        expect(mocks.notify.scheduleAlarm).not.toHaveBeenCalled();
        expect(distressLines(beacon, T0).canGoTo).toBe(true);
    });

    it('an internet-only 970 does NOT sound: red, silent, relayed, with its age', async () => {
        const [beacon] = pass(T0, [cloudFeature(SART, 14, 6)]);
        expect(beacon).toMatchObject({ mmsi: SART, state: 'active', sounds: false, source: 'cloud' });
        await settle();
        expect(mocks.audio.startAlarm).not.toHaveBeenCalled();
        expect(mocks.notify.scheduleSafetyAlert).not.toHaveBeenCalled();
        const lines = distressLines(beacon, T0);
        expect(lines.heard).toBe(`${DISTRESS_RELAYED_WORDS}, 6 min old`);
        expect(DISTRESS_RELAYED_WORDS).toBe('Relayed via internet, not heard by your radio');
    });

    it('the same beacon heard by her radio wins over its internet copy, and sounds', async () => {
        hear(position(SART, 14));
        const beacons = pass(T0, [cloudFeature(SART, 14, 6)]);
        expect(beacons).toHaveLength(1);
        expect(beacons[0]).toMatchObject({ source: 'local', sounds: true });
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
    });

    it('a 97x with another status is a visual caution, silent', async () => {
        hear(position(MOB, 0));
        const [beacon] = pass();
        expect(beacon).toMatchObject({ state: 'caution', sounds: false });
        await settle();
        expect(mocks.audio.startAlarm).not.toHaveBeenCalled();
    });

    it("status 14 before its first fix (the ITU 'not available' 91, 181) sounds as 'position not yet received'", async () => {
        // A liferaft SART switched on under the canopy: its GNSS is cold, its bursts say 14.
        hear(position(SART, 14, 91, 181));
        const [beacon] = pass();
        expect(beacon).toMatchObject({ mmsi: SART, kind: 'sart', state: 'active', sounds: true, lat: null, lon: null });
        const lines = distressLines(beacon, T0);
        expect(lines.where).toBe('Position not yet received');
        expect(lines.canGoTo).toBe(false);
        // Nothing is drawn at 0,0 for it.
        expect(AisStore.toGeoJSON().features).toEqual([]);
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
        expect(mocks.notify.scheduleSafetyAlert).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'distress', body: expect.stringContaining('position not yet received') }),
        );

        // Its first fix gives Go to it.
        vi.setSystemTime(T0 + 60_000);
        hear(position(SART, 14));
        const [fixed] = pass();
        expect(fixed).toMatchObject({ state: 'active', lat: expect.any(Number), lon: expect.any(Number) });
        expect(distressLines(fixed, Date.now()).canGoTo).toBe(true);
    });

    it('a beacon with no fix and no active status never sounds; an ordinary ship with no position is still dropped', async () => {
        hear(position(EPIRB, 15, 91, 181));
        hear(position(MOB, 0, 91, 181));
        hear(position(123_400_309, 0, 91, 181));
        const beacons = pass();
        expect(beacons.map((b) => [b.mmsi, b.state, b.sounds])).toEqual([
            [MOB, 'caution', false],
            [EPIRB, 'caution', false],
        ]);
        expect(AisStore.getTargets().has(123_400_309)).toBe(false);
        await settle();
        expect(mocks.audio.startAlarm).not.toHaveBeenCalled();
    });

    it("an ordinary station's 'RANGE ACTIVE' broadcast is not a beacon", () => {
        hear(encodeAisSafetyText(123_400_305, 'FIRING RANGE ACTIVE'));
        expect(pass()).toEqual([]);
    });

    it('never treats our own MMSI as a beacon', () => {
        hear(position(123_400_306, 14));
        const beacons = collectDistressBeacons({
            own: OWN,
            ownMmsis: new Set([123_400_306]),
            internet: [],
            nowMs: T0,
        });
        expect(beacons).toEqual([]);
    });
});

describe('silence, and what sounds again', () => {
    it('Silence stops the sound and the lock-screen reminders, and keeps the card', async () => {
        hear(position(SART, 14));
        pass();
        await settle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);

        AisGuardAlertStore.silenceDistress(SART);
        await settle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(0);
        expect(mocks.audio.stopAlarm).toHaveBeenCalledTimes(1);
        expect(mocks.notify.cancelSafetyAlert).toHaveBeenCalledWith({ kind: 'distress' });
        expect(AisGuardAlertStore.getDistress().map((b) => b.mmsi)).toEqual([SART]);
        expect(AisGuardAlertStore.distressSilenced(SART)).toBe(true);

        // Later passes keep it silent: the same beacon, still active.
        vi.setSystemTime(T0 + 20_000);
        hear(position(SART, 14));
        pass();
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
    });

    it('a new distress MMSI sounds again after a silence', async () => {
        hear(position(SART, 14));
        pass();
        await settle();
        AisGuardAlertStore.silenceDistress(SART);
        await settle();
        vi.setSystemTime(T0 + 10_000);
        hear(position(SART_2, 14, OWN.lat - 0.05, OWN.lon));
        pass();
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(2);
        expect(mocks.notify.scheduleSafetyAlert).toHaveBeenCalledTimes(2);
        expect(AisGuardAlertStore.distressSilenced(SART)).toBe(true);
        expect(AisGuardAlertStore.distressSilenced(SART_2)).toBe(false);
    });

    it('a beacon switched from test to active sounds, even after a test was dismissed', async () => {
        hear(position(SART, 15));
        hear(encodeAisSafetyText(SART, 'SART TEST'));
        pass();
        AisGuardAlertStore.dismissDistress(SART);
        await settle();
        expect(mocks.audio.startAlarm).not.toHaveBeenCalled();

        vi.setSystemTime(T0 + 60_000);
        hear(position(SART, 14));
        const [beacon] = pass();
        expect(beacon).toMatchObject({ state: 'active', sounds: true });
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
        expect(AisGuardAlertStore.distressDismissed(SART)).toBe(false);
    });

    it('active, silenced, then test, then active again: a new activation sounds again', async () => {
        hear(position(SART, 14));
        pass();
        await settle();
        AisGuardAlertStore.silenceDistress(SART);
        await settle();
        vi.setSystemTime(T0 + 30_000);
        hear(encodeAisSafetyText(SART, 'SART TEST'));
        pass();
        vi.setSystemTime(T0 + 60_000);
        hear(position(SART, 14));
        pass();
        await settle();
        expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(2);
    });

    it('a beacon that falls silent keeps its card and keeps sounding until silenced: it never vanishes', async () => {
        hear(position(SART, 14));
        pass();
        vi.advanceTimersByTime(25 * 60_000);
        const [beacon] = pass();
        await settle();
        expect(beacon).toMatchObject({ mmsi: SART, state: 'active', sounds: true });
        expect(distressLines(beacon, Date.now()).heard).toBe('Heard by your radio, 25 min ago');
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
    });

    it('an internet-relayed beacon that drops out of the feed stays, with its age, until dismissed', () => {
        pass(T0, [cloudFeature(SART, 14, 2)]);
        vi.setSystemTime(T0 + 5 * 60_000);
        const [kept] = pass(T0 + 5 * 60_000, []);
        expect(kept).toMatchObject({ mmsi: SART, source: 'cloud', state: 'active' });
        expect(distressLines(kept, Date.now()).heard).toBe(`${DISTRESS_RELAYED_WORDS}, 7 min old`);
        AisGuardAlertStore.dismissDistress(SART);
        expect(AisGuardAlertStore.distressDismissed(SART)).toBe(true);
    });
});

describe('one sound, three owners: anchor first, distress over collision', () => {
    it('the collision alarm releasing its lease never silences the distress alarm', async () => {
        const collision = await AlarmAudioService.acquire('collision-watch');
        hear(position(SART, 14));
        pass();
        await settle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(2);
        await AlarmAudioService.release(collision);
        expect(mocks.audio.stopAlarm).not.toHaveBeenCalled();
        expect(AlarmAudioService.getIsPlaying()).toBe(true);
        AisGuardAlertStore.silenceDistress(SART);
        await settle();
        expect(mocks.audio.stopAlarm).toHaveBeenCalledTimes(1);
    });

    it('silencing the distress alarm never silences an anchor alarm (owner-scoped leases, no force stop)', async () => {
        const anchor = await AlarmAudioService.acquire('anchor-watch');
        hear(position(SART, 14));
        pass();
        await settle();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(2);
        AisGuardAlertStore.silenceDistress(SART);
        await settle();
        expect(mocks.audio.stopAlarm).not.toHaveBeenCalled();
        expect(AlarmAudioService.getActiveLeaseCount()).toBe(1);
        await AlarmAudioService.release(anchor);
    });
});

describe('a beacon is never a collision target', () => {
    it('steering to a SART at 6 kn grades no close quarters on it; a ship there still would', () => {
        const at = { lat: OWN.lat + 0.03 / 60, lon: OWN.lon };
        const feature = (mmsi: number, navStatus: number): GeoJSON.Feature => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [at.lon, at.lat] },
            properties: { mmsi, sog: 0.5, cog: 90, navStatus, source: 'local', lastUpdated: T0 },
        });
        const graded = gradeCollisionTargets(
            OWN,
            { sogKn: 6, cogDeg: 0, source: 'nmea', pair: 'offshore' },
            [feature(SART, 14), feature(MOB, 15), feature(123_400_307, 0)],
            DEFAULT_COLLISION_PREFS,
            undefined,
            T0,
        );
        expect(graded.map((c) => c.mmsi)).toEqual([123_400_307]);
        expect(graded[0].assessment.closeQuarters).toBe(true);
    });

    it('a ship with an ordinary MMSI misset to status 14 is still graded for collision (Cape Town)', () => {
        const own = { lat: -33.9, lon: 18.4 };
        const ship: GeoJSON.Feature = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [own.lon, own.lat + 0.03 / 60] },
            properties: { mmsi: 123_400_308, sog: 0.5, cog: 90, navStatus: 14, source: 'cloud', lastUpdated: T0 },
        };
        const graded = gradeCollisionTargets(
            own,
            { sogKn: 6, cogDeg: 0, source: 'nmea', pair: 'offshore' },
            [ship],
            DEFAULT_COLLISION_PREFS,
            undefined,
            T0,
        );
        expect(graded.map((c) => c.mmsi)).toEqual([123_400_308]);
        expect(graded[0].assessment.closeQuarters).toBe(true);
    });
});

describe('the watch', () => {
    it('runs whether or not the guard shield is armed: a heard SART sounds with the shield off', async () => {
        const stop = startAisGuardWatch();
        try {
            hear(position(SART, 14));
            await flushPass();
            expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
            // No fix of our own in this test: the beacon is still carded, its range unknown.
            const [beacon] = AisGuardAlertStore.getDistress();
            expect(beacon).toMatchObject({ mmsi: SART, state: 'active', rangeNm: null });
            expect(distressLines(beacon, T0).where).toBe('Range unknown: no position fix');
        } finally {
            stop();
        }
    });

    it('a burst of reports (the Pi lane sends up to 300 at once) costs one distress pass, not one per report', async () => {
        const stop = startAisGuardWatch();
        const passes = vi.spyOn(AisGuardAlertStore, 'setDistress');
        try {
            for (let i = 0; i < 300; i++) {
                AisStore.update({ mmsi: 123_500_000 + i, lat: OWN.lat + i / 1000, lon: OWN.lon, navStatus: 0 });
            }
            hear(position(SART, 14));
            expect(passes).not.toHaveBeenCalled();
            await flushPass();
            expect(passes).toHaveBeenCalledTimes(1);
            expect(mocks.audio.startAlarm).toHaveBeenCalledTimes(1);
        } finally {
            passes.mockRestore();
            stop();
        }
    });
});
