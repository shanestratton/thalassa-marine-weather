#!/usr/bin/env node
/**
 * audit-orphan-routes.mjs — find routes registered in viewRegistry
 * but never triggered from anywhere in the UI.
 *
 * Background
 * ----------
 * We've shipped TWO orphan-route bugs in the last two days:
 *   - Diary (2026-05-16): registered in viewRegistry, gated as a paid
 *     Skipper feature, but the VesselHub tile that called
 *     setPage('diary') had been silently deleted in a Quick-Actions
 *     cleanup. Users couldn't reach a feature they were paying for.
 *   - Galley (2026-05-17): identical pattern — registered + gated +
 *     advertised in the UpgradeModal as a paid feature, but no UI
 *     tile/button actually navigated to it.
 *
 * Both bugs are silent: TypeScript compiles fine, tests pass, the
 * app loads. The only symptom is users not being able to find a
 * feature. The fix is trivial; the detection is what's hard.
 *
 * This script does what a human orphan-audit does, but every commit:
 *   1. Parse viewRegistry.tsx → enumerate every route key.
 *   2. Grep the codebase for navigation calls referencing each key
 *      (setPage('x'), onNavigate('x'), navigate('x'), in both
 *      single- and double-quoted forms).
 *   3. Subtract self-references (the registry itself) + test files.
 *   4. If anything has zero remaining call sites → fail.
 *
 * Run modes
 * ---------
 *   node scripts/audit-orphan-routes.mjs           # human report
 *   node scripts/audit-orphan-routes.mjs --strict  # exit 1 on orphan
 *                                                  # (for CI / lint:routes)
 *   node scripts/audit-orphan-routes.mjs --json    # machine-readable
 *
 * Allow-list
 * ----------
 * Some routes are reachable via REGISTRY-INTERNAL callbacks rather
 * than a UI call site — e.g. the NMEA page's `onNavigateToGlass`
 * prop is constructed by viewRegistry itself and invoked from
 * inside the rendered NMEA component. These routes are listed in
 * `INTENTIONAL_INDIRECT_ROUTES` below; the audit skips them.
 *
 * If you add a route to that list, leave a comment explaining WHY
 * — otherwise the next person reviewing the file will assume it's
 * a hidden orphan we forgot to fix.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(__filename, '../..');
const REGISTRY_PATH = join(REPO_ROOT, 'viewRegistry.tsx');

// Routes that are intentionally only reachable via a registry-
// internal callback, not via a top-level setPage call site. Adding
// to this list = "I have audited this manually and confirmed it's
// reachable; the audit can stop nagging me about it."
const INTENTIONAL_INDIRECT_ROUTES = new Set([
    // `glass` is rendered as a sub-view of the NMEA page — the
    // NMEA component receives `onNavigateToGlass` as a prop (built
    // by viewRegistry.tsx) and calls it when the user taps the
    // Glass card. So `glass` has no top-level setPage('glass') call
    // site, but it IS reachable in the running app.
    'glass',
]);

// Directories to skip entirely. Anything inside these is build
// output, dependencies, or test code where references don't count
// as "the user can reach this route".
const SKIP_DIRS = new Set([
    'node_modules',
    'dist',
    'ios',
    'android',
    'tests',
    'e2e',
    '.claude',
    '.git',
    'pi-cache',
    'cloudflare-worker',
    'supabase',
    'public',
]);

// File extensions to grep.
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

// Files to skip even within search dirs.
const SKIP_FILE_PATTERNS = [
    /\.test\.[tj]sx?$/,
    /\.spec\.[tj]sx?$/,
    /\.d\.ts$/,
    /^viewRegistry\.tsx$/, // the registry itself — self-references don't count
    /^audit-orphan-routes\.mjs$/, // this script itself — its docstring shows
    // literal navigation examples like setPage('glass') for documentation
    // purposes which would otherwise be picked up as fake call sites
];

// ─── 1. Extract route keys from viewRegistry.tsx ─────────────────────

function extractRouteKeys(registrySrc) {
    // Find the VIEW_REGISTRY object body. We look for `VIEW_REGISTRY:
    // Record<string, ViewConfig> = {` then collect every top-level
    // key (4-space indented identifier followed by `: {`).
    const startMatch = registrySrc.match(/VIEW_REGISTRY[^=]*=\s*\{/);
    if (!startMatch) {
        throw new Error('Could not locate VIEW_REGISTRY object in viewRegistry.tsx');
    }
    const start = startMatch.index + startMatch[0].length;

    // Walk forward to find the matching close brace, ignoring nested objects.
    let depth = 1;
    let i = start;
    while (i < registrySrc.length && depth > 0) {
        const c = registrySrc[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
        if (depth === 0) break;
    }
    const body = registrySrc.slice(start, i - 1);

    // Now extract every TOP-LEVEL key. A top-level key sits at depth
    // 0 in `body` and looks like `    identifier: {` after a newline.
    const keys = [];
    const lines = body.split('\n');
    let lineDepth = 0;
    for (const line of lines) {
        if (lineDepth === 0) {
            const m = line.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/);
            if (m) keys.push(m[1]);
        }
        for (const c of line) {
            if (c === '{') lineDepth++;
            else if (c === '}') lineDepth--;
        }
    }
    return keys;
}

// ─── 2. Walk the repo and collect (file, line, route) hits ───────────

function walkRepo(dir, hits, routeSet) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.eslintrc.json') continue;
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            walkRepo(full, hits, routeSet);
            continue;
        }
        // File — check ext + skip patterns.
        const ext = '.' + name.split('.').slice(-1)[0];
        if (!TS_EXTENSIONS.has(ext)) continue;
        if (SKIP_FILE_PATTERNS.some((re) => re.test(name))) continue;
        if (relative(REPO_ROOT, full) === 'viewRegistry.tsx') continue;

        // Read + scan.
        let src;
        try {
            src = readFileSync(full, 'utf8');
        } catch {
            continue;
        }
        // Build the regex once per file. Looks for any of:
        //   setPage('key')   setPage("key")
        //   onNavigate('key')   onNavigate("key")
        //   navigate('key')     navigate("key")
        for (const route of routeSet) {
            const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:setPage|onNavigate|navigate)\\s*\\(\\s*['"]${escaped}['"]\\s*[,)]`, 'g');
            const matches = src.matchAll(re);
            for (const m of matches) {
                // Find line number from match index.
                const idx = m.index;
                const before = src.slice(0, idx);
                const lineNum = before.split('\n').length;
                hits.push({ route, file: relative(REPO_ROOT, full), line: lineNum });
            }
        }
    }
}

// ─── 3. Report ──────────────────────────────────────────────────────

function main() {
    const args = new Set(process.argv.slice(2));
    const strict = args.has('--strict');
    const asJson = args.has('--json');

    const registrySrc = readFileSync(REGISTRY_PATH, 'utf8');
    const routes = extractRouteKeys(registrySrc);
    if (routes.length === 0) {
        console.error('No routes extracted — VIEW_REGISTRY parser is broken.');
        process.exit(2);
    }
    const routeSet = new Set(routes);

    const hits = [];
    walkRepo(REPO_ROOT, hits, routeSet);

    // Bucket hits per route.
    const byRoute = new Map();
    for (const r of routes) byRoute.set(r, []);
    for (const h of hits) byRoute.get(h.route).push(h);

    // Classify.
    const orphans = [];
    const indirect = [];
    const ok = [];
    for (const r of routes) {
        const sites = byRoute.get(r);
        if (sites.length > 0) {
            ok.push({ route: r, count: sites.length, first: sites[0] });
        } else if (INTENTIONAL_INDIRECT_ROUTES.has(r)) {
            indirect.push(r);
        } else {
            orphans.push(r);
        }
    }

    // Output.
    if (asJson) {
        console.log(
            JSON.stringify(
                {
                    totalRoutes: routes.length,
                    reachable: ok.length,
                    indirect: indirect.length,
                    orphans: orphans.length,
                    orphanList: orphans,
                    indirectList: indirect,
                },
                null,
                2,
            ),
        );
    } else {
        console.log(`\n📋 Route audit — ${routes.length} registered, ${ok.length} reachable\n`);
        if (orphans.length > 0) {
            console.log(`❌ ${orphans.length} ORPHAN ROUTE${orphans.length === 1 ? '' : 'S'}:`);
            for (const r of orphans) {
                console.log(`   - ${r}  (registered, no setPage/onNavigate call sites)`);
            }
            console.log('');
        } else {
            console.log('✅ No orphan routes.\n');
        }
        if (indirect.length > 0) {
            console.log(
                `ℹ️  ${indirect.length} intentional indirect route${indirect.length === 1 ? '' : 's'} (allow-listed):`,
            );
            for (const r of indirect) console.log(`   - ${r}`);
            console.log('');
        }
        if (args.has('--verbose')) {
            console.log('✅ Reachable routes (first call site shown):');
            for (const r of ok) {
                console.log(
                    `   - ${r.route.padEnd(16)}  ${r.first.file}:${r.first.line}  (${r.count} site${r.count === 1 ? '' : 's'})`,
                );
            }
        }
    }

    if (strict && orphans.length > 0) {
        console.error('\nFAIL — orphan routes found. Either:\n');
        console.error('  1. Add a UI entry point (setPage / onNavigate) for the route, OR');
        console.error('  2. Delete the route from viewRegistry.tsx if the feature is dead, OR');
        console.error('  3. Add to INTENTIONAL_INDIRECT_ROUTES with a comment explaining why');
        console.error("     it's reachable via a registry-internal callback.\n");
        process.exit(1);
    }
}

main();
