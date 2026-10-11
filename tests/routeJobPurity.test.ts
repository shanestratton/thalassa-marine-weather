/**
 * The route job's graph is safe to run in a worker, and holds no IO
 * (127-ROUTE-W; the o-charts ruling of 2026-10-10: chart cells may sit in a
 * worker's memory, and nothing it holds is ever written anywhere).
 *
 * services/routing/routeJob.ts and everything it imports for its values is
 * the `router-engine` chunk, which is also the route worker's script. This
 * walks that graph from the source (scripts/route-job-closure.mjs, the same
 * walk the build uses to give the job its own logger) and holds it to:
 *   - only the router: the modules the Pi mirrors (sync-router-engine), the
 *     Seaway graph (services/seaway/*), and the job, its sample helper and the
 *     logger;
 *   - no storage or network API, no Capacitor plugin, no DOM (use of the
 *     globals, not the bare words: tideCeiling.ts and fairlead.ts name a
 *     parameter `window`);
 *   - no dynamic import, except the app logger's lazy Sentry import, which the
 *     build replaces in the job's copy (vite.config.ts routeEngineLogger) —
 *     so that copy must never be asked to report: no logger error() anywhere.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_JOB_ENTRY, ROUTE_JOB_LOGGER, routeJobClosure } from '../scripts/route-job-closure.mjs';

const ROOT = process.cwd();
const MIRROR = join(ROOT, 'pi-cache/src/routerEngine');

function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) files(path, out);
        else out.push(relative(MIRROR, path).split('\\').join('/'));
    }
    return out;
}

/** The engine modules the Pi mirrors (pi-cache/scripts/sync-router-engine.mjs writes them at the app's paths). */
const MIRRORED = new Set(files(MIRROR).filter((f) => f !== 'syncedFrom.ts'));
const JOB_OWN = new Set([ROUTE_JOB_ENTRY, 'services/routing/backstopSamples.ts', ROUTE_JOB_LOGGER]);

function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

const GLOBALS = ['window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'fetch'];
/** Uses of a browser global: a member or index (`window.x`), a call (`fetch(`), or `typeof window`. */
function globalUses(code: string): string[] {
    const hits: string[] = [];
    for (const name of GLOBALS) {
        const use = new RegExp(`(?<![\\w$.])${name}\\s*(?:\\.|\\[|\\()|\\btypeof\\s+${name}\\b`, 'g');
        for (const m of code.matchAll(use)) hits.push(m[0].replace(/\s+/g, ' '));
    }
    if (/\bFilesystem\b/.test(code)) hits.push('Filesystem');
    return hits;
}

/** Names bound to a logger (createLogger, and `x as y` renames of them). */
function loggerErrorCalls(sources: Map<string, string>): string[] {
    const names = new Set<string>();
    for (const code of sources.values())
        for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*createLogger\(/g))
            names.add(m[1]);
    for (let grew = true; grew; ) {
        grew = false;
        for (const code of sources.values())
            for (const m of code.matchAll(/\b(\w+)\s+as\s+(\w+)\b/g))
                if (names.has(m[1]) && !names.has(m[2])) {
                    names.add(m[2]);
                    grew = true;
                }
    }
    const hits: string[] = [];
    for (const [file, code] of sources) {
        if (/createLogger\([^)]*\)\s*\.\s*error\b/.test(code)) hits.push(`${file}: createLogger(...).error`);
        for (const name of names)
            for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\.\\s*error\\s*\\(`, 'g')))
                hits.push(`${file}:${code.slice(0, m.index).split('\n').length}: ${m[0]}`);
    }
    return hits;
}

describe("the route job's graph", () => {
    const closure = routeJobClosure(ROOT) as Map<
        string,
        { source: string; imports: string[]; packages: string[]; dynamic: string[] }
    >;
    const sources = new Map([...closure].map(([file, m]) => [file, stripComments(m.source)]));

    it('starts at the job and reaches the engine, the shadows and the job’s own modules', () => {
        expect(closure.has(ROUTE_JOB_ENTRY)).toBe(true);
        for (const f of [
            'services/inshoreRouterEngine.ts',
            'services/engine/navGrid.ts',
            'services/seaway/seawayRouter.ts',
            'services/seaway/leadGraphSearch.ts',
            'services/routing/backstopSamples.ts',
        ])
            expect(closure.has(f), f).toBe(true);
    });

    it('is only the router: mirrored engine modules, the Seaway graph and the job’s own three', () => {
        const strays = [...closure.keys()].filter(
            (f) => !MIRRORED.has(f) && !f.startsWith('services/seaway/') && !JOB_OWN.has(f),
        );
        expect(strays).toEqual([]);
    });

    it('imports no package (the engine reads only geojson types, which erase)', () => {
        expect([...closure].flatMap(([f, m]) => m.packages.map((p) => `${f}: ${p}`))).toEqual([]);
    });

    it('uses no storage, network, DOM or Capacitor API', () => {
        const hits = [...sources].flatMap(([f, code]) => globalUses(code).map((h) => `${f}: ${h}`));
        const capacitor = [...closure].flatMap(([f, m]) =>
            [...m.imports, ...m.packages].filter((s) => s.includes('@capacitor/')).map((s) => `${f}: ${s}`),
        );
        expect([...hits, ...capacitor]).toEqual([]);
    });

    it('has no dynamic import, but the app logger’s lazy Sentry import the build stubs out', () => {
        const dynamic = [...closure].flatMap(([f, m]) => m.dynamic.map((d) => `${f}: import(${d})`));
        expect(dynamic).toEqual([`${ROUTE_JOB_LOGGER}: import(../services/sentry)`]);
    });

    it('never calls a logger’s error()', () => {
        expect(loggerErrorCalls(sources)).toEqual([]);
    });

    it('the rules would catch a global, a bare word passes, and an error() call is found', () => {
        expect(globalUses('const w = window.innerWidth;')).toEqual(['window.']);
        expect(globalUses("const r = await fetch('/x');")).toEqual(['fetch(']);
        expect(globalUses("if (typeof document !== 'undefined') {}")).toEqual(['typeof document']);
        expect(globalUses('localStorage["k"]')).toEqual(['localStorage[']);
        // tideCeiling.ts / fairlead.ts: a parameter named `window`.
        expect(globalUses('function f(window = 11) { const [a] = window; return window >> 1; }')).toEqual([]);
        expect(globalUses('x.fetch(1); refetch(2)')).toEqual([]);
        const probe = new Map([
            ['a.ts', "const log = createLogger('A');\nexport { log as engineLog };\n"],
            ['b.ts', "engineLog.warn('fine');\nengineLog.error('boom');\n"],
        ]);
        expect(loggerErrorCalls(probe)).toEqual(['b.ts:2: engineLog.error(']);
    });
});
