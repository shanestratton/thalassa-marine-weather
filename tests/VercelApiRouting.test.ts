/**
 * Vercel's catch-all SPA rewrite must never swallow an API route.
 *
 * Found on the day ocean.thalassawx.app went live (2026-10-07): the page
 * loaded, but every /api/ocean/summary and /api/ocean/rows call came back as
 * the app's index.html. vercel.json's catch-all `/((?!.*\..*).*)` sends every
 * dot-less path to /index.html, and on Vercel that rewrite wins over a
 * dynamic function route like api/ocean/[view].ts. The other dynamic routes
 * (api/sst/[file].ts and friends) only ever see dotted paths
 * ("…/x.png"), so they worked by luck. The same pattern also stamped
 * `max-age=0, must-revalidate` on API answers, defeating the ocean API's CDN
 * cache. Both rules now skip /api/.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rule = { source: string; destination?: string };
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { rewrites: Rule[]; headers: Rule[] };

/** The regex-group sources ("/(…)") Vercel matches against the whole path. */
const regexRules = (rules: Rule[]) =>
    rules
        .filter((rule) => rule.source.startsWith('/('))
        .map((rule) => ({ ...rule, re: new RegExp(`^${rule.source}$`) }));

const API_PATHS = ['/api/ocean/summary', '/api/ocean/rows', '/api/wx', '/api/spread'];

describe('vercel.json routing keeps the API reachable', () => {
    it('no regex rewrite sends an API path to a page', () => {
        for (const rule of regexRules(vercel.rewrites)) {
            for (const path of API_PATHS) expect(rule.re.test(path), `${rule.source} matched ${path}`).toBe(false);
        }
    });

    it('the SPA catch-all still serves the app routes and leaves files alone', () => {
        const catchAll = regexRules(vercel.rewrites).find((rule) => rule.destination === '/index.html');
        expect(catchAll).toBeDefined();
        for (const path of ['/', '/plan', '/diary', '/obs', '/apiary'])
            expect(catchAll!.re.test(path), path).toBe(true);
        for (const path of ['/assets/main.js', '/ocean.html', '/sw.js'])
            expect(catchAll!.re.test(path), path).toBe(false);
    });

    it('no-cache page headers are not stamped on API answers', () => {
        // Site-wide security headers (`/(.*)`) rightly apply to the API too;
        // only the page-cache rules must leave it to set its own caching.
        const cacheRules = regexRules(vercel.headers).filter((rule) =>
            ((rule as Rule & { headers?: { key: string }[] }).headers ?? []).some(
                (h) => h.key.toLowerCase() === 'cache-control',
            ),
        );
        expect(cacheRules.length).toBeGreaterThan(0);
        for (const rule of cacheRules) {
            for (const path of API_PATHS) expect(rule.re.test(path), `${rule.source} matched ${path}`).toBe(false);
        }
    });
});
