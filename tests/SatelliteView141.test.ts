import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../api/satellite-view';
import {
    parseSatelliteTimes,
    satelliteImageTarget,
    satelliteMetadataUrl,
    satelliteViewProduct,
    validateSatelliteViewTimes,
    type SatelliteViewBox,
} from '../services/weather/satelliteViewContract';
import { validateSatellitePng } from '../services/weather/satelliteViewBytes';
const root = 'tests/fixtures/satellite141/';
const himawari = readFileSync(root + 'himawari-domains.xml', 'utf8'),
    goes = readFileSync(root + 'goes-east-domains.xml', 'utf8'),
    eumet = readFileSync(root + 'eumet-capabilities.xml', 'utf8'),
    noaa = readFileSync(root + 'noaa-capabilities.xml', 'utf8');
const now = Date.parse('2026-10-17T03:30:00Z');
const png = Uint8Array.from(
    Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
    ),
);
function imageQuery(extra = '') {
    return new Request(
        `https://app.test/api/satellite-view?action=image&product=himawari-ir&time=2026-10-17T03:00:00Z&bbox=-1,-1,1,1&width=1&height=1${extra}`,
    );
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv('SATELLITE_VIEW_ENABLED', 'true');
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
describe('original advertised satellite clocks and bounded products', () => {
    it('retains real GIBS ten-minute gaps instead of filling them', () => {
        const times = parseSatelliteTimes(himawari, 'himawari-ir', now);
        expect(times.frames.map((frame) => frame.iso)).toEqual([
            '2026-10-17T02:00:00Z',
            '2026-10-17T02:10:00Z',
            '2026-10-17T02:20:00Z',
            '2026-10-17T02:30:00Z',
            '2026-10-17T02:50:00Z',
            '2026-10-17T03:00:00Z',
        ]);
        const east = parseSatelliteTimes(goes, 'goes-east-ir', Date.parse('2026-10-16T20:00:00Z'));
        expect(east.frames.some((frame) => /T19:[345]0/.test(frame.iso))).toBe(false);
        expect(east.frames.at(-1)?.iso).toBe('2026-10-16T20:00:00Z');
    });
    it('admits only original Meteosat nominal clock-hour Core frames', () => {
        const times = parseSatelliteTimes(eumet, 'meteosat-ir', now);
        expect(times.frames).toHaveLength(5);
        expect(times.frames.every((frame) => frame.timeMs % 3600000 === 0)).toBe(true);
        expect(times.frames.at(-1)?.iso).toBe('2026-10-17T02:00:00Z');
        expect(() =>
            satelliteImageTarget(
                'meteosat-ir',
                { iso: '2026-10-17T02:50:00Z', timeMs: Date.parse('2026-10-17T02:50:00Z'), daily: false },
                [-1, -1, 1, 1],
                1,
                1,
            ),
        ).toThrow(/frame/);
    });
    it('scopes NOAA water vapour to its actual layer instead of neighbouring five-minute GOES times', () => {
        const times = parseSatelliteTimes(noaa, 'water-vapour', now);
        expect(times.frames).toHaveLength(5);
        expect(times.frames.at(-1)?.iso).toBe('2026-10-17T02:00:00Z');
    });
    it('keeps VIIRS daily dates as daily partial composites, without an invented instant', () => {
        const xml =
            '<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-10-15/2026-10-17/P1D</Domain><Size>1</Size></DimensionDomain></Domains>';
        const times = parseSatelliteTimes(xml, 'viirs-night', now);
        expect(times.frames.map((frame) => frame.iso)).toEqual(['2026-10-16', '2026-10-17']);
        expect(times.frames.every((frame) => frame.daily)).toBe(true);
    });
    it('builds only the fixed reviewed endpoints and raw exact-time metadata query', () => {
        const url = satelliteMetadataUrl('himawari-ir', now + 123);
        expect(url).toContain('TIME=2026-10-16T21:30:00Z/2026-10-17T03:30:00Z');
        expect(url).not.toContain('%3A');
        expect(url).not.toContain('.123Z');
        expect(satelliteMetadataUrl('viirs-night', now)).toContain('TILEMATRIXSET=250m');
        expect(satelliteViewProduct('__proto__')).toBe(null);
        expect(satelliteViewProduct('https://evil.test')).toBe(null);
        const target = new URL(
            satelliteImageTarget(
                'goes-east-ir',
                { iso: '2026-10-17T03:00:00Z', timeMs: now - 1800000, daily: false },
                [-1, -1, 1, 1],
                1024,
                512,
            ),
        );
        expect(target.origin).toBe('https://gibs.earthdata.nasa.gov');
        expect(target.searchParams.get('crs')).toBe('EPSG:3857');
        expect(target.searchParams.get('time')).toBe('2026-10-17T03:00:00Z');
    });
    it.each([
        '<!DOCTYPE x><Domains/>',
        '<ExceptionReport/>',
        '<html>error</html>',
        himawari.replace('<Size>4</Size>', '<Size>3</Size>'),
        himawari.replace('PT10M', 'PT0M'),
    ])('holds malformed/ambiguous metadata without source guesses %#', (xml) => {
        expect(() => parseSatelliteTimes(xml, 'himawari-ir', now)).toThrow();
    });
    it('refuses stale metadata, neighbouring layers, unknown clocks and a replayed client read', () => {
        expect(() => parseSatelliteTimes(himawari, 'himawari-ir', now + 86400000)).toThrow(/stale/);
        expect(() => parseSatelliteTimes(eumet.replace('mtg_fd:ir105_hrfi', 'neighbour'), 'meteosat-ir', now)).toThrow(
            /layer/,
        );
        expect(() => parseSatelliteTimes(himawari, 'himawari-ir', NaN)).toThrow();
        const times = parseSatelliteTimes(himawari, 'himawari-ir', now);
        expect(validateSatelliteViewTimes(times, 'himawari-ir', now)).toBe(times);
        expect(() => validateSatelliteViewTimes(times, 'himawari-ir', now + 120001)).toThrow(/retired/);
        expect(() => validateSatelliteViewTimes(times, 'goes-east-ir', now)).toThrow();
        expect(() => validateSatelliteViewTimes(times, 'himawari-ir', NaN)).toThrow();
    });
    it.each(
        [
            [-1, -90, 1, 1],
            [-181, -1, 1, 1],
            [-1, -1, 181, 1],
            [1, -1, -1, 1],
            [-1, 2, 1, 1],
            [NaN, -1, 1, 1],
        ].map((box) => ({ box })),
    )('refuses invalid or wrapped single-request windows $box', ({ box }) => {
        expect(() =>
            satelliteImageTarget(
                'himawari-ir',
                { iso: '2026-10-17T03:00:00Z', timeMs: now - 1800000, daily: false },
                box as unknown as SatelliteViewBox,
                1,
                1,
            ),
        ).toThrow(/window/);
    });
    it('bounds PNG signature and decoded dimensions before passing bytes to the browser', () => {
        expect(() => validateSatellitePng(png, 1, 1)).not.toThrow();
        expect(() => validateSatellitePng(png, 1024, 1024)).toThrow(/dimensions/);
        expect(() => validateSatellitePng(new TextEncoder().encode('<svg/>'), 1, 1)).toThrow(/signature/);
    });
});
describe('separately admitted fixed satellite proxy', () => {
    it('remains default-OFF without any upstream request', async () => {
        vi.stubEnv('SATELLITE_VIEW_ENABLED', '');
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        expect((await handler(imageQuery())).status).toBe(503);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(['&url=https://evil.test', '&product=goes-east-ir', '&width=1024'])(
        'rejects extra/duplicate parameters before I/O %s',
        async (extra) => {
            const fetcher = vi.fn();
            vi.stubGlobal('fetch', fetcher);
            expect((await handler(imageQuery(extra))).status).toBe(400);
            expect(fetcher).not.toHaveBeenCalled();
        },
    );
    it('checks image windows before any upstream metadata request', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const bad = new Request(imageQuery().url.replace('width=1', 'width=1025'));
        expect((await handler(bad)).status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('makes bounded credential-free no-redirect reads and rechecks original membership after image read', async () => {
        const fetcher = vi.fn((url: string, _options?: RequestInit) =>
            Promise.resolve(
                new Response(url.includes('GetMap') ? new Uint8Array(png).buffer : himawari, {
                    headers: { 'content-type': url.includes('GetMap') ? 'image/png' : 'text/xml' },
                }),
            ),
        );
        vi.stubGlobal('fetch', fetcher);
        const result = await handler(imageQuery());
        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(result.headers.get('x-thalassa-listed-time')).toBe('2026-10-17T03:00:00Z');
        expect(result.headers.get('cache-control')).toBe('no-store');
        for (const call of fetcher.mock.calls)
            expect(call[1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    });
    it('never fetches an image for an actual GIBS timeline gap', async () => {
        const fetcher = vi.fn(() =>
            Promise.resolve(new Response(himawari, { headers: { 'content-type': 'text/xml' } })),
        );
        vi.stubGlobal('fetch', fetcher);
        expect((await handler(new Request(imageQuery().url.replace('T03:00:00Z', 'T02:40:00Z')))).status).toBe(400);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('refuses an image whose listed time disappears during the actual read', async () => {
        let reads = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) =>
                Promise.resolve(
                    new Response(
                        url.includes('GetMap')
                            ? new Uint8Array(png).buffer
                            : ++reads === 1
                              ? himawari
                              : himawari.replace('2026-10-17T03:00:00Z', '2026-10-17T02:50:00Z'),
                        { headers: { 'content-type': url.includes('GetMap') ? 'image/png' : 'text/xml' } },
                    ),
                ),
            ),
        );
        expect((await handler(imageQuery())).status).toBe(502);
    });
    it('rejects redirects and misleading provider errors rather than serving them as imagery', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.test' } })),
            ),
        );
        expect((await handler(imageQuery())).status).toBe(502);
    });
    it('enforces the original deadline even if fetch ignores cancellation forever', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>(() => undefined)),
        );
        const pending = handler(imageQuery());
        await vi.advanceTimersByTimeAsync(25001);
        expect((await pending).status).toBe(502);
    });
    it('enforces the deadline when body read and cancel both never settle', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    new Response(
                        new ReadableStream({
                            pull: () => new Promise<void>(() => undefined),
                            cancel: () => new Promise<void>(() => undefined),
                        }),
                        { headers: { 'content-type': 'text/xml' } },
                    ),
                ),
            ),
        );
        const pending = handler(imageQuery());
        await vi.advanceTimersByTimeAsync(25001);
        expect((await pending).status).toBe(502);
    });
});
