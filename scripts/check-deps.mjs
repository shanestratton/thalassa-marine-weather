#!/usr/bin/env node
/**
 * check-deps — two-way dependency hygiene gate.
 *
 * Born 2026-08-03 after a single evening produced both failure modes:
 * eleven dead-declared prod deps (bundle/audit surface for nothing) and
 * one PHANTOM dep — EncSpatialIndex imported @turf/line-intersect, never
 * declared, hoisted in under @turf/buffer; removing buffer broke the
 * build. This script fails CI on either class:
 *
 *   DEAD:    a prod dependency no source file imports (allowlist below
 *            for packages consumed by native tooling/config, not TS).
 *   PHANTOM: a bare import specifier that resolves to no declared
 *            dependency (prod or dev).
 *
 * Scope: the ROOT package only. workers/ and supabase/functions/ have
 * their own dependency worlds (separate package.json / Deno) and are
 * excluded from both directions.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { builtinModules } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname;

/** Packages consumed by native/build tooling rather than TS imports. */
const DEAD_ALLOWLIST = new Set([
    '@capacitor/ios', // native platform — consumed by the iOS project
    '@capacitor/android', // native platform
    '@capacitor/assets', // icon/splash generation CLI
    '@capacitor/status-bar', // configured via capacitor.config.ts plugins.StatusBar; no TS import
]);

/**
 * Bare imports in manual/one-off tooling that installs its deps ad hoc —
 * not part of the app build. Keyed by package name.
 */
const PHANTOM_ALLOWLIST = new Set([
    '@turf/turf', // scripts/build_channel_walls.js — manual data pipeline
    'playwright', // scripts/linz-msi-scrape — runs with its own install
]);

/** Non-package import prefixes that are never phantoms. */
const VIRTUAL_PREFIXES = ['virtual:', 'node:', 'data:'];

const SCAN_DIRS = [
    'components',
    'services',
    'src',
    'pages',
    'hooks',
    'stores',
    'utils',
    'context',
    'contexts',
    'modules',
    'managers',
    'data',
    'scripts',
    'tests',
];
const SCAN_ROOT_FILES = [
    'App.tsx',
    'index.tsx',
    'theme.ts',
    'viewRegistry.tsx',
    'middleware.ts',
    'vite.config.ts',
    'vitest.config.ts',
    'tailwind.config.js',
    'postcss.config.js',
    'capacitor.config.ts',
    'playwright.config.ts',
];
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function* walk(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const e of entries) {
        if (e === 'node_modules' || e.startsWith('.')) continue;
        const p = join(dir, e);
        const st = statSync(p);
        if (st.isDirectory()) yield* walk(p);
        else if (EXTS.has(extname(e))) yield p;
    }
}

/** "@scope/name/deep" → "@scope/name"; "name/deep" → "name". */
function toPackageName(spec) {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const prodDeps = Object.keys(pkg.dependencies ?? {});
const allDeclared = new Set([...prodDeps, ...Object.keys(pkg.devDependencies ?? {})]);
const builtins = new Set(builtinModules);

const files = [];
for (const d of SCAN_DIRS) files.push(...walk(join(ROOT, d)));
for (const f of SCAN_ROOT_FILES) {
    try {
        statSync(join(ROOT, f));
        files.push(join(ROOT, f));
    } catch {
        /* absent root file — fine */
    }
}

// Statement-anchored forms only — a plain /from '...'/ scoop drags in
// prose from comments ("...read from 'weather.current'"). Line-anchored
// import/export cover static forms incl. side-effect imports
// (import 'leaflet.markercluster'); dynamic import()/require() are
// matched unanchored but validated by the npm-name shape below.
const IMPORT_RES = [
    // [^'"]{0,600}? spans multi-line import blocks (import X, { a,\n b }
    // from 'pkg') but cannot jump PAST a specifier — the exclusion of
    // quotes stops it at the first string literal.
    /^[ \t]*(?:import|export)[^'"]{0,600}?\bfrom\s*['"]([^'"\n]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g,
];
/** Valid npm specifier shape — kills residual prose matches. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/[\w.-]+)*$/;

const seenPackages = new Set();
const phantoms = new Map(); // pkgName → first file:specifier

for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of IMPORT_RES) {
        for (const m of text.matchAll(re)) {
            const spec = m[1];
            if (spec.startsWith('.') || spec.startsWith('/')) continue;
            if (VIRTUAL_PREFIXES.some((p) => spec.startsWith(p))) continue;
            if (!NPM_NAME_RE.test(spec)) continue;
            const name = toPackageName(spec);
            if (builtins.has(name)) continue;
            seenPackages.add(name);
            // Type-only packages resolve bare names via DefinitelyTyped:
            // 'geojson' → '@types/geojson'; '@scope/pkg' → '@types/scope__pkg'.
            const typesName = name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
            const declared = allDeclared.has(name) || allDeclared.has(typesName) || PHANTOM_ALLOWLIST.has(name);
            if (!declared && !phantoms.has(name)) {
                phantoms.set(name, `${file.replace(ROOT, '')} → '${spec}'`);
            }
        }
    }
}

const dead = prodDeps.filter((d) => !seenPackages.has(d) && !DEAD_ALLOWLIST.has(d) && !d.startsWith('@types/'));
const typesInProd = prodDeps.filter((d) => d.startsWith('@types/'));

let failed = false;
if (dead.length > 0) {
    failed = true;
    console.error(`❌ DEAD prod dependencies (no source import; allowlist in scripts/check-deps.mjs):`);
    for (const d of dead) console.error(`   - ${d}`);
}
if (phantoms.size > 0) {
    failed = true;
    console.error(`❌ PHANTOM imports (bare specifier with no declared dependency — hoisting roulette):`);
    for (const [name, where] of phantoms) console.error(`   - ${name} (${where})`);
}
if (typesInProd.length > 0) {
    failed = true;
    console.error(`❌ @types/* in prod dependencies (belong in devDependencies): ${typesInProd.join(', ')}`);
}

if (failed) process.exit(1);
console.log(`✅ Dependency hygiene: ${prodDeps.length} prod deps all referenced; no phantom imports.`);
