/** Share repeated literal class strings. Values, attribute order, components,
 * dynamic classes and DOM nodes remain identical. The leaf module has no
 * imports, so its immutable string table introduces no application cycle. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import MagicString from 'magic-string';

const MODULE = 'virtual:thalassa-class-names';
const RESOLVED = '\0' + MODULE;
function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) walk(child, visit);
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

/** Only literal JSX className attributes from production application sources.
 * Multiline strings whose JSX whitespace normalizes differently simply miss
 * the lookup later and remain unchanged. */
export function collectClassNames(root) {
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
                node.name.getText(source) === 'className' &&
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
    return [...counts]
        .filter(([value, count]) => count >= 3 && (value.length + 2) * count - (value.length + 30 + 5 * count) >= 24)
        .map(([value]) => value)
        .sort();
}

/** @param {string} code @param {string} id
 * @param {{root:string, values:readonly string[], parse:(source:string)=>any}} options */
export function shareLiteralClassNames(code, id, { root, values, parse }) {
    const file = id.split('?')[0];
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (
        relative.startsWith('../') ||
        relative.includes('node_modules/') ||
        !/\.[cm]?[jt]sx?$/.test(file) ||
        !code.includes('className')
    )
        return null;
    const indexes = new Map(values.map((value, index) => [value, index]));
    const output = new MagicString(code);
    let prefix = '__thalassaClassNames';
    while (code.includes(prefix)) prefix += '_';
    let replacements = 0;
    walk(parse(code), (node) => {
        if (
            node.type !== 'Property' ||
            node.computed ||
            node.method ||
            node.kind !== 'init' ||
            (node.key.name ?? node.key.value) !== 'className' ||
            node.value.type !== 'Literal' ||
            typeof node.value.value !== 'string'
        )
            return;
        const index = indexes.get(node.value.value);
        if (index === undefined) return;
        output.overwrite(node.value.start, node.value.end, `${prefix}[${index}]`);
        replacements++;
    });
    if (!replacements) return null;
    output.prepend(`import { values as ${prefix} } from '${MODULE}';\n`);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        replacements,
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function shareClassNames(root) {
    let enabled = false,
        values = [],
        replacements = 0;
    return {
        name: 'share-class-names',
        apply: 'build',
        enforce: 'post',
        configResolved(config) {
            enabled = config.isProduction;
        },
        buildStart() {
            if (enabled) values = collectClassNames(root);
        },
        resolveId(id) {
            return id === MODULE ? RESOLVED : null;
        },
        load(id) {
            return id === RESOLVED
                ? `export const values=/* @__PURE__ */Object.freeze(${JSON.stringify(values)});`
                : null;
        },
        transform(code, id) {
            if (!enabled || id === RESOLVED) return null;
            const result = shareLiteralClassNames(code, id, { root, values, parse: (source) => this.parse(source) });
            if (!result) return null;
            replacements += result.replacements;
            return { code: result.code, map: result.map };
        },
        buildEnd() {
            if (enabled) this.info(`shared ${values.length} static class strings across ${replacements} attributes`);
        },
    };
}
