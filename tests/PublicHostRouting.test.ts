/**
 * Which hostnames reach a boat's public pages.
 *
 * Shane 2026-09-02: "can we make the public page work at
 * boat-name.thalassawx.com as well as boat-name.thalassawx.app". A link
 * read out loud has to survive being typed from memory, and .com is the
 * ending people guess.
 *
 * Pinned because host routing fails SILENTLY and in the worst place: the
 * middleware simply falls through, Vercel serves the marketing app, and the
 * skipper never finds out — the person who got the dead link is not the
 * person who could report it.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The live pattern, lifted from the middleware so the two cannot drift. */
function hostPattern(): RegExp {
    const source = readFileSync('middleware.ts', 'utf8');
    const line = source.match(/host\.match\((\/\^.*?\/i)\)/);
    expect(line, 'host match pattern not found in middleware.ts').not.toBeNull();
    const body = (line as RegExpMatchArray)[1];
    return new RegExp(body.slice(1, body.lastIndexOf('/')), 'i');
}

describe('public host routing', () => {
    it('routes a boat handle on both .app and .com', () => {
        const re = hostPattern();
        expect('serene-summer.thalassawx.app'.match(re)?.[1]).toBe('serene-summer');
        expect('serene-summer.thalassawx.com'.match(re)?.[1]).toBe('serene-summer');
    });

    it('tolerates a port, which `host` carries off the standard ports', () => {
        expect('serene-summer.thalassawx.com:3000'.match(hostPattern())?.[1]).toBe('serene-summer');
    });

    it('leaves the apex and www to the marketing site', () => {
        const re = hostPattern();
        // The apex has no sub-label, so it must not match at all…
        expect(re.test('thalassawx.app')).toBe(false);
        expect(re.test('thalassawx.com')).toBe(false);
        // …and www matches the shape but the middleware excludes it by name
        // (one of Thalassa's reserved names since 2026-10-06), which is the
        // behaviour this asserts alongside.
        expect('www.thalassawx.com'.match(re)?.[1]).toBe('www');
        expect(readFileSync('src/publicHosts.ts', 'utf8')).toMatch(/RESERVED_HANDLES[\s\S]*'www'/);
        expect(readFileSync('middleware.ts', 'utf8')).toContain("kind === 'reserved'");
    });

    it('does not hand a lookalike domain a boat page', () => {
        const re = hostPattern();
        expect(re.test('serene-summer.thalassawx.app.evil.test')).toBe(false);
        expect(re.test('serene-summer.thalassawx.net')).toBe(false);
        expect(re.test('evil.test')).toBe(false);
        // Two labels deep is not the pattern either — only one sub-label.
        expect(re.test('a.b.thalassawx.com')).toBe(false);
    });

    it('the renderer treats both apexes as "no handle here"', () => {
        // parseVoyageLogParams must not read "thalassawx" as a boat name.
        const source = readFileSync('src/voyageLogApi.ts', 'utf8');
        expect(source).toMatch(/thalassawx\\\.\(app\|com\)/);
    });
});

/**
 * Box tags (126-11b): https://www.thalassawx.app/box/<id> must reach vercel.json's
 * /box/:id rewrite (the static page for a phone without Thalassa), and Apple
 * must find the association file where it looks. www, because the apex is a
 * Vercel domain redirect to www that never reaches this project. The real
 * middleware, called with real Requests; its upstream fetch is a fake.
 */
describe('box links and the association file', () => {
    const id = '4c3b2a19-0817-4f6e-9d5c-4b3a29180716';

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function route(url: string): Promise<{ result: unknown; fetched: string[] }> {
        const fetched: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (target: URL | string) => {
                fetched.push(new URL(String(target)).pathname);
                return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
            }),
        );
        const { default: middleware } = await import('../middleware');
        const request = new Request(url, { headers: { host: new URL(url).host } });
        return { result: await middleware(request), fetched };
    }

    it('leaves www.thalassawx.app/box/<id>, the link on the tags, alone for the vercel.json rewrite', async () => {
        for (const host of ['www.thalassawx.app', 'thalassawx.app']) {
            const { result, fetched } = await route(`https://${host}/box/${id}`);
            expect(result, host).toBeUndefined();
            expect(fetched, host).toEqual([]);
        }
    });

    it('still sends <handle>.thalassawx.app/box/x to the voyage log, on both endings', async () => {
        for (const host of ['serene-example.thalassawx.app', 'serene-example.thalassawx.com']) {
            const { result, fetched } = await route(`https://${host}/box/x`);
            expect(fetched).toEqual(['/logs.html']);
            expect((result as Response).headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
        }
    });

    it('never runs on /.well-known/apple-app-site-association, but does on /box/<id>', async () => {
        const { config } = await import('../middleware');
        const matcher = new RegExp(`^${config.matcher}$`);
        expect(matcher.test('/.well-known/apple-app-site-association')).toBe(false);
        expect(matcher.test('/box.html')).toBe(false);
        expect(matcher.test(`/box/${id}`)).toBe(true);
    });
});
