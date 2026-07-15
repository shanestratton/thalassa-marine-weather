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
import { parseMarkHazards, validateTraceLeg, type TracerContext } from '../services/routeTracer';

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

function makeCtx(layers: Partial<InshoreLayers>, soloLaterals: unknown[] = []): TracerContext {
    const grid = buildNavGrid(layers as InshoreLayers, BBOX, 25, 2.4, 0.5, 60);
    return {
        grid,
        soloLaterals,
        markHazards: parseMarkHazards((layers.OBSTRN?.features ?? []) as never[]),
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
    it('a disc-only crossing grades CAUTION with honest mark wording, never "charted hazard"', () => {
        // Deep water everywhere → the chart can't call the safe side, so the
        // honest "check which side is safe" fires (NOT the old over-confident
        // "danger side", NOT a charted-hazard danger).
        const ctx = makeCtx({
            DEPARE: DEEP,
            OBSTRN: fc(poly(153.04, -27.16, 153.06, -27.14, { _class: 'iala-oriented-hazard' })),
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('caution:near a mark — check which side is safe');
        expect(msgs).not.toContain('danger side'); // the old false-confident wording is gone
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

    // Shane's ACTUAL 2026-07-16 case: an isolated red beacon ("Fl R 3s", no
    // numbered OBJNAM) → the engine builds a lateral-marker-as-hazard disc for
    // it, but parseLateralMarks DROPS it (needs a number) so it never reaches
    // soloLaterals. §1 must read the chart against the disc's OWN mark
    // (ctx.markHazards, straight from merged.OBSTRN) — NOT rely on soloLaterals.
    // soloLaterals is EMPTY in all three below, exactly like the field bug.
    const MARK_LAT = -27.1503;
    const MARK_LON = 153.05;
    const markHazardOBSTRN = fc({
        type: 'Feature',
        properties: { _class: 'lateral-marker-as-hazard', _markerKind: 'port' },
        geometry: { type: 'Point', coordinates: [MARK_LON, MARK_LAT] },
    });

    it("a CLEAN pass says NOTHING — the disc mark's shoal is on the FAR side (Shane's fix)", () => {
        // Deep (6 m) NORTH where the line runs, shoal (1 m) SOUTH by the land.
        // The mark isn't in soloLaterals, but §1 reads markHazards → clean →
        // silent. Needs the extended probe to see the shoal PAST the 60 m disc.
        const ctx = makeCtx({
            DEPARE: fc(
                poly(153.0, MARK_LAT, 153.1, -27.1, { DRVAL1: 6, DRVAL2: 10 }), // north deep
                poly(153.0, -27.2, 153.1, MARK_LAT, { DRVAL1: 1, DRVAL2: 2 }), // south shoal
            ),
            OBSTRN: markHazardOBSTRN,
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).not.toContain('danger side');
        expect(msgs).not.toContain('near a mark'); // clean → fully silent
        expect(v.issues.some((i) => i.severity === 'danger')).toBe(false);
    });

    it('an AMBIGUOUS pass (deep both sides) gets the honest "check which side", never "danger side"', () => {
        const ctx = makeCtx({
            DEPARE: DEEP, // 6 m everywhere → chart can't call the side
            OBSTRN: markHazardOBSTRN,
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('caution:near a mark — check which side is safe');
        expect(msgs).not.toContain('danger side');
        expect(v.issues.some((i) => i.severity === 'danger')).toBe(false);
    });

    it('a genuine BANK-SIDE pass still warns with teeth (shoal on the boat side)', () => {
        // Flip it: shoal (1 m) NORTH where the line runs, deep SOUTH. The boat
        // IS on the wrong side → the warning must survive, not get suppressed.
        const ctx = makeCtx({
            DEPARE: fc(
                poly(153.0, MARK_LAT, 153.1, -27.1, { DRVAL1: 1, DRVAL2: 2 }), // north shoal (boat side)
                poly(153.0, -27.2, 153.1, MARK_LAT, { DRVAL1: 6, DRVAL2: 10 }), // south deep
            ),
            OBSTRN: markHazardOBSTRN,
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('caution:bank side of a nearby mark — favour the deeper side');
    });
});
