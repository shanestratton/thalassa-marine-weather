import { describe, expect, it } from 'vitest';
import {
    nearestTrialWaypoint,
    MAX_TRIAL_WAYPOINT_HIT_CANDIDATES,
    type TrialWaypointHitCandidate,
} from '../services/autoroutingWaypointHit';

const tap = { x: 100, y: 200 };
const candidate = (index: number, dx = 0, dy = 0): TrialWaypointHitCandidate => ({
    index,
    x: tap.x + dx,
    y: tap.y + dy,
});

describe('nearest trial display-waypoint hit', () => {
    it('chooses the nearest centre, not whichever rendered feature was listed first', () => {
        const candidates = [candidate(0, 20), candidate(2, 3, 4), candidate(1, 9)];
        expect(nearestTrialWaypoint(candidates, tap, 3)).toBe(2);
        expect(nearestTrialWaypoint([...candidates].reverse(), tap, 3)).toBe(2);
    });

    it('includes the 22 px boundary and rejects points just outside the 44 px target', () => {
        expect(nearestTrialWaypoint([candidate(1, 22)], tap, 3)).toBe(1);
        expect(nearestTrialWaypoint([candidate(1, -22)], tap, 3)).toBe(1);
        expect(nearestTrialWaypoint([candidate(1, 0, 22)], tap, 3)).toBe(1);
        expect(nearestTrialWaypoint([candidate(1, 22.000001)], tap, 3)).toBeNull();
        expect(nearestTrialWaypoint([candidate(1, 0, -22.000001)], tap, 3)).toBeNull();
    });

    it('uses a circular distance, not the bounding query square', () => {
        expect(nearestTrialWaypoint([candidate(1, 21, 21)], tap, 3)).toBeNull();
        expect(nearestTrialWaypoint([candidate(1, 13.2, 17.6)], tap, 3)).toBe(1);
    });

    it('breaks exact ties by lowest display index, including duplicate world/tile features', () => {
        const candidates = [candidate(3, 3, 4), candidate(1, -3, -4), candidate(1, 3, 4), candidate(2, -3, 4)];
        expect(nearestTrialWaypoint(candidates, tap, 4)).toBe(1);
        expect(nearestTrialWaypoint([...candidates].reverse(), tap, 4)).toBe(1);
        expect(nearestTrialWaypoint([candidate(3, 22), candidate(0, -22)], tap, 4)).toBe(0);
    });

    it('respects an explicit radius without making the default target larger', () => {
        expect(nearestTrialWaypoint([candidate(1, 30)], tap, 3)).toBeNull();
        expect(nearestTrialWaypoint([candidate(1, 30)], tap, 3, 30)).toBe(1);
        expect(nearestTrialWaypoint([candidate(1, 10.01)], tap, 3, 10)).toBeNull();
    });

    it('accepts valid zero-based endpoints without making editing decisions', () => {
        expect(nearestTrialWaypoint([candidate(0)], tap, 3)).toBe(0);
        expect(nearestTrialWaypoint([candidate(2)], tap, 3)).toBe(2);
        expect(nearestTrialWaypoint([candidate(-0)], tap, 3)).toBe(0);
    });

    it('ignores malformed/out-of-range candidates without hiding a valid nearby pin', () => {
        const candidates = [
            candidate(-1),
            candidate(3),
            candidate(0.5),
            candidate(NaN),
            candidate(Infinity),
            { index: 0, x: NaN, y: 200 },
            { index: 0, x: 100, y: Infinity },
            { index: '0', x: 100, y: 200 },
            { index: 0, x: '100', y: 200 },
            { number: 1, x: 100, y: 200 },
            {},
            null,
            undefined,
            candidate(2, 10),
        ] as unknown as TrialWaypointHitCandidate[];
        expect(nearestTrialWaypoint(candidates, tap, 3)).toBe(2);
        expect(nearestTrialWaypoint(candidates.slice(0, -1), tap, 3)).toBeNull();
    });

    it('never treats another chart feature or one-based number as an implicit waypoint index', () => {
        const features = [
            { properties: { number: 1 }, geometry: { type: 'Point', coordinates: [153, -27] } },
            { number: 1, x: tap.x, y: tap.y },
            { id: 0, x: tap.x, y: tap.y },
        ] as unknown as TrialWaypointHitCandidate[];
        expect(nearestTrialWaypoint(features, tap, 3)).toBeNull();
    });

    it.each([
        { point: { x: NaN, y: 0 } },
        { point: { x: 0, y: Infinity } },
        { point: { x: '100', y: 200 } },
        { point: null },
        { point: {} },
    ])('rejects invalid tap $point', ({ point }) => {
        expect(nearestTrialWaypoint([candidate(0)], point as { x: number; y: number }, 3)).toBeNull();
    });

    it.each([0, -1, 0.5, NaN, Infinity, 10_001])('rejects invalid waypoint count %s', (count) => {
        expect(nearestTrialWaypoint([candidate(0)], tap, count)).toBeNull();
    });

    it.each([0, -1, NaN, Infinity])('rejects invalid radius %s', (radius) => {
        expect(nearestTrialWaypoint([candidate(0)], tap, 3, radius)).toBeNull();
    });

    it('does not let huge finite projected values overflow into a false near hit', () => {
        expect(
            nearestTrialWaypoint(
                [{ index: 1, x: Number.MAX_VALUE, y: Number.MAX_VALUE }],
                {
                    x: -Number.MAX_VALUE,
                    y: -Number.MAX_VALUE,
                },
                3,
                Number.MAX_VALUE,
            ),
        ).toBeNull();
    });

    it('returns null for empty, non-array or over-budget input without scanning an unbounded feature list', () => {
        expect(nearestTrialWaypoint([], tap, 3)).toBeNull();
        expect(nearestTrialWaypoint(null as unknown as TrialWaypointHitCandidate[], tap, 3)).toBeNull();
        const budget = Array.from({ length: MAX_TRIAL_WAYPOINT_HIT_CANDIDATES }, () => candidate(1));
        expect(nearestTrialWaypoint(budget, tap, 3)).toBe(1);
        budget.push(candidate(0));
        expect(nearestTrialWaypoint(budget, tap, 3)).toBeNull();
    });

    it('does not mutate frozen input or the tap', () => {
        const candidates = Object.freeze([Object.freeze(candidate(2, 10)), Object.freeze(candidate(0, 20))]);
        const point = Object.freeze({ ...tap });
        expect(nearestTrialWaypoint(candidates, point, 3)).toBe(2);
        expect(candidates).toEqual([candidate(2, 10), candidate(0, 20)]);
        expect(point).toEqual(tap);
    });
});
