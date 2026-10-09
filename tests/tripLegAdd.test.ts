/**
 * Adding leg 2, 3, 4… from any saved route or any leg of a past trip (126-16a;
 * Shane 2026-10-09: "it is very difficult to add a leg from a previous trip or
 * route, we need to be able to do that easily not just the first leg. but the
 * 2nd and 3rd and 4th etc.").
 *
 * services/tripLegAdd.ts decides, purely: which saved lines can become the
 * next leg from a place (and which way round), the copy that goes into the
 * tracer locked to the previous leg's arrival, and where an opened leg sits in
 * its trip. Fictional routes, worldwide: Banks Peninsula, the Atlantic, the
 * Arctic, the Ogasawara islands and Fiji across the antimeridian.
 */
import { describe, expect, it } from 'vitest';
import type { SavedTrace, TracePoint, TripGroup } from '../services/routeTracer';
import { groupTracesByTrip } from '../services/routeTracer';
import { LEG_JOIN_MAX_NM, addLegSections, legCopyForSlot, slotSeedForLeg, tripJoints } from '../services/tripLegAdd';

/** One degree of latitude in the app's great-circle NM (R = 3440.065 NM). */
const NM_PER_DEG_LAT = (3440.065 * Math.PI) / 180;
const north = (p: TracePoint, nm: number): TracePoint => ({ lat: p.lat + nm / NM_PER_DEG_LAT, lon: p.lon });

const LYTTELTON = { lat: -43.607, lon: 172.722 };
const PORT_LEVY = { lat: -43.641, lon: 172.83 };
const AKAROA = { lat: -43.806, lon: 172.968 };
const PIGEON_BAY = { lat: -43.68, lon: 172.9 };
const DIAMOND_HARBOUR = { lat: -43.627, lon: 172.738 };
const HORTA = { lat: 38.53, lon: -28.63 };

let stamp = 0;
function trace(
    id: string,
    name: string,
    points: TracePoint[],
    extra: Partial<SavedTrace> = {},
    createdAt = new Date(Date.UTC(2026, 8, 1) + stamp++ * 60_000).toISOString(),
): SavedTrace {
    return { id, name, createdAt, points: points.map((p) => ({ ...p })), ...extra };
}
const via = (a: TracePoint, b: TracePoint): TracePoint => ({
    lat: (a.lat + b.lat) / 2 + 0.004,
    lon: (a.lon + b.lon) / 2,
});
const line = (a: TracePoint, b: TracePoint): TracePoint[] => [{ ...a }, via(a, b), { ...b }];

describe('legCopyForSlot: the join rule, worldwide', () => {
    it('snaps a start 0.1 NM from the lock onto it, the rest identical', () => {
        const source = trace('x', 'Akaroa - Pigeon Bay', line(north(AKAROA, 0.1), PIGEON_BAY));
        const copy = legCopyForSlot(source, AKAROA, 'forward');
        if ('refused' in copy) throw new Error('refused');
        expect(copy.points).toHaveLength(source.points.length);
        expect(copy.points[0]).toEqual(AKAROA);
        expect(copy.points.slice(1)).toEqual(source.points.slice(1));
        expect(copy.join.kind).toBe('snap');
        expect(copy.join.nm).toBeCloseTo(0.1, 2);
        expect(copy.name).toBe('Akaroa - Pigeon Bay');
        expect(copy.destName).toBe('Pigeon Bay');
        expect(copy.sourceLabel).toBe('Akaroa - Pigeon Bay');
    });

    it('bridges a start 0.6 NM away with a joining run the check grades', () => {
        const source = trace('x', 'Akaroa - Pigeon Bay', line(north(AKAROA, 0.6), PIGEON_BAY));
        const copy = legCopyForSlot(source, AKAROA, 'forward');
        if ('refused' in copy) throw new Error('refused');
        expect(copy.points).toHaveLength(source.points.length + 1);
        expect(copy.points[0]).toEqual(AKAROA);
        expect(copy.points.slice(1)).toEqual(source.points);
        expect(copy.join).toMatchObject({ kind: 'run' });
        expect(copy.join.nm).toBeCloseTo(0.6, 2);
    });

    it(`refuses a start more than ${LEG_JOIN_MAX_NM} NM away, saying how far`, () => {
        const source = trace('x', 'Akaroa - Pigeon Bay', line(north(AKAROA, 2.3), PIGEON_BAY));
        const copy = legCopyForSlot(source, AKAROA, 'forward');
        expect(copy).toMatchObject({ refused: true });
        expect('refused' in copy && copy.gapNm).toBeCloseTo(2.3, 2);
    });

    it('joins across the antimeridian: Savusavu - Taveuni at 0.1 NM snaps', () => {
        const anchor = { lat: -16.8, lon: 179.999 };
        const source = trace('fj', 'Savusavu - Taveuni', [
            { lat: -16.8, lon: -179.999 },
            { lat: -16.78, lon: -179.95 },
            { lat: -16.75, lon: -179.9 },
        ]);
        const copy = legCopyForSlot(source, anchor, 'forward');
        if ('refused' in copy) throw new Error('refused across 180°');
        expect(copy.join.kind).toBe('snap');
        expect(copy.join.nm).toBeLessThan(0.25);
        expect(copy.points[0]).toEqual(anchor);
        expect(copy.points.slice(1)).toEqual(source.points.slice(1));
    });

    it("'reverse' runs the pins the other way, flips the name and keeps the join rule", () => {
        const source = trace('x', 'Pigeon Bay - Akaroa (3rd Leg)', line(PIGEON_BAY, north(AKAROA, 0.1)), {
            tripId: 'p',
            legOrdinal: 3,
        });
        const copy = legCopyForSlot(source, AKAROA, 'reverse');
        if ('refused' in copy) throw new Error('refused');
        expect(copy.points[0]).toEqual(AKAROA);
        expect(copy.points.slice(1)).toEqual([...source.points].reverse().slice(1));
        expect(copy.name).toBe('Akaroa - Pigeon Bay');
        expect(copy.sourceLabel).toBe('Pigeon Bay - Akaroa (Leg 3)');
        expect(copy.join.kind).toBe('snap');

        const run = legCopyForSlot({ ...source, points: line(PIGEON_BAY, north(AKAROA, 0.6)) }, AKAROA, 'reverse');
        expect('refused' in run ? run : run.join.kind).toBe('run');
        const far = legCopyForSlot({ ...source, points: line(PIGEON_BAY, north(AKAROA, 2.3)) }, AKAROA, 'reverse');
        expect(far).toMatchObject({ refused: true });
    });

    it('a copy carries the pins and a name only: no ids, no chain, no check, no evidence', () => {
        const source = trace('src', "St. John's (NL) - Horta (2nd Leg)", line({ lat: 47.56, lon: -52.71 }, HORTA), {
            tripId: 'trip-atlantic',
            legOrdinal: 2,
            destName: 'Horta',
            plannedRouteId: 'planned_fixture',
            passageVoyageId: '00000000-0000-4000-8000-000000000001',
            verification: { version: 1 } as unknown as SavedTrace['verification'],
            proposalEvidence: { kind: 'fixture' } as unknown as SavedTrace['proposalEvidence'],
        });
        const copy = legCopyForSlot(source, { lat: 47.56, lon: -52.71 }, 'forward');
        if ('refused' in copy) throw new Error('refused');
        for (const key of [
            'id',
            'tripId',
            'legOrdinal',
            'plannedRouteId',
            'passageVoyageId',
            'verification',
            'proposalEvidence',
        ]) {
            expect(copy, key).not.toHaveProperty(key);
        }
        for (const point of copy.points) expect(Object.keys(point).sort()).toEqual(['lat', 'lon']);
        // A non-badge bracket in a place name survives; the trip badge goes.
        expect(copy.name).toBe("St. John's (NL) - Horta");
    });

    it('refuses a copy that collapses to one place', () => {
        // Snapped onto the lock, a two-pin line that ends at it is one place.
        const source = trace('dot', 'Akaroa', [north(AKAROA, 0.1), { ...AKAROA }]);
        expect(legCopyForSlot(source, AKAROA, 'forward')).toMatchObject({ refused: true });
    });
});

/** A one-route trip ending at Akaroa, and a trip P whose leg 2 also ends there. */
function library() {
    const after = trace('z', 'Diamond Harbour - Akaroa', line(DIAMOND_HARBOUR, AKAROA));
    const twin = trace('z-twin', 'Akaroa - Diamond Harbour', [...after.points].reverse());
    const p1 = trace('p', 'Lyttelton - Port Levy (1st Leg)', line(LYTTELTON, PORT_LEVY), {
        tripId: 'p',
        legOrdinal: 1,
    });
    const p2 = trace('p-2', 'Port Levy - Akaroa (2nd Leg)', line(PORT_LEVY, north(AKAROA, 0.6)), {
        tripId: 'p',
        legOrdinal: 2,
    });
    const older = trace('a-old', 'Akaroa - Pigeon Bay', line(AKAROA, PIGEON_BAY));
    const newer = trace('a-new', 'Akaroa - Le Bons Bay', line(AKAROA, { lat: -43.75, lon: 173.1 }));
    const run = trace('a-run', 'Akaroa - Okains Bay', line(north(AKAROA, 0.6), { lat: -43.7, lon: 173.06 }));
    const nearEnd = trace('g', 'Little Akaloa - Duvauchelle', [north(AKAROA, 10), north(AKAROA, 6), north(AKAROA, 3)]);
    const cadiz = trace('cadiz', 'Cádiz → Funchal', line({ lat: 36.53, lon: -6.3 }, { lat: 32.64, lon: -16.91 }));
    const ogasawara = trace('bonin', '父島 - 母島', line({ lat: 27.09, lon: 142.19 }, { lat: 26.64, lon: 142.16 }));
    const arctic = trace('arctic', 'Tromsø - Skjervøy', line({ lat: 69.65, lon: 18.96 }, { lat: 70.03, lon: 20.97 }));
    const lonePin = { ...trace('pin', 'Akaroa pin', [AKAROA]) };
    const traces = [after, twin, p1, p2, older, newer, run, nearEnd, cadiz, ogasawara, arctic, lonePin];
    return { traces, after, twin, p1, p2, older, newer, run, nearEnd, cadiz, ogasawara, arctic };
}

describe('addLegSections: what can be the next leg from here', () => {
    it('excludes the previous leg, its exact reverse twin and rows without a line', () => {
        const { traces } = library();
        const s = addLegSections(traces, traces[0]);
        const ids = [...s.startsHere, ...s.endsHere, ...s.furtherAway].map((row) => row.trace.id);
        expect(ids).not.toContain('z');
        expect(ids).not.toContain('z-twin');
        expect(ids).not.toContain('pin');
    });

    it('starts here: forward rows by gap, then newest; ends here: the other way round', () => {
        const { traces, after } = library();
        const s = addLegSections(traces, after);
        expect(s.startsHere.map((row) => row.trace.id)).toEqual(['a-new', 'a-old', 'a-run']);
        expect(s.startsHere.every((row) => row.direction === 'forward')).toBe(true);
        expect(s.startsHere.map((row) => row.join?.kind)).toEqual(['snap', 'snap', 'run']);
        expect(s.startsHere[2].gapNm).toBeCloseTo(0.6, 2);
        expect(s.endsHere.map((row) => [row.trace.id, row.direction, row.join?.kind])).toEqual([
            ['p-2', 'reverse', 'run'],
        ]);
    });

    it('says where each row comes from: your saved route, or leg N of its trip', () => {
        const { traces, after } = library();
        const s = addLegSections(traces, after);
        expect(s.startsHere[0].sourceText).toBe('your saved route');
        expect(s.endsHere[0].sourceText).toBe('leg 2 of Lyttelton - Akaroa');
        expect(s.furtherAway.find((row) => row.trace.id === 'p')?.sourceText).toBe('leg 1 of Lyttelton - Akaroa');
    });

    it('further away shows the nearer end and its gap, nearest first, at most 20', () => {
        const { traces, after } = library();
        const s = addLegSections(traces, after);
        const g = s.furtherAway[0];
        expect(g.trace.id).toBe('g');
        expect(g.direction).toBe('reverse');
        expect(g.gapNm).toBeCloseTo(3, 1);
        expect(g.join).toBeNull();
        for (let i = 1; i < s.furtherAway.length; i++) {
            expect(s.furtherAway[i].gapNm).toBeGreaterThanOrEqual(s.furtherAway[i - 1].gapNm);
        }
        const many = Array.from({ length: 30 }, (_, i) =>
            trace(`far-${i}`, `Far ${i} - Away`, line(north(AKAROA, 5 + i), north(AKAROA, 40 + i))),
        );
        expect(addLegSections([...traces, ...many], after).furtherAway).toHaveLength(20);
    });

    it('search folds accents and case, and reads the trip label too', () => {
        const { traces, after } = library();
        const all = (query: string) => {
            const s = addLegSections(traces, after, query);
            return [...s.startsHere, ...s.endsHere, ...s.furtherAway].map((row) => row.trace.id);
        };
        expect(all('cadiz')).toEqual(['cadiz']);
        expect(all('CÁDIZ')).toEqual(['cadiz']);
        expect(all('母島')).toEqual(['bonin']);
        expect(all('tromso')).toEqual(['arctic']);
        // "Lyttelton - Akaroa" is trip P's label: both its legs match.
        expect(all('lyttelton - akaroa').sort()).toEqual(['p', 'p-2']);
        expect(all('nowhere at all')).toEqual([]);
    });
});

describe('slotSeedForLeg: an opened leg keeps its place in the trip', () => {
    const p1 = trace('p', 'Lyttelton - Port Levy (1st Leg)', line(LYTTELTON, PORT_LEVY), {
        tripId: 'p',
        legOrdinal: 1,
    });
    const p2 = trace('p-2', 'Port Levy - Akaroa (2nd Leg)', line(PORT_LEVY, AKAROA), {
        tripId: 'p',
        legOrdinal: 2,
        destName: 'Akaroa',
    });

    it('a welded leg 3 is locked at leg 2’s end', () => {
        const p3 = trace('p-3', 'Akaroa - Pigeon Bay (3rd Leg)', line(AKAROA, PIGEON_BAY), {
            tripId: 'p',
            legOrdinal: 3,
        });
        expect(slotSeedForLeg([p1, p2, p3], p3)).toEqual({
            tripId: 'p',
            ordinal: 3,
            fromName: 'Akaroa',
            anchor: p2.points[2],
        });
    });

    it('a leg that starts 0.9 NM off keeps its own first pin, so nothing moves', () => {
        const start = north(AKAROA, 0.9);
        const p3 = trace('p-3', 'Akaroa - Pigeon Bay (3rd Leg)', line(start, PIGEON_BAY), {
            tripId: 'p',
            legOrdinal: 3,
        });
        expect(slotSeedForLeg([p1, p2, p3], p3)).toEqual({
            tripId: 'p',
            ordinal: 3,
            fromName: 'Akaroa',
            anchor: start,
        });
    });

    it('leg 1, a standalone route, and a leg whose previous leg is gone are opened free', () => {
        const p3 = trace('p-3', 'Akaroa - Pigeon Bay (3rd Leg)', line(AKAROA, PIGEON_BAY), {
            tripId: 'p',
            legOrdinal: 3,
        });
        expect(slotSeedForLeg([p1, p2, p3], p1)).toBeNull();
        const solo = trace('solo', 'Tromsø - Skjervøy', line({ lat: 69.65, lon: 18.96 }, { lat: 70.03, lon: 20.97 }));
        expect(slotSeedForLeg([solo], solo)).toBeNull();
        expect(slotSeedForLeg([p1, p3], p3)).toBeNull();
    });
});

describe('tripJoints', () => {
    it('gives the gap at each joint in NM', () => {
        const p1 = trace('p', 'Lyttelton - Port Levy (1st Leg)', line(LYTTELTON, PORT_LEVY), {
            tripId: 'p',
            legOrdinal: 1,
        });
        const p2 = trace('p-2', 'Port Levy - Akaroa (2nd Leg)', line(PORT_LEVY, AKAROA), {
            tripId: 'p',
            legOrdinal: 2,
        });
        const p3 = trace('p-3', 'Akaroa - Pigeon Bay (3rd Leg)', line(north(AKAROA, 0.9), PIGEON_BAY), {
            tripId: 'p',
            legOrdinal: 3,
        });
        const group: TripGroup = groupTracesByTrip([p1, p2, p3])[0];
        const joints = tripJoints(group);
        expect(joints).toHaveLength(2);
        expect(joints[0]).toBe(0);
        expect(joints[1]).toBeCloseTo(0.9, 2);
        expect(tripJoints(groupTracesByTrip([p1])[0])).toEqual([]);
    });
});
