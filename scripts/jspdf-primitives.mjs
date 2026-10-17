/** Reviewed app-only jsPDF build: preserve PDF primitives, all image codecs,
 * bidi/Arabic, font registrations/IDs and every used standard-font metric.
 * Remove only unused emulation/forms/custom-font/table APIs; production
 * consumers are checked. Unknown package bytes or AST shape fail closed. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import MagicString from 'magic-string';
import ts from 'typescript';

export const JSPDF_ES_SHA256 = '5b7f65fa3928b104febbcc37c7174f8e5aa3b8d9d24d0378a3fecad693d86f76';
const PLUGINS = {
    canvas: { symbol: 'Canvas', sha: '030827338cc6572221ba9590f56d41dee62cd5a196c23e480d38c97b07534bfe' },
    context2d: { symbol: 'Context2D', sha: 'd6468adbea639ea19f00050aaff071f46cf36f447b2f7d7432227286967c7eb6' },
    html: { symbol: 'loadHtml2Canvas', sha: '66e22063645153124ff2789f9f0be81c8007f7ae07fb85bae55978822b805f6d' },
};
const sha = (code) => createHash('sha256').update(code).digest('hex');
const ACROFORM_SHA256 = '5101634ff10803fcd6a17b731426c401355534cd915f5b4ecadc99dc11010fd7';
const STANDARD_ONLY_PLUGINS = {
    cell: { symbol: 'NO_MARGINS', sha: '2aaafa3da713c84fade3fbb4f670028adbe29b762d8bf0db27881a906b9de258' },
    ttf: {
        symbol: 'addFont',
        sha: 'c5cbf664232f31b0e140dcd45c0a5974dfbe49f7ae2fc8fb91e7a98ad83d5a81',
    },
    utf8: { symbol: 'utf8TextFunction', sha: '3388c1bc3851e499bb43b9d98d8d6bf2088a6a1fb708169be0eb209ad76e632d' },
    vfs: { symbol: '_initializeVFS', sha: '306c9de59de6ea5894fba949d49abb5d513ca6ec153e6169d4069706f09be759' },
};
const TTF_REGION_SHA = '84ee74c279f26165f1fdc5240a8e764a6a69d032240e9f4941181c9819dd0f35';
const FONT_METRICS_SHA = '2817dbf0593e9d97be68dc58d9048498b2ef6dc2ce4bee43d60804b20903000b';
const RETAINED_METRICS = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Courier'];
const BIDI_LITERAL_SHA = 'f7580897fde81bc45dcae61f664fca651fe4509c0ed33de76d0857206aa1c13c';
const BIDI_VALUES_SHA = 'adf675476359b5604f7b0e3da0403e9104b785e6ff2a1b53ed20ac8a309e4d35';

/** Private constant data only. The bidi algorithm and all 2,048 classes stay unchanged. */
export function encodeJspdfBidi(values) {
    if (values.length !== 2048 || sha(JSON.stringify(values)) !== BIDI_VALUES_SHA)
        throw Error('Unreviewed jsPDF bidi classes');
    const categories = [...new Set(values)];
    const runs = [];
    for (const value of values) {
        if (runs.length && runs.at(-1)[0] === value) runs.at(-1)[1] += 1;
        else runs.push([value, 1]);
    }
    const encoded = runs
        .map(([value, count]) => String.fromCharCode(65 + categories.indexOf(value)) + count.toString(36))
        .join('');
    if (categories.length !== 23 || runs.length !== 231 || encoded.length !== 474)
        throw Error('Unreviewed jsPDF bidi runs');
    const decoder = `(function(s){var types=${JSON.stringify(categories)},out=[],re=/([A-W])([0-9a-z]+)/g,m,last=0;if(s.length!==474)throw Error('PDF bidi data');while((m=re.exec(s))){var n=parseInt(m[2],36);if(m.index!==last||n<1||out.length+n>2048)throw Error('PDF bidi data');for(var i=0;i<n;i++)out.push(types[m[1].charCodeAt(0)-65]);last=re.lastIndex;}if(last!==s.length||out.length!==2048)throw Error('PDF bidi data');return out;})`;
    return { encoded, decoder, expression: decoder + '(' + JSON.stringify(encoded) + ')', values };
}
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
export function pruneJspdfPlugins(code, parse, { acroform = false, appFonts = false, packedBidi = false } = {}) {
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
    if (appFonts) {
        const extras = new Map();
        let metrics = null;
        for (const node of program.body) {
            const call = node.type === 'ExpressionStatement' ? node.expression : null;
            if (call?.type !== 'CallExpression' || call.callee.type !== 'FunctionExpression') continue;
            const declarations = call.callee.body.body.flatMap((statement) =>
                statement.type === 'FunctionDeclaration'
                    ? [statement.id?.name]
                    : statement.type === 'VariableDeclaration'
                      ? statement.declarations.map((item) => item.id.name)
                      : [],
            );
            for (const [name, expected] of Object.entries(STANDARD_ONLY_PLUGINS)) {
                if (!declarations.includes(expected.symbol)) continue;
                if (extras.has(name) || sha(code.slice(node.start, node.end)) !== expected.sha)
                    throw Error('Unreviewed jsPDF standard-font plugin: ' + name);
                extras.set(name, node);
            }
            for (const statement of call.callee.body.body) {
                if (statement.type !== 'VariableDeclaration') continue;
                for (const declaration of statement.declarations)
                    if (declaration.id.name === 'fontMetrics') {
                        if (metrics || sha(code.slice(declaration.start, declaration.end)) !== FONT_METRICS_SHA)
                            throw Error('Unreviewed jsPDF standard font metrics');
                        metrics = declaration;
                    }
            }
        }
        if (extras.size !== 4 || !metrics)
            throw Error('Expected four reviewed jsPDF standard-font plugins and metrics');
        const apiAssignment = (node, member) => {
            const expression = node.type === 'ExpressionStatement' ? node.expression : null;
            const target = expression?.type === 'AssignmentExpression' ? expression.left : null;
            return (
                target?.type === 'MemberExpression' &&
                !target.computed &&
                target.property.name === member &&
                target.object.type === 'MemberExpression' &&
                !target.object.computed &&
                target.object.object.name === 'jsPDF' &&
                target.object.property.name === 'API'
            );
        };
        const first = program.body.filter((node) => apiAssignment(node, 'TTFFont'));
        const last = program.body.filter((node) => apiAssignment(node, 'PDFObject'));
        if (first.length !== 1 || last.length !== 1 || sha(code.slice(first[0].start, last[0].end)) !== TTF_REGION_SHA)
            throw Error('Unreviewed jsPDF TrueType implementation region');
        for (const node of extras.values()) output.remove(node.start, node.end);
        output.remove(first[0].start, last[0].end);
        const unicode = metrics.init.properties;
        if (
            metrics.init.type !== 'ObjectExpression' ||
            unicode.length !== 1 ||
            (unicode[0].key.name ?? unicode[0].key.value) !== 'Unicode' ||
            unicode[0].value.type !== 'ObjectExpression'
        )
            throw Error('Unreviewed jsPDF Unicode metrics structure');
        const retained = unicode[0].value.properties.filter((item) =>
            RETAINED_METRICS.includes(item.key.name ?? item.key.value),
        );
        if (retained.length !== RETAINED_METRICS.length) throw Error('Missing retained jsPDF font metrics');
        output.overwrite(
            unicode[0].value.start,
            unicode[0].value.end,
            '{' +
                unicode[0].value.properties
                    .map((item) =>
                        retained.includes(item)
                            ? code.slice(item.start, item.end)
                            : JSON.stringify(item.key.name ?? item.key.value) + ':{widths:{},kerning:{}}',
                    )
                    .join(',') +
                '}',
        );
    }
    let bidiTable = null;
    if (packedBidi) {
        const arrays = [];
        for (const node of program.body) {
            const call = node.type === 'ExpressionStatement' ? node.expression : null;
            if (call?.type !== 'CallExpression' || call.callee.type !== 'FunctionExpression') continue;
            for (const statement of call.callee.body.body)
                if (statement.type === 'VariableDeclaration')
                    for (const item of statement.declarations)
                        if (item.id.name === 'bidiUnicodeTypes') arrays.push(item.init);
        }
        if (
            arrays.length !== 1 ||
            arrays[0].type !== 'ArrayExpression' ||
            sha(code.slice(arrays[0].start, arrays[0].end)) !== BIDI_LITERAL_SHA ||
            arrays[0].elements.some((item) => item?.type !== 'Literal' || typeof item.value !== 'string')
        )
            throw Error('Unreviewed jsPDF bidi initializer');
        bidiTable = encodeJspdfBidi(arrays[0].elements.map((item) => item.value));
        output.overwrite(arrays[0].start, arrays[0].end, bidiTable.expression);
    }
    return {
        code: output.toString(),
        map: output.generateMap({ source: 'jspdf.es.js', includeContent: true, hires: true }),
        plugins: [...found.keys()],
        acroFormRemoved: acroform,
        appFontsOnly: appFonts,
        bidiTable,
    };
}

const UNSUPPORTED = new Set([
    'addFont',
    'addFileToVFS',
    'getFileFromVFS',
    'existsFileInVFS',
    'TTFFont',
    'PDFObject',
    'getFontList',
    'setFontStyle',
    'cell',
    'cellAddPage',
    'table',
    'setHeaderFunction',
    'getTextDimensions',
    'setTableHeaderRow',
    'printHeaderRow',
]);
const API_PATTERN = new RegExp('\\b(?:' + ['setFont', ...UNSUPPORTED].join('|') + ')\\b');
function literalStrings(node) {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isParenthesizedExpression(node)) return literalStrings(node.expression);
    if (ts.isConditionalExpression(node)) {
        const yes = literalStrings(node.whenTrue),
            no = literalStrings(node.whenFalse);
        return yes && no ? [...yes, ...no] : null;
    }
    return null;
}

/** Guard actual production modules too, so a future font/API use fails the build. */
export function assertJspdfAppApis(code, filename) {
    if (!API_PATTERN.test(code)) return;
    const file = filename.replaceAll('\\', '/');
    const pdfConsumer = /['"]jspdf['"]|\bnew\s+jsPDF\b/.test(code);
    const tree = ts.createSourceFile(
        file,
        code,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const fail = (name) => {
        throw Error('Unsupported jsPDF app font/API ' + name + ' in ' + file);
    };
    const pdfReceiver = (node) => !!node && /(?:^|\.)(?:doc|pdf|pdfDoc)$/.test(node.getText(tree));
    const customTable = (node) => {
        if (
            !file.endsWith('/services/MaintenancePdfService.ts') ||
            !ts.isPropertyAccessExpression(node) ||
            !ts.isIdentifier(node.expression) ||
            node.expression.text !== 'page'
        )
            return false;
        let scope = node.parent;
        while (scope && !ts.isFunctionDeclaration(scope)) scope = scope.parent;
        const declaration = scope?.body?.statements
            .flatMap((statement) =>
                ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
                    ? statement.declarationList.declarations
                    : [],
            )
            .find((item) => ts.isIdentifier(item.name) && item.name.text === 'page');
        if (
            !declaration?.initializer ||
            !ts.isNewExpression(declaration.initializer) ||
            !ts.isIdentifier(declaration.initializer.expression) ||
            declaration.initializer.expression.text !== 'MaintenancePage'
        )
            return false;
        const type = tree.statements.find(
            (statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'MaintenancePage',
        );
        return !!type?.members.some(
            (member) =>
                ts.isMethodDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.name.text === 'table' &&
                member.body,
        );
    };
    const visit = (node) => {
        const name = ts.isPropertyAccessExpression(node)
            ? node.name.text
            : ts.isElementAccessExpression(node) &&
                node.argumentExpression &&
                ts.isStringLiteralLike(node.argumentExpression)
              ? node.argumentExpression.text
              : null;
        if (name === 'setFont') {
            const selfWrapper =
                file.endsWith('/services/pdf/pdfText.ts') &&
                ts.isPropertyAccessExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ThisKeyword;
            if (!selfWrapper) {
                const call = node.parent;
                if (
                    !ts.isCallExpression(call) ||
                    call.expression !== node ||
                    call.arguments.length < 1 ||
                    call.arguments.length > 2
                )
                    fail(name);
                const families = literalStrings(call.arguments[0]),
                    styles = call.arguments.length === 1 ? ['normal'] : literalStrings(call.arguments[1]);
                if (
                    !families?.length ||
                    !styles?.length ||
                    families.some((family) => !['helvetica', 'courier'].includes(family)) ||
                    styles.some((style) => !['normal', 'bold', 'italic', 'bolditalic'].includes(style)) ||
                    (families.includes('courier') && styles.some((style) => style !== 'normal'))
                )
                    fail(name);
            }
        } else if (
            UNSUPPORTED.has(name) &&
            ((pdfConsumer && ts.isCallExpression(node.parent) && node.parent.expression === node) ||
                ![
                    'cell',
                    'cellAddPage',
                    'table',
                    'setHeaderFunction',
                    'getTextDimensions',
                    'setTableHeaderRow',
                    'printHeaderRow',
                ].includes(name) ||
                pdfReceiver(node.expression)) &&
            !(name === 'table' && customTable(node))
        )
            fail(name);
        if (
            ts.isBindingElement(node) &&
            ts.isIdentifier(node.propertyName ?? node.name) &&
            (['setFont', ...UNSUPPORTED]
                .filter(
                    (name) =>
                        ![
                            'cell',
                            'cellAddPage',
                            'table',
                            'setHeaderFunction',
                            'getTextDimensions',
                            'setTableHeaderRow',
                            'printHeaderRow',
                        ].includes(name),
                )
                .includes((node.propertyName ?? node.name).text) ||
                (pdfReceiver(node.parent.parent?.initializer) &&
                    UNSUPPORTED.has((node.propertyName ?? node.name).text)))
        )
            fail('aliased font/API');
        ts.forEachChild(node, visit);
    };
    visit(tree);
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
            if (
                enabled &&
                !id.includes('/node_modules/') &&
                !id.includes('\\node_modules\\') &&
                /\.[cm]?[jt]sx?(?:\?|$)/.test(id)
            )
                assertJspdfAppApis(code, id.split('?')[0]);
            if (!enabled || path.resolve(id.split('?')[0]) !== source) return null;
            const result = pruneJspdfPlugins(code, (value) => this.parse(value), {
                acroform: true,
                appFonts: true,
                packedBidi: true,
            });
            return { code: result.code, map: result.map };
        },
    };
}
