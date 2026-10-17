import { afterEach, describe, expect, it, vi } from 'vitest';
import atmosProxy from '../api/atmos/[file]';
import { assertManifest, assetShardTag, proxyReleaseAsset } from '../api/_releaseAssetProxy';
import {
    ATMOS_DATASETS,
    atmosFileBytes,
    canonicalAtmosGeneration,
    type AtmosDataset,
} from '../services/weather/api/atmosContract';
import { releaseAssetShardTag, marineAssetShardTag } from '../services/weather/api/marineManifestContract';

const RUN = '2026-10-17T00:00:00Z';
const HOUR = 3_600_000;
function manifest(dataset: AtmosDataset) {
    const spec = ATMOS_DATASETS[dataset];
    const generation = canonicalAtmosGeneration(RUN, dataset, Array(spec.steps).fill('a'.repeat(64)));
    return {
        schema_version: 2,
        dataset: { key: dataset, id: spec.id },
        generation,
        generated_at: '2026-10-17T04:00:00Z',
        published_at: '2026-10-17T04:05:00Z',
        data_start: RUN,
        data_end: new Date(Date.parse(RUN) + (spec.steps - 1) * 6 * HOUR).toISOString().replace('.000Z', 'Z'),
        cadence_hours: 6,
        dimensions: { width: 360, height: 181 },
        bounds: { west: -180, south: -90, east: 179, north: 90 },
        producer: { commit: 'b'.repeat(40), run_id: 1, run_attempt: 1 },
        metadata: {
            model: spec.model,
            source_resolution_degrees: '0.25',
            display_resolution_degrees: '1',
            fields: spec.fields.join(','),
            attribution: spec.attribution,
            licence: spec.licence,
        },
        files: Array.from({ length: spec.steps }, (_, step) => ({
            step,
            offset_hours: step * 6,
            data_time: new Date(Date.parse(RUN) + step * 6 * HOUR).toISOString().replace('.000Z', 'Z'),
            filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
            bytes: atmosFileBytes(dataset),
            sha256: 'a'.repeat(64),
            content_type: 'application/octet-stream',
        })),
    };
}
const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('additional atmospheric codecs use the existing guarded release transport', () => {
    it.each(['gfs-atmos', 'ifs-pressure'] as const)(
        'dispatches exact %s scalar admission without weakening THCU',
        async (dataset) => {
            const source = manifest(dataset);
            await expect(assertManifest(source, dataset)).resolves.toBe(source);
            await expect(assertManifest(source, 'sst')).rejects.toThrow();
            source.dimensions = { width: 1440, height: 680 };
            await expect(assertManifest(source, dataset)).rejects.toThrow(/dimensions/);
        },
    );

    it.each(['gfs-atmos', 'ifs-pressure'] as const)(
        'selects only a current %s discovery slot after both bounded reads',
        async (dataset) => {
            vi.useFakeTimers();
            vi.setSystemTime(Date.parse(RUN) + 5 * HOUR);
            const source = manifest(dataset);
            const future = { ...source, published_at: '2026-10-17T05:16:00Z' };
            const fetch = vi.fn(async (input: string) => json(input.includes('-a.json') ? source : future));
            vi.stubGlobal('fetch', fetch);
            const response = await proxyReleaseAsset(
                new Request('https://thalassa.test/api/atmos/manifest-v2.json'),
                dataset,
            );
            expect(response.status).toBe(200);
            expect(response.headers.get('x-thalassa-valid-manifest-slots')).toBe('1');
            expect(response.headers.get('x-thalassa-selected-manifest-slot')).toBe('manifest-v2-a.json');
            expect((await response.json()).generation).toBe(source.generation);
            expect(fetch).toHaveBeenCalledTimes(2);
            for (const [url] of fetch.mock.calls)
                expect(url).toContain(`/releases/download/${ATMOS_DATASETS[dataset].releaseTag}/`);
        },
    );

    it('refuses stale source discovery and unsupported selected models', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse(RUN) + 13 * HOUR);
        const fetch = vi.fn(async () => json(manifest('gfs-atmos')));
        vi.stubGlobal('fetch', fetch);
        const response = await atmosProxy(new Request('https://thalassa.test/api/atmos/manifest-v2.json?model=gfs'));
        expect(response.status).toBe(502);
        fetch.mockClear();
        for (const model of ['aifs', 'icon', 'ecmwf9km', '', 'gfs%26redirect=https://example.test']) {
            expect(
                (await atmosProxy(new Request(`https://thalassa.test/api/atmos/manifest-v2.json?model=${model}`)))
                    .status,
            ).toBe(400);
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(
            (await atmosProxy(new Request('https://thalassa.test/api/atmos/manifest-v2.json?model=gfs&model=ecmwf')))
                .status,
        ).toBe(400);
    });

    it('keeps both new datasets out of legacy manifests and unqualified assets even with the old bridge enabled', async () => {
        vi.stubEnv('THALASSA_CMEMS_V1_BRIDGE_ENABLED', 'true');
        vi.useFakeTimers();
        vi.setSystemTime('2026-07-01T00:00:00Z');
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        for (const dataset of ['gfs-atmos', 'ifs-pressure'] as const) {
            for (const name of ['manifest.json', 'h00.bin']) {
                expect(
                    (await proxyReleaseAsset(new Request(`https://thalassa.test/api/atmos/${name}`), dataset)).status,
                ).toBe(410);
            }
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('derives isolated fixed-prefix weekly shards while retaining every marine tag', () => {
        const generation = manifest('gfs-atmos').generation;
        expect(assetShardTag('gfs-atmos', generation)).toBe('gfs-atmos-latest-assets-2026-W42');
        expect(assetShardTag('ifs-pressure', generation)).toBe('ifs-pressure-latest-assets-2026-W42');
        for (const key of ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld', 'mpa'] as const) {
            expect(assetShardTag(key, generation)).toBe(marineAssetShardTag(key, generation));
        }
        expect(() => releaseAssetShardTag('https://lookalike.test/path', generation)).toThrow();
    });

    it('applies the small atmospheric cap, observed cancellation and original SSRF fence', async () => {
        const source = manifest('ifs-pressure');
        const name = source.files[0].filename;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        const fetch = vi.fn(
            async () =>
                new Response(body, {
                    status: 200,
                    headers: {
                        'content-type': 'application/octet-stream',
                        'content-length': String(atmosFileBytes('ifs-pressure') + 1),
                    },
                }),
        );
        vi.stubGlobal('fetch', fetch);
        const response = await proxyReleaseAsset(
            new Request(`https://thalassa.test/api/atmos/${name}`),
            'ifs-pressure',
        );
        expect(response.status).toBe(502);
        expect(cancelled).toBe(true);
        fetch.mockImplementation(
            async () =>
                new Response(null, {
                    status: 302,
                    headers: { location: 'https://github.com.lookalike.example/stolen' },
                }),
        );
        expect(
            (await proxyReleaseAsset(new Request(`https://thalassa.test/api/atmos/${name}`), 'ifs-pressure')).status,
        ).toBe(502);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
