/**
 * The build's half of "the engine chunk IS the worker" (127-ROUTE-W):
 * scripts/route-job-closure.mjs, which vite.config.ts uses for its
 * manualChunks rule and for the route job's own logger copy. The built chunk
 * itself is checked by e2e/route-worker.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    ROUTE_ENGINE_LOGGER_QUERY,
    routeEngineChunkOf,
    routeEngineLoggerSource,
    routeJobClosure,
} from '../scripts/route-job-closure.mjs';

const ROOT = process.cwd();

/** A fake Rollup graph: id -> [static imports, lazy imports], entries marked. */
function meta(graph: Record<string, [string[], string[]?]>, entries: string[]) {
    const info = new Map(
        Object.entries(graph).map(([id, [importedIds, lazy = []]]) => [
            id,
            { importedIds, dynamicallyImportedIds: lazy, isEntry: entries.includes(id) },
        ]),
    );
    return { getModuleIds: () => info.keys(), getModuleInfo: (id: string) => info.get(id) ?? null };
}

const JOB = '/repo/services/routing/routeJob.ts';

describe('the router-engine chunk', () => {
    it("is the job's whole static closure; what another entry also loads goes to engine-leaf", () => {
        const m = meta(
            {
                '/repo/index.html': [['/repo/index.tsx']],
                '/repo/index.tsx': [['/repo/services/enc/types.ts'], ['/repo/ApplicationShell.tsx']],
                '/repo/ApplicationShell.tsx': [['/repo/services/InshoreRouter.ts']],
                '/repo/services/InshoreRouter.ts': [[JOB]],
                [JOB]: [['/repo/services/inshoreRouterEngine.ts', '/repo/utils/createLogger.ts?route-engine']],
                '/repo/services/inshoreRouterEngine.ts': [
                    ['/repo/services/engine/navGrid.ts', '/repo/services/enc/types.ts'],
                ],
                '/repo/services/engine/navGrid.ts': [[]],
                '/repo/services/enc/types.ts': [[]],
                '/repo/utils/createLogger.ts?route-engine': [[]],
                '/repo/ocean.html': [['/repo/ocean.tsx']],
                '/repo/ocean.tsx': [[], ['/repo/services/engine/navGridLazyUser.ts']],
                '/repo/services/engine/navGridLazyUser.ts': [['/repo/services/engine/navGrid.ts']],
            },
            ['/repo/index.html', '/repo/ocean.html'],
        );
        const chunk = (id: string) => routeEngineChunkOf(id, m);
        expect(chunk(JOB)).toBe('router-engine');
        expect(chunk('/repo/services/inshoreRouterEngine.ts')).toBe('router-engine');
        expect(chunk('/repo/utils/createLogger.ts?route-engine')).toBe('router-engine');
        // The legal boot shell imports it statically: a leaf.
        expect(chunk('/repo/services/enc/types.ts')).toBe('engine-leaf');
        // Another entry reaches it, even lazily: a leaf, so that page never loads the router.
        expect(chunk('/repo/services/engine/navGrid.ts')).toBe('engine-leaf');
        // Not the router's: Rollup decides as before.
        expect(chunk('/repo/services/InshoreRouter.ts')).toBeUndefined();
        expect(chunk('/repo/ApplicationShell.tsx')).toBeUndefined();
    });

    it("fails the build when the job's closure reaches the app's logger, a package or a virtual module", () => {
        for (const stray of [
            '/repo/utils/createLogger.ts',
            '/repo/node_modules/react/index.js',
            '\0vite/preload-helper.js',
        ]) {
            const m = meta({ '/repo/index.html': [[JOB]], [JOB]: [[stray]], [stray]: [[]] }, ['/repo/index.html']);
            expect(() => routeEngineChunkOf(JOB, m), stray).toThrow(/route worker cannot load/);
        }
    });

    it('does nothing in a graph without the job', () => {
        const m = meta({ '/repo/index.html': [['/repo/a.ts']], '/repo/a.ts': [[]] }, ['/repo/index.html']);
        expect(routeEngineChunkOf('/repo/a.ts', m)).toBeUndefined();
    });
});

describe("the route job's own logger copy", () => {
    const logger = readFileSync('utils/createLogger.ts', 'utf8');

    it('is the app logger with its lazy Sentry import stubbed, so the chunk imports nothing', () => {
        const copy = routeEngineLoggerSource(logger, '../services/sentry');
        expect(copy).not.toContain('import(');
        expect(copy).toContain('Promise.resolve({ captureException() {}, addBreadcrumb() {} })');
        expect(
            copy.replace(
                'Promise.resolve({ captureException() {}, addBreadcrumb() {} })',
                "import('../services/sentry')",
            ),
        ).toBe(logger);
        expect(ROUTE_ENGINE_LOGGER_QUERY).toBe('?route-engine');
    });

    it('refuses a logger that no longer says the import it replaces', () => {
        expect(() => routeEngineLoggerSource('export const x = 1;', '../services/sentry')).toThrow(/no longer says/);
    });

    it("is what every module of the job's source graph gets (the walk the build uses)", () => {
        const closure = routeJobClosure(ROOT) as Map<string, { imports: string[] }>;
        const importers = [...closure].filter(([, m]) => m.imports.includes('utils/createLogger.ts')).map(([f]) => f);
        expect(importers).toEqual(
            expect.arrayContaining(['services/routing/routeJob.ts', 'services/engine/constants.ts']),
        );
    });
});
