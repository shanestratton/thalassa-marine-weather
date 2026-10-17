/** Build-only, private synchronous codec for one pinned static JSON value.
 * Generated output is ordinary JavaScript inside the shared SDK factory.
 * No executable source is encoded as data, and no runtime import is added. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import ts from 'typescript';

export const FFLATE_SCHEMA_SOURCE_SHA = 'b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1';
export const SCHEMA_CODEC_BINDING = '__thalassaEmbeddedStyleSchema142';
export const SCHEMA_RAW_BYTES = 60_227;
export const SCHEMA_RAW_SHA = '47a1bb464b518ad9ff182eac5aa011fad032e5fa2ac8114a3ba4956316450c69';
export const SCHEMA_CODEC_SHA = '44d112460fed6fb04df2c8676d0206d6b77af8a6577a2d068359c65c8458a0d1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The normal dependency remains untouched. Only this private sync closure
 * omits encoder reverse maps and adds pre-write/complete-stream refusals. */
export function guardedSchemaInflateSource(source) {
    assert.equal(hash(source), FFLATE_SCHEMA_SOURCE_SHA, 'Unreviewed synchronous codec dependency');
    const ast = ts.createSourceFile('fflate.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const freb = ast.statements
        .filter(ts.isVariableStatement)
        .flatMap((node) => [...node.declarationList.declarations])
        .find((node) => node.name.getText(ast) === 'freb')
        ?.initializer?.getText(ast);
    assert.ok(freb, 'Missing original codec base-table helper');
    const cut = freb.indexOf('    // numbers here are at max 18 bits');
    assert.ok(cut > 0, 'Unreviewed codec reverse-map boundary');
    const baseOnly = freb.slice(0, cut) + '    return { b: b };\n}';
    const edits = [
        [freb, baseOnly],
        ['fl[28] = 258, revfl[258] = 28;', 'fl[28] = 258;'],
        [
            '                buf.set(dat.subarray(s, t), bt);',
            "                if (bt + l > buf.length) err(1, 'Embedded schema stored output overflow');\n                buf.set(dat.subarray(s, t), bt);",
        ],
        [
            '            if (sym < 256)\n                buf[bt++] = sym;',
            "            if (sym < 256) {\n                if (bt >= buf.length) err(1, 'Embedded schema literal output overflow');\n                buf[bt++] = sym;\n            }",
        ],
        [
            '                var end = bt + add;',
            "                var end = bt + add;\n                if (end > buf.length) err(1, 'Embedded schema match output overflow');",
        ],
        [
            '    return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);',
            "    var body = data.subarray(zls(data, opts && opts.dictionary), -4), state = { i: 2 };\n    var output = inflt(body, state, opts && opts.out, opts && opts.dictionary);\n    if (!state.f || Math.ceil(state.p / 8) !== body.length) err(0, 'Embedded schema incomplete or trailing stream');\n    return output;",
        ],
    ];
    let code = source;
    for (const [before, after] of edits) {
        assert.equal(code.split(before).length - 1, 1, 'Unreviewed synchronous codec guard site');
        code = code.replace(before, () => after);
    }
    let reversed = code;
    for (const [before, after] of [...edits].reverse()) reversed = reversed.replace(after, () => before);
    assert.equal(reversed, source, 'Private sync codec reversal failed');
    return { code, edits, originalBaseHelper: freb, baseOnlyHelper: baseOnly };
}

/** Analyse a function-local insertion, rather than allowing script globals. */
export function schemaCodecBuiltins(code) {
    const ast = parse(`function __schemaInsertion(){${code};return ${SCHEMA_CODEC_BINDING}}`, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        ranges: true,
    });
    const allowed = new Set([
        'Object',
        'Uint8Array',
        'Uint16Array',
        'Uint32Array',
        'Int32Array',
        'Array',
        'ArrayBuffer',
        'DataView',
        'Error',
        'Math',
        'Number',
        'String',
        'TextEncoder',
        'TextDecoder',
        'atob',
    ]);
    const references = analyze(ast, {
        ecmaVersion: 2022,
        sourceType: 'script',
        optimistic: false,
    }).globalScope.through.map((reference) => reference.identifier.name);
    const visit = (node) => {
        if (!node || typeof node.type !== 'string') return;
        assert.ok(node.type !== 'ImportExpression' && node.type !== 'WithStatement', 'Dynamic schema codec code');
        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
            assert.ok(
                node.callee.type !== 'Identifier' ||
                    !['eval', 'Function', 'fetch', 'importScripts', 'Worker', 'SharedWorker'].includes(
                        node.callee.name,
                    ),
                'Schema codec must remain ordinary local JavaScript',
            );
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) for (const child of value) visit(child);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    assert.ok(
        references.every((name) => allowed.has(name)),
        'Schema codec acquired an outer SDK/worker binding',
    );
    return [...new Set(references)].sort();
}

export function assertStandaloneSchemaCodec(code) {
    assert.equal(hash(code), SCHEMA_CODEC_SHA, 'Unreviewed ordinary-JS schema codec');
    return schemaCodecBuiltins(code);
}

/** This entry is compiled at build time; it is never stored as runtime data. */
export async function buildStandaloneSchemaCodec(root) {
    const file = fs.realpathSync(path.join(root, 'node_modules/fflate/esm/browser.js'));
    const packageFile = path.join(path.dirname(path.dirname(file)), 'package.json');
    assert.equal(JSON.parse(fs.readFileSync(packageFile, 'utf8')).version, '0.8.3');
    const guarded = guardedSchemaInflateSource(fs.readFileSync(file, 'utf8'));
    const entry = `import {unzlibSync} from ${JSON.stringify(file.replaceAll('\\', '/'))};
export function decode(encoded,bytes,checksum){
 if(typeof encoded!=='string'||encoded.length<8||encoded.length>64000||encoded.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||bytes!==60227||bytes>128000||!Number.isSafeInteger(checksum)||checksum<0||checksum>4294967295)throw Error('Embedded schema bounds');
 const input=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
 if(input.length<6||(input[0]&15)!==8||input[0]>>>4>7||((input[0]<<8)+input[1])%31||(input[1]&32))throw Error('Embedded schema header');
 if(new DataView(input.buffer,input.byteOffset+input.length-4,4).getUint32(0)!==checksum)throw Error('Embedded schema checksum');
 const output=unzlibSync(input,{out:new Uint8Array(bytes)});
 let a=1,b=0;for(let start=0;start<output.length;start+=5552){for(let i=start;i<Math.min(start+5552,output.length);i++){a+=output[i];b+=a;}a%=65521;b%=65521;}
 if(output.length!==bytes||(((b<<16)|a)>>>0)!==checksum)throw Error('Embedded schema checksum or length');
 return new TextDecoder('utf-8',{fatal:true}).decode(output);
}`;
    const result = await build({
        stdin: { contents: entry, resolveDir: root, sourcefile: 'bounded-schema-codec.mjs' },
        bundle: true,
        write: false,
        format: 'iife',
        globalName: SCHEMA_CODEC_BINDING,
        platform: 'browser',
        target: 'es2020',
        minify: true,
        plugins: [
            {
                name: 'pinned-private-sync-inflate',
                setup(builder) {
                    builder.onLoad({ filter: /fflate[\\/]esm[\\/]browser\.js$/ }, (args) => {
                        assert.equal(fs.realpathSync(args.path), file);
                        return { contents: guarded.code, loader: 'js' };
                    });
                },
            },
        ],
        logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const builtins = assertStandaloneSchemaCodec(code);
    return { code, builtins, sha256: hash(code), bytes: Buffer.byteLength(code), guarded };
}
