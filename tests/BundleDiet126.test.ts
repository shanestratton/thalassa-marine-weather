// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINIFIED_PUBLIC_DATA, minifyPublicJson } from '../scripts/minify-public-scripts.mjs';

/**
 * Build 126 bundle diet (package 126-00, was 125-09). Build 125 shipped with
 * 24,660 B of headroom under the 10.25 MiB JavaScript line. Everything in
 * dist/ ships inside the iOS app, so the diet removes bytes rather than
 * moving them between chunks:
 *
 *   1. framer-motion (with motion-dom and motion-utils) served two
 *      components, the layer menu and the storm picker. They animate with
 *      CSS now and the dependency is gone.
 *   2. The two big data tables, the Queensland marine place names and the
 *      customs clearance guide, are data files in public/data, fetched when
 *      needed (public/ is packaged in the app, so they work offline). The
 *      dist copies are minified; the public/ sources stay readable.
 *   3. The JavaScript tripwire comes down to match.
 */
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            sourceFiles(rel, out);
        } else if (/\.(tsx?|mjs|cjs|js)$/.test(entry.name)) out.push(rel);
    }
    return out;
}

describe('framer-motion is out of the app', () => {
    it('is not a dependency in package.json, the npm lockfile or the deno lockfile', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.dependencies).not.toHaveProperty('framer-motion');
        expect(pkg.devDependencies ?? {}).not.toHaveProperty('framer-motion');
        const lock = JSON.parse(read('package-lock.json'));
        for (const name of ['framer-motion', 'motion-dom', 'motion-utils']) {
            expect(lock.packages).not.toHaveProperty(`node_modules/${name}`);
        }
        expect(lock.packages[''].dependencies).not.toHaveProperty('framer-motion');
        expect(read('deno.lock')).not.toContain('framer-motion');
    });

    it('is imported nowhere, app code or e2e fixtures', () => {
        const dirs = ['components', 'pages', 'hooks', 'services', 'src', 'stores', 'utils', 'context', 'e2e'].filter(
            (d) => existsSync(join(ROOT, d)),
        );
        const files = [...dirs.flatMap((d) => sourceFiles(d)), 'App.tsx', 'index.tsx'].filter((f) =>
            existsSync(join(ROOT, f)),
        );
        expect(files.length).toBeGreaterThan(500);
        const offenders = files.filter((f) => /from ['"](framer-motion|motion)['"]/.test(read(f)));
        expect(offenders).toEqual([]);
    });
});

describe('the data tables ship as data', () => {
    it('lists both public data files for dist minification', () => {
        expect([...MINIFIED_PUBLIC_DATA]).toEqual(['data/marine-place-names-qld.json', 'data/customs-clearance.json']);
        for (const file of MINIFIED_PUBLIC_DATA) expect(existsSync(join(ROOT, 'public', file))).toBe(true);
    });

    it('rewrites each dist copy as minified JSON in the release plugin', () => {
        // The wiring, not the name: an import alone (or a commented-out loop)
        // would leave the indented tables shipping with every check green.
        // Whole-line comments only: the config holds globs like '**/*.js'.
        const viteConfig = read('vite.config.ts')
            .replace(/^\s*\/\*[\s\S]*?\*\/[^\S\n]*$/gm, '')
            .replace(/^\s*\/\/[^\n]*$/gm, '');
        const plugin = viteConfig.match(/function releaseMinifyPublicScripts\(\)[\s\S]*?\n\}\n/)?.[0] ?? '';
        const writeBundle = plugin.match(/async writeBundle\(\) \{[\s\S]*?\n {8}\},\n/)?.[0] ?? '';
        expect(writeBundle).toMatch(
            /for \(const fileName of MINIFIED_PUBLIC_DATA\) \{[\s\S]*?const target = path\.join\(outDir, fileName\);[\s\S]*?fs\.writeFileSync\(target, minifyPublicJson\(fs\.readFileSync\(target, 'utf8'\), fileName\)\);/,
        );
        expect(viteConfig).toContain("mode === 'production' && releaseMinifyPublicScripts(),");
    });

    it.each(['data/marine-place-names-qld.json', 'data/customs-clearance.json'])(
        '%s minifies to the same value, much smaller',
        (file) => {
            const source = read(join('public', file));
            const minified = minifyPublicJson(source, file);
            expect(JSON.parse(minified)).toEqual(JSON.parse(source));
            expect(minified.length).toBeLessThan(source.length * 0.8);
            expect(minified).not.toMatch(/\n\s/);
        },
    );

    it('refuses a file that is not JSON rather than shipping it broken', () => {
        expect(() => minifyPublicJson('{"a": 1,', 'data/broken.json')).toThrow(/data\/broken\.json/);
    });

    it('keeps both tables out of every source module', () => {
        // Code only: comments may say where the data lives.
        const code = (f: string) =>
            read(f)
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        const offenders = sourceFiles('services')
            .concat(sourceFiles('components'), sourceFiles('data'))
            .filter((f) => /marine-place-names-qld\.json|customs-clearance\.json/.test(code(f)))
            .map((f) => relative(ROOT, join(ROOT, f)))
            .sort();
        // Only the two loaders name their file, as a fetched URL.
        expect(offenders).toEqual(['data/customsDb.ts', 'services/marineEndpointName.ts']);
        expect(statSync(join(ROOT, 'data/customsDb.ts')).size).toBeLessThan(16_000);
    });
});

describe('the JavaScript tripwire', () => {
    it('is lowered from the 10.25 MiB line build 125 shipped under', () => {
        const script = read('scripts/check-bundle-size.js');
        const line = script.match(/\n\s*javascript: ([^,]+),/)?.[1] ?? '';
        expect(line).not.toBe('10.25 * MIB');
        const bytes = Function('MIB', 'KIB', `return ${line};`)(1024 * 1024, 1024) as number;
        expect(bytes).toBeLessThan(10.25 * 1024 * 1024);
        expect(script).toMatch(/2026-10-\d\d[^\n]*\n[\s\S]*javascript:/);
    });
});
