/**
 * The collision watch rides the guard's app-wide loop (services/AisGuardWatch):
 * one pass, one rule, one alarm path. These pin what reaches the alarm:
 * real-sensor AIS only, never an unknown speed or course, never ownship, and
 * the newest AIS report time so a swept-out list reads as blind, not clear.
 *
 * Fictional MMSIs only (MID 123 is unallocated). Waters off Cape Town.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
    guard: { enabled: true, radiusNm: 2, alerts: [] as unknown[], collisionChecked: true as boolean | undefined },
    heardAt: 0,
    ownMmsiHeard: null as number | null,
    own: { lat: -33.9, lon: 18.4, sog: 6, cog: 0, timestamp: 0, source: 'nmea' } as Record<string, unknown> | null,
    motion: { sogKn: 6, cogDeg: 0, source: 'nmea', pair: 'offshore' } as {
        sogKn: number | null;
        cogDeg: number | null;
        source: string | null;
        pair: 'inshore' | 'offshore';
    },
    local: [] as GeoJSON.Feature[],
    atAnchor: false,
    elsewhere: false,
    anchorSourceAsked: [] as unknown[],
    update: vi.fn(),
    disarm: vi.fn(),
    noFix: vi.fn(),
    unchecked: vi.fn(),
    checkFeatures: vi.fn((..._args: unknown[]) => [] as unknown[]),
}));

vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: { getState: () => hoisted.guard, checkFeatures: hoisted.checkFeatures },
}));
vi.mock('../services/AisStore', () => ({
    AisStore: {
        toGeoJSON: () => ({ type: 'FeatureCollection', features: hoisted.local }),
        subscribe: () => () => {},
        getLastHeardAt: () => hoisted.heardAt,
        getOwnMmsi: () => hoisted.ownMmsiHeard,
    },
}));
vi.mock('../services/ownshipPosition', () => ({
    resolveOwnshipPosition: () => hoisted.own,
    resolveOwnMotion: () => hoisted.motion,
}));
vi.mock('../services/GpsService', () => ({ GpsService: { getLastKnownPosition: () => null } }));
vi.mock('../services/collisionAnchorWatch', () => ({
    readCollisionAnchorWatch: (own: { source?: unknown } | null) => {
        hoisted.anchorSourceAsked.push(own?.source ?? null);
        return hoisted.atAnchor ? 'at-anchor' : hoisted.elsewhere ? 'elsewhere' : 'none';
    },
}));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({}) } }));
vi.mock('../stores/LocationStore', () => ({ LocationStore: { getState: () => ({}) } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: { mmsi: '123499999' } } }) },
}));
vi.mock('../services/CollisionAlarmService', () => ({
    CollisionAlarmService: {
        update: hoisted.update,
        disarm: hoisted.disarm,
        noFix: hoisted.noFix,
        unchecked: hoisted.unchecked,
    },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runGuardCheck, publishInternetAisFeatures, __resetAisGuardWatchForTests } from '../services/AisGuardWatch';
import type { CollisionAlarmCandidate } from '../services/CollisionAlarmService';

// Real time: the internet feed is timestamped on publish with Date.now().
const NOW = Date.now();

/** A target `distNm` due north of the boat, heading south (straight at us). */
function feature(mmsi: number, distNm: number, props: Record<string, unknown> = {}): GeoJSON.Feature {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [18.4, -33.9 + distNm / 60] },
        properties: {
            mmsi,
            name: `FICTIONAL ${mmsi}`,
            sog: 8,
            cog: 180,
            navStatus: 0,
            lastUpdated: NOW - 4_000,
            ...props,
        },
    };
}

/** Every target the watch graded this pass (alarming or not). */
function graded(): CollisionAlarmCandidate[] {
    expect(hoisted.update).toHaveBeenCalled();
    return hoisted.update.mock.calls.at(-1)![0];
}

/** The ones that alarm. */
function candidates(): CollisionAlarmCandidate[] {
    return graded().filter((c) => c.assessment.alarm);
}

beforeEach(() => {
    __resetAisGuardWatchForTests();
    hoisted.guard = { enabled: true, radiusNm: 2, alerts: [], collisionChecked: true };
    hoisted.own = { lat: -33.9, lon: 18.4, sog: 6, cog: 0, timestamp: NOW, source: 'nmea' };
    hoisted.motion = { sogKn: 6, cogDeg: 0, source: 'nmea', pair: 'offshore' };
    hoisted.local = [];
    hoisted.heardAt = 0;
    hoisted.ownMmsiHeard = null;
    hoisted.atAnchor = false;
    hoisted.elsewhere = false;
    hoisted.anchorSourceAsked = [];
    for (const fn of [hoisted.update, hoisted.disarm, hoisted.noFix, hoisted.unchecked, hoisted.checkFeatures]) {
        fn.mockClear();
    }
});

describe('collision watch on the guard loop', () => {
    it('hands a closing receiver target to the alarm, named, with its report age, and still runs the ring', () => {
        hoisted.local = [feature(123400101, 1.5)];
        runGuardCheck(NOW);
        expect(hoisted.checkFeatures).toHaveBeenCalledOnce();
        const [only] = candidates();
        expect(only.mmsi).toBe(123400101);
        expect(only.name).toBe('FICTIONAL 123400101');
        expect(only.source).toBe('local');
        expect(only.reportAgeSec).toBe(4);
        expect(only.assessment.alarm).toBe(true);
        expect(only.assessment.risk).toBe('DANGER');
        expect(hoisted.update.mock.calls[0][1]).toEqual({
            nowMs: NOW,
            lastAisAt: NOW - 4_000,
            own: 'moving',
            atAnchor: false,
            anchorWatchElsewhere: false,
        });
    });

    it('hands over a quiet target too, graded, so the alarm can tell opening from lost', () => {
        hoisted.local = [feature(123400102, 1.5, { cog: 0, sog: 12 })]; // running away
        runGuardCheck(NOW);
        expect(candidates()).toEqual([]);
        const [quiet] = graded();
        expect(quiet.mmsi).toBe(123400102);
        expect(quiet.assessment.rangeOnly).toBe(false);
        expect(quiet.opening).toBe(true);
    });

    it('never alarms on an unknown speed or course (102.3 / 360): range only, never opening', () => {
        hoisted.local = [feature(123400103, 0.5, { sog: 102.3 }), feature(123400104, 0.5, { cog: 360 })];
        runGuardCheck(NOW);
        expect(candidates()).toEqual([]);
        for (const c of graded()) {
            expect(c.assessment.rangeOnly).toBe(true);
            expect(c.opening).toBe(false);
        }
    });

    it('never grades our own transponder: neither the typed MMSI nor the one our !AIVDO reports', () => {
        hoisted.ownMmsiHeard = 123488888;
        hoisted.local = [feature(123499999, 0.2), feature(123488888, 0.01, { sog: 6, cog: 0 })];
        runGuardCheck(NOW);
        expect(graded()).toEqual([]);
        // The ring is not handed our echo either.
        const ringFeatures = hoisted.checkFeatures.mock.calls[0][2] as GeoJSON.Feature[];
        expect(ringFeatures.map((f) => f.properties?.mmsi)).toEqual([]);
    });

    it('lets network AIS alarm, with its age, but never an app-reported position', () => {
        publishInternetAisFeatures([
            feature(123400105, 1.5, { source: 'cloud', staleMinutes: 2, lastUpdated: undefined }),
            feature(123400106, 1.4, { source: 'app', staleMinutes: 0 }),
        ]);
        runGuardCheck(NOW);
        const list = candidates();
        expect(list.map((c) => c.mmsi)).toEqual([123400105]);
        expect(list[0].source).toBe('cloud');
        expect(list[0].reportAgeSec).toBe(120);
    });

    it('treats a swept-out receiver list as no AIS, never as a clear sea', () => {
        hoisted.local = [];
        runGuardCheck(NOW);
        expect(hoisted.update.mock.calls[0][1]).toEqual({
            nowMs: NOW,
            lastAisAt: 0,
            own: 'moving',
            atAnchor: false,
            anchorWatchElsewhere: false,
        });
    });

    it('counts AIS as heard from any message the receiver decoded, not only targets still held', () => {
        hoisted.local = [];
        hoisted.heardAt = NOW - 20_000; // e.g. our own !AIVDO, or a target since swept
        runGuardCheck(NOW);
        expect(hoisted.update.mock.calls[0][1].lastAisAt).toBe(NOW - 20_000);
    });

    it('tells the alarm when we are stopped or our motion is unknown', () => {
        hoisted.motion = { sogKn: 0.2, cogDeg: null, source: 'nmea', pair: 'inshore' };
        runGuardCheck(NOW);
        expect(hoisted.update.mock.calls.at(-1)![1].own).toBe('stopped');
        hoisted.motion = { sogKn: 6, cogDeg: null, source: 'nmea', pair: 'offshore' };
        runGuardCheck(NOW);
        expect(hoisted.update.mock.calls.at(-1)![1].own).toBe('unknown');
    });

    it('a shield armed before build 125 keeps its ring but holds the collision alarm until the sound check', () => {
        hoisted.guard.collisionChecked = undefined;
        hoisted.local = [feature(123400110, 1.5)];
        runGuardCheck(NOW);
        expect(hoisted.update).not.toHaveBeenCalled();
        expect(hoisted.unchecked).toHaveBeenCalledWith(NOW);
        expect(hoisted.checkFeatures).toHaveBeenCalledOnce();
    });

    it('disarmed: tells the alarm to stand down and checks nothing', () => {
        hoisted.guard.enabled = false;
        hoisted.local = [feature(123400107, 1.5)];
        runGuardCheck(NOW);
        expect(hoisted.disarm).toHaveBeenCalledOnce();
        expect(hoisted.update).not.toHaveBeenCalled();
    });

    it('no fix: says so instead of watching nothing', () => {
        hoisted.own = null;
        hoisted.local = [feature(123400108, 1.5)];
        runGuardCheck(NOW);
        expect(hoisted.noFix).toHaveBeenCalledWith(NOW);
        expect(hoisted.update).not.toHaveBeenCalled();
    });

    it('at anchor (125-01b): stopped, a ship under way inside close quarters reaches the alarm; a drifter does not', () => {
        hoisted.atAnchor = true;
        hoisted.motion = { sogKn: 0.1, cogDeg: null, source: 'nmea', pair: 'inshore' };
        // Due north, heading south: 0.2 NM at 6 kn is 2 min out; at 1.5 kn, 0.05 NM is 2 min out.
        hoisted.local = [
            feature(123400111, 0.2, { sog: 6 }),
            feature(123400112, 0.05, { sog: 1.5 }),
            feature(123400113, 0.2, { sog: 6, navStatus: 5 }), // 'moored', making 6 kn
        ];
        runGuardCheck(NOW);
        // The anchor truth is asked about the position the rule grades (the boat's GPS here).
        expect(hoisted.anchorSourceAsked).toContain('nmea');
        expect(hoisted.update.mock.calls.at(-1)![1]).toMatchObject({ own: 'stopped', atAnchor: true });
        const list = candidates();
        expect(list.map((c) => c.mmsi).sort()).toEqual([123400111, 123400113]);
        for (const c of list) expect(c.assessment.closeQuarters).toBe(true);
    });

    it('at a berth (no anchor watch): the same ships reach the alarm graded, but none alarms', () => {
        hoisted.motion = { sogKn: 0.1, cogDeg: null, source: 'nmea', pair: 'inshore' };
        hoisted.local = [feature(123400111, 0.2, { sog: 6 }), feature(123400112, 0.05, { sog: 1.5 })];
        runGuardCheck(NOW);
        expect(hoisted.update.mock.calls.at(-1)![1]).toMatchObject({ own: 'stopped', atAnchor: false });
        expect(
            graded()
                .map((c) => c.mmsi)
                .sort(),
        ).toEqual([123400111, 123400112]);
        expect(candidates()).toEqual([]);
    });

    it('yawing at anchor (125-01b review): 0.8 kn with no course is stopped, a swinging neighbour stays quiet', () => {
        hoisted.atAnchor = true;
        hoisted.motion = { sogKn: 0.8, cogDeg: null, source: 'nmea', pair: 'inshore' };
        hoisted.local = [
            feature(123400114, 0.12, { sog: 0.9 }), // a neighbour swinging toward us
            feature(123400115, 0.2, { sog: 6 }), // a ship under way, 2 min out
        ];
        runGuardCheck(NOW);
        expect(hoisted.update.mock.calls.at(-1)![1]).toMatchObject({ own: 'stopped', atAnchor: true });
        expect(candidates().map((c) => c.mmsi)).toEqual([123400115]);
        const neighbour = graded().find((c) => c.mmsi === 123400114)!;
        expect(neighbour.assessment.alarm).toBe(false);
        // She is not under way and we are stopped: evidence an encounter with her is over.
        expect(neighbour.settled).toBe(true);
        expect(graded().find((c) => c.mmsi === 123400115)!.settled).toBe(false);
        // The same yaw with no anchor watch is a boat under way with no course: unknown, no CPA.
        hoisted.atAnchor = false;
        runGuardCheck(NOW);
        expect(hoisted.update.mock.calls.at(-1)![1]).toMatchObject({ own: 'unknown', atAnchor: false });
        expect(graded().every((c) => c.settled === false)).toBe(true);
    });

    it('under way, nothing is settled: an encounter ends only on an opening CPA', () => {
        hoisted.local = [feature(123400116, 1.5, { sog: 1 })];
        runGuardCheck(NOW);
        expect(graded()[0].settled).toBe(false);
    });

    it('an anchor watch kept elsewhere reaches the strip, and is not at anchor for the rule', () => {
        hoisted.elsewhere = true;
        hoisted.motion = { sogKn: 0.1, cogDeg: null, source: 'phone', pair: 'inshore' };
        hoisted.own = { lat: -33.9, lon: 18.4, sog: 0, cog: 0, timestamp: NOW, source: 'gps' };
        hoisted.local = [feature(123400117, 0.2, { sog: 6 })];
        runGuardCheck(NOW);
        expect(hoisted.anchorSourceAsked.at(-1)).toBe('gps');
        expect(hoisted.update.mock.calls.at(-1)![1]).toMatchObject({
            own: 'stopped',
            atAnchor: false,
            anchorWatchElsewhere: true,
        });
        expect(candidates()).toEqual([]);
    });

    it('our own motion unknown: range only, no alarm', () => {
        hoisted.motion = { sogKn: null, cogDeg: null, source: null, pair: 'inshore' };
        hoisted.local = [feature(123400109, 1.5)];
        runGuardCheck(NOW);
        expect(candidates()).toEqual([]);
    });
});
