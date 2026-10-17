// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classTableSource, collectClassNames, shareClassNames } from '../scripts/share-class-names.mjs';

let root: string;
const className = 'flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm';
const selectedClass = 'bg-amber-500 text-slate-950 border-amber-400';
const idleClass = 'bg-white/5 text-white border-white/10';
const dynamicTemplate =
    '`prefix ${choose()?' + JSON.stringify(selectedClass) + ':' + JSON.stringify(idleClass) + '} suffix`';
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-class-sharing-'));
    await fs.mkdir(path.join(root, 'components'));
    await fs.writeFile(
        path.join(root, 'App.tsx'),
        `<div>${Array(8)
            .fill(
                `<span className=${JSON.stringify(className)}>Label</span><span className={selected ? ${JSON.stringify(selectedClass)} : ${JSON.stringify(idleClass)}}>Choice</span><span className={${dynamicTemplate}}>Template</span>`,
            )
            .join('')}</div>`,
    );
});
afterAll(async () => {
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
});

it('collects exact literal classes and branches without evaluating conditions or admitting test-only strings', async () => {
    await fs.writeFile(
        path.join(root, 'components', 'only.test.tsx'),
        Array(8).fill('<span className="test-only class must not enter the production pool"/>').join('\n'),
    );
    expect(collectClassNames(root)).toEqual([className, selectedClass, idleClass, 'prefix ', ' suffix'].sort());
});

it('reconstructs every real pooled class and unusual whitespace losslessly with an immutable table', async () => {
    const values = [...collectClassNames(process.cwd()), ' a  b\tc ', 'text-["☀️"] \\ escaped', '', ' '.repeat(3)];
    const source = classTableSource(values);
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    expect(module.values).toEqual(values);
    expect(Object.isFrozen(module.values)).toBe(true);
    expect(source.length).toBeLessThan(JSON.stringify(values).length);
});

it('preserves real DOM, class values, property order, side effects and handlers after production minification', async () => {
    const entry = path.join(root, 'entry.js');
    await fs.writeFile(
        entry,
        `
const __thalassaClassNames = 'existing binding';
export function render(h,selected) {
  const effects=[];
  const a={className:${JSON.stringify(className)},id:'first'};
  const b={id:'second',className:${JSON.stringify(className)}};
  const c={...a,className:'dynamic '+effects.push('dynamic')};
  const d={className:(effects.push('before'),${JSON.stringify(className)}),...b};
  const e={get className(){effects.push('getter');return ${JSON.stringify(className)}}};
  const f={['className']:${JSON.stringify(className)}};
  const choose=()=>{effects.push('condition');return selected;};
  const g={className:choose()?${JSON.stringify(selectedClass)}:${JSON.stringify(idleClass)}};
  const h1={className:${dynamicTemplate}};
  const i={className:'prefix '+(selected&&${JSON.stringify(selectedClass)}||${JSON.stringify(idleClass)})};
  const buttons=[a,b,c,d,e,f,g,h1,i].map(props=>h('button',{className:props.className,onClick:()=>effects.push('clicked')},'Open'));
  return {buttons,effects,keys:[Object.keys(a),Object.keys(b)],binding:__thalassaClassNames};
}
`,
    );
    const compile = async (enabled: boolean) => {
        const result = await build({
            root,
            configFile: false,
            logLevel: 'silent',
            plugins: enabled ? [shareClassNames(root, { standalone: true })] : [],
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
        const code = chunks[0].code;
        const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
        const cases = [false, true].map((selected) => {
            const { buttons, ...details } = module.render(React.createElement, selected);
            const initial = buttons.map((button: React.ReactElement) => renderToStaticMarkup(button)).join('');
            buttons[0].props.onClick();
            return { initial, details };
        });
        return { cases, bytes: Buffer.byteLength(code) };
    };
    const baseline = await compile(false),
        shared = await compile(true);
    expect(shared.cases).toEqual(baseline.cases);
    for (const { details } of shared.cases) {
        expect(details.effects).toEqual(['dynamic', 'before', 'condition', 'condition', 'getter', 'clicked']);
        expect(details.binding).toBe('existing binding');
    }
    expect(shared.bytes).toBeLessThan(baseline.bytes);
});
