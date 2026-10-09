/**
 * Whitespace-only minification for the two hand-written scripts Vite copies
 * verbatim from public/ into dist/: the service worker and the AudioWorklet.
 *
 * public/sw.js is about 52 KB, of which about 44 KB is the comment history of
 * every cache bump (v3..v199). Those comments are worth keeping in the source,
 * but every byte in dist counts against the app's JavaScript budget
 * (scripts/check-bundle-size.js), and dist is what Vercel serves and what
 * cap sync copies into the iOS app. The vite.config.ts plugin
 * `releaseMinifyPublicScripts` rewrites only the dist copies; public/ stays
 * byte-identical, so tests that read the source keep reading it.
 *
 * Only comments and whitespace go: identifiers and strings are kept. Every
 * call proves it by parsing the original and the stripped copy and requiring
 * the same syntax tree, or the build fails. The comparison ignores source
 * positions and how a literal was spelled (0x8000 vs 32768, ' vs "), and
 * reads esbuild's `void 0` as `undefined`, which esbuild only writes for the
 * unshadowed global (non-writable since ES5, so the two are the same value).
 */
import { parseAst, transformWithEsbuild } from 'vite';

/** The public/ scripts whose dist copies are whitespace-minified. */
export const MINIFIED_PUBLIC_SCRIPTS = Object.freeze(['sw.js', 'pcm-worklet.js']);

/**
 * The public/ data files whose dist copies are minified JSON (build 126 bundle
 * diet). Both were JavaScript tables until then; as data they are fetched
 * when needed. The public/ sources stay indented so edits and refreshes are
 * reviewable diffs; the shipped copy loses only the whitespace.
 */
export const MINIFIED_PUBLIC_DATA = Object.freeze(['data/marine-place-names-qld.json', 'data/customs-clearance.json']);

/** Text each dist copy must still contain (verify-web-release.mjs greps CACHE_NAME). */
export const REQUIRED_PUBLIC_SCRIPT_TOKENS = Object.freeze({
    'sw.js': ['CACHE_NAME', 'RUNTIME_TILE_CACHE', 'OFFLINE_TILE_CACHE', 'DATA_CACHE', 'LAN_TILE_CACHE'],
    'pcm-worklet.js': ['registerProcessor', 'pcm-processor', 'AudioWorkletProcessor'],
});

const isVoidZero = (node) =>
    node !== null &&
    typeof node === 'object' &&
    node.type === 'UnaryExpression' &&
    node.operator === 'void' &&
    node.argument?.type === 'Literal' &&
    node.argument.value === 0;

/** The program's syntax tree as text, without positions or literal spellings. */
export function syntaxFingerprint(code) {
    return JSON.stringify(parseAst(code), function (key, value) {
        if (key === 'start' || key === 'end') return undefined;
        if (key === 'raw' && this.type === 'Literal') return undefined;
        if (isVoidZero(value)) return { type: 'Identifier', name: 'undefined' };
        return value;
    });
}

/**
 * Strip comments and whitespace from one public script, keeping its program.
 * Throws if the syntax trees differ or a required token is missing.
 */
export async function minifyPublicScriptWhitespace(source, fileName) {
    const { code: stripped } = await transformWithEsbuild(source, fileName, {
        loader: 'js',
        minifyWhitespace: true,
        legalComments: 'none',
        sourcemap: false,
    });
    if (syntaxFingerprint(stripped) !== syntaxFingerprint(source)) {
        throw new Error(`${fileName}: whitespace minification changed the program`);
    }
    for (const token of REQUIRED_PUBLIC_SCRIPT_TOKENS[fileName] ?? []) {
        if (!stripped.includes(token)) {
            throw new Error(`${fileName}: whitespace minification lost ${JSON.stringify(token)}`);
        }
    }
    return stripped;
}

/**
 * Minify one public JSON file: parse, then serialise without whitespace.
 * Throws (naming the file) if it does not parse, so a broken data file fails
 * the build instead of shipping. Re-parsing the output proves the value
 * survived unchanged.
 */
export function minifyPublicJson(source, fileName) {
    let value;
    try {
        value = JSON.parse(source);
    } catch (error) {
        throw new Error(`${fileName}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const minified = JSON.stringify(value);
    if (JSON.stringify(JSON.parse(minified)) !== minified) {
        throw new Error(`${fileName}: minified JSON does not round-trip`);
    }
    return minified;
}
