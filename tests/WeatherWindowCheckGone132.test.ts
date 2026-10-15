/**
 * The hidden Weather Window Check stays deleted (132-B23, Shane 2026-10-15).
 *
 * The Go/No-Go scorer had no way in: its binder row was culled on 2026-09-02
 * ("we already have one on the passage planning") and its radial-menu item
 * was parked behind a flag that was never turned back on. A route, a lazy
 * chunk and a scoring engine that nothing reaches are only something to keep
 * true by hand, so the page, the engine that only it used, its route, its
 * radial-menu wiring and its tests went. The Departure Window on the Plan tab
 * covers leaving times, and Skipper's Reference's squall card points there.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const posix = (path: string) => path.split(sep).join('/');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const DELETED = [
    'components/weatherWindow/WeatherWindowCheck.tsx',
    'services/weatherWindow/weatherWindowScore.ts',
    'tests/weatherWindowScore.test.ts',
];
const SKIP = new Set(['node_modules', 'dist', 'ios', 'android', 'coverage', 'output', 'supabase']);

function sourceFiles(dir = ROOT): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) return [];
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(tsx?|mjs|js)$/.test(entry.name) ? [full] : [];
    });
}

/** Every module a file imports, lazy-loads or mocks, resolved to a repo path without extension. */
function relativeSpecifiers(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const out: string[] = [];
    for (const m of source.matchAll(/(?:\bfrom\s+|\bimport\(\s*|\bvi\.mock\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g)) {
        out.push(posix(relative(ROOT, resolve(dirname(file), m[1]))).replace(/\.(tsx?|js)$/, ''));
    }
    return out;
}

describe('the Weather Window Check stays deleted', () => {
    it.each(DELETED)('%s is gone', (file) => {
        expect(existsSync(join(ROOT, file))).toBe(false);
    });

    it('nothing imports, lazy-loads or mocks the page or its engine', () => {
        const gone = new Set(DELETED.map((f) => f.replace(/\.tsx?$/, '')));
        const offenders = sourceFiles().flatMap((file) =>
            relativeSpecifiers(file)
                .filter((spec) => gone.has(spec))
                .map((spec) => `${posix(relative(ROOT, file))} -> ${spec}`),
        );
        expect(offenders).toEqual([]);
    });

    it('has no route, no page transition and no radial-menu way in', () => {
        expect(read('viewRegistry.tsx')).not.toMatch(/weatherWindow:|WeatherWindowCheck/);
        expect(read('stores/uiStore.ts')).not.toMatch(/'weatherWindow'/);
        expect(read('components/map/buildTacticalState.ts')).not.toMatch(/onOpenWeatherWindow|'weatherWindow'/);
        expect(read('components/map/RadialHelmMenu.tsx')).not.toMatch(/onOpenWeatherWindow|WeatherWindowIcon/);
    });

    it('leaves the Departure Window, which covers leaving times, in place', () => {
        expect(existsSync(join(ROOT, 'components/passage/DepartureWindowSheet.tsx'))).toBe(true);
        expect(existsSync(join(ROOT, 'services/WeatherWindowService.ts'))).toBe(true);
    });
});
