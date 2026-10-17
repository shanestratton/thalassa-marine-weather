/** Representation only: exact, authored display prose. Encoded bytes remain
 * JavaScript and count against the ordinary release budget. No DOM, fetch,
 * feature flag, catalogue admission, executable text or new decoder. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import ts from 'typescript';
import MagicString from 'magic-string';

export const AUTHORED_PROSE_SOURCES = Object.freeze({
    'services/reference/skipperReferenceCards.ts': {
        sha256: '9fe84c62cfffc09d2595766e9d63592fd67474a1d158c0e9833038d88a52829d',
        literals: 77,
    },
    'services/TripOverviewService.ts': {
        sha256: '72bbf55ff9474e85da6647aaf8ff4318134e6a21c90f062d99962d3e97602876',
        literals: 32,
    },
});
const MODULE = 'virtual:thalassa-authored-prose';
const RESOLVED = '\0' + MODULE;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const clean = (name) => name.replaceAll('\\', '/');

/** The compiler's cooked value, never raw template/source text. Untagged
 * templates with expressions remain untouched, including coercion/order. */
export function authoredProseLiterals(code, file) {
    if (!Object.hasOwn(AUTHORED_PROSE_SOURCES, file)) return [];
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rows = [];
    const visit = (node) => {
        if (
            ts.isTaggedTemplateExpression(node) ||
            ts.isImportDeclaration(node) ||
            ts.isExportDeclaration(node) ||
            ts.isImportEqualsDeclaration(node)
        )
            return;
        if (
            (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
            (['URL', 'Worker', 'SharedWorker', 'importScripts', 'import'].includes(node.expression.getText(source)) ||
                ['import.meta.glob', 'import.meta.globEager'].includes(node.expression.getText(source)))
        )
            return;
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.length >= 40) {
            const parent = node.parent;
            const symbol =
                ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) ||
                ts.isLiteralTypeNode(parent) ||
                ts.isExternalModuleReference(parent) ||
                ts.isExpressionStatement(parent);
            if (!symbol) rows.push({ start: node.getStart(source), end: node.end, value: node.text });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return rows;
}

/** One original string is one dictionary entry and a one-token output row.
 * The existing decoder already admits spaces in entries and restores these
 * exact values with unchanged bounds/checksum/freeze rules. */
export function packAuthoredProseValues(values) {
    if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > 4096 ||
        values.some((value) => typeof value !== 'string' || value.length > 4096) ||
        values.reduce((sum, value) => sum + value.length, 0) > 256000
    )
        throw Error('Authored prose exceeds unchanged decoder bounds');
    const raw = Buffer.from(JSON.stringify([values, values.map((_, i) => i.toString(36))]));
    if (raw.length > 128000) throw Error('Authored prose exceeds unchanged decoder bounds');
    const zipped = deflateSync(raw, { level: 9 }),
        encoded = zipped.toString('base64');
    if (encoded.length > 64000) throw Error('Authored prose exceeds unchanged decoder bounds');
    return { encoded, bytes: raw.length, count: values.length, checksum: zipped.readUInt32BE(zipped.length - 4) };
}

export function rewriteAuthoredProse(code, file, values) {
    const rows = authoredProseLiterals(code, file);
    if (!rows.length) return null;
    const indexes = new Map(values.map((value, i) => [value, i])),
        output = new MagicString(code);
    let binding = '__thalassaAuthoredProse';
    while (code.includes(binding)) binding += '_';
    for (const row of rows) {
        const index = indexes.get(row.value);
        if (index === undefined) throw Error('Authored prose is absent from its reviewed table');
        output.overwrite(row.start, row.end, `${binding}[${index}]`);
    }
    output.prepend(`import {values as ${binding}} from '${MODULE}';\n`);
    return {
        code: output.toString(),
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        rows,
        binding,
    };
}

export function collectAuthoredProse(root) {
    const records = Object.entries(AUTHORED_PROSE_SOURCES).map(([file, spec]) => {
        const code = fs.readFileSync(path.join(root, file), 'utf8');
        if (hash(code.replaceAll('\r\n', '\n')) !== spec.sha256)
            throw Error(`Unreviewed authored prose source: ${file}`);
        const rows = authoredProseLiterals(code, file);
        if (rows.length !== spec.literals) throw Error(`Unreviewed authored prose inventory: ${file}`);
        return { file, code, rows };
    });
    const values = [...new Set(records.flatMap(({ rows }) => rows.map(({ value }) => value)))].sort();
    if (values.length !== 106) throw Error('Unreviewed authored prose value count');
    return { records, values, packed: packAuthoredProseValues(values) };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function packAuthoredProse(root) {
    let enabled = false,
        reviewed;
    return {
        name: 'pack-exact-authored-prose',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            enabled = config.isProduction && !config.isWorker;
        },
        buildStart() {
            if (enabled) reviewed = collectAuthoredProse(root);
        },
        resolveId(id) {
            return enabled && id === MODULE ? RESOLVED : null;
        },
        load(id) {
            if (!enabled || id !== RESOLVED || !reviewed) return null;
            const { packed } = reviewed;
            return (
                `import {decodeClassNames} from ${JSON.stringify(clean(path.resolve(root, 'utils/decodeClassNames.ts')))};` +
                `export const values=decodeClassNames(${JSON.stringify(packed.encoded)},${packed.bytes},${packed.count},${packed.checksum});`
            );
        },
        transform(code, id) {
            if (!enabled || id.includes('?')) return null;
            const relative = clean(path.relative(root, id));
            if (!Object.hasOwn(AUTHORED_PROSE_SOURCES, relative)) return null;
            if (hash(code.replaceAll('\r\n', '\n')) !== AUTHORED_PROSE_SOURCES[relative].sha256)
                throw Error(`Unreviewed authored prose transform: ${relative}`);
            const result = rewriteAuthoredProse(code, relative, reviewed.values);
            return result && { code: result.code, map: result.map };
        },
    };
}
