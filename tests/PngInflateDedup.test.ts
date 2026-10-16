// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { build } from 'vite';
import type { RollupOutput } from 'rollup';
import { decode, decodeApng, encode, type ImageData } from 'fast-png';
import type { jsPDF } from 'jspdf';
import { Inflate, inflate } from '../utils/pngInflate';
import { pngInflateDedup } from '../scripts/png-inflate-dedup.mjs';

const root = process.cwd();
interface BuiltApi {
    decode: typeof decode;
    decodeApng: typeof decodeApng;
    jsPDF: typeof jsPDF;
}
let bundled: BuiltApi;
let modules: string[] = [];
let bytes = 0;
beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const result = await build({
        configFile: false,
        logLevel: 'silent',
        root,
        plugins: [
            pngInflateDedup(root),
            {
                name: 'png-proof-entry',
                resolveId(id) {
                    return id === 'png-proof-entry' ? '\0png-proof-entry' : null;
                },
                load(id) {
                    return id === '\0png-proof-entry'
                        ? "export {decode,decodeApng} from 'fast-png';export {jsPDF} from 'jspdf';"
                        : null;
                },
            },
        ],
        resolve: {
            alias: [
                { find: /^canvg$/, replacement: path.join(root, 'utils/vendorStubs/canvgUnavailable.ts') },
                { find: /^html2canvas$/, replacement: path.join(root, 'utils/vendorStubs/html2canvasUnavailable.ts') },
                { find: /^dompurify$/, replacement: path.join(root, 'utils/vendorStubs/dompurifyUnavailable.ts') },
            ],
        },
        build: {
            write: false,
            emptyOutDir: false,
            copyPublicDir: false,
            minify: 'terser',
            terserOptions: { compress: { passes: 2 } },
            rollupOptions: {
                input: 'png-proof-entry',
                preserveEntrySignatures: 'strict',
                output: { inlineDynamicImports: true },
            },
        },
    });
    const output = (result as RollupOutput).output.find((o) => o.type === 'chunk');
    if (!output || output.type !== 'chunk') throw Error('Missing PNG production proof');
    modules = Object.keys(output.modules);
    bytes = Buffer.byteLength(output.code);
    bundled = await import(
        /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(output.code).toString('base64')
    );
}, 30000);
afterAll(() => vi.unstubAllEnvs());

function pngChunk(type: string, data: Uint8Array): Buffer {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write(type, 4, 'ascii');
    chunk.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, -4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    return chunk;
}
function pngChunks(png: Uint8Array): { type: string; data: Buffer }[] {
    const buffer = Buffer.from(png);
    const result: { type: string; data: Buffer }[] = [];
    for (let offset = 8; offset < buffer.length; ) {
        const length = buffer.readUInt32BE(offset);
        result.push({
            type: buffer.toString('ascii', offset + 4, offset + 8),
            data: buffer.subarray(offset + 8, offset + 8 + length),
        });
        offset += length + 12;
    }
    return result;
}
describe('shared PNG inflate codec', () => {
    it('checks zlib integrity, joins one-byte IDAT fragments and preserves input bytes', () => {
        const expected = Uint8Array.from({ length: 20000 }, (_, i) => i % 251);
        const zipped = deflateSync(expected);
        const stream = new Inflate();
        for (const byte of zipped) {
            const input = Uint8Array.of(byte);
            expect(stream.push(input)).toBe(true);
            input[0] ^= 255;
        }
        expect(stream.result).toEqual(expected);
        expect(stream.err).toBe(0);
        const corrupt = Uint8Array.from(zipped);
        corrupt[corrupt.length - 1] ^= 1;
        expect(() => inflate(corrupt)).toThrow(/checksum/);
        expect(() => inflate(zipped.subarray(0, -1))).toThrow();
        expect(() => inflate(Uint8Array.of(0, 0, 0, 0, 0, 0))).toThrow(/header/);
    });
    it('does not retain the duplicate Pako codec or unused encoder in a real production PNG/PDF build', () => {
        expect(modules.some((m) => m.replaceAll('\\', '/').includes('/pako/'))).toBe(false);
        expect(modules.some((m) => m.replaceAll('\\', '/').endsWith('/utils/pngInflate.ts'))).toBe(true);
        expect(bytes).toBeGreaterThan(100000);
    });
    const formats: [string, ImageData][] = [
        [
            'RGB',
            {
                width: 2,
                height: 2,
                channels: 3,
                depth: 8,
                data: Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255),
            },
        ],
        [
            'RGBA',
            {
                width: 2,
                height: 2,
                channels: 4,
                depth: 8,
                data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255),
            },
        ],
        ['grey8', { width: 2, height: 2, channels: 1, depth: 8, data: Uint8Array.of(0, 90, 170, 255) }],
        [
            'grey-alpha',
            { width: 2, height: 2, channels: 2, depth: 8, data: Uint8Array.of(0, 255, 90, 128, 170, 0, 255, 255) },
        ],
        ['grey16', { width: 2, height: 2, channels: 1, depth: 16, data: Uint16Array.of(0, 12345, 40000, 65535) }],
        [
            'RGBA16',
            {
                width: 2,
                height: 2,
                channels: 4,
                depth: 16,
                data: Uint16Array.of(
                    65535,
                    0,
                    0,
                    65535,
                    0,
                    65535,
                    0,
                    32000,
                    0,
                    0,
                    65535,
                    0,
                    65535,
                    65535,
                    65535,
                    65535,
                ),
            },
        ],
        [
            'indexed alpha',
            {
                width: 2,
                height: 2,
                channels: 1,
                depth: 8,
                data: Uint8Array.of(0, 1, 2, 0),
                palette: [
                    [255, 0, 0, 255],
                    [0, 255, 0, 128],
                    [0, 0, 255, 0],
                ],
            },
        ],
    ];
    it.each(formats)('preserves every decoded pixel and metadata for %s, including Adam7', (_name, input) => {
        for (const interlace of ['null', 'Adam7'] as const) {
            const png = encode(input, { interlace });
            const expected = decode(png, { checkCrc: true });
            const actual = bundled.decode(png, { checkCrc: true });
            expect(actual).toEqual(expected);
        }
    });
    it('preserves ICC profiles and real multi-chunk IDAT streams', () => {
        const original = encode(formats[1][1]);
        const chunks = pngChunks(original);
        const compressed = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
        const profile = Uint8Array.from({ length: 512 }, (_, i) => i % 251);
        const bytes = Buffer.concat([
            Buffer.from(original.subarray(0, 8)),
            pngChunk('IHDR', chunks[0].data),
            pngChunk('iCCP', Buffer.concat([Buffer.from('test-profile\0\0'), deflateSync(profile)])),
            ...Array.from(compressed, (byte) => pngChunk('IDAT', Uint8Array.of(byte))),
            pngChunk('IEND', new Uint8Array()),
        ]);
        const actual = bundled.decode(bytes, { checkCrc: true });
        expect(actual).toEqual(decode(bytes, { checkCrc: true }));
        expect(actual.iccEmbeddedProfile?.profile).toEqual(profile);
    });
    it('preserves separately compressed APNG frames and split fdAT streams', () => {
        const frames = [
            formats[1][1],
            { ...formats[1][1], data: Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255) },
        ];
        const encoded = frames.map((frame) => encode(frame));
        const chunks = encoded.map(pngChunks);
        const control = Buffer.alloc(8);
        control.writeUInt32BE(2);
        const content: Buffer[] = [
            Buffer.from(encoded[0].subarray(0, 8)),
            pngChunk('IHDR', chunks[0][0].data),
            pngChunk('acTL', control),
        ];
        let sequence = 0;
        for (let index = 0; index < frames.length; index++) {
            const frame = Buffer.alloc(26);
            frame.writeUInt32BE(sequence++);
            frame.writeUInt32BE(2, 4);
            frame.writeUInt32BE(2, 8);
            frame.writeUInt16BE(1, 20);
            frame.writeUInt16BE(10, 22);
            content.push(pngChunk('fcTL', frame));
            const compressed = Buffer.concat(chunks[index].filter((c) => c.type === 'IDAT').map((c) => c.data));
            for (const byte of compressed) {
                if (index === 0) content.push(pngChunk('IDAT', Uint8Array.of(byte)));
                else {
                    const data = Buffer.alloc(5);
                    data.writeUInt32BE(sequence++);
                    data[4] = byte;
                    content.push(pngChunk('fdAT', data));
                }
            }
        }
        content.push(pngChunk('IEND', new Uint8Array()));
        const bytes = Buffer.concat(content);
        const actual = bundled.decodeApng(bytes, { checkCrc: true });
        expect(actual).toEqual(decodeApng(bytes, { checkCrc: true }));
        expect(actual.frames.map((frame) => frame.data)).toEqual(frames.map((frame) => frame.data));
    });
    it('embeds truecolour, palette and alpha PNGs in the real jsPDF constructor', () => {
        const doc = new bundled.jsPDF({ compress: true });
        for (let i = 0; i < formats.length; i++)
            doc.addImage(encode(formats[i][1]), 'PNG', 10, 10 + i * 20, 16, 16, `png-${i}`);
        const pdf = Buffer.from(doc.output('arraybuffer')).toString('latin1');
        expect(pdf.startsWith('%PDF-')).toBe(true);
        expect(pdf.match(/\/Subtype \/Image/g)?.length).toBeGreaterThanOrEqual(7);
        expect(pdf).toContain('/SMask');
    });
    it('guards the third-party decode seam and side-effect-free encoder module against dependency drift', () => {
        const decoder = readFileSync('node_modules/fast-png/lib-esm/PngDecoder.js', 'utf8');
        expect(decoder).toContain("import { inflate, Inflate as Inflator } from 'pako'");
        expect(decoder).toContain('this._inflator.result');
        expect(decoder).not.toMatch(/_inflator\.(?:onData|onEnd|setDictionary)|new Inflator\([^)]*\w/);
        const encoder = readFileSync('node_modules/fast-png/lib-esm/PngEncoder.js', 'utf8');
        expect(encoder).not.toMatch(/\bstatic\s*(?:\{|\w+\s*=)|globalThis|window\./);
    });
});
