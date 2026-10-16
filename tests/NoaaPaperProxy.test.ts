import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler, noaaTileUrl } from '../api/noaa-chart';
const request = (query = 'style=paper&z=10&x=294&y=398') => new Request(`https://fixture.test/api/noaa-chart?${query}`);
const png = () => {
    const b = new Uint8Array(33);
    b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const v = new DataView(b.buffer);
    v.setUint32(16, 256);
    v.setUint32(20, 256);
    return b;
};
afterEach(() => vi.unstubAllGlobals());
describe('fixed public NOAA raster proxy', () => {
    it('uses the actual traditional chart service, with tile-derived Mercator bounds, and keeps ECDIS separate', () => {
        const url = new URL(noaaTileUrl(new URL(request().url))!);
        expect(url.hostname).toBe('gis.charttools.noaa.gov');
        expect(url.pathname).toContain('/MCS/NOAAChartDisplay/');
        expect(url.searchParams.get('size')).toBe('256,256');
        expect(url.searchParams.get('bbox')!.split(',').map(Number).every(Number.isFinite)).toBe(true);
        expect(noaaTileUrl(new URL(request('style=ecdis&z=10&x=294&y=398').url))).toContain('/MCS/ENCOnline/');
    });
    it.each([
        'style=paper&z=19&x=0&y=0',
        'style=paper&z=3&x=8&y=0',
        'style=paper&z=3&x=-1&y=0',
        'style=paper&z=03&x=1&y=1',
        'style=paper&z=3&x=1&y=1&url=https://evil.test',
        'style=paper&style=ecdis&z=3&x=1&y=1',
    ])('rejects noncanonical/unbounded requests before any upstream call: %s', async (query) => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        expect((await handler(request(query))).status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('validates bounded 256px PNG and serves browser/native CORS without following redirects', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(
            async () => new Response(png(), { headers: { 'content-type': 'image/png' } }),
        );
        vi.stubGlobal('fetch', fetch);
        const response = await handler(request());
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
        expect((await response.arrayBuffer()).byteLength).toBe(33);
    });
    it.each(['redirect', 'html', 'dimensions', 'oversize'])('rejects bad upstream %s', async (mode) => {
        const bytes = mode === 'oversize' ? new Uint8Array(1024 * 1024 + 1) : png();
        if (mode === 'dimensions') new DataView(bytes.buffer).setUint32(16, 100000);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                mode === 'redirect'
                    ? new Response(null, { status: 302, headers: { location: 'https://evil.test' } })
                    : new Response(bytes, { headers: { 'content-type': mode === 'html' ? 'text/html' : 'image/png' } }),
            ),
        );
        const response = await handler(request());
        expect(response.status).toBe(502);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
});
