// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encode } from 'fast-png';
import { runPublicSatelliteProof, PUBLIC_SATELLITE_PROOF_LIMITS } from '../scripts/prove-public-satellite141.mjs';
import { SATELLITE_VIEW_PRODUCTS, satelliteMetadataUrl } from '../services/weather/satelliteViewContract';
const now = Date.parse('2026-10-17T03:30:00Z');
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
function png(visible = true) {
    const data = new Uint8Array(256 * 256 * 4);
    if (visible)
        for (let i = 0; i < data.length; i += 4) {
            data[i] = (i / 4) % 256;
            data[i + 1] = 80;
            data[i + 3] = 255;
        }
    return encode({ width: 256, height: 256, channels: 4, depth: 8, data });
}
function fixture(blankNewest = false) {
    const reads: string[] = [],
        files = new Map<string, Uint8Array | string>();
    const read = vi.fn(async (url: string) => {
        reads.push(url);
        const parsed = new URL(url),
            product = parsed.searchParams.get('product') as keyof typeof SATELLITE_VIEW_PRODUCTS;
        expect(parsed.origin).toBe('https://pcisdplnodrphauixcau.supabase.co');
        expect(parsed.pathname).toBe('/functions/v1/satellite-view');
        const daily = SATELLITE_VIEW_PRODUCTS[product].daily;
        const hourly = SATELLITE_VIEW_PRODUCTS[product].hourlyOnly;
        const end = Math.floor(now / 3600000) * 3600000;
        const frames = (
            daily ? [now - 86400000, now] : hourly ? [end - 3600000, end] : [now - 3600000, now - 1800000]
        ).map((time) => ({
            iso: daily ? new Date(time).toISOString().slice(0, 10) : new Date(time).toISOString().replace('.000Z', 'Z'),
            timeMs: daily ? Math.floor(time / 86400000) * 86400000 : time,
            daily,
        }));
        if (parsed.searchParams.get('action') === 'times') {
            const value = { product, metadataUrl: satelliteMetadataUrl(product, now), readAtMs: now, frames };
            return { response: Response.json(value), bytes: new TextEncoder().encode(JSON.stringify(value)) };
        }
        const bytes = png(!(blankNewest && parsed.searchParams.get('time') === frames.at(-1)!.iso));
        return {
            response: new Response(new Uint8Array(bytes).buffer, {
                headers: {
                    'content-type': 'image/png',
                    'x-thalassa-listed-time': parsed.searchParams.get('time')!,
                    'x-thalassa-satellite-product': product,
                    'x-thalassa-satellite-window': parsed.searchParams.get('bbox') + ':256x256',
                },
            }),
            bytes,
        };
    });
    return {
        reads,
        files,
        read,
        save: async (name: string, value: Uint8Array | string) => {
            files.set(name, value);
        },
    };
}
it('default refusal happens before any public read or evidence write', async () => {
    const f = fixture();
    await expect(
        runPublicSatelliteProof({ allowPublicReads: false, ...f, signal: new AbortController().signal }),
    ).rejects.toThrow('reviewed');
    expect(f.reads).toEqual([]);
    expect(f.files.size).toBe(0);
});
it('bounds the complete public proposal to18 fixed reads and retains exact metadata/image provenance', async () => {
    const f = fixture(),
        result = await runPublicSatelliteProof({ allowPublicReads: true, ...f, signal: new AbortController().signal });
    expect(f.reads).toHaveLength(18);
    expect(result.products).toHaveLength(6);
    expect(result.completeAllProductsWithUsableDetail).toBe(true);
    expect(result.currentClockAltered).toBe(false);
    expect(PUBLIC_SATELLITE_PROOF_LIMITS.providerRequestsMaximumInsideReviewedEdge).toBe(42);
    expect(f.files.size).toBe(18);
});
it('keeps unusable newest frames held while describing older manual detail separately', async () => {
    const f = fixture(true),
        result = await runPublicSatelliteProof({ allowPublicReads: true, ...f, signal: new AbortController().signal });
    for (const p of result.products) {
        expect(p.observations[0]).toMatchObject({ defaultNewest: true, png: { clientDetailStatus: 'held' } });
        expect(p.observations[1]).toMatchObject({ defaultNewest: false, png: { clientDetailStatus: 'usable' } });
    }
    expect(result.completeAllProductsWithUsableDetail).toBe(true);
});
it('cancellation after an uncooperative image cannot persist that image', async () => {
    const f = fixture(),
        owner = new AbortController();
    const read = async (...args: Parameters<typeof f.read>) => {
        const value = await f.read(...args);
        if (new URL(args[0]).searchParams.get('action') === 'image') owner.abort(new Error('retired'));
        return value;
    };
    await expect(runPublicSatelliteProof({ allowPublicReads: true, ...f, read, signal: owner.signal })).rejects.toThrow(
        'retired',
    );
    expect([...f.files.keys()]).toEqual(['himawari-ir-public-times.json']);
});
