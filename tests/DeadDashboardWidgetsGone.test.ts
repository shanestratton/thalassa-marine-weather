/**
 * The old dashboard widget registry stays deleted (W1-FX item 3).
 *
 * WidgetRenderer mapped widget ids ('advice', 'details', 'hourly', 'tides',
 * 'vessel', …) to the widgets behind them, but nothing has rendered it since
 * January 2026: the Glass is HeroSlide, and Dashboard took only an empty
 * context from it that no component read. Rollup's own production graph
 * (b123 2aecbedf, 2026-10-08) still shipped the registry's whole subtree,
 * because module-level React.memo and lazyRetry calls count as side effects:
 * WeatherGrid (with DetailedMetricsWidget), Advice, the WeatherCharts and
 * DndSortableGrid lazy chunks, WeatherIcon, and, through the TideAndVessel
 * barrel HeroSlide used for TideGraph alone, VesselWidget and the
 * MoonVisual / SolarArc celestial widgets. Every one was mounted only by tests.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const DELETED = [
    'components/WidgetRenderer.tsx',
    'components/dashboard/Advice.tsx',
    'components/dashboard/WeatherGrid.tsx',
    'components/dashboard/WeatherCharts.tsx',
    'components/dashboard/DndSortableGrid.tsx',
    'components/dashboard/shared/WeatherIcon.tsx',
    'components/dashboard/TideAndVessel.tsx',
    'components/dashboard/VesselWidget.tsx',
    'components/dashboard/tide/CelestialComponents.tsx',
    'components/dashboard/tide/index.ts',
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
        out.push(relative(ROOT, resolve(dirname(file), m[1])).replace(/\.(tsx?|js)$/, ''));
    }
    return out;
}

describe('the dead dashboard widget registry stays deleted', () => {
    it.each(DELETED)('%s is gone', (file) => {
        expect(existsSync(join(ROOT, file))).toBe(false);
    });

    it('nothing imports, lazy-loads or mocks any of them', () => {
        const gone = new Set(
            DELETED.flatMap((f) => {
                const base = f.replace(/\.tsx?$/, '');
                return base.endsWith('/index') ? [base, base.slice(0, -'/index'.length)] : [base];
            }),
        );
        const offenders = sourceFiles().flatMap((file) =>
            relativeSpecifiers(file)
                .filter((spec) => gone.has(spec))
                .map((spec) => `${relative(ROOT, file)} -> ${spec}`),
        );
        expect(offenders).toEqual([]);
    });
});
