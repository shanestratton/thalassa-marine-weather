/** Share repeated literal class strings. Values, attribute order, components,
 * dynamic classes and DOM nodes remain identical. The bounded decoder imports
 * only the shared inflate primitive, so the table has no application cycle. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import MagicString from 'magic-string';
import { deflateSync } from 'node:zlib';

const MODULE = 'virtual:thalassa-class-names';
const RESOLVED = '\0' + MODULE;
const DECODER = 'virtual:thalassa-class-data-decoder';
const DECODE_RESOLVED = '\0' + DECODER;
function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) walk(child, visit);
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

/** Literal class values only. Conditions, calls and template coercions keep
 * their original evaluation; only their resulting string branches are shared. */
function expressionStrings(node, add) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text);
    else if (ts.isParenthesizedExpression(node)) expressionStrings(node.expression, add);
    else if (ts.isConditionalExpression(node)) {
        expressionStrings(node.whenTrue, add);
        expressionStrings(node.whenFalse, add);
    } else if (
        ts.isBinaryExpression(node) &&
        [
            ts.SyntaxKind.PlusToken,
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
    ) {
        expressionStrings(node.left, add);
        expressionStrings(node.right, add);
    } else if (ts.isTemplateExpression(node)) {
        add(node.head.text);
        for (const span of node.templateSpans) {
            expressionStrings(span.expression, add);
            add(span.literal.text);
        }
    }
}

/** Multiline JSX whitespace that normalizes differently misses the exact
 * lookup and remains unchanged. Dynamic expressions are never evaluated here. */
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
            if (ts.isJsxAttribute(node) && node.name.getText(source) === 'className' && node.initializer) {
                const add = (value) => counts.set(value, (counts.get(value) ?? 0) + 1);
                if (ts.isStringLiteral(node.initializer)) add(node.initializer.text);
                else if (ts.isJsxExpression(node.initializer) && node.initializer.expression)
                    expressionStrings(node.initializer.expression, add);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return selectClassNames(counts);
}

/** Long unique literals also share their CSS words with the pool. Keep the
 * existing decoder limits and reserve output space for exceptional strings. */
export function selectClassNames(counts) {
    const repeated = [...counts]
        .filter(
            ([value, count]) =>
                count >= 2 && (value.length + 2) * count - Math.ceil(value.length / 3) - 5 * count >= 24,
        )
        .map(([value]) => value);
    const extras = [];
    let restored = repeated.reduce((sum, value) => sum + value.length, 0);
    const candidates = [...counts]
        .filter(([value, count]) => count === 1 && value.length >= 100 && value.length <= 4095)
        .map(([value]) => value)
        .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    for (const value of candidates) {
        if (restored + value.length > 240_000) continue;
        extras.push(value);
        restored += value.length;
    }
    for (;;) {
        const values = [...repeated, ...extras].sort();
        try {
            packClassNames(values);
            return values;
        } catch (error) {
            if (
                !extras.length ||
                ![
                    'Embedded class table exceeds reviewed bounds',
                    'Embedded class encoding exceeds reviewed bounds',
                ].includes(error.message)
            )
                throw error;
            extras.length = Math.floor(extras.length * 0.9);
        }
    }
}

/** Encode repeated CSS words once, reconstructing exact strings at module
 * initialization. Splitting/joining on the literal space preserves repeated
 * spaces, tabs, escapes and Unicode; no class is normalized or evaluated. */
export function classTableSource(values) {
    const words = [...new Set(values.flatMap((value) => value.split(' ')))].sort();
    const indexes = new Map(words.map((word, index) => [word, index.toString(36)]));
    const encoded = values.map((value) =>
        value
            .split(' ')
            .map((word) => indexes.get(word))
            .join(' '),
    );
    const direct = `export const values=/* @__PURE__ */Object.freeze(${JSON.stringify(values)});`;
    const packed = `const words=${JSON.stringify(words)};export const values=/* @__PURE__ */Object.freeze(${JSON.stringify(encoded)}.map(value=>value.split(' ').map(index=>words[parseInt(index,36)]).join(' ')));`;
    return packed.length < direct.length ? packed : direct;
}

/** Same word table and indexes, stored as bounded compressed JSON. */
export function packClassNames(values) {
    const words = [...new Set(values.flatMap((value) => value.split(' ')))].sort();
    const indexes = new Map(words.map((word, index) => [word, index.toString(36)]));
    const rows = values.map((value) =>
        value
            .split(' ')
            .map((word) => indexes.get(word))
            .join(' '),
    );
    const raw = Buffer.from(JSON.stringify([words, rows]));
    if (raw.length > 128_000 || values.length > 4096 || words.length > 8192)
        throw Error('Embedded class table exceeds reviewed bounds');
    const zipped = deflateSync(raw, { level: 9 });
    const encoded = zipped.toString('base64');
    if (encoded.length > 64_000) throw Error('Embedded class encoding exceeds reviewed bounds');
    const checksum = zipped.readUInt32BE(zipped.length - 4);
    return {
        encoded,
        bytes: raw.length,
        count: values.length,
        checksum,
        code: `import {decodeClassNames} from '${DECODER}';export const values=decodeClassNames(${JSON.stringify(encoded)},${raw.length},${values.length},${checksum});`,
    };
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
    const replaced = new Set();
    const shareValue = (value) => {
        if (value.type === 'Literal' && typeof value.value === 'string') {
            const index = indexes.get(value.value);
            if (index === undefined || replaced.has(value.start)) return;
            output.overwrite(value.start, value.end, `${prefix}[${index}]`);
            replaced.add(value.start);
            replacements++;
        } else if (value.type === 'ConditionalExpression') {
            shareValue(value.consequent);
            shareValue(value.alternate);
        } else if (
            value.type === 'LogicalExpression' ||
            (value.type === 'BinaryExpression' && value.operator === '+')
        ) {
            shareValue(value.left);
            shareValue(value.right);
        } else if (value.type === 'TemplateLiteral') {
            for (const quasi of value.quasis) {
                const index = indexes.get(quasi.value.cooked);
                if (index === undefined || replaced.has(quasi.start)) continue;
                // Retain template coercion and expression order. The inserted
                // value is an immutable primitive string, never source text.
                output.overwrite(quasi.start, quasi.end, '${' + prefix + '[' + index + ']}');
                replaced.add(quasi.start);
                replacements++;
            }
            for (const expression of value.expressions) shareValue(expression);
        }
    };
    walk(parse(code), (node) => {
        if (
            node.type !== 'Property' ||
            node.computed ||
            node.method ||
            node.kind !== 'init' ||
            (node.key.name ?? node.key.value) !== 'className'
        )
            return;
        shareValue(node.value);
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
            return id === MODULE ? RESOLVED : id === DECODER ? DECODE_RESOLVED : null;
        },
        load(id) {
            if (id === DECODE_RESOLVED)
                return `export {decodeClassNames} from ${JSON.stringify(path.resolve(root, 'utils/decodeClassNames.ts'))};`;
            if (id !== RESOLVED) return null;
            const ordinary = classTableSource(values),
                packed = packClassNames(values);
            return packed.code.length + 1600 < ordinary.length ? packed.code : ordinary;
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
