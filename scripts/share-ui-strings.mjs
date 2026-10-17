/** Lossless representation of long static UI strings. No dynamic expression,
 * import/asset path, object key, tagged template or directive is rewritten.
 * The existing bounded decoder and all of its limits remain unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import MagicString from 'magic-string';
import { collectClassNames, packClassNames } from './share-class-names.mjs';

const MODULE = 'virtual:thalassa-ui-strings';
const RESOLVED = '\0' + MODULE;
const uiFile = (name) =>
    /^(?:App\.tsx|(?:components|pages)\/.*\.tsx)$/.test(name) &&
    !/(?:^|\/)(?:__tests__|fixtures)\/|\.(?:test|spec)\.tsx$/.test(name);

export function selectUiStrings(counts) {
    const candidates = [...counts]
        .filter(([value, count]) => value.length >= 80 && value.length <= 8192 && count >= 1)
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
            selected.pop();
        }
    }
}

export function collectUiStrings(root) {
    const classes = new Set(collectClassNames(root)),
        counts = new Map();
    const files = ['App.tsx', ...fs.globSync(['components/**/*.tsx', 'pages/**/*.tsx'], { cwd: root })].sort();
    for (const file of files) {
        if (!uiFile(file.replaceAll('\\', '/')) || !fs.existsSync(path.join(root, file))) continue;
        const source = ts.createSourceFile(
            file,
            fs.readFileSync(path.join(root, file), 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX,
        );
        function visit(node) {
            if (ts.isStringLiteralLike(node) && !classes.has(node.text)) {
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
                if (!symbol && node.text.length >= 80) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return selectUiStrings(counts);
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
export function shareUiStrings(root) {
    let enabled = false,
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
            if (enabled) values = collectUiStrings(root);
        },
        resolveId(id) {
            return id === MODULE ? RESOLVED : null;
        },
        load(id) {
            return id === RESOLVED ? packClassNames(values).code : null;
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
