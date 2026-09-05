/**
 * Audit item 16: the two public upstream proxies that spend paid quota get
 * caller and volume controls.
 *
 *  - maritime-intel fans out to five RSS publishers per request and had no
 *    caller check at all. It now takes the same authenticated-or-public quota
 *    get-weather uses, and answers repeats from a 10-minute in-isolate cache.
 *  - api/owm-tile (Vercel Edge) proxies OpenWeatherMap tiles with our key. It
 *    now refuses a foreign Origin/Referer while still serving same-origin and
 *    in-app requests, which send neither header.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import handler, { originAllowed } from '../api/owm-tile';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('maritime-intel', () => {
    const edge = strip(readFileSync('supabase/functions/maritime-intel/index.ts', 'utf8'));

    it('meters the caller before touching any upstream feed', () => {
        const quota = edge.indexOf("requireAuthenticatedOrPublicQuota(req, 'maritime_intel', 120, 30, 3600)");
        const fetchAll = edge.indexOf('Promise.allSettled(RSS_FEEDS.map(fetchFeed))');
        expect(quota).toBeGreaterThan(0);
        expect(fetchAll).toBeGreaterThan(quota);
        expect(edge).toContain('if (caller instanceof Response) return withCors(caller, corsHeaders);');
    });

    it('serves repeats from a short cache instead of re-fetching five publishers', () => {
        expect(edge).toContain('const CACHE_TTL_MS = 10 * 60 * 1000;');
        const cacheHit = edge.indexOf('if (cached && Date.now() - cached.at < CACHE_TTL_MS)');
        const fetchAll = edge.indexOf('Promise.allSettled(RSS_FEEDS.map(fetchFeed))');
        expect(cacheHit).toBeGreaterThan(0);
        expect(cacheHit).toBeLessThan(fetchAll);
        // An empty aggregate (every feed down) is never cached as the answer.
        expect(edge).toContain('if (limited.length > 0) cached = { at: Date.now(), body };');
    });
});

describe('owm-tile origin allowlist', () => {
    const url = 'https://thalassa.test/api/owm-tile?layer=clouds&z=0&x=0&y=0';
    const req = (headers: Record<string, string> = {}) => new Request(url, { headers });

    it('allows a request with no Origin or Referer — same-origin tile fetches send neither', () => {
        expect(originAllowed(req())).toBe(true);
    });

    it('allows the app origins and previews', () => {
        for (const origin of [
            'https://www.thalassawx.app',
            'https://thalassawx.app',
            'capacitor://localhost',
            'ionic://localhost',
            'http://localhost:5173',
            'https://thalassa-git-feature-x.vercel.app',
        ]) {
            expect(originAllowed(req({ origin })), origin).toBe(true);
        }
    });

    it('refuses a foreign origin, by Origin or by Referer', () => {
        expect(originAllowed(req({ origin: 'https://evil.example' }))).toBe(false);
        expect(originAllowed(req({ referer: 'https://evil.example/map.html' }))).toBe(false);
        expect(originAllowed(req({ referer: 'not a url' }))).toBe(false);
    });

    it('the handler answers 403 to a foreign origin before spending anything', async () => {
        const res = await handler(req({ origin: 'https://evil.example' }));
        expect(res.status).toBe(403);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });
});
