/** Remove only the unused, self-contained HTML/canvas emulation plugins from
 * the reviewed jsPDF browser build. PDF primitives, image formats, fonts and
 * AcroForm stay intact. Unknown package bytes or AST structure fail closed. */
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

/** @param {string} code @param {(source:string)=>any} parse */
export function pruneJspdfPlugins(code, parse) {
    if (sha(code) !== JSPDF_ES_SHA256) throw Error('Unreviewed jsPDF ESM source; review the primitive-only transform');
    const found = new Map();
    for (const node of parse(code).body) {
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
    return {
        code: output.toString(),
        map: output.generateMap({ source: 'jspdf.es.js', includeContent: true, hires: true }),
        plugins: [...found.keys()],
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
            const result = pruneJspdfPlugins(code, (value) => this.parse(value));
            return { code: result.code, map: result.map };
        },
    };
}
