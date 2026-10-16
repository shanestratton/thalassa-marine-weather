import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartsForPoint, jmaChartUrl, synopticChart, chartCredit } from '../services/weather/synopticCharts';
import { readChartBytes, SYNOPTIC_MAX_ASSET_BYTES } from '../services/weather/synopticChartBytes';
import handler from '../api/synoptic-chart';
const state = vi.hoisted(() => ({ disk: null as unknown, satellite: false, pi: null as unknown }));
vi.mock('../services/PiOfflineWeatherService', () => ({ readPiAnalysis: vi.fn(async () => state.pi) }));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async () => state.disk),
    saveLargeDataImmediate: vi.fn(async (_key, value) => {
        state.disk = structuredClone(value);
    }),
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => state.satellite }));
vi.mock('../services/native/apiBase', () => ({ API_BASE: '/api' }));
import {
    boundedSavedCharts,
    downloadSynopticChart,
    resetSynopticCacheForTests,
    savedSynopticChart,
    SYNOPTIC_CACHE_BYTES,
} from '../services/weather/synopticChartCache';
import { saveLargeDataImmediate } from '../services/nativeStorage';
const gif = new TextEncoder().encode('GIF89a1234567890');
const response = (bytes = gif, mime = 'image/gif') =>
    new Response(bytes.buffer as ArrayBuffer, { headers: { 'content-type': mime } });
beforeEach(() => {
    state.disk = null;
    state.satellite = false;
    state.pi = null;
    resetSynopticCacheForTests();
    vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('reviewed official chart registry', () => {
    it('selects each reviewed ocean source and explicitly leaves southern Australia/New Zealand to model isobars', () => {
        expect(chartsForPoint(50, -30)[0].issuer).toBe('NOAA OPC');
        expect(chartsForPoint(40, -150)[0].issuer).toBe('NOAA OPC');
        expect(chartsForPoint(15, -60)[0].issuer).toBe('NOAA TAFB');
        expect(chartsForPoint(-15, 170)[0].issuer).toBe('NOAA HFO');
        expect(chartsForPoint(35, 140)[0].issuer).toBe('JMA');
        expect(chartsForPoint(-35, 151)).toEqual([]);
        expect(chartsForPoint(-41, 174)).toEqual([]);
        expect(chartsForPoint(NaN, 0)).toEqual([]);
        expect(chartCredit(synopticChart('jma-analysis')!)).toContain('Public Data License');
    });
    it('the app and web CSP permit the two CORS-enabled official hosts', () => {
        for (const file of ['index.html', 'vercel.json']) {
            const source = readFileSync(file, 'utf8');
            expect(source).toContain('https://www.weather.gov');
            expect(source).toContain('https://www.jma.go.jp');
        }
    });
    it('allows only exact JMA product filenames from the fixed Asia slots', () => {
        const file = '20261016000000_0_Z__C_010000_20261016000000_MET_CHT_JCIasas_JCP600x512_JRcolor_Tjmahp_image.png';
        expect(jmaChartUrl({ asia: { now: [file] } }, 'now')).toBe(
            `https://www.jma.go.jp/bosai/weather_map/data/png/${file}`,
        );
        for (const invalid of [
            'https://evil.test/chart.png',
            '../chart.png',
            'chart.svg',
            file.replace('asas', 'fsas24'),
        ])
            expect(jmaChartUrl({ asia: { now: [invalid] } }, 'now')).toBeNull();
    });
});

describe('bounded official chart bytes and proxy', () => {
    it('checks MIME and magic bytes, rejects HTML/SVG and enforces the streamed byte cap', async () => {
        expect(Array.from(await readChartBytes(response(), 'image/gif'))).toEqual(Array.from(gif));
        await expect(readChartBytes(response(gif, 'text/html'), 'image/gif')).rejects.toThrow();
        await expect(
            readChartBytes(response(new TextEncoder().encode('<svg>bad</svg>')), 'image/gif'),
        ).rejects.toThrow();
        await expect(
            readChartBytes(response(new Uint8Array(SYNOPTIC_MAX_ASSET_BYTES + 1)), 'image/gif'),
        ).rejects.toThrow();
    });
    it('proxies only fixed reviewed sources, with CORS and no redirects or credentials', async () => {
        const fetcher = vi.fn().mockResolvedValue(response());
        vi.stubGlobal('fetch', fetcher);
        const result = await handler(new Request('https://example.test/api/synoptic-chart?id=opc-atl-analysis'));
        expect(result.status).toBe(200);
        expect(result.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetcher).toHaveBeenCalledWith(
            synopticChart('opc-atl-analysis')!.url,
            expect.objectContaining({
                redirect: 'manual',
                credentials: 'omit',
                headers: { Accept: 'image/gif', 'User-Agent': 'Thalassa/1.2 (+https://www.thalassawx.app)' },
            }),
        );
        for (const query of [
            'id=https://evil.test/a',
            'id=opc-atl-analysis&url=https://evil.test',
            'id=opc-atl-analysis&id=opc-pac-analysis',
            'id=jma-analysis',
        ])
            expect((await handler(new Request(`https://example.test/api/synoptic-chart?${query}`))).status).toBe(400);
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it('reports only the fixed public source status when the host rejects the request', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private diagnostic', { status: 403 })));
        const result = await handler(new Request('https://example.test/api/synoptic-chart?id=opc-atl-analysis'));
        expect(result.status).toBe(502);
        expect(result.headers.get('x-thalassa-upstream-status')).toBe('403');
        expect(result.headers.get('cache-control')).toBe('no-store');
        expect(await result.text()).toBe('Official chart unavailable');
    });
    it('refuses redirects and partial images without following their target', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        for (const status of [301, 302, 307, 308, 206]) {
            fetcher.mockResolvedValueOnce(
                new Response(gif, {
                    status,
                    headers: { 'content-type': 'image/gif', location: 'https://evil.test/chart.gif' },
                }),
            );
            const result = await handler(new Request('https://example.test/api/synoptic-chart?id=opc-atl-analysis'));
            expect(result.status).toBe(502);
            expect(result.headers.get('x-thalassa-upstream-status')).toBe(String(status));
        }
        expect(fetcher).toHaveBeenCalledTimes(5);
        expect(
            fetcher.mock.calls.every(
                ([url, init]) => url === synopticChart('opc-atl-analysis')!.url && init.redirect === 'manual',
            ),
        ).toBe(true);
    });
    it('suppresses network exceptions while distinguishing that no HTTP response arrived', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private diagnostic')));
        const result = await handler(new Request('https://example.test/api/synoptic-chart?id=opc-atl-analysis'));
        expect(result.status).toBe(502);
        expect(result.headers.get('x-thalassa-upstream-status')).toBe('0');
        expect(await result.text()).toBe('Official chart unavailable');
    });
});

describe('official charts offline and on satellite', () => {
    it('blocks automatic downloads on satellite but permits an explicit, bounded download and verifies offline saving', async () => {
        state.satellite = true;
        const fetcher = vi.fn().mockResolvedValue(response());
        vi.stubGlobal('fetch', fetcher);
        const chart = synopticChart('opc-atl-analysis')!;
        await expect(downloadSynopticChart(chart)).rejects.toThrow('Satellite Mode');
        expect(fetcher).not.toHaveBeenCalled();
        const result = await downloadSynopticChart(chart, { explicit: true });
        expect(result.offlineSaved).toBe(true);
        expect(await savedSynopticChart(chart.id)).toEqual(result.chart);
        expect(fetcher).toHaveBeenCalledWith(
            '/api/synoptic-chart?id=opc-atl-analysis',
            expect.objectContaining({ credentials: 'omit' }),
        );
    });
    it('reads the paired boat cache before WAN even in Satellite Mode', async () => {
        state.satellite = true;
        state.pi = {
            id: 'opc-atl-analysis',
            dataUrl: `data:image/gif;base64,${btoa('GIF89a1234567890')}`,
            fetchedAt: Date.now(),
        };
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const result = await downloadSynopticChart(synopticChart('opc-atl-analysis')!);
        expect(result.offlineSaved).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
        expect((await savedSynopticChart('opc-atl-analysis'))?.dataUrl).toBe(result.chart.dataUrl);
    });
    it('never claims offline success when persistence fails', async () => {
        vi.mocked(saveLargeDataImmediate).mockRejectedValueOnce(new Error('disk full'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
        expect((await downloadSynopticChart(synopticChart('opc-atl-analysis')!, { explicit: true })).offlineSaved).toBe(
            false,
        );
    });
    it('bounds the whole serialized cache to 3 MiB, evicts old charts and rejects corrupt content', () => {
        const bytes = new Uint8Array(1024 * 1024);
        bytes.set(gif);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        const dataUrl = `data:image/gif;base64,${btoa(binary)}`;
        const entries = ['opc-atl-analysis', 'opc-pac-analysis', 'opc-atl-24', 'opc-pac-24'].map((id, i) => ({
            id,
            dataUrl,
            bytes: bytes.length,
            downloadedAt: Date.now() - i * 1000,
        }));
        const bounded = boundedSavedCharts(entries);
        expect(bounded.map((entry) => entry.id)).toEqual(['opc-atl-analysis', 'opc-pac-analysis']);
        expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(SYNOPTIC_CACHE_BYTES);
        expect(boundedSavedCharts([{ ...entries[0], dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }])).toEqual([]);
    });
});
