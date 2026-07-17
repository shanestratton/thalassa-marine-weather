/**
 * encDepthStyle — regression guard over the chart's safety-critical
 * display math. Every rule here has grounded (or nearly grounded) a
 * boat somewhere in the audit trail:
 *   1. unknown depth NEVER reads as safe (fill, glaze);
 *   2. attribute reads defend lowercase ogr2ogr cells;
 *   3. the safety contour is per-cell — no lost keel line at seams;
 *   4. never embolden a contour shallower than the safety depth;
 *   5. the sounding subscript carry (1.96 → "2", not "1₀").
 * Expressions are exercised through a faithful mini-evaluator
 * (exprEval.ts) — structure alone proves nothing about semantics.
 */
import { describe, it, expect } from 'vitest';

import {
    ATTR_UNKNOWN,
    DEPARE_BAND_COLORS,
    DEPCNT_LABEL_INK_DATUM,
    DEPCNT_LABEL_INK_LIVE,
    NO_SAFETY_VALDCO,
    SHALLOW_CAUTION_COLOR,
    buildDepareFillColor,
    buildDepareGlazeFillColor,
    buildDepareSatelliteOpacity,
    buildDepcntLabelField,
    buildSoundingTextField,
    computeSafetyValdco,
    computeSafetyValdcoByCell,
    depcntLineFilter,
    depcntSafetyFilter,
    distinctValdcosByCell,
    safetyContourMatchExpr,
} from '../../components/map/encDepthStyle';
import { evalExpr } from './exprEval';

const fill = (props: Record<string, unknown>, tide = 0): unknown => evalExpr(buildDepareFillColor(tide), { props });
const glaze = (props: Record<string, unknown>, S = 3): unknown => evalExpr(buildDepareSatelliteOpacity(S), { props });
const sounding = (props: Record<string, unknown>, tide = 0): unknown =>
    evalExpr(buildSoundingTextField(tide), { props });

describe('hard rule 1 — unknown depth never reads as safe', () => {
    it('missing DRVAL1 renders UNCHARTED (transparent), not deep paper', () => {
        // Old behaviour: to-number(null)=0 → 0–2 m band (comment claimed
        // 999/deep). Either way a polygon with NO depth data painted as
        // charted water. Now: no fill at all.
        expect(fill({})).toBe('rgba(0,0,0,0)');
    });

    it('garbage DRVAL1 renders UNCHARTED, not 50 m+ clean paper', () => {
        // Old behaviour: to-number("n/a") throws → coalesce → 999 → pure
        // white "sail here". The exact fail-dangerous path.
        expect(fill({ DRVAL1: 'n/a' })).toBe('rgba(0,0,0,0)');
    });

    it('the satellite glaze never lights the keel-safe wash over unknown depth', () => {
        expect(glaze({})).toBe(0);
        expect(glaze({ DRVAL1: 'n/a' })).toBe(0);
    });

    it('real depths still band correctly', () => {
        expect(fill({ DRVAL1: -1 })).toBe(DEPARE_BAND_COLORS.drying);
        expect(fill({ DRVAL1: 0.5 })).toBe(DEPARE_BAND_COLORS.b0to2);
        expect(fill({ DRVAL1: 3 })).toBe(DEPARE_BAND_COLORS.b2to5);
        expect(fill({ DRVAL1: 60 })).toBe(DEPARE_BAND_COLORS.b50plus);
    });

    it('drying vs 0–2 m bands are visibly distinct colours (sunlight read)', () => {
        expect(DEPARE_BAND_COLORS.drying).not.toBe(DEPARE_BAND_COLORS.b0to2);
    });
});

describe('hard rule 2 — lowercase ogr2ogr attributes are first-class', () => {
    it('a lowercase drval1 cell bands like its uppercase twin', () => {
        expect(fill({ drval1: 3 })).toBe(fill({ DRVAL1: 3 }));
        expect(glaze({ drval1: 5 })).toBe(glaze({ DRVAL1: 5 }));
    });

    it('a lowercase valdco contour is labelled with its value, not "0"', () => {
        expect(evalExpr(buildDepcntLabelField(0), { props: { valdco: 5 } })).toBe('5');
        expect(evalExpr(buildDepcntLabelField(0), { props: { VALDCO: 5 } })).toBe('5');
    });

    it('a contour with NO value gets NO label — never a fake "0 m" line', () => {
        expect(evalExpr(buildDepcntLabelField(0), { props: {} })).toBe('');
        expect(evalExpr(buildDepcntLabelField(0), { props: { VALDCO: 'x' } })).toBe('');
    });

    it('numeric-string attributes (quoted by some converters) still parse', () => {
        expect(fill({ DRVAL1: '3.0' })).toBe(DEPARE_BAND_COLORS.b2to5);
    });
});

describe('tide offset — "depth right now" shifts every stop consistently', () => {
    it('a 0–2 m bank under 1.5 m of tide reads as the 2–5 m band', () => {
        expect(fill({ DRVAL1: 1 }, 1.5)).toBe(DEPARE_BAND_COLORS.b2to5);
    });
    it('contour labels shift with the tide so the screen never mixes datums', () => {
        // Non-integer results keep the decimal (audit: rounding printed a
        // WRONG depth on the line — 6.2 m labelled "6").
        expect(evalExpr(buildDepcntLabelField(1.2), { props: { VALDCO: 5 } })).toBe('6.2');
        expect(evalExpr(buildDepcntLabelField(1), { props: { VALDCO: 5 } })).toBe('6');
        expect(evalExpr(buildDepcntLabelField(0), { props: { VALDCO: 3.6 } })).toBe('3.6');
    });
});

describe('hard rule 5 — sounding subscript carry', () => {
    it('renders paper-chart subscripts: 3.4 → 3₄', () => {
        expect(sounding({ _d: 3.4 })).toBe('3₄');
    });
    it('the 1.96 carry: rounds to "2", never "1₀"', () => {
        expect(sounding({ _d: 1.96 })).toBe('2');
        // Same value arriving via a tide offset (the path that shipped
        // the original bug — offsets make non-pre-rounded values).
        expect(sounding({ _d: 0.66 }, 1.3)).toBe('2');
    });
    it('drying heights render as magnitude (khaki convention), no minus sign', () => {
        // INT1: drying soundings carry the underline (combining U+0332) —
        // magnitude only, no minus sign, khaki ink carries the rest.
        expect(sounding({ _d: -0.3 })).toBe('0\u0332₃');
    });
    it('deep water rounds whole', () => {
        expect(sounding({ _d: 12.4 })).toBe('12');
        expect(sounding({ _d: 9.96 })).toBe('10');
    });
});

describe('hard rules 3+4 — the safety contour', () => {
    it('never emboldens a contour shallower than the safety depth', () => {
        expect(computeSafetyValdco([2, 5, 10], 3)).toBe(5);
        expect(computeSafetyValdco([2, 2.5], 3)).toBeNull(); // shallow-only cell
        expect(computeSafetyValdco([], 3)).toBeNull();
        expect(computeSafetyValdco([NaN, 5], 3)).toBe(5);
    });

    it('per-cell: each cell bolds ITS OWN smallest qualifying contour', () => {
        // The seam case from the audit: window sv used to be 3 (cell A);
        // cell B carries only [5, 10] and lost its keel line entirely.
        const byCell = computeSafetyValdcoByCell({ A: [3, 5], B: [5, 10] }, 3);
        expect(byCell).toEqual({ A: 3, B: 5 });

        const filter = depcntSafetyFilter(byCell);
        const bold = (props: Record<string, unknown>): unknown => evalExpr(filter, { props, zoom: 12 });
        expect(bold({ _cellId: 'A', VALDCO: 3 })).toBe(true);
        expect(bold({ _cellId: 'B', VALDCO: 5 })).toBe(true); // B keeps its line
        expect(bold({ _cellId: 'B', VALDCO: 10 })).toBe(false);
        expect(bold({ _cellId: 'A', VALDCO: 5 })).toBe(false); // A bolds 3, not 5
    });

    it('ordinary-contour filter is the exact complement of the safety filter', () => {
        const byCell = computeSafetyValdcoByCell({ A: [3, 5] }, 3);
        const line = depcntLineFilter(byCell);
        const safety = depcntSafetyFilter(byCell);
        for (const props of [
            { _cellId: 'A', VALDCO: 3 },
            { _cellId: 'A', VALDCO: 5 },
            { _cellId: 'A', valdco: 3 },
            { _cellId: 'A' },
        ]) {
            const asLine = Boolean(evalExpr(line, { props, zoom: 12 }));
            const asSafety = Boolean(evalExpr(safety, { props, zoom: 12 }));
            expect(asLine).toBe(!asSafety);
        }
    });

    it('no qualifying contour anywhere → nothing bolds, everything draws thin', () => {
        const byCell = computeSafetyValdcoByCell({ A: [1, 2] }, 3); // { A: null }
        expect(evalExpr(depcntSafetyFilter(byCell), { props: { _cellId: 'A', VALDCO: 2 }, zoom: 12 })).toBe(false);
        expect(evalExpr(depcntLineFilter(byCell), { props: { _cellId: 'A', VALDCO: 2 }, zoom: 12 })).toBe(true);
    });

    it('unknown VALDCO can never collide with a sentinel and render bold', () => {
        // The two sentinels MUST stay distinct: if ATTR_UNKNOWN ===
        // NO_SAFETY_VALDCO a garbage contour would match the "no safety
        // contour" case and draw as the keel line.
        expect(ATTR_UNKNOWN).not.toBe(NO_SAFETY_VALDCO);
        expect(evalExpr(safetyContourMatchExpr({ A: ATTR_UNKNOWN }), { props: { _cellId: 'A', VALDCO: 'junk' } })).toBe(
            false,
        );
    });

    it('lowercase valdco cells participate in per-cell grouping', () => {
        const byCell = distinctValdcosByCell({
            features: [
                { properties: { _cellId: 'A', VALDCO: 5 } },
                { properties: { _cellId: 'A', valdco: 2 } },
                { properties: { _cellId: 'B', valdco: 10 } },
                { properties: { _cellId: 'A', VALDCO: 5 } }, // dup
                { properties: { VALDCO: 7 } }, // no provenance → '?' group
            ],
        });
        expect(byCell).toEqual({ A: [2, 5], B: [10], '?': [7] });
    });
});

describe('expression structural invariants', () => {
    it('band step stops stay strictly ascending under any tide offset', () => {
        for (const tide of [-1, 0, 0.5, 2.3, 4]) {
            const expr = buildDepareFillColor(tide) as unknown as unknown[];
            const step = (expr as unknown[])[2] as unknown[]; // case → valid arm
            const stops: number[] = [];
            for (let i = 3; i < step.length; i += 2) stops.push(step[i] as number);
            for (let i = 1; i < stops.length; i++) expect(stops[i]).toBeGreaterThan(stops[i - 1]);
        }
    });

    it('glaze step stops stay strictly ascending for shallow AND deep keels', () => {
        for (const S of [0.5, 3, 19.99, 20, 25, 49.99, 60]) {
            const expr = buildDepareSatelliteOpacity(S) as unknown as unknown[];
            const step = (expr as unknown[])[2] as unknown[];
            const stops: number[] = [];
            for (let i = 3; i < step.length; i += 2) stops.push(step[i] as number);
            for (let i = 1; i < stops.length; i++) expect(stops[i]).toBeGreaterThan(stops[i - 1]);
        }
    });

    it('contour label inks are distinct between datum and live modes', () => {
        expect(DEPCNT_LABEL_INK_DATUM).not.toBe(DEPCNT_LABEL_INK_LIVE);
    });
});

describe('satellite shallow-water salience — a known shoal is NOT identical to uncharted', () => {
    const glazeColor = (props: Record<string, unknown>, S = 3): unknown =>
        evalExpr(buildDepareGlazeFillColor(S), { props });

    it('charted-shallow paints a CAUTION wash (opacity > 0), unlike uncharted (0) — the collision is broken', () => {
        expect(glaze({ DRVAL1: 1 }, 3)).toBeGreaterThan(0); // known 1 m shoal, S=3
        expect(glaze({}, 3)).toBe(0); // uncharted → still bare imagery
        expect(glaze({ DRVAL1: 1 }, 3)).not.toBe(glaze({}, 3));
    });

    it('drying / shallow-caution / safe are three DISTINCT colours', () => {
        const drying = glazeColor({ DRVAL1: -0.5 }, 3);
        const shallow = glazeColor({ DRVAL1: 1 }, 3);
        const safe = glazeColor({ DRVAL1: 5 }, 3);
        expect(shallow).toBe(SHALLOW_CAUTION_COLOR);
        // The glaze's safe-white is its OWN warm constant — deliberately NOT
        // the chart ramp (blue-shallow, 2026-07-18): over imagery "white
        // means GO"; a blue wash would read as water depth, not clearance.
        expect(safe).toBe('#f7f5f0'); // glaze safe white
        expect(new Set([drying, shallow, safe]).size).toBe(3);
    });

    it('safe water stays brighter than the shallow caution wash', () => {
        expect(glaze({ DRVAL1: 5 }, 3)).toBeGreaterThan(glaze({ DRVAL1: 1 }, 3) as number);
    });

    it('opacity + colour agree on the 0/S boundaries (pairing invariant)', () => {
        // At exactly S → safe; just under → caution amber.
        expect(glazeColor({ DRVAL1: 3 }, 3)).toBe('#f7f5f0');
        expect(glaze({ DRVAL1: 3 }, 3)).toBeGreaterThanOrEqual(0.6);
        expect(glazeColor({ DRVAL1: 2.99 }, 3)).toBe(SHALLOW_CAUTION_COLOR);
    });
});
