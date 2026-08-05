import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DATASET_PROXY_SPECS,
    assetShardTag,
    assertManifest,
    computeGeneration,
    proxyReleaseAsset,
    selectNewestManifestSlot,
} from '../api/_releaseAssetProxy';

const DATA_START = '2026-08-05T00:00:00Z';

async function currentsManifest() {
    const hashes = Array.from({ length: 13 }, (_, index) => (index + 1).toString(16).padStart(64, '0'));
    const generation = await computeGeneration(DATA_START, 'currents', hashes);
    return {
        schema_version: 2,
        dataset: { key: 'currents', id: DATASET_PROXY_SPECS.currents.id },
        generation,
        generated_at: '2026-08-05T00:01:00Z',
        published_at: '2026-08-05T00:02:00Z',
        data_start: DATA_START,
        data_end: '2026-08-05T12:00:00Z',
        cadence_hours: 1,
        dimensions: { width: 1440, height: 680 },
        bounds: { north: 89.875, south: -79.875, west: -179.875, east: 179.875 },
        producer: { commit: 'a'.repeat(40), run_id: 123, run_attempt: 1 },
        files: hashes.map((sha256, step) => ({
            step,
            offset_hours: step,
            data_time: `2026-08-05T${String(step).padStart(2, '0')}:00:00Z`,
            filename: `${generation}-h${String(step).padStart(3, '0')}.bin`,
            bytes: 8_812_830,
            sha256,
            content_type: 'application/octet-stream',
        })),
        metadata: { attribution: 'Copernicus Marine Service' },
    };
}

async function mpaManifest() {
    const dataStart = '2024-06-30T00:00:00Z';
    const sha256 = 'b'.repeat(64);
    const generation = await computeGeneration(dataStart, 'mpa', [sha256]);
    return {
        schema_version: 2,
        dataset: { key: 'mpa', id: DATASET_PROXY_SPECS.mpa.id },
        generation,
        generated_at: '2026-08-05T00:01:00Z',
        published_at: '2026-08-05T00:02:00Z',
        data_start: dataStart,
        data_end: dataStart,
        cadence_hours: null,
        dimensions: { feature_count: 5_337 },
        bounds: { west: 70.717, east: 170.3667, south: -58.4488, north: -8.4738 },
        producer: { commit: 'c'.repeat(40), run_id: 456, run_attempt: 2 },
        files: [
            {
                step: 0,
                filename: `${generation}-mpa.geojson`,
                bytes: 7_000_000,
                sha256,
                content_type: 'application/geo+json',
            },
        ],
        metadata: { classification_notice: 'Indicative registry classification only.' },
    };
}

function upstream(body: BodyInit, contentType: string, extra: HeadersInit = {}): Response {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body).byteLength : undefined;
    return new Response(body, {
        status: 200,
        headers: {
            'content-type': contentType,
            ...(bytes === undefined ? {} : { 'content-length': String(bytes) }),
            ...extra,
        },
    });
}

function controlledRejectedUpstream({
    status = 200,
    contentType = 'application/octet-stream',
    contentLength,
    location,
}: {
    status?: number;
    contentType?: string | null;
    contentLength?: string;
    location?: string;
} = {}) {
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
        releaseCancellation = resolve;
    });
    const cancel = vi.fn((_reason: unknown) => cancellation);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('rejected upstream body'));
        },
        cancel(reason) {
            return cancel(reason);
        },
    });
    const headers = new Headers();
    if (contentType !== null) headers.set('content-type', contentType);
    if (contentLength !== undefined) headers.set('content-length', contentLength);
    if (location !== undefined) headers.set('location', location);
    return {
        response: new Response(body, { status, headers }),
        cancel,
        releaseCancellation,
    };
}

async function expectAwaitedCancellation(
    pending: Promise<Response>,
    controlled: ReturnType<typeof controlledRejectedUpstream>,
    reason: string,
    expectedStatus = 502,
): Promise<Response> {
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    await vi.waitFor(() => expect(controlled.cancel).toHaveBeenCalledWith(reason));
    expect(settled).toBe(false);
    controlled.releaseCancellation();
    const response = await pending;
    expect(response.status).toBe(expectedStatus);
    return response;
}

afterEach(() => {
    delete process.env.THALASSA_CMEMS_V1_BRIDGE_ENABLED;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('trusted release asset proxy', () => {
    it('matches the Python canonical generation fixture exactly', async () => {
        await expect(computeGeneration(DATA_START, 'currents', ['0'.repeat(64), 'f'.repeat(64)])).resolves.toBe(
            'g-20260805T000000Z-606e60c9f9ed',
        );
    });

    it('derives the same weekly shard, including the ISO year boundary', () => {
        expect(assetShardTag('currents', 'g-20260805T000000Z-0123456789ab')).toBe(
            'cmems-currents-latest-assets-2026-W32',
        );
        expect(assetShardTag('mpa', 'g-20251231T235959Z-0123456789ab')).toBe('mpa-aus-latest-assets-2026-W01');
        expect(() => assetShardTag('currents', 'g-20261340T250000Z-0123456789ab')).toThrow(
            'invalid generation timestamp',
        );
    });

    it('rejects stable legacy names and unsupported methods without fetching', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const legacy = await proxyReleaseAsset(new Request('https://thalassa.test/api/currents/h00.bin'), 'currents');
        expect(legacy.status).toBe(410);
        expect(legacy.headers.get('cache-control')).toBe('no-store');
        expect(legacy.headers.get('access-control-allow-origin')).toBe('*');
        const post = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest.json', { method: 'POST' }),
            'currents',
        );
        expect(post.status).toBe(405);
        expect(post.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects Range because only a complete body can carry end-to-end integrity', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const generation = 'g-20260805T000000Z-0123456789ab';
        const response = await proxyReleaseAsset(
            new Request(`https://thalassa.test/api/currents/${generation}-h000.bin`, {
                headers: { range: 'bytes=0-99' },
            }),
            'currents',
        );
        expect(response.status).toBe(400);
        expect(response.headers.get('accept-ranges')).toBe('none');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cancels and awaits a rejected upstream status body', async () => {
        const generation = 'g-20260805T000000Z-0123456789ab';
        const filename = `${generation}-h000.bin`;
        const controlled = controlledRejectedUpstream({ status: 503 });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(controlled.response);

        const pending = proxyReleaseAsset(new Request(`https://thalassa.test/api/currents/${filename}`), 'currents');
        const response = await expectAwaitedCancellation(pending, controlled, 'upstream status rejected');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('answers credential-free CORS preflight', async () => {
        const response = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/mpa/manifest.json', {
                method: 'OPTIONS',
                headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'GET' },
            }),
            'mpa',
        );
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    });

    it('validates manifest generation and serves it with revalidation headers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T06:00:00Z'));
        const manifest = await currentsManifest();
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => upstream(JSON.stringify(manifest), 'application/octet-stream'));
        const response = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest-v2.json?probe=cache-busted'),
            'currents',
        );
        expect(response.status).toBe(200);
        expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
            'https://github.com/shanestratton/thalassa-marine-weather/releases/download/cmems-currents-latest/manifest-v2-a.json',
            'https://github.com/shanestratton/thalassa-marine-weather/releases/download/cmems-currents-latest/manifest-v2-b.json',
        ]);
        expect(fetchSpy.mock.calls.every((call) => call[1]?.cache === 'no-store')).toBe(true);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-thalassa-generation')).toBe(manifest.generation);
        expect(response.headers.get('x-thalassa-selected-manifest-slot')).toBe('manifest-v2-b.json');
        expect(response.headers.get('x-thalassa-valid-manifest-slots')).toBe('2');
        expect(response.headers.get('content-digest')).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/u);
    });

    it('fails legacy paths closed by default, including bare MPA and CMEMS URLs', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        for (const [dataset, filename] of [
            ['currents', 'manifest.json'],
            ['currents', 'h00.bin'],
            ['mpa', 'manifest.json'],
            ['mpa', 'mpa.geojson'],
        ] as const) {
            const response = await proxyReleaseAsset(
                new Request(`https://thalassa.test/api/${dataset}/${filename}`),
                dataset,
            );
            expect(response.status).toBe(410);
            expect(response.headers.get('cache-control')).toBe('no-store');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('temporarily synthesizes a fresh coherent CMEMS v1 manifest only behind the exact emergency flag', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T06:00:00Z'));
        process.env.THALASSA_CMEMS_V1_BRIDGE_ENABLED = 'true';
        const manifest = await currentsManifest();
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => upstream(JSON.stringify(manifest), 'application/json'));

        const response = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest.json'),
            'currents',
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const legacy = (await response.json()) as {
            version: number;
            generated_at: string;
            hours: Array<{ hour: number; file: string; bytes: number }>;
        };
        expect(legacy).toEqual({
            version: 1,
            generated_at: manifest.data_start,
            hours: manifest.files.map((file) => ({
                hour: file.offset_hours,
                file: file.filename,
                bytes: file.bytes,
            })),
        });
        expect(new Set(legacy.hours.map((entry) => entry.file.slice(0, manifest.generation.length)))).toEqual(
            new Set([manifest.generation]),
        );
        expect(legacy.hours.every((entry) => entry.file.startsWith(`${manifest.generation}-h`))).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        const mpa = await proxyReleaseAsset(new Request('https://thalassa.test/api/mpa/manifest.json'), 'mpa');
        expect(mpa.status).toBe(410);
    });

    it('cannot revive the emergency CMEMS bridge after its absolute sunset', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-20T00:00:00Z'));
        process.env.THALASSA_CMEMS_V1_BRIDGE_ENABLED = 'true';
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const response = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest.json'),
            'currents',
        );
        expect(response.status).toBe(410);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('selects deterministically by data_start, published_at, generation and slot rather than input order', async () => {
        const candidate = (
            slot: 'manifest-v2-a.json' | 'manifest-v2-b.json',
            dataStart: string,
            publishedAt: string,
            generation: string,
        ) => ({
            slot,
            body: new Uint8Array(),
            manifest: { data_start: dataStart, published_at: publishedAt, generation },
            upstreamEtag: null,
        });
        const olderPublished = candidate('manifest-v2-b.json', '2026-08-05T00:00:00Z', '2026-08-05T02:00:00Z', 'g-z');
        const newerSource = candidate('manifest-v2-a.json', '2026-08-05T01:00:00Z', '2026-08-05T01:30:00Z', 'g-a');
        expect(selectNewestManifestSlot([olderPublished, newerSource])?.slot).toBe('manifest-v2-a.json');
        expect(selectNewestManifestSlot([newerSource, olderPublished])?.slot).toBe('manifest-v2-a.json');
    });

    it('falls back from a missing or invalid slot and fails closed when neither slot is valid', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T06:00:00Z'));
        const manifest = await currentsManifest();
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input) =>
                String(input).endsWith('manifest-v2-a.json')
                    ? new Response('missing', { status: 404 })
                    : upstream(JSON.stringify(manifest), 'application/json'),
            );
        const fallback = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest-v2.json'),
            'currents',
        );
        expect(fallback.status).toBe(200);
        expect(fallback.headers.get('x-thalassa-selected-manifest-slot')).toBe('manifest-v2-b.json');
        expect(fallback.headers.get('x-thalassa-valid-manifest-slots')).toBe('1');

        fetchSpy.mockImplementation(async (input) =>
            String(input).endsWith('manifest-v2-a.json')
                ? upstream(JSON.stringify(manifest), 'application/json')
                : upstream('{"partial":', 'application/json'),
        );
        const invalidNewest = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest-v2.json'),
            'currents',
        );
        expect(invalidNewest.status).toBe(200);
        expect(invalidNewest.headers.get('x-thalassa-selected-manifest-slot')).toBe('manifest-v2-a.json');
        expect(invalidNewest.headers.get('x-thalassa-valid-manifest-slots')).toBe('1');

        fetchSpy.mockResolvedValue(upstream('{"broken":true}', 'application/json'));
        const rejected = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest-v2.json'),
            'currents',
        );
        expect(rejected.status).toBe(502);
        expect(rejected.headers.get('cache-control')).toBe('no-store');
    });

    it('uses independent slot deadlines so one hung slot cannot poison the valid slot', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T06:00:00Z'));
        const manifest = await currentsManifest();
        const stalled = new ReadableStream<Uint8Array>({});
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
            String(input).endsWith('manifest-v2-a.json')
                ? new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } })
                : upstream(JSON.stringify(manifest), 'application/json'),
        );
        const pending = proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest-v2.json'),
            'currents',
        );
        await vi.advanceTimersByTimeAsync(8_001);
        const response = await pending;
        expect(response.status).toBe(200);
        expect(response.headers.get('x-thalassa-selected-manifest-slot')).toBe('manifest-v2-b.json');
        expect(response.headers.get('x-thalassa-valid-manifest-slots')).toBe('1');
    });

    it('does not count a schema-valid but stale slot as failover-ready', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T06:00:00Z'));
        const fresh = await currentsManifest();
        const stale = structuredClone(fresh);
        stale.data_start = '2026-08-04T00:00:00Z';
        stale.data_end = '2026-08-04T12:00:00Z';
        // Keep it schema-valid, including its generation binding.
        const hashes = stale.files.map((file) => file.sha256);
        stale.generation = await computeGeneration(stale.data_start, 'currents', hashes);
        stale.files.forEach((file, index) => {
            file.data_time = `2026-08-04T${String(index).padStart(2, '0')}:00:00Z`;
            file.filename = `${stale.generation}-h${String(index).padStart(3, '0')}.bin`;
        });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
            String(input).endsWith('manifest-v2-a.json')
                ? upstream(JSON.stringify(stale), 'application/json')
                : upstream(JSON.stringify(fresh), 'application/json'),
        );
        const response = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest-v2.json'),
            'currents',
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('x-thalassa-valid-manifest-slots')).toBe('1');
        expect(response.headers.get('x-thalassa-selected-manifest-slot')).toBe('manifest-v2-b.json');
    });

    it('rejects a manifest whose generation suffix is not bound to ordered file hashes', async () => {
        const manifest = await currentsManifest();
        manifest.files[0].sha256 = 'f'.repeat(64);
        await expect(assertManifest(manifest, 'currents')).rejects.toThrow('generation digest');
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream(JSON.stringify(manifest), 'application/json'));
        const response = await proxyReleaseAsset(
            new Request('https://thalassa.test/api/currents/manifest-v2.json'),
            'currents',
        );
        expect(response.status).toBe(502);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('rejects impossible calendar timestamps and non-instant MPA source windows', async () => {
        const badCalendar = await currentsManifest();
        badCalendar.generated_at = '2026-02-30T00:01:00Z';
        await expect(assertManifest(badCalendar, 'currents')).rejects.toThrow(/timestamp/i);

        const mpa = await mpaManifest();
        await expect(assertManifest(mpa, 'mpa')).resolves.toBe(mpa);
        mpa.data_end = '2024-07-01T00:00:00Z';
        await expect(assertManifest(mpa, 'mpa')).rejects.toThrow(/MPA source (?:time|window)/i);
    });

    it('rejects consumer-invalid metadata and undersized MPA declarations at the proxy boundary', async () => {
        const invalidMetadata = await mpaManifest();
        (invalidMetadata as { metadata: unknown }).metadata = 'not-an-object';
        await expect(assertManifest(invalidMetadata, 'mpa')).rejects.toThrow(/metadata must be an object/i);

        const undersized = await mpaManifest();
        undersized.files[0].bytes = 1;
        await expect(assertManifest(undersized, 'mpa')).rejects.toThrow(/byte count is invalid/i);
    });

    it('serves immutable assets with integrity, generation, ETag, CORS and 304 support', async () => {
        const generation = 'g-20260805T000000Z-0123456789ab';
        const filename = `${generation}-h000.bin`;
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => upstream(bytes, 'application/octet-stream', { etag: '"upstream"' }));
        const first = await proxyReleaseAsset(
            new Request(`https://thalassa.test/api/currents/${filename}`),
            'currents',
        );
        expect(first.status).toBe(200);
        expect(fetchSpy.mock.calls[0]?.[0]).toBe(
            `https://github.com/shanestratton/thalassa-marine-weather/releases/download/cmems-currents-latest-assets-2026-W32/${filename}`,
        );
        expect(first.headers.get('cache-control')).toContain('immutable');
        expect(first.headers.get('x-thalassa-generation')).toBe(generation);
        expect(first.headers.get('x-content-sha256')).toHaveLength(64);
        expect(first.headers.get('access-control-allow-origin')).toBe('*');
        expect(first.headers.get('access-control-expose-headers')).toContain('Content-Digest');
        expect(first.headers.get('content-length')).toBeNull();
        await expect(first.arrayBuffer()).resolves.toEqual(bytes.buffer);
        const etag = first.headers.get('etag') as string;
        const second = await proxyReleaseAsset(
            new Request(`https://thalassa.test/api/currents/${filename}`, { headers: { 'if-none-match': etag } }),
            'currents',
        );
        expect(second.status).toBe(304);
        expect(second.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    });

    it('follows only bounded redirects to the trusted GitHub asset host', async () => {
        const generation = 'g-20260805T000000Z-0123456789ab';
        const filename = `${generation}-h000.bin`;
        const trusted = `https://release-assets.githubusercontent.com/github-production-release-asset/1/signed?filename=${filename}`;
        const redirect = controlledRejectedUpstream({ status: 302, contentType: null, location: trusted });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(redirect.response)
            .mockResolvedValueOnce(upstream(new Uint8Array([7, 8, 9]), 'application/octet-stream'));
        const pending = proxyReleaseAsset(new Request(`https://thalassa.test/api/currents/${filename}`), 'currents');
        await vi.waitFor(() => expect(redirect.cancel).toHaveBeenCalledWith('following trusted release redirect'));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        redirect.releaseCancellation();
        const response = await pending;
        expect(response.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[1]?.[0]).toBe(trusted);

        vi.restoreAllMocks();
        const hostileRedirect = controlledRejectedUpstream({
            status: 302,
            contentType: null,
            location: 'https://evil.invalid/payload',
        });
        const hostileFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(hostileRedirect.response);
        const rejectedPending = proxyReleaseAsset(
            new Request(`https://thalassa.test/api/currents/${filename}`),
            'currents',
        );
        await vi.waitFor(() =>
            expect(hostileRedirect.cancel).toHaveBeenCalledWith('following trusted release redirect'),
        );
        hostileRedirect.releaseCancellation();
        const rejected = await rejectedPending;
        expect(rejected.status).toBe(502);
        expect(rejected.headers.get('access-control-allow-origin')).toBe('*');
        expect(hostileFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the timeout active while a response body is stalled', async () => {
        vi.useFakeTimers();
        const generation = 'g-20260805T000000Z-0123456789ab';
        const filename = `${generation}-h000.bin`;
        const stalled = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1]));
            },
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(stalled, {
                status: 200,
                headers: { 'content-type': 'application/octet-stream' },
            }),
        );
        const pending = proxyReleaseAsset(new Request(`https://thalassa.test/api/currents/${filename}`), 'currents');
        await vi.advanceTimersByTimeAsync(20_001);
        const response = await pending;
        expect(response.status).toBe(502);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('observes a rejected stream cancellation when a stalled body times out', async () => {
        vi.useFakeTimers();
        const generation = 'g-20260805T000000Z-0123456789ab';
        const filename = `${generation}-h000.bin`;
        const cancel = vi.fn(() => Promise.reject(new Error('fixture cancel rejected')));
        const stalled = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1]));
            },
            cancel,
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(stalled, {
                status: 200,
                headers: { 'content-type': 'application/octet-stream' },
            }),
        );

        const pending = proxyReleaseAsset(new Request(`https://thalassa.test/api/currents/${filename}`), 'currents');
        await vi.advanceTimersByTimeAsync(20_001);
        const response = await pending;
        expect(response.status).toBe(502);
        expect(cancel).toHaveBeenCalledWith('upstream request aborted');
        await Promise.resolve();
    });

    it('rejects an impossible generation timestamp before fetching', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const filename = 'g-20261340T250000Z-0123456789ab-h000.bin';
        const response = await proxyReleaseAsset(
            new Request(`https://thalassa.test/api/currents/${filename}`),
            'currents',
        );
        expect(response.status).toBe(400);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cancels and awaits oversized or invalid declarations and unexpected content types', async () => {
        const generation = 'g-20260805T000000Z-0123456789ab';
        const filename = `${generation}-mpa.geojson`;
        const oversizedUpstream = controlledRejectedUpstream({
            contentType: 'application/geo+json',
            contentLength: String(16 * 1024 * 1024 + 1),
        });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(oversizedUpstream.response);
        const oversizedPending = proxyReleaseAsset(new Request(`https://thalassa.test/api/mpa/${filename}`), 'mpa');
        const oversized = await expectAwaitedCancellation(
            oversizedPending,
            oversizedUpstream,
            'upstream content length rejected',
        );
        expect(oversized.status).toBe(502);
        expect(oversized.headers.get('access-control-allow-origin')).toBe('*');

        const invalidLengthUpstream = controlledRejectedUpstream({
            contentType: 'application/geo+json',
            contentLength: 'not-a-size',
        });
        fetchSpy.mockResolvedValueOnce(invalidLengthUpstream.response);
        const invalidLengthPending = proxyReleaseAsset(new Request(`https://thalassa.test/api/mpa/${filename}`), 'mpa');
        const invalidLength = await expectAwaitedCancellation(
            invalidLengthPending,
            invalidLengthUpstream,
            'upstream content length rejected',
        );
        expect(invalidLength.headers.get('access-control-allow-origin')).toBe('*');

        const wrongTypeUpstream = controlledRejectedUpstream({ contentType: 'text/html' });
        fetchSpy.mockResolvedValueOnce(wrongTypeUpstream.response);
        const wrongTypePending = proxyReleaseAsset(new Request(`https://thalassa.test/api/mpa/${filename}`), 'mpa');
        const wrongType = await expectAwaitedCancellation(
            wrongTypePending,
            wrongTypeUpstream,
            'upstream content type rejected',
        );
        expect(wrongType.status).toBe(502);
        expect(wrongType.headers.get('access-control-allow-origin')).toBe('*');
    });
});
