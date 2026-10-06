import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MapTiler is OUT (Shane 2026-10-04: "fix the license problem"). Its free key
 * is licensed for non-commercial use only, and the default Obs view loaded its
 * Ocean tiles as a 0.45 tint over satellite, which blocks the paid release.
 *
 * This guard reads everything that ships to a browser or the phone: the app
 * and public-page source, the HTML entry points, the static public files, the
 * CSP headers and the stylesheet. Any 'maptiler' (URL, host, credit or
 * comment) fails it, and so does the retired key on any host. The key is
 * matched by its SHA-256 so this public repo stops carrying it. Tests, docs
 * and scripts are not shipped and are not read.
 */
const RETIRED_KEY_SHA256 = 'f4a651bcf07847919e37d2374d53bb401cf4c4ac55d6bf9b2a2c33a20de419d7';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const ROOT = process.cwd();
const SHIPPED_DIRS = [
    'api',
    'components',
    'config',
    'context',
    'contexts',
    'hooks',
    'managers',
    'modules',
    'pages',
    'public',
    'services',
    'src',
    'stores',
    'types',
    'utils',
    'workers',
];
const SHIPPED_FILES = [
    'App.tsx',
    'ApplicationShell.tsx',
    'index.tsx',
    'index.html',
    'index.css',
    'logs.html',
    'beta.html',
    'feedback.html',
    'ocean.html',
    'viewRegistry.tsx',
    'utils.ts',
    'types.ts',
    'theme.ts',
    'manifest.json',
    'vercel.json',
    'middleware.ts',
];
const TEXT = /\.(ts|tsx|js|mjs|cjs|jsx|html|css|json|txt|xml|webmanifest)$/;

function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (TEXT.test(name)) out.push(path);
    }
}

function shippedFiles(): string[] {
    const out: string[] = [];
    for (const dir of SHIPPED_DIRS) {
        try {
            walk(join(ROOT, dir), out);
        } catch {
            /* a directory this checkout does not have */
        }
    }
    for (const file of SHIPPED_FILES) {
        try {
            if (statSync(join(ROOT, file)).isFile()) out.push(join(ROOT, file));
        } catch {
            /* optional entry point */
        }
    }
    return out;
}

describe('MapTiler is gone from everything the client loads', () => {
    it('reads a real set of shipped files', () => {
        const files = shippedFiles().map((path) => relative(ROOT, path));
        expect(files).toContain('components/map/useMapInit.ts');
        expect(files).toContain('src/components/MapContainer.tsx');
        expect(files).toContain('public/sw.js');
        expect(files).toContain('index.html');
        expect(files.length).toBeGreaterThan(500);
    });

    it('has no MapTiler URL, host, credit or key', () => {
        const offenders: string[] = [];
        for (const path of shippedFiles()) {
            const text = readFileSync(path, 'utf8');
            const keyed = [...text.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{20}(?![A-Za-z0-9])/g)].some(
                ([token]) => sha256(token) === RETIRED_KEY_SHA256,
            );
            if (/maptiler/i.test(text) || keyed) {
                const line = text.split('\n').findIndex((row) => /maptiler/i.test(row)) + 1;
                offenders.push(`${relative(ROOT, path)}:${line || 'retired key'}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
