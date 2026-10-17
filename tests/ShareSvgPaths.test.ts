// @vitest-environment node
import path from 'node:path';
import React, { type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { build, parseAst } from 'vite';
import react from '@vitejs/plugin-react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectSvgPaths, shareLiteralSvgPaths, shareSvgPaths } from '../scripts/share-svg-paths.mjs';
import { shareSvgProps } from '../scripts/share-svg-props.mjs';
import { packClassNames } from '../scripts/share-class-names.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

const root = process.cwd();
const values = collectSvgPaths(root);
const value = values[0];
const literal = JSON.stringify(value);
const imports = `import {jsx as h} from 'react/jsx-runtime';`;
const transform = (code: string, file = path.join(root, 'components/Icon.js')) =>
    shareLiteralSvgPaths(code, file, { root, values, parse: parseAst });
type Icons = Record<string, Record<string, ComponentType<Record<string, unknown>>>>;

async function production(shared: boolean, handlerProof = false) {
    const entry = path.join(root, 'components/__SvgPathProductionProof.js');
    const result = await build({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [
            react(),
            shareSvgProps(root),
            ...(shared ? [shareSvgPaths(root, { standalone: true })] : []),
            {
                name: 'svg-path-proof-entry',
                resolveId(id) {
                    return id === 'svg-path-proof-entry' ? entry : null;
                },
                load(id) {
                    if (id !== entry) return null;
                    return handlerProof
                        ? `${imports}
export const effects=[];
const __thalassaSvgPaths='existing';
export const binding=__thalassaSvgPaths;
export const Icon=()=>h('path',{id:'original-id',className:(effects.push('class'),'ink'),d:${literal},onClick:()=>effects.push('click'),'data-testid':'kept-test-id'});`
                        : ['UIIcons', 'WeatherIcons', 'MaritimeIcons', 'NavigationIcons', 'GlassGlyphs']
                              .map(
                                  (name) =>
                                      `export * as ${name} from ${JSON.stringify(path.join(root, `components/icons/${name}.tsx`).replaceAll('\\', '/'))};`,
                              )
                              .join('\n');
                },
            },
        ],
        build: {
            write: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: 'svg-path-proof-entry',
                preserveEntrySignatures: 'strict',
                output: { inlineDynamicImports: true },
            },
        },
    });
    if (Array.isArray(result) || !('output' in result)) throw Error('Expected one SVG production bundle');
    const chunk = result.output.find((output) => output.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw Error('Missing SVG production proof');
    expect(Object.keys(chunk.modules).includes('\0virtual:thalassa-svg-paths')).toBe(shared);
    return {
        bytes: Buffer.byteLength(chunk.code),
        exports: await import(
            /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
        ),
    };
}
function svgTree(markup: string): unknown {
    const Parser = new JSDOM('').window.DOMParser;
    const document = new Parser().parseFromString(markup, 'image/svg+xml');
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

describe('lossless production SVG path dictionary', () => {
    beforeAll(() => vi.stubEnv('NODE_ENV', 'production'));
    afterAll(() => vi.unstubAllEnvs());

    it('restores every collected path exactly through the existing bounded immutable decoder', () => {
        expect(values.length).toBeGreaterThan(50);
        const packed = packClassNames(values);
        const restored = decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum);
        expect(restored).toEqual(values);
        expect(Object.isFrozen(restored)).toBe(true);
        expect(packed.encoded.length).toBeLessThan(JSON.stringify(values).length);
    });

    it('keeps all real icon SVG paths, IDs, attributes and child order identical after production minification', async () => {
        const original = await production(false),
            shared = await production(true);
        let count = 0;
        for (const [module, icons] of Object.entries(original.exports as Icons)) {
            for (const [name, Icon] of Object.entries(icons)) {
                const props = { className: 'h-7 w-7 text-amber-400', rotation: 137 };
                const expected = renderToStaticMarkup(React.createElement(Icon, props));
                const actual = renderToStaticMarkup(React.createElement(shared.exports[module][name], props));
                expect(svgTree(actual), `${module}.${name}`).toEqual(svgTree(expected));
                count++;
            }
        }
        expect(count).toBeGreaterThan(80);
        // This small icon-only fixture also includes the complete global pool;
        // actual application savings are proved separately by its configured build.
    }, 60000);

    it('preserves production prop order, IDs, test IDs, side effects, handlers and colliding bindings', async () => {
        const run = async (shared: boolean) => {
            const result = await production(shared, true);
            const element = result.exports.Icon();
            const markup = renderToStaticMarkup(element);
            element.props.onClick();
            return {
                markup,
                keys: Object.keys(element.props),
                effects: result.exports.effects,
                binding: result.exports.binding,
            };
        };
        const original = await run(false),
            shared = await run(true);
        expect(shared).toEqual(original);
        expect(shared.effects).toEqual(['class', 'click']);
        expect(shared.markup).toContain('data-testid="kept-test-id"');
    }, 60000);

    it('replaces only the path value and preserves original source maps', () => {
        const code = `${imports}export const Icon=()=>h('path',{id:'kept',d:${literal},stroke:colour(),onClick:click});`;
        const changed = transform(code);
        expect(changed?.replacements).toBe(1);
        expect(changed?.code).toContain("id:'kept',d:__thalassaSvgPaths[0],stroke:colour(),onClick:click");
        expect(changed?.map.sourcesContent).toEqual([code]);
        expect(changed?.map.mappings.length).toBeGreaterThan(0);
        expect(() => parseAst(changed!.code)).not.toThrow();
    });

    it.each([
        `${imports}export const Icon=()=>h('path',{d:${literal},...custom});`,
        `${imports}export const Icon=()=>h('path',{d:${literal},d:'override'});`,
        `${imports}export const Icon=()=>h('path',{d:${literal},[key]:value});`,
        `${imports}export const Icon=()=>h('path',{get d(){return ${literal}}});`,
        `${imports}export const Icon=(h)=>h('path',{d:${literal}});`,
        `import {jsx as h} from 'another-runtime';export const Icon=()=>h('path',{d:${literal}});`,
        `${imports}export const Icon=()=>h('div',{d:${literal}});`,
        `${imports}export const Icon=()=>h('path',{d:effect()});`,
        `${imports}export const Icon=()=>h('path',{d:'M1 1h1'});`,
    ])('leaves dynamic, spread, duplicate, computed, accessor, shadowed and foreign cases unchanged (%#)', (code) => {
        expect(transform(code)).toBeNull();
    });

    it('leaves dependencies and files outside the app untouched', () => {
        const code = `${imports}export const Icon=()=>h('path',{d:${literal}});`;
        expect(transform(code, path.join(root, 'node_modules/pkg/index.js'))).toBeNull();
        expect(transform(code, path.join(root, '../outside/Icon.js'))).toBeNull();
    });
});
