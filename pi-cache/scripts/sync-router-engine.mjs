#!/usr/bin/env node
/**
 * Mirror the app's inshore routing engine into the Pi cache.
 *
 * The phone's engine (services/inshoreRouterEngine.ts and every module it
 * imports) is the one routing engine. The Pi runs a copy of it for
 * POST /api/enc/route and /api/enc/route-prepped. Until 2026-10-04 that copy
 * was one hand-merged file, last synced 2026-05-21; the engine has since
 * grown to ~35 modules, so this script copies them instead:
 *
 *   - follows the import graph from services/inshoreRouterEngine.ts;
 *   - writes each module to pi-cache/src/routerEngine/<same path as in the app>;
 *   - rewrites relative imports to the '.js' specifiers Node's ESM loader needs;
 *   - swaps utils/createLogger (app-only: Sentry, import.meta.env) for a
 *     console shim with the same interface;
 *   - records the app commit it copied in routerEngine/syncedFrom.ts.
 *
 * Usage (from the repo root or anywhere):
 *   node pi-cache/scripts/sync-router-engine.mjs           # rewrite the mirror
 *   node pi-cache/scripts/sync-router-engine.mjs --check   # exit 1 if it drifted
 *
 * It refuses to copy engine files with uncommitted changes (the Pi must run a
 * commit), unless --allow-dirty is given for a local experiment.
 * The mirror is generated: never edit pi-cache/src/routerEngine by hand.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PI_CACHE, '..');
const ENTRY = 'services/inshoreRouterEngine.ts';
const OUT = path.join(PI_CACHE, 'src', 'routerEngine');
const OUT_REL = path.relative(REPO, OUT);
const LOGGER = 'utils/createLogger.ts';
const SYNCED_FROM = 'syncedFrom.ts';
// Type-only packages the Pi already has (@types/geojson). Anything else the
// engine imports from node_modules must be added here deliberately.
const ALLOWED_PACKAGES = new Set(['geojson']);

const ts = createRequire(path.join(PI_CACHE, 'package.json'))('typescript');
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const ALLOW_DIRTY = args.has('--allow-dirty');

const posix = (p) => p.split(path.sep).join('/');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const fail = (message) => {
    console.error(`sync-router-engine: ${message}`);
    process.exit(1);
};

function resolveSpecifier(fromRel, spec) {
    let base;
    if (spec.startsWith('@/')) base = path.join(REPO, spec.slice(2));
    else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(REPO, path.dirname(fromRel), spec);
    else return null;
    const stem = base.replace(/\.js$/, '');
    for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return posix(path.relative(REPO, candidate));
    }
    fail(`${fromRel} imports '${spec}', which does not resolve to a file`);
}

/** Every module the engine needs, as repo-relative paths, with its import sites. */
function readClosure() {
    const modules = new Map();
    const queue = [ENTRY];
    while (queue.length > 0) {
        const rel = queue.shift();
        if (modules.has(rel)) continue;
        if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) fail(`${rel}: only .ts modules can be mirrored`);
        const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
        const imports = [];
        if (rel !== LOGGER) {
            for (const ref of ts.preProcessFile(source, true, true).importedFiles) {
                const target = resolveSpecifier(rel, ref.fileName);
                if (target === null) {
                    const pkg = ref.fileName.startsWith('@')
                        ? ref.fileName.split('/').slice(0, 2).join('/')
                        : ref.fileName.split('/')[0];
                    if (!ALLOWED_PACKAGES.has(pkg)) fail(`${rel} imports the package '${ref.fileName}'`);
                    continue;
                }
                // preProcessFile's pos is the opening quote; the specifier follows it.
                const start = ref.pos + 1;
                const end = start + ref.fileName.length;
                if (!`'"`.includes(source[ref.pos]) || source.slice(start, end) !== ref.fileName) {
                    fail(`${rel}: could not locate the import '${ref.fileName}' at offset ${ref.pos}`);
                }
                imports.push({ start, end, target });
                queue.push(target);
            }
        }
        modules.set(rel, { source, imports });
    }
    return modules;
}

function relativeJsSpecifier(fromRel, targetRel) {
    let spec = posix(path.relative(path.dirname(fromRel), targetRel)).replace(/\.tsx?$/, '.js');
    if (!spec.startsWith('.')) spec = `./${spec}`;
    return spec;
}

function header(rel) {
    return [
        `// GENERATED by pi-cache/scripts/sync-router-engine.mjs from ${rel}.`,
        '// Do not edit here: change the app copy, then re-run the script (see pi-cache/src/services/inshoreRouter.ts).',
        '',
    ].join('\n');
}

const LOGGER_SHIM = `/**
 * The Pi's stand-in for the app's utils/createLogger: the same interface,
 * without Sentry or import.meta.env. As in the app's production build, debug
 * and info are silent when NODE_ENV=production (the systemd unit sets it);
 * warn and error go to the journal.
 */
export interface Logger {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

const IS_PROD = process.env.NODE_ENV === 'production';
const noop = (..._args: unknown[]): void => {};

export function createLogger(tag: string): Logger {
    const prefix = \`[\${tag}]\`;
    return {
        debug: IS_PROD ? noop : (...args: unknown[]) => console.debug(prefix, ...args),
        info: IS_PROD ? noop : (...args: unknown[]) => console.info(prefix, ...args),
        warn: (...args: unknown[]) => console.warn(prefix, ...args),
        error: (...args: unknown[]) => console.error(prefix, ...args),
    };
}

export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return String(err);
}
`;

function render(rel, { source, imports }) {
    if (rel === LOGGER) return header(rel) + LOGGER_SHIM;
    let out = '';
    let at = 0;
    for (const site of [...imports].sort((a, b) => a.start - b.start)) {
        out += source.slice(at, site.start) + relativeJsSpecifier(rel, site.target);
        at = site.end;
    }
    return header(rel) + out + source.slice(at);
}

function git(...gitArgs) {
    return execFileSync('git', ['-C', REPO, ...gitArgs], { encoding: 'utf8' }).trim();
}

function prettierFormat(files) {
    const prettier = path.join(REPO, 'node_modules', '.bin', 'prettier');
    if (!fs.existsSync(prettier)) fail(`${prettier} is missing — run npm ci at the repo root first`);
    execFileSync(prettier, ['--write', '--log-level', 'warn', ...files], { cwd: REPO, stdio: 'inherit' });
}

const modules = readClosure();
const sources = [...modules.keys()].sort();
const digest = sha256(sources.map((rel) => `${rel}\n${sha256(modules.get(rel).source)}\n`).join(''));
const generated = new Map(sources.map((rel) => [rel, render(rel, modules.get(rel))]));

// Prettier owns the repo's formatting (CI runs format:check), and a '.js'
// suffix can push an import past the print width — so the mirror is the
// formatted output, in --check mode too (formatted in a scratch tree).
function formattedTree(dir) {
    for (const [rel, text] of generated) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    prettierFormat(sources.map((rel) => path.join(dir, rel)));
}

function listMirror() {
    if (!fs.existsSync(OUT)) return [];
    return fs
        .readdirSync(OUT, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => posix(path.relative(OUT, path.join(d.parentPath ?? d.path, d.name))))
        .sort();
}

const syncedFromFile = (commit) => `// GENERATED by pi-cache/scripts/sync-router-engine.mjs. Do not edit.
/** The app commit the Pi's routing engine was copied from, and a digest of the copied sources. */
export const ROUTER_ENGINE_SYNCED_FROM = {
    commit: '${commit}',
    modules: ${sources.length},
    sourceDigest: '${digest}',
} as const;
`;

if (CHECK) {
    const scratch = fs.mkdtempSync(path.join(PI_CACHE, '.router-engine-check-'));
    // process.exit skips `finally`, and fail() exits: clean up on exit instead.
    process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
    formattedTree(scratch);
    const drift = [];
    for (const rel of sources) {
        const want = fs.readFileSync(path.join(scratch, rel), 'utf8');
        const have = fs.existsSync(path.join(OUT, rel)) ? fs.readFileSync(path.join(OUT, rel), 'utf8') : null;
        if (have === null) drift.push(`missing: ${rel}`);
        else if (have !== want) drift.push(`differs: ${rel}`);
    }
    for (const rel of listMirror()) {
        if (rel !== SYNCED_FROM && !modules.has(rel)) drift.push(`no longer part of the engine: ${rel}`);
    }
    const stampPath = path.join(OUT, SYNCED_FROM);
    const stamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : '';
    if (!stamp.includes(`sourceDigest: '${digest}'`)) drift.push(`stale digest: ${SYNCED_FROM}`);
    if (drift.length > 0) {
        console.error(`sync-router-engine --check: the Pi's engine copy has drifted from ${ENTRY}:`);
        for (const line of drift) console.error(`  ${line}`);
        console.error('Run: node pi-cache/scripts/sync-router-engine.mjs');
        process.exit(1);
    }
    const copiedFrom = /commit: '([^']*)'/.exec(stamp)?.[1] ?? '?';
    console.info(`sync-router-engine --check: in sync (${sources.length} modules, copied from ${copiedFrom}).`);
    process.exit(0);
}

const dirty = git('status', '--porcelain', '--', ...sources);
if (dirty && !ALLOW_DIRTY)
    fail(`engine files have uncommitted changes:\n${dirty}\n(commit them, or pass --allow-dirty)`);
const commit = git('rev-parse', '--short=8', 'HEAD') + (dirty ? '-dirty' : '');

const stale = listMirror().filter((rel) => rel !== SYNCED_FROM && !modules.has(rel));
for (const rel of stale) {
    fs.rmSync(path.join(OUT, rel));
    for (let dir = path.dirname(path.join(OUT, rel)); dir !== OUT && fs.readdirSync(dir).length === 0; ) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
    }
}
formattedTree(OUT);
fs.writeFileSync(path.join(OUT, SYNCED_FROM), syncedFromFile(commit));
prettierFormat([path.join(OUT, SYNCED_FROM)]);
console.info(
    `sync-router-engine: ${sources.length} modules copied from ${commit} into ${OUT_REL}` +
        (stale.length ? `; removed ${stale.length} no longer used: ${stale.join(', ')}` : '') +
        '.',
);
