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

    // CHARACTERISATION of a KNOWN GAP, kept as the control that proves the
    // CATNAV 1/2 tests above can tell the difference. A CATNAV 3 lead still
    // rescues a 1 m band to 5 m preferred water, which breaks "leads never
    // override depth". Waiting on Shane (questionsForShane #2: refuse, needs
    // tide, or predicted tide at a dredged bar such as the Brisbane bar and
    // Tangalooma). When that lands, FLIP this assertion rather than keep it —
    // a change here is the fix, not a regression.
    it('a CATNAV 3 leading line keeps its existing corridor (unchanged behaviour)', () => {
        expect(centre({ ...shallow(), NAVLINE: fc(chartNav(3)) })).toMatchObject({ depth: 5, preferred: 1 });
    });

    const landOverBand = (): InshoreLayers => ({
        LNDARE: fc(box({ acronym: 'LNDARE' })),
        DEPARE: fc(box({ acronym: 'DEPARE', DRVAL1: -0.5, DRVAL2: 0 })),
    });

    // CHARACTERISATION of a KNOWN GAP (see above): a CATNAV 3 lead still
    // reopens a DRYING band (DRVAL1 -0.5) under land paint as 5 m navigable
    // water, which breaks "leads never override land or depth". Same pending
    // decision (questionsForShane #2); the Phase 1 lead compiler clips NAVLNE 3
    // to its on-water span. FLIP this once decided, do not keep it.
    it('control: a CATNAV 3 transit still resolves a land-paint vs charted-band conflict', () => {
        expect(centre(landOverBand()).landBlocked).toBe(1);
        expect(centre({ ...landOverBand(), NAVLINE: fc(chartNav(3)) })).toMatchObject({ depth: 5, landBlocked: 0 });
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
