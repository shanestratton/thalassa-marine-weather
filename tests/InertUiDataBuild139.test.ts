// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { buildInertUiFixture } from './helpers/inertUiFixture139.mjs';
import { shareClassNames } from '../scripts/share-class-names.mjs';
import { shareUiStrings } from '../scripts/share-ui-strings.mjs';
import { shareSvgPaths } from '../scripts/share-svg-paths.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

let parent: string;
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-inert-ui139-'));
});
afterAll(async () => {
    vi.unstubAllEnvs();
    if (path.dirname(parent) === path.resolve(os.tmpdir()) && path.basename(parent).startsWith('thalassa-inert-ui139-'))
        await fs.rm(parent, { recursive: true, force: true });
});

it('injects exact bounded tuples for static and dynamic document graphs, never unrelated entries or executable chunks', async () => {
    const { output, expected } = await buildInertUiFixture(path.join(parent, 'source'), path.join(parent, 'dist'), {
        write: false,
    });
    if (Array.isArray(output) || !('output' in output)) throw Error('Expected one mini build');
    const files = output.output;
    const chunks = files.filter((file) => file.type === 'chunk');
    let indexTuples: unknown[] = [];
    for (const name of ['index', 'logs', 'beta', 'feedback', 'ocean']) {
        const file = files.find((file) => file.type === 'asset' && file.fileName === name + '.html');
        if (!file || file.type !== 'asset') throw Error('Expected HTML');
        const html = String(file.source);
        const blocks = [
            ...html.matchAll(/<script type="application\/json" id="(thalassa-ui-[a-f0-9]{64})">([\s\S]*?)<\/script>/g),
        ];
        if (name === 'index' || name === 'logs') {
            expect(blocks.length).toBeGreaterThanOrEqual(2);
            expect(new Set(blocks.map((b) => b[1])).size).toBe(blocks.length);
            expect(html.indexOf('<meta charset=')).toBeLessThan(html.indexOf(blocks[0][0]));
            expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf(blocks[0][0]));
            expect(html.indexOf('<body>')).toBeLessThan(html.indexOf(blocks[0][0]));
            const tuples = blocks.map((block) => JSON.parse(block[2]));
            for (const tuple of tuples) {
                const [encoded, bytes, count, checksum] = tuple;
                expect(encoded).not.toContain('<');
                expect(chunks.every((chunk) => !chunk.code.includes(encoded))).toBe(true);
                expect(() => decodeClassNames(encoded, bytes, count, checksum)).not.toThrow();
            }
            const restored = tuples.flatMap(([encoded, bytes, count, checksum]) =>
                decodeClassNames(encoded, bytes, count, checksum),
            );
            expect(restored).toEqual(expect.arrayContaining([...expected.classes, ...expected.ui, ...expected.svg]));
            expect(restored).toHaveLength(expected.classes.length + expected.ui.length + expected.svg.length);
            const arrays = tuples.map(([encoded, bytes, count, checksum]) =>
                decodeClassNames(encoded, bytes, count, checksum),
            );
            expect(arrays).toEqual(expect.arrayContaining([expected.classes, expected.ui, expected.svg]));
            if (name === 'index') indexTuples = tuples;
            else expect(tuples).toEqual(indexTuples);
        } else expect(blocks).toHaveLength(0);
    }
    expect(files.some((file) => file.fileName.includes('worker') && file.fileName.endsWith('.js'))).toBe(true);
}, 30000);

it.each(['jsEntry', 'workerDom', 'async'])(
    'refuses unsupported %s without an embedded fallback',
    async (kind) => {
        await expect(
            buildInertUiFixture(path.join(parent, kind), path.join(parent, kind + '-dist'), {
                [kind]: true,
                write: false,
            }),
        ).rejects.toThrow(
            kind === 'jsEntry'
                ? /requires a supported HTML document entry/
                : kind === 'workerDom'
                  ? /worker cannot import the inert UI DOM reader/
                  : /requires deferred document modules/,
        );
    },
    30000,
);

it('requires explicit inert or standalone packing at every plugin call site', () => {
    for (const factory of [shareClassNames, shareUiStrings, shareSvgPaths])
        expect(() => factory(process.cwd())).toThrow(/Choose inert HTML data or explicit standalone/);
});
