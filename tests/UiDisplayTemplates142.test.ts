// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'vite';
import {
    collectUiDisplayTemplateCounts,
    isUiDisplayTemplateSource,
    rewriteUiDisplayTemplates,
    uiDisplayTemplateRows,
} from '../scripts/ui-display-templates142.mjs';
import { regroupUiStringPools, shareUiDisplayTemplates, shareUiStrings } from '../scripts/share-ui-strings.mjs';

const file = 'components/Example.tsx';
const head = ' Exact authored display text with two  spaces, Unicode ⚓ and a newline\n';
const tail = ' final display text with exact tabs\t and more than forty characters.';
let root: string;
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-display-templates142-'));
    await fs.mkdir(path.join(root, 'components'));
});
afterAll(async () => {
    vi.unstubAllEnvs();
    if (
        root &&
        path.dirname(root) === path.resolve(os.tmpdir()) &&
        path.basename(root).startsWith('thalassa-display-templates142-')
    )
        await fs.rm(root, { recursive: true, force: true });
});

it('admits only cooked JSX children/display attributes and preserves exact raw source boundaries', () => {
    const code = 'export const x=<section title={`' + head + '${value}' + tail + '`}>{`' + tail + '`}</section>;';
    const rows = uiDisplayTemplateRows(code, file);
    expect(rows.map((row: { value: string }) => row.value)).toEqual([head, tail, tail]);
    const result = rewriteUiDisplayTemplates(code, file, [head, tail]);
    expect(result?.rewrites).toHaveLength(3);
    expect(result?.code).toContain('${value}');
    expect(result?.code).toContain('title={`');
    expect(result?.code).not.toContain(head);
    expect(result?.rewrites[0].original).toBe(head);
    expect(result?.rewrites[2].original).toBe('`' + tail + '`');
    expect(uiDisplayTemplateRows('export const bad=<div>{`unterminated', file)).toEqual([]);
});

it('leaves scripts/styles, tags, assets, event code, standalone data, errors, prompts and program/transport values intact', () => {
    const literal = '`' + tail + '`';
    const expressions = [
        'const x=<script>{' + literal + '}</script>;',
        'const x=<SCRIPT>{' + literal + '}</SCRIPT>;',
        'const x=<style>{' + literal + '}</style>;',
        'const x=<div>{String.raw' + literal + '}</div>;',
        'const x=<div>{tag' + literal + '}</div>;',
        'const x=<img src={' + literal + '}/>;',
        'const x=<a href={' + literal + '}/>;',
        'const x=<button onClick={()=>send(' + literal + ')}/>;',
        'const x=<div dangerouslySetInnerHTML={{__html:' + literal + '}}/>;',
        'const x=<div>{new URL(' + literal + ',import.meta.url)}</div>;',
        'const x=<div>{new Worker(' + literal + ')}</div>;',
        'const x=<div>{import.meta.glob([' + literal + '])}</div>;',
        'const x=<div>{import(' + literal + ')}</div>;',
        'const x=<div>{setError(' + literal + ')}</div>;',
        'const x=<div>{console.warn(' + literal + ')}</div>;',
        'const x=<div>{console["warn"](' + literal + ')}</div>;',
        'const x=<div>{new Error(' + literal + ')}</div>;',
        'const x=<div>{fetch(' + literal + ')}</div>;',
        'const x=<div>{prompt(' + literal + ')}</div>;',
        'const x=<div>{eval(' + literal + ')}</div>;',
        'const x=<div>{new Function(' + literal + ')}</div>;',
        'const x=<div>{format({prompt:' + literal + '})}</div>;',
        'const x=<div>{buildPrompt(' + literal + ')}</div>;',
        'const x=<div>{compileProgram(' + literal + ')}</div>;',
        'const x=<div>{compileShader(' + literal + ')}</div>;',
        'const x=<div>{executeCommand(' + literal + ')}</div>;',
        'const x=<div>{opaqueOperation(' + literal + ')}</div>;',
        'const x=<div>{opaque["call"](' + literal + ')}</div>;',
        'const x=<div>{({unknownProperty:' + literal + '})}</div>;',
        'const x={text:' + literal + ',prompt:' + literal + '};',
        'const x=<div>{`https://provider.example.test/' + tail + '`}</div>;',
        'const x=<div>{`void main() { gl_FragColor=vec4(1.0); }' + tail + '`}</div>;',
        'const x=<div>{`<script>display();</script>' + tail + '`}</div>;',
        'const x=<div>{`<gpx><trk>protocol</trk></gpx>' + tail + '`}</div>;',
        'const x=<code>{`const program = function run(){return true;}' + tail + '`}</code>;',
        'const x=<code>{`uniform sampler2D image; varying vec2 position;' + tail + '`}</code>;',
    ];
    for (const source of expressions) {
        expect(uiDisplayTemplateRows(source, file), source).toEqual([]);
        expect(rewriteUiDisplayTemplates(source, file, [tail]), source).toBeNull();
    }
    const short = 'const x=<div>{`short`}</div>;',
        oversized = 'const x=<div>{`' + 'x'.repeat(4097) + '`}</div>;';
    expect(uiDisplayTemplateRows(short, file)).toEqual([]);
    expect(uiDisplayTemplateRows(oversized, file)).toEqual([]);
    expect(
        uiDisplayTemplateRows('const x=items.map(item=><div>{`' + tail + '${item}' + tail + '`}</div>);', file),
    ).toHaveLength(2);
});

it('avoids escaped declared and free identifier capture using compiler-normalized names', () => {
    const escaped = '__thalassaUiDisplayTempl\\u0061tes';
    for (const prefix of ['const ' + escaped + '="existing";', 'export const free=' + escaped + ';']) {
        const source = prefix + 'export const x=<div>{`' + tail + '`}</div>;',
            result = rewriteUiDisplayTemplates(source, file, [tail]);
        expect(result?.binding).toBe('__thalassaUiDisplayTemplates_');
        expect(result?.code).toContain(prefix);
    }
});

it.each([
    'services/worker.tsx',
    'components/Example.worker.tsx',
    'components/ExampleWorker.tsx',
    'components/workers/X.tsx',
    'components/ChatPage.tsx',
    'src/App.tsx',
    'components/Example.test.tsx',
    'utils/readPackedUiData.ts',
])('refuses non-UI, private/bootstrap or worker source: %s', (name) => {
    expect(isUiDisplayTemplateSource(name)).toBe(false);
    expect(rewriteUiDisplayTemplates('const x=<div>{`' + tail + '`}</div>;', name, [tail])).toBeNull();
});

it('keeps content-addressed snapshots isolated across same-size edits and returned Map mutation', async () => {
    const target = path.join(root, 'components', 'Cache.tsx'),
        one = 'a'.repeat(40),
        two = 'b'.repeat(40);
    await fs.writeFile(target, 'const x=<div>{`' + one + '`}</div>;');
    const original = await fs.stat(target),
        a = collectUiDisplayTemplateCounts(root);
    expect(a.has(one)).toBe(true);
    a.clear();
    expect(collectUiDisplayTemplateCounts(root).has(one)).toBe(true);
    await fs.writeFile(target, 'const x=<div>{`' + two + '`}</div>;');
    await fs.utimes(target, original.atime, original.mtime);
    expect([...collectUiDisplayTemplateCounts(root).keys()]).toEqual([two]);
    await fs.unlink(target);
});

it('regroups deterministically without dropping any value and refuses a fifth pool or oversized output', () => {
    const values = Array.from({ length: 100 }, (_, i) => `exact entry ${i} with repeated words and Unicode ⚓`);
    const pools = regroupUiStringPools(values);
    expect(regroupUiStringPools([...values].reverse())).toEqual(pools);
    expect(new Set(pools.flat())).toEqual(new Set(values));
    expect(() => regroupUiStringPools(['x'.repeat(4097)])).toThrow();
    expect(() => regroupUiStringPools(Array.from({ length: 16385 }, (_, i) => String(i)))).toThrow(/unchanged four/);
});

async function bundle(entry: string, enabled: boolean, worker = false) {
    const decoder: Plugin = {
        name: 'original-display-decoder',
        resolveId(id) {
            return id === 'virtual:thalassa-class-data-decoder' ? path.resolve('utils/decodeClassNames.ts') : null;
        },
    };
    const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        cacheDir: path.join(root, '.vite-templates'),
        esbuild: { jsxFactory: 'h', jsxFragment: 'Fragment' },
        plugins: enabled ? [decoder, shareUiDisplayTemplates(root), shareUiStrings(root, { standalone: true })] : [],
        worker: { plugins: () => [shareUiDisplayTemplates(root), shareUiStrings(root, { standalone: true })] },
        build: {
            write: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: entry,
                preserveEntrySignatures: 'strict',
                output: worker ? {} : { inlineDynamicImports: true, format: 'es' },
            },
        },
    });
    if (Array.isArray(result) || !('output' in result)) throw Error('Expected one isolated fixture build');
    return result.output;
}

it('preserves minified rendered values, property order, handlers, Unicode and immediate coercion/exception order', async () => {
    const entry = path.join(root, 'components', 'Coercion.tsx');
    const rawHead = JSON.stringify(head).slice(1, -1),
        rawTail = JSON.stringify(tail).slice(1, -1);
    await fs.writeFile(
        entry,
        'function h(tag,props,...children){return{tag,props,children}};export function run(symbol){const effects=[];const choose=()=>{effects.push("choose");return symbol?Symbol("x"):{[Symbol.toPrimitive](hint){effects.push(hint);return "⚓"}}};const __thalassaUiDisplayTempl\\u0061tes="collision";try{const node=<section title={`' +
            rawTail +
            '`} onClick={()=>effects.push("clicked")}>{`' +
            rawHead +
            '${choose()}' +
            rawTail +
            '${(effects.push("last"),3)}' +
            rawTail +
            '`}</section>;return{node,effects,binding:__thalassaUiDisplayTempl\\u0061tes}}catch(e){return{effects,error:e.name}}}',
    );
    const original = await bundle(entry, false),
        packed = await bundle(entry, true);
    const execute = async (chunks: Awaited<ReturnType<typeof bundle>>) => {
        const scripts = chunks.filter((chunk) => chunk.type === 'chunk');
        expect(scripts).toHaveLength(1);
        const module = await import(
            /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(scripts[0].code).toString('base64')}`
        );
        const ordinary = module.run(false),
            propertyOrder = Object.keys(ordinary.node.props);
        ordinary.node.props.onClick();
        delete ordinary.node.props.onClick;
        return { ordinary, propertyOrder, symbol: module.run(true) };
    };
    const a = await execute(original),
        b = await execute(packed);
    expect(b).toEqual(a);
    expect(b.ordinary.effects).toEqual(['choose', 'string', 'last', 'clicked']);
    expect(b.symbol).toEqual({ effects: ['choose'], error: 'TypeError' });
    expect(b.ordinary.node.children).toEqual([head + '⚓' + tail + '3' + tail]);
});

it('preserves an escaped free reference after actual minification instead of capturing the new table alias', async () => {
    const entry = path.join(root, 'components', 'FreeReference.tsx');
    await fs.writeFile(
        entry,
        'function h(tag,props,...children){return{tag,props,children}};export function read(){return <div>{`' +
            JSON.stringify(head).slice(1, -1) +
            '${__thalassaUiDisplayTempl\\u0061tes}' +
            JSON.stringify(tail).slice(1, -1) +
            '`}</div>}',
    );
    vi.stubGlobal('__thalassaUiDisplayTemplates', 'external-free-reference');
    try {
        for (const enabled of [false, true]) {
            const output = await bundle(entry, enabled),
                chunks = output.filter((item) => item.type === 'chunk');
            expect(chunks).toHaveLength(1);
            const module = await import(
                /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(chunks[0].code).toString('base64')}`
            );
            expect(module.read().children).toEqual([head + 'external-free-reference' + tail]);
        }
    } finally {
        vi.unstubAllGlobals();
    }
});

it('keeps a real separate Vite worker free of UI tables, decoder imports and DOM even when worker plugins are installed', async () => {
    const entry = path.join(root, 'worker-entry.ts'),
        worker = path.join(root, 'actual-worker.ts');
    await fs.writeFile(
        entry,
        'export const create=()=>new Worker(new URL("./actual-worker.ts",import.meta.url),{type:"module"});',
    );
    await fs.writeFile(worker, 'self.postMessage(' + JSON.stringify(tail) + ');');
    const output = await bundle(entry, true, true);
    const scripts = output
        .filter((item) => item.fileName.endsWith('.js'))
        .map((item) => (item.type === 'chunk' ? item.code : Buffer.from(item.source).toString()));
    const actual = scripts.find((text) => text.includes('postMessage'));
    expect(actual).toBeTruthy();
    expect(actual).toContain(tail.replaceAll('\t', '\\t'));
    expect(actual).not.toMatch(/decodeClassNames|readPackedUiData|thalassa-ui-strings|document[.]/);
    const plugin = shareUiDisplayTemplates(root);
    if (typeof plugin.configResolved !== 'function' || typeof plugin.transform !== 'function')
        throw Error('Expected callable source hooks');
    plugin.configResolved.call({} as never, { isProduction: true, isWorker: true } as never);
    expect(
        plugin.transform.call({} as never, 'const x=<div>{`' + tail + '`}</div>;', path.join(root, file)),
    ).toBeNull();
});
