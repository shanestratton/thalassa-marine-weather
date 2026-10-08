/**
 * The distress-beacon classifier (build 125, package 125-02), in the same
 * pure, dependency-free module as the collision rule (utils/collisionRule.ts)
 * so the Pi's night watch (126-04) copies one file.
 *
 *  - Nav status 14, or a message 14 'ACTIVE' text, is active: it alarms.
 *  - Status 15 on a beacon's MMSI, or 'TEST' text, is a test: shown, never an alarm,
 *    including status 15 heard before the beacon's message 14.
 *  - A 970 (AIS-SART), 972 (AIS man overboard) or 974 (EPIRB-AIS) MMSI with any
 *    other status is a visual caution only.
 *  - Only a beacon heard by her own receiver ('local') sounds. One relayed over
 *    the internet ('cloud') is red and silent.
 *  - A heard beacon with no position yet still alarms, marked as such.
 *  - Whichever of status and text was heard last decides, so a test beacon
 *    switched to active alarms on its first active position report.
 *
 * Fictional MMSIs only: 970/972/974 followed by manufacturer 00, which this
 * repository uses for invented beacons (it is public).
 */
import { describe, expect, it } from 'vitest';
import {
    aisTargetIsDistressBeacon,
    classifyDistress,
    distressKindOfMmsi,
    distressTextSignal,
    type DistressEvidence,
} from '../utils/collisionRule';

const SART = 970_000_101;
const MOB = 972_000_102;
const EPIRB = 974_000_103;
const SHIP = 123_400_104; // MID 123 is unallocated: a fictional vessel

const T = Date.UTC(2026, 9, 9, 6, 0, 0);

function evidence(over: Partial<DistressEvidence>): DistressEvidence {
    return { mmsi: SART, source: 'local', hasPosition: true, ...over };
}

describe('which MMSIs are beacons', () => {
    it('reads 970 as an AIS-SART, 972 as AIS man overboard and 974 as EPIRB-AIS', () => {
        expect(distressKindOfMmsi(SART)).toBe('sart');
        expect(distressKindOfMmsi(MOB)).toBe('mob');
        expect(distressKindOfMmsi(EPIRB)).toBe('epirb');
        expect(distressKindOfMmsi(String(MOB))).toBe('mob');
    });

    it('reads no other MMSI as a beacon, 971/973 and short numbers included', () => {
        for (const mmsi of [SHIP, 971_000_001, 973_000_001, 975_000_001, 97_000_010, 9_700_001_011, 0, -970_000_101]) {
            expect(distressKindOfMmsi(mmsi)).toBeNull();
        }
        expect(distressKindOfMmsi(null)).toBeNull();
        expect(distressKindOfMmsi('not a number')).toBeNull();
    });

    it('never drops a beacon: any 97x MMSI, or any target reporting status 14', () => {
        expect(aisTargetIsDistressBeacon(SART, 15)).toBe(true);
        expect(aisTargetIsDistressBeacon(EPIRB, 0)).toBe(true);
        expect(aisTargetIsDistressBeacon(SHIP, 14)).toBe(true);
        expect(aisTargetIsDistressBeacon(SHIP, 15)).toBe(false);
        expect(aisTargetIsDistressBeacon(SHIP, 0)).toBe(false);
    });
});

describe("a message 14's text", () => {
    it("reads a beacon's own words", () => {
        expect(distressTextSignal('SART ACTIVE', SART)).toEqual({ state: 'active', kind: 'sart' });
        expect(distressTextSignal('MOB TEST', MOB)).toEqual({ state: 'test', kind: 'mob' });
        expect(distressTextSignal('epirb active', EPIRB)).toEqual({ state: 'active', kind: 'epirb' });
    });

    it('reads ACTIVE or TEST from any 97x MMSI, whatever the other words', () => {
        expect(distressTextSignal('ACTIVE', SART)).toEqual({ state: 'active', kind: null });
        expect(distressTextSignal('BEACON TEST 2', MOB)?.state).toBe('test');
    });

    it('takes TEST over ACTIVE when a text says both: a test never alarms', () => {
        expect(distressTextSignal('SART TEST ACTIVE', SART)?.state).toBe('test');
    });

    it("ignores an ordinary station's safety text, unless it names the beacon", () => {
        expect(distressTextSignal('FIRING RANGE ACTIVE', SHIP)).toBeNull();
        expect(distressTextSignal('RADIO CHECK TEST', SHIP)).toBeNull();
        expect(distressTextSignal('SART ACTIVE', SHIP)).toEqual({ state: 'active', kind: 'sart' });
        expect(distressTextSignal('', SART)).toBeNull();
        expect(distressTextSignal(undefined, SART)).toBeNull();
    });
});

describe('the fixtures the plan names', () => {
    it('status 15 heard before the message 14 never alarms: a test, then still a test', () => {
        const first = classifyDistress(evidence({ navStatus: 15, navStatusAt: T }));
        expect(first).toMatchObject({ kind: 'sart', state: 'test', sounds: false, positionKnown: true });
        const then = classifyDistress(
            evidence({ navStatus: 15, navStatusAt: T, safetyText: 'SART TEST', safetyTextAt: T + 30_000 }),
        );
        expect(then).toMatchObject({ state: 'test', sounds: false });
    });

    it("a message 14 alone alarms, as 'position not yet received'", () => {
        const c = classifyDistress({
            mmsi: SART,
            safetyText: 'SART ACTIVE',
            safetyTextAt: T,
            source: 'local',
            hasPosition: false,
        });
        expect(c).toMatchObject({ kind: 'sart', state: 'active', sounds: true, positionKnown: false });
    });

    it('a message 1 with status 14 alarms, from any MMSI', () => {
        expect(classifyDistress(evidence({ mmsi: MOB, navStatus: 14, navStatusAt: T }))).toMatchObject({
            kind: 'mob',
            state: 'active',
            sounds: true,
        });
        // ITU's status 14 is 'AIS-SART (active)': a beacon on an unexpected MMSI still counts.
        expect(classifyDistress(evidence({ mmsi: SHIP, navStatus: 14, navStatusAt: T }))).toMatchObject({
            kind: 'sart',
            state: 'active',
            sounds: true,
        });
    });

    it('an internet-only 970 does NOT sound: red and silent, relayed', () => {
        const c = classifyDistress(evidence({ navStatus: 14, navStatusAt: T, source: 'cloud' }));
        expect(c).toMatchObject({ state: 'active', sounds: false, relayed: true });
    });
});

describe('the rest of the rule', () => {
    it('a 97x with any other status is a visual caution, never a sound', () => {
        for (const navStatus of [0, 1, 5, 8, 13]) {
            const c = classifyDistress(evidence({ mmsi: EPIRB, navStatus, navStatusAt: T }));
            expect(c).toMatchObject({ kind: 'epirb', state: 'caution', sounds: false });
        }
    });

    it('an ordinary vessel is not a beacon: status 15, 0 or a stray ACTIVE text', () => {
        expect(classifyDistress(evidence({ mmsi: SHIP, navStatus: 15, navStatusAt: T }))).toBeNull();
        expect(classifyDistress(evidence({ mmsi: SHIP, navStatus: 0, navStatusAt: T }))).toBeNull();
        expect(
            classifyDistress(evidence({ mmsi: SHIP, navStatus: 0, safetyText: 'RANGE ACTIVE', safetyTextAt: T })),
        ).toBeNull();
    });

    it('test then active: the newer report decides, so the switch alarms at once', () => {
        const switched = classifyDistress(
            evidence({ navStatus: 14, navStatusAt: T + 60_000, safetyText: 'SART TEST', safetyTextAt: T }),
        );
        expect(switched).toMatchObject({ state: 'active', sounds: true });
        // And the other way: a newer TEST text over an older active report.
        const stood = classifyDistress(
            evidence({ navStatus: 14, navStatusAt: T, safetyText: 'SART TEST', safetyTextAt: T + 60_000 }),
        );
        expect(stood).toMatchObject({ state: 'test', sounds: false });
    });

    it('status 15 then an ACTIVE text alarms: the beacon said so last', () => {
        const c = classifyDistress(
            evidence({ navStatus: 15, navStatusAt: T, safetyText: 'SART ACTIVE', safetyTextAt: T + 5_000 }),
        );
        expect(c).toMatchObject({ state: 'active', sounds: true });
    });

    it('a beacon with neither status nor text yet (a static message only) is a caution', () => {
        expect(classifyDistress({ mmsi: MOB, source: 'local', hasPosition: false })).toMatchObject({
            state: 'caution',
            sounds: false,
            positionKnown: false,
        });
    });

    it('takes its kind from the MMSI first, then the words', () => {
        expect(classifyDistress(evidence({ mmsi: MOB, safetyText: 'SART ACTIVE', safetyTextAt: T }))?.kind).toBe('mob');
        expect(classifyDistress(evidence({ mmsi: SHIP, safetyText: 'EPIRB ACTIVE', safetyTextAt: T }))?.kind).toBe(
            'epirb',
        );
    });

    it('only real AIS is a beacon: an app-shared position never is', () => {
        expect(classifyDistress(evidence({ navStatus: 14, navStatusAt: T, source: 'app' }))).toBeNull();
        expect(classifyDistress(evidence({ navStatus: 14, navStatusAt: T, source: null }))).toBeNull();
    });
});
