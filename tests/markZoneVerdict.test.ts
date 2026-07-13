/**
 * Mark-inference discs vs the tracer verdict (Skirmish Point, 2026-07-14:
 * "it says crossing a hazard?? but there are not").
 *
 * Solo-lateral / cardinal avoidance half-discs are ROUTING inferences
 * (`_class: 'iala-oriented-hazard'`), not charted data. The A* grid
 * blocks them (robot stays conservative) but the tracer must:
 *   - grade a disc-only crossing as CAUTION with honest mark wording,
 *   - never let a disc mask a REAL charted danger on the same leg,
 *   - keep calling real obstructions "crosses a charted hazard".
 */
import { describe, expect, it } from 'vitest';
import type { FeatureCollection } from 'geojson';
import { buildNavGrid } from '../services/engine/navGrid';
import type { InshoreLayers } from '../services/inshoreRouterEngine';
import { validateTraceLeg, type TracerContext } from '../services/routeTracer';

const poly = (w: number, s: number, e: number, n: number, props: Record<string, unknown> = {}) => ({
    type: 'Feature' as const,
    properties: props,
    geometry: {
        type: 'Polygon' as const,
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

const fc = (...features: unknown[]): FeatureCollection =>
    ({ type: 'FeatureCollection', features }) as FeatureCollection;

const BBOX: [number, number, number, number] = [153.0, -27.2, 153.1, -27.1];

function makeCtx(layers: Partial<InshoreLayers>): TracerContext {
    const grid = buildNavGrid(layers as InshoreLayers, BBOX, 25, 2.4, 0.5, 60);
    return {
        grid,
        soloLaterals: [],
        cardinals: [],
        gatePairs: [],
        leads: [],
        canalLanes: [],
        draftM: 2.4,
        draftAssumed: false,
        bbox: BBOX,
        resM: 25,
    } as unknown as TracerContext;
}

// 6 m water across the whole test box.
const DEEP = fc(poly(153.0, -27.2, 153.1, -27.1, { DRVAL1: 6, DRVAL2: 10 }));
const A = { lat: -27.15, lon: 153.01 };
const B = { lat: -27.15, lon: 153.09 };

describe('mark-inference discs in the tracer verdict', () => {
    it('a disc-only crossing grades CAUTION with mark wording, never "charted hazard"', () => {
        const ctx = makeCtx({
            DEPARE: DEEP,
            OBSTRN: fc(poly(153.04, -27.16, 153.06, -27.14, { _class: 'iala-oriented-hazard' })),
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('caution:passes the danger side of a nearby mark');
        expect(msgs).not.toContain('charted hazard');
        expect(v.issues.some((i) => i.severity === 'danger')).toBe(false);
    });

    it('a REAL charted obstruction still grades DANGER "crosses a charted hazard"', () => {
        const ctx = makeCtx({
            DEPARE: DEEP,
            OBSTRN: fc(poly(153.04, -27.16, 153.06, -27.14)), // no _class — charted feature
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        expect(v.issues.some((i) => i.severity === 'danger' && i.message === 'crosses a charted hazard')).toBe(true);
    });

    it('a disc never masks real charted land on the same leg', () => {
        const ctx = makeCtx({
            DEPARE: DEEP,
            OBSTRN: fc(poly(153.02, -27.16, 153.03, -27.14, { _class: 'iala-oriented-hazard' })),
            LNDARE: fc(poly(153.06, -27.17, 153.08, -27.13)), // land AFTER the disc along the leg
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        expect(v.issues.some((i) => i.severity === 'danger' && i.message === 'crosses charted land')).toBe(true);
    });
});
