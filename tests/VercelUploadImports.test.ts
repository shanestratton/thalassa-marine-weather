/**
 * Every file Vercel uploads must be buildable without the folders .vercelignore
 * leaves out.
 *
 * Found on 2026-10-13: master moved to build 127 and the production deploy
 * failed with TS2307. browser-tests/helpers/windPixelCapture.ts imports
 * tests/helpers/colourScience; Vercel never receives tests/, and tsconfig's
 * `./**\/*` include still type-checked browser-tests/, so `tsc` failed there
 * while passing on the Mac and on GitHub, where the whole tree exists. The
 * same trap broke every deploy from 2026-07-24 (supabase/functions/_shared)
 * and on 2026-10-10 (e2e/ fixtures importing tests/).
 *
 * This test reads .vercelignore, works out which tracked source files Vercel
 * uploads, and fails if any of them imports a path Vercel does not upload.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rules = { dirs: string[]; reopened: string[]; files: string[] };

/** Folder rules and literal files in .vercelignore; `!dir` re-includes a folder. */
function folderRules(text: string): Rules {
    const dirs: string[] = [];
    const reopened: string[] = [];
    const files: string[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('!')) {
            reopened.push(`${line.slice(1).replace(/\/$/, '')}/`);
            continue;
        }
        const dir = line.endsWith('/*') ? line.slice(0, -1) : line.endsWith('/') ? line : null;
        if (dir && !dir.includes('*')) dirs.push(dir);
        else if (!line.includes('*')) files.push(line);
    }
    return { dirs, reopened, files };
}

const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

/** True when Vercel receives this path, per the folder and test-file rules. */
function uploaded(path: string, rules: Rules): boolean {
    if (TEST_FILE.test(path)) return false;
    if (rules.files.includes(path)) return false;
    // The deepest matching rule wins, as in gitignore: `supabase/*` then
    // `!supabase/functions`, `supabase/functions/*`, `!supabase/functions/_shared`.
    let verdict = true;
    let depth = -1;
    for (const dir of rules.dirs)
        if (path.startsWith(dir) && dir.length > depth) [verdict, depth] = [false, dir.length];
    for (const dir of rules.reopened)
        if (path.startsWith(dir) && dir.length > depth) [verdict, depth] = [true, dir.length];
    return verdict;
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Uploaded source files whose relative imports reach a path Vercel leaves out. */
function offenders(files: string[], read: (path: string) => string, rules: Rules): string[] {
    const found: string[] = [];
    const trackedFiles = new Set(files);
    for (const file of files) {
        if (!uploaded(file, rules)) continue;
        for (const match of read(file).matchAll(SPECIFIER)) {
            const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
            const resolved =
                [target, `${target}.ts`, `${target}.tsx`, `${target}.mts`, `${target}.mjs`, `${target}/index.ts`].find(
                    (candidate) => trackedFiles.has(candidate),
                ) ?? target;
            if (!uploaded(resolved, rules)) found.push(`${file} imports ${match[1]} (${target} is not uploaded)`);
        }
    }
    return found.sort();
}

const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mts', '*.mjs'], {
    encoding: 'utf8',
})
    .split('\0')
    .filter(Boolean);
const read = (path: string) => readFileSync(path, 'utf8');
const rules = folderRules(readFileSync('.vercelignore', 'utf8'));

describe('the Vercel upload builds on its own', () => {
    it('leaves out the test folders, and keeps the shared edge-function code the app imports', () => {
        for (const dir of ['tests/', 'e2e/', 'browser-tests/']) expect(rules.dirs).toContain(dir);
        expect(uploaded('supabase/functions/_shared/ww3/constants.ts', rules)).toBe(true);
        expect(uploaded('supabase/functions/_shared/community-review-photo-codec.ts', rules)).toBe(true);
        expect(uploaded('supabase/functions/community-review-photo/codec.ts', rules)).toBe(false);
        expect(uploaded('supabase/functions/proxy-openmeteo/index.ts', rules)).toBe(false);
        expect(uploaded('components/map/MapHub.tsx', rules)).toBe(true);
        expect(uploaded('components/map/MapHub.test.tsx', rules)).toBe(false);
        expect(uploaded('scripts/noaa-enc/convert-cli.ts', rules)).toBe(false);
        expect(uploaded('scripts/noaa-enc/convert-package-cli.ts', rules)).toBe(false);
        expect(uploaded('scripts/check-pi-wake-db.mjs', rules)).toBe(false);
        expect(uploaded('scripts/check-pi-wake-postgres.mjs', rules)).toBe(false);
    });

    it('rejects app imports of excluded literal files, extensionless files and type-only Pi dependencies', () => {
        const files = ['app.ts', 'scripts/proof.mjs', 'scripts/private-helper.ts', 'pi-cache/src/types.ts'];
        const rules = folderRules('scripts/proof.mjs\nscripts/private-helper.ts\npi-cache/\n');
        const source = `import './scripts/proof.mjs'; import {helper} from './scripts/private-helper'; import type {Wire} from './pi-cache/src/types';`;
        expect(offenders(files, (file) => (file === 'app.ts' ? source : ''), rules)).toEqual([
            'app.ts imports ./pi-cache/src/types (pi-cache/src/types is not uploaded)',
            'app.ts imports ./scripts/private-helper (scripts/private-helper is not uploaded)',
            'app.ts imports ./scripts/proof.mjs (scripts/proof.mjs is not uploaded)',
        ]);
    });

    it('no uploaded file imports a path Vercel does not upload', () => {
        expect(tracked.length).toBeGreaterThan(500);
        expect(offenders(tracked, read, rules)).toEqual([]);
    });

    it('catches the build 127 failure: browser-tests/ uploaded while it imports tests/', () => {
        const without = { ...rules, dirs: rules.dirs.filter((dir) => dir !== 'browser-tests/') };
        expect(offenders(tracked, read, without)).toContain(
            'browser-tests/helpers/windPixelCapture.ts imports ../../tests/helpers/colourScience (tests/helpers/colourScience is not uploaded)',
        );
    });
});
