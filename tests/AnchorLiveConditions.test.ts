/**
 * The boat's live depth and wind in the anchor broadcast (126-05's `live`
 * block), read for the shore screen (126-03a): bounded and age-checked.
 *
 * Missing or junk values read as unknown, never 0: a stale sounder figure or a
 * dropped wind field must not read as "now" or as calm water.
 */
import { describe, expect, it } from 'vitest';
import {
    ANCHOR_LIVE_KEYS,
    LIVE_MAX_AGE_MS,
    LIVE_SHOW_AGE_MS,
    liveAgeWords,
    readAnchorLiveConditions,
    type AnchorLiveWire,
} from '../services/anchorLiveConditions';
import { readLiveConditions } from '../pi-cache/src/anchorBroadcaster';

const NOW = Date.UTC(2026, 9, 10, 2, 0, 0);
const NONE = { depth: null, tws: null, twd: null };

describe('readAnchorLiveConditions', () => {
    it('names the seven wire keys 126-05 writes', () => {
        expect([...ANCHOR_LIVE_KEYS].sort()).toEqual(
            ['depthAt', 'depthM', 'depthReference', 'twdAt', 'twdDeg', 'twsAt', 'twsKn'].sort(),
        );
    });

    it.each([undefined, null, {}, 'live', 42, []])('reads %j as nothing known', (live) => {
        expect(readAnchorLiveConditions(live, NOW)).toEqual(NONE);
    });

    it('reads fresh values with their own times and ages', () => {
        const read = readAnchorLiveConditions(
            {
                depthM: 3.2,
                depthReference: 'below-keel',
                depthAt: NOW - 8_000,
                twsKn: 18,
                twsAt: NOW - 5_000,
                twdDeg: 135,
                twdAt: NOW - 40_000,
            },
            NOW,
        );
        expect(read.depth).toEqual({ value: 3.2, at: NOW - 8_000, ageMs: 8_000, reference: 'below-keel' });
        expect(read.tws).toEqual({ value: 18, at: NOW - 5_000, ageMs: 5_000 });
        expect(read.twd).toEqual({ value: 135, at: NOW - 40_000, ageMs: 40_000 });
    });

    it('keeps a real zero apart from a missing value', () => {
        const read = readAnchorLiveConditions({ depthM: 0, depthAt: NOW, twsKn: 0, twsAt: NOW }, NOW);
        expect(read.depth?.value).toBe(0);
        expect(read.tws?.value).toBe(0);
        expect(read.twd).toBeNull();
    });

    it('a value without its own time is unknown: it cannot be aged', () => {
        expect(readAnchorLiveConditions({ depthM: 4, twsKn: 12, twdDeg: 90 }, NOW)).toEqual(NONE);
    });

    it.each([
        ['depth not a number', { depthM: Number.NaN, depthAt: NOW }, 'depth'],
        ['depth as text', { depthM: '4.0', depthAt: NOW }, 'depth'],
        ['depth deeper than any sea', { depthM: 12_000, depthAt: NOW }, 'depth'],
        ['depth far above the keel', { depthM: -20, depthAt: NOW }, 'depth'],
        ['negative wind speed', { twsKn: -3, twsAt: NOW }, 'tws'],
        ['wind speed past any storm', { twsKn: 400, twsAt: NOW }, 'tws'],
        ['infinite wind speed', { twsKn: Number.POSITIVE_INFINITY, twsAt: NOW }, 'tws'],
        ['a direction past 360°', { twdDeg: 400, twdAt: NOW }, 'twd'],
        ['a negative direction', { twdDeg: -10, twdAt: NOW }, 'twd'],
        ['a time from a clock a minute fast', { twsKn: 10, twsAt: NOW + 60_000 }, 'tws'],
        ['a time that is not a number', { twsKn: 10, twsAt: Number.NaN }, 'tws'],
    ] as const)('%s reads as unknown', (_label, live, key) => {
        expect(readAnchorLiveConditions(live, NOW)[key]).toBeNull();
    });

    it('keeps a keel in the mud: a little below zero is a reading, not junk', () => {
        const read = readAnchorLiveConditions({ depthM: -0.4, depthReference: 'below-keel', depthAt: NOW }, NOW);
        expect(read.depth?.value).toBe(-0.4);
    });

    it('turns 360° into 000°', () => {
        expect(readAnchorLiveConditions({ twdDeg: 360, twdAt: NOW }, NOW).twd?.value).toBe(0);
    });

    it(`drops a value older than ${LIVE_MAX_AGE_MS / 60_000} minutes`, () => {
        expect(LIVE_MAX_AGE_MS).toBe(15 * 60_000);
        const stale = { depthM: 5, depthAt: NOW - 16 * 60_000, twsKn: 9, twsAt: NOW - 14 * 60_000 };
        const read = readAnchorLiveConditions(stale, NOW);
        expect(read.depth).toBeNull();
        expect(read.tws?.ageMs).toBe(14 * 60_000);
    });

    it.each([
        ['below-keel', 'below-keel'],
        ['below-transducer', 'below-transducer'],
        ['below-waterline', 'below-surface'],
        ['below-surface', 'below-surface'],
        ['sideways', null],
        [undefined, null],
    ] as const)('reads the depth reference %s as %s', (depthReference, expected) => {
        const read = readAnchorLiveConditions({ depthM: 6, depthReference, depthAt: NOW }, NOW);
        expect(read.depth?.reference).toBe(expected);
    });
});

describe('liveAgeWords', () => {
    it(`says nothing up to ${LIVE_SHOW_AGE_MS / 60_000} minutes old, then the minutes`, () => {
        expect(LIVE_SHOW_AGE_MS).toBe(2 * 60_000);
        expect(liveAgeWords(90_000)).toBeNull();
        expect(liveAgeWords(2 * 60_000)).toBeNull();
        expect(liveAgeWords(5 * 60_000)).toBe('5 min ago');
        expect(liveAgeWords(5 * 60_000 + 59_000)).toBe('5 min ago');
    });
});

describe("the Pi's own live block reads back through this reader (126-05)", () => {
    const at = (agoMs: number) => new Date(NOW - agoMs).toISOString();
    const leaf = (value: unknown, agoMs: number) => ({ value, $source: 'fictional-bus.7', timestamp: at(agoMs) });

    it('every key the Pi writes is a wire key, and every value reads back with its own time', () => {
        // A fictional boat at anchor in Chesapeake Bay, as Signal K files her (SI units).
        const doc = {
            environment: {
                depth: {
                    belowTransducer: leaf(3.7, 4_000),
                    transducerToKeel: leaf(1.1, 4_000),
                    belowKeel: leaf(2.6, 4_000),
                },
                wind: { speedTrue: leaf(5.1, 3_000), directionTrue: leaf(0.7854, 9_000) },
            },
        };
        const live = readLiveConditions(doc, NOW);
        expect(live).toBeDefined();
        // The Pi's shape is the phone's wire shape (a compile-time check as well).
        const wire: AnchorLiveWire = live!;
        expect(Object.keys(wire).sort()).toEqual([...ANCHOR_LIVE_KEYS].sort());
        const read = readAnchorLiveConditions(wire, NOW);
        expect(read.depth).toEqual({ value: 2.6, at: NOW - 4_000, ageMs: 4_000, reference: 'below-keel' });
        expect(read.tws).toEqual({ value: 9.9, at: NOW - 3_000, ageMs: 3_000 }); // 5.1 m/s
        expect(read.twd).toEqual({ value: 45, at: NOW - 9_000, ageMs: 9_000 });
    });

    it("the Pi's below-the-waterline depth reads ashore as below the surface", () => {
        const live = readLiveConditions({ environment: { depth: { belowSurface: leaf(11.2, 2_000) } } }, NOW);
        expect(readAnchorLiveConditions(live, NOW).depth).toEqual({
            value: 11.2,
            at: NOW - 2_000,
            ageMs: 2_000,
            reference: 'below-surface',
        });
    });

    it('nothing fresh on the Pi is nothing known ashore, never a zero', () => {
        const stale = {
            environment: {
                depth: { belowKeel: leaf(2.6, 30_000) },
                wind: { speedTrue: leaf(5.1, 25_000), directionTrue: leaf(0.7854, 90_000) },
            },
        };
        const live = readLiveConditions(stale, NOW);
        expect(live).toBeUndefined();
        expect(readAnchorLiveConditions(live, NOW)).toEqual(NONE);
    });
});
