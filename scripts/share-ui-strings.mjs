/** Lossless representation of long static UI strings. No dynamic expression,
 * import/asset path, object key, tagged template or directive is rewritten.
 * The existing bounded decoder and all of its limits remain unchanged. */
import path from 'node:path';
import MagicString from 'magic-string';
import { collectClassNames, packClassNames, packCompactStringData } from './share-class-names.mjs';
import { collectSvgPaths, collectLegacySvgPaths } from './share-svg-paths.mjs';
import { collectUiLiteralCounts, isUiSourceFile } from './static-ui-literals.mjs';
import { collectUiDisplayTemplateCounts, rewriteUiDisplayTemplates } from './ui-display-templates142.mjs';
import {
    collectStaticCssCounts,
    compiledCssRanges,
    isStaticCssSource,
    assertStaticCssSource,
} from './static-css-data.mjs';

const MODULE = 'virtual:thalassa-ui-strings';
const RESOLVED = '\0' + MODULE;
export const UI_STRING_POOL_LIMIT = 4;
export function selectUiStrings(counts, { minLength = 80, compact = false } = {}) {
    if (![20, 80].includes(minLength)) throw Error('Unreviewed UI string selection');
    const candidates = [...counts]
        .filter(
            ([value, count]) =>
                value.length >= minLength &&
                value.length <= 8192 &&
                !value.split(' ').some((word) => word.length > 4096) &&
                count >= 1,
        )
        .sort(([a, ac], [b, bc]) => (b.length - 8) * bc - (a.length - 8) * ac || (a < b ? -1 : a > b ? 1 : 0));
    let restored = 0;
    const selected = [];
    for (const [value] of candidates) {
        if (selected.length >= 4096 || restored + value.length > 240000) continue;
        selected.push(value);
        restored += value.length;
    }
    for (;;) {
        const values = [...selected].sort();
        try {
            (compact ? packCompactStringData : packClassNames)(values);
            return values;
        } catch (error) {
            if (!selected.length || !/^Embedded class (?:table|encoding) exceeds reviewed bounds$/.test(error.message))
                throw error;
            selected.length = Math.floor(selected.length * (compact ? 0.99 : 0.95));
        }
    }
}

// An explicit compiler-cooked snapshot lets the baseline/current proof share
// one read without a process-global cache. The normal build always reads source.
export function collectUiStringPools(
    root,
    { legacy = false, literalCounts = collectUiLiteralCounts(root), displayTemplates = true } = {},
) {
    const counts = new Map(literalCounts);
    const classes = new Set([
        ...collectClassNames(root),
        ...(legacy ? collectLegacySvgPaths(root) : collectSvgPaths(root, { uiCounts: counts })),
    ]);
    for (const value of classes) counts.delete(value);
    if (!legacy)
        for (const [value, count] of collectStaticCssCounts(root)) counts.set(value, (counts.get(value) ?? 0) + count);
    const pools = [];
    while (pools.length < UI_STRING_POOL_LIMIT && counts.size) {
        const values = selectUiStrings(counts, { minLength: 20, compact: !legacy });
        if (!values.length) break;
        pools.push(values);
        for (const value of values) counts.delete(value);
    }
    if (legacy || !displayTemplates) return pools;
    const templates = [...collectUiDisplayTemplateCounts(root).keys()].filter((value) => !classes.has(value));
    return templates.length ? regroupUiStringPools([...pools.flat(), ...templates]) : pools;
}

/** Keep every existing value. Ordering is a representation choice only; no
 * candidate is dropped when four unchanged tables cannot hold the cohort. */
export function regroupUiStringPools(input) {
    const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const ordered = [...new Set(input)].sort(
        (a, b) => compare(a.trimStart().split(/\s/)[0], b.trimStart().split(/\s/)[0]) || compare(a, b),
    );
    const pools = [];
    let at = 0;
    while (at < ordered.length && pools.length < UI_STRING_POOL_LIMIT) {
        let low = 1,
            high = Math.min(4096, ordered.length - at),
            best = 0;
        while (low <= high) {
            const count = (low + high) >> 1;
            try {
                packCompactStringData(ordered.slice(at, at + count));
                best = count;
                low = count + 1;
            } catch (error) {
                if (!/^Embedded class (?:table|encoding) exceeds reviewed bounds$/.test(error.message)) throw error;
                high = count - 1;
            }
        }
        if (!best) break;
        pools.push(ordered.slice(at, at + best));
        at += best;
    }
    if (at !== ordered.length) throw Error('Display templates exceed the unchanged four UI tables');
    return pools;
}

export function collectUiStrings(root) {
    return collectUiStringPools(root).flat();
}

/** Every table retains the existing decoder limits; the aggregate is bounded
 * to four tables, 16,384 entries and 960,000 restored UTF-16 code units.
 * @param {string[][]} pools
 * @param {{ data?: ReturnType<typeof import('./inert-ui-data.mjs').inertUiData>, standalone?: boolean }} [options] */
export function packUiStringPools(pools, { data, standalone = false } = {}) {
    if (!data && !standalone) throw Error('Choose inert HTML data or explicit standalone UI packing');
    if (
        !Array.isArray(pools) ||
        pools.length > UI_STRING_POOL_LIMIT ||
        pools.some(
            (values) =>
                !Array.isArray(values) ||
                values.some(
                    (value) =>
                        typeof value !== 'string' ||
                        value.length > 8192 ||
                        value.split(' ').some((word) => word.length > 4096),
                ) ||
                values.reduce((sum, value) => sum + value.length, 0) > 240000,
        )
    )
        throw Error('UI string pools exceed reviewed aggregate bounds');
    const packed = pools.map(packCompactStringData);
    if (packed.length === 0) return 'export const values=Object.freeze([]);';
    if (data) return data.moduleSource(RESOLVED, packed);
    if (packed.length === 1) return packed[0].code;
    const calls = packed.map(
        (value) =>
            `...decodeClassNames(${JSON.stringify(value.encoded)},${value.bytes},${value.count},${value.checksum})`,
    );
    return `import {decodeClassNames} from 'virtual:thalassa-class-data-decoder';export const values=Object.freeze([${calls.join(',')}]);`;
}

export function shareUiStringLiterals(code, id, { root, values, parse }) {
    const file = id.split('?')[0],
        relative = path.relative(root, file).replaceAll('\\', '/');
    const ordinaryUi = isUiSourceFile(relative),
        css = isStaticCssSource(relative);
    if ((!ordinaryUi && !css) || relative.startsWith('../') || relative.includes('node_modules/')) return null;
    const indexes = new Map(values.map((value, i) => [value, i]));
    const output = new MagicString(code);
    let prefix = '__thalassaUiStrings';
    while (code.includes(prefix)) prefix += '_';
    let replacements = 0;
    const replaced = new Set();
    const rewrites = [];
    const replace = (start, end, replacement) => {
        output.overwrite(start, end, replacement);
        replaced.add(start);
        rewrites.push({ start, end, original: code.slice(start, end), replacement });
        replacements++;
    };
    function walk(node, parent, key) {
        if (!node || typeof node.type !== 'string' || node.type === 'TaggedTemplateExpression') return;
        if (
            node.type === 'ImportExpression' ||
            node.type === 'ImportDeclaration' ||
            (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
        )
            return;
        if (
            ['NewExpression', 'CallExpression'].includes(node.type) &&
            ((node.callee?.type === 'Identifier' &&
                ['URL', 'Worker', 'SharedWorker', 'importScripts'].includes(node.callee.name)) ||
                (node.callee?.type === 'MemberExpression' &&
                    ['glob', 'globEager'].includes(node.callee.property?.name)))
        )
            return;
        if (node.type === 'Literal' && typeof node.value === 'string' && indexes.has(node.value)) {
            const moduleSource =
                ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(
                    parent?.type,
                ) && key === 'source';
            const propertyKey =
                ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && key === 'key';
            const directive = parent?.type === 'ExpressionStatement' && typeof parent.directive === 'string';
            const asset =
                ['NewExpression', 'CallExpression'].includes(parent?.type) &&
                ((parent.callee?.type === 'Identifier' &&
                    ['URL', 'Worker', 'SharedWorker', 'importScripts'].includes(parent.callee.name)) ||
                    (parent.callee?.type === 'MemberExpression' &&
                        ['glob', 'globEager'].includes(parent.callee.property?.name)));
            if (!moduleSource && !propertyKey && !directive && !asset) {
                replace(node.start, node.end, `${prefix}[${indexes.get(node.value)}]`);
            }
        }
        for (const [childKey, value] of Object.entries(node)) {
            if (Array.isArray(value)) for (const child of value) walk(child, node, childKey);
            else if (value && typeof value === 'object') walk(value, node, childKey);
        }
    }
    if (ordinaryUi) walk(parse(code), null, '');
    if (css) {
        assertStaticCssSource(root, relative);
        for (const range of compiledCssRanges(code)) {
            const index = indexes.get(range.value);
            if (index === undefined || replaced.has(range.start)) continue;
            replace(range.start, range.end, range.quasi ? '${' + prefix + '[' + index + ']}' : `${prefix}[${index}]`);
        }
    }
    if (!replacements) return null;
    const prelude = `import {values as ${prefix}} from '${MODULE}';\n`;
    output.prepend(prelude);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        replacements,
        rewrites,
        prelude,
    };
}

/** @param {string} root
 * @param {{ data?: ReturnType<typeof import('./inert-ui-data.mjs').inertUiData>, standalone?: boolean }} [options]
 * @returns {import('vite').Plugin} */
export function shareUiStrings(root, { data, standalone = false } = {}) {
    if (!data && !standalone) throw Error('Choose inert HTML data or explicit standalone UI packing');
    let enabled = false,
        pools = [],
        values = [],
        replacements = 0;
    return {
        name: 'share-static-ui-strings',
        apply: 'build',
        enforce: 'post',
        configResolved(config) {
            enabled = config.isProduction && !config.isWorker;
        },
        buildStart() {
            if (enabled) {
                pools = collectUiStringPools(root);
                values = pools.flat();
            }
        },
        resolveId(id) {
            return enabled && id === MODULE ? RESOLVED : null;
        },
        load(id) {
            return enabled && id === RESOLVED ? packUiStringPools(pools, { data, standalone }) : null;
        },
        transform(code, id) {
            if (!enabled || id === RESOLVED) return null;
            const result = shareUiStringLiterals(code, id, { root, values, parse: (source) => this.parse(source) });
            if (!result) return null;
            replacements += result.replacements;
            return { code: result.code, map: result.map };
        },
        buildEnd() {
            if (enabled) this.info(`shared ${values.length} static UI strings across ${replacements} literals`);
        },
    };
}

/** Source AST hook precedes JSX lowering. It shares the existing table owner;
 * the original post-JSX literal/CSS transform and worker seam stay intact.
 * @param {string} root @returns {import('vite').Plugin} */
export function shareUiDisplayTemplates(root) {
    let enabled = false,
        values = [];
    return {
        name: 'share-cooked-jsx-display-templates',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            enabled = config.isProduction && !config.isWorker;
        },
        buildStart() {
            if (enabled) values = collectUiStringPools(root).flat();
        },
        transform(code, id) {
            if (!enabled || id.includes('?')) return null;
            const relative = path.relative(root, id).replaceAll('\\', '/');
            if (relative.startsWith('../') || relative.includes('node_modules/')) return null;
            const result = rewriteUiDisplayTemplates(code, relative, values);
            return result && { code: result.code, map: result.map };
        },
    };
}
