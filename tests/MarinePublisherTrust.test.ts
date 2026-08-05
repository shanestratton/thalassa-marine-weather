import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    assertCmemsFrameMemoryBudget,
    CMEMS_DATASETS,
    decodeThcuV2,
    fetchBoundedPublisherBytes,
    immutableCmemsManifestIdentity,
    publisherGenerationSuffix,
    readBoundedResponse,
    sha256Hex,
    validateCmemsManifest,
    verifyPublisherAsset,
    type CmemsManifest,
} from '../services/weather/api/cmemsGridTrust';
import {
    clearMpaDatasetCache,
    fetchVerifiedMpaGeoJson,
    getVerifiedMpaDatasetStatus,
    MPA_CACHE_TTL_MS,
    releaseMpaDataset,
    validateMpaGeoJson,
    validateMpaManifest,
    type MpaManifest,
    type MpaProperties,
} from '../services/weather/api/mpaDataset';

const NOW = Date.parse('2026-08-05T12:00:00Z');
const WIDTH = 1440;
const HEIGHT = 681;
const CELLS = WIDTH * HEIGHT;
const BYTES = 30 + CELLS * 9;
const BOUNDS = { north: 90, south: -80, west: -179.875, east: 179.875 };

function currentsManifest(): CmemsManifest {
    const generation = 'g-20260805T060000Z-6596b9958bcd';
    return {
        schema_version: 2,
        dataset: { key: 'currents', id: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i' },
        generation,
        generated_at: '2026-08-05T06:30:00Z',
        published_at: '2026-08-05T07:00:00Z',
        data_start: '2026-08-05T06:00:00Z',
        data_end: '2026-08-05T18:00:00Z',
        cadence_hours: 1,
        dimensions: { width: WIDTH, height: HEIGHT },
        bounds: BOUNDS,
        producer: { commit: '1'.repeat(40), run_id: 123, run_attempt: 1 },
        files: Array.from({ length: 13 }, (_, step) => ({
            step,
            offset_hours: step,
            data_time: `2026-08-05T${String(step + 6).padStart(2, '0')}:00:00Z`,
            filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
            bytes: BYTES,
            sha256: 'a'.repeat(64),
            content_type: 'application/octet-stream' as const,
        })),
        metadata: { attribution: 'Copernicus Marine Service' },
    };
}

function makeThcu(): Uint8Array {
    const bytes = new Uint8Array(BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x55434854, true);
    view.setUint8(4, 2);
    view.setUint8(5, 0);
    view.setUint16(6, WIDTH, true);
    view.setUint16(8, HEIGHT, true);
    view.setFloat32(10, BOUNDS.north, true);
    view.setFloat32(14, BOUNDS.south, true);
    view.setFloat32(18, BOUNDS.west, true);
    view.setFloat32(22, BOUNDS.east, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 0, true);
    const vOffset = 30 + CELLS * 4;
    const maskOffset = vOffset + CELLS * 4;
    for (let index = 0; index < CELLS; index++) {
        view.setFloat32(30 + index * 4, (index % 101) / 100, true);
        view.setFloat32(vOffset + index * 4, 0.2, true);
        bytes[maskOffset + index] = index % 10 < 3 ? 1 : 0;
    }
    return bytes;
}

describe('CMEMS schema-v2 client trust boundary', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('gives 12-hourly waves one honest 3-hour cadence margin without weakening currents', () => {
        expect(CMEMS_DATASETS.waves.maxSourceAgeHours).toBe(15);
        expect(CMEMS_DATASETS.currents.maxSourceAgeHours).toBe(12);
    });

    it('derives every CMEMS scrubber count from the inclusive manifest contract with load-aware playback', () => {
        expect(CMEMS_DATASETS.currents.steps).toBe(13);
        const weatherLayers = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
        const mapHub = readFileSync('components/map/MapHub.tsx', 'utf8');
        const playback = readFileSync('components/map/useCmemsPlayback.ts', 'utf8');
        const controls = readFileSync('components/map/MapWeatherControls.tsx', 'utf8');
        expect(weatherLayers).toContain('const currentsTotalHours = CMEMS_DATASETS.currents.steps;');
        expect(weatherLayers).toContain('const wavesTotalHours = CMEMS_DATASETS.waves.steps;');
        expect(weatherLayers).toContain('const sstTotalSteps = CMEMS_DATASETS.sst.steps;');
        expect(weatherLayers).toContain('const chlTotalSteps = CMEMS_DATASETS.chl.steps;');
        expect(weatherLayers).toContain('const seaiceTotalSteps = CMEMS_DATASETS.seaice.steps;');
        expect(weatherLayers).toContain('const mldTotalSteps = CMEMS_DATASETS.mld.steps;');
        for (const timeline of [
            'currentsTotalHours',
            'wavesTotalHours',
            'sstTotalSteps',
            'chlTotalSteps',
            'seaiceTotalSteps',
            'mldTotalSteps',
        ]) {
            expect(mapHub).toContain(`totalSteps: weather.${timeline},`);
        }
        expect(mapHub).toContain('useCmemsAutoplay(activeCmemsPlayback);');
        expect(playback).toContain('if (next >= config.totalSteps)');
        expect(playback).toContain('if (!isCmemsRenderedStepReady(config.status, step)) return;');
        expect(controls).toContain('totalFrames = weather.currentsTotalHours;');
    });

    it('accepts only the exact identity, cadence, source times and immutable filenames', () => {
        const manifest = currentsManifest();
        expect(validateCmemsManifest(manifest, 'currents', NOW)).toEqual(manifest);

        const wrongTime = structuredClone(manifest);
        wrongTime.files[3].data_time = '2026-08-05T08:30:00Z';
        expect(() => validateCmemsManifest(wrongTime, 'currents', NOW)).toThrow(/source time/i);

        const mixedGeneration = structuredClone(manifest);
        mixedGeneration.files[2].filename = 'g-20260805T060000Z-bbbbbbbbbbbb-h002.bin';
        expect(() => validateCmemsManifest(mixedGeneration, 'currents', NOW)).toThrow(/filename/i);

        const stale = structuredClone(manifest);
        stale.data_start = '2026-08-04T00:00:00Z';
        stale.data_end = '2026-08-04T12:00:00Z';
        stale.generation = 'g-20260804T000000Z-aaaaaaaaaaaa';
        stale.files.forEach((file, step) => {
            file.data_time = `2026-08-04T${String(step).padStart(2, '0')}:00:00Z`;
            file.filename = `${stale.generation}-h${String(step).padStart(3, '0')}.bin`;
        });
        expect(() => validateCmemsManifest(stale, 'currents', NOW)).toThrow(/cover|stale/i);

        const future = structuredClone(manifest);
        future.generated_at = '2026-08-05T13:00:00Z';
        future.published_at = '2026-08-05T13:01:00Z';
        expect(() => validateCmemsManifest(future, 'currents', NOW)).toThrow(/future/i);
    });

    it('strictly decodes v2 THCU and rejects truncated, huge, non-finite, implausible and bad-mask payloads', () => {
        const manifest = currentsManifest();
        const file = manifest.files[0];
        const bytes = makeThcu();
        const view = new DataView(bytes.buffer);
        expect(decodeThcuV2(bytes, manifest, file).landMask).toHaveLength(CELLS);

        expect(() => decodeThcuV2(bytes.subarray(0, 29), manifest, file)).toThrow(/length|truncated/i);

        view.setUint16(6, 65_535, true);
        expect(() => decodeThcuV2(bytes, manifest, file)).toThrow(/dimensions/i);
        view.setUint16(6, WIDTH, true);

        view.setFloat32(30, Number.NaN, true);
        expect(() => decodeThcuV2(bytes, manifest, file)).toThrow(/non-finite/i);
        view.setFloat32(30, 0.1, true);

        view.setFloat32(30 + CELLS * 4, Number.POSITIVE_INFINITY, true);
        expect(() => decodeThcuV2(bytes, manifest, file)).toThrow(/non-finite/i);
        view.setFloat32(30 + CELLS * 4, 0.2, true);

        view.setFloat32(30, 9, true);
        expect(() => decodeThcuV2(bytes, manifest, file)).toThrow(/implausible current/i);
        view.setFloat32(30, 0.1, true);

        const maskOffset = 30 + CELLS * 8;
        bytes[maskOffset] = 2;
        expect(() => decodeThcuV2(bytes, manifest, file)).toThrow(/mask/i);
    });

    it('binds generation hashes exactly like Python and verifies asset bytes and SHA-256', async () => {
        expect(
            await publisherGenerationSuffix('2026-08-05T06:00:00Z', 'currents', ['a'.repeat(64), 'b'.repeat(64)]),
        ).toBe('0d5c30d3aca1');
        expect(await publisherGenerationSuffix('2024-06-01T00:00:00Z', 'mpa', ['c'.repeat(64)])).toBe('4032f2a216e2');
        const bytes = new TextEncoder().encode('trusted bytes');
        const hash = await sha256Hex(bytes);
        await expect(verifyPublisherAsset(bytes, bytes.length, hash, 'fixture')).resolves.toBeUndefined();
        await expect(verifyPublisherAsset(bytes, bytes.length, '0'.repeat(64), 'fixture')).rejects.toThrow(/SHA-256/i);
        await expect(verifyPublisherAsset(bytes, bytes.length + 1, hash, 'fixture')).rejects.toThrow(/length/i);
    });

    it('caps streamed bodies in one bounded allocation', async () => {
        const oversizedHeader = new Response('x', { headers: { 'content-length': '999' } });
        await expect(readBoundedResponse(oversizedHeader, 16)).rejects.toThrow(/ceiling/i);

        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(10));
                controller.enqueue(new Uint8Array(10));
                controller.close();
            },
        });
        await expect(readBoundedResponse(new Response(body), 16)).rejects.toThrow(/streaming/i);

        const exactBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.enqueue(new Uint8Array([3, 4]));
                controller.close();
            },
        });
        const exact = await readBoundedResponse(new Response(exactBody), 4);
        expect([...exact]).toEqual([1, 2, 3, 4]);
        expect(exact.byteLength).toBe(exact.buffer.byteLength);
    });

    it.each([
        {
            name: 'non-success status',
            response: (body: ReadableStream<Uint8Array>) =>
                new Response(body, {
                    status: 503,
                    headers: { 'content-type': 'application/octet-stream' },
                }),
            expectedError: /HTTP 503/i,
        },
        {
            name: 'unexpected content type',
            response: (body: ReadableStream<Uint8Array>) =>
                new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                }),
            expectedError: /wrong content type/i,
        },
        {
            name: 'oversized declaration',
            response: (body: ReadableStream<Uint8Array>) =>
                new Response(body, {
                    status: 200,
                    headers: {
                        'content-type': 'application/octet-stream',
                        'content-length': '17',
                    },
                }),
            expectedError: /byte ceiling/i,
        },
    ])('awaits upstream body cancellation before rejecting a $name', async ({ response, expectedError }) => {
        let releaseCancellation!: () => void;
        const cancellationGate = new Promise<void>((resolve) => {
            releaseCancellation = resolve;
        });
        const cancel = vi.fn(() => cancellationGate);
        const body = new ReadableStream<Uint8Array>({ cancel });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

        let settled = false;
        const pending = fetchBoundedPublisherBytes('/api/currents/frame.bin', 16, 'application/octet-stream').finally(
            () => {
                settled = true;
            },
        );

        await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        releaseCancellation();
        await expect(pending).rejects.toThrow(expectedError);
        vi.unstubAllGlobals();
    });

    it('mirrors an already-aborted caller signal before starting a publisher fetch', async () => {
        const controller = new AbortController();
        controller.abort(new Error('pre-aborted fixture'));
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(
            fetchBoundedPublisherBytes('/api/currents/frame.bin', 16, 'application/octet-stream', controller.signal),
        ).rejects.toThrow(/pre-aborted fixture/i);
        expect(fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('uses an immutable-core identity but permits fresh publication evidence for the same generation', () => {
        const original = currentsManifest();
        const retry = structuredClone(original);
        retry.generated_at = '2026-08-05T07:30:00Z';
        retry.published_at = '2026-08-05T08:00:00Z';
        retry.producer = { commit: '2'.repeat(40), run_id: 124, run_attempt: 2 };
        expect(immutableCmemsManifestIdentity(retry)).toBe(immutableCmemsManifestIdentity(original));
        retry.files[0].sha256 = 'b'.repeat(64);
        expect(immutableCmemsManifestIdentity(retry)).not.toBe(immutableCmemsManifestIdentity(original));
    });

    it('enforces a bounded one-frame decoder and two-frame LRU ownership contract', () => {
        const manifest = currentsManifest();
        expect(() => assertCmemsFrameMemoryBudget(manifest)).not.toThrow();
        const unsafe = structuredClone(manifest);
        unsafe.dimensions = { width: 5_000, height: 5_000 };
        expect(() => assertCmemsFrameMemoryBudget(unsafe)).toThrow(/frame decoded-memory budget/i);

        const source = readFileSync('services/weather/api/cmemsGridTrust.ts', 'utf8');
        expect(source).toContain('export const CMEMS_FRAME_CACHE_LIMIT = 2');
        expect(source).toContain('async function fetchAndValidateFrame(');
        expect(source).toContain('sourceStep,');
        expect(source).toContain('buildSparseGrid(manifest, new Map([[requestedStep, decoded]])');
        expect(source).toContain('releaseCmemsGrid(dataset)');
        expect(source).toContain('speed: new Array<Float32Array>(totalSteps)');
        expect(source).not.toContain('decoded.speed');
        expect(source).toMatch(/manifest-v2\.json[\s\S]*fetchBoundedPublisherBytes[\s\S]*'force-cache'/);
    });
});

const MPA_BOUNDS = { west: 70.717, east: 170.3667, south: -58.4488, north: -8.4738 };

function mpaManifest(): MpaManifest {
    const generation = 'g-20240601T000000Z-4032f2a216e2';
    return {
        schema_version: 2,
        dataset: { key: 'mpa', id: 'dcceew-capad-mapserver-layer-1' },
        generation,
        generated_at: '2026-08-05T06:00:00Z',
        published_at: '2026-08-05T06:05:00Z',
        data_start: '2024-06-01T00:00:00Z',
        data_end: '2024-06-01T00:00:00Z',
        cadence_hours: null,
        dimensions: { feature_count: 100 },
        bounds: MPA_BOUNDS,
        producer: { commit: '3'.repeat(40), run_id: 456, run_attempt: 1 },
        files: [
            {
                step: 0,
                filename: `${generation}-mpa.geojson`,
                bytes: 100_000,
                sha256: 'c'.repeat(64),
                content_type: 'application/geo+json',
            },
        ],
        metadata: { notice: 'Indicative heuristic; verify current rules.' },
    };
}

const MPA_PROPS: MpaProperties = {
    name: 'Example marine reserve',
    type: 'Marine park',
    iucn: 'VI',
    zone: '',
    authority: 'DCCEEW',
    state: 'External territory',
    area_km2: 123.4,
    protection_class: 'multiple_use',
    classification_source: 'indicative_heuristic',
};

function mpaCollection() {
    const ring = [
        [MPA_BOUNDS.west, MPA_BOUNDS.south],
        [MPA_BOUNDS.east, MPA_BOUNDS.south],
        [MPA_BOUNDS.east, MPA_BOUNDS.north],
        [MPA_BOUNDS.west, MPA_BOUNDS.north],
        [MPA_BOUNDS.west, MPA_BOUNDS.south],
    ];
    return {
        type: 'FeatureCollection',
        features: Array.from({ length: 100 }, () => ({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { ...MPA_PROPS },
        })),
    };
}

describe('MPA schema-v2 client trust boundary', () => {
    afterEach(() => {
        clearMpaDatasetCache();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
    it('accepts the real Australian external-territory envelope without truncation', () => {
        const manifest = mpaManifest();
        manifest.dimensions.feature_count = 4_541;
        expect(validateMpaManifest(manifest, NOW).bounds).toEqual(MPA_BOUNDS);
    });

    it('validates exact feature count, polygons, properties, coordinate domain and observed bounds', () => {
        const manifest = mpaManifest();
        const collection = mpaCollection();
        expect(validateMpaGeoJson(collection, manifest).features).toHaveLength(100);

        const tinyZone = structuredClone(collection);
        tinyZone.features[0].properties.area_km2 = 0.000001;
        expect(() => validateMpaGeoJson(tinyZone, manifest)).not.toThrow();

        const zeroArea = structuredClone(collection);
        zeroArea.features[0].properties.area_km2 = 0;
        expect(() => validateMpaGeoJson(zeroArea, manifest)).toThrow(/area must be positive/i);

        const badGeometry = structuredClone(collection);
        badGeometry.features[0].geometry.type = 'LineString';
        expect(() => validateMpaGeoJson(badGeometry, manifest)).toThrow(/geometry type/i);

        const badCoordinate = structuredClone(collection);
        badCoordinate.features[0].geometry.coordinates[0][0][0] = 181;
        expect(() => validateMpaGeoJson(badCoordinate, manifest)).toThrow(/longitude|bounds/i);

        const badProperty = structuredClone(collection);
        delete (badProperty.features[0].properties as Partial<MpaProperties>).classification_source;
        expect(() => validateMpaGeoJson(badProperty, manifest)).toThrow(/missing/i);
    });

    it('allows an old authoritative source snapshot but rejects a stale weekly publication and future source', () => {
        expect(() => validateMpaManifest(mpaManifest(), NOW)).not.toThrow();
        const stalePublication = mpaManifest();
        stalePublication.generated_at = '2026-07-01T06:00:00Z';
        stalePublication.published_at = '2026-07-01T06:05:00Z';
        expect(() => validateMpaManifest(stalePublication, NOW)).toThrow(/weekly publication is stale/i);

        const futureSource = mpaManifest();
        futureSource.data_start = '2026-08-06T00:00:00Z';
        futureSource.data_end = futureSource.data_start;
        futureSource.generation = 'g-20260806T000000Z-cccccccccccc';
        futureSource.files[0].filename = `${futureSource.generation}-mpa.geojson`;
        expect(() => validateMpaManifest(futureSource, NOW)).toThrow(/source timestamp is in the future/i);
    });

    it('clears a previously verified overlay when its 30-minute refresh fails', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const bundle = await mpaNetworkBundle();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(bundle.manifest))
            .mockResolvedValueOnce(geoJsonResponse(bundle.asset))
            .mockResolvedValueOnce(
                new Response('unavailable', { status: 503, headers: { 'content-type': 'application/json' } }),
            );
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchVerifiedMpaGeoJson()).resolves.not.toBeNull();
        expect(getVerifiedMpaDatasetStatus()?.generation).toBe(bundle.manifest.generation);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
        expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'force-cache' });
        vi.setSystemTime(NOW + MPA_CACHE_TTL_MS + 1_000);
        await expect(fetchVerifiedMpaGeoJson()).resolves.toBeNull();
        expect(getVerifiedMpaDatasetStatus()).toBeNull();
    });

    it('accepts fresh health evidence for an unchanged immutable generation and updates cached publication status', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const first = await mpaNetworkBundle();
        const refreshed = structuredClone(first.manifest);
        refreshed.generated_at = '2026-08-05T12:10:00Z';
        refreshed.published_at = '2026-08-05T12:15:00Z';
        refreshed.producer = { commit: '4'.repeat(40), run_id: 999, run_attempt: 2 };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(first.manifest))
            .mockResolvedValueOnce(geoJsonResponse(first.asset))
            .mockResolvedValueOnce(jsonResponse(refreshed));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchVerifiedMpaGeoJson()).resolves.not.toBeNull();
        vi.setSystemTime(NOW + MPA_CACHE_TTL_MS + 1_000);
        await expect(fetchVerifiedMpaGeoJson()).resolves.not.toBeNull();
        expect(getVerifiedMpaDatasetStatus()?.publishedAt).toBe('2026-08-05T12:15:00Z');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('drops the old parsed generation before requesting a replacement asset', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const first = await mpaNetworkBundle();
        const replacementCollection = mpaCollection();
        replacementCollection.features[0].properties.name = 'Replacement marine reserve';
        const replacement = await mpaNetworkBundle(replacementCollection);
        expect(replacement.manifest.generation).not.toBe(first.manifest.generation);

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(first.manifest))
            .mockResolvedValueOnce(geoJsonResponse(first.asset))
            .mockResolvedValueOnce(jsonResponse(replacement.manifest))
            .mockImplementationOnce(() => {
                expect(getVerifiedMpaDatasetStatus()).toBeNull();
                return Promise.resolve(geoJsonResponse(replacement.asset));
            });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchVerifiedMpaGeoJson()).resolves.not.toBeNull();
        vi.setSystemTime(NOW + MPA_CACHE_TTL_MS + 1_000);
        const beforeReplacement = vi.fn();
        const loaded = await fetchVerifiedMpaGeoJson(undefined, beforeReplacement);

        expect(beforeReplacement).toHaveBeenCalledOnce();
        expect(beforeReplacement).toHaveBeenCalledWith(replacement.manifest.generation);
        expect(loaded?.features[0].properties.name).toBe('Replacement marine reserve');
        expect(getVerifiedMpaDatasetStatus()?.generation).toBe(replacement.manifest.generation);
    });

    it('does not fetch or claim a replacement generation when presentation teardown fails', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const first = await mpaNetworkBundle();
        const replacementCollection = mpaCollection();
        replacementCollection.features[0].properties.name = 'Must not mount';
        const replacement = await mpaNetworkBundle(replacementCollection);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(first.manifest))
            .mockResolvedValueOnce(geoJsonResponse(first.asset))
            .mockResolvedValueOnce(jsonResponse(replacement.manifest));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchVerifiedMpaGeoJson()).resolves.not.toBeNull();
        vi.setSystemTime(NOW + MPA_CACHE_TTL_MS + 1_000);
        const failedRemoval = vi.fn(() => {
            throw new Error('Mapbox still owns stale MPA geometry');
        });

        await expect(fetchVerifiedMpaGeoJson(undefined, failedRemoval)).resolves.toBeNull();
        expect(failedRemoval).toHaveBeenCalledWith(replacement.manifest.generation);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(getVerifiedMpaDatasetStatus()).toBeNull();
    });

    it('cannot repopulate parsed GeoJSON after the overlay releases during a fetch', async () => {
        const bundle = await mpaNetworkBundle();
        let resolveManifest!: (response: Response) => void;
        const fetchMock = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveManifest = resolve;
                }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const loading = fetchVerifiedMpaGeoJson();
        await Promise.resolve();
        releaseMpaDataset();
        resolveManifest(jsonResponse(bundle.manifest));

        await expect(loading).resolves.toBeNull();
        expect(getVerifiedMpaDatasetStatus()).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

async function mpaNetworkBundle(collection = mpaCollection()): Promise<{ manifest: MpaManifest; asset: Uint8Array }> {
    const encoded = new TextEncoder().encode(JSON.stringify(collection));
    const asset = new Uint8Array(Math.max(100_000, encoded.byteLength));
    asset.set(encoded);
    asset.fill(0x20, encoded.byteLength);
    const digest = await sha256Hex(asset);
    const manifest = mpaManifest();
    const suffix = await publisherGenerationSuffix(manifest.data_start, 'mpa', [digest]);
    manifest.generation = `g-20240601T000000Z-${suffix}`;
    manifest.files[0] = {
        step: 0,
        filename: `${manifest.generation}-mpa.geojson`,
        bytes: asset.byteLength,
        sha256: digest,
        content_type: 'application/geo+json',
    };
    return { manifest, asset };
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function geoJsonResponse(value: Uint8Array): Response {
    const body = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    return new Response(body, { headers: { 'content-type': 'application/geo+json' } });
}
