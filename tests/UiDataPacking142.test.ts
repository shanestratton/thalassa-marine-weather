// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import ts from 'typescript';
import { build, type Plugin } from 'vite';
import { parseAst } from 'rollup/parseAst';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { packCompactStringData } from '../scripts/share-class-names.mjs';
import { collectLegacySvgPaths, collectSvgPaths } from '../scripts/share-svg-paths.mjs';
import {
    collectUiStringPools,
    packUiStringPools,
    shareUiStringLiterals,
    shareUiStrings,
} from '../scripts/share-ui-strings.mjs';
import {
    assertStaticCssSource,
    compiledCssRanges,
    isStaticCssSource,
    staticCssSourceRows,
} from '../scripts/static-css-data.mjs';
import { STATIC_CSS_SOURCES142 } from '../scripts/static-css-sources142.mjs';
import { collectUiLiteralCounts } from '../scripts/static-ui-literals.mjs';
import { shareSvgAttributes, shareSvgProps, SVG_LITERAL_RUNS142 } from '../scripts/share-svg-props.mjs';
import { routeJobClosure, staticAppGraph } from '../scripts/route-job-closure.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

const root = process.cwd();
// Like the existing ShareSvgPaths/PackedClassNames suites, construct the real
// build-source data at module import; this is not a timed application action.
// One immutable compiler-cooked snapshot serves both independent selections.
const literalCounts = collectUiLiteralCounts(root);
const legacy: string[][] = collectUiStringPools(root, { legacy: true, literalCounts });
const pools: string[][] = collectUiStringPools(root, { literalCounts });
const legacyPaths: string[] = collectLegacySvgPaths(root);
const paths: string[] = collectSvgPaths(root, { uiCounts: literalCounts });
let temporary: string;
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-ui-data142-'));
});
afterAll(async () => {
    vi.unstubAllEnvs();
    if (
        temporary &&
        path.dirname(temporary) === path.resolve(os.tmpdir()) &&
        path.basename(temporary).startsWith('thalassa-ui-data142-')
    )
        await fs.rm(temporary, { recursive: true, force: true });
});

const decode = (values: string[]) => {
    const packed = packCompactStringData(values);
    return { packed, values: decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum) };
};
const compileTs = (source: string, file: string) =>
    ts.transpileModule(source, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;

it('retains every original selected UI/SVG value and restores all five actual tables exactly under the original limits', () => {
    const original = [...legacy.flat(), ...legacyPaths];
    expect(original.length).toBeGreaterThanOrEqual(8531);
    const current = new Set([...pools.flat(), ...paths]);
    expect(original.filter((value) => !current.has(value))).toEqual([]);
    expect(pools).toHaveLength(4);
    expect(paths).toHaveLength(374);
    expect(legacyPaths).toHaveLength(80);
    for (const values of [...pools, paths]) {
        const restored = decode(values);
        expect(restored.values).toEqual(values);
        expect(Object.isFrozen(restored.values)).toBe(true);
        expect(restored.packed.bytes).toBeLessThanOrEqual(128000);
        expect(restored.packed.encoded.length).toBeLessThanOrEqual(64000);
        expect(values.length).toBeLessThanOrEqual(4096);
        expect(values.reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(240000);
    }
    const decoder = originalDecoderHash();
    expect(decoder).toBe('a221b18976fe54913e67e915f9af23b5390444e3637266b81a03f739b19a7a8e');
});

// Pin the original decoder itself, rather than copying a permissive decoder into a fixture.
function originalDecoderHash() {
    return createHash('sha256')
        .update(ts.sys.readFile(path.join(root, 'utils/decodeClassNames.ts'))!.replaceAll('\r\n', '\n'))
        .digest('hex');
}

it('chooses deterministic bounded representations while preserving unusual Unicode, empty words and exact whitespace', () => {
    const values = [
        '',
        '   ',
        ' a  b\tc\n ',
        'text-["☀️"] \\ escaped',
        '\ud800',
        ...Array.from({ length: 180 }, (_, i) => `exact value ${i} repeated repeated words`),
    ];
    expect(decode(values).values).toEqual(values);
    expect(packCompactStringData(values)).toEqual(packCompactStringData([...values]));
    expect(() => packCompactStringData(Array(4097).fill('data'))).toThrow(/bounds/);
    expect(() => packCompactStringData(['x'.repeat(4097)])).toThrow(/bounds/);
    expect(() =>
        packUiStringPools(
            Array.from({ length: 5 }, () => ['data']),
            { standalone: true },
        ),
    ).toThrow(/aggregate bounds/);
});

it('keys build-only source reuse by exact bytes and isolates caller Maps even after same-length source edits', async () => {
    const directory = path.join(temporary, 'snapshot');
    await fs.mkdir(directory);
    const file = path.join(directory, 'App.tsx');
    const first = 'Exact first visible authored statement.',
        second = 'Exact other visible authored statement.';
    expect(first.length).toBe(second.length);
    await fs.writeFile(file, `export const word=${JSON.stringify(first)};`);
    const counts = collectUiLiteralCounts(directory);
    expect(counts.get(first)).toBe(1);
    counts.delete(first);
    expect(collectUiLiteralCounts(directory).get(first)).toBe(1);
    const before = await fs.stat(file);
    await fs.writeFile(file, `export const word=${JSON.stringify(second)};`);
    await fs.utimes(file, before.atime, before.mtime);
    const changed = collectUiLiteralCounts(directory);
    expect(changed.has(first)).toBe(false);
    expect(changed.get(second)).toBe(1);
});

it('retains corruption, schema, trailing checksum and expansion-bomb refusals with the original bounded decoder', () => {
    const p = packCompactStringData(['exact static CSS data with two spaces  retained']);
    expect(() => decodeClassNames(p.encoded, p.bytes, p.count, p.checksum ^ 1)).toThrow(/checksum/);
    expect(() => decodeClassNames('A'.repeat(64001), p.bytes, p.count, p.checksum)).toThrow(/bounds/);
    expect(() => decodeClassNames(p.encoded, 128001, p.count, p.checksum)).toThrow(/bounds/);
    for (const value of [
        [['word'], ['1']],
        [[5], ['0']],
        [['word'], ['-1']],
        [['word'], ['!']],
        [['x'.repeat(4096)], [Array(100).fill('0').join(' ')]],
    ]) {
        const raw = Buffer.from(JSON.stringify(value)),
            zipped = deflateSync(raw);
        expect(() =>
            decodeClassNames(zipped.toString('base64'), raw.length, 1, zipped.readUInt32BE(zipped.length - 4)),
        ).toThrow();
    }
});

it('pins every actual CSS owner, matches its compiler-cooked fragments, and reverses every source token exactly', () => {
    expect(Object.keys(STATIC_CSS_SOURCES142)).toHaveLength(26);
    const unique = new Set<string>();
    let fragments = 0,
        edited = 0;
    for (const [file, spec] of Object.entries(STATIC_CSS_SOURCES142) as [string, { literals: number }][]) {
        const source = assertStaticCssSource(root, file);
        const rows = staticCssSourceRows(source, file);
        for (const row of rows) unique.add(row.value);
        expect(rows, file).toHaveLength(spec.literals);
        fragments += rows.length;
        const compiled = compileTs(source, file),
            ranges = compiledCssRanges(compiled);
        expect(ranges.map((range: { value: string }) => range.value).sort(), file).toEqual(
            rows.map((row: { value: string }) => row.value).sort(),
        );
        const result = shareUiStringLiterals(compiled, path.join(root, file), {
            root,
            values: pools.flat(),
            parse: parseAst,
        });
        if (!result) continue;
        let reversed = result.code.slice(result.prelude.length);
        for (const rewrite of [...result.rewrites].sort((a, b) => a.start - b.start)) {
            const at = reversed.indexOf(rewrite.replacement);
            expect(at, file).toBeGreaterThanOrEqual(0);
            reversed = reversed.slice(0, at) + rewrite.original + reversed.slice(at + rewrite.replacement.length);
        }
        expect(reversed, file).toBe(compiled);
        expect(result.map.sourcesContent).toEqual([compiled]);
        expect(() => parseAst(result.code), file).not.toThrow();
        edited += result.replacements;
    }
    expect(fragments).toBe(124);
    expect(unique.size).toBe(117);
    expect(edited).toBeGreaterThan(90);
});

it('refuses drifted canonical CSS owners and never expands into bootstrap, chat, errors or protocol fields', async () => {
    const file = Object.keys(STATIC_CSS_SOURCES142)[0];
    await fs.mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await fs.writeFile(path.join(temporary, file), assertStaticCssSource(root, file) + '\n// unreviewed drift');
    expect(() => assertStaticCssSource(temporary, file)).toThrow(/Unreviewed/);
    for (const file of [
        'pages/ChatPage.tsx',
        'utils/readPackedUiData.ts',
        'utils/readPreloadData.ts',
        'utils/decodeClassNames.ts',
    ])
        expect(isStaticCssSource(file)).toBe(false);
    const text = 'color:red; background:blue; exact static CSS';
    const code = `export const protocol={message:${JSON.stringify(text)}};export function run(target){target.style.cssText=${JSON.stringify(text)}}`;
    const result = shareUiStringLiterals(code, path.join(root, 'components/map/useConsensusMatrix.ts'), {
        root,
        values: [text],
        parse: parseAst,
    });
    expect(result?.replacements).toBe(1);
    expect(result?.code).toContain(`message:${JSON.stringify(text)}`);
});

it('matches only untagged CSS contexts with actual lexical style variables and React imports', () => {
    const value = 'color:red; background:blue; exact static CSS',
        literal = JSON.stringify(value);
    const code = `import {jsx as h} from 'react/jsx-runtime';
      const style=document.createElement('style');style.textContent=${literal};
      export const a=h('style',{children:${literal}});
      export function foreign(h,style,document){style.textContent=${literal};h('style',{children:${literal}});const other=document.createElement('style');other.textContent=${literal};}
      export function tag(target){target.style.cssText=String.raw\`${value}\`;}
      export const ignored={cssText:${literal},textContent:${literal}};`;
    expect(compiledCssRanges(code).map((row: { value: string }) => row.value)).toEqual([value, value]);
    expect(compiledCssRanges(`let style=document.createElement('style');style.textContent=${literal};`)).toEqual([]);
    expect(
        compiledCssRanges(`const style=document.createElement('style');style=foreign;style.textContent=${literal};`),
    ).toEqual([]);
});

async function bundle(source: string, plugins: Plugin[] = []) {
    const id = path.join(temporary, 'fixture.mjs');
    const result = await build({
        root: temporary,
        configFile: false,
        cacheDir: path.join(temporary, '.vite-ui142'),
        logLevel: 'silent',
        plugins: [
            {
                name: 'exact-ui142-fixture',
                resolveId(value) {
                    return value === 'ui142-fixture' ? id : null;
                },
                load(value) {
                    return value === id ? source : null;
                },
            },
            ...plugins,
        ],
        build: {
            write: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: 'ui142-fixture',
                preserveEntrySignatures: 'strict',
                output: { inlineDynamicImports: true, format: 'es' },
            },
        },
    });
    if (Array.isArray(result) || !('output' in result)) throw Error('Expected one isolated fixture build');
    const chunks = result.output.filter((item) => item.type === 'chunk');
    expect(chunks).toHaveLength(1);
    return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(chunks[0].code).toString('base64')}`);
}

it('preserves CSS text, literal escapes, template coercion/effect order and lazy style assignment after actual minification', async () => {
    const head = 'color:red;  background:"⚓"; padding:1px; ',
        tail = '; border:1px solid red; /* exact spaces  */';
    const source = `export function run(target){const effects=[];const value={toString(){effects.push('coerce');return '3px'}};const choose=()=>{effects.push('choose');return value};target.style.cssText=\`${head}\${choose()}${tail}\`;effects.push('after');return {effects,text:target.style.cssText};}`;
    const ranges = compiledCssRanges(source);
    expect(ranges).toHaveLength(2);
    const values = ranges.map((row: { value: string }) => row.value);
    const transformed = shareUiStringLiterals(source, path.join(root, 'components/map/useConsensusMatrix.ts'), {
        root,
        values,
        parse: parseAst,
    });
    expect(transformed?.replacements).toBe(2);
    expect(transformed?.code).toContain('${choose()}');
    const table: Plugin = {
        name: 'original-bounded-ui142-table',
        resolveId(id) {
            if (id === 'virtual:thalassa-ui-strings') return '\0ui142-table';
            if (id === 'virtual:thalassa-class-data-decoder') return path.join(root, 'utils/decodeClassNames.ts');
        },
        load(id) {
            return id === '\0ui142-table' ? packUiStringPools([values], { standalone: true }) : null;
        },
    };
    const baseline = await bundle(source),
        packed = await bundle(transformed!.code, [table]);
    expect(packed.run({ style: {} })).toEqual(baseline.run({ style: {} }));
    expect(packed.run({ style: {} }).effects).toEqual(['choose', 'coerce', 'after']);
});

it('preserves all three new contiguous SVG runs at their exact positions, primitive types, child order and effects', async () => {
    expect(SVG_LITERAL_RUNS142).toHaveLength(3);
    const source = `import {jsx as h} from 'react/jsx-runtime';export function run(){const effects=[];const node=h('svg',{id:'outer',fill:'none',viewBox:'0 0 24 24',onClick:()=>effects.push('clicked'),children:[h('path',{id:'child',strokeLinecap:'round',strokeLinejoin:'round',strokeWidth:2,d:'M0 0h24'}),h('svg',{id:'other',viewBox:'0 0 24 24',fill:'currentColor'})]});return {node,effects};}`;
    const marked = shareSvgAttributes(source, path.join(root, 'components/Proof.tsx'), { root, parse: parseAst });
    expect(marked?.elements).toBe(3);
    const jsx: Plugin = {
        name: 'jsx142-proof-structural-values',
        resolveId(id) {
            return id === 'react/jsx-runtime' ? '\0jsx142-proof' : null;
        },
        load(id) {
            return id === '\0jsx142-proof'
                ? 'export function jsx(tag,props){return {tag,props,keys:Object.keys(props)}}'
                : null;
        },
    };
    const baseline = await bundle(source, [jsx]),
        packed = await bundle(marked!.code, [jsx, shareSvgProps(root)]);
    const inspect = (module: typeof baseline) => {
        const value = module.run();
        value.node.props.onClick();
        delete value.node.props.onClick;
        return value;
    };
    expect(inspect(packed)).toEqual(inspect(baseline));
    expect(inspect(packed).node.props.children[0].props.strokeWidth).toBe(2);
});

it.each([
    "h('path',{strokeLinecap:'round',strokeLinejoin:'round',...custom})",
    "h('path',{strokeLinecap:'round',strokeLinejoin:'round',strokeLinecap:'square'})",
    "h('path',{strokeLinecap:'round',[key]:'round',strokeLinejoin:'round'})",
    "h('path',{strokeLinecap:'round',id:effect(),strokeLinejoin:'round'})",
    "h('path',{strokeLinecap:'round',strokeLinejoin:value})",
    "h('foreign',{strokeLinecap:'round',strokeLinejoin:'round'})",
])('does not factor unsafe, dynamic or noncontiguous SVG data: %s', (expression) => {
    const code = `import {jsx as h} from 'react/jsx-runtime';export const x=${expression};`;
    expect(shareSvgAttributes(code, path.join(root, 'components/Proof.tsx'), { root, parse: parseAst })).toBeNull();
});

it('keeps UI tables and CSS owners out of worker/route closures and disables worker table resolution', () => {
    const graph = new Set([
        ...routeJobClosure(root).keys(),
        ...staticAppGraph(root, [
            'services/charts/localRasterWorker.ts',
            'services/enc/encParseWorker.ts',
            'services/enc/encGeometryWorker.ts',
            'services/userOverlays/worker.ts',
            'services/weather/gribImportWorker.ts',
        ]).keys(),
    ]);
    expect([...graph].filter((file) => isStaticCssSource(file))).toEqual([]);
    const plugin = shareUiStrings(root, { standalone: true });
    if (
        typeof plugin.configResolved !== 'function' ||
        typeof plugin.resolveId !== 'function' ||
        typeof plugin.load !== 'function' ||
        typeof plugin.transform !== 'function'
    )
        throw Error('Expected callable plugin hooks');
    // Vite resolves no table or transform in its separate worker build.
    plugin.configResolved.call({} as never, { isProduction: true, isWorker: true } as never);
    expect(
        plugin.resolveId.call({} as never, 'virtual:thalassa-ui-strings', undefined, {
            isEntry: false,
            attributes: {},
        }),
    ).toBeNull();
    expect(plugin.load.call({} as never, '\0virtual:thalassa-ui-strings')).toBeNull();
    expect(
        plugin.transform.call({} as never, 'export const text="unchanged";', path.join(root, 'components/Proof.tsx')),
    ).toBeNull();
});
