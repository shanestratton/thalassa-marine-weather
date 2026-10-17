/** Lossless representation of long static UI strings. No dynamic expression,
 * import/asset path, object key, tagged template or directive is rewritten.
 * The existing bounded decoder and all of its limits remain unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import MagicString from 'magic-string';
import { collectClassNames, packClassNames } from './share-class-names.mjs';
import { collectSvgPaths } from './share-svg-paths.mjs';

const MODULE = 'virtual:thalassa-ui-strings';
const RESOLVED = '\0' + MODULE;
export const UI_STRING_POOL_LIMIT = 4;
const uiFile = (name) =>
    /^(?:App\.tsx|(?:components|pages)\/.*\.tsx)$/.test(name) &&
    !/(?:^|\/)(?:__tests__|fixtures)\/|\.(?:test|spec)\.tsx$/.test(name);

export function selectUiStrings(counts, { minLength = 80 } = {}) {
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
            packClassNames(values);
            return values;
        } catch (error) {
            if (!selected.length || !/^Embedded class (?:table|encoding) exceeds reviewed bounds$/.test(error.message))
                throw error;
            selected.length = Math.floor(selected.length * 0.95);
        }
    }
}

export function collectUiStringPools(root) {
    const classes = new Set([...collectClassNames(root), ...collectSvgPaths(root)]),
        counts = new Map();
    const files = ['App.tsx', ...fs.globSync(['components/**/*.tsx', 'pages/**/*.tsx'], { cwd: root })].sort();
    for (const file of files) {
        if (!uiFile(file.replaceAll('\\', '/')) || !fs.existsSync(path.join(root, file))) continue;
        // Collect the compiler's literal JSX text, including its entity and
        // whitespace normalization. The actual post-JSX transform below still
        // replaces only an exact string match; expressions are never evaluated.
        const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
            fileName: file,
            compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText;
        const source = ts.createSourceFile(file, compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        function visit(node) {
            if (ts.isStringLiteral(node) && !classes.has(node.text)) {
                const parent = node.parent;
                const symbol =
                    (ts.isPropertyAssignment(parent) && parent.name === node) ||
                    ts.isLiteralTypeNode(parent) ||
                    ts.isImportDeclaration(parent) ||
                    ts.isExportDeclaration(parent) ||
                    ts.isExternalModuleReference(parent) ||
                    ts.isTaggedTemplateExpression(parent) ||
                    (ts.isNewExpression(parent) &&
                        ['URL', 'Worker', 'SharedWorker'].includes(parent.expression.getText(source)));
                if (!symbol && node.text.length >= 20) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    const pools = [];
    while (pools.length < UI_STRING_POOL_LIMIT && counts.size) {
        const values = selectUiStrings(counts, { minLength: 20 });
        if (!values.length) break;
        pools.push(values);
        for (const value of values) counts.delete(value);
    }
    return pools;
}

export function collectUiStrings(root) {
    return collectUiStringPools(root).flat();
}

/** Every table retains the existing decoder limits; the aggregate is bounded
 * to four tables, 16,384 entries and 960,000 restored UTF-16 code units. */
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
    const packed = pools.map(packClassNames);
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
    if (!uiFile(relative) || relative.startsWith('../') || relative.includes('node_modules/')) return null;
    const indexes = new Map(values.map((value, i) => [value, i]));
    const output = new MagicString(code);
    let prefix = '__thalassaUiStrings';
    while (code.includes(prefix)) prefix += '_';
    let replacements = 0;
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
                output.overwrite(node.start, node.end, `${prefix}[${indexes.get(node.value)}]`);
                replacements++;
            }
        }
        for (const [childKey, value] of Object.entries(node)) {
            if (Array.isArray(value)) for (const child of value) walk(child, node, childKey);
            else if (value && typeof value === 'object') walk(value, node, childKey);
        }
    }
    walk(parse(code), null, '');
    if (!replacements) return null;
    output.prepend(`import {values as ${prefix}} from '${MODULE}';\n`);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        replacements,
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
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
            enabled = config.isProduction;
        },
        buildStart() {
            if (enabled) {
                pools = collectUiStringPools(root);
                values = pools.flat();
            }
        },
        resolveId(id) {
            return id === MODULE ? RESOLVED : null;
        },
        load(id) {
            return id === RESOLVED ? packUiStringPools(pools, { data, standalone }) : null;
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
