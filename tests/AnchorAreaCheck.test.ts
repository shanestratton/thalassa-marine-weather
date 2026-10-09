/**
 * Is the anchor down inside a charted area where anchoring is a problem?
 * (build 126, 126-07d: services/anchorAreaCheck.ts)
 *
 * Global first: the official chart cells on the phone (S-57 RESARE with its
 * RESTRN codes, CBLARE, PIPARE, TSSLPT) work anywhere in the world; the GBRMPA
 * no-anchoring polygons are a national extra. Every area here is FICTIONAL,
 * built in the test (the repo is public): a restricted area off Cádiz, a cable
 * area off Horta, a pipeline area off Lyttelton, a traffic lane in the Strait
 * of Gibraltar, a reserve astride 180° off Taveuni, and a Coral Sea reef.
 *
 * The chart side runs the real EncSpatialIndex point test (a one-point segment
 * through segmentCautions); only the cell lookup is stood in for, the way
 * EncHazardService.querySegmentCautions composes cells. The check is said,
 * never enforced: it never throws, and a slow or failing source gives nothing.
 *
 * What the chart could say (126-07d review): only a chart cell counts as
 * having looked ('checked'), so the "No chart areas loaded here" words show
 * wherever no cell covers the point, the whole atlas coast included (its real
 * tile index, read from public/anchorages/qld); and a chart that covers the
 * point but is slow or unreadable is 'unchecked', never 'none'.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Geometry, Polygon } from 'geojson';
import { EncSpatialIndex, type EncCautionArea } from '../services/enc/EncSpatialIndex';

type BBox = [number, number, number, number];

const enc = vi.hoisted(() => ({
    cells: [] as Array<{ id: string; bbox: [number, number, number, number]; index: EncSpatialIndex }>,
    /** Set to make the chart query hang until released (the deadline tests) or fail. */
    hang: false,
    fail: false,
    /** Lets every hung query go, so none outlives its test. */
    release: [] as Array<() => void>,
    /** The chart queries asked, in order. */
    queries: 0,
    /** Cells whose index could not be built (missing or corrupt GeoJSON). */
    failed: [] as string[],
}));
const atlas = vi.hoisted(() => ({ loadNear: vi.fn() }));
const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));

const touches = (bbox: BBox, lat: number, lon: number) =>
    lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

vi.mock('../services/enc/EncCellMetadata', () => ({
    cellsForBBox: (q: BBox) =>
        enc.cells.filter(({ bbox }) => !(bbox[2] < q[0] || bbox[0] > q[2] || bbox[3] < q[1] || bbox[1] > q[3])),
}));
vi.mock('../services/enc/encIndexCache', () => ({ failedCellIds: () => [...enc.failed] }));
vi.mock('../services/HazardQueryService', () => ({
    hasEncCoverageFor: (q: BBox) =>
        enc.cells.some(({ bbox }) => !(bbox[2] < q[0] || bbox[0] > q[2] || bbox[3] < q[1] || bbox[1] > q[3])),
    // As EncHazardService composes it: every covering cell, de-duplicated by class, name and RESTRN.
    querySegmentCautions: async (segments: { lat1: number; lon1: number; lat2: number; lon2: number }[]) => {
        enc.queries += 1;
        if (enc.hang) await new Promise<void>((resolve) => enc.release.push(resolve));
        if (enc.fail) throw new Error('index build failed');
        return segments.map((s) => {
            const seen = new Set<string>();
            const out: EncCautionArea[] = [];
            for (const cell of enc.cells) {
                if (!touches(cell.bbox, s.lat1, s.lon1)) continue;
                for (const area of cell.index.segmentCautions(s.lat1, s.lon1, s.lat2, s.lon2)) {
                    const key = `${area.cls}|${area.name ?? ''}|${area.restrn ?? ''}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push(area);
                }
            }
            return out;
        });
    },
}));
vi.mock('../services/anchorages/AnchorageService', () => ({ AnchorageService: { loadNear: atlas.loadNear } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: logs.info, warn: logs.warn, error: vi.fn() }),
}));

import { ANCHOR_AREA_AFTER_ARM_MS, ANCHOR_AREA_CHECK_MS, checkAnchorAreas } from '../services/anchorAreaCheck';

/** A box [w, s, e, n] as a closed polygon ring. */
function box(w: number, s: number, e: number, n: number): Polygon {
    return {
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
    };
}
const area = (cls: string, geometry: Geometry, restrn?: string, name?: string): EncCautionArea => ({
    geometry,
    cls,
    ...(restrn !== undefined ? { restrn } : {}),
    ...(name ? { name } : {}),
});
function cell(id: string, bbox: BBox, areas: EncCautionArea[]) {
    enc.cells.push({ id, bbox, index: new EncSpatialIndex(id, [], [], [], areas) });
}
/** The atlas, as AnchorageService hands it over: GBRMPA no-anchoring polygons near the point. */
function atlasWith(features: Array<{ geometry: Geometry; name?: string; legal?: string }>, tiles = ['t-fixture']) {
    atlas.loadNear.mockResolvedValue({
        points: { type: 'FeatureCollection', features: [] },
        noAnchor: {
            type: 'FeatureCollection',
            features: features.map((f, i) => ({
                type: 'Feature',
                geometry: f.geometry,
                properties: {
                    id: `gbrmpa-noanchor-fixture-${i}`,
                    name: f.name,
                    type: 'No-anchoring area',
                    source: 'GBRMPA',
                    legal: f.legal,
                },
            })),
        },
        zoning: { type: 'FeatureCollection', features: [] },
        tiles,
    });
}
const outsideTheAtlas = () => atlasWith([], []);

// Fictional areas, worldwide.
const CADIZ = { lat: 36.5, lon: -6.35 };
const HORTA = { lat: 38.53, lon: -28.62 };
const LYTTELTON = { lat: -43.61, lon: 172.72 };
const GIBRALTAR = { lat: 35.95, lon: -5.6 };
const CORAL_SEA = { lat: -19.1, lon: 149.9 };

function worldCharts() {
    cell(
        'ZZ4CADIZ',
        [-6.6, 36.3, -6.1, 36.8],
        [
            area('RESARE', box(-6.38, 36.48, -6.32, 36.52), '1', 'Fixture Anchorage Ban'),
            // Fishing only: nothing to do with an anchored boat.
            area('RESARE', box(-6.43, 36.58, -6.37, 36.62), '3', 'Fixture Fishing Box'),
        ],
    );
    cell('ZZ4HORTA', [-28.9, 38.3, -28.4, 38.8], [area('CBLARE', box(-28.64, 38.52, -28.6, 38.54))]);
    cell('ZZ4LYTTN', [172.5, -43.8, 173.0, -43.4], [area('PIPARE', box(172.7, -43.62, 172.74, -43.6))]);
    cell('ZZ4GIBRL', [-5.9, 35.8, -5.3, 36.1], [area('TSSLPT', box(-5.7, 35.93, -5.5, 35.97))]);
}

beforeEach(() => {
    enc.cells = [];
    enc.hang = false;
    enc.fail = false;
    enc.queries = 0;
    enc.failed = [];
    atlas.loadNear.mockReset();
    outsideTheAtlas();
    logs.warn.mockReset();
    logs.info.mockReset();
});

afterEach(async () => {
    // A hung chart query is let go, so the next test's ask does not wait on it.
    enc.hang = false;
    for (const release of enc.release.splice(0)) release();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('checkAnchorAreas: official charts, worldwide', () => {
    beforeEach(worldCharts);

    it('inside a restricted area where anchoring is prohibited (off Cádiz): names it, in the IHO words', async () => {
        const { warnings, charts } = await checkAnchorAreas(CADIZ.lat, CADIZ.lon);
        expect(charts).toBe('checked');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ kind: 'anchoring', source: 'ENC', name: 'Fixture Anchorage Ban' });
        expect(warnings[0].words).toBe(
            'Inside Fixture Anchorage Ban, a restricted area: anchoring prohibited (official chart).',
        );
        // The Move anchor sheet's short form: the kind and the source, no name.
        expect(warnings[0].brief).toBe('a restricted area: anchoring prohibited (official chart)');
    });

    it('inside a submarine cable area (off Horta)', async () => {
        const { warnings } = await checkAnchorAreas(HORTA.lat, HORTA.lon);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ kind: 'cable', source: 'ENC', area: 'a submarine cable area' });
        expect(warnings[0].credit).toBe('official chart');
        expect(warnings[0].words).toBe(
            'Inside a submarine cable area (official chart). Anchoring here can damage the cable and your anchor.',
        );
    });

    it('inside a pipeline area (off Lyttelton)', async () => {
        const { warnings } = await checkAnchorAreas(LYTTELTON.lat, LYTTELTON.lon);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ kind: 'pipeline', source: 'ENC', area: 'a pipeline area' });
        expect(warnings[0].words).toBe(
            'Inside a pipeline area (official chart). Anchoring here can damage the pipeline and your anchor.',
        );
    });

    it('inside a traffic lane (Strait of Gibraltar): COLREG Rule 10(g)', async () => {
        const { warnings } = await checkAnchorAreas(GIBRALTAR.lat, GIBRALTAR.lon);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({ kind: 'tss', source: 'ENC', area: 'a traffic lane' });
        expect(warnings[0].words).toBe(
            'Inside a traffic lane (official chart). Avoid anchoring in a traffic separation scheme (COLREG Rule 10(g)).',
        );
    });

    it.each([
        ['Cádiz, just east', CADIZ.lat, -6.315],
        ['Horta, just north', 38.545, HORTA.lon],
        ['Lyttelton, just south', -43.625, LYTTELTON.lon],
        ['Gibraltar, just west', GIBRALTAR.lat, -5.705],
    ])('just outside (%s): nothing', async (_where, lat, lon) => {
        const { warnings, charts } = await checkAnchorAreas(lat, lon);
        expect(warnings).toEqual([]);
        // A chart covers it and answered: nothing is said, and nothing claims it is clear.
        expect(charts).toBe('checked');
    });

    it('a restricted area for fishing only does not warn an anchored boat', async () => {
        const { warnings } = await checkAnchorAreas(36.6, -6.4);
        expect(warnings).toEqual([]);
    });

    it("RESTRN '1,14': anchoring prohibited and an area to be avoided, ranked as anchoring", async () => {
        cell(
            'ZZ5GIBRL',
            [-5.9, 35.8, -5.3, 36.1],
            [area('RESARE', box(-5.62, 35.94, -5.58, 35.96), '1,14', 'Fixture Lane Reserve')],
        );
        const { warnings } = await checkAnchorAreas(GIBRALTAR.lat, GIBRALTAR.lon);
        expect(warnings.map((w) => w.kind)).toEqual(['anchoring', 'tss']);
        expect(warnings[0].words).toBe(
            'Inside Fixture Lane Reserve, a restricted area: anchoring prohibited, area to be avoided (official chart).',
        );
        // The short form keeps only the most serious code.
        expect(warnings[0].brief).toBe('a restricted area: anchoring prohibited (official chart)');
    });

    it("RESTRN '07' (zero-padded): entry prohibited, said first, ahead of the cable", async () => {
        cell('ZZ5HORTA', [-28.9, 38.3, -28.4, 38.8], [area('RESARE', box(-28.63, 38.525, -28.61, 38.535), '07')]);
        const { warnings } = await checkAnchorAreas(HORTA.lat, HORTA.lon);
        expect(warnings.map((w) => w.kind)).toEqual(['entry', 'cable']);
        expect(warnings[0].words).toBe('Inside a restricted area: entry prohibited (official chart).');
        expect(warnings.map((w) => w.brief)).toEqual([
            'a restricted area: entry prohibited (official chart)',
            'a submarine cable area (official chart)',
        ]);
    });

    it("dragging (24) and stopping (25) prohibited are an anchored boat's business; an unknown code is not", async () => {
        cell(
            'ZZ5CADIZ',
            [-6.6, 36.3, -6.1, 36.8],
            [
                area('RESARE', box(-6.3, 36.4, -6.2, 36.45), '24,25'),
                area('RESARE', box(-6.2, 36.4, -6.15, 36.45), '99'),
            ],
        );
        expect((await checkAnchorAreas(36.42, -6.25)).warnings[0].words).toBe(
            'Inside a restricted area: dragging prohibited, stopping prohibited (official chart).',
        );
        expect((await checkAnchorAreas(36.42, -6.17)).warnings).toEqual([]);
    });

    it('a cable area where anchoring is prohibited says so', async () => {
        cell('ZZ5LYTTN', [172.5, -43.8, 173.0, -43.4], [area('CBLARE', box(172.6, -43.7, 172.65, -43.65), '1')]);
        const { warnings } = await checkAnchorAreas(-43.68, 172.62);
        expect(warnings[0].words).toBe(
            'Inside a submarine cable area: anchoring prohibited (official chart). Anchoring here can damage the cable and your anchor.',
        );
        // The longest short form there is: the sheet's fit test measures it (move-anchor-layout.spec.ts).
        expect(warnings[0].brief).toBe('a submarine cable area: anchoring prohibited (official chart)');
    });

    it('a cable area and a traffic lane that share a name are two lines, not one', async () => {
        cell(
            'ZZ5STRAIT',
            [-5.9, 35.8, -5.3, 36.1],
            [
                area('CBLARE', box(-5.62, 35.94, -5.58, 35.96), undefined, 'Fixture Strait'),
                area('TSSLPT', box(-5.62, 35.94, -5.58, 35.96), undefined, 'Fixture Strait'),
            ],
        );
        const { warnings } = await checkAnchorAreas(GIBRALTAR.lat, GIBRALTAR.lon);
        // The fixture's own unnamed lane is there too (charted first, in the other cell).
        expect(warnings.map((w) => `${w.kind} ${w.name ?? ''}`)).toEqual([
            'cable Fixture Strait',
            'tss ',
            'tss Fixture Strait',
        ]);
        expect(warnings[2].words).toContain('COLREG Rule 10(g)');
    });
});

describe('checkAnchorAreas: the GBRMPA atlas, a national extra', () => {
    it('inside a no-anchoring area: names it, its legal reference and the CC BY credit', async () => {
        atlasWith([
            {
                geometry: box(149.85, -19.15, 149.95, -19.05),
                name: 'Fixture Reef',
                legal: 'Plan of Management — Schedule X',
            },
        ]);
        const { warnings, charts } = await checkAnchorAreas(CORAL_SEA.lat, CORAL_SEA.lon);
        // The atlas never counts as the chart: cables and pipelines were not looked for.
        expect(charts).toBe('none');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
            kind: 'anchoring',
            source: 'GBRMPA',
            name: 'Fixture Reef',
            legal: 'Plan of Management — Schedule X',
            area: 'Fixture Reef no-anchoring area',
            credit: 'GBRMPA, Plan of Management — Schedule X, CC BY',
        });
        expect(warnings[0].words).toBe(
            'Inside Fixture Reef no-anchoring area (GBRMPA, Plan of Management — Schedule X, CC BY).',
        );
        // The sheet's short form: still credited, the name and clause left to the page's note.
        expect(warnings[0].brief).toBe('a no-anchoring area (GBRMPA, CC BY)');
        // Asked for the tiles near the anchor only.
        expect(atlas.loadNear).toHaveBeenCalledWith(CORAL_SEA.lat, CORAL_SEA.lon, 2);
    });

    it('just outside it: nothing', async () => {
        atlasWith([{ geometry: box(149.85, -19.15, 149.95, -19.05), name: 'Fixture Reef', legal: 'X' }]);
        expect((await checkAnchorAreas(-19.16, CORAL_SEA.lon)).warnings).toEqual([]);
    });

    it('the same area on the chart and in the atlas is said once, the chart first', async () => {
        cell(
            'ZZ4CORAL',
            [149.5, -19.5, 150.5, -18.5],
            [area('RESARE', box(149.85, -19.15, 149.95, -19.05), '1', 'Fixture Reef')],
        );
        atlasWith([{ geometry: box(149.85, -19.15, 149.95, -19.05), name: 'Fixture Reef', legal: 'X' }]);
        const { warnings } = await checkAnchorAreas(CORAL_SEA.lat, CORAL_SEA.lon);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].source).toBe('ENC');
    });
});

describe('checkAnchorAreas: astride 180° off Taveuni', () => {
    it('a reserve charted in two cells, one each side of 180°: found from both sides', async () => {
        cell(
            'ZZ4TAVW',
            [179.5, -17.5, 180, -16.5],
            [area('RESARE', box(179.9, -16.95, 180, -16.85), '2', 'Fixture Taveuni Reserve')],
        );
        cell(
            'ZZ4TAVE',
            [-180, -17.5, -179.5, -16.5],
            [area('RESARE', box(-180, -16.95, -179.9, -16.85), '2', 'Fixture Taveuni Reserve')],
        );
        for (const lon of [179.95, -179.95]) {
            const { warnings } = await checkAnchorAreas(-16.9, lon);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].words).toBe(
                'Inside Fixture Taveuni Reserve, a restricted area: anchoring restricted (official chart).',
            );
        }
        expect((await checkAnchorAreas(-16.9, -179.85)).warnings).toEqual([]);
    });

    it('an atlas polygon written past 180° (179.9 to 180.1): found from both sides', async () => {
        atlasWith([{ geometry: box(179.9, -16.95, 180.1, -16.85), name: 'Fixture Lagoon', legal: 'X' }]);
        expect((await checkAnchorAreas(-16.9, 179.95)).warnings).toHaveLength(1);
        expect((await checkAnchorAreas(-16.9, -179.95)).warnings).toHaveLength(1);
        expect((await checkAnchorAreas(-16.9, -179.85)).warnings).toEqual([]);
    });
});

describe('checkAnchorAreas: the real atlas tile index (public/anchorages/qld), no chart cells', () => {
    // The real AnchorageService over the files the app ships, fetched from disk.
    beforeEach(async () => {
        const { AnchorageService } = await vi.importActual<typeof import('../services/anchorages/AnchorageService')>(
            '../services/anchorages/AnchorageService',
        );
        vi.stubGlobal('fetch', async (url: string) => {
            const body = await readFile(join(process.cwd(), 'public', url), 'utf8');
            return { ok: true, status: 200, json: async () => JSON.parse(body) };
        });
        atlas.loadNear.mockImplementation(AnchorageService.loadNear);
    });

    it.each([
        ['Moreton Bay, off Tangalooma', -27.18, 153.37],
        ['Cairns', -16.9, 145.78],
        ['Port Moresby', -9.48, 147.15],
        ['Cádiz, outside every tile', CADIZ.lat, CADIZ.lon],
    ])('%s: an atlas tile with no no-anchoring polygons is not a chart: "none"', async (_where, lat, lon) => {
        await expect(checkAnchorAreas(lat, lon)).resolves.toEqual({ warnings: [], charts: 'none' });
    });

    it('inside a shipped no-anchoring polygon (Bait Reef, Whitsundays): said and credited, and still no chart', async () => {
        const { warnings, charts } = await checkAnchorAreas(-19.8168, 149.0688);
        expect(charts).toBe('none');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
            source: 'GBRMPA',
            kind: 'anchoring',
            brief: 'a no-anchoring area (GBRMPA, CC BY)',
        });
        expect(warnings[0].credit).toMatch(/^GBRMPA, .+, CC BY$/);
    });
});

describe('checkAnchorAreas: said, never enforced; quiet when it cannot look', () => {
    it('no chart cells and outside the atlas: nothing, no chart, and no throw', async () => {
        await expect(checkAnchorAreas(CADIZ.lat, CADIZ.lon)).resolves.toEqual({ warnings: [], charts: 'none' });
    });

    it('the atlas loader throws: the chart results still come back', async () => {
        worldCharts();
        atlas.loadNear.mockRejectedValue(new Error('anchorage data fetch failed: HTTP 503'));
        const { warnings, charts } = await checkAnchorAreas(HORTA.lat, HORTA.lon);
        expect(warnings.map((w) => w.kind)).toEqual(['cable']);
        expect(charts).toBe('checked');
        expect(logs.warn).toHaveBeenCalled();
    });

    it('the chart query fails: the atlas results still come back, and the chart is unchecked, not absent', async () => {
        worldCharts();
        enc.fail = true;
        atlasWith([{ geometry: box(-28.64, 38.52, -28.6, 38.54), name: 'Fixture Bank', legal: 'X' }]);
        const { warnings, charts } = await checkAnchorAreas(HORTA.lat, HORTA.lon);
        expect(warnings.map((w) => w.source)).toEqual(['GBRMPA']);
        expect(charts).toBe('unchecked');
    });

    it('a covering cell that could not be read: the answer is incomplete, so unchecked', async () => {
        worldCharts();
        enc.failed = ['ZZ4HORTA'];
        await expect(checkAnchorAreas(38.545, HORTA.lon)).resolves.toEqual({ warnings: [], charts: 'unchecked' });
        // A cell elsewhere that could not be read is not this point's business.
        enc.failed = ['ZZ4CADIZ'];
        await expect(checkAnchorAreas(38.545, HORTA.lon)).resolves.toEqual({ warnings: [], charts: 'checked' });
    });

    it(`both sources slow: after ${3_000} ms it gives up with nothing, the chart unchecked, not absent`, async () => {
        vi.useFakeTimers();
        worldCharts();
        enc.hang = true;
        atlas.loadNear.mockReturnValue(new Promise(() => undefined));
        let settled: Awaited<ReturnType<typeof checkAnchorAreas>> | null = null;
        void checkAnchorAreas(HORTA.lat, HORTA.lon).then((result) => {
            settled = result;
        });
        await vi.advanceTimersByTimeAsync(ANCHOR_AREA_CHECK_MS - 1);
        expect(settled).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(ANCHOR_AREA_CHECK_MS).toBe(3_000);
        expect(settled).toEqual({ warnings: [], charts: 'unchecked' });
        expect(logs.warn).toHaveBeenCalled();
    });

    it('a slow first chart answer: the next ask waits for it, and answers without building it again', async () => {
        vi.useFakeTimers();
        worldCharts();
        enc.hang = true;
        const first = checkAnchorAreas(HORTA.lat, HORTA.lon);
        await vi.advanceTimersByTimeAsync(ANCHOR_AREA_CHECK_MS);
        await expect(first).resolves.toEqual({ warnings: [], charts: 'unchecked' });
        expect(enc.queries).toBe(1);

        // Asked again while the first query is still building: it waits, no second query beside it.
        enc.hang = false;
        const again = checkAnchorAreas(HORTA.lat, HORTA.lon);
        await vi.advanceTimersByTimeAsync(500);
        expect(enc.queries).toBe(1);
        // The first finishes (its indexes cached): the second asks and answers in time.
        for (const release of enc.release.splice(0)) release();
        await vi.advanceTimersByTimeAsync(0);
        const { warnings, charts } = await again;
        expect(charts).toBe('checked');
        expect(warnings.map((w) => w.kind)).toEqual(['cable']);
        expect(enc.queries).toBe(2);
    });

    it(`after the watch is armed nothing waits on it: given ${ANCHOR_AREA_AFTER_ARM_MS / 1000} s, a slow chart still answers`, async () => {
        vi.useFakeTimers();
        worldCharts();
        enc.hang = true;
        let settled: Awaited<ReturnType<typeof checkAnchorAreas>> | null = null;
        void checkAnchorAreas(HORTA.lat, HORTA.lon, ANCHOR_AREA_AFTER_ARM_MS).then((result) => {
            settled = result;
        });
        await vi.advanceTimersByTimeAsync(ANCHOR_AREA_CHECK_MS * 2);
        expect(settled).toBeNull();
        for (const release of enc.release.splice(0)) release();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toMatchObject({ charts: 'checked' });
        expect(settled!.warnings.map((w) => w.kind)).toEqual(['cable']);
    });

    it('never puts the position in a log line', async () => {
        worldCharts();
        enc.fail = true;
        atlas.loadNear.mockRejectedValue(new Error('offline'));
        await checkAnchorAreas(HORTA.lat, HORTA.lon);
        const said = JSON.stringify([...logs.warn.mock.calls, ...logs.info.mock.calls]);
        expect(said).not.toMatch(/38\.5|28\.6/);
    });

    it('a position that is not a number: nothing, no throw', async () => {
        await expect(checkAnchorAreas(Number.NaN, 10)).resolves.toEqual({ warnings: [], charts: 'none' });
    });
});
