import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Worker builds resolve createLogger's lazy `import('../services/sentry')` to
 * no-op functions (vite.config.ts `workerSentryNoop`, 2026-10-05). Before, the
 * navGrid worker carried its own copy of the Sentry SDK, React's Sentry
 * bindings and @capacitor/core, about 97 KB that could never run: the worker
 * graph only calls a logger's warn(), and only error() reaches Sentry.
 *
 * That stays free only while no worker calls a logger's error(). This guard
 * walks every module worker's import graph and fails if a logger's error() is
 * called there, or if a logger is passed somewhere it could be. A worker
 * error that needs reporting should be posted back to the main thread, whose
 * Sentry is untouched.
 */
const ROOT = process.cwd();
const read = (path: string) => readFileSync(path, 'utf8');
const rel = (path: string) => relative(ROOT, path);
const APP_DIRS = ['components', 'hooks', 'services', 'src', 'stores', 'utils', 'modules', 'managers', 'pages'];
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.mjs'];

function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
    }
}

function appSource(): string[] {
    const out: string[] = [];
    for (const dir of APP_DIRS) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir), out);
    return out;
}

function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

function resolveImport(from: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
    else if (specifier.startsWith('@/')) base = join(ROOT, specifier.slice(2));
    else return null; // npm package: not app code
    if (existsSync(base) && statSync(base).isFile()) return base;
    for (const ext of EXTENSIONS) if (existsSync(base + ext)) return base + ext;
    return null;
}

/** Runtime imports only: `import type` / `export type` are erased. */
function importsOf(code: string): string[] {
    const specs: string[] = [];
    const statements = /(?:^|[;\n])\s*(import|export)\s+(?!type\b)(?:[\w*\s{},$]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    for (const match of code.matchAll(statements)) specs.push(match[2]);
    for (const match of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
    return specs;
}

/** Worker entry specifiers in one file: `new (Shared)Worker(new URL(...))` and Vite's `?worker` imports. */
function workerSpecifiers(code: string): string[] {
    const specs: string[] = [];
    const constructed = /new (?:Shared)?Worker\(\s*new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    for (const match of code.matchAll(constructed)) specs.push(match[1]);
    const imported = /\b(?:import|from)\s*\(?\s*['"]([^'"?]+)\?(?:shared)?worker(?:&[^'"]*)?['"]/g;
    for (const match of code.matchAll(imported)) specs.push(match[1]);
    return specs;
}

function workerEntries(): string[] {
    const entries = new Set<string>();
    for (const file of appSource()) {
        for (const specifier of workerSpecifiers(read(file))) {
            const target = resolveImport(file, specifier);
            if (target) entries.add(target);
        }
    }
    return [...entries].sort();
}

function importGraph(entry: string): string[] {
    const seen = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.shift()!;
        for (const specifier of importsOf(stripComments(read(file)))) {
            const target = resolveImport(file, specifier);
            if (target && !seen.has(target)) {
                seen.add(target);
                queue.push(target);
            }
        }
    }
    return [...seen];
}

const graphSources = (graph: string[]) => new Map(graph.map((file) => [file, stripComments(read(file))]));

/** Every way a logger could reach error() inside one worker graph (file -> comment-free code). */
function loggerErrorPaths(sources: Map<string, string>): string[] {
    const names = new Set<string>();
    for (const code of sources.values()) {
        for (const match of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*createLogger\(/g))
            names.add(match[1]);
    }
    // Follow `import { engineLog as log }` renames until nothing new appears.
    for (let grew = true; grew; ) {
        grew = false;
        for (const code of sources.values()) {
            for (const match of code.matchAll(/\b(\w+)\s+as\s+(\w+)\b/g)) {
                if (names.has(match[1]) && !names.has(match[2])) {
                    names.add(match[2]);
                    grew = true;
                }
            }
        }
    }

    const offenders: string[] = [];
    for (const [file, code] of sources) {
        if (/createLogger\([^)]*\)\s*\.\s*error\b/.test(code)) offenders.push(`${rel(file)}: createLogger(...).error`);
        const specifierLists = [...code.matchAll(/\b(?:import|export)\s*\{[^}]*\}/g)].map((m) => [
            m.index!,
            m.index! + m[0].length,
        ]);
        for (const name of names) {
            for (const match of code.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g'))) {
                const at = match.index!;
                if (specifierLists.some(([start, end]) => at >= start && at < end)) continue;
                if (/\b(?:const|let|var)\s+$/.test(code.slice(Math.max(0, at - 12), at))) continue;
                const after = code.slice(at + name.length, at + name.length + 24);
                if (/^\s*\.\s*(?:warn|info|debug)\s*\(/.test(after)) continue;
                const line = code.slice(0, at).split('\n').length;
                offenders.push(`${rel(file)}:${line}: ${name}${after.split('\n')[0]}`);
            }
        }
    }
    return offenders;
}

describe('workers ship without a second Sentry SDK', () => {
    const viteConfig = read(join(ROOT, 'vite.config.ts'));
    const entries = workerEntries();

    it('wires the no-op into worker builds only', () => {
        expect(viteConfig).toMatch(
            /worker:\s*\{\s*format:\s*'es',\s*plugins:\s*\(\)\s*=>\s*\[workerSentryNoop\(\)\],?\s*\}/,
        );
        // Defined once, used once: never in the main build's plugin list.
        expect(viteConfig.match(/(?<!function )\bworkerSentryNoop\(\)/g)).toHaveLength(1);
    });

    it("matches createLogger's own Sentry import", () => {
        const declared = viteConfig.match(/export const LOGGER_SENTRY_IMPORT = '([^']+)';/)?.[1];
        expect(declared).toBe('../services/sentry');
        expect(read(join(ROOT, 'utils/createLogger.ts'))).toContain(`import('${declared}')`);
    });

    it('finds the module workers and the logger the no-op exists for', () => {
        expect(entries.map(rel)).toEqual(
            expect.arrayContaining([
                'services/engine/navGridWorker.ts',
                'services/enc/encGeometryWorker.ts',
                'services/enc/encParseWorker.ts',
            ]),
        );
        const withLogger = entries.filter((entry) =>
            importGraph(entry).some((f) => rel(f) === 'utils/createLogger.ts'),
        );
        // If no worker reaches createLogger any more, remove workerSentryNoop from vite.config.ts.
        expect(withLogger.map(rel)).toContain('services/engine/navGridWorker.ts');
    });

    it.each(entries.map((entry) => [rel(entry), entry]))('%s never calls a logger error()', (_name, entry) => {
        expect(loggerErrorPaths(graphSources(importGraph(entry)))).toEqual([]);
    });

    it('would catch an error() call, a renamed logger or a logger handed elsewhere', () => {
        const navGridWorker = entries.find((entry) => rel(entry) === 'services/engine/navGridWorker.ts')!;
        const sources = graphSources(importGraph(navGridWorker));
        const navGrid = join(ROOT, 'services/engine/navGrid.ts');
        expect(sources.has(navGrid)).toBe(true);
        sources.set(
            navGrid,
            `${sources.get(navGrid)}\nengineLog.error('boom');\nreport(engineLog);\n` +
                `import { engineLog as log } from './constants';\nlog.error('renamed');\n`,
        );
        const offenders = loggerErrorPaths(sources);
        expect(offenders).toHaveLength(3);
        expect(offenders.join('\n')).toMatch(/engineLog\.error/);
        expect(offenders.join('\n')).toMatch(/engineLog\)/);
        expect(offenders.join('\n')).toMatch(/log\.error/);
    });

    it('would catch a let-declared logger calling error()', () => {
        const sources = new Map([
            ['probe.ts', "import { createLogger } from './createLogger';\nlet probeLog = createLogger('Probe');\n"],
            ['use.ts', "probeLog.warn('fine');\nprobeLog.error('boom');\n"],
        ]);
        expect(loggerErrorPaths(sources)).toEqual([expect.stringMatching(/probeLog\.error/)]);
    });

    it("finds workers spawned with new URL or imported with Vite's ?worker", () => {
        const code = [
            "const a = new Worker(new URL('./a.ts', import.meta.url), { type: 'module' });",
            "const b = new SharedWorker(new URL('./b.ts', import.meta.url));",
            "import CWorker from './c.ts?worker';",
            "import DWorker from './d?worker&inline';",
            "const E = await import('./e.ts?worker');",
            "import url from './f.ts?url';",
        ].join('\n');
        expect(workerSpecifiers(code)).toEqual(['./a.ts', './b.ts', './c.ts', './d', './e.ts']);
    });
});
