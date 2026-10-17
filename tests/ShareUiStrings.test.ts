// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'vite';
import { parseAst } from 'rollup/parseAst';
import {
    collectUiStrings,
    selectUiStrings,
    shareUiStringLiterals,
    shareUiStrings,
} from '../scripts/share-ui-strings.mjs';
import { shareClassNames, packClassNames } from '../scripts/share-class-names.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

let root: string;
const messages = Array.from(
    { length: 60 },
    (_, i) =>
        `Public interface message ${i}: Review the original report and chosen settings before confirming this fictional example. Unknown readings stay unknown. Exact spaces  and Unicode ⚓ are retained.`,
);
const markup = ` ${messages[0]}\n  \t"quoted" \\ escaped `;
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-ui-strings-'));
    await fs.mkdir(path.join(root, 'components'));
    await fs.mkdir(path.join(root, 'components', 'fixtures'));
    await fs.writeFile(
        path.join(root, 'App.tsx'),
        `export const words=${JSON.stringify(messages)};export const unusual=${JSON.stringify(markup)};`,
    );
    await fs.writeFile(
        path.join(root, 'components', 'fixtures', 'sample.tsx'),
        `export const sample=${JSON.stringify('Fixture-only text '.repeat(15))};`,
    );
    await fs.writeFile(
        path.join(root, 'components', 'sample.test.tsx'),
        `export const sample=${JSON.stringify('Test-only text '.repeat(15))};`,
    );
});
afterAll(async () => {
    vi.unstubAllEnvs();
    if (
        root &&
        path.dirname(root) === path.resolve(os.tmpdir()) &&
        path.basename(root).startsWith('thalassa-ui-strings-')
    )
        await fs.rm(root, { recursive: true, force: true });
});

it('collects production UI literals and reconstructs exact Unicode and whitespace without admitting test content', () => {
    const values = collectUiStrings(root),
        packed = packClassNames(values);
    expect(values).toEqual([...messages, markup].sort());
    expect(decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum)).toEqual(values);
});

it('keeps existing expansion, byte, word and value bounds when future UI text exceeds the table', () => {
    const entries = Array.from(
        { length: 4000 },
        (_, i) => [`Public message ${i} ${'original report '.repeat(20)}`, 1] as const,
    );
    const values = selectUiStrings(new Map(entries)),
        packed = packClassNames(values);
    expect(values).toEqual(selectUiStrings(new Map([...entries].reverse())));
    expect(values.length).toBeGreaterThan(0);
    expect(values.length).toBeLessThan(entries.length);
    expect(values.reduce((sum: number, value: string) => sum + value.length, 0)).toBeLessThanOrEqual(240000);
    expect(packed.bytes).toBeLessThanOrEqual(128000);
    expect(packed.encoded.length).toBeLessThanOrEqual(64000);
    expect(decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum)).toEqual(values);
});

it('leaves module paths, nested glob patterns, URL constructors, keys, directives and tagged templates intact', () => {
    const text = JSON.stringify(messages[0]);
    const code = `${text};import value from ${text};export {value as other} from ${text};
      const __thalassaUiStrings='existing';const a=import(${text});const b=import.meta.glob([${text}]);
      const c=new URL(${text},import.meta.url);const d={${text}:${text}};const e=String.raw\`${messages[0]}\`;
      export const actual=${text};`;
    const result = shareUiStringLiterals(code, path.join(root, 'components', 'Probe.tsx'), {
        root,
        values: [messages[0]],
        parse: parseAst,
    });
    expect(result?.replacements).toBe(2);
    expect(result?.code).toContain(`import value from ${text}`);
    expect(result?.code).toContain(`export {value as other} from ${text}`);
    expect(result?.code).toContain(`import(${text})`);
    expect(result?.code).toContain(`import.meta.glob([${text}])`);
    expect(result?.code).toContain(`new URL(${text},import.meta.url)`);
    expect(result?.code).toContain(`{${text}:__thalassaUiStrings_[0]}`);
    expect(result?.code).toContain(`String.raw\`${messages[0]}\``);
    expect(
        shareUiStringLiterals(code, path.join(root, 'services', 'Other.ts'), {
            root,
            values: [messages[0]],
            parse: parseAst,
        }),
    ).toBeNull();
});

it('preserves actual rendered DOM, conditional evaluation, property order and handlers after Vite and Terser', async () => {
    const entry = path.join(root, 'components', 'Probe.tsx');
    await fs.writeFile(
        entry,
        `
      const __thalassaUiStrings='existing';
      export function render(h,selected){
        const effects=[];const choose=()=>{effects.push('condition');return selected};
        const a={title:${JSON.stringify(messages[0])},id:'first'};
        const b={id:'second',title:${JSON.stringify(messages[1])}};
        const note=choose()?${JSON.stringify(messages[0])}:${JSON.stringify(messages[1])};
        const node=h('button',{'aria-label':note,title:a.title,onClick:()=>effects.push('clicked')},${JSON.stringify(markup)});
        return {node,effects,keys:[Object.keys(a),Object.keys(b)],binding:__thalassaUiStrings,words:${JSON.stringify(messages)}};
      }`,
    );
    const decoder: Plugin = {
        name: 'fixture-original-decoder',
        enforce: 'pre',
        resolveId(id) {
            return id === 'virtual:thalassa-class-data-decoder' ? path.resolve('utils/decodeClassNames.ts') : null;
        },
    };
    async function compile(enabled: boolean) {
        const result = await build({
            root,
            configFile: false,
            logLevel: 'silent',
            plugins: enabled ? [decoder, shareClassNames(root), shareUiStrings(root)] : [],
            build: {
                write: false,
                copyPublicDir: false,
                minify: 'terser',
                terserOptions: { compress: { passes: 2 } },
                rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { format: 'es' } },
            },
        });
        if (Array.isArray(result) || !('output' in result)) throw Error('Expected one production bundle');
        const chunks = result.output.filter((item) => item.type === 'chunk');
        expect(chunks).toHaveLength(1);
        const code = chunks[0].code,
            module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
        return {
            bytes: Buffer.byteLength(code),
            cases: [false, true].map((selected) => {
                const { node, ...details } = module.render(React.createElement, selected);
                const html = renderToStaticMarkup(node);
                node.props.onClick();
                return { html, details };
            }),
        };
    }
    const original = await compile(false),
        packed = await compile(true);
    expect(packed.cases).toEqual(original.cases);
    expect(packed.bytes).toBeLessThan(original.bytes);
    for (const c of packed.cases) {
        expect(c.details.effects).toEqual(['condition', 'clicked']);
        expect(c.details.binding).toBe('existing');
    }
});
