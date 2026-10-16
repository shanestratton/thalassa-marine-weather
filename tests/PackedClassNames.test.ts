// @vitest-environment node
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { collectClassNames, packClassNames, shareClassNames } from '../scripts/share-class-names.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

const real = collectClassNames(process.cwd());
beforeAll(() => vi.stubEnv('NODE_ENV', 'production'));
afterAll(() => vi.unstubAllEnvs());
const unpack = (values: string[]) => {
    const packed = packClassNames(values);
    return decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum);
};
it('reconstructs every production class, exact whitespace, Unicode and escaped characters in original order', () => {
    const values = [...real, ' a  b\tc\n ', 'text-["☀️"] \\ escaped', '', '   ', '\ud800'];
    const decoded = unpack(values);
    expect(decoded).toEqual(values);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(real.length).toBeGreaterThan(1000);
});
it('refuses corrupt, oversized and wrong-length embedded bytes without allocating beyond fixed bounds', () => {
    const p = packClassNames(real);
    const decode = (encoded = p.encoded, bytes = p.bytes, count = p.count, checksum = p.checksum) =>
        decodeClassNames(encoded, bytes, count, checksum);
    expect(() => decode('A'.repeat(64001))).toThrow();
    expect(() => decode(p.encoded, 128001)).toThrow();
    expect(() => decode(p.encoded, p.bytes - 1)).toThrow();
    expect(() => decode(p.encoded, p.bytes + 1)).toThrow();
    expect(() => decode(p.encoded, p.bytes, p.count + 1)).toThrow();
    expect(() => decode(p.encoded, p.bytes, p.count, p.checksum ^ 1)).toThrow();
    expect(() => decode(p.encoded.slice(0, 80))).toThrow();
});
it('refuses invalid word references, schema changes and bounded-input expansion bombs', () => {
    const decode = (value: unknown, count = 1) => {
        const raw = Buffer.from(JSON.stringify(value)),
            z = deflateSync(raw);
        return () => decodeClassNames(z.toString('base64'), raw.length, count, z.readUInt32BE(z.length - 4));
    };
    for (const value of [[['word'], ['1']], [['word'], ['-1']], [[5], ['0']], { words: ['word'] }, [['word'], ['!']]])
        expect(decode(value)).toThrow();
    expect(decode([['x'.repeat(4096)], [Array(100).fill('0').join(' ')]])).toThrow(/output exceeds/);
});
it('keeps all production DOM classes, prop order and handlers identical after actual Vite/Terser compilation', async () => {
    const id = path.join(process.cwd(), '__class-packing-fixture.js');
    const objects = real.map((value: string, i: number) =>
        i % 2 ? `{id:'p${i}',className:${JSON.stringify(value)}}` : `{className:${JSON.stringify(value)},id:'p${i}'}`,
    );
    const source = `export function render(h){const effects=[];const props=[${objects.join(',')}];return {
        buttons:props.map((p,i)=>h('button',{...p,onClick:()=>effects.push(i)},'Open')),
        keys:props.map(p=>Object.keys(p)),effects};}`;
    const compile = async (enabled: boolean) => {
        const result = await build({
            root: process.cwd(),
            configFile: false,
            logLevel: 'silent',
            plugins: [
                {
                    name: 'owned-class-fixture',
                    resolveId(name) {
                        return name === 'class-packing-fixture' ? id : null;
                    },
                    load(name) {
                        return name === id ? source : null;
                    },
                },
                ...(enabled ? [shareClassNames(process.cwd())] : []),
            ],
            build: {
                write: false,
                copyPublicDir: false,
                minify: 'terser',
                terserOptions: { compress: { passes: 2 } },
                rollupOptions: {
                    input: 'class-packing-fixture',
                    preserveEntrySignatures: 'strict',
                    output: { format: 'es' },
                },
            },
        });
        if (Array.isArray(result) || !('output' in result)) throw Error('Expected one build');
        const chunks = result.output.filter((item) => item.type === 'chunk');
        expect(chunks).toHaveLength(1);
        const code = chunks[0].code;
        const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
        const { buttons, keys, effects } = module.render(React.createElement) as {
            buttons: React.ReactElement<{ onClick: () => void }>[];
            keys: string[][];
            effects: number[];
        };
        const markup = buttons.map((button) => renderToStaticMarkup(button)).join('');
        buttons[0].props.onClick();
        buttons.at(-1)!.props.onClick();
        return { markup, keys, effects, bytes: Buffer.byteLength(code) };
    };
    const baseline = await compile(false),
        packed = await compile(true);
    expect(packed.markup).toBe(baseline.markup);
    expect(packed.keys).toEqual(baseline.keys);
    expect(packed.effects).toEqual([0, real.length - 1]);
    expect(packed.effects).toEqual(baseline.effects);
    expect(packed.bytes).toBeLessThan(baseline.bytes);
}, 30_000);
