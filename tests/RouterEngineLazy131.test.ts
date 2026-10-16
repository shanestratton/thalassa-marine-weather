// @vitest-environment node
/**
 * Build 131, package 131-04 (was 127-10): the app opens without the router.
 *
 * 127's route worker put the routing engine in its own chunk, `router-engine`
 * (about 120 KB compressed), but the app shell still imported it: the saved
 * route library lived in services/routeTracer.ts, which imports the engine, and
 * the Log, Cast Off, the account sync and Plan Your Day all read the library.
 * The library is services/savedTraceStore.ts now and imports no engine code,
 * the Log's route report loads when it opens, and the build gives the two
 * engine modules the start-up does use (plain types and constants) to the
 * small `engine-leaf` chunk. The router loads when a route is planned, traced
 * or checked.
 *
 * These walk the source the way the build reads the engine
 * (scripts/route-job-closure.mjs), so a new static path from the start-up to
 * the router fails here. The build fails too (routeEngineChunkOf throws when
 * the start-up reaches the route job). An import of a type that does not say
 * `type` counts as a value here: write `import type` for it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    APP_SHELL_ENTRY,
    ROUTE_ENGINE_SHARED_LEAVES,
    routeJobClosure,
    staticAppGraph,
} from '../scripts/route-job-closure.mjs';

const ROOT = process.cwd();
const ENGINE = routeJobClosure(ROOT) as Map<string, { imports: string[] }>;
/** The router's front doors: reaching one statically brings the whole engine. */
const ROUTER = ['services/routeTracer.ts', 'services/InshoreRouter.ts', 'services/routing/routeWorkerHost.ts'];
const stopAtRouter = (rel: string) => ENGINE.has(rel) || ROUTER.includes(rel);

/**
 * The modules of the engine's graph the app may load at start-up, and why
 * each is safe there. They import no other app module for a value, so none
 * can bring the router with it.
 */
const START_UP_LEAVES = [
    // Chart cell names, ids and sizes (chartFacts, the chart registry, the Pi pairing).
    'services/enc/types.ts',
    // The router's result types, plus nearSpanBlocks for the saved route's caveats.
    'services/engine/types.ts',
    // The app's own logger. The router's chunk carries its own copy
    // (vite.config.ts routeEngineLogger), so this is not the engine's.
    'utils/createLogger.ts',
];

/** Everyday passage summaries share these pure calculations with the offshore
 * Worker. None imports runtime code: Plan Your Day's existing polar lookup,
 * saved-route distances, and incoming-leg sailing statistics cannot load a router. */
const SAFE_ENGINE_LEAVES = [...START_UP_LEAVES, ...ROUTE_ENGINE_SHARED_LEAVES];

/** What `entries` reach statically, of the engine's graph and of the router's front doors. */
function routerReach(entries: string[]): string[] {
    return [...staticAppGraph(ROOT, entries, stopAtRouter).keys()].filter(stopAtRouter).sort();
}

const ROOTS = ['components', 'services', 'utils', 'hooks', 'stores', 'pages', 'context', 'contexts', 'src'];

function sourceFiles(dir: string, out: string[] = []): string[] {
    let entries: string[] = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const entry of entries) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) sourceFiles(p, out);
        else if (/\.(ts|tsx)$/.test(p) && !/\.test\.|\.spec\./.test(p)) out.push(p.split(sep).join('/'));
    }
    return out;
}

/** Code without its comments: the explanations name the modules on purpose. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const read = (path: string) => readFileSync(path, 'utf8');

const files = [...ROOTS.flatMap((root) => sourceFiles(root)), 'App.tsx', 'ApplicationShell.tsx', 'index.tsx']
    .filter((path, i, all) => all.indexOf(path) === i)
    .map((path) => ({ path, text: code(read(path)) }));

/** The names services/savedTraceStore.ts exports. */
const LIBRARY = [
    ...read('services/savedTraceStore.ts').matchAll(/^export (?:function|interface|const|type) (\w+)/gm),
].map((m) => m[1]);

describe('the app starts without the router (131-04)', () => {
    it('finds what it guards', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(ENGINE.has('services/routing/routeJob.ts')).toBe(true);
        expect(ENGINE.has('services/engine/navGrid.ts')).toBe(true);
        expect(LIBRARY).toEqual(
            expect.arrayContaining(['loadSavedTraces', 'saveTrace', 'bankTraceVerification', 'deleteTrace']),
        );
        expect(LIBRARY.length).toBeGreaterThanOrEqual(38);
    });

    it("the start-up (index.tsx and the app shell) reaches only the engine's three leaves, and no router", () => {
        expect(routerReach(['index.tsx', APP_SHELL_ENTRY])).toEqual(START_UP_LEAVES);
        // Walking the app's import graph takes seconds; under coverage on a two-core runner it overran 5 s.
    }, 60_000);

    it('those leaves import nothing of the engine for a value, so the router cannot ride in with them', () => {
        for (const leaf of SAFE_ENGINE_LEAVES.filter((f) => f !== 'utils/createLogger.ts')) {
            expect(ENGINE.get(leaf)?.imports, leaf).toEqual([]);
        }
    });

    it('the build is told which module the start-up is (the chunk rule reads it by name)', () => {
        expect(APP_SHELL_ENTRY).toBe('ApplicationShell.tsx');
        expect(existsSync(join(ROOT, APP_SHELL_ENTRY))).toBe(true);
        expect(code(read('index.tsx'))).toContain("React.lazy(() => import('./ApplicationShell'))");
    });

    it("the saved-route library brings no engine: from the tracer it takes the point's type, and only that", () => {
        expect(routerReach(['services/savedTraceStore.ts'])).toEqual(START_UP_LEAVES);
        const store = code(read('services/savedTraceStore.ts'));
        expect([...store.matchAll(/from '\.\/routeTracer'/g)]).toHaveLength(1);
        expect(store).toContain("import type { TracePoint } from './routeTracer';");
    }, 60_000);

    it('the shell services and screens that read the library reach no router', () => {
        // The ones a launch or a skipper's everyday use loads: the account sync
        // and its check recovery (every signed-in launch), the background
        // check queue, Cast Off and its follow, the Log, the Vessel page,
        // Plan Your Day, crew passages and the trip sheet.
        for (const module of [
            'services/savedRoutesSync.ts',
            'services/traceCheckRecovery.ts',
            'services/traceBackgroundCheck.ts',
            'services/castOffHandoff.ts',
            'services/shiplog/followCastOffRoute.ts',
            'services/dayPlanner/todayLoader.ts',
            'pages/LogPage.tsx',
            'components/vessel/CastOffPanel.tsx',
            'components/VesselHub.tsx',
            'components/dayPlanner/TodaySheet.tsx',
            'components/CrewManagement.tsx',
            'components/passage/TripSheet.tsx',
        ]) {
            expect(
                routerReach([module]).filter((f) => !SAFE_ENGINE_LEAVES.includes(f)),
                module,
            ).toEqual([]);
        }
    }, 60_000);
});

describe('the library has one home (131-04)', () => {
    it('routeTracer neither defines nor re-exports a library name', () => {
        const tracer = code(read('services/routeTracer.ts'));
        for (const name of LIBRARY) {
            expect(tracer, name).not.toMatch(new RegExp(`export (?:function|interface|const|type) ${name}\\b`));
        }
        const reexports = [...tracer.matchAll(/export \{([^}]*)\} from '\.\/savedTraceStore'/g)];
        expect(reexports).toEqual([]);
    });

    it('no module imports a library name from the tracer', () => {
        const offenders: string[] = [];
        for (const f of files) {
            for (const m of f.text.matchAll(
                /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'[./]*(?:services\/)?routeTracer'/g,
            )) {
                const names = m[1].split(',').map(
                    (n) =>
                        n
                            .replace(/\btype\b/, '')
                            .trim()
                            .split(/\s+as\s+/)[0],
                );
                for (const name of names) if (LIBRARY.includes(name)) offenders.push(`${f.path}: ${name}`);
            }
            for (const m of f.text.matchAll(
                /const\s*\{([^}]*)\}\s*=\s*await import\('[./]*(?:services\/)?routeTracer'\)/g,
            )) {
                for (const name of m[1].split(',').map((n) => n.trim().split(/\s*:\s*/)[0]))
                    if (LIBRARY.includes(name)) offenders.push(`${f.path}: ${name} (dynamic)`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('the Lighthouse byte line comes down with it (131-04)', () => {
    it('total-byte-weight is 800,000 B, ratcheted from 900,000 with the reason beside it', () => {
        const config = createRequire(import.meta.url)('../lighthouserc.cjs');
        expect(config.ci.assert.assertions['total-byte-weight']).toEqual(['error', { maxNumericValue: 800000 }]);
        const source = read('lighthouserc.cjs');
        expect(source).toContain('// 800000, was 900000 (2026-10-15, build 131, 131-04).');
        expect(source).toMatch(/NOT\s+\/\/ measured by Lighthouse yet/);
    });
});

describe("the Log's route report loads when it opens (131-04)", () => {
    it('LogPage reaches it through lazyRetry and a Suspense, never statically', () => {
        const log = code(read('pages/LogPage.tsx'));
        expect(log.replace(/\s+/g, ' ')).toContain(
            "const TraceReportModal = lazyRetry( () => import('../components/map/TraceReportModal').then((m) => ({ default: m.TraceReportModal })), 'TraceReportModal_Log', );",
        );
        expect(log).toMatch(/<Suspense fallback=\{null\}>\s*<TraceReportModal/);
    });

    it('no app module imports the route report statically', () => {
        const importers = files
            .filter((f) => /^\s*import\s+(?!type\b)[^;]*?from\s+['"][^'"]*\/TraceReportModal['"]/m.test(f.text))
            .map((f) => f.path);
        expect(importers).toEqual([]);
    });
});
