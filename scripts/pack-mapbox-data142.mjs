/** Explicit data-only stages after the independently executable89-shader baseline.
 * Main GLSL remains outside serialized factories. One pinned shared JSON argument
 * uses a local ordinary-JS codec; no SDK program text is encoded or evaluated. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import ts from 'typescript';
import MagicString from 'magic-string';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import { packMapboxShaderSource, packShaderRows } from './pack-mapbox-shaders.mjs';
import {
    buildStandaloneSchemaCodec,
    assertStandaloneSchemaCodec,
    SCHEMA_CODEC_BINDING,
    SCHEMA_RAW_BYTES,
    SCHEMA_RAW_SHA,
} from './mapbox-schema-codec142.mjs';

const MODULE = 'virtual:thalassa-mapbox-shader-data';
const RESOLVED = '\0' + MODULE;
const binding = '__thalassaMapboxShaderValues';
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Check native references in the whole SDK lexical context as well as the
 * standalone closure: similarly named SDK bindings cannot capture them. */
function assertInsertedCodecBindings(code, start, length, builtins) {
    const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', ranges: true });
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'script', optimistic: false });
    const end = start + length,
        globals = new Set();
    for (const scope of scopes.scopes)
        for (const reference of scope.references) {
            const identifier = reference.identifier;
            if (identifier.start < start || identifier.end > end) continue;
            if (reference.resolved) {
                assert.ok(
                    reference.resolved.identifiers.every((node) => node.start >= start && node.end <= end),
                    'Schema codec captured an outer SDK variable',
                );
            } else {
                assert.ok(builtins.includes(identifier.name), 'Schema codec acquired a non-native global');
                globals.add(identifier.name);
            }
        }
    assert.deepEqual([...globals].sort(), builtins, 'Schema codec builtin resolution changed');
}

export function mapboxFactories(code) {
    const source = ts.createSourceFile('pinned-mapbox.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(source.parseDiagnostics.length, 0, 'Invalid Mapbox ordinary-JS syntax');
    const factories = [];
    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'define' &&
            node.arguments.length === 2 &&
            ts.isArrayLiteralExpression(node.arguments[0]) &&
            ts.isFunctionExpression(node.arguments[1])
        )
            factories.push(node.arguments[1]);
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(factories.length, 3, 'Unreviewed serialized factory inventory');
    return { source, factories, callbacks: factories.map((node) => code.slice(node.getStart(source), node.end)) };
}

/** Preserve the original89 transform as a real separately executable baseline.
 * This stage independently replaces100 main-only values, never callback0/1. */
export function packMapboxMainData142(code) {
    const baseline = packMapboxShaderSource(code);
    const { source, factories, callbacks } = mapboxFactories(code);
    const literals = [];
    const visit = (node) => {
        if (
            (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
            node.text.length >= 100 &&
            /void main\s*\(|precision (?:highp|mediump)|#define SHADER_NAME|uniform |#ifdef|#define/.test(node.text)
        ) {
            let owner = node.parent;
            while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
            assert.equal(owner, factories[2], 'GLSL crossed the main-renderer boundary');
            literals.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(literals.length, 100, 'Unreviewed main GLSL inventory');
    assert.deepEqual(
        literals
            .filter((node) => /void main\s*\(|precision (?:highp|mediump)|#define SHADER_NAME/.test(node.text))
            .map((node) => node.text),
        baseline.values,
        'Original89 GLSL values changed',
    );
    const rows = [],
        spans = [];
    for (const node of literals) {
        const start = rows.length;
        for (let i = 0; i < node.text.length; i += 2048) rows.push(node.text.slice(i, i + 2048));
        spans.push({ start, end: rows.length });
    }
    assert.equal(rows.length, 159, 'Unreviewed main GLSL row inventory');
    const pools = [packShaderRows(rows.slice(0, 85)), packShaderRows(rows.slice(85))];
    const table =
        `import {decodeClassNames} from 'virtual:thalassa-class-data-decoder';export const values=(()=>{` +
        pools
            .map(
                (p, i) =>
                    `const p${i}=decodeClassNames(${JSON.stringify(p.encoded)},${p.bytes},${p.count},${p.checksum});`,
            )
            .join('') +
        `const rows=[...p0,...p1];return Object.freeze([${spans.map((s) => (s.end === s.start + 1 ? `rows[${s.start}]` : `rows.slice(${s.start},${s.end}).join('')`)).join(',')}]);})();`;
    const output = new MagicString(code);
    literals.forEach((node, i) => output.overwrite(node.getStart(source), node.end, `${binding}[${i}]`));
    const prelude = `var ${binding}=require(${JSON.stringify(MODULE)}).values;\n`;
    output.prepend(prelude);
    const changed = output.toString();
    for (const callback of callbacks.slice(0, 2))
        assert.ok(changed.includes(callback), 'Main stage changed serialized callback bytes');
    const originalLiterals = literals.map((node) => node.getText(source));
    let reversed = changed.slice(prelude.length);
    originalLiterals.forEach((literal, i) => {
        reversed = reversed.replace(`${binding}[${i}]`, () => literal);
    });
    assert.equal(reversed, code, 'Main GLSL stage reversal failed');
    return {
        code: changed,
        table,
        baseline,
        rows,
        spans,
        pools,
        prelude,
        originalLiterals,
        values: literals.map((node) => node.text),
        callbacks,
        reversal: reversed,
    };
}

/** This stage changes only one JSON.parse argument and inserts its standalone
 * codec at the start of the shared factory. All other source reverses exactly. */
export function packMapboxSharedSchema142(code, codec) {
    assert.ok(!code.includes(SCHEMA_CODEC_BINDING), 'Schema local binding collision');
    const builtins = assertStandaloneSchemaCodec(codec);
    const { source, factories, callbacks } = mapboxFactories(code);
    const candidates = [];
    const visit = (node) => {
        if (ts.isStringLiteral(node) && node.text.startsWith('{"$version"')) candidates.push(node);
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(candidates.length, 1, 'Unreviewed shared schema inventory');
    const literal = candidates[0];
    let owner = literal.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    assert.equal(owner, factories[0], 'Schema escaped shared factory');
    assert.ok(
        ts.isCallExpression(literal.parent) &&
            literal.parent.expression.getText(source) === 'JSON.parse' &&
            literal.parent.arguments.length === 1 &&
            literal.parent.arguments[0] === literal,
        'Schema must be one original JSON.parse argument',
    );
    const raw = Buffer.from(literal.text, 'utf8');
    assert.equal(raw.length, SCHEMA_RAW_BYTES, 'Unreviewed schema bytes');
    assert.equal(hash(raw), SCHEMA_RAW_SHA, 'Unreviewed schema data');
    const zipped = deflateSync(raw, { level: 9 });
    const encoded = zipped.toString('base64'),
        checksum = zipped.readUInt32BE(zipped.length - 4);
    assert.ok(encoded.length <= 64000 && raw.length <= 128000, 'Schema tuple bounds');
    const call = `${SCHEMA_CODEC_BINDING}.decode(${JSON.stringify(encoded)},${raw.length},${checksum})`;
    const insertion = '\n' + codec + '\n';
    const output = new MagicString(code);
    output.overwrite(literal.getStart(source), literal.end, call);
    output.appendLeft(factories[0].body.getStart(source) + 1, insertion);
    const changed = output.toString();
    assert.equal(changed.split(call).length - 1, 1);
    assert.equal(changed.split(insertion).length - 1, 1);
    const reversed = changed.replace(insertion, '').replace(call, () => literal.getText(source));
    assert.equal(reversed, code, 'Shared schema stage reversal failed');
    const after = mapboxFactories(changed);
    assert.notEqual(after.callbacks[0], callbacks[0]);
    assert.deepEqual(after.callbacks.slice(1), callbacks.slice(1), 'Schema stage changed worker/main factory bytes');
    assertInsertedCodecBindings(changed, changed.indexOf(insertion) + 1, codec.length, builtins);
    return {
        code: changed,
        raw,
        encoded,
        checksum,
        call,
        insertion,
        originalLiteral: literal.getText(source),
        callbacks,
        builtins,
        reversal: reversed,
        map: output.generateMap({ includeContent: true, hires: true }),
    };
}

/** @param {string} root @returns {import('vite').Plugin} */
export function packMapboxData142(root) {
    const target = fs
        .realpathSync(path.resolve(root, 'node_modules/mapbox-gl/dist/mapbox-gl.js'))
        .replaceAll('\\', '/');
    assert.equal(
        JSON.parse(fs.readFileSync(path.resolve(root, 'node_modules/mapbox-gl/package.json'), 'utf8')).version,
        '3.19.0',
    );
    let enabled = false,
        table = null,
        codec;
    return {
        name: 'pack-pinned-mapbox-explicit-data142',
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
        async transform(code, id) {
            if (!enabled || id.includes('?') || id.replaceAll('\\', '/') !== target) return null;
            codec ??= buildStandaloneSchemaCodec(root);
            const main = packMapboxMainData142(code);
            const schema = packMapboxSharedSchema142(main.code, (await codec).code);
            table = main.table;
            // A direct source map is build diagnostic metadata only. Original
            // full SDK source is retained in sourcesContent for attribution.
            const map = new MagicString(code);
            map.overwrite(0, code.length, schema.code);
            return { code: schema.code, map: map.generateMap({ source: id, includeContent: true, hires: true }) };
        },
    };
}
