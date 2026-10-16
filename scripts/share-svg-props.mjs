/** Share repeated literal outline attributes without changing SVG elements,
 * child geometry, dynamic attributes, or React component boundaries. This
 * runs after JSX compilation and only recognises imported React jsx/jsxs.
 * Spread/computed/duplicate props and shadowed helpers are left untouched. */
import path from 'node:path';
import MagicString from 'magic-string';
import { bindingCounts } from './strip-noop-logs.mjs';

const MODULE = 'virtual:thalassa-svg-outline-props';
const RESOLVED = '\0' + MODULE;
const CORE = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor' };
const ROUND = { strokeLinecap: 'round', strokeLinejoin: 'round' };
const SIZE = { xmlns: 'http://www.w3.org/2000/svg', width: '24', height: '24' };
const VARIANTS = Array.from({ length: 8 }, (_, mask) => ({
    ...CORE,
    ...(mask & 1 ? ROUND : {}),
    ...(mask & 2 ? SIZE : {}),
    ...(mask & 4 ? { strokeWidth: '2' } : {}),
}));
const SOURCE = VARIANTS.map(
    (props, i) => `export const p${i}=/* @__PURE__ */Object.freeze(${JSON.stringify(props)});`,
).join('\n');

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) walk(child, visit);
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

/** @param {string} code
 * @param {string} id
 * @param {{parse:(source:string)=>any,root:string}} options */
export function shareSvgAttributes(code, id, { parse, root }) {
    const file = id.split('?')[0];
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (
        relative.startsWith('../') ||
        relative.includes('node_modules/') ||
        !/\.[cm]?[jt]sx?$/.test(file) ||
        (!code.includes('"svg"') && !code.includes("'svg'"))
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
    // A generated binding must not collide with any user identifier, including
    // an otherwise unbound global. One shared import per used variant/file.
    let prefix = '__thalassaSvgProps';
    while (code.includes(prefix)) prefix += '_';
    const output = new MagicString(code);
    const used = new Set();
    let elements = 0;
    walk(program, (node) => {
        if (
            node.type !== 'CallExpression' ||
            node.optional ||
            node.callee.type !== 'Identifier' ||
            !helpers.has(node.callee.name) ||
            node.arguments[0]?.type !== 'Literal' ||
            node.arguments[0].value !== 'svg'
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
        const matches = (defaults) =>
            Object.entries(defaults).every(
                ([key, value]) =>
                    attributes.get(key)?.value.type === 'Literal' && attributes.get(key).value.value === value,
            );
        if (!matches(CORE)) return;
        const mask = (matches(ROUND) ? 1 : 0) | (matches(SIZE) ? 2 : 0) | (matches({ strokeWidth: '2' }) ? 4 : 0);
        const selected = new Set(Object.keys(VARIANTS[mask]));
        // Replacing the complete props expression keeps interleaved children
        // edits independent: only the opening property's own ranges change.
        const chosen = props.properties.filter((p) => selected.has(p.key.name ?? p.key.value));
        const first = chosen[0];
        output.overwrite(first.start, first.end, `...${prefix}${mask}`);
        for (const property of chosen.slice(1)) {
            const index = props.properties.indexOf(property);
            const previous = props.properties[index - 1];
            output.remove(previous.end, property.end);
        }
        used.add(mask);
        elements++;
    });
    if (!elements) return null;
    output.prepend(`import {${[...used].map((mask) => `p${mask} as ${prefix}${mask}`).join(',')}} from '${MODULE}';\n`);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        elements,
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function shareSvgProps(root) {
    let enabled = false;
    let count = 0;
    return {
        name: 'share-svg-props',
        apply: 'build',
        enforce: 'post',
        configResolved(config) {
            enabled = config.isProduction;
        },
        resolveId(id) {
            return id === MODULE ? RESOLVED : null;
        },
        load(id) {
            return id === RESOLVED ? SOURCE : null;
        },
        transform(code, id) {
            if (!enabled) return null;
            const result = shareSvgAttributes(code, id, { parse: (source) => this.parse(source), root });
            if (!result) return null;
            count += result.elements;
            return { code: result.code, map: result.map };
        },
        buildEnd() {
            if (enabled) this.info(`shared static outline props for ${count} SVG elements`);
        },
    };
}
