/** Representation only: pinned Mapbox main-renderer GLSL, never serialized
 * worker callbacks, executable SDK source, billing, telemetry or public APIs. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import ts from 'typescript';
import MagicString from 'magic-string';

export const MAPBOX_SHADER_SOURCE_SHA = '07cd585ebf678c90e00e70c5d02b0ea7c8c2d76df6dc8e599ddc4de0ffe5f9b4';
const MODULE = 'virtual:thalassa-mapbox-shader-data';
const RESOLVED = '\0' + MODULE;
const binding = '__thalassaMapboxShaderValues';
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Exact original GLSL chunks are single dictionary entries. The existing
 * decoder admits embedded whitespace in an entry; one-token rows preserve it
 * without introducing space separators. No decoder/resource bound changes. */
export function packShaderRows(rows) {
    if (
        !Array.isArray(rows) ||
        !rows.length ||
        rows.length > 4096 ||
        rows.some((row) => typeof row !== 'string' || row.length < 1 || row.length > 2048) ||
        rows.reduce((sum, row) => sum + row.length, 0) > 256000
    )
        throw Error('Mapbox shader rows exceed unchanged decoder bounds');
    const words = [...new Set(rows)],
        indexes = new Map(words.map((word, i) => [word, i.toString(36)])),
        raw = Buffer.from(JSON.stringify([words, rows.map((row) => indexes.get(row))]));
    if (raw.length > 128000) throw Error('Mapbox shader rows exceed unchanged decoder bounds');
    const zipped = deflateSync(raw, { level: 9 }),
        encoded = zipped.toString('base64');
    if (encoded.length > 64000) throw Error('Mapbox shader rows exceed unchanged decoder bounds');
    return { encoded, bytes: raw.length, count: rows.length, checksum: zipped.readUInt32BE(zipped.length - 4) };
}

/** @param {string} code @param {string} [file] */
export function packMapboxShaderSource(code, file = 'mapbox-gl/dist/mapbox-gl.js') {
    if (hash(code.replace(/\r\n/g, '\n')) !== MAPBOX_SHADER_SOURCE_SHA || code.includes(binding))
        throw Error('Unreviewed Mapbox shader source');
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const chunks = [];
    const collect = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'define' &&
            node.arguments.length === 2 &&
            ts.isArrayLiteralExpression(node.arguments[0]) &&
            ts.isFunctionExpression(node.arguments[1])
        )
            chunks.push(node.arguments[1]);
        ts.forEachChild(node, collect);
    };
    collect(source);
    if (chunks.length !== 3) throw Error('Unreviewed Mapbox worker/main boundary');
    const main = chunks[2];
    const literals = [];
    const visit = (node) => {
        if (
            (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
            node.text.length >= 100 &&
            /void main\s*\(|precision (?:highp|mediump)|#define SHADER_NAME/.test(node.text)
        ) {
            let parent = node.parent;
            while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
            if (parent !== main) throw Error('A Mapbox shader crossed the main-renderer boundary');
            literals.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (literals.length !== 89) throw Error('Unreviewed Mapbox shader inventory');
    const rows = [],
        spans = [];
    for (const node of literals) {
        const start = rows.length;
        for (let i = 0; i < node.text.length; i += 2048) rows.push(node.text.slice(i, i + 2048));
        spans.push({ start, end: rows.length });
    }
    if (rows.length !== 139) throw Error('Unreviewed Mapbox shader row inventory');
    // Reviewed source-order boundary: two ordinary bounded tuples. No row or
    // shader order changes; each <=2048-code-unit chunk is restored verbatim.
    const pools = [packShaderRows(rows.slice(0, 65)), packShaderRows(rows.slice(65))];
    const table =
        `import {decodeClassNames} from 'virtual:thalassa-class-data-decoder';` +
        `export const values=(()=>{` +
        pools
            .map(
                (p, i) =>
                    `const p${i}=decodeClassNames(${JSON.stringify(p.encoded)},${p.bytes},${p.count},${p.checksum});`,
            )
            .join('') +
        `const rows=[...p0,...p1];return Object.freeze([${spans.map((span) => (span.end === span.start + 1 ? `rows[${span.start}]` : `rows.slice(${span.start},${span.end}).join('')`)).join(',')}]);})();`;
    const output = new MagicString(code);
    literals.forEach((node, i) => output.overwrite(node.getStart(source), node.end, `${binding}[${i}]`));
    const prelude = `var ${binding}=require(${JSON.stringify(MODULE)}).values;\n`;
    output.prepend(prelude);
    const transformed = output.toString();
    // These callbacks are serialized by Mapbox's existing runtime. They must
    // retain their original source bytes and acquire no external bindings.
    for (const worker of chunks.slice(0, 2)) {
        const original = code.slice(worker.getStart(source), worker.end);
        if (!transformed.includes(original)) throw Error('Mapbox serialized worker bytes changed');
    }
    return {
        code: transformed,
        map: output.generateMap({ source: file, includeContent: true, hires: true }),
        table,
        values: literals.map((node) => node.text),
        originalLiterals: literals.map((node) => node.getText(source)),
        pools,
        rows,
        spans,
        prelude,
        workers: chunks.slice(0, 2).map((node) => code.slice(node.getStart(source), node.end)),
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function packMapboxShaders(root) {
    const file = path.resolve(root, 'node_modules/mapbox-gl/dist/mapbox-gl.js');
    const clean = (value) => value.replaceAll('\\', '/');
    const target = clean(fs.realpathSync(file));
    let enabled = false,
        table = null;
    return {
        name: 'pack-pinned-mapbox-main-shaders',
        apply: 'build',
        enforce: 'pre',
        configResolved(config) {
            enabled = config.isProduction && !config.isWorker;
        },
        resolveId(id) {
            return enabled && id === MODULE ? RESOLVED : null;
        },
        load(id) {
            return enabled && id === RESOLVED ? table : null;
        },
        transform(code, id) {
            if (!enabled || id.includes('?') || clean(id) !== target) return null;
            const result = packMapboxShaderSource(code, id);
            table = result.table;
            return { code: result.code, map: result.map };
        },
    };
}
