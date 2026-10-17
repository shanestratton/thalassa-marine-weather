// @vitest-environment node
import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { inertPreloadData } from '../scripts/inert-preload-data.mjs';
import { inertUiDataWorkerFence } from '../scripts/inert-ui-data.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-preload140-'));
vi.stubEnv('NODE_ENV', 'production');
const source = path.join(root, 'source');
fs.mkdirSync(path.join(source, 'utils'), { recursive: true });
const runtime = fs.readFileSync('utils/readPreloadData.ts', 'utf8');
fs.writeFileSync(path.join(source, 'utils/readPreloadData.ts'), runtime);
for (let i = 0; i < 3; i++)
    fs.writeFileSync(path.join(source, `shared${i}.js`), `export function value(){return 'shared${i}';}`);
for (const kind of ['a', 'b']) {
    fs.writeFileSync(
        path.join(source, `${kind}.html`),
        `<html><head><meta charset="utf-8"></head><body><button>Open</button><script type="module" src="/${kind}.js"></script></body></html>`,
    );
    fs.writeFileSync(
        path.join(source, `${kind}.js`),
        `document.querySelector('button').onclick=()=>import('./lazy-${kind}.js').then(m=>{document.body.dataset.loaded=m.value});`,
    );
    fs.writeFileSync(
        path.join(source, `lazy-${kind}.js`),
        `import './${kind}.css';${[0, 1, 2].map((i) => `import{value as v${i}}from'./shared${i}.js';`).join('')}export const value='${kind}'+v0()+v1()+v2();`,
    );
    fs.writeFileSync(path.join(source, `${kind}.css`), `button{color:${kind === 'a' ? 'red' : 'blue'}}`);
}
async function compile(label: string, jsEntry = false, collapsed = false) {
    const output = path.join(root, label);
    await build({
        configFile: false,
        root: source,
        publicDir: false,
        logLevel: 'silent',
        plugins: [inertPreloadData(source)],
        worker: { format: 'es', plugins: () => [inertUiDataWorkerFence(source)] },
        build: {
            outDir: output,
            sourcemap: 'hidden',
            modulePreload: collapsed ? { polyfill: false } : undefined,
            minify: 'terser',
            rollupOptions: {
                input: collapsed
                    ? path.join(source, 'collapsed.html')
                    : jsEntry
                      ? path.join(source, 'a.js')
                      : { a: path.join(source, 'a.html'), b: path.join(source, 'b.html') },
                output: {
                    manualChunks(id) {
                        if (id.endsWith('/utils/readPreloadData.ts')) return 'preload-data';
                        const shared = id.match(/shared(\d)\.js$/);
                        if (shared) return `shared${shared[1]}-${'long-known-fixture-name-'.repeat(3)}`;
                    },
                },
            },
        },
    });
    return {
        output,
        files: new Map(
            fs
                .readdirSync(path.join(output, 'assets'))
                .filter((name) => name.endsWith('.js'))
                .map((name) => [name, fs.readFileSync(path.join(output, 'assets', name), 'utf8')]),
        ),
    };
}
afterAll(() => {
    vi.unstubAllEnvs();
    // Only this test's explicitly created temporary directory may be removed.
    const target = path.resolve(root),
        parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('thalassa-preload140-'))
        throw Error('Unsafe fixture cleanup');
    fs.rmSync(target, { recursive: true });
});

it('preserves cached asset identity, local document ownership and source mappings across two independent entry graphs', async () => {
    const first = await compile('first');
    const aHtml = fs.readFileSync(path.join(first.output, 'a.html'), 'utf8'),
        bHtml = fs.readFileSync(path.join(first.output, 'b.html'), 'utf8');
    const ids = (html: string) => [...html.matchAll(/id="(thalassa-preload-[a-f0-9]{64})"/g)].map((match) => match[1]);
    expect(ids(aHtml)).toHaveLength(1);
    expect(ids(bHtml)).toHaveLength(1);
    expect(ids(aHtml)).not.toEqual(ids(bHtml));
    expect(aHtml).toMatch(/rel="modulepreload"[^>]+preload-data-/);
    const bEntry = [...first.files.keys()].find((name) => /^b-/.test(name))!;
    const bCode = first.files.get(bEntry)!;
    const map = JSON.parse(fs.readFileSync(path.join(first.output, 'assets', bEntry + '.map'), 'utf8'));
    expect(map.mappings.split(';')[0]).toBe('');
    expect(bCode).toContain(ids(bHtml)[0]);
    expect(bCode).not.toContain(ids(aHtml)[0]);

    const aPath = path.join(source, 'lazy-a.js');
    fs.writeFileSync(aPath, fs.readFileSync(aPath, 'utf8').replace("value='a'", "value='changed-a'"));
    const second = await compile('second');
    // Changing another local array must not alter an unchanged chunk or its key.
    expect(second.files.get(bEntry)).toBe(bCode);
    expect(ids(fs.readFileSync(path.join(second.output, 'b.html'), 'utf8'))).toEqual(ids(bHtml));
    for (const [name, code] of first.files)
        if (second.files.has(name)) expect(second.files.get(name), `immutable ${name}`).toBe(code);

    fs.writeFileSync(
        path.join(source, 'utils/readPreloadData.ts'),
        runtime.replace('Reload the app.', 'Reload this app.'),
    );
    const third = await compile('reader-change');
    // Reader edits are ordinary import dependencies and change importer hashes.
    expect(third.files.has(bEntry)).toBe(false);
    for (const [name, code] of second.files)
        if (third.files.has(name)) expect(third.files.get(name), `immutable after reader edit ${name}`).toBe(code);
}, 20_000);

it('executes a dynamic import collapsed into its already-loaded entry with Vite’s actual absent preload list', async () => {
    fs.writeFileSync(
        path.join(source, 'collapsed.html'),
        '<html><head><meta charset="utf-8"></head><body><script type="module" src="/collapsed.js"></script></body></html>',
    );
    fs.writeFileSync(path.join(source, 'collapsed-shared.js'), "export const value='same-loaded-module';");
    fs.writeFileSync(
        path.join(source, 'collapsed.js'),
        "import{value}from'./collapsed-shared.js';globalThis.collapsedValue=value;globalThis.loadCollapsed=()=>import('./collapsed-shared.js').then(m=>m.value);",
    );
    const result = await compile('collapsed', false, true);
    const entry = [...result.files.keys()].find((name) => /^collapsed-/.test(name))!;
    expect(result.files.get(entry)).toContain('(void 0)');
    const html = fs.readFileSync(path.join(result.output, 'collapsed.html'), 'utf8');
    expect(html).not.toContain('id="thalassa-preload-');
    const runner = path.join(root, 'run-collapsed.mjs');
    fs.writeFileSync(
        runner,
        `globalThis.window={dispatchEvent(){return true}};await import(${JSON.stringify(pathToFileURL(path.join(result.output, 'assets', entry)).href)});console.log(JSON.stringify([globalThis.collapsedValue,await globalThis.loadCollapsed()]));`,
    );
    const run = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(['same-loaded-module', 'same-loaded-module']);
}, 20_000);

it('refuses a bare JavaScript entry instead of creating a document-data fallback', async () => {
    await expect(compile('bare-js', true)).rejects.toThrow('Preload data requires a document');
}, 20_000);

it('refuses the document reader in an actual independent Vite worker build', async () => {
    const main = path.join(source, 'a.js'),
        original = fs.readFileSync(main, 'utf8');
    fs.writeFileSync(main, original + "new Worker(new URL('./worker.js',import.meta.url),{type:'module'});");
    fs.writeFileSync(
        path.join(source, 'worker.js'),
        "import{readPreloadData}from'./utils/readPreloadData.ts';postMessage(readPreloadData('invalid',1,1,1));",
    );
    try {
        await expect(compile('worker-dom')).rejects.toThrow(/worker cannot import the inert UI DOM reader/);
    } finally {
        fs.writeFileSync(main, original);
    }
}, 20_000);
