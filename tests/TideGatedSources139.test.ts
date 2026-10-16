/** Fictional chart, transport and rights reviews exercise the real source gate.
 * These fixtures are not a live Pi read or a real navigation permission. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { SampledTideAuthority } from '../services/tides/sampledTideNavigation';
import type { SampledTideSeries } from '../services/tides/sampledTideContract';
import type { RouteJob } from '../services/routing/routeJob';
const h = vi.hoisted(() => ({
    version: 1,
    chartLifetime: 1,
    scope: { key: 'user:fictional', userId: 'fictional', generation: 1 },
    prior: 'fictional-boat-1',
    cells: [] as EncCell[],
    blob: null as EncConversionResult | null,
    series: [] as SampledTideSeries[],
    authority: { sources: [], ties: [] } as SampledTideAuthority,
    receipt: {} as object | null,
    release: vi.fn(),
    load: vi.fn(),
    peek: vi.fn(),
    byteLength: 1000 as number | null,
    readSources: vi.fn(),
    workerCalls: 0,
    contextRelease: vi.fn(),
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    cellsForBBox: () => h.cells,
    listCells: () => h.cells,
    getVersion: () => h.version,
}));
vi.mock('../services/enc/chartFindMemory', () => ({ chartFindGeneration: () => h.chartLifetime }));
vi.mock('../services/enc/EncCellStore', () => ({
    loadCellGeoJSON: h.load,
    peekCellGeoJSON: h.peek,
    readRetainedCellGeoJSONBytes: (_id: string, blob: EncConversionResult) => (blob === h.blob ? h.byteLength : null),
}));
vi.mock('../services/enc/piCellSync', () => ({
    readPiChartReadEvidence: () => h.receipt,
    isPiChartReadEvidenceCurrent: (r: object) => r === h.receipt,
}));
vi.mock('../services/enc/noaaPackageWindow', () => ({
    loadNoaaPackageCohort: async (_cells: EncCell[], _bounds: number[], check: () => void) => ({
        blobs: new Map(),
        bytes: 0,
        check,
        release: h.release,
    }),
}));
vi.mock('../services/tides/passageTideSources', () => ({ loadPassageTideSources: h.readSources }));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ ...h.scope }),
    isAuthIdentityScopeCurrent: (s: { generation: number }) => s.generation === h.scope.generation,
    subscribeAuthIdentityScope: () => () => {},
}));
vi.mock('../services/routing/trackRoutingPriors', () => ({ trackPriorContextKey: () => h.prior }));
vi.mock('../services/routing/routingExclusions', () => ({
    routingExclusionContextKey: () => 'fictional-current-context',
    readCurrentRoutingExclusions: async () => ({
        manual: undefined,
        marineParks: undefined,
        advisories: [],
        isCurrent: () => true,
        release: h.contextRelease,
    }),
}));
vi.mock('../services/routing/routeWorkerHost', () => ({
    runRouteJobHosted: async (job: RouteJob) => {
        h.workerCalls++;
        const { runRouteJob } = await import('../services/routing/routeJob');
        return { output: runRouteJob(job), where: 'main', waitMs: 0, handoffMs: 0, backMs: 0 };
    },
}));
vi.mock('../services/tides/sampledTideNavigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/tides/sampledTideNavigation')>()),
    REVIEWED_SAMPLED_TIDE_AUTHORITY: h.authority,
}));
import { bindAdapterSampledTideSeries } from '../services/tides/sampledTideAcquisition';
import { encCellContentIdentity } from '../services/enc/cellContentIdentity';
import {
    prepareTideGatedSources,
    checkTideGatedSourcePermit,
    recheckTideGatedSourcePermit,
    tideGatedBounds,
} from '../services/routing/tideGatedSources';
import { haversineM } from '../services/engine/geometry';
import { tideGatedGridLayout } from '../services/engine/tideGatedSearch';
import {
    planTideGatedShortcut,
    finalizeTideShortcutPreview,
    retireTideShortcutPreview,
} from '../services/routing/tideGatedPlanning';

const T = Date.parse('2026-10-17T01:00:00Z'),
    H = 3600000;
const input = () => ({
    from: { lat: 0, lon: -0.0005 },
    to: { lat: 0, lon: 0.0005 },
    departureMs: T,
    speedKts: 6,
    requiredM: 2.5,
    uncertaintyMs: 900000,
    lifetimeKey: 'fictional-request-1',
});
const options = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
const rectangle = (n: number): GeoJSON.Polygon => ({
    type: 'Polygon',
    coordinates: [
        [
            [-n, -n],
            [n, -n],
            [n, n],
            [-n, n],
            [-n, -n],
        ],
    ],
});
function fakePath() {
    const r = input(),
        grid = tideGatedGridLayout(tideGatedBounds(r.from, r.to)!).grid;
    const y = Math.floor((r.from.lat - grid.minLat) / grid.dLat),
        fromX = Math.floor((r.from.lon - grid.minLon) / grid.dLon),
        toX = Math.floor((r.to.lon - grid.minLon) / grid.dLon);
    const indices = Array.from({ length: toX - fromX + 1 }, (_, i) => y * grid.width + fromX + i),
        points = indices.map((idx, i) =>
            i === 0
                ? [r.from.lon, r.from.lat]
                : i === indices.length - 1
                  ? [r.to.lon, r.to.lat]
                  : [grid.minLon + ((idx % grid.width) + 0.5) * grid.dLon, grid.minLat + (y + 0.5) * grid.dLat],
        ) as [number, number][];
    const timesMs = [T];
    let distanceM = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
            b = points[i],
            length = haversineM(a[1], a[0], b[1], b[0]);
        distanceM += length;
        timesMs.push(timesMs[i - 1] + (length / ((r.speedKts * 1852) / 3600)) * 1000);
    }
    return { grid, points, timesMs, indices, tideCells: [...indices], distanceM };
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(T);
    h.version++;
    h.chartLifetime++;
    h.scope.generation++;
    h.prior = 'fictional-boat-1';
    h.receipt = {};
    h.release.mockReset();
    h.load.mockReset();
    h.peek.mockReset();
    h.byteLength = 1000;
    h.readSources.mockReset();
    h.contextRelease.mockReset();
    h.workerCalls = 0;
    const cell: EncCell = {
        id: 'AU500001',
        sourceHO: 'AHO',
        edition: 1,
        updateNumber: 0,
        issued: '2026-10-01',
        importedAt: '2026-10-17',
        contentSha256: 'a'.repeat(64),
        bbox: [-1, -1, 1, 1],
        geojsonPath: 'ram',
        hazardCount: 0,
        licence: 'protected',
        usage: 'navigation',
        sizeBytes: 1000,
    };
    h.cells = [cell];
    const layers = Object.fromEntries(
        [
            'DEPARE',
            'LNDARE',
            'COALNE',
            'OBSTRN',
            'WRECKS',
            'UWTROC',
            'SOUNDG',
            'M_QUAL',
            'M_SDAT',
            'RESARE',
            'TSEZNE',
            'TSSLPT',
            'BRIDGE',
            'CBLOHD',
            'PIPOHD',
            'CONVYR',
            'SLCONS',
            'DAMCON',
            'PILPNT',
            'PONTON',
            'MARCUL',
        ].map((name) => [name, { type: 'FeatureCollection', features: [] }]),
    ) as EncConversionResult['layers'];
    layers.DEPARE!.features.push({ type: 'Feature', properties: { DRVAL1: 1, DRVAL2: 2 }, geometry: rectangle(0.01) });
    layers.M_QUAL!.features.push({ type: 'Feature', properties: { CATZOC: 2 }, geometry: rectangle(1) });
    h.blob = {
        cellId: cell.id,
        sourceHO: cell.sourceHO,
        edition: 1,
        updateNumber: 0,
        issued: cell.issued,
        bbox: cell.bbox,
        soundingDatum: 'LAT',
        extractorSchema: 3,
        layers,
    };
    h.load.mockImplementation(async () => h.blob);
    h.peek.mockImplementation(() => h.blob);
    const raw: SampledTideSeries = {
        schema: 1,
        kind: 'sampled-prediction',
        provider: 'NOAA',
        productId: 'fictional-product',
        stationId: 'fictional-station',
        stationName: 'Fictional station',
        lat: 0,
        lon: 0,
        datumId: 'fictional-MLLW',
        datumLabel: 'Fictional MLLW',
        datumEpoch: 'fictional-epoch',
        sourceAtMs: T - H,
        receivedAtMs: T,
        expiresAtMs: T + H,
        sourceUrl: 'https://tidesandcurrents.noaa.gov/',
        licenceUrl: 'https://tidesandcurrents.noaa.gov/',
        units: 'm',
        samples: Array.from({ length: 5 }, (_, i) => ({ timeMs: T - H + i * H, heightM: 2 })),
    };
    const bound = bindAdapterSampledTideSeries(
        raw,
        {
            provider: raw.provider,
            productId: raw.productId,
            requestUrl: raw.sourceUrl,
            responseUrl: raw.sourceUrl,
            receivedAtMs: T,
            bodySha256: 'b'.repeat(64),
        },
        T,
    );
    if (!bound) throw Error('Bad fictional source');
    h.series = [bound];
    h.readSources.mockImplementation(async () => ({ navigationSeries: h.series, stations: [], notes: [] }));
    h.authority.sources = [
        {
            reviewId: 'FICTIONAL-REVIEW',
            provider: 'NOAA',
            productId: raw.productId,
            sourceUrlPrefix: raw.sourceUrl,
            rights: {
                basis: 'public-agency-navigation-use',
                reference: 'https://tidesandcurrents.noaa.gov/fictional-rights',
            },
            uses: ['sounding'],
            validFromMs: T - 24 * H,
            validUntilMs: T + 24 * H,
            maxIssueAgeMs: 24 * H,
            maxSampleGapMs: H,
            predictionUncertaintyM: 0.1,
        },
    ];
    h.authority.ties = [
        {
            reviewId: 'FICTIONAL-TIE',
            provider: 'NOAA',
            productId: raw.productId,
            stationId: raw.stationId,
            sourceDatumId: raw.datumId,
            sourceDatumEpoch: raw.datumEpoch!,
            chartContentKey: encCellContentIdentity(cell),
            targetDatumId: 'LAT',
            targetDatumEpoch: 'fictional-chart-epoch',
            use: 'sounding',
            sourceReference: 'https://tidesandcurrents.noaa.gov/fictional-tie',
            validFromMs: T - 24 * H,
            validUntilMs: T + 24 * H,
            coverage: [[-0.05, -0.05, 0.05, 0.05]],
            maxDistanceKm: 15,
            offsetM: 0,
            uncertaintyM: 0.1,
        },
    ];
});
afterEach(() => {
    retireTideShortcutPreview();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('aboard source permit', () => {
    it('joins real source admission to the real strict worker across original shallow/deep seams', async () => {
        const fetch = vi.fn(async () => {
            throw Error('No WAN is allowed in this joined source fixture.');
        });
        vi.stubGlobal('fetch', fetch);
        const rect = (w: number, s: number, e: number, n: number, depth: number): GeoJSON.Feature<GeoJSON.Polygon> => ({
            type: 'Feature',
            properties: { acronym: 'DEPARE', DRVAL1: depth, DRVAL2: depth + 1 },
            geometry: {
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
            },
        });
        h.blob!.layers.DEPARE!.features = [
            rect(-0.2, -0.2, -0.00035, 0.2, 5),
            rect(0.00035, -0.2, 0.2, 0.2, 5),
            rect(-0.00035, 0.0009, 0.00035, 0.2, 5),
            rect(-0.00035, -0.2, 0.00035, -0.0009, 5),
            rect(-0.00035, -0.0009, 0.00035, 0.0009, 1),
        ];
        const result = await planTideGatedShortcut(
            {
                ...input(),
                from: { lat: 0, lon: -0.0015 },
                to: { lat: 0, lon: 0.0015 },
                draftM: 2,
                safetyM: 0.5,
                airDraftM: null,
            },
            options(),
        );
        expect(result.kind, JSON.stringify(result)).toBe('preview');
        if (result.kind !== 'preview') return;
        expect(h.workerCalls).toBe(1);
        expect(await finalizeTideShortcutPreview(result.result)).toBe(true);
        // The real public wrapper must preserve this exact private identity;
        // the ordinary water-pack decorator clones results when it has data.
        const planning = await import('../services/routing/tideGatedPlanning');
        vi.spyOn(planning, 'planTideGatedShortcut').mockResolvedValueOnce(result);
        const { tryInshoreRoute } = await import('../services/InshoreRouter');
        const exposed = await tryInshoreRoute({ lat: 0, lon: -0.0015 }, { lat: 0, lon: 0.0015 }, 2, null, 'safest', {
            departureMs: T,
            tideShortcut: { speedKts: 6, uncertaintyMs: 900000 },
        });
        expect(exposed).toBe(result.result);
        expect(exposed && 'polyline' in exposed && (await finalizeTideShortcutPreview(exposed))).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        retireTideShortcutPreview(result.result);
        expect(h.contextRelease).toHaveBeenCalledOnce();
    });
    it('keeps actual adapters without original navigation samples held without chart I/O or WAN', async () => {
        h.series = [];
        const result = await prepareTideGatedSources(input(), options());
        expect(result.kind).toBe('held');
        expect(h.load).not.toHaveBeenCalled();
        expect(h.readSources).toHaveBeenCalledWith(expect.anything(), T, 'aboard', expect.anything());
    });
    it('admits a future fictional fully acquired/reviewed source; copies are not permits', async () => {
        const result = await prepareTideGatedSources(input(), options());
        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') return;
        expect(checkTideGatedSourcePermit(result.permit)).toBe(true);
        expect(checkTideGatedSourcePermit({ ...result.permit })).toBe(false);
        expect(checkTideGatedSourcePermit(JSON.parse(JSON.stringify(result.permit)))).toBe(false);
        expect(result.permit.request.areas[0].windows.length).toBeGreaterThan(0);
        expect(Object.isFrozen(result.permit.request.areas[0].geometry)).toBe(true);
        expect(Object.isFrozen(result.permit.layers.DEPARE!.features)).toBe(true);
        expect(await recheckTideGatedSourcePermit(result.permit, fakePath())).toBe(true);
        result.release();
        expect(() => checkTideGatedSourcePermit(result.permit)).toThrow(/retired/);
    });
    it.each(['receipt', 'datum', 'epoch', 'rights', 'acquisition', 'cohort', 'quality', 'missing-class', 'soundings'])(
        'holds missing %s proof',
        async (kind) => {
            if (kind === 'receipt') h.receipt = null;
            if (kind === 'datum') h.blob!.soundingDatum = undefined;
            if (kind === 'epoch') h.authority.ties[0].targetDatumEpoch = '';
            if (kind === 'rights') h.authority.sources = [];
            if (kind === 'acquisition') h.series = [{ ...h.series[0] }];
            if (kind === 'cohort') h.cells = Array.from({ length: 15 }, () => h.cells[0]);
            if (kind === 'quality') h.blob!.layers.M_QUAL!.features[0].properties!.CATZOC = 6;
            if (kind === 'missing-class') delete h.blob!.layers.UWTROC;
            if (kind === 'soundings')
                h.blob!.layers.SOUNDG!.features.push({
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'Point', coordinates: [0, 0] },
                });
            const result = await prepareTideGatedSources(input(), options());
            expect(result.kind).toBe('held');
        },
    );
    it('releases a late read without issuing after a chart transition', async () => {
        h.peek.mockImplementationOnce(() => {
            h.version++;
            return h.blob;
        });
        await expect(prepareTideGatedSources(input(), options())).rejects.toThrow(/retired/);
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('retires on receipt, owner, boat and chart changes', async () => {
        for (const kind of ['receipt', 'owner', 'boat', 'chart', 'private-memory']) {
            const result = await prepareTideGatedSources(input(), options());
            expect(result.kind).toBe('ready');
            if (result.kind !== 'ready') return;
            if (kind === 'receipt') h.receipt = {};
            if (kind === 'owner') h.scope.generation++;
            if (kind === 'boat') h.prior += '-next';
            if (kind === 'chart') h.version++;
            if (kind === 'private-memory') h.chartLifetime++;
            expect(() => checkTideGatedSourcePermit(result.permit)).toThrow(/retired/);
            result.release();
        }
    });
    it('rejects an exact-clock or geometry mutation during the final original-interval reread', async () => {
        const result = await prepareTideGatedSources(input(), options());
        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') return;
        const path = fakePath();
        const proof = recheckTideGatedSourcePermit(result.permit, path);
        path.points[1][0] += 0.00001;
        expect(await proof).toBe(false);
        result.release();
    });
    it('retains the original modeled clock without minute rounding', async () => {
        const result = await prepareTideGatedSources(input(), options());
        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') return;
        const path = fakePath();
        path.timesMs[1] = Math.round(path.timesMs[1] / 60000) * 60000;
        expect(await recheckTideGatedSourcePermit(result.permit, path)).toBe(false);
        result.release();
    });
    it.each(['grid-layout', 'cell-index', 'interior-position'])('refuses a forged %s final footprint', async (kind) => {
        const result = await prepareTideGatedSources(input(), options());
        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') return;
        const path = fakePath();
        if (kind === 'grid-layout') path.grid.dLon *= 0.99;
        if (kind === 'cell-index') path.indices[1] += path.grid.width;
        if (kind === 'interior-position') path.points[1][0] += path.grid.dLon / 10;
        expect(await recheckTideGatedSourcePermit(result.permit, path)).toBe(false);
        result.release();
    });
    it.each(['physical-point', 'drying-sliver', 'shallow-sounding'])(
        'checks original %s across the complete final cell rather than only its centre',
        async (kind) => {
            const path = fakePath(),
                x = path.points[1][0] + path.grid.dLon / 3,
                y = path.points[1][1] + path.grid.dLat / 3;
            if (kind === 'physical-point')
                h.blob!.layers.OBSTRN!.features.push({
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'Point', coordinates: [x, y] },
                });
            if (kind === 'shallow-sounding')
                h.blob!.layers.SOUNDG!.features.push({
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'Point', coordinates: [x, y, 0.1] },
                });
            if (kind === 'drying-sliver') {
                const d = path.grid.dLon / 100;
                h.blob!.layers.DEPARE!.features.push({
                    type: 'Feature',
                    properties: { DRVAL1: -0.1, DRVAL2: 0 },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [x, y],
                                [x + d, y],
                                [x + d, y + d],
                                [x, y + d],
                                [x, y],
                            ],
                        ],
                    },
                });
            }
            const result = await prepareTideGatedSources(input(), options());
            expect(result.kind).toBe('ready');
            if (result.kind !== 'ready') return;
            expect(await recheckTideGatedSourcePermit(result.permit, path)).toBe(false);
            result.release();
        },
    );
    it('does not assume a dateline or polar chart transfer', () => {
        expect(tideGatedBounds({ lat: 0, lon: 179.99 }, { lat: 0, lon: -179.99 })).toBeNull();
        expect(tideGatedBounds({ lat: 81, lon: 0 }, { lat: 81, lon: 1 })).toBeNull();
    });
    it.each(['absent', 'unmeasured', 'over-budget'])(
        'holds a private %s RAM view without fetching or trusting metadata bytes',
        async (kind) => {
            if (kind === 'absent') h.peek.mockReturnValueOnce(null);
            if (kind === 'unmeasured') h.byteLength = null;
            if (kind === 'over-budget') {
                h.cells[0].sizeBytes = 1;
                h.byteLength = 16 * 1024 * 1024 + 1;
            }
            expect((await prepareTideGatedSources(input(), options())).kind).toBe('held');
            expect(h.load).not.toHaveBeenCalled();
        },
    );
    it('reads a deep original sounding without converting it to a physical obstacle', async () => {
        h.blob!.layers.SOUNDG!.features.push({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [0, 0, 9] },
        });
        const r = await prepareTideGatedSources(input(), options());
        expect(r.kind).toBe('ready');
        if (r.kind !== 'ready') return;
        expect(r.permit.request.soundings).toEqual([{ lon: 0, lat: 0, depthM: 9 }]);
        r.release();
    });
});
