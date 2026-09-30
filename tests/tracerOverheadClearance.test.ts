/**
 * The Route Tracer grades bridges and overhead lines the way the router does
 * (Phase 2a review, 2026-09-30). Part B made the router block a bridge,
 * overhead cable or pipe whose clearance is below the air draft + 1 m,
 * unknown, or unset — but the tracer's grid carried no low-clearance bars and
 * its leg grading had no overhead check, so a hand-traced leg (or a "Fix this
 * leg" detour) under an 8 m bridge graded clean for an 18 m mast.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import type { InshoreLayers } from '../services/inshoreRouterEngine';
import {
    fixLegOnGrid,
    hydrateLegVerdicts,
    persistLegVerdicts,
    tracerContextFromLayers,
    validateTraceLeg,
} from '../services/routeTracer';
import { chartClearanceBars, polylineCrossesClearanceBar } from '../services/routing/overheadClearance';

const poly = (w: number, s: number, e: number, n: number, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

// A deep 8 m basin, 4 km × 2.2 km. The bridge runs north-south across its
// southern half at lon 153.02; the northern half is open water round it.
const BBOX: [number, number, number, number] = [153.0, -27.02, 153.04, -27.0];
const LAYERS: InshoreLayers = { DEPARE: fc(poly(153.0, -27.02, 153.04, -27.0, { DRVAL1: 8, DRVAL2: 10 })) };
const bridge = (props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: { acronym: 'BRIDGE', rcid: 7, OBJNAM: 'Basin Bridge', ...props },
    geometry: {
        type: 'LineString',
        coordinates: [
            [153.02, -27.0205],
            [153.02, -27.009],
        ],
    },
});
const AIR = 18;
const ctxWith = (b: Feature, airDraftM: number | null = AIR) =>
    tracerContextFromLayers(LAYERS, [], BBOX, 2.4, {
        clearanceBars: chartClearanceBars({ BRIDGE: [b] }, airDraftM),
        airDraftM,
    });
// West to east under the bridge, in the southern half.
const A = { lat: -27.015, lon: 153.012 };
const B = { lat: -27.015, lon: 153.028 };

describe('tracer: bridges and overhead lines', () => {
    it('a leg under an 8 m bridge is DANGER for an 18 m mast, in the router’s words', () => {
        const v = validateTraceLeg(A, B, ctxWith(bridge({ VERCLR: 8 })));
        expect(v.grade).toBe('danger');
        expect(v.issues.map((i) => i.message).join(' | ')).toMatch(/"Basin Bridge" has 8(\.0)? m clearance/);
    });

    it('a bridge with no charted clearance is DANGER (unknown blocks)', () => {
        const v = validateTraceLeg(A, B, ctxWith(bridge({})));
        expect(v.grade).toBe('danger');
        expect(v.issues.map((i) => i.message).join(' | ')).toMatch(/no clearance/i);
    });

    it('with the air draft unset every bridge is DANGER', () => {
        const v = validateTraceLeg(A, B, ctxWith(bridge({ VERCLR: 40 }), null));
        expect(v.grade).toBe('danger');
        expect(v.issues.map((i) => i.message).join(' | ')).toMatch(/air draft is not set/);
    });

    it('a leg under a low overhead conveyor (CONVYR) is DANGER too, named (round 2, 2026-09-30)', () => {
        const conveyor: Feature = {
            ...bridge({}),
            properties: { acronym: 'CONVYR', rcid: 8, OBJNAM: 'Coal loader', VERCLR: 12 },
        };
        const ctx = tracerContextFromLayers(LAYERS, [], BBOX, 2.4, {
            clearanceBars: chartClearanceBars({ CONVYR: [conveyor] }, AIR),
            airDraftM: AIR,
        });
        const v = validateTraceLeg(A, B, ctx);
        expect(v.grade).toBe('danger');
        expect(v.issues.map((i) => i.message).join(' | ')).toMatch(/overhead conveyor "Coal loader" has 12(\.0)? m/);
    });

    it('a 40 m bridge clears an 18 m mast: the leg is clean', () => {
        const v = validateTraceLeg(A, B, ctxWith(bridge({ VERCLR: 40 })));
        expect(v.grade).toBe('clear');
    });

    it('"Fix this leg" detours round the bridge, never under it', () => {
        const ctx = ctxWith(bridge({ VERCLR: 8 }));
        const detour = fixLegOnGrid(ctx, A, B);
        expect(detour).not.toBeNull();
        const line = detour!.map((p) => [p.lon, p.lat] as [number, number]);
        expect(polylineCrossesClearanceBar(line, ctx.clearanceBars ?? [])).toBeNull();
        expect(Math.max(...detour!.map((p) => p.lat))).toBeGreaterThan(-27.009); // went north of the span
    });

    it('a verdict graded for one air draft is never replayed for another', () => {
        localStorage.clear();
        const cache = new Map([
            [
                'leg-1',
                { grade: 'clear', issues: [], minDepthM: 9, minAt: null, needsTide: false, nudge: null, nudgeTo: null },
            ],
        ]);
        persistLegVerdicts(cache as never, 2.4, false, 'fp', 25);
        expect(hydrateLegVerdicts(2.4, false, 'fp', 25)?.get('leg-1')?.grade).toBe('clear');
        expect(hydrateLegVerdicts(2.4, false, 'fp', 18)).toBeNull();
        expect(hydrateLegVerdicts(2.4, false, 'fp', null)).toBeNull();
        localStorage.clear();
    });
});

describe('tracer: a chart with no bridge layers says so on its legs (owner decision 8; fix-up, 2026-09-30)', () => {
    const N = { lat: -27.004, lon: 153.012 };
    const M = { lat: -27.004, lon: 153.028 };

    it('a leg through a schema-1 cell carries the caveat as an info note — the grade is unchanged', () => {
        const ctx = ctxWith(bridge({ VERCLR: 40 }));
        const plain = validateTraceLeg(N, M, ctx);
        ctx.structuresUnknownBboxes = [[153.0, -27.02, 153.04, -27.0]];
        const v = validateTraceLeg(N, M, ctx);
        expect(v.grade).toBe(plain.grade);
        const note = v.issues.find((i) => /bridges and power lines not checked/.test(i.message));
        expect(note?.severity).toBe('info');
        // Last, so a leg's own confirmation still reads first.
        expect(v.issues[v.issues.length - 1]).toBe(note);
    });

    it('a leg clear of every such cell carries no caveat', () => {
        const ctx = ctxWith(bridge({ VERCLR: 40 }));
        ctx.structuresUnknownBboxes = [[153.1, -27.1, 153.2, -27.05]];
        expect(validateTraceLeg(N, M, ctx).issues.some((i) => /not checked/.test(i.message))).toBe(false);
    });
});
