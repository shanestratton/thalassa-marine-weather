/** Remove only the unused, self-contained HTML/canvas emulation plugins from
 * the reviewed jsPDF browser build. PDF primitives, image formats and fonts
 * stay intact. The optional AcroForm cut removes its reviewed, unused
 * registration region only. Unknown bytes or AST structure fail closed. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import MagicString from 'magic-string';

export const JSPDF_ES_SHA256 = '5b7f65fa3928b104febbcc37c7174f8e5aa3b8d9d24d0378a3fecad693d86f76';
const PLUGINS = {
    canvas: { symbol: 'Canvas', sha: '030827338cc6572221ba9590f56d41dee62cd5a196c23e480d38c97b07534bfe' },
    context2d: { symbol: 'Context2D', sha: 'd6468adbea639ea19f00050aaff071f46cf36f447b2f7d7432227286967c7eb6' },
    html: { symbol: 'loadHtml2Canvas', sha: '66e22063645153124ff2789f9f0be81c8007f7ae07fb85bae55978822b805f6d' },
};
const sha = (code) => createHash('sha256').update(code).digest('hex');
const ACROFORM_SHA256 = '5101634ff10803fcd6a17b731426c401355534cd915f5b4ecadc99dc11010fd7';
const ACROFORM_EXPORTS = [
    'AcroForm',
    'AcroFormAppearance',
    'AcroFormButton',
    'AcroFormCheckBox',
    'AcroFormChoiceField',
    'AcroFormComboBox',
    'AcroFormEditBox',
    'AcroFormListBox',
    'AcroFormPasswordField',
    'AcroFormPushButton',
    'AcroFormRadioButton',
    'AcroFormTextField',
];

/** @param {string} code @param {(source:string)=>any} parse */
export function pruneJspdfPlugins(code, parse, { acroform = false } = {}) {
    if (sha(code) !== JSPDF_ES_SHA256) throw Error('Unreviewed jsPDF ESM source; review the primitive-only transform');
    const found = new Map();
    const program = parse(code);
    for (const node of program.body) {
        const call = node.type === 'ExpressionStatement' ? node.expression : null;
        if (
            call?.type !== 'CallExpression' ||
            call.callee.type !== 'FunctionExpression' ||
            call.callee.params.length !== 1 ||
            call.callee.params[0].name !== 'jsPDFAPI' ||
            call.arguments.length !== 1 ||
            call.arguments[0].type !== 'MemberExpression' ||
            call.arguments[0].computed ||
            call.arguments[0].object.name !== 'jsPDF' ||
            call.arguments[0].property.name !== 'API'
        )
            continue;
        const declarations = call.callee.body.body.flatMap((statement) =>
            statement.type === 'FunctionDeclaration'
                ? [statement.id?.name]
                : statement.type === 'VariableDeclaration'
                  ? statement.declarations.map((declaration) => declaration.id.name)
                  : [],
        );
        for (const [name, expected] of Object.entries(PLUGINS)) {
            if (!declarations.includes(expected.symbol)) continue;
            if (found.has(name) || sha(code.slice(node.start, node.end)) !== expected.sha)
                throw Error('Unreviewed jsPDF plugin structure: ' + name);
            found.set(name, node);
        }
    }
    if (found.size !== 3) throw Error('Expected exactly three reviewed jsPDF HTML/canvas plugins');
    const output = new MagicString(code);
    for (const node of found.values()) output.remove(node.start, node.end);
    if (acroform) {
        const declaration = (name) =>
            program.body.filter(
                (node) =>
                    node.type === 'VariableDeclaration' && node.declarations.some((item) => item.id.name === name),
            );
        const first = declaration('jsPDFAPI'),
            last = declaration('AcroForm');
        if (first.length !== 1 || last.length !== 1 || sha(code.slice(first[0].start, last[0].end)) !== ACROFORM_SHA256)
            throw Error('Unreviewed jsPDF AcroForm registration region');
        const exports = program.body.filter((node) => node.type === 'ExportNamedDeclaration');
        if (exports.length !== 1 || exports[0].declaration || exports[0].source)
            throw Error('Unreviewed jsPDF export structure');
        const removed = exports[0].specifiers.filter((item) => ACROFORM_EXPORTS.includes(item.local.name));
        if (
            removed.length !== ACROFORM_EXPORTS.length ||
            removed.some((item, index) => item.local.name !== ACROFORM_EXPORTS[index])
        )
            throw Error('Unreviewed jsPDF AcroForm exports');
        output.remove(first[0].start, last[0].end);
        output.overwrite(
            exports[0].start,
            exports[0].end,
            `export {${exports[0].specifiers
                .filter((item) => !ACROFORM_EXPORTS.includes(item.local.name))
                .map((item) => code.slice(item.start, item.end))
                .join(',')}};`,
        );
    }
    return {
        code: output.toString(),
        map: output.generateMap({ source: 'jspdf.es.js', includeContent: true, hires: true }),
        plugins: [...found.keys()],
        acroFormRemoved: acroform,
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function jspdfPrimitives(root) {
    const dist = path.resolve(root, 'node_modules/jspdf/dist');
    const source = path.join(dist, 'jspdf.es.js');
    let enabled = false;
    return {
        name: 'jspdf-primitives',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            enabled = config.isProduction;
            if (enabled && JSON.parse(fs.readFileSync(path.join(dist, '../package.json'), 'utf8')).version !== '4.2.1')
                throw Error('Unreviewed jsPDF version');
        },
        resolveId(id) {
            if (enabled && id === 'jspdf') return source;
            return null;
        },
        transform(code, id) {
            if (!enabled || path.resolve(id.split('?')[0]) !== source) return null;
            const result = pruneJspdfPlugins(code, (value) => this.parse(value), { acroform: true });
            return { code: result.code, map: result.map };
        },
    };
}
