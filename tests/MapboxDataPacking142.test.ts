// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { constants, deflateRawSync, deflateSync } from 'node:zlib';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeClassNames } from '../utils/decodeClassNames';
import {
    mapboxFactories,
    packMapboxMainData142,
    packMapboxSharedSchema142,
    packMapboxData142,
} from '../scripts/pack-mapbox-data142.mjs';
import {
    buildStandaloneSchemaCodec,
    guardedSchemaInflateSource,
    schemaCodecBuiltins,
    SCHEMA_CODEC_BINDING,
    SCHEMA_CODEC_SHA,
    SCHEMA_RAW_SHA,
} from '../scripts/mapbox-schema-codec142.mjs';

const root = process.cwd();
const file = fs.realpathSync(path.resolve('node_modules/mapbox-gl/dist/mapbox-gl.js'));
const source = fs.readFileSync(file, 'utf8');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Decode = (encoded: string, bytes: number, checksum: number) => string;
let main: ReturnType<typeof packMapboxMainData142>;
let codec: Awaited<ReturnType<typeof buildStandaloneSchemaCodec>>;
let schema: ReturnType<typeof packMapboxSharedSchema142>;
let decode: Decode;
beforeAll(async () => {
    main = packMapboxMainData142(source);
    codec = await buildStandaloneSchemaCodec(root);
    schema = packMapboxSharedSchema142(main.code, codec.code);
    const context: Record<string, unknown> = {
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int32Array,
        ArrayBuffer,
        DataView,
        TextDecoder,
        atob,
    };
    vm.runInNewContext(codec.code, context, { timeout: 1000 });
    const entry = context[SCHEMA_CODEC_BINDING] as { decode: Decode };
    expect(typeof entry.decode).toBe('function');
    decode = entry.decode;
}, 40_000);

describe('explicit data-only SDK stages142', () => {
    it('keeps all89 original baseline values and exact100-main/159-row source reversal', () => {
        expect(main.baseline.values).toHaveLength(89);
        expect(main.baseline.rows).toHaveLength(139);
        const rows = main.pools.flatMap((p) => [...decodeClassNames(p.encoded, p.bytes, p.count, p.checksum)]);
        expect(rows).toEqual(main.rows);
        const values = main.spans.map((s) => rows.slice(s.start, s.end).join(''));
        expect(values).toEqual(main.values);
        expect(values).toHaveLength(100);
        for (const [i, value] of values.entries()) expect(Buffer.from(value)).toEqual(Buffer.from(main.values[i]));
        expect(main.pools.map((p) => [p.count, p.bytes, p.encoded.length])).toEqual([
            [85, 107019, 26960],
            [74, 101867, 27840],
        ]);
        expect(main.rows).toHaveLength(159);
        expect(main.reversal).toBe(source);
        for (const callback of main.callbacks.slice(0, 2)) expect(main.code).toContain(callback);
        expect(main.table).not.toMatch(/\bdocument\b|\beval\s*\(|new Function|readPackedUiData|readPreloadData/);
    });

    it('restores whole60227-byte JSON, key order and object values; exact one-argument/local-codec reversal', () => {
        const restored = decode(schema.encoded, schema.raw.length, schema.checksum);
        expect(Buffer.from(restored)).toEqual(schema.raw);
        expect(hash(restored)).toBe(SCHEMA_RAW_SHA);
        expect(JSON.stringify(JSON.parse(restored))).toBe(schema.raw.toString('utf8'));
        expect(Object.keys(JSON.parse(restored))).toEqual(Object.keys(JSON.parse(schema.raw.toString('utf8'))));
        expect(schema.reversal).toBe(main.code);
        expect(schema.code.split(schema.call)).toHaveLength(2);
        expect(schema.code.split(schema.insertion)).toHaveLength(2);
        const after = mapboxFactories(schema.code);
        expect(after.callbacks[0]).not.toBe(schema.callbacks[0]);
        expect(after.callbacks.slice(1)).toEqual(schema.callbacks.slice(1));
        expect(schema.code.replace(schema.insertion, '').replace(schema.call, () => schema.originalLiteral)).toBe(
            main.code,
        );
    });

    it('pins the actual SDK/dependency and ordinary-JS native-only codec closure', () => {
        expect(JSON.parse(fs.readFileSync('node_modules/mapbox-gl/package.json', 'utf8')).version).toBe('3.19.0');
        expect(
            JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages['node_modules/mapbox-gl'].version,
        ).toBe('3.19.0');
        expect(hash(source)).toBe('07cd585ebf678c90e00e70c5d02b0ea7c8c2d76df6dc8e599ddc4de0ffe5f9b4');
        expect(codec.bytes).toBe(5456);
        expect(codec.sha256).toBe(SCHEMA_CODEC_SHA);
        expect(codec.builtins).toEqual([
            'DataView',
            'Error',
            'Math',
            'Number',
            'Object',
            'TextDecoder',
            'Uint16Array',
            'Uint8Array',
            'atob',
        ]);
        expect(() => schemaCodecBuiltins('var local=outerSdkValue;')).toThrow(/outer SDK/);
        expect(() => schemaCodecBuiltins('eval("x")')).toThrow();
        expect(() => schemaCodecBuiltins('new Function("x")')).toThrow();
        expect(() => schemaCodecBuiltins('import("x")')).toThrow(/Dynamic/);
        expect(() => schemaCodecBuiltins('with({}){}')).toThrow(/Dynamic/);
        expect(() => packMapboxSharedSchema142(main.code + SCHEMA_CODEC_BINDING, codec.code)).toThrow(/collision/);
        expect(() => packMapboxSharedSchema142(main.code, codec.code + '\n')).toThrow(/Unreviewed/);
        const shadowed = main.code.replace(main.callbacks[0], () =>
            main.callbacks[0].replace('{', '{var TextDecoder;'),
        );
        expect(() => packMapboxSharedSchema142(shadowed, codec.code)).toThrow(/captured an outer SDK/);
        expect(() => packMapboxMainData142(source + '\n')).toThrow(/Unreviewed/);
    });

    it('refuses JSON argument, ownership and data drift without accepting alternate schema sources', () => {
        expect(() =>
            packMapboxSharedSchema142(
                main.code.replace(schema.originalLiteral, () => schema.originalLiteral + ', null'),
                codec.code,
            ),
        ).toThrow(/one original/);
        expect(() =>
            packMapboxSharedSchema142(
                main.code.replace('JSON.parse(' + schema.originalLiteral, 'other.parse(' + schema.originalLiteral),
                codec.code,
            ),
        ).toThrow(/one original/);
        const changed = schema.originalLiteral.replace('version', 'versioN');
        expect(() =>
            packMapboxSharedSchema142(
                main.code.replace(schema.originalLiteral, () => changed),
                codec.code,
            ),
        ).toThrow();
    });

    it('keeps the plugin inert for workers/development and query/foreign paths', () => {
        const plugin = packMapboxData142(root);
        // Vite plugin hooks are objects or functions in its full public type;
        // these concrete source hooks intentionally have one simple function form.
        const hook = plugin as unknown as {
            configResolved(config: { isProduction: boolean; isWorker: boolean }): void;
            resolveId(id: string): string | null;
            transform(code: string, id: string): Promise<unknown>;
        };
        hook.configResolved({ isProduction: false, isWorker: false });
        expect(hook.resolveId('virtual:thalassa-mapbox-shader-data')).toBeNull();
        hook.configResolved({ isProduction: true, isWorker: true });
        expect(hook.resolveId('virtual:thalassa-mapbox-shader-data')).toBeNull();
        hook.configResolved({ isProduction: true, isWorker: false });
        expect(hook.resolveId('virtual:thalassa-mapbox-shader-data')).toBe('\0virtual:thalassa-mapbox-shader-data');
        expect(hook.transform(source, file + '?foreign')).resolves.toBeNull();
        expect(hook.transform(source, file + '.other')).resolves.toBeNull();
    });

    it('connects the real source transform to its sole bounded virtual table with original source attribution', async () => {
        const hook = packMapboxData142(root) as unknown as {
            configResolved(config: { isProduction: boolean; isWorker: boolean }): void;
            load(id: string): string | null;
            transform(code: string, id: string): Promise<{ code: string; map: { sourcesContent: string[] } }>;
        };
        hook.configResolved({ isProduction: true, isWorker: false });
        expect(hook.load('\0virtual:thalassa-mapbox-shader-data')).toBeNull();
        const result = await hook.transform(source, file);
        expect(result.code).toBe(schema.code);
        expect(result.map.sourcesContent).toEqual([source]);
        expect(hook.load('\0virtual:thalassa-mapbox-shader-data')).toBe(main.table);
        expect(hook.load('\0virtual:foreign')).toBeNull();
    });

    it('preserves original31-word inflate base tables and reverses every private dependency edit', () => {
        const original = fs.readFileSync('node_modules/fflate/esm/browser.js', 'utf8');
        const guarded = guardedSchemaInflateSource(original);
        let restored = guarded.code;
        for (const [before, after] of [...guarded.edits].reverse()) restored = restored.replace(after, () => before);
        expect(restored).toBe(original);
        expect(() => guardedSchemaInflateSource(original + '\n')).toThrow(/Unreviewed/);
        const ast = ts.createSourceFile('fflate.js', original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const declaration = (name: string) =>
            ast.statements
                .filter(ts.isVariableStatement)
                .flatMap((n) => [...n.declarationList.declarations])
                .find((n) => n.name.getText(ast) === name)
                ?.initializer?.getText(ast);
        for (const [name, start] of [
            ['fleb', 2],
            ['fdeb', 0],
        ] as const) {
            const bits = declaration(name);
            expect(bits).toBeTruthy();
            const context = { u8: Uint8Array, u16: Uint16Array, i32: Int32Array };
            const a = vm.runInNewContext(`(${guarded.originalBaseHelper})(${bits},${start})`, context, {
                timeout: 1000,
            });
            const b = vm.runInNewContext(`(${guarded.baseOnlyHelper})(${bits},${start})`, context, { timeout: 1000 });
            expect(a.b.length).toBe(31);
            expect(Buffer.from(a.b.buffer)).toEqual(Buffer.from(b.b.buffer));
            expect(b.r).toBeUndefined();
            if (name === 'fdeb') expect(a.r.byteLength).toBe(131076);
        }
    });

    it('measures bounded typed backings during actual init/decode without claiming total heap or GC', () => {
        const allocations: { phase: string; bytes: number }[] = [],
            seen = new WeakSet<ArrayBufferLike>();
        let phase = 'init';
        const context: Record<string, unknown> = { ArrayBuffer, DataView, TextDecoder, atob };
        for (const [name, Type] of Object.entries({ Uint8Array, Uint16Array, Uint32Array, Int32Array })) {
            context[name] = new Proxy(Type, {
                construct(Target, args) {
                    const value = Reflect.construct(Target, args, Target) as Uint8Array;
                    if (!seen.has(value.buffer)) {
                        seen.add(value.buffer);
                        allocations.push({ phase, bytes: value.buffer.byteLength });
                    }
                    return value;
                },
            });
        }
        vm.runInNewContext(codec.code, context, { timeout: 1000 });
        phase = 'decode';
        const entry = context[SCHEMA_CODEC_BINDING] as { decode: Decode };
        expect(entry.decode(schema.encoded, schema.raw.length, schema.checksum)).toBe(schema.raw.toString('utf8'));
        expect(Math.max(...allocations.map((v) => v.bytes))).toBe(65536);
        expect(allocations.every((v) => v.bytes <= 128000)).toBe(true);
        expect(allocations.filter((v) => v.phase === 'init').reduce((s, v) => s + v.bytes, 0)).toBe(67207);
        expect(allocations.filter((v) => v.phase === 'decode').reduce((s, v) => s + v.bytes, 0)).toBe(77217);
    });
});

describe('18 concrete embedded schema refusal controls', () => {
    for (const bytes of [-1, 0, 60226, 60228, 128001, Infinity, NaN])
        it(`refuses declared size ${bytes}`, () => {
            expect(() => decode(schema.encoded, bytes, schema.checksum)).toThrow(/bounds/);
        });
    it('refuses encoded cap', () => expect(() => decode('A'.repeat(64004), 60227, schema.checksum)).toThrow(/bounds/));
    it('refuses invalid base64', () => expect(() => decode('!!!!', 60227, schema.checksum)).toThrow(/bounds/));
    it('refuses invalid header', () => {
        const b = Buffer.from(schema.encoded, 'base64');
        b[0] = 0;
        expect(() => decode(b.toString('base64'), 60227, schema.checksum)).toThrow(/header/);
    });
    it('refuses preset dictionary', () => {
        const b = Buffer.from(schema.encoded, 'base64');
        b[0] = 0x78;
        b[1] = 0xbb;
        expect(() => decode(b.toString('base64'), 60227, schema.checksum)).toThrow(/header/);
    });
    it('refuses changed checksum parameter', () =>
        expect(() => decode(schema.encoded, 60227, (schema.checksum + 1) >>> 0)).toThrow(/checksum/));
    it('refuses changed checksum trailer', () => {
        const b = Buffer.from(schema.encoded, 'base64');
        b[b.length - 1] ^= 1;
        expect(() => decode(b.toString('base64'), 60227, schema.checksum)).toThrow(/checksum/);
    });
    it('refuses trailing compressed data', () => {
        const b = Buffer.from(schema.encoded, 'base64');
        expect(() =>
            decode(
                Buffer.concat([b.subarray(0, -4), Buffer.from([0]), b.subarray(-4)]).toString('base64'),
                60227,
                schema.checksum,
            ),
        ).toThrow(/trailing stream/);
    });
    it('refuses invalid UTF8', () => {
        const raw = Buffer.alloc(60227, 120);
        raw[0] = 255;
        const b = deflateSync(raw);
        expect(() => decode(b.toString('base64'), 60227, b.readUInt32BE(b.length - 4))).toThrow(
            /encoded data|encoding|UTF/i,
        );
    });
    for (const [name, options, error] of [
        ['back reference', {}, /match output overflow/],
        ['literal', { strategy: constants.Z_HUFFMAN_ONLY }, /literal output overflow/],
    ] as const)
        it(`refuses ${name} output overflow before the write`, () => {
            const b = deflateSync(Buffer.alloc(60228, 120), options);
            expect(() => decode(b.toString('base64'), 60227, b.readUInt32BE(b.length - 4))).toThrow(error);
        });
    it('refuses stored output overflow before the copy', () => {
        const prefix = Buffer.alloc(60000, 120),
            suffix = Buffer.alloc(300, 121);
        const head = deflateRawSync(prefix, { finishFlush: constants.Z_SYNC_FLUSH });
        const stored = Buffer.alloc(5 + suffix.length);
        stored[0] = 1;
        stored.writeUInt16LE(suffix.length, 1);
        stored.writeUInt16LE(~suffix.length & 65535, 3);
        suffix.copy(stored, 5);
        let a = 1,
            b = 0;
        for (const byte of Buffer.concat([prefix, suffix])) {
            a = (a + byte) % 65521;
            b = (b + a) % 65521;
        }
        const checksum = ((b << 16) | a) >>> 0,
            tail = Buffer.alloc(4);
        tail.writeUInt32BE(checksum);
        const stream = Buffer.concat([Buffer.from([0x78, 0x9c]), head, stored, tail]);
        expect(() => decode(stream.toString('base64'), 60227, checksum)).toThrow(/stored output overflow/);
    });
});
