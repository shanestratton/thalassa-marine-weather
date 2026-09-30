/**
 * Phase 0 (Shane approved 2026-09-29): only real leads may lead.
 *
 * A chart NAVLNE is a lead only when it is a leading line (CATNAV 3). A
 * clearing line (CATNAV 1) marks the edge of a danger; a transit (CATNAV 2)
 * is a bearing. Before this gate every chart NAVLNE was pushed into the
 * engine's NAVLINE layer, where Pass 5b made a ~150 m corridor PREFERRED,
 * rescued shallow cells to max(draft + safety, 5 m) and reopened land-painted
 * cells — so a clearing line through a 1 m band read as 5 m deep channel.
 */
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { describe, expect, it } from 'vitest';
import { CAUTION } from '../services/engine/constants';
import { latLonToGrid } from '../services/engine/geometry';
import { buildNavGrid } from '../services/engine/navGrid';
import type { InshoreLayers } from '../services/engine/types';
import { withNavLineLeadsOnly } from '../services/inshoreRouterEngine';
import { isChartNavLine, isNavLineLead, navLineLeads } from '../services/leadingLine';
import { tracerContextFromLayers } from '../services/routeTracer';
import { encLayer } from './helpers/encCells';

// Distinct longitude so no grid built here can share a cache fingerprint with
// another suite (the counts-as-fingerprint trap in the masterplan).
const W = 151.1;
const S = -25.1;
const BBOX: [number, number, number, number] = [W, S, W + 0.004, S + 0.004];
const MID_LAT = S + 0.002;

const box = (props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [BBOX[0], BBOX[1]],
                [BBOX[2], BBOX[1]],
                [BBOX[2], BBOX[3]],
                [BBOX[0], BBOX[3]],
                [BBOX[0], BBOX[1]],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const navLine = (props: Record<string, unknown>): Feature<LineString> => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'LineString',
        coordinates: [
            [W + 0.0005, MID_LAT],
            [W + 0.0035, MID_LAT],
        ],
    },
});
const chartNav = (CATNAV: unknown) => navLine({ acronym: 'NAVLNE', CATNAV });
/** A line ~170 m north of navLine: clear of every chart line built above. */
const awayLine = (props: Record<string, unknown>): Feature<LineString> => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'LineString',
        coordinates: [
            [W + 0.0005, MID_LAT + 0.0015],
            [W + 0.0035, MID_LAT + 0.0015],
        ],
    },
});

const DRAFT_M = 2;
const SAFETY_M = 0.5;
function centre(layers: InshoreLayers) {
    const grid = buildNavGrid(layers, BBOX, 25, DRAFT_M, SAFETY_M, 60);
    const { x, y } = latLonToGrid(grid, MID_LAT, W + 0.002);
    const i = y * grid.width + x;
    return { depth: grid.cells[i], preferred: grid.preferred[i], landBlocked: grid.landBlocked?.[i] ?? 0 };
}

describe('lead categories — which navigation lines may lead', () => {
    it.each([
        ['clearing line', 1],
        ['transit / bearing', 2],
        ['uncategorised', undefined],
        ['unknown category', 4],
        ['list-valued', '1,3'],
        ['array-valued', [3]],
    ])('a chart NAVLNE %s (CATNAV=%s) is not a lead', (_name, catnav) => {
        expect(isNavLineLead(chartNav(catnav))).toBe(false);
        expect(isNavLineLead(navLine({ CATNAV: catnav }), 'NAVLNE')).toBe(false);
    });

    it('a chart leading line (CATNAV 3) is a lead, whatever the attribute spelling', () => {
        expect(isNavLineLead(chartNav(3))).toBe(true);
        expect(isNavLineLead(chartNav('3'))).toBe(true);
        expect(isNavLineLead(navLine({ acronym: 'NAVLNE', catnav: 3 }))).toBe(true);
        expect(isNavLineLead(navLine({ CATNAV: 3 }), 'NAVLNE')).toBe(true);
    });

    it('a chart NAVLNE with only S-57 structure (no acronym, no CATNAV) is judged as a chart line, so never leads', () => {
        // An extractor that leaves out the acronym, or a hand-assembled blob:
        // without layerClass this used to be read as an OSM line and kept.
        expect(isChartNavLine(navLine({ classCode: 85, rcid: 2366 }))).toBe(true);
        expect(isNavLineLead(navLine({ classCode: 85, rcid: 2366 }))).toBe(false);
        expect(isNavLineLead(navLine({ rcid: 2366 }))).toBe(false);
        expect(isNavLineLead(navLine({ OBJL: 85 }))).toBe(false);
        expect(isNavLineLead(navLine({ classCode: 85, rcid: 2376, CATNAV: 3 }))).toBe(true);
        // OSM ways carry _osmId and seamark:* — still OSM.
        expect(isChartNavLine(navLine({ _osmId: 1, 'seamark:type': 'navigation_line', _source: 'osm' }))).toBe(false);
    });

    it('a chart NAVLNE 3 with unusable geometry is not a lead', () => {
        const broken = { ...chartNav(3), geometry: { type: 'LineString', coordinates: [[W, MID_LAT]] } };
        expect(isNavLineLead(broken)).toBe(false);
    });

    it('OSM lines keep their existing behaviour, except that a clearing line never leads', () => {
        const osm = (category?: string) =>
            navLine({
                'seamark:type': 'navigation_line',
                ...(category ? { 'seamark:navigation_line:category': category } : {}),
                _source: 'osm',
            });
        expect(isNavLineLead(osm('leading'))).toBe(true);
        expect(isNavLineLead(osm('transit'))).toBe(true);
        expect(isNavLineLead(osm())).toBe(true);
        expect(isNavLineLead(osm('clearing'))).toBe(false);
        expect(isNavLineLead(osm('leading; clearing'))).toBe(false);
        // Untyped synthetic geometry (no acronym, no CATNAV) is unchanged.
        expect(isNavLineLead(navLine({}))).toBe(true);
    });

    it('keeps the identity of an all-lead list and drops the rest', () => {
        const leads = [chartNav(3), navLine({})];
        expect(navLineLeads(leads)).toBe(leads);
        expect(navLineLeads([chartNav(1), chartNav(3), chartNav(2)]).map((f) => f.properties?.CATNAV)).toEqual([3]);
    });

    it('on the real Newport cells keeps every CATNAV 3 leading line and none of the clearing or transit lines', () => {
        const enb5 = encLayer('OC-61-10ENB5', 'NAVLNE');
        const rcs5 = encLayer('OC-61-10RCS5', 'NAVLNE');
        const kept = [...navLineLeads(enb5, 'NAVLNE'), ...navLineLeads(rcs5, 'NAVLNE')];
        const rcid = (f: Feature) => f.properties?.rcid as number;
        const byCat = (c: number) => [...enb5, ...rcs5].filter((f) => f.properties?.CATNAV === c).map(rcid);
        expect(byCat(1).sort()).toEqual([2366, 2367, 2368, 2369, 2370]);
        expect(byCat(2).sort()).toEqual([2383, 3454]);
        expect(kept.map(rcid).sort()).toEqual(byCat(3).sort());
        expect(kept).toHaveLength(14);
    });
});

describe('navGrid Pass 5b — clearing and transit lines neither attract nor rescue', () => {
    const shallow = (): InshoreLayers => ({ DEPARE: fc(box({ acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 2 })) });

    it('baseline: the 1 m band reads caution for a 2 m draft and is not preferred', () => {
        expect(centre(shallow())).toMatchObject({ depth: CAUTION, preferred: 0 });
    });

    it.each([1, 2])('a CATNAV %s line through the band leaves it caution and unpreferred', (catnav) => {
        expect(centre({ ...shallow(), NAVLINE: fc(chartNav(catnav)) })).toMatchObject({
            depth: CAUTION,
            preferred: 0,
        });
    });

    // FLIPPED (Phase 2a review, 2026-09-30; was the characterisation of a
    // known gap — a CATNAV 3 lead rescued this 1 m band to 5 m preferred
    // water, breaking "leads never override depth"). Owner decisions: a
    // charted lead shallower than draft + 0.5 m is 'needs tide', and unknown
    // is never green. The lead still PREFERS its corridor (A* rides it at
    // 1.0x), which is also the control that proves the CATNAV 1/2 tests above
    // can tell the difference — but the band stays the 1 m it is charted.
    it('a CATNAV 3 leading line prefers its corridor and never deepens it', () => {
        expect(centre({ ...shallow(), NAVLINE: fc(chartNav(3)) })).toMatchObject({ depth: CAUTION, preferred: 1 });
    });

    const landOverBand = (): InshoreLayers => ({
        LNDARE: fc(box({ acronym: 'LNDARE' })),
        DEPARE: fc(box({ acronym: 'DEPARE', DRVAL1: -0.5, DRVAL2: 0 })),
    });

    // FLIPPED in Phase 1 (was the Phase 0 characterisation of a known gap:
    // "a CATNAV 3 transit still resolves a land-paint vs charted-band
    // conflict", which reopened a DRYING band under land paint as 5 m
    // navigable water). Pass 5b now reads only a lead's ON-WATER span
    // (services/routing/leadLandClip.ts), so the stretch of a leading line
    // that runs over land towards its marks ashore reopens nothing, prefers
    // nothing and rescues nothing.
    it('a CATNAV 3 lead no longer reopens land-painted cells: its land extension is clipped', () => {
        expect(centre(landOverBand()).landBlocked).toBe(1);
        const cell = centre({ ...landOverBand(), NAVLINE: fc(chartNav(3)) });
        expect(cell.landBlocked).toBe(1);
        expect(cell.preferred).toBe(0);
        expect(Number.isNaN(cell.depth)).toBe(true);
    });

    // The same lead running from charted water on to that land: the water
    // span keeps its corridor (preferred, at its charted depth — no rescue
    // since the Phase 2a review), the land span stays land.
    it('a CATNAV 3 lead keeps its corridor on water and stops at the land', () => {
        const eastHalfLand: Feature = {
            ...box({ acronym: 'LNDARE' }),
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [W + 0.002, BBOX[1]],
                        [BBOX[2], BBOX[1]],
                        [BBOX[2], BBOX[3]],
                        [W + 0.002, BBOX[3]],
                        [W + 0.002, BBOX[1]],
                    ],
                ],
            },
        };
        const layers: InshoreLayers = {
            LNDARE: fc(eastHalfLand),
            DEPARE: fc(box({ acronym: 'DEPARE', DRVAL1: -0.5, DRVAL2: 0 })),
            NAVLINE: fc(chartNav(3)),
        };
        const grid = buildNavGrid(layers, BBOX, 25, DRAFT_M, SAFETY_M, 60);
        const at = (lon: number) => {
            const { x, y } = latLonToGrid(grid, MID_LAT, lon);
            const i = y * grid.width + x;
            return { depth: grid.cells[i], preferred: grid.preferred[i], landBlocked: grid.landBlocked?.[i] ?? 0 };
        };
        // On water, west of the land (drying band, no land paint): preferred,
        // and still the drying band it is charted as (it read 5 m before the
        // Phase 2a review).
        expect(at(W + 0.001)).toMatchObject({ depth: CAUTION, preferred: 1, landBlocked: 0 });
        // Over the land, east of its edge: before Phase 1 this read 5 m, preferred, reopened.
        const land = at(W + 0.003);
        expect(land.landBlocked).toBe(1);
        expect(land.preferred).toBe(0);
        expect(Number.isNaN(land.depth)).toBe(true);
    });

    // Phase 1 review (high): clipping the line was not enough. The 1-cell
    // brush around each on-water Bresenham cell still reopened land-painted
    // cells past the clip point and to each side of it (+37.5 m at 25 m,
    // +75 m at 50 m, +150 m at 100 m), and a lead across a land-painted
    // drying spit up to 150 m wide was reopened all the way across at 50 m.
    // A lead never reopens a land-painted cell, at any resolution: every cell
    // whose centre is on the land, from the edge to 2 cells inside, on the
    // lead's row and both brush rows, stays land.
    describe('the brush never reopens land beside or past the clip', () => {
        const S2 = -25.2;
        const rect = (x0: number, x1: number, y0: number, y1: number, props: Record<string, unknown>): Feature => ({
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
        const leadAcross = (x0: number, x1: number, lat: number): Feature<LineString> => ({
            type: 'Feature',
            properties: { acronym: 'NAVLNE', CATNAV: 3 },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [x0, lat],
                    [x1, lat],
                ],
            },
        });
        /** Every cell on the lead's row ±1 whose centre lies in [lon0, lon1]. */
        function landCells(
            layers: InshoreLayers,
            bbox: [number, number, number, number],
            res: number,
            lat: number,
            lon0: number,
            lon1: number,
        ) {
            const grid = buildNavGrid(layers, bbox, res, DRAFT_M, SAFETY_M, 60);
            const row = latLonToGrid(grid, lat, lon0).y;
            const out: { x: number; y: number; landBlocked: number; preferred: number; blocked: boolean }[] = [];
            for (let y = row - 1; y <= row + 1; y++) {
                for (let x = 0; x < grid.width; x++) {
                    const lon = grid.minLon + (x + 0.5) * grid.dLon;
                    if (lon <= lon0 || lon >= lon1) continue;
                    const i = y * grid.width + x;
                    out.push({
                        x,
                        y,
                        landBlocked: grid.landBlocked?.[i] ?? 0,
                        preferred: grid.preferred[i],
                        blocked: Number.isNaN(grid.cells[i]),
                    });
                }
            }
            return out;
        }

        it.each([25, 50, 100])('%i m grid: the land from its edge to 2 cells inside stays land', (res) => {
            const w = 151.2 + res / 1000; // a distinct grid-cache fingerprint per case
            const bbox: [number, number, number, number] = [w, S2, w + 0.012, S2 + 0.012];
            const lat = S2 + 0.006;
            const edge = w + 0.006;
            const layers: InshoreLayers = {
                LNDARE: fc(rect(edge, bbox[2], bbox[1], bbox[3], { acronym: 'LNDARE' })),
                DEPARE: fc(rect(bbox[0], bbox[2], bbox[1], bbox[3], { acronym: 'DEPARE', DRVAL1: -0.5, DRVAL2: 0 })),
                NAVLINE: fc(leadAcross(w + 0.001, w + 0.011, lat)),
            };
            const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
            const cells = landCells(layers, bbox, res, lat, edge, edge + (2.5 * res) / mPerDegLon);
            expect(cells.length).toBeGreaterThanOrEqual(6);
            for (const c of cells) expect(c).toMatchObject({ landBlocked: 1, preferred: 0, blocked: true });
        });

        it('50 m grid: a lead across a 150 m land-painted drying spit is not reopened across it', () => {
            const w = 151.33;
            const bbox: [number, number, number, number] = [w, S2, w + 0.02, S2 + 0.012];
            const lat = S2 + 0.006;
            const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
            const e0 = w + 0.01;
            const e1 = e0 + 150 / mPerDegLon;
            const layers: InshoreLayers = {
                LNDARE: fc(rect(e0, e1, bbox[1], bbox[3], { acronym: 'LNDARE' })),
                DEPARE: fc(rect(bbox[0], bbox[2], bbox[1], bbox[3], { acronym: 'DEPARE', DRVAL1: -0.5, DRVAL2: 0 })),
                NAVLINE: fc(leadAcross(w + 0.001, w + 0.019, lat)),
            };
            const cells = landCells(layers, bbox, 50, lat, e0, e1);
            expect(cells.length).toBeGreaterThanOrEqual(6);
            for (const c of cells) expect(c).toMatchObject({ landBlocked: 1, preferred: 0, blocked: true });
        });
    });

    // Phase 1 review (high, 2026-09-29): "on water" is the GRID's verdict,
    // not the S-57-only vector clip. The grid already treats land paint as
    // water where the OSM canal carve (or OSM-vouched water) says so — the
    // Newport entrance channel — and the vector clip cut the entrance lead
    // there with a ~590 m gap, refusing the production-shape routes.
    describe('a lead keeps its corridor wherever the grid itself has water', () => {
        const canalOverLand = (): InshoreLayers => ({
            LNDARE: fc(box({ acronym: 'LNDARE' })),
            // The OSM waterway=canal centreline along the lead (Pass 1b carve).
            CANAL: fc(navLine({ waterway: 'canal', _source: 'osm' })),
            NAVLINE: fc(chartNav(3)),
        });

        it('over the canal carve: preferred, as before Phase 1', () => {
            expect(centre(canalOverLand())).toMatchObject({ preferred: 1, landBlocked: 0 });
            expect(centre(canalOverLand()).depth).toBeGreaterThanOrEqual(5);
        });

        it('the land either side of the carve stays land, unpreferred', () => {
            const grid = buildNavGrid(canalOverLand(), BBOX, 25, DRAFT_M, SAFETY_M, 60);
            const { x, y } = latLonToGrid(grid, MID_LAT, W + 0.002);
            for (const dy of [-1, 1]) {
                const i = (y + dy) * grid.width + x;
                expect(grid.landBlocked?.[i]).toBe(1);
                expect(grid.preferred[i]).toBe(0);
                expect(Number.isNaN(grid.cells[i])).toBe(true);
            }
        });

        it('land a relax zone lets through as caution is still land to a lead', () => {
            const land: InshoreLayers = { LNDARE: fc(box({ acronym: 'LNDARE' })), NAVLINE: fc(chartNav(3)) };
            const grid = buildNavGrid(land, BBOX, 25, DRAFT_M, SAFETY_M, 60, false, [
                { lat: MID_LAT, lon: W + 0.002, radiusM: 1_000 },
            ]);
            const { x, y } = latLonToGrid(grid, MID_LAT, W + 0.002);
            const i = y * grid.width + x;
            expect(grid.cells[i]).toBe(CAUTION);
            expect(grid.preferred[i]).toBe(0);
        });

        // Final review 2026-09-29 (medium): only the Bresenham CENTRE cell was
        // checked for relaxed land. The brush skipped hardBlocked cells only,
        // and land a relax zone lets through is CAUTION with hardBlocked 0, so
        // a lead on water one cell off such land stamped the land beside it
        // 5 m preferred (the canal carve's banks, a lead meeting the shore).
        it('relaxed land beside a lead on water stays caution and unpreferred', () => {
            const lat = MID_LAT;
            const dLat = 25 / 111_320;
            const shoreLat = lat + 0.3 * dLat; // the lead's row is water, the row above is land
            const northLand: Feature = {
                ...box({ acronym: 'LNDARE' }),
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [BBOX[0], shoreLat],
                            [BBOX[2], shoreLat],
                            [BBOX[2], BBOX[3]],
                            [BBOX[0], BBOX[3]],
                            [BBOX[0], shoreLat],
                        ],
                    ],
                },
            };
            const southWater: Feature = {
                ...box({ acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 }),
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [BBOX[0], BBOX[1]],
                            [BBOX[2], BBOX[1]],
                            [BBOX[2], shoreLat],
                            [BBOX[0], shoreLat],
                            [BBOX[0], BBOX[1]],
                        ],
                    ],
                },
            };
            const zone = [{ lat, lon: W + 0.002, radiusM: 1_000 }];
            const build = (withLead: boolean) =>
                buildNavGrid(
                    {
                        LNDARE: fc(northLand),
                        DEPARE: fc(southWater),
                        NAVLINE: withLead ? fc(chartNav(3)) : fc(),
                    },
                    [BBOX[0] + 0.00001, BBOX[1], BBOX[2], BBOX[3]], // a grid of its own in the cache
                    25,
                    DRAFT_M,
                    SAFETY_M,
                    60,
                    false,
                    zone,
                );
            const cellAt = (grid: ReturnType<typeof buildNavGrid>, x: number, y: number) => {
                const i = y * grid.width + x;
                return { depth: grid.cells[i], preferred: grid.preferred[i] };
            };
            const base = build(false);
            const { x, y } = latLonToGrid(base, lat, W + 0.002);
            // Preconditions: the lead's row is charted water, the row above is
            // land the relax zone let through as caution.
            expect(cellAt(base, x, y)).toMatchObject({ depth: 10, preferred: 0 });
            expect(cellAt(base, x, y + 1)).toMatchObject({ depth: CAUTION, preferred: 0 });

            const led = build(true);
            expect(cellAt(led, x, y).preferred).toBe(1);
            for (const dx of [-1, 0, 1])
                expect(cellAt(led, x + dx, y + 1)).toMatchObject({ depth: CAUTION, preferred: 0 });
        });
    });

    it.each([1, 2])('a CATNAV %s line never reopens land-painted cells', (catnav) => {
        const cell = centre({ ...landOverBand(), NAVLINE: fc(chartNav(catnav)) });
        expect(cell.landBlocked).toBe(1);
        expect(cell.preferred).toBe(0);
        expect(Number.isNaN(cell.depth)).toBe(true);
    });
});

describe('engine entry and tracer — one gate for every lead consumer', () => {
    it('routeInshore strips clearing and transit NAVLNE before any consumer sees the layers', () => {
        const layers: InshoreLayers = { NAVLINE: fc(chartNav(1), chartNav(3), chartNav(2), awayLine({})) };
        const gated = withNavLineLeadsOnly(layers);
        expect(gated.NAVLINE?.features.map((f) => f.properties?.CATNAV)).toEqual([3, undefined]);
        expect(layers.NAVLINE?.features).toHaveLength(4);
        const clean: InshoreLayers = { NAVLINE: fc(chartNav(3)) };
        expect(withNavLineLeadsOnly(clean)).toBe(clean);
    });

    it('routeInshore also strips an OSM way that redraws a chart clearing or transit line', () => {
        const osm = (props: Record<string, unknown> = {}) =>
            navLine({ 'seamark:type': 'navigation_line', _source: 'osm', ...props });
        for (const catnav of [1, 2]) {
            const layers: InshoreLayers = {
                NAVLINE: fc(chartNav(catnav), osm({ 'seamark:navigation_line:category': 'transit' })),
            };
            expect(withNavLineLeadsOnly(layers).NAVLINE?.features).toEqual([]);
        }
        // On a tie with a chart lead the non-lead claims it (the safe side);
        // the chart lead itself stays.
        const tie: InshoreLayers = { NAVLINE: fc(chartNav(2), chartNav(3), osm()) };
        expect(withNavLineLeadsOnly(tie).NAVLINE?.features.map((f) => f.properties?.CATNAV)).toEqual([3]);
        // An OSM line clear of the chart's non-leads is unchanged.
        const away: InshoreLayers = { NAVLINE: fc(chartNav(2), awayLine({ _source: 'osm' })) };
        expect(withNavLineLeadsOnly(away).NAVLINE?.features.map((f) => f.properties?._source)).toEqual(['osm']);
    });

    it('the tracer never snaps to, or rides, a clearing or transit line', () => {
        const ctx = tracerContextFromLayers({ NAVLINE: fc(chartNav(1), chartNav(2), chartNav(3)) }, [], BBOX, DRAFT_M, {
            skipGrid: true,
        });
        expect(ctx.leads).toHaveLength(1);
        expect(ctx.chartTracks?.map((t) => t.chartTrack.category)).toEqual([3]);
    });
});
