import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'fast-png';
import { readFileSync } from 'node:fs';
import {
    inspectSatelliteProofPng,
    runSatelliteSourceProof,
    satelliteProofFetch,
    SATELLITE_SOURCE_PROOF_BOXES,
    SATELLITE_SOURCE_PROOF_LIMITS,
    OLDER_GIBS_SOURCE_PROOF_PRODUCTS,
} from '../scripts/prove-sharper-satellite-source.mjs';
import { SATELLITE_VIEW_PRODUCTS } from '../services/weather/satelliteViewContract';

const rgba = (alpha: number, height = 256) => {
    const data = new Uint8Array(256 * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = (index / 4) % 256;
        data[index + 1] = 80;
        data[index + 2] = 150;
        data[index + 3] = alpha;
    }
    return encode({ width: 256, height, data, channels: 4, depth: 8 });
};
const png = rgba(255);
const iso = (value: number) => new Date(value).toISOString().replace('.000Z', 'Z');
const options = (overrides = {}) => ({
    allowSourceReads: true,
    signal: new AbortController().signal,
    save: vi.fn(async () => undefined),
    read: vi.fn(async (url: string) => {
        if (new URL(url).searchParams.get('request')?.toLowerCase() === 'getmap')
            return { response: new Response(), bytes: png };
        const product = url.includes('mtg_fd')
            ? 'meteosat-ir'
            : url.includes('nowcoast')
              ? 'water-vapour'
              : url.includes('VIIRS')
                ? 'viirs-night'
                : 'himawari-ir';
        const now = Date.now(),
            daily = product === 'viirs-night',
            last = daily ? Math.floor(now / 86400000) * 86400000 : Math.floor(now / 3600000) * 3600000;
        const domain = daily
            ? `${iso(last - 86400000).slice(0, 10)}/${iso(last).slice(0, 10)}/P1D`
            : `${iso(last - 3600000)}/${iso(last)}/PT10M`;
        const xml = ['meteosat-ir', 'water-vapour'].includes(product)
            ? `<WMS_Capabilities><Layer><Name>${SATELLITE_VIEW_PRODUCTS[product].layer}</Name><Dimension name="time">${domain}</Dimension></Layer></WMS_Capabilities>`
            : `<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>${domain}</Domain><Size>1</Size></DimensionDomain></Domains>`;
        return { response: new Response(), bytes: new TextEncoder().encode(xml) };
    }),
    ...overrides,
});
afterEach(() => vi.useRealTimers());

describe('reviewed satellite source observation stays bounded and explicit', () => {
    it('refuses an unknown mode before any request or evidence write', async () => {
        const input = options({ mode: 'world' });
        await expect(runSatelliteSourceProof(input)).rejects.toThrow('Unknown source proof mode');
        expect(input.read).not.toHaveBeenCalled();
        expect(input.save).not.toHaveBeenCalled();
    });
    it('older mode reads only three fixed GIBS products and excludes the newest two under the unchanged parser', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime('2026-10-17T03:30:00Z');
        const input = options({ mode: 'older-gibs' });
        const result = await runSatelliteSourceProof(input);
        expect(result.completeSixProductObservation).toBeNull();
        expect(result.completeSelectedProductsWithUsableDetail).toBe(true);
        expect(result.products.map((product: { product: string }) => product.product)).toEqual(
            OLDER_GIBS_SOURCE_PROOF_PRODUCTS,
        );
        expect(input.read).toHaveBeenCalledTimes(15);
        for (const product of result.products) {
            expect(product.metadata).toHaveLength(3);
            expect(product.frames.map((frame: { listedTime: string }) => frame.listedTime)).toEqual([
                '2026-10-17T02:10:00Z',
                '2026-10-17T02:20:00Z',
            ]);
            expect(product.clientUsableFrames).toBe(2);
            expect(
                product.frames.every(
                    (frame: { png: { clientDetailStatus: string } }) => frame.png.clientDetailStatus === 'usable',
                ),
            ).toBe(true);
        }
        expect(input.read.mock.calls.every(([url]) => new URL(url).hostname === 'gibs.earthdata.nasa.gov')).toBe(true);
    });
    it('refuses the default path before reads or evidence writes', async () => {
        const input = options({ allowSourceReads: false });
        await expect(runSatelliteSourceProof(input)).rejects.toThrow('explicit reviewed admission');
        expect(input.read).not.toHaveBeenCalled();
        expect(input.save).not.toHaveBeenCalled();
    });
    it('does not invent older frames when only the newest two are advertised', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime('2026-10-17T03:30:00Z');
        const read = vi.fn(async () => ({
            response: new Response(),
            bytes: new TextEncoder().encode(
                '<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-10-17T03:00:00Z/2026-10-17T03:10:00Z/PT10M</Domain><Size>1</Size></DimensionDomain></Domains>',
            ),
        }));
        const result = await runSatelliteSourceProof(options({ mode: 'older-gibs', read }));
        expect(read).toHaveBeenCalledTimes(3);
        expect(result.completeSelectedProductsWithUsableDetail).toBe(false);
        expect(
            result.products.every(
                (product: { frames: unknown[]; error: string }) =>
                    product.frames.length === 0 && product.error.includes('No older advertised frame'),
            ),
        ).toBe(true);
    });
    it('holds a disappearing older cohort after the image read and never substitutes newer unselected pixels', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime('2026-10-17T03:30:00Z');
        const source = options(),
            counts = new Map<string, number>();
        const read = vi.fn(async (url: string) => {
            const target = new URL(url);
            if (target.searchParams.get('request')?.toLowerCase() === 'getmap') return source.read(url);
            const layer = target.searchParams.get('LAYER')!;
            const count = (counts.get(layer) ?? 0) + 1;
            counts.set(layer, count);
            const response = await source.read(url);
            if (count > 1)
                response.bytes = new TextEncoder().encode(
                    new TextDecoder()
                        .decode(response.bytes)
                        .replace(
                            /<Domain>[^<]*<\/Domain>/,
                            '<Domain>2026-10-17T02:50:00Z/2026-10-17T03:00:00Z/PT10M</Domain>',
                        ),
                );
            return response;
        });
        const result = await runSatelliteSourceProof(options({ mode: 'older-gibs', read }));
        expect(read).toHaveBeenCalledTimes(9);
        expect(result.completeSelectedProductsWithUsableDetail).toBe(false);
        for (const product of result.products) {
            expect(product.observedFrames).toBe(0);
            expect(product.clientUsableFrames).toBe(0);
            expect(product.frames[0].error).toContain('disappeared after image read');
            expect(product.frames[1].error).toContain('no longer in the current original metadata');
        }
    });
    it('keeps the exact six fixed providers and original source limits', () => {
        expect(Object.keys(SATELLITE_SOURCE_PROOF_BOXES)).toEqual(Object.keys(SATELLITE_VIEW_PRODUCTS));
        expect(SATELLITE_SOURCE_PROOF_LIMITS).toMatchObject({
            products: 6,
            framesPerProduct: 2,
            edge: 256,
            requests: 30,
            imageBytes: 2 * 1024 * 1024,
            consumedBytes: 32 * 1024 * 1024,
            directoryBytes: 32 * 1024 * 1024,
            seconds: 600,
        });
    });
    it('observes only two advertised images per product and checks membership afterward without claiming capture clocks', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime('2026-10-17T03:30:00Z');
        const input = options();
        const result = await runSatelliteSourceProof(input);
        expect(result.completeSixProductObservation).toBe(true);
        expect(input.read).toHaveBeenCalledTimes(30);
        expect(result.products).toHaveLength(6);
        for (const product of result.products) {
            expect(product.observedFrames).toBe(2);
            expect(product.metadata).toHaveLength(3);
            expect(product.frames).toHaveLength(2);
            expect(
                product.frames.every(
                    (frame: { independentAcquisitionClock: string }) => frame.independentAcquisitionClock === 'unknown',
                ),
            ).toBe(true);
            expect(product.twoAdvertisedImageHashesDiffer).toBe(false);
        }
        const meteosat = result.products.find((product: { product: string }) => product.product === 'meteosat-ir');
        expect(meteosat.frames.map((frame: { listedTime: string }) => frame.listedTime)).toEqual([
            '2026-10-17T02:00:00Z',
            '2026-10-17T03:00:00Z',
        ]);
        const maps = input.read.mock.calls.filter(([url]) => new URL(url).searchParams.get('request') === 'GetMap');
        expect(maps).toHaveLength(12);
        expect(maps.every(([url]) => new URL(url).searchParams.get('width') === '256')).toBe(true);
        expect(result.unknown).toContain(
            'Independent image acquisition clock, nearest-value response identity and scan timing',
        );
    });
    it('holds every absent source honestly and still records six explicit outcomes', async () => {
        const result = await runSatelliteSourceProof(
            options({
                read: async () => {
                    throw Error('Original provider unavailable');
                },
            }),
        );
        expect(result.completeSixProductObservation).toBe(false);
        expect(result.products).toHaveLength(6);
        expect(
            result.products.every(
                (product: { status: string; error: string }) =>
                    product.status === 'held' && product.error === 'Original provider unavailable',
            ),
        ).toBe(true);
    });
    it('does not enter a provider read after cancellation', async () => {
        const controller = new AbortController();
        controller.abort();
        const input = options({ signal: controller.signal });
        const result = await runSatelliteSourceProof(input);
        expect(result.completeSixProductObservation).toBe(false);
        expect(input.read).not.toHaveBeenCalled();
    });
    it('manual workflow is default false and cannot activate either live feature flag or publish', () => {
        for (const file of ['sharper-satellite-source-proof.yml', 'sharper-satellite-older-gibs-proof.yml']) {
            const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
            expect(workflow).toContain('default: false');
            expect(workflow).toContain('inputs.allow_source_reads == true');
            expect(workflow).toContain('contents: read');
            expect(workflow).toContain('persist-credentials: false');
            expect(workflow).not.toMatch(
                /SATELLITE_VIEW_ENABLED|VITE_SHARPER_SATELLITE_ENABLED|schedule:|contents: write|secrets\./,
            );
            for (const line of workflow.split('\n').filter((line) => line.includes('uses:')))
                expect(line).toMatch(/@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
        }
    });
});

describe('independent bounded PNG diagnostics', () => {
    it.each(['first-observation-transparent.png', 'first-observation-opaque-uniform.png'])(
        'keeps retained %s PNG observation separate from actual client usable detail',
        (file) => {
            const decoded = inspectSatelliteProofPng(readFileSync(`tests/fixtures/satellite141/${file}`));
            expect(decoded.clientDetailStatus).toBe('held');
            expect(decoded.clientDetailAlphaFraction).toBeNull();
            expect(decoded.clientDetailError).toContain('coverage unknown');
            expect(decoded.independentAcquisitionClock).toBe('unknown');
        },
    );
    it('decodes actual bounded CRC-checked pixels without physical-weather or clock inference', () => {
        expect(inspectSatelliteProofPng(png)).toMatchObject({
            width: 256,
            height: 256,
            crcCheckedCriticalChunks: true,
            decodedVisiblePixels: 65536,
            independentAcquisitionClock: 'unknown',
        });
        expect(inspectSatelliteProofPng(rgba(0)).decodedVisiblePixels).toBe(0);
    });
    it('refuses corrupt critical CRC, duplicate headers and inflated planes beyond the advertised dimensions', () => {
        const corrupt = new Uint8Array(png);
        corrupt[32] ^= 1;
        expect(() => inspectSatelliteProofPng(corrupt)).toThrow();
        const duplicate = Buffer.concat([png.subarray(0, 33), png.subarray(8, 33), png.subarray(33)]);
        expect(() => inspectSatelliteProofPng(duplicate)).toThrow('duplicate');
        const bomb = Buffer.from(rgba(255, 512));
        bomb.writeUInt32BE(256, 20);
        expect(() => inspectSatelliteProofPng(bomb)).toThrow();
    });
});

describe('actual streamed quota wrapper', () => {
    const init = { redirect: 'error', credentials: 'omit', cache: 'no-store' } as const;
    it('refuses unexpected URLs/options before network access', async () => {
        const native = vi.fn(),
            guard = satelliteProofFetch(native, new AbortController(), vi.fn());
        await expect(guard.fetch('https://lookalike.invalid', init)).rejects.toThrow('Unexpected');
        expect(native).not.toHaveBeenCalled();
    });
    it('counts a failing streamed body and aborts on aggregate quota before the next request', async () => {
        const controller = new AbortController(),
            native = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))),
            guard = satelliteProofFetch(native, controller, vi.fn(), { requests: 1, consumedBytes: 3 });
        guard.expect('https://fixed.invalid');
        const response = await guard.fetch('https://fixed.invalid', init);
        await expect(response.arrayBuffer()).rejects.toThrow('quota');
        expect(controller.signal.aborted).toBe(true);
        expect(guard.totals()).toEqual({ requests: 1, consumedBytes: 4 });
        guard.expect('https://fixed.invalid');
        await expect(guard.fetch('https://fixed.invalid', init)).rejects.toThrow('quota');
        expect(native).toHaveBeenCalledTimes(1);
    });
});
