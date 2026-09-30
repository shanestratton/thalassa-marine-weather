/**
 * Owner decision 9 (Shane, 2026-09-30): SURVEY QUALITY ON THE ROUTE — "Yes,
 * amber on the route". Decisions 3 and 4 (read on the leads since round 1)
 * read on the route too:
 *   • A1 0.5 m + 1%, A2 / B 1.0 m + 2%, C 2.0 m + 5% of the depth: where the
 *     charted depth less that error is below draft + UKC, the stretch is amber
 *     — "survey may be out by X m";
 *   • CATZOC D / U, or no grade at all: amber — "old or ungraded survey";
 *   • a cell whose data carries no M_QUAL layer at all: "survey quality not
 *     checked on this chart" (decision 8's way), never amber.
 * The route still goes: disclosure only — never a refusal, never a path cost.
 * The grade at a spot is the FINEST survey's there; a finer cell with no zone
 * on the spot never borrows a coarser cell's grade.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import type { InshoreLayers } from '../../services/engine/types';
import { collectSurveyRuns } from '../../services/engine/shallowRuns';
import { surveyVerdict } from '../../services/routing/leadReview';

const rect = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
                [x0, y0],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const band = (lat: number, x0: number, x1: number, DRVAL1: number, rank?: number) =>
    rect(x0, lat - 0.02, x1, lat + 0.02, {
        acronym: 'DEPARE',
        DRVAL1,
        DRVAL2: DRVAL1 + 5,
        ...(rank !== undefined ? { _scaleRank: rank } : {}),
    });
const zone = (lat: number, x0: number, x1: number, CATZOC: number | null, rank?: number) =>
    rect(x0, lat - 0.03, x1, lat + 0.03, {
        acronym: 'M_QUAL',
        ...(CATZOC !== null ? { CATZOC } : {}),
        ...(rank !== undefined ? { _scaleRank: rank } : {}),
    });

/** A straight line along `lat` from x0 to x1, in 1 km segments. */
const line = (lat: number, x0: number, x1: number): [number, number][] => {
    const n = 10;
    return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, lat] as [number, number]);
};
const DRAFT = 2.4;
const UKC = 0.5;
const kmOf = (runs: { lengthM: number }[]) => runs.reduce((m, r) => m + r.lengthM, 0) / 1000;

describe('the one survey rule (leadReview surveyVerdict), shared by the leads and the route', () => {
    it('A1 / A2 / B / C read their error against draft + UKC; D, U and no grade never clear', () => {
        const need = DRAFT + UKC;
        expect(surveyVerdict(1, 10, need)).toEqual({ kind: 'ok' });
        expect(surveyVerdict(4, 4, need)).toEqual({ kind: 'margin', errorM: 2.2 });
        expect(surveyVerdict(4, 10, need)).toEqual({ kind: 'ok' }); // 10 − 2.5 = 7.5 ≥ 2.9
        expect(surveyVerdict(2, 3.5, need)).toMatchObject({ kind: 'margin' }); // 3.5 − 1.07 < 2.9
        expect(surveyVerdict(5, 30, need)).toEqual({ kind: 'poor' });
        expect(surveyVerdict(6, 30, need)).toEqual({ kind: 'poor' });
        expect(surveyVerdict(null, 30, need)).toEqual({ kind: 'ungraded' });
        // Charted shallower than the keel needs: a DEPTH matter (needs tide,
        // decisions 6 and 7), exactly as the leads read it — not a margin.
        expect(surveyVerdict(1, 2, need)).toEqual({ kind: 'ok' });
        expect(surveyVerdict(4, -1, need)).toEqual({ kind: 'ok' });
        // No charted depth: another rule's business (uncharted caution).
        expect(surveyVerdict(4, null, need)).toEqual({ kind: 'ok' });
    });

    // Round-3 review (2026-09-30): decision 9's own words ("where charted
    // depth minus the zone error is below draft + UKC") cover water already
    // charted shallower than the keel needs. The ROUTE reads it so (belowNeed):
    // the stretch is red already; its tide chip, worked from the charted depth
    // alone, now carries "survey may be out by 2.1 m", and so does the caveat.
    // The leads keep the depth reading (decision 6: needs tide already).
    it('the route reads water charted below the keel’s need as a margin too (belowNeed)', () => {
        const need = DRAFT + UKC;
        expect(surveyVerdict(4, 2, need, { belowNeed: true })).toEqual({ kind: 'margin', errorM: 2.1 });
        expect(surveyVerdict(1, 2, need, { belowNeed: true })).toMatchObject({ kind: 'margin' });
        expect(surveyVerdict(4, 2, need)).toEqual({ kind: 'ok' });
        expect(surveyVerdict(5, 2, need, { belowNeed: true })).toEqual({ kind: 'poor' });
        expect(surveyVerdict(4, null, need, { belowNeed: true })).toEqual({ kind: 'ok' });
    });
});

describe('a tide chip in poor-survey water says the survey error (round-3 review, 2026-09-30)', () => {
    it('a C survey over a 2 m band: the stretch is a survey margin of 2.1 m under the red', () => {
        const lat = -27.52;
        const out = collectSurveyRuns({
            layers: { DEPARE: fc(band(lat, 153.38, 153.52, 2, 5500)), M_QUAL: fc(zone(lat, 153.38, 153.52, 4, 5500)) },
            polyline: line(lat, 153.4, 153.5),
            draftM: DRAFT,
            safetyM: UKC,
        });
        expect(out.surveyRuns).toHaveLength(1);
        expect(out.surveyRuns[0]).toMatchObject({ reason: 'survey-margin', catzoc: 4, errorM: 2.1, minDepthM: 2 });
    });
});

describe('collectSurveyRuns — the stretches of a finished route', () => {
    const lat = -27.5;
    const base = { DEPARE: fc(band(lat, 153.38, 153.52, 4, 5500)) };

    it('an A1 survey over 4 m is fine for this keel; a C survey over the same 4 m may be out by 2.2 m', () => {
        const poly = line(lat, 153.4, 153.5);
        const good = collectSurveyRuns({
            layers: { ...base, M_QUAL: fc(zone(lat, 153.38, 153.52, 1, 5500)) },
            polyline: poly,
            draftM: DRAFT,
            safetyM: UKC,
        });
        expect(good.surveyRuns).toEqual([]);
        expect(good.surveyMask.some(Boolean)).toBe(false);

        const rough = collectSurveyRuns({
            layers: { ...base, M_QUAL: fc(zone(lat, 153.45, 153.52, 4, 5500), zone(lat, 153.38, 153.45, 1, 5500)) },
            polyline: poly,
            draftM: DRAFT,
            safetyM: UKC,
        });
        expect(rough.surveyRuns).toHaveLength(1);
        const r = rough.surveyRuns[0];
        expect(r).toMatchObject({ reason: 'survey-margin', catzoc: 4, errorM: 2.2, minDepthM: 4 });
        // Its exact start: the zone edge half-way along, not a whole segment.
        expect(r.startSeg + r.startT).toBeCloseTo(5, 1);
        expect(r.endSeg + r.endT).toBeCloseTo(10, 5);
        expect(kmOf(rough.surveyRuns)).toBeCloseTo(4.94, 1);
        expect(rough.surveyMask).toEqual([false, false, false, false, false, true, true, true, true, true]);
    });

    it('CATZOC D or U is "poor"; a zone with no CATZOC, or water no zone covers, is "ungraded"', () => {
        const poly = line(lat, 153.4, 153.5);
        const out = collectSurveyRuns({
            layers: {
                DEPARE: fc(band(lat, 153.38, 153.52, 20, 5500)),
                M_QUAL: fc(
                    zone(lat, 153.38, 153.42, 5, 5500),
                    zone(lat, 153.42, 153.44, 6, 5500),
                    zone(lat, 153.44, 153.46, null, 5500),
                    // 153.46–153.48 uncovered by any zone of the cell
                    zone(lat, 153.48, 153.52, 1, 5500),
                ),
            },
            polyline: poly,
            draftM: DRAFT,
            safetyM: UKC,
        });
        expect(out.surveyRuns.map((r) => [r.reason, r.catzoc])).toEqual([
            ['survey-poor', 6],
            ['survey-ungraded', null],
        ]);
        expect(out.surveyRuns[0].lengthM).toBeGreaterThan(3900);
        expect(out.surveyRuns[1].lengthM).toBeGreaterThan(3900);
        expect(out.uncheckedCells).toEqual([]);
    });

    it('a finer cell with no zone on the spot never borrows a coarser cell’s A1 grade', () => {
        const poly = line(lat, 153.4, 153.5);
        const layers: InshoreLayers = {
            DEPARE: fc(
                band(lat, 153.38, 153.52, 20, 3500), // coarse cell, A1 zone everywhere
                band(lat, 153.44, 153.46, 20, 5500), // a finer cell's band here
            ),
            M_QUAL: fc(zone(lat, 153.38, 153.52, 1, 3500)),
        };
        const ungraded = collectSurveyRuns({ layers, polyline: poly, draftM: DRAFT, safetyM: UKC });
        expect(ungraded.surveyRuns.map((r) => r.reason)).toEqual(['survey-ungraded']);
        expect(ungraded.surveyRuns[0].lengthM).toBeGreaterThan(1900);
        expect(ungraded.surveyRuns[0].lengthM).toBeLessThan(2100);

        // …and when that finer cell's data carries no M_QUAL at all, it was
        // not checked — a caveat, never amber.
        const unchecked = collectSurveyRuns({
            layers,
            polyline: poly,
            draftM: DRAFT,
            safetyM: UKC,
            uncheckedCells: [{ id: 'FINE', bbox: [153.44, lat - 0.02, 153.46, lat + 0.02], rank: 5500 }],
        });
        expect(unchecked.surveyRuns.map((r) => [r.reason, r.cellIds])).toEqual([['survey-unchecked', ['FINE']]]);
        expect(unchecked.uncheckedCells).toEqual(['FINE']);
        expect(unchecked.surveyMask.some(Boolean)).toBe(false);
    });

    it('a coarser cell with no M_QUAL under a finer graded cell changes nothing', () => {
        const out = collectSurveyRuns({
            layers: {
                DEPARE: fc(band(lat, 153.38, 153.52, 20, 3500), band(lat, 153.38, 153.52, 20, 5500)),
                M_QUAL: fc(zone(lat, 153.38, 153.52, 1, 5500)),
            },
            polyline: line(lat, 153.4, 153.5),
            draftM: DRAFT,
            safetyM: UKC,
            uncheckedCells: [{ id: 'OVERVIEW', bbox: [150, -30, 180, 0], rank: 1352 }],
        });
        expect(out.surveyRuns).toEqual([]);
    });
});

describe('the route: amber disclosure only — never a cost, never a refusal', () => {
    const isResult = (r: ReturnType<typeof routeInshore>): r is RouteResult => 'polyline' in r;
    const lat = -26.5;
    const q: RouteRequest = {
        fromLat: lat,
        fromLon: 153.4,
        toLat: lat,
        toLon: 153.5,
        draftM: DRAFT,
        safetyM: UKC,
        resolutionM: 50,
    };
    const depth = fc(band(lat, 153.3, 153.6, 12, 5500));

    it('the same line with and without a poor survey; the poor stretch rides the result', () => {
        const plain = routeInshore({ DEPARE: depth }, q);
        // The same request both times (the second is a grid-cache hit: M_QUAL
        // is not part of the grid or its key), so the route must not move
        // with the survey either way.
        const poor = routeInshore({ DEPARE: depth, M_QUAL: fc(zone(lat, 153.3, 153.6, 5, 5500)) }, q);
        expect(isResult(plain) && isResult(poor)).toBe(true);
        if (!isResult(plain) || !isResult(poor)) return;
        expect(poor.polyline).toEqual(plain.polyline);
        expect(poor.cautionMask).toEqual(plain.cautionMask);
        expect(plain.surveyRuns).toEqual([]);
        expect(poor.surveyRuns?.map((r) => r.reason)).toEqual(['survey-poor']);
        expect(poor.surveyRuns?.[0].lengthM).toBeGreaterThan(9000);
    });

    it('says which cells were not checked', () => {
        const r = routeInshore(
            { DEPARE: depth },
            { ...q, surveyUncheckedCells: [{ id: 'OC-TEST', bbox: [153.3, lat - 0.1, 153.6, lat + 0.1], rank: 5500 }] },
        );
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.surveyUncheckedCells).toEqual(['OC-TEST']);
        expect(r.surveyRuns?.every((s) => s.reason === 'survey-unchecked')).toBe(true);
    });
});
