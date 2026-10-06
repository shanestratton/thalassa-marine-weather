// @vitest-environment node
/**
 * Which host gets which page, now that some labels are Thalassa's own
 * (src/publicHosts.ts, middleware.ts, 2026-10-06): ocean.thalassawx.app is
 * the public fleet page and indexable; its aliases redirect to it; www, api,
 * tiles and the rest pass through; every boat keeps its voyage log (noindex)
 * and its /plan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import middleware from '../../middleware';
import { classifyPublicHost, OCEAN_ALIASES, oceanPathRedirect, RESERVED_HANDLES } from '../../src/publicHosts';

const fetched: string[] = [];

function stubFetch() {
    fetched.length = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: URL | string) => {
            fetched.push(String(input));
            return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
        }),
    );
}

const call = (url: string) => middleware(new Request(url, { headers: { host: new URL(url).host } }));

afterEach(() => vi.unstubAllGlobals());

describe('classifyPublicHost', () => {
    it('sorts the ocean, its aliases, reserved names and boats', () => {
        expect(classifyPublicHost('ocean.thalassawx.app')).toEqual({ kind: 'ocean', label: 'ocean', tld: 'app' });
        expect(classifyPublicHost('OCEAN.thalassawx.com:443')?.kind).toBe('ocean-redirect');
        for (const alias of OCEAN_ALIASES)
            expect(classifyPublicHost(`${alias}.thalassawx.app`)?.kind).toBe('ocean-redirect');
        for (const name of ['www', 'api', 'tiles', 'app', 'maps']) {
            expect(classifyPublicHost(`${name}.thalassawx.app`)?.kind).toBe('reserved');
        }
        expect(classifyPublicHost('serene-summer.thalassawx.com')?.kind).toBe('boat');
        expect(classifyPublicHost('oceanic.thalassawx.app')?.kind).toBe('boat');
    });

    it('is null for anything that is not one label on a thalassawx apex', () => {
        for (const host of [
            'thalassawx.app',
            'a.b.thalassawx.app',
            'ocean.thalassawx.app.evil.test',
            'ocean.thalassawx.net',
            '',
        ]) {
            expect(classifyPublicHost(host)).toBeNull();
        }
    });

    it('reserves every name the ocean page answers to', () => {
        expect(RESERVED_HANDLES).toEqual(expect.arrayContaining(['ocean', ...OCEAN_ALIASES, 'www']));
    });
});

describe('middleware', () => {
    it('serves ocean.thalassawx.app from ocean.html, indexable, at any path', async () => {
        stubFetch();
        for (const path of ['/', '/species/megaptera-novaeangliae', '/plan']) {
            const response = (await call(`https://ocean.thalassawx.app${path}`)) as Response;
            expect(response.status).toBe(200);
            expect(response.headers.get('x-robots-tag')).toBeNull();
        }
        expect(fetched.map((u) => new URL(u).pathname)).toEqual(['/ocean.html', '/ocean.html', '/ocean.html']);
    });

    it('sends .com and the aliases to the canonical page with a 308, keeping path and query', async () => {
        stubFetch();
        const cases: Array<[string, string]> = [
            ['https://ocean.thalassawx.com/x?y=1', 'https://ocean.thalassawx.app/x?y=1'],
            ['https://watch.thalassawx.app/', 'https://ocean.thalassawx.app/'],
            [
                'https://sightings.thalassawx.com/species/dugong-dugon?a=b',
                'https://ocean.thalassawx.app/species/dugong-dugon?a=b',
            ],
            ['https://seabed.thalassawx.app/', 'https://ocean.thalassawx.app/'],
        ];
        for (const [from, to] of cases) {
            const response = (await call(from)) as Response;
            expect(response.status).toBe(308);
            expect(response.headers.get('location')).toBe(to);
        }
        expect(fetched).toEqual([]);
    });

    it('passes www, api, tiles and the apex through untouched', async () => {
        stubFetch();
        for (const url of [
            'https://www.thalassawx.app/',
            'https://api.thalassawx.app/x',
            'https://tiles.thalassawx.com/',
            'https://thalassawx.app/',
            'https://www.thalassawx.app/oceanic',
        ]) {
            expect(await call(url)).toBeUndefined();
        }
        expect(fetched).toEqual([]);
    });

    it('sends the apex and www /ocean paths to the canonical page (its data answers there only)', async () => {
        stubFetch();
        const cases: Array<[string, string]> = [
            ['https://thalassawx.app/ocean', 'https://ocean.thalassawx.app/'],
            ['https://www.thalassawx.app/ocean/', 'https://ocean.thalassawx.app/'],
            [
                'https://www.thalassawx.com/ocean/species/dugong-dugon?a=b',
                'https://ocean.thalassawx.app/species/dugong-dugon?a=b',
            ],
        ];
        for (const [from, to] of cases) {
            const response = (await call(from)) as Response;
            expect(response.status).toBe(308);
            expect(response.headers.get('location')).toBe(to);
        }
        expect(fetched).toEqual([]);
        // Not on a boat's host, not on a lookalike, not for /oceanic.
        expect(oceanPathRedirect('serene-summer.thalassawx.app', new URL('https://x/ocean'))).toBeNull();
        expect(oceanPathRedirect('thalassawx.app.evil.test', new URL('https://x/ocean'))).toBeNull();
        expect(oceanPathRedirect('www.thalassawx.app', new URL('https://x/oceanic'))).toBeNull();
    });

    it('still gives a boat its voyage log (noindex) and its planner', async () => {
        stubFetch();
        const log = (await call('https://serene-summer.thalassawx.app/')) as Response;
        expect(log.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
        const plan = (await call('https://serene-summer.thalassawx.com/plan')) as Response;
        expect(plan.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
        expect(fetched.map((u) => new URL(u).pathname)).toEqual(['/logs.html', '/index.html']);
    });
});
