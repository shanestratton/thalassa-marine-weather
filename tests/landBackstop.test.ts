/**
 * Land backstop tests — the caller-side sweep that rejects inshore routes
 * crossing land through chart-coverage gaps (Newport→Mooloolaba field bug:
 * the engine routed dead-straight over Bribie Island with zero caution
 * because uncharted space is engine-navigable).
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import {
    findLandRuns,
    inshoreRouteCrossesLand,
    LONE_SAMPLE_END_CLEARANCE_M,
    MAX_OSM_WATER_BRIDGE_SAMPLES,
    samplePolyline,
    MIN_RUN_SAMPLES,
    type LonLat,
} from '../services/routing/landBackstop';
import {
    chartedLandFinding,
    landBackstopFinding,
    landBackstopRefusal,
    landBackstopTitle,
} from '../services/routing/landBackstopWords';
import type { DepthResult } from '../services/GebcoDepthService';
import { GebcoDepthService } from '../services/GebcoDepthService';
import { backstopChartWaterProbe } from '../services/engine/safetyAudit';
import {
    BACKSTOP_MIN_VOUCH_BAND,
    backstopVerdict,
    isBackstopOsmWater,
    type ChartWaterProbe,
    type ChartWaterVerdict,
} from '../services/engine/chartWaterEvidence';
import { cellFinenessRank } from '../services/enc/scaleShadow';

const d = (depth: number | null, i = 0): DepthResult => ({ lat: -27 - i * 0.001, lon: 153, depth_m: depth });

/** NOAA ETOPO as the backstop asks for it (GebcoDepthService.queryRouteRelief,
 *  one grid request per route since 2026-10-02). */
function etopo(depthAt: (lat: number, lon: number, index: number) => number | null) {
    return vi.spyOn(GebcoDepthService, 'queryRouteRelief').mockImplementation(async (points) => {
        const depths = points.map(({ lat, lon }, index) => ({ lat, lon, depth_m: depthAt(lat, lon, index) }));
        const missing = depths.filter((x) => x.depth_m === null).length;
        return {
            depths,
            failure: missing > 0 ? { kind: 'partial' as const, missing, total: points.length } : null,
            requests: 1,
        };
    });
}

describe('findLandRuns', () => {
    it('clean water → no runs', () => {
        expect(findLandRuns([d(-20), d(-15), d(-8), d(-30)])).toEqual([]);
    });

    it('a solid island reads as one long run', () => {
        const runs = findLandRuns([d(-20), d(0), d(5), d(12), d(3), d(-18)]);
        expect(runs.length).toBe(1);
        expect(runs[0].startIdx).toBe(1);
        expect(runs[0].samples).toBe(4);
    });

    it('a single coastal-pixel kiss is below the rejection threshold', () => {
        const runs = findLandRuns([d(-20), d(1), d(-20)]);
        expect(runs.length).toBe(1);
        expect(runs[0].samples).toBe(1);
        expect(runs[0].samples).toBeLessThan(MIN_RUN_SAMPLES); // caller filters it out
    });

    it('null depths (ETOPO fetch gaps) break runs — unknown is not land', () => {
        const runs = findLandRuns([d(2), d(null), d(2)]);
        expect(runs.length).toBe(2);
        expect(runs.every((r) => r.samples === 1)).toBe(true);
    });

    it('dredged channels (negative ETOPO elevation) never read as land', () => {
        expect(findLandRuns([d(-2.1), d(-1.5), d(-3)])).toEqual([]);
    });
});

describe('inshoreRouteCrossesLand', () => {
    const route: LonLat[] = [
        [153, -27],
        [153.01, -27],
    ];

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('verifies a fully sampled below-sea-level ocean route', async () => {
        etopo(() => -25);

        await expect(inshoreRouteCrossesLand(route)).resolves.toMatchObject({
            status: 'verified',
            crossesLand: false,
        });
    });

    it('rejects a positive-elevation island run', async () => {
        etopo((_lat, _lon, index) => (index === 0 ? -25 : 4));

        await expect(inshoreRouteCrossesLand(route)).resolves.toMatchObject({
            status: 'verified',
            crossesLand: true,
        });
    });

    it('reports null depth coverage as unavailable instead of clear', async () => {
        etopo((_lat, _lon, index) => (index === 1 ? null : -25));

        const result = await inshoreRouteCrossesLand(route);
        expect(result.status).toBe('unavailable');
        expect(result.crossesLand).toBe(false);
        expect(result.samplesChecked).toBeLessThan(result.samplesRequested);
    });
});

describe('samplePolyline', () => {
    it('samples a long leg at the step interval, both ends included', () => {
        // ~11.1 km due north → ~28 samples at 400 m + endpoints
        const line: LonLat[] = [
            [153, -27.0],
            [153, -26.9],
        ];
        const samples = samplePolyline(line, 400, 180);
        expect(samples.length).toBeGreaterThan(25);
        expect(samples.length).toBeLessThan(32);
        expect(samples[0]).toEqual([153, -27.0]);
        expect(samples[samples.length - 1]).toEqual([153, -26.9]);
    });

    it('caps total samples on very long routes', () => {
        const line: LonLat[] = [
            [153, -27.5],
            [153, -25.0], // ~278 km
        ];
        const samples = samplePolyline(line, 400, 180);
        expect(samples.length).toBeLessThanOrEqual(181);
    });

    it('degenerate input passes through', () => {
        expect(samplePolyline([[153, -27]] as LonLat[])).toEqual([[153, -27]]);
    });
});

// ── Where the charts say water (2026-10-02, Coral Sea Marina → Daydream) ─────
//
// Shane's phone at Airlie Beach: ETOPO's ~1.8 km pixels read the marina, its
// dredged channel and the 5–30 m water off a headland as land, and Auto
// refused a route the 1:12,000 and 1:90,000 cells chart end to end. An ETOPO
// land sample now counts only where the route's own charts do not vouch for
// water — a chart finer than ETOPO's pixel (usage band 3+), never drying
// under the decision-1 finest-band rule, or the route's own OSM water.
// Synthetic geometry only: an invented strip of the Tasman Sea near 161 E,
// 31 S (the repo is public; no real chart data).

const LAT = -31.0;
/** A route due east along 31 S, 161.00 → 161.06 E (~5.7 km, ~15 samples). */
const EAST: LonLat[] = [
    [161.0, LAT],
    [161.06, LAT],
];
const box = (w: number, e: number, s = LAT - 0.01, n = LAT + 0.01): Polygon => ({
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
});
/** A feature of a cell compiled at `scale`, stamped as the engine's merge stamps it. */
const chart = (acronym: string, g: Polygon, scale: number, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: { acronym, ...props, _scaleRank: cellFinenessRank({ nativeScale: scale }) },
    geometry: g,
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const HARBOUR = 12_000; // band 5, like AU5WSY01
const COASTAL = 90_000; // band 4, like AU421148
const GENERAL = 1_500_000; // band 2, like AU230140
const OVERVIEW = 3_500_000; // band 1, like AU130120

/** ETOPO reads land (4 m) between these longitudes, sea (-20 m) elsewhere. */
function etopoLandBetween(...spans: [number, number][]): void {
    etopo((_lat, lon) => (spans.some(([w, e]) => lon >= w && lon <= e) ? 4 : -20));
}

describe('the satellite land check where the charts say water', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('ignores a shore run a detailed chart charts as never-drying water — and says so', async () => {
        // The Airlie headland: the overview's generalised land paint bulges over
        // water the 1:90,000 cell charts 10–20 m deep; ETOPO reads it land.
        const probe = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(161.01, 161.03), OVERVIEW)),
            DEPARE: fc(chart('DEPARE', box(160.99, 161.07), COASTAL, { DRVAL1: 10, DRVAL2: 20 })),
        });
        etopoLandBetween([161.01, 161.03]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: probe });
        expect(result).toMatchObject({ status: 'verified', crossesLand: false, runs: [], ignoredRuns: 1 });
        expect(result.vouchedLandSamples).toBeGreaterThanOrEqual(MIN_RUN_SAMPLES);
        expect(
            warn.mock.calls.some((args) =>
                args.some(
                    (a) =>
                        typeof a === 'string' &&
                        a.includes(`ignored ${result.vouchedLandSamples} ETOPO land sample(s) (1 whole run(s))`),
                ),
            ),
            'the ignored run is logged with its count',
        ).toBe(true);
        // Without the charts' word, the same ETOPO reading is a crossing (as before).
        await expect(inshoreRouteCrossesLand(EAST)).resolves.toMatchObject({ crossesLand: true });
    });

    it('still rejects a chart gap — the Bribie case: no cell covers the island ETOPO calls land', async () => {
        const probe = backstopChartWaterProbe({
            DEPARE: fc(
                chart('DEPARE', box(160.99, 161.01), COASTAL, { DRVAL1: 10 }),
                chart('DEPARE', box(161.04, 161.07), COASTAL, { DRVAL1: 10 }),
            ),
        });
        etopoLandBetween([161.015, 161.035]);
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: probe });
        expect(result).toMatchObject({ status: 'verified', crossesLand: true });
        expect(result.runs[0].charts).toBe('uncharted');
        expect(landBackstopFinding(result)).toMatch(
            /^Satellite relief shows land near 31\.000° S, 161\.0[23]\d° E, where none of the charts used for this route is detailed enough to say whether it is water\.$/,
        );
    });

    it('never lets an overview or general cell vouch: a small island no detailed chart covers is rejected', async () => {
        // Armit Island: ~1 km, generalised away by the 1:1.5M and 1:3.5M cells
        // (their depth bands run straight over it); only the 1:90,000 has it.
        // Here no detailed chart covers it at all.
        const probe = backstopChartWaterProbe({
            DEPARE: fc(
                chart('DEPARE', box(160.99, 161.07), GENERAL, { DRVAL1: 20 }),
                chart('DEPARE', box(160.99, 161.07), OVERVIEW, { DRVAL1: 20 }),
                chart('DEPARE', box(160.99, 161.015), COASTAL, { DRVAL1: 10 }),
                chart('DEPARE', box(161.035, 161.07), COASTAL, { DRVAL1: 10 }),
            ),
        });
        etopoLandBetween([161.02, 161.03]);
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: probe });
        expect(result).toMatchObject({ status: 'verified', crossesLand: true });
        expect(result.runs[0].charts).toBe('uncharted');
        expect(result.vouchedLandSamples).toBe(0);
    });

    it('where a detailed chart and an overview overlap, the finest survey decides (decision 1)', async () => {
        // The island IS in the 1:90,000 cell: its land beats the overview's band.
        const island = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(161.02, 161.03), COASTAL)),
            DEPARE: fc(chart('DEPARE', box(160.99, 161.07), OVERVIEW, { DRVAL1: 20 })),
        });
        etopoLandBetween([161.02, 161.03]);
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: island });
        expect(result).toMatchObject({ status: 'verified', crossesLand: true });
        expect(result.runs[0].charts).toBe('land');
        expect(landBackstopRefusal(result)).toMatch(
            /^Satellite relief shows land near 31\.000° S, 161\.02\d° E, and the installed charts show land or drying ground there too\. The route is not shown\. Plot this passage in Manual\. Nothing changed\.$/,
        );
        // A harbour band that never dries beats the coastal land paint: water.
        const p = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(161.02, 161.03), COASTAL)),
            DEPARE: fc(chart('DEPARE', box(161.02, 161.03), HARBOUR, { DRVAL1: 1.8 })),
        });
        expect(p(161.025, LAT)).toBe('water');
        // …and one that dries leaves it land; so does an equal-scale band.
        const drying = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(161.02, 161.03), OVERVIEW)),
            DEPARE: fc(chart('DEPARE', box(161.02, 161.03), HARBOUR, { DRVAL1: -0.5 })),
        });
        expect(drying(161.025, LAT)).toBe('land');
        const equal = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(161.02, 161.03), COASTAL)),
            DEPARE: fc(chart('DEPARE', box(161.02, 161.03), COASTAL, { DRVAL1: 5 })),
        });
        expect(equal(161.025, LAT)).toBe('land');
    });

    it('a mixed run is judged by its unvouched samples alone', async () => {
        // ETOPO reads land from 161.01 to 161.04; the charts vouch the western
        // half only. The eastern half still makes a run: rejected, there.
        const half: ChartWaterProbe = (lon) => (lon < 161.025 ? 'water' : 'uncharted');
        etopoLandBetween([161.01, 161.04]);
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: half });
        expect(result.crossesLand).toBe(true);
        expect(result.runs).toHaveLength(1);
        expect(result.runs[0].lon).toBeGreaterThanOrEqual(161.025);
        expect(result.runs[0].samples).toBeGreaterThanOrEqual(MIN_RUN_SAMPLES);
        expect(result.ignoredRuns).toBe(0);
        // One unvouched sample where ETOPO reads water either side is a
        // coastal kiss, not a run (as before)…
        const samples = samplePolyline(EAST);
        const lone = samples[Math.floor(samples.length / 2)][0];
        const one: ChartWaterProbe = (lon) => (Math.abs(lon - lone) < 1e-9 ? 'uncharted' : 'water');
        etopoLandBetween([lone - 1e-6, lone + 1e-6]);
        await expect(inshoreRouteCrossesLand(EAST, { chartWater: one })).resolves.toMatchObject({
            status: 'verified',
            crossesLand: false,
            ignoredRuns: 0,
        });
        // …but where ETOPO reads land across it and the detailed charts vouch
        // for water on both sides, the charts have a hole there that ETOPO
        // calls land (review fix-up, 2026-10-02: an island whose land paint
        // did not merge): rejected.
        etopoLandBetween([161.01, 161.05]);
        const hole = await inshoreRouteCrossesLand(EAST, { chartWater: one });
        expect(hole).toMatchObject({ status: 'verified', crossesLand: true });
        expect(hole.runs).toHaveLength(1);
        expect(hole.runs[0]).toMatchObject({ samples: 1, charts: 'uncharted' });
        expect(hole.runs[0].lon).toBeCloseTo(lone, 9);
    });

    it("ignores ETOPO land over the route's own OSM marina water, even with only overview cells", async () => {
        const probe = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(160.99, 161.07), OVERVIEW)),
            // As the engine injects an OSM marina: no S-57 identity, leisure=marina.
            DEPARE: fc({
                type: 'Feature',
                properties: { leisure: 'marina', DRVAL1: 5, DRVAL2: 5 },
                geometry: box(160.995, 161.025),
            }),
        });
        etopoLandBetween([161.0, 161.02]);
        await expect(
            inshoreRouteCrossesLand(
                [
                    [161.0, LAT],
                    [161.02, LAT],
                ],
                { chartWater: probe },
            ),
        ).resolves.toMatchObject({ status: 'verified', crossesLand: false, ignoredRuns: 1 });
    });

    it('unavailable ETOPO stays unavailable whatever the charts say', async () => {
        const water: ChartWaterProbe = () => 'water';
        etopo((_lat, _lon, i) => (i === 1 ? null : 4));
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: water });
        expect(result.status).toBe('unavailable');
        expect(result.crossesLand).toBe(false);
        vi.spyOn(GebcoDepthService, 'queryRouteRelief').mockResolvedValue({
            depths: [],
            failure: { kind: 'bad-answer' },
            requests: 1,
        });
        await expect(inshoreRouteCrossesLand(EAST, { chartWater: water })).resolves.toMatchObject({
            status: 'unavailable',
        });
    });

    it('a probe that throws vouches nothing (fail closed)', async () => {
        const broken: ChartWaterProbe = () => {
            throw new Error('bad geometry');
        };
        etopoLandBetween([161.01, 161.03]);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: broken });
        expect(result).toMatchObject({ status: 'verified', crossesLand: true });
        expect(result.runs[0].charts).toBe('unchecked');
        expect(landBackstopRefusal(result)).toMatch(
            /^Satellite relief shows land near 31\.000° S, 161\.0\d\d° E\. The route is not shown\. Check that stretch on a detailed chart, or plot this passage in Manual\. Nothing changed\.$/,
        );
    });
});

// ── A lone sample can be an island (review fix-up, 2026-10-02) ─────────────
//
// On the real Whitsunday cells a straight line across Daydream Island (0.3 ×
// 1.1 km, charted at 1:90,000) passed: one land sample between two the charts
// vouch for made a "run" of 1. And OSM ponds inside Hamilton Island split its
// land run. Same synthetic Tasman strip as above.

describe('the satellite land check — small islands and OSM water', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    const samples = samplePolyline(EAST);
    /** A box `halfM` metres either side of sample k's longitude. */
    const around = (k: number, halfM: number): [number, number] => {
        const dLon = halfM / (111_320 * Math.cos((LAT * Math.PI) / 180));
        return [samples[k][0] - dLon, samples[k][0] + dLon];
    };
    /** Coastal (1:90,000) never-drying water either side of [w, e], an
     *  overview band over everything — as a real chart holes its DEPARE. */
    const seaAround = ([w, e]: [number, number]) => [
        chart('DEPARE', box(160.99, w), COASTAL, { DRVAL1: 10, DRVAL2: 20 }),
        chart('DEPARE', box(e, 161.07), COASTAL, { DRVAL1: 10, DRVAL2: 20 }),
        chart('DEPARE', box(160.99, 161.07), OVERVIEW, { DRVAL1: 0 }),
    ];

    it('a ≤400 m charted island with vouched water on both sides is rejected (Daydream, straight across)', async () => {
        const k = Math.floor(samples.length / 2);
        const island = around(k, 150); // ~300 m wide
        const probe = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(...island), COASTAL)),
            DEPARE: fc(...seaAround(island)),
        });
        expect(probe(samples[k][0], LAT)).toBe('land');
        expect(probe(samples[k - 1][0], LAT)).toBe('water');
        expect(probe(samples[k + 1][0], LAT)).toBe('water');
        // ETOPO's pixel reads land well beyond the island, over vouched water.
        etopoLandBetween([samples[k - 2][0], samples[k + 2][0]]);
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: probe });
        expect(result).toMatchObject({ status: 'verified', crossesLand: true });
        expect(result.runs).toHaveLength(1);
        expect(result.runs[0]).toMatchObject({ startIdx: k, samples: 1, charts: 'land' });
        expect(landBackstopTitle(result)).toBe('Inshore route rejected — crosses charted land');
        // …and where ETOPO reads land at the island alone.
        etopoLandBetween(island);
        await expect(inshoreRouteCrossesLand(EAST, { chartWater: probe })).resolves.toMatchObject({
            crossesLand: true,
            runs: [{ startIdx: k, samples: 1, charts: 'land' }],
        });
    });

    it(`a lone charted-land sample within ${LONE_SAMPLE_END_CLEARANCE_M} m of an end is that pin's own (decision 7)`, async () => {
        for (const [k, rejected] of [
            [1, false], // ~400 m from the start
            [2, true], // ~800 m
            [samples.length - 2, false], // ~400 m from the end
        ] as const) {
            const island = around(k, 100);
            const probe = backstopChartWaterProbe({
                LNDARE: fc(chart('LNDARE', box(...island), HARBOUR)),
                DEPARE: fc(...seaAround(island)),
            });
            etopoLandBetween(island);
            const result = await inshoreRouteCrossesLand(EAST, { chartWater: probe });
            expect(result.crossesLand, `island at sample ${k}`).toBe(rejected);
            expect(result.status).toBe('verified');
        }
    });

    it('the island whose land paint did not merge: a hole in the detailed charts, small-scale land there', async () => {
        const k = Math.floor(samples.length / 2);
        const island = around(k, 150);
        const probe = backstopChartWaterProbe({
            // Only the overview paints the island; the detailed DEPARE holes it.
            LNDARE: fc(chart('LNDARE', box(...island), OVERVIEW)),
            DEPARE: fc(...seaAround(island)),
        });
        expect(probe(samples[k][0], LAT)).toBe('uncharted-land');
        etopoLandBetween([samples[k - 2][0], samples[k + 2][0]]);
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: probe });
        expect(result).toMatchObject({ status: 'verified', crossesLand: true });
        expect(result.runs[0]).toMatchObject({ startIdx: k, samples: 1, charts: 'uncharted', smallScaleLand: true });
        expect(landBackstopFinding(result)).toMatch(
            /^Satellite relief shows land near 31\.000° S, 161\.0\d\d° E, where none of the charts used for this route is detailed enough to say whether it is water, and the small-scale chart there shows land too\.$/,
        );
        expect(landBackstopRefusal(result)).toMatch(
            / Check that stretch on a detailed chart, or plot this passage in Manual\. Nothing changed\.$/,
        );
        expect(landBackstopRefusal(result)).not.toMatch(/install/i);
        expect(landBackstopTitle(result)).toBe('Inshore route rejected — possible chart gap');
    });

    it('OSM water the charts do not vouch for neither counts nor breaks a run (Hamilton Island)', async () => {
        // A ~1.2 km island only the overview paints, with an OSM lake on the
        // middle sample: it used to vouch, splitting land / water / land into
        // two lone samples that passed.
        const k = Math.floor(samples.length / 2);
        const island: [number, number] = [around(k - 1, 60)[0], around(k + 1, 60)[1]];
        const lake = around(k, 60);
        const probe = backstopChartWaterProbe({
            LNDARE: fc(chart('LNDARE', box(...island), OVERVIEW)),
            DEPARE: fc({
                type: 'Feature',
                properties: { natural: 'water', water: 'lake', DRVAL1: 10, DRVAL2: 10 },
                geometry: box(...lake),
            }),
        });
        expect(probe(samples[k][0], LAT)).toBe('osm-water');
        etopoLandBetween(island);
        const result = await inshoreRouteCrossesLand(EAST, { chartWater: probe });
        expect(result).toMatchObject({ status: 'verified', crossesLand: true, osmWaterSamples: 1 });
        expect(result.runs).toHaveLength(1);
        expect(result.runs[0]).toMatchObject({ startIdx: k - 1, samples: 2, charts: 'uncharted' });
    });

    it(`a longer OSM-only stretch (over ${MAX_OSM_WATER_BRIDGE_SAMPLES} samples) is water on the way, and breaks the run`, async () => {
        // Up a river no detailed chart covers: two stray samples off the OSM
        // river polygon, kilometres apart, are not one crossing.
        const k = Math.floor(samples.length / 2);
        const at = (n: number) => samples[n][0];
        const probeFor =
            (osm: number[]): ChartWaterProbe =>
            (lon) =>
                osm.some((n) => Math.abs(lon - at(n)) < 1e-9) ? 'osm-water' : 'uncharted';
        etopoLandBetween([at(k - 2) - 1e-6, at(k + 2) + 1e-6]);
        // k-2 and k+2 off the polygon, three OSM samples between: no run.
        await expect(inshoreRouteCrossesLand(EAST, { chartWater: probeFor([k - 1, k, k + 1]) })).resolves.toMatchObject(
            { status: 'verified', crossesLand: false, osmWaterSamples: 3 },
        );
        // Two between: bridged, one run of two.
        etopoLandBetween([at(k - 1) - 1e-6, at(k + 2) + 1e-6]);
        const bridged = await inshoreRouteCrossesLand(EAST, { chartWater: probeFor([k, k + 1]) });
        expect(bridged).toMatchObject({ status: 'verified', crossesLand: true, osmWaterSamples: 2 });
        expect(bridged.runs).toEqual([expect.objectContaining({ startIdx: k - 1, samples: 2, charts: 'uncharted' })]);
    });

    it('ponds and Mapbox / satellite water never speak for the satellite check; navigable OSM water does', () => {
        const island = box(161.02, 161.03);
        const probeWith = (props: Record<string, unknown>) =>
            backstopChartWaterProbe({
                LNDARE: fc(chart('LNDARE', island, COASTAL)),
                DEPARE: fc({ type: 'Feature', properties: { ...props, DRVAL1: 10, DRVAL2: 10 }, geometry: island }),
            })(161.025, LAT);
        for (const water of ['reservoir', 'pond', 'basin', 'lagoon', 'wastewater']) {
            expect(isBackstopOsmWater({ natural: 'water', water }), water).toBe(false);
            expect(probeWith({ natural: 'water', water }), water).toBe('land');
        }
        expect(isBackstopOsmWater({ natural: 'water', _source: 'mapbox-water' })).toBe(false);
        expect(probeWith({ natural: 'water', _source: 'mapbox-water' })).toBe('land');
        for (const props of [
            { leisure: 'marina' },
            { waterway: 'canal' },
            { waterway: 'dock' },
            { waterway: 'river' },
            { waterway: 'riverbank' },
            { natural: 'water', water: 'river' },
            { natural: 'water', water: 'canal' },
            { natural: 'water', water: 'harbour' },
            { harbour: 'yes' },
        ]) {
            expect(isBackstopOsmWater(props), JSON.stringify(props)).toBe(true);
            expect(probeWith(props), JSON.stringify(props)).toBe('osm-water');
        }
        // An S-57 band is never "OSM water".
        expect(isBackstopOsmWater({ acronym: 'DEPARE', natural: 'water' })).toBe(false);
    });
});

describe('the refusal words (review fix-up, 2026-10-02)', () => {
    const run = (charts: 'land' | 'uncharted' | 'unchecked') => ({
        runs: [{ startIdx: 3, samples: 2, lat: -20.2557, lon: 148.8142, charts }],
    });

    it("the planner's title follows what the charts say", () => {
        expect(landBackstopTitle(run('land'))).toBe('Inshore route rejected — crosses charted land');
        expect(landBackstopTitle(run('uncharted'))).toBe('Inshore route rejected — possible chart gap');
        expect(landBackstopTitle(run('unchecked'))).toBe('Inshore route rejected — possible chart gap');
        expect(landBackstopTitle({ runs: [] })).toBe('Inshore route rejected — possible chart gap');
        // A land run anywhere decides it.
        expect(landBackstopTitle({ runs: [...run('uncharted').runs, { ...run('land').runs[0], samples: 1 }] })).toBe(
            'Inshore route rejected — crosses charted land',
        );
    });

    it('an uncharted stretch never claims the chart is not installed', () => {
        expect(landBackstopFinding(run('uncharted'))).toBe(
            'Satellite relief shows land near 20.256° S, 148.814° E, where none of the charts used for this route is detailed enough to say whether it is water.',
        );
        expect(landBackstopRefusal(run('uncharted'))).not.toMatch(/install/i);
    });

    it("the engine's charted-land audit, in Auto's words", () => {
        expect(chartedLandFinding({ totalM: 380, awayM: 380, awayAt: [148.8142, -20.2557] })).toBe(
            'The only way Thalassa found crosses charted land near 20.256° S, 148.814° E.',
        );
        expect(chartedLandFinding({ totalM: 380, awayM: 380 })).toBe(
            'The only way Thalassa found crosses charted land.',
        );
        // Land at a pin's own edge only, no audit, or nonsense: nothing to say.
        expect(chartedLandFinding({ totalM: 40, awayM: 0 })).toBeNull();
        expect(chartedLandFinding(undefined)).toBeNull();
        expect(chartedLandFinding({ awayM: Number.NaN })).toBeNull();
    });
});

describe('backstopVerdict — only a chart finer than ETOPO may vouch', () => {
    const band = (rank: number | null, neverDries = true) => ({ rank, neverDries });
    const rankOf = (nativeScale: number) => cellFinenessRank({ nativeScale })!;

    it('the boundary is usage band 3: 1:350,000 vouches, 1:350,001 does not', () => {
        expect(BACKSTOP_MIN_VOUCH_BAND).toBe(3);
        expect(backstopVerdict(false, [band(rankOf(350_000))], [])).toBe('water');
        expect(backstopVerdict(false, [band(rankOf(350_001))], [])).toBe('uncharted');
        expect(backstopVerdict(false, [band(rankOf(1_500_000))], [])).toBe('uncharted');
        expect(backstopVerdict(false, [band(rankOf(3_500_000))], [])).toBe('uncharted');
    });

    it('a band known by its S-57 name alone vouches from band 3; an unranked band never does', () => {
        const byName = (name: string) => cellFinenessRank({ sourceCellId: name });
        expect(backstopVerdict(false, [band(byName('AU3SYN01'))], [])).toBe('water');
        expect(backstopVerdict(false, [band(byName('AU2SYN01'))], [])).toBe('uncharted');
        expect(backstopVerdict(false, [band(null)], [])).toBe('uncharted');
        expect(backstopVerdict(false, [], [])).toBe('uncharted');
    });

    it('drying ground, land of unknown scale, and overview-only land', () => {
        expect(backstopVerdict(false, [band(rankOf(90_000), false)], [])).toBe('land');
        // An OSM breakwater (unranked land) over a never-drying harbour band.
        expect(backstopVerdict(false, [band(rankOf(12_000))], [null])).toBe('land');
        // Overview land and an overview band: nobody detailed says anything,
        // and the small-scale chart paints land there (review fix-up,
        // 2026-10-02: the words must not imply water).
        expect(backstopVerdict(false, [band(rankOf(1_500_000))], [rankOf(3_500_000)])).toBe('uncharted-land');
        expect(backstopVerdict(false, [band(rankOf(1_500_000))], [])).toBe('uncharted');
    });

    it("OSM water is neutral where the charts do not vouch, and never beats a chart's water", () => {
        // Review fix-up, 2026-10-02: OSM water used to vouch first, over
        // detailed land and in chart gaps alike.
        expect(backstopVerdict(true, [], [rankOf(90_000)])).toBe('osm-water');
        expect(backstopVerdict(true, [], [])).toBe('osm-water');
        expect(backstopVerdict(true, [band(rankOf(90_000), false)], [])).toBe('osm-water');
        expect(backstopVerdict(true, [band(rankOf(90_000))], [])).toBe('water');
    });

    it('a band of unknown scale that dries cancels a vouch with land paint too', () => {
        // Review fix-up, 2026-10-02: the land-paint branch skipped it.
        const harbour = band(rankOf(12_000));
        expect(backstopVerdict(false, [harbour], [rankOf(3_500_000)])).toBe('water');
        expect(backstopVerdict(false, [harbour, band(null, false)], [rankOf(3_500_000)])).toBe('land');
        expect(backstopVerdict(false, [harbour, band(null, false)], [])).toBe('land');
        expect(backstopVerdict(false, [harbour, band(null, true)], [rankOf(3_500_000)])).toBe('water');
    });

    it('each verdict is one of five words', () => {
        const all: ChartWaterVerdict[] = ['water', 'osm-water', 'land', 'uncharted', 'uncharted-land'];
        expect(all).toContain(backstopVerdict(false, [band(rankOf(90_000))], [rankOf(3_500_000)]));
    });
});

describe('every caller passes the route’s own charts to the check', () => {
    it('Auto, the passage planner and the voyage form', () => {
        for (const [file, call] of [
            ['services/autoroutingThalassa.ts', 'inshoreRouteCrossesLand(polyline, { chartWater: ok.chartWater })'],
            ['components/map/usePassagePlanner.ts', 'chartWater: inshoreRes.chartWater'],
            ['hooks/useVoyageForm.ts', 'chartWater: inshoreRes.chartWater'],
        ] as const) {
            const source = readFileSync(file, 'utf8');
            expect(source, file).toContain(call);
            expect(source, file).toContain('landBackstop');
        }
        // …and the planner and the voyage form refuse the engine's own
        // charted land first, in Auto's words (review fix-up, 2026-10-02).
        for (const file of ['components/map/usePassagePlanner.ts', 'hooks/useVoyageForm.ts']) {
            const source = readFileSync(file, 'utf8');
            expect(source, file).toContain('chartedLandFinding(inshoreRes.hardLand)');
            expect(source.indexOf('chartedLandFinding(inshoreRes.hardLand)'), file).toBeLessThan(
                source.indexOf('await inshoreRouteCrossesLand('),
            );
        }
        expect(readFileSync('components/map/usePassagePlanner.ts', 'utf8')).toContain('landBackstopTitle(backstop)');
        expect(readFileSync('services/autoroutingThalassa.ts', 'utf8')).toContain('chartedLandFinding(ok.hardLand)');
        // The engine wrapper builds it on both of its success paths.
        const router = readFileSync('services/InshoreRouter.ts', 'utf8');
        expect(router).toContain('...routeChartWater(merged, g.polyline)');
        expect(router).toContain('...routeChartWater(merged, result.polyline)');
    });
});
