/** Fictional chart, transport and rights reviews exercise the real source gate.
 * These fixtures are not a live Pi read or a real navigation permission. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { SampledTideAuthority } from '../services/tides/sampledTideNavigation';
import type { SampledTideSeries } from '../services/tides/sampledTideContract';
const h = vi.hoisted(() => ({
    version: 1,
    scope: { key: 'user:fictional', userId: 'fictional', generation: 1 },
    prior: 'fictional-boat-1',
    cells: [] as EncCell[],
    blob: null as EncConversionResult | null,
    series: [] as SampledTideSeries[],
    authority: { sources: [], ties: [] } as SampledTideAuthority,
    receipt: {} as object | null,
    release: vi.fn(),
    load: vi.fn(),
    readSources: vi.fn(),
}));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => h.cells, getVersion: () => h.version }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: h.load }));
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
}));
vi.mock('../services/routing/trackRoutingPriors', () => ({ trackPriorContextKey: () => h.prior }));
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
        distanceM = haversineM(0, r.from.lon, 0, r.to.lon);
    return {
        points: [
            [r.from.lon, 0],
            [r.to.lon, 0],
        ] as [number, number][],
        timesMs: [T, T + (distanceM / ((r.speedKts * 1852) / 3600)) * 1000],
        indices: [1, 2],
        tideCells: [1],
        distanceM,
    };
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(T);
    h.version++;
    h.scope.generation++;
    h.prior = 'fictional-boat-1';
    h.receipt = {};
    h.release.mockReset();
    h.load.mockReset();
    h.readSources.mockReset();
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
            'OBSTRN',
            'WRECKS',
            'UWTROC',
            'SOUNDG',
            'M_QUAL',
            'M_SDAT',
            'RESARE',
            'TSEZNE',
            'BRIDGE',
            'CBLOHD',
            'PIPOHD',
            'CONVYR',
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
afterEach(() => vi.restoreAllMocks());

describe('aboard source permit', () => {
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
        h.load.mockImplementationOnce(async () => {
            h.version++;
            return h.blob;
        });
        await expect(prepareTideGatedSources(input(), options())).rejects.toThrow(/retired/);
        expect(h.release).toHaveBeenCalledOnce();
    });
    it('retires on receipt, owner, boat and chart changes', async () => {
        for (const kind of ['receipt', 'owner', 'boat', 'chart']) {
            const result = await prepareTideGatedSources(input(), options());
            expect(result.kind).toBe('ready');
            if (result.kind !== 'ready') return;
            if (kind === 'receipt') h.receipt = {};
            if (kind === 'owner') h.scope.generation++;
            if (kind === 'boat') h.prior += '-next';
            if (kind === 'chart') h.version++;
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
    it('does not assume a dateline or polar chart transfer', () => {
        expect(tideGatedBounds({ lat: 0, lon: 179.99 }, { lat: 0, lon: -179.99 })).toBeNull();
        expect(tideGatedBounds({ lat: 81, lon: 0 }, { lat: 81, lon: 1 })).toBeNull();
    });
});
