import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { OfflineWeatherStore, refreshOfflineWeather, marineIssueTime } from './offlineWeather.js';
import { satIrImageUrl, parseGmgsiFrames } from './offlineWeather/satelliteSource.js';
import { chartsForPoint } from './offlineWeather/synopticCharts.js';
import type { CacheEntry } from './cache.js';

const NOW = Date.UTC(2026, 9, 16, 12);
class MemoryCache {
    rows = new Map<string, CacheEntry>();
    get<T>(key: string): CacheEntry<T> | null {
        return (this.rows.get(key) as CacheEntry<T>) ?? null;
    }
    set<T>(key: string, data: T, ttl: number, source = ''): void {
        this.rows.set(key, { data, cachedAt: NOW, expiresAt: NOW + ttl, source });
    }
}
const caps =
    '<Layer><Name>global_longwave_imagery_mosaic</Name><Dimension name="time">2026-10-16T05:00:00Z/2026-10-16T12:00:00Z/PT1H</Dimension></Layer>';
const bulletin =
    'FZNT01 KWBC 161030\nHSFAT1\nHIGH SEAS FORECAST\nNWS OCEAN PREDICTION CENTER\n1030 UTC FRI OCT 16 2026\nOriginal forecast text.\n';
const jpeg = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
const gif = Buffer.from('GIF89afakefixture');
test('GMGSI request is the unchanged global belt, with only source-listed times', () => {
    const frames = parseGmgsiFrames(caps)!;
    const url = new URL(satIrImageUrl(frames.at(-1)!));
    assert.equal(url.searchParams.get('width'), '3072');
    assert.equal(url.searchParams.get('height'), '1288');
    assert.equal(url.searchParams.get('bbox'), '-20037508.34,-8399737.89,20037508.34,8399737.89');
    assert.equal(url.searchParams.get('time'), '2026-10-16T12:00:00.000Z');
    assert.equal(url.searchParams.get('layers'), 'global_longwave_imagery_mosaic');
});
test('closed internet policy fetches nothing and cannot erase a saved copy', async () => {
    const cache = new MemoryCache();
    const old = { schema: 1, fetchedAt: NOW - 1000, frames: [{ iso: 'old', dataUrl: 'old', timeMs: NOW - 1000 }] };
    cache.set('offline-weather:satellite', old, 1000);
    let calls = 0;
    await refreshOfflineWeather(
        cache,
        { lat: -27, lon: 153 },
        {
            internetAllowed: () => false,
            fetchImpl: (async () => {
                calls++;
                throw new Error();
            }) as typeof fetch,
        },
    );
    assert.equal(calls, 0);
    assert.deepEqual(new OfflineWeatherStore(cache).satellite(), old);
});
test('a bounded refresh keeps six frames, dated analysis, and original NOAA marine text', async () => {
    const cache = new MemoryCache();
    const urls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('GetCapabilities'))
            return new Response(caps, { headers: { 'Content-Type': 'application/xml' } });
        if (url.includes('GetMap')) return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
        if (url.includes('tgftp')) return new Response(bulletin, { headers: { 'Content-Type': 'text/plain' } });
        return new Response(gif, { headers: { 'Content-Type': 'image/gif' } });
    }) as typeof fetch;
    await refreshOfflineWeather(
        cache,
        { lat: 40, lon: -70 },
        { internetAllowed: () => true, fetchImpl: fetcher, now: () => NOW },
    );
    const store = new OfflineWeatherStore(cache);
    assert.equal(store.satellite()!.frames.length, 6);
    assert.equal(store.satellite()!.frames[0].timeMs, Date.UTC(2026, 9, 16, 7));
    assert.equal(store.analysis('opc-atl-analysis')!.fetchedAt, NOW);
    assert.equal(store.bulletins().bulletins[0].text, bulletin);
    assert.equal(store.bulletins().bulletins[0].issuedAt, '2026-10-16T10:30:00.000Z');
    assert.deepEqual(store.capabilities(), { schema: 1, satellite: true, analysis: true, marineBulletins: true });
    assert.equal(urls.filter((url) => url.includes('GetMap')).length, 6);
    await refreshOfflineWeather(
        cache,
        { lat: 40, lon: -70 },
        { internetAllowed: () => true, fetchImpl: fetcher, now: () => NOW + 1000 },
    );
    assert.equal(
        urls.filter((url) => url.includes('GetMap')).length,
        6,
        'unchanged frame bytes are not downloaded twice',
    );
});
test('a policy change during a body read stops subsequent assets', async () => {
    const cache = new MemoryCache();
    let allowed = true;
    let calls = 0;
    await refreshOfflineWeather(
        cache,
        { lat: 40, lon: -70 },
        {
            internetAllowed: () => allowed,
            now: () => NOW,
            fetchImpl: (async () => {
                calls++;
                allowed = false;
                return new Response(caps);
            }) as typeof fetch,
        },
    );
    assert.equal(calls, 1);
    assert.equal(new OfflineWeatherStore(cache).satellite(), null);
});
test('missing feed, oversized payload and false image MIME never become a cached picture', async () => {
    for (const content of ['x'.repeat(1_000_001), '<html>error</html>']) {
        const cache = new MemoryCache();
        await refreshOfflineWeather(
            cache,
            { lat: -40, lon: 153 },
            {
                internetAllowed: () => true,
                fetchImpl: (async () => new Response(content)) as typeof fetch,
                now: () => NOW,
            },
        );
        assert.equal(new OfflineWeatherStore(cache).satellite(), null);
        assert.equal(new OfflineWeatherStore(cache).capabilities().analysis, false);
    }
});
test('a February source file is not promoted to an October issue by day-of-month matching', () => {
    assert.equal(marineIssueTime(bulletin, NOW), '2026-10-16T10:30:00.000Z');
    assert.equal(marineIssueTime(bulletin.replace('OCT', 'FEB'), NOW), null);
    assert.equal(marineIssueTime(bulletin.replace('161030', '171030'), NOW), null);
    assert.equal(marineIssueTime('<html>unavailable</html>', NOW), null);
});
test('Australia gets no invented US bulletin coverage and permission-held sources are absent', async () => {
    const cache = new MemoryCache();
    await refreshOfflineWeather(
        cache,
        { lat: -27, lon: 153 },
        {
            internetAllowed: () => true,
            now: () => NOW,
            fetchImpl: (async () => new Response('unavailable', { status: 503 })) as typeof fetch,
        },
    );
    const store = new OfflineWeatherStore(cache);
    assert.equal(store.bulletins().bulletins.length, 0);
    assert.match(store.bulletins().coverage, /Selected NOAA/);
    assert.equal(chartsForPoint(-40, 153).length, 0);
    const scheduler = readFileSync(new URL('./scheduler.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(scheduler, /gibs\.earthdata\.nasa\.gov/);
});
