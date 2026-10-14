// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAst, transformWithEsbuild } from 'vite';

import { insertAt, markNoopLogCalls, stripNoopLogs } from '../scripts/strip-noop-logs.mjs';

/**
 * 129-10: production builds drop the app logger's info() and debug() calls,
 * which createLogger makes a no-op when import.meta.env.PROD is true. The
 * calls are marked pure, so the minifier removes them and keeps any argument
 * that could have a side effect. These pin what is marked, what is never
 * marked, that removal keeps behaviour, and that the call really did nothing.
 */

const ROOT = '/app';
const FILE = `${ROOT}/services/Example.ts`;
const mark = (code: string, id = FILE) => markNoopLogCalls(code, id, { parse: parseAst, root: ROOT });
// treeShaking: as Rollup does across the build, drop what nothing uses.
const minify = async (code: string) =>
    (await transformWithEsbuild(code, 'x.js', { minify: true, format: 'esm', treeShaking: true })).code;

const MODULE = `import { createLogger } from '../utils/createLogger';
const log = createLogger('Example');
export function load(items, fetchMore) {
    log.info('[Example] loaded', items.length, fetchMore());
    log.debug(\`first \${items[0]}\`);
    log.warn('slow link');
    log.error('failed', new Error('x'));
    return items;
}
`;

describe('markNoopLogCalls', () => {
    it("marks the app logger's info and debug calls pure, and nothing else", () => {
        const result = mark(MODULE);
        expect(result?.calls).toBe(2);
        expect(result?.code).toContain("/* @__PURE__ */ log.info('[Example] loaded'");
        expect(result?.code).toContain('/* @__PURE__ */ log.debug(`first');
        expect(result?.code).toContain("    log.warn('slow link');");
        expect(result?.code).toContain("    log.error('failed'");
        expect(result?.code).toContain("const log = /* @__PURE__ */ createLogger('Example');");
    });

    it('minified, the messages go and every argument with a side effect still runs', async () => {
        const out = await minify(mark(MODULE)?.code ?? '');
        expect(out).not.toContain('loaded');
        expect(out).not.toContain('first');
        expect(out).not.toMatch(/\.info\(|\.debug\(/);
        // fetchMore() is still called, items.length still read (a getter could throw).
        expect(out).toMatch(/fetchMore\(\)|\w\(\)/);
        expect(out).toMatch(/\.length/);
        expect(out).toContain('slow link');
        expect(out).toContain('failed');
    });

    it('accepts the @ alias and the route engine copy (a ?query id)', () => {
        expect(mark(MODULE.replace('../utils/createLogger', '@/utils/createLogger'))?.calls).toBe(2);
        expect(mark(MODULE, `${FILE}?route-engine-logger`)?.calls).toBe(2);
        expect(mark(MODULE.replace('../utils/createLogger', '../utils/createLogger.ts'))?.calls).toBe(2);
    });

    it("leaves another package's createLogger alone (pi-cache has its own)", () => {
        expect(
            mark(MODULE.replace('../utils/createLogger', '../../utils/createLogger.js'), `${ROOT}/pi-cache/src/x/y.ts`),
        ).toBeNull();
        expect(mark(MODULE.replace('../utils/createLogger', 'some-logger'))).toBeNull();
        expect(mark(MODULE, `${ROOT}/node_modules/pkg/index.js`)).toBeNull();
    });

    it('leaves a file alone when the logger name is bound anywhere else', () => {
        for (const shadow of [
            'function inner(log) { log.info("param"); }',
            'try { x(); } catch (log) { log.info("caught"); }',
            'const run = () => { const log = makeOther(); log.info("local"); };',
            'function pick(other) { const { log } = other; return log; }',
        ]) {
            expect(mark(MODULE.replace('export function load', `${shadow}\nexport function load`)), shadow).toBeNull();
        }
    });

    it('leaves let bindings, renamed method calls and optional calls alone', () => {
        expect(mark(MODULE.replace('const log =', 'let log ='))).toBeNull();
        const code = MODULE.replace(
            "log.info('[Example] loaded', items.length, fetchMore());",
            "log['info']('x'); log.info?.('y');",
        );
        expect(mark(code)?.calls).toBe(1);
        expect(mark(code)?.code).toContain("log['info']('x'); log.info?.('y');");
    });

    it('keeps every token mapped to its own column (Sentry stack traces)', () => {
        const { code, map } = insertAt('a; log.info(x); b.c(d);\nnext();', [3], '/* @__PURE__ */ ', 'x.js');
        expect(code).toBe('a; /* @__PURE__ */ log.info(x); b.c(d);\nnext();');
        const decoded = decodeMappings(map.mappings);
        const at = (line: number, generatedColumn: number) =>
            decoded[line].filter((segment) => segment[0] <= generatedColumn).at(-1)?.[3];
        expect(at(0, code.indexOf('log'))).toBe(3);
        expect(at(0, code.indexOf('b.c'))).toBe('a; log.info(x); b.c(d);'.indexOf('b.c'));
        expect(at(1, 0)).toBe(0);
        expect(map.sources).toEqual(['x.js']);
    });
});

describe('stripNoopLogs in the build', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('a real production build drops the calls and an unused logger, and keeps warn and side effects', async () => {
        const root = '/virtual-app';
        const files: Record<string, string> = {
            [`${root}/main.ts`]:
                "import { load } from './services/Example';\nimport { quiet } from './services/Quiet';\n" +
                "import { interp } from './services/Interp';\nexport { load, quiet, interp };\n",
            [`${root}/services/Example.ts`]: MODULE,
            [`${root}/services/Quiet.ts`]: `import { createLogger } from '../utils/createLogger';
const log = createLogger('QuietTag');
export const quiet = () => { log.info('only info'); return 1; };
`,
            // Rollup's purity model, pinned: a bare interpolation, String(x) and
            // x + 1 count as side-effect free, so those calls go whole and the
            // value's toString / valueOf no longer runs; a call still runs.
            [`${root}/services/Interp.ts`]: `import { createLogger } from '../utils/createLogger';
const log = createLogger('InterpTag');
export const interp = (value, counter) => {
    log.debug(\`D1 \${value}\`);
    log.info('O1', String(value));
    log.info('Q1', value + 1);
    log.info('C1', counter.hit());
    return 2;
};
`,
            [`${root}/utils/createLogger.ts`]: readFileSync(join(process.cwd(), 'utils/createLogger.ts'), 'utf8'),
            [`${root}/services/sentry.ts`]:
                'export const captureException = () => {};\nexport const addBreadcrumb = () => {};\n',
        };
        // Vite's build is production (import.meta.env.PROD, config.isProduction)
        // only when NODE_ENV says so; vitest runs with NODE_ENV=test.
        vi.stubEnv('NODE_ENV', 'production');
        const { build } = await import('vite');
        const result = (await build({
            configFile: false,
            logLevel: 'silent',
            root: process.cwd(),
            plugins: [
                {
                    name: 'virtual-app',
                    enforce: 'pre',
                    resolveId(source, importer) {
                        const base = source.startsWith('/')
                            ? source
                            : importer
                              ? posix.join(importer, '..', source)
                              : source;
                        for (const candidate of [base, `${base}.ts`]) if (files[candidate]) return candidate;
                        return null;
                    },
                    load(id) {
                        return files[id] ?? null;
                    },
                },
                stripNoopLogs(root),
            ],
            build: {
                write: false,
                minify: 'esbuild',
                rollupOptions: {
                    input: `${root}/main.ts`,
                    output: { inlineDynamicImports: true },
                    preserveEntrySignatures: 'strict',
                },
            },
        })) as { output: { type: string; code?: string }[] };
        const code = result.output
            .filter((item) => item.type === 'chunk')
            .map((item) => item.code)
            .join('\n');
        expect(code).not.toContain('[Example] loaded');
        expect(code).not.toContain('only info');
        expect(code).not.toContain('QuietTag');
        expect(code).toContain('slow link');
        // The arguments that could have side effects still run.
        expect(code).toMatch(/\.length,\w\(\)/);
        // And this was the production logger: IS_PROD compiles to
        // `typeof import.meta<"u"&&!0`, true in every module, so info() is the no-op.
        expect(code).toContain('typeof import.meta<"u"&&!0');

        // Run the built module: no app value defines toString, valueOf or
        // Symbol.toPrimitive today (git grep), so none of this changes behaviour.
        const built = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
            interp: (value: unknown, counter: { hit: () => number }) => number;
        };
        let conversions = 0;
        let calls = 0;
        const value = {
            toString: () => String(++conversions),
            valueOf: () => ++conversions,
        };
        expect(built.interp(value, { hit: () => ++calls })).toBe(2);
        expect(conversions).toBe(0);
        expect(calls).toBe(1);
    }, 30000);

    it('vite.config.ts wires it, and it only runs for production builds', () => {
        const config = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
        expect(config).toContain("import { stripNoopLogs } from './scripts/strip-noop-logs.mjs';");
        expect(config).toMatch(/\n\s+stripNoopLogs\(__dirname\),/);
        const plugin = stripNoopLogs(ROOT) as unknown as {
            apply: string;
            configResolved: (config: { isProduction: boolean }) => void;
            transform: (this: { parse: typeof parseAst }, code: string, id: string) => unknown;
        };
        expect(plugin.apply).toBe('build');
        const context = { parse: parseAst };
        plugin.configResolved({ isProduction: false });
        expect(plugin.transform.call(context, MODULE, FILE)).toBeNull();
        plugin.configResolved({ isProduction: true });
        expect(plugin.transform.call(context, MODULE, FILE)).toMatchObject({
            code: expect.stringContaining('@__PURE__'),
        });
    });

    it('in production, info() and debug() are the one no-op: no console, no Sentry, nothing kept', async () => {
        vi.stubEnv('PROD', true);
        vi.resetModules();
        const consoleSpies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((method) =>
            vi.spyOn(console, method).mockImplementation(() => {}),
        );
        const { createLogger } = await import('../utils/createLogger');
        const log = createLogger('Prod');
        const other = createLogger('Other');
        expect(log.info).toBe(log.debug);
        expect(log.info).toBe(other.info);
        expect(log.info('a', { b: 1 })).toBeUndefined();
        log.debug('c');
        for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
        // warn still reaches the console in production.
        log.warn('kept');
        expect(consoleSpies[3]).toHaveBeenCalledWith('[Prod]', 'kept');
    });
});

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Source map v3 mappings, absolute: [generatedColumn, source, line, column] per segment. */
function decodeMappings(mappings: string): number[][][] {
    const state = [0, 0, 0, 0];
    return mappings.split(';').map((line) => {
        state[0] = 0;
        if (!line) return [];
        return line.split(',').map((segment) => {
            const values: number[] = [];
            let value = 0;
            let shift = 0;
            for (const char of segment) {
                const digit = BASE64.indexOf(char);
                value += (digit & 31) << shift;
                if (digit & 32) {
                    shift += 5;
                } else {
                    values.push(value & 1 ? -(value >> 1) : value >> 1);
                    value = 0;
                    shift = 0;
                }
            }
            values.forEach((delta, index) => (state[index] += delta));
            return [...state];
        });
    });
}
