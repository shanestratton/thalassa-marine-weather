// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aromeStaticFixture } from '../../tests/fixtures/aromeStatic142';
import {
    AROME_TEST_RUN as run,
    AROME_TEST_MODEL as model,
    AROME_TEST_POINT as point,
} from '../../tests/fixtures/arome142';
import { AROME_STATIC_ORIGIN, aromeSha256 } from './aromeStaticContract';
import { fetchAromeFromStatic, AROME_UPSTREAM_MS } from '../../supabase/functions/_shared/arome-upstream';

const env = (name: string) => (name === 'THALASSA_AROME_STATIC_ENABLED' ? 'true' : undefined);
const now = () => run + 3600_000;
afterEach(() => {
    vi.useRealTimers();
});
type Fixture = Awaited<ReturnType<typeof aromeStaticFixture>>;
const response = (raw: Uint8Array) => new Response(Uint8Array.from(raw));
function transport(f: Fixture) {
    return vi.fn<typeof fetch>(async (input) => {
        const bytes = f.objects.get(String(input));
        return bytes ? response(bytes) : new Response(null, { status: 404 });
    });
}
async function rebind(f: Fixture) {
    const raw = new TextEncoder().encode(JSON.stringify(f.manifest));
    f.slot.manifestBytes = raw.length;
    f.slot.manifestSha256 = await aromeSha256(raw);
    f.objects.set(`${AROME_STATIC_ORIGIN}/${model}/current-0.json`, new TextEncoder().encode(JSON.stringify(f.slot)));
    f.objects.set(`${AROME_STATIC_ORIGIN}/${model}/cohorts/${f.slot.manifestSha256}/manifest.json`, raw);
}

describe('14206 bounded immutable AROME Edge reader', () => {
    it('uses exactly four fixed public GETs with no wx ingress, point body, token or paid fallback', async () => {
        const f = await aromeStaticFixture();
        const fetcher = transport(f);
        const result = await fetchAromeFromStatic(model, point, env, fetcher, now);
        expect(result.model).toBe(model);
        expect(result.hourly.wind_speed_10m[0]).toBe(10);
        expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
            `${AROME_STATIC_ORIGIN}/${model}/current-0.json`,
            `${AROME_STATIC_ORIGIN}/${model}/current-1.json`,
            `${AROME_STATIC_ORIGIN}/${model}/cohorts/${f.slot.manifestSha256}/manifest.json`,
            `${AROME_STATIC_ORIGIN}/${model}/tiles/${f.tile.sha256}.bin.gz`,
        ]);
        for (const [, init] of fetcher.mock.calls) {
            expect(init).toMatchObject({
                method: 'GET',
                credentials: 'omit',
                redirect: 'error',
                headers: { Accept: 'application/octet-stream' },
            });
            expect(init?.body).toBeUndefined();
            expect(new Headers(init?.headers).has('authorization')).toBe(false);
        }
    });

    it.each([undefined, '', 'TRUE', 'https://wx-data.thalassawx.app'])(
        'holds unadmitted configuration %s before any request',
        async (enabled) => {
            const fetcher = vi.fn<typeof fetch>();
            await expect(fetchAromeFromStatic(model, point, () => enabled, fetcher, now)).rejects.toThrow(
                'unavailable',
            );
            expect(fetcher).not.toHaveBeenCalled();
        },
    );

    it('refuses unknown models/out-of-grid/nonfinite coordinates before reads', async () => {
        const fetcher = vi.fn<typeof fetch>();
        for (const [id, p] of [
            ['meteofrance_arome', point],
            [model, { lat: NaN, lon: 166 }],
            [model, { lat: -31, lon: 166 }],
            [model, { lat: -28, lon: 166 }],
            [model, { lat: -20, lon: 157 }],
            [model, { lat: -12, lon: 166 }],
            [model, { lat: -20, lon: 173 }],
        ] as const) {
            await expect(fetchAromeFromStatic(id, p, env, fetcher, now)).rejects.toThrow();
        }
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('selects the genuine newest original-run slot while preserving the older slot as fallback discovery', async () => {
        const f = await aromeStaticFixture();
        f.objects.set(
            `${AROME_STATIC_ORIGIN}/${model}/current-1.json`,
            new TextEncoder().encode(
                JSON.stringify({
                    ...f.slot,
                    runUtc: '2026-10-16T18:00:00Z',
                    manifestSha256: '7'.repeat(64),
                }),
            ),
        );
        const fetcher = transport(f);
        expect((await fetchAromeFromStatic(model, point, env, fetcher, now)).runUtc).toBe(f.slot.runUtc);
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(fetcher.mock.calls.some(([url]) => String(url).includes('7'.repeat(64)))).toBe(false);
    });

    it('refuses conflicting manifests for the same original run', async () => {
        const f = await aromeStaticFixture();
        f.objects.set(
            `${AROME_STATIC_ORIGIN}/${model}/current-1.json`,
            new TextEncoder().encode(JSON.stringify({ ...f.slot, manifestSha256: '7'.repeat(64) })),
        );
        const fetcher = transport(f);
        await expect(fetchAromeFromStatic(model, point, env, fetcher, now)).rejects.toThrow('unavailable');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('never retries or borrows the older cohort after selected manifest/tile failure', async () => {
        const f = await aromeStaticFixture();
        const fetcher = transport(f);
        f.objects.delete(`${AROME_STATIC_ORIGIN}/${model}/cohorts/${f.slot.manifestSha256}/manifest.json`);
        await expect(fetchAromeFromStatic(model, point, env, fetcher, now)).rejects.toThrow('unavailable');
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it.each(['manifest', 'packed', 'raw'])('refuses %s checksum corruption', async (kind) => {
        const f = await aromeStaticFixture();
        if (kind === 'manifest')
            f.objects.set(
                `${AROME_STATIC_ORIGIN}/${model}/cohorts/${f.slot.manifestSha256}/manifest.json`,
                new TextEncoder().encode('{}'),
            );
        if (kind === 'packed')
            f.objects.set(
                `${AROME_STATIC_ORIGIN}/${model}/tiles/${f.tile.sha256}.bin.gz`,
                new Uint8Array(f.packed.length),
            );
        if (kind === 'raw') {
            f.tile.rawSha256 = '9'.repeat(64);
            await rebind(f);
        }
        const fetcher = transport(f);
        await expect(fetchAromeFromStatic(model, point, env, fetcher, now)).rejects.toThrow('checksum');
        expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('bounds compressed and decompressed bytes independently; bombs cannot allocate an unbounded decoded table', async () => {
        const f = await aromeStaticFixture();
        const bomb = Uint8Array.from(gzipSync(new Uint8Array(6 * 1024 * 1024)));
        f.tile.sha256 = await aromeSha256(bomb);
        f.tile.bytes = bomb.length;
        f.objects.set(`${AROME_STATIC_ORIGIN}/${model}/tiles/${f.tile.sha256}.bin.gz`, bomb);
        await rebind(f);
        const fetcher = transport(f);
        await expect(fetchAromeFromStatic(model, point, env, fetcher, now)).rejects.toThrow('byte limit');
        expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it.each(['content-length', 'actual-bytes', 'content-encoding'])(
        'refuses invalid %s without fallback',
        async (kind) => {
            const fetcher = vi.fn<typeof fetch>(async () =>
                kind === 'actual-bytes'
                    ? new Response('x'.repeat(4097))
                    : new Response('{}', {
                          headers:
                              kind === 'content-length' ? { 'content-length': '4097' } : { 'content-encoding': 'gzip' },
                      }),
            );
            await expect(fetchAromeFromStatic(model, point, env, fetcher, now)).rejects.toThrow();
            expect(fetcher).toHaveBeenCalledTimes(2);
        },
    );

    it.each(['headers', 'body'])('bounds %s even when transport ignores AbortSignal', async (kind) => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>(() =>
            kind === 'headers'
                ? new Promise(() => undefined)
                : Promise.resolve(
                      new Response(
                          new ReadableStream({
                              start() {
                                  /* deliberately stalled */
                              },
                          }),
                      ),
                  ),
        );
        const pending = fetchAromeFromStatic(model, point, env, fetcher, now);
        const assertion = expect(pending).rejects.toThrow('deadline');
        await vi.advanceTimersByTimeAsync(AROME_UPSTREAM_MS);
        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('rechecks original freshness after all reads instead of restamping receipt time', async () => {
        const f = await aromeStaticFixture();
        const original = transport(f);
        let clock = now();
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
            const result = await original(input, init);
            if (String(input).endsWith('.bin.gz')) clock = run + 18 * 3600_000 + 1;
            return result;
        });
        await expect(fetchAromeFromStatic(model, point, env, fetcher, () => clock)).rejects.toThrow('unqualified');
        expect(fetcher).toHaveBeenCalledTimes(4);
    });
});
