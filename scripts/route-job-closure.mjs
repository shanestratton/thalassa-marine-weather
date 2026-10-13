/**
 * The route job's module closure, read from the source (127-ROUTE-W).
 *
 * services/routing/routeJob.ts is the one routing job: the engine, its two
 * shadows, the Seaway promotion and the result. In the production build its
 * static import closure is one chunk, `router-engine`, and that chunk is also
 * the route worker's script (vite.config.ts routeEngineChunkOf). So the same
 * closure must be safe to load in a worker, and tests/routeJobPurity.test.ts
 * walks it with this function.
 *
 * Read like the Pi mirror's sync script reads the engine
 * (pi-cache/scripts/sync-router-engine.mjs), with one difference: an import
 * that only brings in types (`import type`, or every name marked `type`)
 * erases when TypeScript compiles, so it is not followed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** The job's own module, repo-relative. */
export const ROUTE_JOB_ENTRY = 'services/routing/routeJob.ts';
/** The app logger: the route job's graph gets its own copy of it in the build. */
export const ROUTE_JOB_LOGGER = 'utils/createLogger.ts';

const posix = (p) => p.split(path.sep).join('/');

function resolveSpecifier(repo, fromRel, spec) {
    let base;
    if (spec.startsWith('@/')) base = path.join(repo, spec.slice(2));
    else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(repo, path.dirname(fromRel), spec);
    else return null;
    const stem = base.replace(/\.js$/, '');
    for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return posix(path.relative(repo, candidate));
    }
    throw new Error(`${fromRel} imports '${spec}', which does not resolve to a file`);
}

function importsOf(ts, rel, source) {
    const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const values = [];
    const dynamic = [];
    const onlyTypes = (elements) => elements.length > 0 && elements.every((e) => e.isTypeOnly);
    for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause;
            if (clause?.isTypeOnly) continue;
            if (
                clause &&
                !clause.name &&
                clause.namedBindings &&
                ts.isNamedImports(clause.namedBindings) &&
                onlyTypes(clause.namedBindings.elements)
            )
                continue;
            values.push(statement.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
            if (statement.isTypeOnly) continue;
            if (
                statement.exportClause &&
                ts.isNamedExports(statement.exportClause) &&
                onlyTypes(statement.exportClause.elements)
            )
                continue;
            values.push(statement.moduleSpecifier.text);
        }
    }
    const visit = (node) => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            dynamic.push(arg && ts.isStringLiteralLike(arg) ? arg.text : '<computed>');
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return { values, dynamic };
}

/**
 * Every module routeJob.ts reaches through value imports, as a Map from the
 * repo-relative path to { source, imports (repo-relative), packages, dynamic }.
 */
export function routeJobClosure(repo) {
    const ts = createRequire(path.join(repo, 'package.json'))('typescript');
    const modules = new Map();
    const queue = [ROUTE_JOB_ENTRY];
    while (queue.length > 0) {
        const rel = queue.shift();
        if (modules.has(rel)) continue;
        const source = fs.readFileSync(path.join(repo, rel), 'utf8');
        const { values, dynamic } = importsOf(ts, rel, source);
        const imports = [];
        const packages = [];
        for (const spec of values) {
            const target = resolveSpecifier(repo, rel, spec);
            if (target === null) packages.push(spec);
            else {
                imports.push(target);
                queue.push(target);
            }
        }
        modules.set(rel, { source, imports, packages, dynamic });
    }
    return modules;
}

// ── The build's side (vite.config.ts) ───────────────────────────────

/** The query that names the route job's own copy of the app logger. */
export const ROUTE_ENGINE_LOGGER_QUERY = '?route-engine';

/**
 * The route job's copy of utils/createLogger.ts: the same source, with the
 * lazy Sentry import of error() resolved to no-op functions (as the
 * worker-sentry-noop plugin does for worker builds). Throws if the import is
 * no longer there to replace.
 */
export function routeEngineLoggerSource(source, sentryImport) {
    const lazySentry = `import('${sentryImport}')`;
    if (!source.includes(lazySentry)) throw new Error(`${ROUTE_JOB_LOGGER} no longer says ${lazySentry}`);
    return source.replace(lazySentry, 'Promise.resolve({ captureException() {}, addBreadcrumb() {} })');
}

const clean = (id) => id.replaceAll('\\', '/');
const chunkMemo = new WeakMap();

/**
 * Rollup manualChunks: which of the route job's chunks a module goes in, or
 * undefined. The job's static closure, from the build's own graph
 * (meta.getModuleInfo), is `router-engine`; a module of it that another entry
 * also loads (logs, beta, feedback, ocean, statically or lazily, or the index
 * entry statically: the legal boot shell) is `engine-leaf`, so those pages
 * never load the router. Throws if the closure reaches the app's logger, a
 * package or a virtual module, none of which the route worker can load.
 *
 * @param {string} id
 * @param {{ getModuleIds: () => Iterable<string>, getModuleInfo: (id: string) => ({ importedIds: readonly string[], dynamicallyImportedIds: readonly string[], isEntry: boolean } | null) }} meta
 * @returns {'router-engine' | 'engine-leaf' | undefined}
 */
export function routeEngineChunkOf(id, meta) {
    let chunks = chunkMemo.get(meta.getModuleInfo);
    if (!chunks) {
        chunks = new Map();
        chunkMemo.set(meta.getModuleInfo, chunks);
        const ids = [...meta.getModuleIds()];
        const root = ids.find((m) => clean(m).endsWith(`/${ROUTE_JOB_ENTRY}`));
        const reach = (starts, lazy) => {
            const seen = new Set();
            const queue = [...starts];
            while (queue.length > 0) {
                const next = queue.pop();
                if (seen.has(next)) continue;
                seen.add(next);
                const info = meta.getModuleInfo(next);
                if (!info) continue;
                queue.push(...info.importedIds, ...(lazy ? info.dynamicallyImportedIds : []));
            }
            return seen;
        };
        if (root) {
            const entries = ids.filter((m) => meta.getModuleInfo(m)?.isEntry);
            const indexEntry = entries.filter((m) => clean(m).endsWith('/index.html'));
            const otherEntries = entries.filter((m) => !indexEntry.includes(m));
            const shared = new Set([...reach(otherEntries, true), ...reach(indexEntry, false)]);
            for (const m of reach([root], false)) {
                const c = clean(m);
                if (c.endsWith(`/${ROUTE_JOB_LOGGER}`) || c.includes('/node_modules/') || c.startsWith('\0'))
                    throw new Error(`the route job's closure reaches ${c}, which the route worker cannot load`);
                chunks.set(m, shared.has(m) ? 'engine-leaf' : 'router-engine');
            }
        }
    }
    return chunks.get(id);
}
