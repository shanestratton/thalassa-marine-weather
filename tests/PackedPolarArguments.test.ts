// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { packPolarArguments, packPolarSource } from '../scripts/pack-polar-arguments.mjs';
import { packClassNames } from '../scripts/share-class-names.mjs';
import { restorePolarEntries } from '../utils/restorePolarEntries';
import type { PolarDatabaseEntry } from '../data/polarDatabase';

const root = process.cwd();
const file = path.join(root, 'data/polarDatabase.ts');
const source = fs.readFileSync(file, 'utf8');
type Catalogue = { POLAR_DATABASE: PolarDatabaseEntry[]; searchPolarDatabase: (query: string) => PolarDatabaseEntry[] };

async function production(packed: boolean): Promise<Catalogue> {
    const result = await build({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: packed ? [packPolarArguments(root)] : [],
        build: {
            write: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: { input: file, preserveEntrySignatures: 'strict', output: { inlineDynamicImports: true } },
        },
    });
    if (Array.isArray(result) || !('output' in result)) throw Error('Expected one public catalogue bundle');
    const chunk = result.output.find((output) => output.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw Error('Missing public catalogue bundle');
    expect(Object.keys(chunk.modules).includes('\0virtual:thalassa-polar-arguments')).toBe(packed);
    return import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64'));
}

describe('lossless public polar argument storage', () => {
    beforeAll(() => vi.stubEnv('NODE_ENV', 'production'));
    afterAll(() => vi.unstubAllEnvs());
    it('preserves every production model, matrix value, search result, order and shared axes', async () => {
        const original = await production(false),
            packed = await production(true);
        expect(packed.POLAR_DATABASE).toHaveLength(321);
        expect(packed.POLAR_DATABASE).toEqual(original.POLAR_DATABASE);
        for (const [index, entry] of packed.POLAR_DATABASE.entries()) {
            for (const [angle, row] of entry.polar.matrix.entries())
                for (const [wind, value] of row.entries())
                    expect(Object.is(value, original.POLAR_DATABASE[index].polar.matrix[angle][wind])).toBe(true);
            expect(entry.polar.angles).toBe(packed.POLAR_DATABASE[0].polar.angles);
            expect(entry.polar.windSpeeds).toBe(packed.POLAR_DATABASE[0].polar.windSpeeds);
        }
        for (const query of ['', '  ', 'BENETEAU', 'tayana', '55', 'multihull', 'no model like this'])
            expect(packed.searchPolarDatabase(query)).toEqual(original.searchPolarDatabase(query));
    }, 60000);

    it('changes only the literal factory argument representation, retaining the generator byte for byte', () => {
        const packed = packPolarSource(source)!;
        const withoutImport = packed.code.slice(packed.code.indexOf('\n') + 1);
        expect(withoutImport.replace(`${packed.binding}(e)`, packed.initializer)).toBe(source);
        expect(packed.map.sourcesContent).toEqual([source]);
        expect(packed.rows).toHaveLength(321);
        expect(packed.packed.encoded.length).toBeLessThan(JSON.stringify(packed.rows).length);
        const calls = restorePolarEntries(
            packed.packed.encoded,
            packed.packed.bytes,
            packed.packed.count,
            packed.packed.checksum,
            (...args) => args,
        );
        expect(calls).toEqual(packed.rows);
        expect(() => packPolarSource(source + '\n// changed source')).toThrow('Unreviewed public polar source');
    });

    it('refuses any malformed row before invoking the original factory', () => {
        for (const invalid of [
            ['Missing'],
            ['Model', 'Maker', null, 'cruiser'],
            ['Model', 'Maker', 40, 'unknown'],
            ['Model', 'Maker', 301, 'cruiser'],
        ]) {
            const rows = [['Known', 'Maker', 40, 'cruiser'], invalid].map((row) => JSON.stringify(row));
            const packed = packClassNames(rows),
                factory = vi.fn();
            expect(() =>
                restorePolarEntries(packed.encoded, packed.bytes, packed.count, packed.checksum, factory),
            ).toThrow('Invalid embedded polar arguments');
            expect(factory).not.toHaveBeenCalled();
        }
    });

    it('refuses corrupt bytes and an out-of-bound count without calling the factory', () => {
        const packed = packPolarSource(source)!.packed,
            factory = vi.fn();
        expect(() => restorePolarEntries(packed.encoded, packed.bytes, 513, packed.checksum, factory)).toThrow(
            'Invalid embedded polar count',
        );
        expect(() =>
            restorePolarEntries(packed.encoded, packed.bytes, packed.count, packed.checksum ^ 1, factory),
        ).toThrow('checksum');
        expect(factory).not.toHaveBeenCalled();
    });
});
