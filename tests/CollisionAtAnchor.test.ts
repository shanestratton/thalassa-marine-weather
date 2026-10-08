/**
 * Close quarters at anchor (build 125, package 125-01b): where `atAnchor`
 * comes from, and that the chip, the alarm and Calypso all grade with it.
 *
 * `atAnchor` is read from the one anchor-watch truth (presentAnchorWatchRow,
 * the row the System status box, the Vessel tile and the chart badge read),
 * never from a nav status:
 *  - a watch kept on this phone (holding, setting, paused or alarming) is at
 *    anchor: the phone's own watch runs aboard;
 *  - a watch this phone handed to its Pi is at anchor while the position the
 *    rule grades is the boat's own (her GPS, any lane); graded from this
 *    phone's GPS, only while that is within 100 m of where the Pi last
 *    reported her (aboard), since the phone may be ashore on Shore Watch;
 *  - a session joined from another device is at anchor only while the
 *    position we grade is within 100 m of where that device last reported its
 *    boat; otherwise it says nothing about where we are, or which boat.
 *
 * An anchor watch that is on but not at anchor for us is 'elsewhere': the
 * strip says so, never 'no anchor watch' (125-01b review).
 *
 * Anchored off Horta (Azores) and in Simon's Town (South Africa): a global
 * app. Fictional MMSIs only (MID 123 is unallocated).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AisTarget } from '../types/navigation';

const hoisted = vi.hoisted(() => ({
    local: { state: 'idle' } as Record<string, unknown>,
    localListener: null as ((snapshot: Record<string, unknown>) => void) | null,
    localThrows: false,
    shore: {
        sessionCode: null as string | null,
        position: null as unknown,
        stale: true,
        cause: null as string | null,
        lastContactAt: null as number | null,
    },
    piCode: null as string | null,
    fix: { lat: 38.53, lon: -28.62, sog: 0, cog: 0, timestamp: 0, source: 'nmea' } as Record<string, unknown> | null,
    motion: { sogKn: 0 as number | null, cogDeg: null as number | null, source: 'nmea', pair: 'inshore' },
    targets: new Map<number, AisTarget>(),
}));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: (listener: (snapshot: Record<string, unknown>) => void) => {
            if (hoisted.localThrows) throw new Error('test double without subscribe');
            hoisted.localListener = listener;
            listener(hoisted.local);
            return () => undefined;
        },
        getSnapshot: () => {
            if (hoisted.localThrows) throw new Error('test double without getSnapshot');
            return hoisted.local;
        },
    },
}));
vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: { getSnapshot: () => hoisted.shore },
}));
vi.mock('../services/anchorPiWatchKeeper', () => ({
    AnchorPiWatchKeeper: { keepingSessionCode: () => hoisted.piCode },
}));
vi.mock('../services/ownshipPosition', () => ({
    resolveOwnshipPosition: () => hoisted.fix,
    resolveOwnMotion: () => hoisted.motion,
}));
vi.mock('../services/AisStore', () => ({
    AisStore: {
        getTargets: () => hoisted.targets,
        getOwnMmsi: () => null,
        toGeoJSON: () => ({ type: 'FeatureCollection', features: [] }),
        subscribe: () => () => undefined,
        getLastHeardAt: () => 0,
    },
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: {} }) } }));
vi.mock('../services/CollisionAlarmService', () => ({
    CollisionAlarmService: { update: vi.fn(), disarm: vi.fn(), noFix: vi.fn(), unchecked: vi.fn() },
}));

import { presentAnchorWatchRow } from '../components/anchor-watch/anchorWatchStatusRow';
import {
    collisionAnchorWatch,
    __resetCollisionAnchorWatchForTests,
    type CollisionPositionSource,
} from '../services/collisionAnchorWatch';
import { collisionCandidates, readCollisionInputs } from '../services/AisGuardWatch';
import { aisProximity } from '../services/voice/integrations/aisProximity';
import { computeCpa } from '../utils/cpaCalculation';

const NOW = Date.now();
const HORTA = { lat: 38.53, lon: -28.62 };
const SIMONS_TOWN = { lat: -34.19, lon: 18.43 };

type Local = Parameters<typeof presentAnchorWatchRow>[0];
type Shore = Parameters<typeof presentAnchorWatchRow>[1];
const local = (state: string, extra: Record<string, unknown> = {}): NonNullable<Local> =>
    ({
        state,
        distanceFromAnchor: 12,
        swingRadius: 45,
        alarmTriggeredAt: null,
        alarmCause: null,
        ...extra,
    }) as NonNullable<Local>;
const noShore: Shore = { sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null };
const remote = {
    vessel: { latitude: HORTA.lat, longitude: HORTA.lon, timestamp: NOW },
    anchor: { latitude: HORTA.lat, longitude: HORTA.lon + 0.0003 },
    distance: 20,
    swingRadius: 45,
    isAlarm: false,
    timestamp: NOW,
};
const shore = (sessionCode: string, extra: Partial<Shore> = {}): Shore =>
    ({ sessionCode, position: remote, stale: false, cause: null, lastContactAt: NOW, ...extra }) as Shore;
/** Where the keeper last reported the boat (fresh), as readCollisionAnchorWatch passes it. */
const KEPT = { lat: HORTA.lat, lon: HORTA.lon };
/** `northM` metres north of the boat, from `source`. */
const fromBoat = (source: CollisionPositionSource, northM = 0) => ({
    lat: HORTA.lat + northM / 1852 / 60,
    lon: HORTA.lon,
    source,
});
/** The rule's flag: whether this row puts the position we grade at anchor. */
const atAnchor = (
    row: Parameters<typeof collisionAnchorWatch>[0],
    source: CollisionPositionSource,
    northM = 0,
    kept: typeof KEPT | null = KEPT,
) => collisionAnchorWatch(row, fromBoat(source, northM), kept) === 'at-anchor';

beforeEach(() => {
    __resetCollisionAnchorWatchForTests();
    hoisted.local = { state: 'idle' };
    hoisted.localListener = null;
    hoisted.localThrows = false;
    hoisted.shore = { sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null };
    hoisted.piCode = null;
    hoisted.fix = { ...HORTA, sog: 0, cog: 0, timestamp: NOW, source: 'nmea' };
    hoisted.motion = { sogKn: 0, cogDeg: null, source: 'nmea', pair: 'inshore' };
    hoisted.targets = new Map();
});

describe('who keeps the anchor watch decides atAnchor (the one anchor-watch truth)', () => {
    it('no anchor watch anywhere: not at anchor (a berth), and nothing kept elsewhere', () => {
        for (const source of ['nmea', 'gps', null] as const) {
            for (const row of [
                presentAnchorWatchRow(null, noShore, null),
                presentAnchorWatchRow(local('idle'), noShore, null),
            ]) {
                expect(collisionAnchorWatch(row, fromBoat(source), KEPT)).toBe('none');
            }
        }
    });

    it("this phone's own watch, in any state but idle: at anchor, from the boat's GPS or the phone's", () => {
        for (const state of ['watching', 'setting', 'paused', 'alarm']) {
            const row = presentAnchorWatchRow(local(state), noShore, null);
            expect(row.keeper).toBe('phone');
            for (const source of ['nmea', 'gps'] as const) {
                expect(atAnchor(row, source, 0, null), `${state} ${source}`).toBe(true);
            }
        }
    });

    it("the watch this phone handed to its Pi: at anchor while we grade the boat's own position", () => {
        // Joined as Shore Watch to its own Pi's session, with fresh reports.
        const joined = presentAnchorWatchRow(local('idle'), shore('PISESSION'), 'PISESSION');
        expect(joined.keeper).toBe('pi');
        expect(atAnchor(joined, 'nmea', 0, null)).toBe(true);
        // The Pi has the watch but this phone never joined: still the boat's.
        const unjoined = presentAnchorWatchRow(null, noShore, 'PISESSION');
        expect(unjoined).toMatchObject({ active: true, keeper: 'pi' });
        expect(atAnchor(unjoined, 'nmea', 0, null)).toBe(true);
        // A Pi watch in alarm or out of touch is still an anchor down.
        expect(atAnchor(presentAnchorWatchRow(null, shore('PISESSION', { cause: 'drag' }), 'PISESSION'), 'nmea')).toBe(
            true,
        );
        expect(
            atAnchor(presentAnchorWatchRow(null, shore('PISESSION', { cause: 'contact-lost' }), 'PISESSION'), 'nmea'),
        ).toBe(true);
    });

    it("Pi-kept, graded from this phone's own GPS: at anchor aboard (within 100 m of her), elsewhere ashore", () => {
        const joined = presentAnchorWatchRow(local('idle'), shore('PISESSION'), 'PISESSION');
        // Aboard, the boat's network feed lapsed for 20 s: the phone's GPS is within metres of hers.
        expect(collisionAnchorWatch(joined, fromBoat('gps', 15), KEPT)).toBe('at-anchor');
        expect(collisionAnchorWatch(joined, fromBoat('gps', 95), KEPT)).toBe('at-anchor');
        // Ashore on Shore Watch (a ferry passing the waterfront must not sound): kept elsewhere.
        expect(collisionAnchorWatch(joined, fromBoat('gps', 400), KEPT)).toBe('elsewhere');
        // No fresh report of where she lies: we cannot say we are aboard.
        expect(collisionAnchorWatch(joined, fromBoat('gps', 15), null)).toBe('elsewhere');
        expect(collisionAnchorWatch(joined, null, KEPT)).toBe('elsewhere');
    });

    it('a session joined from another device: at anchor only alongside her, else kept elsewhere', () => {
        const other = presentAnchorWatchRow(null, shore('FRIENDSBOAT'), 'PISESSION');
        expect(other.keeper).toBe('other');
        // A crew phone keeps the watch and this phone joined it, aboard: at anchor.
        expect(collisionAnchorWatch(other, fromBoat('gps', 20), KEPT)).toBe('at-anchor');
        expect(collisionAnchorWatch(other, fromBoat('nmea', 5), KEPT)).toBe('at-anchor');
        // A friend's boat across the bay, or no fresh position of hers: not where we are.
        expect(collisionAnchorWatch(other, fromBoat('nmea', 1_500), KEPT)).toBe('elsewhere');
        expect(collisionAnchorWatch(other, fromBoat('gps', 400), KEPT)).toBe('elsewhere');
        expect(collisionAnchorWatch(other, fromBoat('nmea', 5), null)).toBe('elsewhere');
        const noPi = presentAnchorWatchRow(null, shore('FRIENDSBOAT'), null);
        expect(collisionAnchorWatch(noPi, fromBoat('nmea', 1_500), KEPT)).toBe('elsewhere');
    });

    it('this phone keeping its own watch wins over a joined session', () => {
        const row = presentAnchorWatchRow(local('watching'), shore('FRIENDSBOAT'), null);
        expect(row.keeper).toBe('phone');
        expect(atAnchor(row, 'gps', 5_000, null)).toBe(true);
    });
});

describe('readCollisionInputs supplies atAnchor to the alarm, the chip and Calypso alike', () => {
    /** This phone's own GPS, `northM` metres north of the boat at Horta. */
    const phoneAt = (northM: number) => ({ ...fromBoat('gps', northM), sog: 0, cog: 0, timestamp: NOW });

    it('phone-kept: true, and follows the watch as it is weighed', () => {
        hoisted.local = local('watching');
        hoisted.fix = phoneAt(0);
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: true, anchorWatch: 'at-anchor' });
        // Weigh anchor: the service tells its subscribers.
        hoisted.localListener!(local('idle'));
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: false, anchorWatch: 'none' });
    });

    it("Pi-kept: true from the boat's GPS or aboard; kept elsewhere from this phone ashore", () => {
        hoisted.shore = shore('PISESSION') as typeof hoisted.shore;
        hoisted.piCode = 'PISESSION';
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: true, anchorWatch: 'at-anchor' });
        // Aboard, the boat's feed lapsed: this phone's GPS, a few metres from hers.
        hoisted.fix = phoneAt(12);
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: true, anchorWatch: 'at-anchor' });
        // Ashore, 600 m off: the watch is kept elsewhere.
        hoisted.fix = phoneAt(600);
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: false, anchorWatch: 'elsewhere' });
        // Aboard, but the Pi's reports have gone stale: we cannot say so.
        hoisted.fix = phoneAt(12);
        hoisted.shore = shore('PISESSION', { stale: true }) as typeof hoisted.shore;
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: false, anchorWatch: 'elsewhere' });
    });

    it('another device: at anchor alongside her, kept elsewhere away from her; no watch at all: none', () => {
        hoisted.shore = shore('FRIENDSBOAT') as typeof hoisted.shore;
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: true, anchorWatch: 'at-anchor' });
        hoisted.fix = phoneAt(2_000);
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: false, anchorWatch: 'elsewhere' });
        hoisted.shore = { sessionCode: null, position: null, stale: true, cause: null, lastContactAt: null };
        expect(readCollisionInputs(NOW)).toMatchObject({ atAnchor: false, anchorWatch: 'none' });
    });

    it("this phone's watch that cannot be read never breaks the watch: not at anchor, as before 125-01b", () => {
        hoisted.local = local('watching');
        hoisted.localThrows = true;
        expect(() => readCollisionInputs(NOW)).not.toThrow();
        expect(readCollisionInputs(NOW).atAnchor).toBe(false);
        // The Pi's watch is still read.
        hoisted.shore = shore('PISESSION') as typeof hoisted.shore;
        hoisted.piCode = 'PISESSION';
        expect(readCollisionInputs(NOW).atAnchor).toBe(true);
    });
});

describe('the chip, the alarm and Calypso agree at anchor', () => {
    /** A vessel steaming north whose CPA is `offNm` east of `at`, `tcpaMin` minutes from now. */
    function vessel(mmsi: number, sogKn: number, offNm: number, tcpaMin: number, at = HORTA): AisTarget {
        const cosLat = Math.cos((at.lat * Math.PI) / 180);
        return {
            mmsi,
            name: `FICTIONAL ${mmsi}`,
            lat: at.lat - (sogKn * tcpaMin) / 60 / 60,
            lon: at.lon + offNm / 60 / cosLat,
            sog: sogKn,
            cog: 0,
            heading: 511,
            navStatus: 0,
            shipType: 70,
            callSign: '',
            destination: '',
            lastUpdated: NOW - 5_000,
        };
    }

    for (const [where, at] of [
        ['Horta', HORTA],
        ['Simon’s Town', SIMONS_TOWN],
    ] as const) {
        for (const anchored of [true, false]) {
            it(`${where}, ${anchored ? 'anchor watch on' : 'at a berth'}: one answer for every target`, async () => {
                hoisted.fix = { ...at, sog: 0, cog: 0, timestamp: NOW, source: 'nmea' };
                if (anchored) hoisted.local = local('watching');
                const ships = [
                    vessel(123400501, 6, 0.05, 2, at), // under way, close quarters
                    vessel(123400502, 1.5, 0.05, 2, at), // a drifter
                    vessel(123400503, 2, 0.05, 2, at), // exactly 2 kn
                    vessel(123400504, 12, 0.3, 2, at), // under way, 0.3 NM off
                    { ...vessel(123400505, 6, 0.05, 2, at), navStatus: 5 }, // 'moored' at 6 kn
                    { ...vessel(123400506, 6, 0.05, 2, at), sog: 102.3 }, // speed not available
                ];
                for (const ship of ships) hoisted.targets.set(ship.mmsi, ship);

                const inputs = readCollisionInputs(NOW);
                expect(inputs.atAnchor).toBe(anchored);
                const features = ships.map((t) => ({
                    type: 'Feature' as const,
                    geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
                    properties: { ...t, source: 'local' },
                }));
                const alarm = collisionCandidates(
                    inputs.own!,
                    inputs.motion,
                    features,
                    inputs.prefs,
                    inputs.ownMmsis,
                    NOW,
                    inputs.atAnchor,
                ).map((c) => c.mmsi);
                const voice = JSON.parse((await aisProximity(5, 10)).content);
                const voiceAlarms = voice.targets
                    .filter((t: { alarm: boolean }) => t.alarm)
                    .map((t: { mmsi: number }) => t.mmsi);
                const chipAlarms = ships
                    .filter((t) => {
                        const chip = computeCpa(
                            inputs.own!.lat,
                            inputs.own!.lon,
                            inputs.motion.cogDeg,
                            inputs.motion.sogKn,
                            t.lat,
                            t.lon,
                            t.cog,
                            t.sog,
                            t.navStatus ?? undefined,
                            inputs.prefs,
                            5,
                            inputs.motion.pair,
                            inputs.atAnchor,
                        );
                        return !!chip && (chip.risk === 'DANGER' || chip.closeQuarters);
                    })
                    .map((t) => t.mmsi);

                const expected = anchored ? [123400501, 123400505] : [];
                expect(alarm.sort()).toEqual(expected);
                expect(voiceAlarms.sort()).toEqual(expected);
                expect(chipAlarms.sort()).toEqual(expected);
                expect(voice.at_anchor).toBe(anchored);
            });
        }
    }

    it("the chart's CPA chip passes the alarm's own atAnchor (readCollisionInputs) to computeCpa", () => {
        const source = readFileSync(resolve(process.cwd(), 'components/map/useAisStreamLayer.ts'), 'utf8');
        const read = /const \{([^}]*)\} = readCollisionInputs\(\);/.exec(source);
        expect(read?.[1]).toMatch(/\batAnchor\b/);
        const call = /computeCpa\(([\s\S]*?)\)\s*:\s*null;/.exec(source);
        expect(call?.[1].trim().replace(/,\s*$/, '').split(/,\s*/).at(-1)).toBe('atAnchor');
    });
});
