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

type Rules = { dirs: string[]; reopened: string[] };

/** The folder rules in .vercelignore: `dir/` and `dir/*` exclude it; `!dir` re-includes. */
function folderRules(text: string): Rules {
    const dirs: string[] = [];
    const reopened: string[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('!')) {
            reopened.push(`${line.slice(1).replace(/\/$/, '')}/`);
            continue;
        }
        const dir = line.endsWith('/*') ? line.slice(0, -1) : line.endsWith('/') ? line : null;
        if (dir && !dir.includes('*')) dirs.push(dir);
    }
    return { dirs, reopened };
}

const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

/** True when Vercel receives this path, per the folder and test-file rules. */
function uploaded(path: string, rules: Rules): boolean {
    if (TEST_FILE.test(path)) return false;
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
    for (const file of files) {
        if (!uploaded(file, rules)) continue;
        for (const match of read(file).matchAll(SPECIFIER)) {
            const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
            if (!uploaded(target, rules) && !uploaded(`${target}.ts`, rules))
                found.push(`${file} imports ${match[1]} (${target} is not uploaded)`);
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
        expect(uploaded('supabase/functions/proxy-openmeteo/index.ts', rules)).toBe(false);
        expect(uploaded('components/map/MapHub.tsx', rules)).toBe(true);
        expect(uploaded('components/map/MapHub.test.tsx', rules)).toBe(false);
        expect(uploaded('scripts/noaa-enc/convert-cli.ts', rules)).toBe(false);
        expect(uploaded('scripts/noaa-enc/convert-package-cli.ts', rules)).toBe(false);
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
