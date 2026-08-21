/**
 * corridorPrefetch's pad formula mirrors the inshore engine's request box —
 * but the ENGINE refuses routes beyond MAX_INSHORE_NM (50 NM), so its version
 * is bounded by construction. The prefetch copied the formula WITHOUT the
 * ceiling: pad = max(span × 0.5, 0.08°) grows with the route, so a
 * Moreton-Bay-to-GBR trace (~4° span) padded ~2° a side and "the corridor"
 * became an ~8°×5° box over the densest cell region on the coast. Every pin
 * edit then hydrated another 12 reef cells; every arrival bumped the registry
 * and re-ran a ~27 MB display merge (Shane 2026-08-22, Plan-page deaths at
 * the southern GBR).
 *
 * Contract now: at or below the engine's own maximum span, behaviour is
 * IDENTICAL (the engine can genuinely consume the whole padded box). Above
 * it, no consumer exists for the corners — auto-route refuses the route and
 * grading works in ≤40 km windows around the line — so only cells near the
 * traced line are fetched.
 */
import { describe, expect, it } from 'vitest';
import {
    CORRIDOR_PAD_DEG,
    ENGINE_MAX_SPAN_DEG,
    corridorBBox,
    selectCorridorCells,
} from '../services/enc/corridorPrefetch';

type Cell = { id: string; bbox: [number, number, number, number] };

/** A degree-square cell centred on (lat, lon). */
function cell(id: string, lat: number, lon: number, half = 0.25): Cell {
    return { id, bbox: [lon - half, lat - half, lon + half, lat + half] };
}

/** Trivial cellsForBBox: every cell whose bbox intersects the query box. */
function inBBox(cells: Cell[]) {
    return (bbox: [number, number, number, number]): Cell[] =>
        cells.filter((c) => c.bbox[0] <= bbox[2] && c.bbox[2] >= bbox[0] && c.bbox[1] <= bbox[3] && c.bbox[3] >= bbox[1]);
}

describe('selectCorridorCells', () => {
    it('keeps engine-scale routes byte-identical to the padded bbox', () => {
        // A 20 NM hop — well inside MAX_INSHORE_NM. The engine may request the
        // whole padded box for this route, so the prefetch must keep covering
        // it, corners included.
        const pins = [
            { lat: -27.0, lon: 153.2 },
            { lat: -27.3, lon: 153.3 },
        ];
        const corner = cell('corner', -27.0 - 0.3, 153.3 + 0.3);
        const cells = [cell('mid', -27.15, 153.25), corner];

        const picked = selectCorridorCells(pins, inBBox(cells));
        const bboxPicked = inBBox(cells)(corridorBBox(pins));
        expect(picked.map((c) => c.id).sort()).toEqual(bboxPicked.map((c) => c.id).sort());
        expect(picked.some((c) => c.id === 'corner')).toBe(true);
    });

    it('trims a passage-scale trace to cells near the line', () => {
        // Moreton Bay to the southern GBR — the span that produced the storm.
        const pins = [
            { lat: -27.3, lon: 153.2 },
            { lat: -25.5, lon: 153.1 },
            { lat: -23.9, lon: 152.4 }, // Lady Musgrave water
        ];
        const nearLine = cell('near-line', -25.5, 153.1);
        // Inside the old padded bbox (pad ≈ 1.7°) but ~1.5° from any leg —
        // rain of cells like this over the reef WAS the hydration storm.
        const farCorner = cell('far-corner', -24.0, 154.9);
        const picked = selectCorridorCells(pins, inBBox([nearLine, farCorner]));

        expect(picked.some((c) => c.id === 'near-line')).toBe(true);
        expect(picked.some((c) => c.id === 'far-corner')).toBe(false);
    });

    it('keeps cells a long leg vaults over without an endpoint nearby', () => {
        // A single 2°-long leg passes straight over a small mid-leg cell whose
        // bbox holds neither endpoint. The crossing test must keep it — that
        // is water the boat actually transits.
        const pins = [
            { lat: -26.0, lon: 153.0 },
            { lat: -24.0, lon: 153.0 },
        ];
        const midLeg = cell('mid-leg', -25.0, 153.0, 0.1);
        const picked = selectCorridorCells(pins, inBBox([midLeg]));
        expect(picked.some((c) => c.id === 'mid-leg')).toBe(true);
    });

    it('pins the constants to the engine contract they derive from', () => {
        // 50 NM ≈ 0.83°; the corridor pad is that span × 0.5. If MAX_INSHORE_NM
        // ever moves, these must move with it — the derivation is the point.
        expect(ENGINE_MAX_SPAN_DEG).toBeCloseTo(0.84, 2);
        expect(CORRIDOR_PAD_DEG).toBeCloseTo(0.42, 2);
    });
});
