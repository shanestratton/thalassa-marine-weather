/** Share exact repeated SVG path strings at build time. Geometry, elements,
 * property order, IDs and handlers stay intact; dynamic/ambiguous props stay
 * untouched. The existing bounded embedded-string decoder is shared. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import MagicString from 'magic-string';
import { bindingCounts } from './strip-noop-logs.mjs';
import { packClassNames } from './share-class-names.mjs';

const MODULE = 'virtual:thalassa-svg-paths';
const RESOLVED = '\0' + MODULE;
function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) walk(child, visit);
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

/** Only literal path attributes in application JSX; no remote or boat data. */
export function collectSvgPaths(root) {
    const counts = new Map();
    const files = ['App.tsx', ...fs.globSync(['components/**/*.tsx', 'pages/**/*.tsx'], { cwd: root })].sort();
    for (const name of files) {
        if (/(?:^|\/)(?:__tests__|fixtures)\/|\.(?:test|spec)\.tsx$/.test(name.replaceAll('\\', '/'))) continue;
        const file = path.join(root, name);
        if (!fs.existsSync(file)) continue;
        const source = ts.createSourceFile(
            name,
            fs.readFileSync(file, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX,
        );
        const visit = (node) => {
            if (
                ts.isJsxAttribute(node) &&
                node.name.getText(source) === 'd' &&
                node.initializer &&
                ts.isStringLiteral(node.initializer)
            ) {
                const value = node.initializer.text;
                counts.set(value, (counts.get(value) ?? 0) + 1);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    const selected = [...counts].filter(([value, count]) => count > 1 && (value.length + 2) * (count - 1) > 7 * count);
    const values = selected.map(([value]) => value).sort();
    if (!values.length) return [];
    const packed = packClassNames(values);
    const originalBytes = selected.reduce((sum, [value, count]) => sum + (value.length + 2) * count, 0);
    const referenceBytes = selected.reduce((sum, [, count]) => sum + 7 * count, 0);
    // Reserve decoder/import overhead too. A small pool stays ordinary source.
    return packed.code.length + referenceBytes + 2000 < originalBytes ? values : [];
}

/** @param {string} code @param {string} id
 * @param {{root:string,values:readonly string[],parse:(source:string)=>any}} options */
export function shareLiteralSvgPaths(code, id, { root, values, parse }) {
    const file = id.split('?')[0];
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (
        relative.startsWith('../') ||
        relative.includes('node_modules/') ||
        !/\.[cm]?[jt]sx?$/.test(file) ||
        !values.length ||
        (!code.includes('"path"') && !code.includes("'path'"))
    )
        return null;
    const program = parse(code);
    const counts = bindingCounts(program);
    const helpers = new Set();
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration' || node.source.value !== 'react/jsx-runtime') continue;
        for (const specifier of node.specifiers) {
            if (
                specifier.type === 'ImportSpecifier' &&
                ['jsx', 'jsxs'].includes(specifier.imported.name) &&
                counts.get(specifier.local.name) === 1
            )
                helpers.add(specifier.local.name);
        }
    }
    if (!helpers.size) return null;
    const indexes = new Map(values.map((value, index) => [value, index]));
    let prefix = '__thalassaSvgPaths';
    while (code.includes(prefix)) prefix += '_';
    const output = new MagicString(code);
    let replacements = 0;
    walk(program, (node) => {
        if (
            node.type !== 'CallExpression' ||
            node.optional ||
            node.callee.type !== 'Identifier' ||
            !helpers.has(node.callee.name) ||
            node.arguments[0]?.type !== 'Literal' ||
            node.arguments[0].value !== 'path'
        )
            return;
        const props = node.arguments[1];
        if (
            props?.type !== 'ObjectExpression' ||
            props.properties.some((p) => p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method)
        )
            return;
        const entries = props.properties.map((p) => [p.key.name ?? p.key.value, p]);
        const attributes = new Map(entries);
        if (attributes.size !== entries.length) return;
        const value = attributes.get('d')?.value;
        if (value?.type !== 'Literal' || typeof value.value !== 'string') return;
        const index = indexes.get(value.value);
        if (index === undefined) return;
        output.overwrite(value.start, value.end, `${prefix}[${index}]`);
        replacements++;
    });
    if (!replacements) return null;
    output.prepend(`import {values as ${prefix}} from '${MODULE}';\n`);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        replacements,
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function shareSvgPaths(root, { data, standalone = false } = {}) {
    if (!data && !standalone) throw Error('Choose inert HTML data or explicit standalone SVG packing');
    let enabled = false,
        values = [],
        replacements = 0;
    return {
        name: 'share-svg-paths',
        apply: 'build',
        enforce: 'post',
        configResolved(config) {
            enabled = config.isProduction;
        },
        buildStart() {
            if (enabled) values = collectSvgPaths(root);
        },
        resolveId(id) {
            return id === MODULE ? RESOLVED : null;
        },
        load(id) {
            if (id !== RESOLVED) return null;
            const packed = packClassNames(values);
            if (data) return data.moduleSource(RESOLVED, [packed]);
            return `import {decodeClassNames} from ${JSON.stringify(path.resolve(root, 'utils/decodeClassNames.ts'))};export const values=decodeClassNames(${JSON.stringify(packed.encoded)},${packed.bytes},${packed.count},${packed.checksum});`;
        },
        transform(code, id) {
            if (!enabled || id === RESOLVED) return null;
            const result = shareLiteralSvgPaths(code, id, { root, values, parse: (source) => this.parse(source) });
            if (!result) return null;
            replacements += result.replacements;
            return { code: result.code, map: result.map };
        },
        buildEnd() {
            if (enabled) this.info(`shared ${values.length} exact SVG paths across ${replacements} attributes`);
        },
    };
}
