import { describe, expect, it } from 'vitest';
import {
    resolveRouteConstraints,
    routeRetainsConstraints,
    routeSegmentAllowed,
    type RouteConstraintPoint,
} from '../services/routing/routeConstraints';
const origin = { lat: 0, lon: 0 },
    end = { lat: 0, lon: 2 },
    via = { lat: 0, lon: 1, name: 'User pin' };
describe('must-pass and leave-side route constraints', () => {
    it('keeps user pins in order and refuses a final smoothing pass that drops or reverses them', () => {
        const value = resolveRouteConstraints(origin, [via, { lat: 0, lon: 1.5 }], end)!;
        expect(routeRetainsConstraints(value.points, value)).toBe(true);
        expect(routeRetainsConstraints([origin, end], value)).toBe(false);
        expect(routeRetainsConstraints([origin, value.points[2], via, end], value)).toBe(false);
        expect(routeRetainsConstraints([{ lat: 0, lon: -1 }, ...value.points], value)).toBe(false);
    });
    it('derives a visible passing point for leave-to-port, and blocks the wrong-side half-line', () => {
        const value = resolveRouteConstraints(origin, [{ ...via, leaveSide: 'port', standOffM: 50 }], end)!;
        expect(value.points[1].lat).toBeLessThan(0);
        expect(value.halfLines[0].bearing).toBeCloseTo(0);
        expect(routeRetainsConstraints(value.points, value)).toBe(true);
        expect(routeSegmentAllowed({ lat: 0.1, lon: 0 }, { lat: 0.1, lon: 2 }, value.halfLines)).toBe(false);
        expect(routeSegmentAllowed(origin, end, value.halfLines)).toBe(false);
        expect(routeSegmentAllowed({ lat: -0.1, lon: 0 }, { lat: -0.1, lon: 2 }, value.halfLines)).toBe(true);
    });
    it('reverses the forbidden side for leave-to-starboard', () => {
        const value = resolveRouteConstraints(origin, [{ ...via, leaveSide: 'starboard', standOffM: 50 }], end)!;
        expect(value.points[1].lat).toBeGreaterThan(0);
        expect(routeRetainsConstraints(value.points, value)).toBe(true);
        expect(routeSegmentAllowed({ lat: -0.1, lon: 0 }, { lat: -0.1, lon: 2 }, value.halfLines)).toBe(false);
    });
    it('uses the short dateline crossing and spherical polar geometry, not longitude interpolation', () => {
        const dateLineRay = [{ lat: 0, lon: 180, bearing: 0 }];
        expect(routeSegmentAllowed({ lat: 1, lon: 179 }, { lat: 1, lon: -179 }, dateLineRay)).toBe(false);
        expect(routeSegmentAllowed({ lat: -1, lon: 179 }, { lat: -1, lon: -179 }, dateLineRay)).toBe(true);
        const polarRay = [{ lat: 85, lon: 0, bearing: 0 }];
        expect(routeSegmentAllowed({ lat: 86, lon: -10 }, { lat: 86, lon: 10 }, polarRay)).toBe(false);
        expect(routeSegmentAllowed({ lat: 84, lon: -10 }, { lat: 84, lon: 10 }, polarRay)).toBe(true);
    });
    it('refuses malformed, excessive, coincident and ambiguous side requests as a whole', () => {
        for (const bad of [
            { ...via, leaveSide: 'port' },
            { ...via, leaveSide: 'port', standOffM: 0 },
            { ...via, leaveSide: 'port', standOffM: Infinity },
            { ...via, leaveSide: 'unknown', standOffM: 50 },
            { ...via, lat: NaN },
        ])
            expect(resolveRouteConstraints(origin, [bad as RouteConstraintPoint], end)).toBeNull();
        expect(resolveRouteConstraints(origin, Array(257).fill(via), end)).toBeNull();
        expect(resolveRouteConstraints(origin, [origin], end)).toBeNull();
        expect(resolveRouteConstraints(origin, [{ ...via, leaveSide: 'port', standOffM: 50 }], origin)).toBeNull();
    });
});
