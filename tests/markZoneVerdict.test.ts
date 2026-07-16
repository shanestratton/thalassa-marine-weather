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

    it('a CLEAN deep-water pass reads GREEN (info) with the IALA confirmation, grade stays clear', () => {
        // Deep (6 m) NORTH where the line runs, shoal SOUTH. Boat on the deep
        // side, red mark to starboard → correct heading out. Shane 2026-07-16:
        // "can it be green because I'm on the correct side?" — YES: 'info', and
        // the leg grade stays clear (green), no amber.
        const ctx = makeCtx({
            DEPARE: fc(
                poly(153.0, MARK_LAT, 153.1, -27.1, { DRVAL1: 6, DRVAL2: 10 }), // north deep
                poly(153.0, -27.2, 153.1, MARK_LAT, { DRVAL1: 1, DRVAL2: 2 }), // south shoal
            ),
            OBSTRN: markHazardOBSTRN,
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('info:Red port-hand mark to your starboard — correct side heading out (IALA-A)');
        expect(v.grade).toBe('clear'); // ← GREEN, not amber
        expect(v.issues.some((i) => i.severity === 'caution' || i.severity === 'danger')).toBe(false);
    });

    it('a deep-water pass with no confirmed shoal ALSO reads GREEN (info), never amber', () => {
        // Deep both sides → chart can't call the side, but the water is keel-safe
        // where the boat sails → a safe pass → GREEN with the IALA context.
        const ctx = makeCtx({
            DEPARE: DEEP, // 6 m everywhere
            OBSTRN: markHazardOBSTRN, // red port-hand
        } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('info:Red port-hand mark to your starboard — correct side heading out (IALA-A)');
        expect(v.grade).toBe('clear');
        expect(msgs).not.toContain('caution:');
        expect(msgs).not.toContain('danger side');
    });

    it('a GREEN mark to port reads the right hand + side, GREEN', () => {
        // Green (starboard-hand) mark NORTH of the eastbound leg → on the boat's
        // port. Locks the other colour + the port course-side.
        const greenN = fc({
            type: 'Feature',
            properties: { _class: 'lateral-marker-as-hazard', _markerKind: 'starboard' },
            geometry: { type: 'Point', coordinates: [MARK_LON, -27.1497] },
        });
        const ctx = makeCtx({ DEPARE: DEEP, OBSTRN: greenN } as Partial<InshoreLayers>);
        const v = validateTraceLeg(A, B, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('info:Green starboard-hand mark to your port — correct side heading out (IALA-A)');
        expect(v.grade).toBe('clear');
    });

    it('when the depth is unproven (leg passing over the mark), it falls back to the amber IALA rule', () => {
        // A short leg entirely inside the 60 m disc → no least-depth read →
        // depth NOT confirmed safe → the advisory stays amber with the rule.
        const ctx = makeCtx({ DEPARE: DEEP, OBSTRN: markHazardOBSTRN } as Partial<InshoreLayers>);
        const shortA = { lat: MARK_LAT, lon: 153.0495 };
        const shortB = { lat: MARK_LAT, lon: 153.0505 };
        const v = validateTraceLeg(shortA, shortB, ctx);
        const msgs = v.issues.map((i) => `${i.severity}:${i.message}`).join(' | ');
        expect(msgs).toContain('IALA-A: keep red to port heading in');
        expect(v.issues.some((i) => i.severity === 'caution')).toBe(true);
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
