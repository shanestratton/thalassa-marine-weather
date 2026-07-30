#!/usr/bin/env node
/**
 * tests-for — every test file that could plausibly cover the given source files.
 *
 * There are 31 test files COLOCATED beside their source (services/*.test.ts,
 * utils/*.test.ts …) in addition to the 600-odd under tests/. Grepping only
 * tests/ finds a subset, and that subset can be the wrong one: twice in one
 * session a behaviour fix passed every test under tests/ and then failed CI on
 * a colocated file that had encoded the OLD behaviour as its spec —
 * services/AisGuardZone.test.ts and utils/cpaCalculation.test.ts. Both times
 * the fix was right and the untouched sibling test was wrong, and both times CI
 * found it instead of me.
 *
 * Usage:
 *   node scripts/tests-for.mjs services/MobService.ts utils/cpaCalculation.ts
 *   NODE_OPTIONS=--max-old-space-size=6144 npx vitest run \
 *     $(node scripts/tests-for.mjs services/MobService.ts) --maxWorkers=2
 *
 * Matching is deliberately broad — a same-named sibling, a same-named file in
 * tests/, and anything whose text mentions the module. False positives cost a
 * few seconds; a false negative costs a red master.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const ROOTS = ['tests', 'components', 'services', 'utils', 'stores', 'hooks', 'pages', 'modules'];

function walk(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
    console.error('usage: node scripts/tests-for.mjs <source-file> [...]');
    process.exit(2);
}

const allTests = ROOTS.flatMap((r) => walk(r));
const hits = new Set();

for (const target of targets) {
    const stem = basename(target, extname(target));
    for (const test of allTests) {
        if (basename(test).replace(/\.test\.(ts|tsx)$/, '') === stem) {
            hits.add(test);
            continue;
        }
        // Mentions the module by name — catches consumers whose specs would
        // change meaning even though they are named after something else.
        try {
            if (readFileSync(test, 'utf8').includes(stem)) hits.add(test);
        } catch {
            /* unreadable — skip */
        }
    }
}

console.log([...hits].sort().join('\n'));
