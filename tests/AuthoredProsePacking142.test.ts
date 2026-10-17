// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
    AUTHORED_PROSE_SOURCES,
    authoredProseLiterals,
    collectAuthoredProse,
    packAuthoredProse,
    packAuthoredProseValues,
    rewriteAuthoredProse,
} from '../scripts/pack-authored-prose.mjs';
import { decodeClassNames } from '../utils/decodeClassNames';

const root = path.resolve('.');
const reference = 'services/reference/skipperReferenceCards.ts';
const trip = 'services/TripOverviewService.ts';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
beforeAll(() => vi.stubEnv('NODE_ENV', 'production'));
afterAll(() => vi.unstubAllEnvs());

it('pins the unchanged reference source and every cooked value to the actual bounded decoder', async () => {
    const { records, values, packed } = collectAuthoredProse(root);
    expect(Object.keys(AUTHORED_PROSE_SOURCES)).toEqual([reference]);
    expect(records.map(({ rows }) => rows.length)).toEqual([77]);
    expect(values).toHaveLength(74);
    expect(packed.bytes).toBe(17237);
    expect(packed.encoded).toHaveLength(8692);
    const restored = decodeClassNames(packed.encoded, packed.bytes, packed.count, packed.checksum);
    expect(restored).toEqual(values);
    expect(Object.isFrozen(restored)).toBe(true);
    for (const record of records) {
        const sourceSpec = Object.entries(AUTHORED_PROSE_SOURCES).find(([file]) => file === record.file)?.[1];
        if (!sourceSpec) throw Error('Unexpected prose source');
        expect(digest(record.code.replaceAll('\r\n', '\n'))).toBe(sourceSpec.sha256);
        const changed = rewriteAuthoredProse(record.code, record.file, values);
        expect(changed).not.toBeNull();
        if (!changed) throw Error('Missing exact prose transform');
        let reversed = changed.code;
        for (const row of [...record.rows].reverse()) {
            // Compare the original source after replacing only the generated
            // references by their original literal tokens, in reverse order.
            const token = `${changed.binding}[${values.indexOf(row.value)}]`;
            const at = reversed.lastIndexOf(token);
            expect(at).toBeGreaterThanOrEqual(0);
            reversed =
                reversed.slice(0, at) + record.code.slice(row.start, row.end) + reversed.slice(at + token.length);
        }
        reversed = reversed.slice(reversed.indexOf('\n') + 1);
        expect(reversed).toBe(record.code);
    }
    const ordinaryPool = await fs.readFile(path.join(root, 'scripts/share-ui-strings.mjs'), 'utf8');
    expect(ordinaryPool).toContain('export const UI_STRING_POOL_LIMIT = 4;');
});

it('preserves escaped cooked templates while leaving dynamic/tagged templates, modules, keys and directives exact', () => {
    const text = 'Original display text with exact spaces  and escaped Unicode ⚓.\nNext line.';
    const literal = JSON.stringify(text);
    const code = `${literal};import value from ${literal};export {value} from ${literal};
        type Label=${literal};const object={${literal}:${literal}};
        const tagged=String.raw\`Original display text with exact spaces  and escaped Unicode \\u2693.\\nNext line.\`;
        const dynamic=\`Original display text with exact spaces  and escaped Unicode \\u2693.\\nNext line.\${value}\`;
        const path=new URL(${literal},import.meta.url);const load=()=>import(${literal});
        export const quoted=${literal};
        export const cooked=\`Original display text with exact spaces  and escaped Unicode \\u2693.\\nNext line.\`;`;
    const rows = authoredProseLiterals(code, reference);
    expect(rows.map(({ value }) => value)).toEqual([text, text, text]);
    const changed = rewriteAuthoredProse(code, reference, [text]);
    expect(changed?.code).toContain(`String.raw\`Original display text`);
    expect(changed?.code).toContain(`const dynamic=\`Original display text`);
    expect(changed?.code).toContain(`new URL(${literal},import.meta.url)`);
    expect(changed?.code).toContain(`import(${literal})`);
    expect(changed?.code).toContain(`type Label=${literal}`);
    expect(changed?.code).toContain(`{${literal}:__thalassaAuthoredProse[0]}`);
    expect(changed?.code).toContain(`export const cooked=__thalassaAuthoredProse[0]`);
    expect(authoredProseLiterals(code, 'services/Other.ts')).toEqual([]);
    expect(authoredProseLiterals(code, trip)).toEqual([]);
    expect(rewriteAuthoredProse(code, 'services/Other.ts', [text])).toBeNull();
    expect(() => rewriteAuthoredProse(code, reference, [])).toThrow(/absent/);
});

it('refuses source drift and the original per-table expansion bounds', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-prose142-'));
    try {
        for (const file of Object.keys(AUTHORED_PROSE_SOURCES)) {
            const target = path.join(temporary, file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, await fs.readFile(path.join(root, file)));
        }
        await fs.appendFile(path.join(temporary, reference), '\n// content requires a new review\n');
        expect(() => collectAuthoredProse(temporary)).toThrow(/Unreviewed authored prose source/);
    } finally {
        expect(path.dirname(temporary)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(temporary)).toMatch(/^thalassa-prose142-/);
        await fs.rm(temporary, { recursive: true, force: true });
    }
    expect(() => packAuthoredProseValues(['x'.repeat(4097)])).toThrow(/bounds/);
    expect(() => packAuthoredProseValues(Array.from({ length: 4097 }, () => 'x'))).toThrow(/bounds/);
    expect(() => packAuthoredProseValues(Array.from({ length: 70 }, () => 'x'.repeat(4000)))).toThrow(/bounds/);
});

it('preserves every hemisphere card, shared card identity and all ten country-snippet values after real production minification', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-prose142-build-'));
    try {
        const entry = path.join(temporary, 'entry.mjs');
        await fs.writeFile(
            entry,
            `export {skipperReferenceCards,SKIPPER_REFERENCE_CARDS} from ${JSON.stringify(path.join(root, reference).replaceAll('\\', '/'))};
             export {getCountrySnippets,detectCountry} from ${JSON.stringify(path.join(root, trip).replaceAll('\\', '/'))};`,
        );
        const compile = async (enabled: boolean) => {
            const result = await build({
                root,
                configFile: false,
                logLevel: 'silent',
                plugins: enabled ? [packAuthoredProse(root)] : [],
                build: {
                    write: false,
                    copyPublicDir: false,
                    minify: 'terser',
                    terserOptions: { compress: { passes: 2 } },
                    rollupOptions: {
                        input: entry,
                        preserveEntrySignatures: 'strict',
                        output: { format: 'es', inlineDynamicImports: true },
                    },
                },
            });
            if (Array.isArray(result) || !('output' in result)) throw Error('Expected one production bundle');
            const chunks = result.output.filter((item) => item.type === 'chunk');
            expect(chunks).toHaveLength(1);
            const code = chunks[0].code;
            expect(code).not.toMatch(/document\.|readPackedUiData|fetch\(/);
            expect(code.includes(collectAuthoredProse(root).packed.encoded)).toBe(enabled);
            const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
            const south = module.skipperReferenceCards('south');
            const north = module.skipperReferenceCards('north');
            const countries = [
                'Australia',
                'New Zealand',
                'New Caledonia',
                'Vanuatu',
                'Fiji',
                'Tonga',
                'Cook Islands',
                'French Polynesia',
                'Niue',
                'Samoa',
                'Unknown',
                'Australia',
            ];
            return {
                bytes: Buffer.byteLength(code),
                values: {
                    south,
                    north,
                    legacy: module.SKIPPER_REFERENCE_CARDS,
                    snippets: module.getCountrySnippets(countries),
                    countries: ['Port Vila', 'Opua', 'Papeete', 'Unknown, Elsewhere'].map(module.detectCountry),
                    sharedFirst: south[0] === north[0],
                    sharedForecast: south[2] === north[2],
                    legacyFirst: south[0] === module.SKIPPER_REFERENCE_CARDS[0],
                    keys: Object.keys(module),
                },
            };
        };
        const original = await compile(false),
            packed = await compile(true);
        expect(packed.values).toEqual(original.values);
        expect(JSON.stringify(packed.values)).toBe(JSON.stringify(original.values));
        expect(packed.values.snippets).toHaveLength(11);
        expect(packed.values.south).toHaveLength(4);
        expect(packed.values.north).toHaveLength(4);
        expect(packed.values.sharedFirst && packed.values.sharedForecast && packed.values.legacyFirst).toBe(true);
        // Includes the actual unchanged decoder/inflater; the real full app
        // already shares those imports. Final whole-artifact size is separate.
        expect(packed.bytes).toBeLessThan(original.bytes);
    } finally {
        expect(path.dirname(temporary)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(temporary)).toMatch(/^thalassa-prose142-build-/);
        await fs.rm(temporary, { recursive: true, force: true });
    }
}, 30000);

it('keeps the original prose in a real independent worker without importing the table or a document reader', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'thalassa-prose142-worker-'));
    try {
        const entry = path.join(temporary, 'entry.mjs');
        await fs.writeFile(
            entry,
            `export const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});`,
        );
        await fs.writeFile(
            path.join(temporary, 'worker.ts'),
            `import {skipperReferenceCards} from ${JSON.stringify(path.join(root, reference).replaceAll('\\', '/'))};
             self.postMessage(skipperReferenceCards('north'));`,
        );
        const result = await build({
            root,
            configFile: false,
            logLevel: 'silent',
            plugins: [packAuthoredProse(root)],
            worker: { format: 'es', plugins: () => [packAuthoredProse(root)] },
            build: {
                write: false,
                copyPublicDir: false,
                minify: 'terser',
                rollupOptions: { input: entry, preserveEntrySignatures: 'strict' },
            },
        });
        if (Array.isArray(result) || !('output' in result)) throw Error('Expected one worker build');
        const workers = result.output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.js'));
        expect(workers).toHaveLength(1);
        const code = workers[0].type === 'asset' ? String(workers[0].source) : '';
        expect(code).toContain('North of the equator');
        expect(code).not.toContain(collectAuthoredProse(root).packed.encoded);
        expect(code).not.toMatch(/document\.|decodeClassNames|readPackedUiData|virtual:thalassa-authored-prose/);
    } finally {
        expect(path.dirname(temporary)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(temporary)).toMatch(/^thalassa-prose142-worker-/);
        await fs.rm(temporary, { recursive: true, force: true });
    }
});
