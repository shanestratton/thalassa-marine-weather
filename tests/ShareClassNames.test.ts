// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectClassNames, shareClassNames } from '../scripts/share-class-names.mjs';

let root: string;
const className = 'flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm';
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-class-sharing-'));
    await fs.mkdir(path.join(root, 'components'));
    await fs.writeFile(
        path.join(root, 'App.tsx'),
        `<div>${Array(8)
            .fill(`<span className=${JSON.stringify(className)}>Label</span>`)
            .join('')}</div>`,
    );
});
afterAll(async () => {
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
});

it('collects repeated literal production classes without test-only strings or dynamic templates', async () => {
    await fs.writeFile(
        path.join(root, 'components', 'only.test.tsx'),
        Array(8).fill('<span className="test-only class must not enter the production pool"/>').join('\n'),
    );
    expect(collectClassNames(root)).toEqual([className]);
});

it('preserves real DOM, class values, property order, side effects and handlers after production minification', async () => {
    const entry = path.join(root, 'entry.js');
    await fs.writeFile(
        entry,
        `
const __thalassaClassNames = 'existing binding';
export function render(h) {
  const effects=[];
  const a={className:${JSON.stringify(className)},id:'first'};
  const b={id:'second',className:${JSON.stringify(className)}};
  const c={...a,className:'dynamic '+effects.push('dynamic')};
  const d={className:(effects.push('before'),${JSON.stringify(className)}),...b};
  const e={get className(){effects.push('getter');return ${JSON.stringify(className)}}};
  const f={['className']:${JSON.stringify(className)}};
  const buttons=[a,b,c,d,e,f].map(props=>h('button',{className:props.className,onClick:()=>effects.push('clicked')},'Open'));
  return {buttons,effects,keys:[Object.keys(a),Object.keys(b)],binding:__thalassaClassNames};
}
`,
    );
    const compile = async (enabled: boolean) => {
        const result = await build({
            root,
            configFile: false,
            logLevel: 'silent',
            plugins: enabled ? [shareClassNames(root)] : [],
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
        const { buttons, ...details } = module.render(React.createElement);
        const initial = buttons.map((button: React.ReactElement) => renderToStaticMarkup(button)).join('');
        buttons[0].props.onClick();
        return { initial, details, bytes: Buffer.byteLength(code) };
    };
    const baseline = await compile(false),
        shared = await compile(true);
    expect(shared.initial).toBe(baseline.initial);
    expect(shared.details).toEqual(baseline.details);
    expect(shared.details.effects).toEqual(['dynamic', 'before', 'getter', 'clicked']);
    expect(shared.details.binding).toBe('existing binding');
    expect(shared.bytes).toBeLessThan(baseline.bytes);
});
