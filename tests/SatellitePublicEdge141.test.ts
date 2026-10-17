import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicSatelliteViewHandler, SATELLITE_PUBLIC_QUOTA } from '../supabase/functions/satellite-view/handler';
import { MarineDataTrustError, readBoundedResponse } from '../services/weather/api/cmemsGridTrust';
import * as bounded from '../services/weather/api/boundedPublisherResponse';
import { SATELLITE_VIEW_URL } from '../services/weather/satelliteViewEndpoint';
const now = Date.parse('2026-10-17T03:30:00Z');
const xml = readFileSync('tests/fixtures/satellite141/himawari-domains.xml', 'utf8');
const req = (suffix = '?action=times&product=himawari-ir', init?: RequestInit) =>
    new Request(SATELLITE_VIEW_URL + suffix, init);
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
describe('fixed public satellite Edge admission', () => {
    it('retains exact shared bounded reader and error identities after the pure module extraction', () => {
        expect(readBoundedResponse).toBe(bounded.readBoundedResponse);
        expect(MarineDataTrustError).toBe(bounded.MarineDataTrustError);
    });
    it('admits one quota before fixed metadata without forwarding client credentials', async () => {
        const events: string[] = [];
        const quota = vi.fn(async () => {
            events.push('quota');
            return null;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string, init: RequestInit) => {
                events.push('provider');
                expect(new URL(input).origin).toBe('https://gibs.earthdata.nasa.gov');
                expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
                expect(new Headers(init.headers).has('authorization')).toBe(false);
                return new Response(xml, { headers: { 'content-type': 'text/xml' } });
            }),
        );
        const response = await createPublicSatelliteViewHandler(
            () => true,
            quota,
        )(req(undefined, { headers: { authorization: 'Bearer fictional', cookie: 'private', apikey: 'private' } }));
        expect(response.status).toBe(200);
        expect(events).toEqual(['quota', 'provider']);
        expect((await response.json()).frames.at(-1).iso).toBe('2026-10-17T03:00:00Z');
        expect(SATELLITE_PUBLIC_QUOTA).toEqual({ bucket: 'satellite_view_public', limit: 120, windowSeconds: 3600 });
    });
    it.each([
        '?action=times&product=unknown',
        '?action=times&product=himawari-ir&url=https://bad.test',
        '?action=times&product=himawari-ir&product=himawari-ir',
        '/nested?action=times&product=himawari-ir',
        '?action=image&product=himawari-ir&time=bad&bbox=-1,-1,1,1&width=256&height=256',
    ])('refuses %s before quota or source access', async (suffix) => {
        const quota = vi.fn(async () => null),
            fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        expect((await createPublicSatelliteViewHandler(() => true, quota)(req(suffix))).status).toBe(400);
        expect(quota).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([429, 503])('retains quota refusal %s and retry headers without a provider read', async (status) => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const response = await createPublicSatelliteViewHandler(
            () => true,
            async () => new Response('held', { status, headers: { 'retry-after': '60' } }),
        )(req());
        expect(response.status).toBe(status);
        expect(response.headers.get('retry-after')).toBe('60');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('retires uncooperative quota at eight seconds and refuses its late approval', async () => {
        let finish!: (value: null) => void;
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const pending = createPublicSatelliteViewHandler(
            () => true,
            () => new Promise<null>((resolve) => (finish = resolve)),
        )(req());
        await vi.advanceTimersByTimeAsync(8000);
        expect((await pending).status).toBe(503);
        finish(null);
        await Promise.resolve();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('cancels quota before its late result and never requests a provider', async () => {
        let finish!: (value: null) => void;
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const owner = new AbortController();
        const pending = createPublicSatelliteViewHandler(
            () => true,
            () => new Promise<null>((resolve) => (finish = resolve)),
        )(req(undefined, { signal: owner.signal }));
        owner.abort();
        expect((await pending).status).toBe(503);
        finish(null);
        await Promise.resolve();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('keeps both gates OFF, preflight credential-free and mutations/partial reads unavailable', async () => {
        const quota = vi.fn(async () => null),
            fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const handle = createPublicSatelliteViewHandler(() => false, quota);
        expect((await handle(req())).status).toBe(503);
        expect((await handle(req('', { method: 'OPTIONS' }))).status).toBe(204);
        expect((await handle(req(undefined, { method: 'POST', body: '{}' }))).status).toBe(405);
        expect((await handle(req(undefined, { headers: { range: 'bytes=0-2' } }))).status).toBe(400);
        expect(quota).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});
