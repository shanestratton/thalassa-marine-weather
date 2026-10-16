// @vitest-environment node
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build, parseAst } from 'vite';
import react from '@vitejs/plugin-react';
import type { RollupOutput } from 'rollup';
import React, { type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { shareSvgAttributes, shareSvgProps } from '../scripts/share-svg-props.mjs';

const root = process.cwd();
const mark = (code: string, file = path.join(root, 'components/Icon.js')) =>
    shareSvgAttributes(code, file, { parse: parseAst, root });
const props = 'viewBox:"0 0 24 24",fill:"none",stroke:"currentColor"';
const imports = `import {jsx as h} from 'react/jsx-runtime';`;
type Icons = Record<string, Record<string, ComponentType<Record<string, unknown>>>>;

async function productionIcons(shared: boolean): Promise<{ bytes: number; icons: Icons }> {
    const result = await build({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [
            react(),
            ...(shared ? [shareSvgProps(root)] : []),
            {
                name: 'svg-proof-entry',
                resolveId(id) {
                    return id === 'svg-proof-entry' ? '\0svg-proof-entry' : null;
                },
                load(id) {
                    return id === '\0svg-proof-entry'
                        ? ['UIIcons', 'WeatherIcons', 'MaritimeIcons', 'NavigationIcons', 'GlassGlyphs']
                              .map(
                                  (name) =>
                                      `export * as ${name} from ${JSON.stringify(path.join(root, `components/icons/${name}.tsx`).replaceAll('\\', '/'))};`,
                              )
                              .join('\n')
                        : null;
                },
            },
        ],
        build: {
            write: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: 'svg-proof-entry',
                preserveEntrySignatures: 'strict',
                output: { inlineDynamicImports: true },
            },
        },
    });
    const output = (result as RollupOutput).output.find((o) => o.type === 'chunk');
    if (!output || output.type !== 'chunk') throw Error('Missing SVG proof');
    return {
        bytes: Buffer.byteLength(output.code),
        icons: await import(
            /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(output.code).toString('base64')
        ),
    };
}
function svgTree(markup: string): unknown {
    const document = new JSDOM(markup, { contentType: 'image/svg+xml' }).window.document;
    expect(document.querySelector('parsererror')).toBeNull();
    const visit = (node: Element): unknown => ({
        tag: node.tagName,
        attributes: Object.fromEntries(
            [...node.attributes].map((a) => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b)),
        ),
        text: node.childElementCount ? null : node.textContent,
        children: [...node.children].map(visit),
    });
    return visit(document.documentElement);
}
describe('production shared SVG outline attributes', () => {
    let original: Awaited<ReturnType<typeof productionIcons>>;
    let shared: Awaited<ReturnType<typeof productionIcons>>;
    beforeAll(async () => {
        vi.stubEnv('NODE_ENV', 'production');
        original = await productionIcons(false);
        shared = await productionIcons(true);
    }, 30000);
    afterAll(() => vi.unstubAllEnvs());
    it('reduces the real production icon bundle while every SVG attribute and child remains identical', () => {
        let count = 0;
        for (const [module, icons] of Object.entries(original.icons)) {
            for (const [name, Icon] of Object.entries(icons)) {
                const values = { className: 'h-7 w-7 text-amber-400', rotation: 137 };
                const expected = renderToStaticMarkup(React.createElement(Icon, values));
                const actual = renderToStaticMarkup(React.createElement(shared.icons[module][name], values));
                expect(svgTree(actual), `${module}.${name}`).toEqual(svgTree(expected));
                count++;
            }
        }
        expect(count).toBeGreaterThan(80);
        expect(original.bytes - shared.bytes).toBeGreaterThan(5000);
    });
    it('keeps dynamic expressions, children, custom widths and child overrides intact with source maps', () => {
        const code = `${imports}export const Icon=()=>h('svg',{className:effect(),${props},strokeWidth:1.75,width:dimension(),children:h('path',{fill:'red',stroke:'blue',d:'M0 0h24'})});`;
        const result = mark(code);
        expect(result?.elements).toBe(1);
        expect(result?.code).toContain('className:effect()');
        expect(result?.code).toContain('strokeWidth:1.75,width:dimension()');
        expect(result?.code).toContain("fill:'red',stroke:'blue',d:'M0 0h24'");
        expect(result?.map.sourcesContent).toEqual([code]);
        expect(result?.map.mappings.length).toBeGreaterThan(0);
    });
    it.each([
        `${imports}export const Icon=()=>h('svg',{${props},...custom});`,
        `${imports}export const Icon=()=>h('svg',{${props},fill:'red'});`,
        `${imports}export const Icon=()=>h('svg',{${props},[key]:value});`,
        `${imports}export const Icon=()=>h('svg',{${props},get width(){return 24}});`,
        `${imports}export const Icon=(h)=>h('svg',{${props}});`,
        `import {jsx as h} from 'another-runtime';export const Icon=()=>h('svg',{${props}});`,
        `${imports}export const Icon=()=>h('div',{${props}});`,
        `${imports}export const Icon=()=>h('svg',{viewBox:'0 0 48 48',fill:'none',stroke:'currentColor'});`,
    ])(
        'leaves spread, duplicate, computed, accessor, shadowed, foreign and custom view-box cases unchanged (%#)',
        (code) => {
            expect(mark(code)).toBeNull();
        },
    );
    it('leaves dependencies and source outside the app untouched', () => {
        const code = `${imports}export const Icon=()=>h('svg',{${props}});`;
        expect(mark(code, path.join(root, 'node_modules/pkg/index.js'))).toBeNull();
        expect(mark(code, path.join(root, '../outside/Icon.js'))).toBeNull();
    });
    it('uses a collision-free imported binding and edits nested SVG props independently', () => {
        const code = `${imports}const __thalassaSvgProps0=1;export const Icon=()=>h('svg',{${props},children:h('svg',{${props}})});`;
        const result = mark(code);
        expect(result?.elements).toBe(2);
        expect(result?.code).toContain('p0 as __thalassaSvgProps_0');
        expect(() => parseAst(result!.code)).not.toThrow();
    });
});
