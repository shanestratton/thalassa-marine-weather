import { describe, expect, it } from 'vitest';
import {
    copyTraceRoutePoints,
    encodeTraceRoutePoint,
    decodeTraceRoutePoints,
    reverseTraceRoutePoints,
    type TraceRoutePoint,
} from '../services/routing/traceRoutePoint';
import { routeConstraintsForTrace } from '../services/routing/traceConstraints';
import { resolveRouteConstraints } from '../services/routing/routeConstraints';
import { decodeSavedRoutePoints } from '../services/savedRoutePoints';
import { evaluateTraceRelease, normaliseTraceVerification } from '../services/traceVerification';
const origin = { lat: 0, lon: 0 },
    destination = { lat: 0, lon: 2 };
function points(): TraceRoutePoint[] {
    const resolved = resolveRouteConstraints(
        origin,
        [{ lat: 0, lon: 1, name: 'User side mark', leaveSide: 'port', standOffM: 50 }],
        destination,
    )!;
    return [
        origin,
        { lat: -0.001, lon: 0.5, shape: true as const },
        { lat: resolved.points[1].lat, lon: resolved.points[1].lon, constraint: resolved.canonicalVias[0] },
        { lat: -0.001, lon: 1.5, auto: true as const },
        destination,
    ];
}
describe('Tracer point intent survives local and account round-trips', () => {
    it('retains actual geometry, fixed mark and generated roles across versioned pairs', () => {
        const original = points(),
            wire = original.map(encodeTraceRoutePoint);
        expect(wire[0]).toEqual([0, 0]);
        expect(wire[1]).toEqual([-0.001, 0.5, 1]);
        expect(wire[3]).toEqual([-0.001, 1.5, 2]);
        expect(decodeTraceRoutePoints(wire)).toEqual(original);
        expect(decodeSavedRoutePoints(wire)).toEqual(original);
        expect(routeConstraintsForTrace(decodeTraceRoutePoints(wire)!)).toEqual([original[2].constraint]);
    });
    it('refuses the whole point list for malformed or future metadata instead of silently dropping a mark', () => {
        expect(
            decodeTraceRoutePoints([
                [0, 0],
                [0, 1, { v: 2, mark: {} }],
                [0, 2],
            ]),
        ).toBeNull();
        expect(
            decodeTraceRoutePoints([
                [0, 0],
                [0, 1, 3],
                [0, 2],
            ]),
        ).toBeNull();
        expect(
            copyTraceRoutePoints([
                origin,
                { lat: 0, lon: 1, constraint: { lat: 0, lon: 1, leaveSide: 'port', standOffM: 50 } },
                destination,
            ]),
        ).toBeNull();
        expect(
            decodeTraceRoutePoints([
                [0, 0],
                [91, 1],
                [0, 2],
            ]),
        ).toBeNull();
    });
    it('does not copy chart/provider properties into the private point payload', () => {
        const original = points();
        const unsafe = {
            ...original[2],
            depth_m: 4,
            sourceCell: 'PRIVATE',
            constraint: { ...original[2].constraint!, chartProperties: { value: 5 } },
        };
        expect(JSON.stringify(encodeTraceRoutePoint(unsafe))).not.toMatch(/PRIVATE|chartProperties|depth_m/);
        expect(copyTraceRoutePoints([unsafe])?.[0]).toEqual(original[2]);
    });
    it('reverses vessel-side wording and reference while keeping the same physical line and barrier', () => {
        const original = points(),
            reversed = reverseTraceRoutePoints(original);
        expect(reversed.map((p) => [p.lon, p.lat])).toEqual(original.map((p) => [p.lon, p.lat]).reverse());
        const constraints = routeConstraintsForTrace(reversed)!;
        expect(constraints[0]).toMatchObject({ leaveSide: 'starboard', courseBearing: 270 });
        expect(reverseTraceRoutePoints(reversed)).toEqual(original);
    });
    it('holds a line whose side position or crossing no longer matches its original mark', () => {
        const original = points();
        original[2] = { ...original[2], lat: 0.01 };
        expect(routeConstraintsForTrace(original)).toBeNull();
    });
    it('does not reuse a geometry-only clearance after its leave-side metadata changes', () => {
        const original = points();
        const verdicts = original.slice(1).map(() => ({
            grade: 'clear' as const,
            issues: [],
            minDepthM: 8,
            minAt: null,
            needsTide: false,
            nudge: null,
            nudgeTo: null,
        }));
        const context = {
            draftM: 1.8,
            draftAssumed: false,
            encRegistryVersion: 1,
            encRegistryFingerprint: 'PUBLIC@1',
            departureMs: Date.now(),
            tideWindowLabel: '',
        };
        const gate = evaluateTraceRelease(original, 'ready', verdicts, new Set(), context);
        expect(gate.allowed).toBe(true);
        original[2].constraint!.standOffM = 100;
        expect(normaliseTraceVerification(gate.verification, original)).toBeNull();
        const refusal = evaluateTraceRelease(original, 'ready', verdicts, new Set([0, 1, 2, 3]), context);
        expect(refusal.allowed).toBe(false);
        expect(refusal.reason).toContain('side crossing cannot be acknowledged');
    });
});
