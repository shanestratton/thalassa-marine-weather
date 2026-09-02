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
import { describe, expect, it } from 'vitest';

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
        // …and www matches the shape but the middleware excludes it by name,
        // which is the behaviour this asserts alongside.
        expect('www.thalassawx.com'.match(re)?.[1]).toBe('www');
        expect(readFileSync('middleware.ts', 'utf8')).toContain("=== 'www'");
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
