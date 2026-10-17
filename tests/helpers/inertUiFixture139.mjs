/** Synthetic mini Vite document graph, shared by unit and real-browser proofs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { inertUiData, inertUiDataWorkerFence } from '../../scripts/inert-ui-data.mjs';
import { shareClassNames, collectClassNames } from '../../scripts/share-class-names.mjs';
import { shareUiStrings, collectUiStringPools } from '../../scripts/share-ui-strings.mjs';
import { shareSvgPaths, collectSvgPaths } from '../../scripts/share-svg-paths.mjs';

export async function buildInertUiFixture(root, outDir, options = {}) {
    const repo = process.cwd();
    await fs.mkdir(root, { recursive: true });
    const classes = Array.from(
        { length: 300 },
        (_, i) =>
            `flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm marker-${i}`,
    );
    const messages = Array.from(
        { length: 40 },
        (_, i) =>
            `Synthetic display message ${i}: a skipper reviews this fictional passage carefully before departure.`,
    );
    const svg = Array.from({ length: 36 }, (_, i) => `M${i} 0 L${i + 1} 2 L${i + 2} 4 L${i + 3} 6 L${i + 4} 8 Z`);
    await fs.writeFile(
        path.join(root, 'App.tsx'),
        `<div>${classes.map((v) => `<span className=${JSON.stringify(v)} />`.repeat(2)).join('')}${messages
            .map((v) => `<p>${v}</p>`)
            .join('')}${svg.map((v) => `<path d=${JSON.stringify(v)} />`.repeat(4)).join('')}</div>`,
    );
    const html = (entry) =>
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';worker-src 'self';connect-src 'self'"></head><body><div id="root"></div><button id="dynamic">Dynamic class</button><button id="worker">Worker</button><script type="module" src="/${entry}.js"${options.async ? ' async' : ''}></script></body></html>`;
    for (const name of ['index', 'logs', 'beta', 'feedback', 'ocean'])
        await fs.writeFile(path.join(root, name + '.html'), html(name));
    await fs.writeFile(
        path.join(root, 'index.js'),
        `import {values as ui} from 'virtual:thalassa-ui-strings';import {values as svg} from 'virtual:thalassa-svg-paths';
globalThis.fixture={ui,svg,frozen:Object.isFrozen(ui)&&Object.isFrozen(svg)};
document.getElementById('root').textContent=ui[0];globalThis.providerMounted=true;
document.getElementById('dynamic').onclick=async()=>{const {values}=await import('virtual:thalassa-class-names');globalThis.fixture.classes=values;document.getElementById('root').className=values[0];};
document.getElementById('worker').onclick=()=>{const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});worker.onmessage=({data})=>{globalThis.workerResult=data;worker.terminate();};};`,
    );
    await fs.writeFile(
        path.join(root, 'logs.js'),
        `import {values as ui} from 'virtual:thalassa-ui-strings';import {values as classes} from 'virtual:thalassa-class-names';import {values as svg} from 'virtual:thalassa-svg-paths';globalThis.fixture={ui,classes,svg,frozen:Object.isFrozen(ui)&&Object.isFrozen(classes)&&Object.isFrozen(svg)};document.getElementById('root').textContent=ui[0];document.getElementById('root').className=classes[0];globalThis.providerMounted=true;`,
    );
    for (const name of ['beta', 'feedback', 'ocean'])
        await fs.writeFile(
            path.join(root, name + '.js'),
            `document.getElementById('root').textContent='${name} independent';`,
        );
    await fs.writeFile(path.join(root, 'worker.js'), 'postMessage([2,3,5].map(value=>value*value));');
    if (options.workerDom)
        await fs.writeFile(
            path.join(root, 'worker.js'),
            `import {readPackedUiData} from ${JSON.stringify(path.resolve(repo, 'utils/readPackedUiData.ts'))};postMessage(readPackedUiData('invalid',8,1,1,1));`,
        );
    const data = inertUiData(repo);
    const output = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
            data.plugin,
            shareClassNames(root, { data }),
            shareUiStrings(root, { data }),
            shareSvgPaths(root, { data }),
        ],
        worker: { format: 'es', plugins: () => [inertUiDataWorkerFence(repo)] },
        build: {
            write: options.write ?? true,
            outDir,
            emptyOutDir: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: options.jsEntry
                    ? path.join(root, 'index.js')
                    : Object.fromEntries(
                          ['index', 'logs', 'beta', 'feedback', 'ocean'].map((name) => [
                              name,
                              path.join(root, name + '.html'),
                          ]),
                      ),
            },
        },
    });
    return {
        output,
        expected: {
            classes: collectClassNames(root),
            ui: collectUiStringPools(root).flat(),
            svg: collectSvgPaths(root),
        },
    };
}
