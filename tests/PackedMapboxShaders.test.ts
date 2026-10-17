// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { build, type Plugin } from 'vite';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { packMapboxShaderSource, packMapboxShaders } from '../scripts/pack-mapbox-shaders.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

const root = process.cwd();
const file = fs.realpathSync(path.resolve('node_modules/mapbox-gl/dist/mapbox-gl.js'));
const source = fs.readFileSync(file, 'utf8');
const decoder: Plugin = {
    name: 'original-pure-decoder',
    enforce: 'pre',
    resolveId(id) {
        return id === 'virtual:thalassa-class-data-decoder' ? path.join(root, 'utils/decodeClassNames.ts') : null;
    },
};
beforeAll(() => vi.stubEnv('NODE_ENV', 'production'));
afterAll(() => vi.unstubAllEnvs());
async function compile(packed: boolean) {
    const entry = '\0mapbox-shader-proof';
    const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
            {
                name: 'proof-entry',
                resolveId(id) {
                    return id === 'proof' ? entry : null;
                },
                load(id) {
                    return id === entry ? `export {default} from ${JSON.stringify(file)};` : null;
                },
            },
            ...(packed ? [packMapboxShaders(root), decoder] : []),
        ],
        build: {
            write: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: 'proof',
                preserveEntrySignatures: 'strict',
                output: { inlineDynamicImports: true },
            },
        },
    });
    if (Array.isArray(result) || !('output' in result)) throw Error('Expected one Mapbox proof');
    const chunk = result.output.find((v) => v.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw Error('Missing Mapbox proof');
    const value = await import(
        /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
    );
    return {
        value: value.default,
        code: chunk.code,
        modules: Object.keys(chunk.modules),
        bytes: Buffer.byteLength(chunk.code),
    };
}
describe('pinned main-renderer shader representation', () => {
    it('restores all89 original GLSL strings exactly without changing either serialized worker callback', () => {
        const packed = packMapboxShaderSource(source, file);
        const rows = packed.pools.flatMap((p) => [...decodeClassNames(p.encoded, p.bytes, p.count, p.checksum)]);
        const values = packed.spans.map((span) => rows.slice(span.start, span.end).join(''));
        expect(values).toHaveLength(89);
        expect(values).toEqual(packed.values);
        for (const [index, value] of values.entries())
            expect(Buffer.from(value)).toEqual(Buffer.from(packed.values[index]));
        for (const callback of packed.workers) expect(packed.code.includes(callback)).toBe(true);
        let restored = packed.code.slice(packed.prelude.length);
        for (let i = 0; i < values.length; i++)
            restored = restored.replace(`__thalassaMapboxShaderValues[${i}]`, packed.originalLiterals[i]);
        expect(restored).toBe(source);
        expect(packed.map.sourcesContent).toEqual([source]);
        expect(packed.code.slice(packed.prelude.length).split('__thalassaMapboxShaderValues[')).toHaveLength(90);
        expect(packed.workers).toHaveLength(2);
        expect(packed.pools).toHaveLength(2);
        expect(() => packMapboxShaderSource(source + '\n// drift')).toThrow('Unreviewed Mapbox shader source');
        expect(packed.table).not.toMatch(/\bdocument\b|\beval\s*\(|new Function|readPackedUiData|readPreloadData/);
        expect(restored).toContain('workerBundleString');
    });

    it('preserves every runtime export/accessor with actual Vite CommonJS handling', async () => {
        const original = await compile(false),
            packed = await compile(true);
        expect(packed.modules.filter((id) => id === '\0virtual:thalassa-mapbox-shader-data')).toHaveLength(1);
        expect(packed.modules.filter((id) => id.includes('decodeClassNames'))).toHaveLength(1);
        expect(packed.value.version).toBe(original.value.version);
        expect(Object.keys(packed.value)).toEqual(Object.keys(original.value));
        for (const key of Object.keys(original.value)) {
            const a = Object.getOwnPropertyDescriptor(original.value, key)!,
                b = Object.getOwnPropertyDescriptor(packed.value, key)!;
            expect({
                enumerable: b.enumerable,
                configurable: b.configurable,
                writable: b.writable,
                type: typeof b.value,
                get: typeof b.get,
                set: typeof b.set,
            }).toEqual({
                enumerable: a.enumerable,
                configurable: a.configurable,
                writable: a.writable,
                type: typeof a.value,
                get: typeof a.get,
                set: typeof a.set,
            });
        }
        expect(new packed.value.LngLat(153, -27).toArray()).toEqual(new original.value.LngLat(153, -27).toArray());
        const point = new packed.value.Point(10, 20).add(new packed.value.Point(3, 4));
        expect([point.x, point.y]).toEqual([13, 24]);
        expect(packed.value.MercatorCoordinate.fromLngLat([153, -27]).x).toBe(
            original.value.MercatorCoordinate.fromLngLat([153, -27]).x,
        );
        expect(packed.bytes).toBeLessThan(original.bytes - 100_000);
        console.info(
            JSON.stringify({
                kind: 'isolated-mapbox-minified',
                original: original.bytes,
                packed: packed.bytes,
                saved: original.bytes - packed.bytes,
            }),
        );
    }, 120_000);
});
