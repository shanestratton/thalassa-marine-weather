// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'vite';
import { packReliefInventories, packReliefRows, RELIEF_ROW_SOURCES } from '../scripts/pack-relief-rows.mjs';
import { inertUiDataWorkerFence } from '../scripts/inert-ui-data.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

const sourceRoot = process.cwd();
const names = Object.keys(RELIEF_ROW_SOURCES);
type Inventory = {
    schema: number;
    region: string;
    version: string;
    minzoom: number;
    maxzoom: number;
    tilePairs: number;
    rows: number[][];
};
type Compiled = {
    au: Inventory;
    nz: Inventory;
    auNames: Omit<Inventory, 'rows'> & { rows: number[][] };
    nzNames: Omit<Inventory, 'rows'> & { rows: number[][] };
};
let root: string;
const decoder: Plugin = {
    name: 'proof-original-bounded-decoder',
    enforce: 'pre',
    resolveId(id) {
        return id === 'virtual:thalassa-class-data-decoder' ? path.join(sourceRoot, 'utils/decodeClassNames.ts') : null;
    },
};
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-relief-packing-'));
    await fs.mkdir(path.join(root, 'data/relief'), { recursive: true });
    for (const name of names)
        await fs.copyFile(path.join(sourceRoot, 'data/relief', name), path.join(root, 'data/relief', name));
    await fs.writeFile(
        path.join(root, 'entry.js'),
        `import au,*as auNames from './data/relief/au250-v2.json';import nz,*as nzNames from './data/relief/nz-v2.json';export{au,nz,auNames,nzNames};`,
    );
});
afterAll(async () => {
    vi.unstubAllEnvs();
    if (
        root &&
        path.dirname(root) === path.resolve(os.tmpdir()) &&
        path.basename(root).startsWith('thalassa-relief-packing-')
    )
        await fs.rm(root, { recursive: true, force: true });
});
async function compile(enabled: boolean) {
    const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        cacheDir: path.join(root, '.vite'),
        plugins: enabled ? [packReliefInventories(root), decoder] : [],
        build: {
            write: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: path.join(root, 'entry.js'),
                preserveEntrySignatures: 'strict',
                output: { inlineDynamicImports: true },
            },
        },
    });
    if (Array.isArray(result) || !('output' in result)) throw Error('Expected one relief bundle');
    const chunk = result.output.find((item) => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw Error('Missing relief bundle');
    const value: Compiled = await import(
        /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
    );
    return { value, code: chunk.code, bytes: Buffer.byteLength(chunk.code), modules: Object.keys(chunk.modules) };
}

describe('reviewed local relief inventory representation', () => {
    it.each(names)(
        'restores every original %s row/field/order exactly within unchanged decoder bounds',
        async (name) => {
            const raw = await fs.readFile(path.join(root, 'data/relief', name), 'utf8');
            const original: Inventory = JSON.parse(raw);
            const packed = packReliefRows(raw, name);
            expect(packed).toEqual(packReliefRows(raw, name));
            expect(packReliefRows(raw.replace(/\r?\n/g, '\r\n'), name)).toEqual(packed);
            const rows = decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum).map((row) =>
                row.split(',').map(Number),
            );
            expect(rows).toEqual(original.rows);
            for (const [i, row] of rows.entries())
                for (const [j, value] of row.entries()) expect(Object.is(value, original.rows[i][j])).toBe(true);
            expect(packed.encoded.length).toBeLessThan(64_000);
            expect(packed.bytes).toBeLessThan(128_000);
            expect(packed.count).toBeLessThan(4096);
            expect(() => packReliefRows(raw + ' ', name)).toThrow('Unreviewed canonical relief row source');
            expect(() => packReliefRows(raw, 'other.json')).toThrow('Unreviewed canonical relief row source');
            expect(() => decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum ^ 1)).toThrow(
                'checksum',
            );
            expect(() => decodeClassNames(packed.encoded, 128_001, packed.count, packed.checksum)).toThrow('bounds');
            expect(() => decodeClassNames(packed.encoded, packed.bytes, 4097, packed.checksum)).toThrow('bounds');
        },
    );

    it('preserves actual minified default/named exports, metadata order and ordinary mutable row arrays', async () => {
        const original = await compile(false),
            packed = await compile(true);
        for (const key of ['au', 'nz'] as const) {
            expect(packed.value[key]).toEqual(original.value[key]);
            expect(Object.keys(packed.value[key])).toEqual(Object.keys(original.value[key]));
            expect(Object.isFrozen(packed.value[key].rows)).toBe(false);
            expect(Object.isFrozen(packed.value[key].rows[0])).toBe(false);
            const namedKey = key === 'au' ? 'auNames' : 'nzNames';
            const { default: _originalDefault, ...originalNamed } = original.value[
                namedKey
            ] as Compiled[typeof namedKey] & { default: Inventory };
            const { default: _packedDefault, ...packedNamed } = packed.value[namedKey] as Compiled[typeof namedKey] & {
                default: Inventory;
            };
            expect(packedNamed).toEqual(originalNamed);
            expect(packed.value[key].rows).toBe(packed.value[namedKey].rows);
        }
        expect(packed.modules.filter((id) => id.includes('thalassa:relief-rows:'))).toHaveLength(2);
        expect(packed.modules.filter((id) => id.includes('decodeClassNames'))).toHaveLength(1);
        expect(packed.code).not.toMatch(/\beval\s*\(|\bnew Function\b|\bdocument\b|readPackedUiData|readPreloadData/);
        expect(packed.bytes).toBeLessThan(original.bytes - 8000);
        console.info(
            JSON.stringify({
                kind: 'isolated-relief-minified',
                original: original.bytes,
                packed: packed.bytes,
                saved: original.bytes - packed.bytes,
                includesDecoder: true,
            }),
        );
    }, 60_000);

    it('refuses corrupt compressed bytes and oversized inflate output without raising the existing ceilings', () => {
        const bytes = new TextEncoder().encode(' '.repeat(128_001));
        const bomb = deflateSync(bytes).toString('base64');
        expect(() => decodeClassNames(bomb, 128_001, 1, 0)).toThrow('bounds');
        expect(() => decodeClassNames(bomb, 128_000, 1, 0)).toThrow();
        expect(() => decodeClassNames(Buffer.from('invalid').toString('base64'), 7, 1, 0)).toThrow('header');
    });

    it('leaves raw/url JSON asset imports on their original Vite path', async () => {
        await fs.writeFile(
            path.join(root, 'assets.js'),
            `import raw from './data/relief/au250-v2.json?raw';import url from './data/relief/nz-v2.json?url';export{raw,url};`,
        );
        const result = await build({
            root,
            configFile: false,
            logLevel: 'silent',
            plugins: [packReliefInventories(root)],
            build: {
                write: false,
                copyPublicDir: false,
                assetsInlineLimit: 0,
                rollupOptions: { input: path.join(root, 'assets.js'), preserveEntrySignatures: 'strict' },
            },
        });
        if (Array.isArray(result) || !('output' in result)) throw Error('Expected asset bundle');
        const chunk = result.output.find((item) => item.type === 'chunk');
        if (!chunk || chunk.type !== 'chunk') throw Error('Missing asset bundle');
        expect(Object.keys(chunk.modules).some((id) => id.includes('thalassa:relief-rows:'))).toBe(false);
        const module = await import(
            /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
        );
        expect(module.raw).toBe(await fs.readFile(path.join(root, 'data/relief/au250-v2.json'), 'utf8'));
        expect(module.url).toMatch(/assets\/nz-v2-[\w-]+\.json$/);
    });

    it('keeps an actual isolated Vite worker build free of packing/DOM readers even if the plugin is supplied there', async () => {
        await fs.writeFile(
            path.join(root, 'worker.js'),
            `import rows from './data/relief/au250-v2.json';postMessage(rows);`,
        );
        await fs.writeFile(
            path.join(root, 'main-worker.js'),
            `export const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});`,
        );
        const result = await build({
            root,
            configFile: false,
            logLevel: 'silent',
            plugins: [packReliefInventories(root), decoder],
            worker: { format: 'es', plugins: () => [packReliefInventories(root), inertUiDataWorkerFence(sourceRoot)] },
            build: {
                write: false,
                copyPublicDir: false,
                rollupOptions: { input: path.join(root, 'main-worker.js'), preserveEntrySignatures: 'strict' },
            },
        });
        if (Array.isArray(result) || !('output' in result)) throw Error('Expected worker bundle');
        const worker = result.output.find((item) => item.type === 'asset' && /worker-[\w-]+\.js$/.test(item.fileName));
        if (!worker || worker.type !== 'asset') throw Error('Missing actual worker asset');
        const code = typeof worker.source === 'string' ? worker.source : new TextDecoder().decode(worker.source);
        expect(code).not.toMatch(/\bdocument\b|decodeClassNames|readPackedUiData|readPreloadData|thalassa:relief/);
        const received = vi.fn();
        vi.stubGlobal('postMessage', received);
        try {
            await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
        } finally {
            vi.unstubAllGlobals();
        }
        expect(received).toHaveBeenCalledExactlyOnceWith(
            JSON.parse(await fs.readFile(path.join(root, 'data/relief/au250-v2.json'), 'utf8')),
        );
    }, 60_000);
});
