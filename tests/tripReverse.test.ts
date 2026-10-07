/**
 * Reversing legs and trips (Shane 2026-10-07: "i can reverse the first leg.
 * but i cannot reverse the 2nd leg and so on"). Pure decisions only — the
 * storage-backed sequences live in tripLegs.test.ts and
 * useReturnTripFlow.test.ts. Fictional places throughout.
 */
import { describe, expect, it } from 'vitest';
import { reversedLegName, reverseRouteName, stripRouteBadges } from '../services/routeNameParts';
import type { NextLegSeed, SavedTrace } from '../services/routeTracer';
import {
    REVERSE_JOIN_NM,
    activeReversalNote,
    describeReversalSource,
    followedSavedRouteIds,
    isReversalOf,
    overwriteBlockReason,
    parseReturnPlan,
    returnTripOrder,
    reversalNote,
    reversedLegForSlot,
    slotCandidates,
    findTripGroup,
    previousLegFor,
} from '../services/tripReverse';

const HARBOUR = { lat: -30.0, lon: 160.0 };
const BAY_POINT = { lat: -29.9, lon: 160.1 };
const SANDY_COVE = { lat: -29.8, lon: 160.2 };
const CAPE_GREY = { lat: -29.7, lon: 160.3 };
/** ~0.1 NM north of a point: inside the 0.25 NM join. */
const near = (p: { lat: number; lon: number }, nm: number) => ({ lat: p.lat + nm / 60, lon: p.lon });
const mid = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => ({
    lat: (a.lat + b.lat) / 2 + 0.003,
    lon: (a.lon + b.lon) / 2,
});

function leg(
    id: string,
    name: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    chain?: { tripId: string; legOrdinal: number },
    extra: Partial<SavedTrace> = {},
): SavedTrace {
    return {
        id,
        name,
        createdAt: '2026-10-01T00:00:00.000Z',
        points: [{ ...from }, mid(from, to), { ...to }],
        ...(chain ?? {}),
        ...extra,
    };
}

const OUTBOUND: SavedTrace[] = [
    leg('trip-out', 'Harbour - Bay Point (1st Leg)', HARBOUR, BAY_POINT, { tripId: 'trip-out', legOrdinal: 1 }),
    leg('out-2', 'Bay Point - Sandy Cove (2nd Leg)', BAY_POINT, SANDY_COVE, { tripId: 'trip-out', legOrdinal: 2 }),
    leg('out-3', 'Sandy Cove - Cape Grey (3rd Leg)', SANDY_COVE, CAPE_GREY, { tripId: 'trip-out', legOrdinal: 3 }),
];

describe('reversed names lose their trip badges', () => {
    it('flips the places and strips every badge the app writes', () => {
        expect(reversedLegName('Bay Point - Sandy Cove (2nd Leg)')).toBe('Sandy Cove - Bay Point');
        expect(reversedLegName('Harbour - Cape Grey (Passage)')).toBe('Cape Grey - Harbour');
        expect(reversedLegName('Harbour - Cape Grey (3 legs)')).toBe('Cape Grey - Harbour');
        expect(reversedLegName('Harbour → Bay Point (Leg 1)')).toBe('Bay Point → Harbour');
        expect(stripRouteBadges('Harbour - Cape Grey (Passage) (2nd Leg)')).toBe('Harbour - Cape Grey');
        // reverseRouteName itself still keeps a badge (a pure string flip).
        expect(reverseRouteName('Bay Point - Sandy Cove (2nd Leg)')).toBe('Sandy Cove - Bay Point (2nd Leg)');
    });

    it('works for names outside English and for titles with no separator', () => {
        expect(reversedLegName('Nouméa - Île des Pins (2nd Leg)')).toBe('Île des Pins - Nouméa');
        expect(reversedLegName('横浜 → 館山 (3rd Leg)')).toBe('館山 → 横浜');
        expect(reversedLegName('Ålesund – Geiranger (2nd Leg)')).toBe('Geiranger – Ålesund');
        // No separator: the skipper's words survive, but never the badge.
        expect(reversedLegName('Bay run (2nd Leg)')).toBe('Bay run');
        expect(reversedLegName("Tour de l'île (2nd Leg)")).toBe("Tour de l'île");
        expect(reversedLegName('Our winter holiday')).toBe('Our winter holiday');
    });
});

describe('return-trip order', () => {
    const group = findTripGroup(OUTBOUND, 'trip-out')!;

    it('comes home from the last leg by default, leg 1 last', () => {
        expect(returnTripOrder(group)).toEqual(['out-3', 'out-2', 'trip-out']);
    });

    it('starts from any leg and clamps out-of-range positions', () => {
        expect(returnTripOrder(group, 2)).toEqual(['out-2', 'trip-out']);
        expect(returnTripOrder(group, 1)).toEqual(['trip-out']);
        expect(returnTripOrder(group, 99)).toEqual(['out-3', 'out-2', 'trip-out']);
        expect(returnTripOrder(group, 0)).toEqual(['trip-out']);
    });

    it('finds the trip by its key or by any leg id', () => {
        expect(findTripGroup(OUTBOUND, 'out-2')?.key).toBe('trip-out');
        expect(findTripGroup(OUTBOUND, 'nope')).toBeNull();
    });
});

describe('filling a locked-start slot with a saved leg, reversed', () => {
    // A return trip's leg 1 (Cape Grey → Sandy Cove) is saved; leg 2 departs
    // Sandy Cove with its first pin locked there.
    const returnLeg1 = leg('ret-1', 'Cape Grey - Sandy Cove', CAPE_GREY, SANDY_COVE);
    const seed: NextLegSeed = { tripId: 'ret-1', ordinal: 2, fromName: 'Sandy Cove', anchor: SANDY_COVE };
    const traces = [returnLeg1, ...OUTBOUND];

    it('offers legs that ARRIVE at the locked start, the reversed trip first', () => {
        const otherTrip = leg('elsewhere', 'Reef Gap - Sandy Cove', CAPE_GREY, near(SANDY_COVE, 0.1), {
            tripId: 'trip-other',
            legOrdinal: 2,
        });
        const previous = previousLegFor([...traces, otherTrip], seed);
        expect(previous?.id).toBe('ret-1');
        const picks = slotCandidates([otherTrip, ...traces], SANDY_COVE, {
            previousLeg: previous,
            preferTripId: 'trip-out',
        });
        // out-2 arrives at Sandy Cove; ret-1 is the previous leg; out-3 leaves it.
        expect(picks.map((t) => t.id)).toEqual(['out-2', 'elsewhere']);
    });

    it('never offers the previous leg or its exact reverse twin', () => {
        const loop = leg('loop', 'Sandy Cove loop', SANDY_COVE, SANDY_COVE);
        const twin: SavedTrace = { ...loop, id: 'loop-twin', points: [...loop.points].reverse() };
        const loopSeed: NextLegSeed = { tripId: 'loop', ordinal: 2, fromName: 'Sandy Cove', anchor: SANDY_COVE };
        const picks = slotCandidates([loop, twin, OUTBOUND[1]], SANDY_COVE, {
            previousLeg: previousLegFor([loop, twin], loopSeed),
        });
        expect(picks.map((t) => t.id)).toEqual(['out-2']);
    });

    it('ignores legs that end further than the join distance away', () => {
        const far = leg('far', 'Harbour - Off Sandy Cove', HARBOUR, near(SANDY_COVE, REVERSE_JOIN_NM + 0.1));
        expect(slotCandidates([far], SANDY_COVE)).toEqual([]);
    });

    it('drops the leg in reversed with pin 0 moved onto the exact anchor', () => {
        const nudged = { ...OUTBOUND[1], points: [BAY_POINT, mid(BAY_POINT, SANDY_COVE), near(SANDY_COVE, 0.1)] };
        const slot = reversedLegForSlot(nudged, SANDY_COVE)!;
        expect(slot.points[0]).toEqual(SANDY_COVE);
        expect(slot.points.slice(1)).toEqual([mid(BAY_POINT, SANDY_COVE), BAY_POINT]);
        expect(slot.name).toBe('Sandy Cove - Bay Point');
        expect(slot.destName).toBe('Bay Point');
        expect(slot.sourceLabel).toBe('Bay Point - Sandy Cove (Leg 2)');
        // The source row is not touched.
        expect(nudged.points[2]).toEqual(near(SANDY_COVE, 0.1));
    });

    it('refuses a leg that does not reach the anchor, and never carries a check or Auto evidence', () => {
        expect(reversedLegForSlot(OUTBOUND[2], SANDY_COVE)).toBeNull();
        const checked = {
            ...OUTBOUND[1],
            verification: { schemaVersion: 1 } as unknown as SavedTrace['verification'],
            proposalEvidence: { schemaVersion: 1 } as unknown as SavedTrace['proposalEvidence'],
        };
        const slot = reversedLegForSlot(checked, SANDY_COVE)!;
        expect(Object.keys(slot).sort()).toEqual(['destName', 'name', 'points', 'sourceLabel']);
    });
});

describe('the reversal note', () => {
    it('says what to check that the grader does not read, while the line still arrives there', () => {
        const mark = { label: 'Bay Point - Sandy Cove (Leg 2)', end: BAY_POINT };
        const line = [SANDY_COVE, mid(SANDY_COVE, BAY_POINT), BAY_POINT];
        expect(activeReversalNote(line, mark)).toBe(
            'Reversed from Bay Point - Sandy Cove (Leg 2) — check traffic lanes, tidal gates and lights for this direction',
        );
        expect(reversalNote('X')).toMatch(/traffic lanes, tidal gates and lights/);
        // Undo past it, or a different ending: no note.
        expect(activeReversalNote([SANDY_COVE], mark)).toBeNull();
        expect(activeReversalNote([SANDY_COVE, CAPE_GREY], mark)).toBeNull();
        expect(activeReversalNote(line, null)).toBeNull();
    });
});

describe('describing what was reversed', () => {
    it('names the leg and says the outbound trip is unchanged', () => {
        expect(describeReversalSource(OUTBOUND, OUTBOUND[1].points)).toEqual({
            label: 'Bay Point - Sandy Cove (Leg 2)',
            unchanged: 'Leg 2 of Harbour - Cape Grey is unchanged',
        });
    });

    it('names a standalone route and a passage rollup', () => {
        const solo = leg('solo', 'Marina - Island Anchorage', HARBOUR, CAPE_GREY);
        expect(describeReversalSource([solo], solo.points)?.unchanged).toBe('Marina - Island Anchorage is unchanged');
        const stitched = [HARBOUR, mid(HARBOUR, BAY_POINT), BAY_POINT, mid(BAY_POINT, SANDY_COVE), SANDY_COVE];
        stitched.push(mid(SANDY_COVE, CAPE_GREY), CAPE_GREY);
        expect(describeReversalSource(OUTBOUND, stitched)).toEqual({
            label: 'Harbour - Cape Grey (Passage)',
            unchanged: 'the 3 legs of Harbour - Cape Grey are unchanged',
        });
        expect(describeReversalSource(OUTBOUND, [HARBOUR, CAPE_GREY])).toBeNull();
    });
});

describe('overwrite refusals', () => {
    const reversed = (t: SavedTrace) => [...t.points].reverse();

    it('isReversalOf: ends swapped; a loop is decided by its second pin', () => {
        expect(isReversalOf(reversed(OUTBOUND[1]), OUTBOUND[1].points)).toBe(true);
        expect(isReversalOf(OUTBOUND[1].points, OUTBOUND[1].points)).toBe(false);
        const loop = [SANDY_COVE, BAY_POINT, CAPE_GREY, SANDY_COVE];
        expect(isReversalOf([...loop].reverse(), loop)).toBe(true);
        expect(isReversalOf(loop, loop)).toBe(false);
    });

    it('refuses to overwrite a trip leg with its own reversal (separator-less and non-English names)', () => {
        for (const name of ['Bay run (2nd Leg)', "Tour de l'île (2nd Leg)", '湾内クルーズ (2nd Leg)']) {
            const stored = { ...OUTBOUND[1], name };
            expect(overwriteBlockReason(stored, reversed(stored))).toBe(
                `That's ${name.replace(' (2nd Leg)', '')} reversed — give the return run its own name`,
            );
        }
        // Badge-only legs (the cloud shed tripId) count as trip legs.
        const shed = { ...OUTBOUND[1], tripId: undefined, legOrdinal: undefined, name: 'Bay run (2nd Leg)' };
        expect(overwriteBlockReason(shed, reversed(shed))).toMatch(/reversed/);
    });

    it('refuses to overwrite the followed route with its reversal', () => {
        const solo = leg('solo', 'Bay run', HARBOUR, CAPE_GREY, undefined, { plannedRouteId: 'planned-solo' });
        expect(overwriteBlockReason(solo, reversed(solo))).toBeNull();
        const followed = followedSavedRouteIds([solo], {
            isFollowing: true,
            voyageId: 'planned-solo',
            routeCoords: [],
        });
        expect([...followed]).toEqual(['solo']);
        expect(overwriteBlockReason(solo, reversed(solo), { followedIds: followed })).toMatch(
            /^That's Bay run reversed/,
        );
        // Matched by the followed line itself when no mirror id is known.
        expect([
            ...followedSavedRouteIds([solo], { isFollowing: true, voyageId: null, routeCoords: solo.points }),
        ]).toEqual(['solo']);
        expect(followedSavedRouteIds([solo], { isFollowing: false, voyageId: null, routeCoords: [] }).size).toBe(0);
    });

    it('still allows an ordinary edit of an opened leg to overwrite it in place', () => {
        const edited = [...OUTBOUND[1].points];
        edited[1] = { lat: edited[1].lat + 0.001, lon: edited[1].lon };
        expect(overwriteBlockReason(OUTBOUND[1], edited)).toBeNull();
    });

    it('a chained draft may only overwrite this leg of this trip', () => {
        const seed: NextLegSeed = { tripId: 'ret-1', ordinal: 2, fromName: 'Sandy Cove', anchor: SANDY_COVE };
        const draft = [SANDY_COVE, mid(SANDY_COVE, BAY_POINT), near(BAY_POINT, 0.1)];
        expect(overwriteBlockReason(OUTBOUND[1], draft, { anchor: seed })).toBe(
            'Bay Point - Sandy Cove (2nd Leg) is leg 2 of another trip — give this leg its own name',
        );
        const ownLeg = leg('ret-2', 'Sandy Cove - Bay Point (2nd Leg)', SANDY_COVE, BAY_POINT, {
            tripId: 'ret-1',
            legOrdinal: 2,
        });
        expect(overwriteBlockReason(ownLeg, draft, { anchor: seed })).toBeNull();
        const ownLeg1 = leg('ret-1', 'Cape Grey - Sandy Cove (1st Leg)', CAPE_GREY, SANDY_COVE, {
            tripId: 'ret-1',
            legOrdinal: 1,
        });
        expect(overwriteBlockReason(ownLeg1, draft, { anchor: seed })).toMatch(/is leg 1 of this trip/);
    });
});

describe('return plan storage contract', () => {
    const plan = {
        sourceTripId: 'trip-out',
        sourceLabel: 'Harbour - Cape Grey',
        sourceLegIds: ['out-3', 'out-2', 'trip-out'],
        nextIndex: 1,
        chainFromId: null,
    };

    it('round-trips a valid cursor and rejects damaged ones', () => {
        expect(parseReturnPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
        expect(parseReturnPlan({ ...plan, chainFromId: 'ret-1', nextIndex: 2 })).toMatchObject({ nextIndex: 2 });
        expect(parseReturnPlan({ ...plan, nextIndex: 0 })).toBeNull();
        expect(parseReturnPlan({ ...plan, nextIndex: 4 })).toBeNull();
        expect(parseReturnPlan({ ...plan, sourceLegIds: ['only-one'] })).toBeNull();
        expect(parseReturnPlan({ ...plan, chainFromId: 42 })).toBeNull();
        expect(parseReturnPlan(null)).toBeNull();
    });
});
