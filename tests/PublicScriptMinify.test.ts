// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    MINIFIED_PUBLIC_SCRIPTS,
    REQUIRED_PUBLIC_SCRIPT_TOKENS,
    minifyPublicScriptWhitespace,
    syntaxFingerprint,
} from '../scripts/minify-public-scripts.mjs';

/**
 * The production build rewrites dist/sw.js and dist/pcm-worklet.js without
 * comments or whitespace (vite.config.ts `releaseMinifyPublicScripts`,
 * 2026-10-05): the service worker's cache-bump history alone was about 44 KB
 * of the JavaScript budget. public/ is untouched, so ServiceWorkerHardening
 * and every other source-reading test still read the commented original.
 *
 * Here: the dist copy parses to the same program, keeps every cache name, and
 * a real change to the program is caught rather than shipped.
 */
const ROOT = process.cwd();
const readPublic = (name: string) => readFileSync(join(ROOT, 'public', name), 'utf8');

describe('public scripts ship without comments, unchanged in behaviour', () => {
    it('is registered for production builds', () => {
        const viteConfig = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
        expect(viteConfig).toContain("mode === 'production' && releaseMinifyPublicScripts(),");
        expect([...MINIFIED_PUBLIC_SCRIPTS]).toEqual(['sw.js', 'pcm-worklet.js']);
    });

    it.each(MINIFIED_PUBLIC_SCRIPTS.map((name) => [name]))('%s keeps its program', async (name) => {
        const source = readPublic(name);
        const stripped = await minifyPublicScriptWhitespace(source, name);
        expect(syntaxFingerprint(stripped)).toBe(syntaxFingerprint(source));
        expect(stripped.length).toBeLessThan(source.length * 0.3);
        for (const token of REQUIRED_PUBLIC_SCRIPT_TOKENS[name as keyof typeof REQUIRED_PUBLIC_SCRIPT_TOKENS]) {
            expect(stripped).toContain(token);
        }
    });

    it('keeps every service-worker cache name and value', async () => {
        const source = readPublic('sw.js');
        const stripped = await minifyPublicScriptWhitespace(source, 'sw.js');
        const caches = [...source.matchAll(/^const (\w*CACHE\w*) = '([^']+)';/gm)];
        expect(caches.map((m) => m[1])).toEqual([
            'CACHE_NAME',
            'RUNTIME_TILE_CACHE',
            'OFFLINE_TILE_CACHE',
            'DATA_CACHE',
            'LAN_TILE_CACHE',
        ]);
        for (const [, name, value] of caches) {
            expect(stripped).toMatch(new RegExp(`\\b${name}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`));
        }
    });

    it('notices a change to the program, not just to its spelling', () => {
        const source = readPublic('sw.js');
        expect(syntaxFingerprint(source.replace(/^\/\/.*$/gm, ''))).toBe(syntaxFingerprint(source));
        const bumped = source.replace(/^const CACHE_NAME = '([^']+)';/m, "const CACHE_NAME = '$1-next';");
        expect(bumped).not.toBe(source);
        expect(syntaxFingerprint(bumped)).not.toBe(syntaxFingerprint(source));
        const reordered = source.replace('self.skipWaiting();', 'self.clients.claim();');
        expect(reordered).not.toBe(source);
        expect(syntaxFingerprint(reordered)).not.toBe(syntaxFingerprint(source));
    });
});
