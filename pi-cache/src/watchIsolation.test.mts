/**
 * The watch is sacred (127 vision §4.1 rule 4; 127-C-d decisions 1 and 9):
 * nothing that opens, parses or routes over a chart may run inside the
 * process that keeps the anchor watch, the night watch, the alarm relay and
 * the telemetry. So the static import closure of the server (src/server.ts,
 * which tsc compiles one-to-one into dist/server.js) holds no senc engine, no
 * vault decoder and no router engine, and routes/enc.ts never calls
 * routeInshore.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [/^sencEngine\//, /^vault\/decoder/, /^routerEngine\//, /^services\/inshoreRouter\.ts$/];

/** Static relative imports (import/export ... from, and side-effect imports), not type-only ones. */
function importsOf(source: string): string[] {
    const out: string[] = [];
    const re = /^\s*(import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;
    for (const m of source.matchAll(re)) if (!m[2]) out.push(m[3]);
    return out;
}

/** The closure of `entry` (relative to src/), as src-relative .ts paths. */
export function closureOf(entry: string, read: (rel: string) => string | null): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
        const rel = queue.shift()!;
        if (seen.has(rel)) continue;
        const source = read(rel);
        if (source === null) continue;
        seen.add(rel);
        for (const spec of importsOf(source)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.js$/, '.ts');
            queue.push(target);
        }
    }
    return seen;
}

const fromDisk = (rel: string): string | null => {
    const file = path.join(SRC, rel);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

const offenders = (closure: Set<string>) => [...closure].filter((rel) => FORBIDDEN.some((re) => re.test(rel)));

test('the server process loads no chart decoder, senc engine or router engine', () => {
    const closure = closureOf('server.ts', fromDisk);
    assert.ok(closure.has('routes/enc.ts'), 'the closure is the real one');
    assert.ok(closure.has('vaultClient.ts'), 'it reaches the vault only through its client');
    assert.deepEqual(offenders(closure), []);
});

test('routes/enc.ts never routes: no routeInshore call and no router import', () => {
    const enc = readFileSync(path.join(SRC, 'routes', 'enc.ts'), 'utf8');
    assert.doesNotMatch(enc, /routeInshore\(/);
    assert.doesNotMatch(enc, /services\/inshoreRouter/);
});

test('proven to fail: adding the router import to routes/enc.ts is caught', () => {
    const graph = (rel: string): string | null => {
        if (rel === 'routes/enc.ts') {
            return `import { routeInshore } from '../services/inshoreRouter.js';\n${fromDisk(rel)}`;
        }
        if (rel === 'services/inshoreRouter.ts')
            return "export { routeInshore } from '../routerEngine/services/inshoreRouterEngine.js';\n";
        if (rel === 'routerEngine/services/inshoreRouterEngine.ts') return 'export const routeInshore = 1;\n';
        return fromDisk(rel);
    };
    const found = offenders(closureOf('server.ts', graph));
    assert.ok(found.includes('services/inshoreRouter.ts'), found.join(', '));
    assert.ok(found.includes('routerEngine/services/inshoreRouterEngine.ts'));
    // And a decoder import from a route.
    const decoderGraph = (rel: string): string | null =>
        rel === 'vaultClient.ts'
            ? `import { OexDecoder } from './vault/decoder.js';\n${fromDisk(rel)}`
            : rel === 'vault/decoder.ts'
              ? "import { parseSenc } from '../sencEngine/featureParser.js';\n"
              : rel === 'sencEngine/featureParser.ts'
                ? 'export const parseSenc = 1;\n'
                : fromDisk(rel);
    const viaClient = offenders(closureOf('server.ts', decoderGraph));
    assert.deepEqual(viaClient.sort(), ['sencEngine/featureParser.ts', 'vault/decoder.ts']);
});
