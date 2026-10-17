import { describe, expect, it } from 'vitest';
import { normaliseRouteConstraints, resolveRouteConstraints } from '../services/routing/routeConstraints';
import {
    recoverRouteConstraints,
    routeConstraintNotes,
    ROUTE_CONSTRAINT_NOTES_PREFIX,
} from '../services/routing/routeConstraintNotes';
import { remainingReplanVias } from '../services/routing/routeReplanPolicy';
import { buildFollowRoutePlan } from '../services/shiplog/followRoutePlan';
import { chartFreeVoyagePlan } from '../services/chartFacts';
import type { VoyagePlan } from '../types';
const origin = { lat: 0, lon: 0 },
    destination = { lat: 0, lon: 2 };
const side = { lat: 0, lon: 1, name: 'User mark', leaveSide: 'port' as const, standOffM: 50 };
describe('durable user constraints remain separate from generated route shape', () => {
    it('restores a fixed side reference without rotating it when the re-plan origin moves', () => {
        const initial = resolveRouteConstraints(origin, [side], destination)!;
        const notes = '__route_geometry__::[[0,0],[2,0]]\nSummary' + routeConstraintNotes(initial.canonicalVias);
        const restored = recoverRouteConstraints(notes)!;
        expect(restored).toEqual([{ ...side, courseBearing: 90 }]);
        const next = resolveRouteConstraints({ lat: -0.5, lon: 0.5 }, restored, destination)!;
        expect(next.points[1]).toEqual(initial.points[1]);
        expect(next.halfLines).toEqual(initial.halfLines);
    });
    it('preserves absent legacy, explicit empty and invalid metadata as distinct states', () => {
        expect(recoverRouteConstraints('Legacy summary')).toBeUndefined();
        expect(recoverRouteConstraints(routeConstraintNotes([]))).toEqual([]);
        expect(recoverRouteConstraints(`${ROUTE_CONSTRAINT_NOTES_PREFIX}{invalid`)).toBeNull();
        expect(recoverRouteConstraints(routeConstraintNotes([]) + routeConstraintNotes([]))).toBeNull();
        expect(normaliseRouteConstraints([side])).toBeNull();
        expect(() => routeConstraintNotes(null)).toThrow('unreadable');
        expect(() => routeConstraintNotes(Array(257).fill(origin))).toThrow('unreadable');
    });
    it('whitelists user fields across notes, the chart-free plan and saved-route follow reconstruction', () => {
        const clean = [{ ...side, courseBearing: 90 }];
        const raw = [{ ...clean[0], depth_m: 3.1, chartFeature: { licensed: true }, sourceCell: 'PRIVATE' }];
        expect(recoverRouteConstraints(routeConstraintNotes(raw))).toEqual(clean);
        const plan = buildFollowRoutePlan({ points: [origin, destination], routeConstraints: raw })!;
        expect(plan.routeConstraints).toEqual(clean);
        expect(chartFreeVoyagePlan({ ...plan, routeConstraints: raw }).routeConstraints).toEqual(clean);
        expect(
            buildFollowRoutePlan({ points: [origin, destination], routeConstraints: null })?.routeConstraints,
        ).toBeNull();
        expect(
            buildFollowRoutePlan({ points: [origin, { lat: NaN, lon: 1 }, destination], routeConstraints: [] }),
        ).toBeNull();
    });
    it('refuses a new side whose neighbouring course is antipodal and has no unique bearing', () => {
        expect(resolveRouteConstraints(origin, [{ ...side, lat: 1, lon: 90 }], { lat: 0, lon: 180 })).toBeNull();
    });
    it('retains the unpassed original mark and frame, while refusing altered geometry or corrupt metadata', () => {
        const constraints = resolveRouteConstraints(origin, [side], destination)!;
        const plan: VoyagePlan = {
            origin: 'A',
            destination: 'B',
            departureDate: '2026-10-17T12:00:00Z',
            destinationCoordinates: destination,
            waypoints: [],
            routeConstraints: constraints.canonicalVias,
            distanceApprox: '',
            durationApprox: '',
            overview: '',
        };
        const route = constraints.points;
        expect(remainingReplanVias(plan, route, origin)?.remaining).toEqual(constraints.canonicalVias);
        expect(remainingReplanVias(plan, route, { lat: 0, lon: 1.8 })?.remaining).toEqual([]);
        expect(remainingReplanVias(plan, [origin, destination], origin)).toBeNull();
        expect(remainingReplanVias({ ...plan, routeConstraints: null }, route, origin)).toBeNull();
    });
});
