import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseAst } from 'rollup/parseAst';
import tzLookup from 'tz-lookup';
import { describe, expect, it } from 'vitest';
import { packTimezoneSource, TZ_GRID_SHA256, TZ_ZONES_SHA256 } from '../scripts/pack-timezone-data.mjs';
import { decodeTimezoneData } from '../utils/decodeTimezoneData';

const source = fs.readFileSync(path.join(process.cwd(), 'node_modules/tz-lookup/tz.js'), 'utf8');
const packed = packTimezoneSource(source, parseAst);
const decoded = decodeTimezoneData(
    packed.encoded,
    packed.payloadBytes,
    packed.grid.length,
    packed.zones.length,
    packed.checksum,
);
const lookup: typeof tzLookup = new Function(
    'decodeTimezoneData',
    packed.code
        .replace("import {decodeTimezoneData} from 'virtual:thalassa-timezone-data';", '')
        .replace('export default tzlookup;', 'return tzlookup;'),
)(decodeTimezoneData);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('embedded timezone data representation', () => {
    it('reconstructs every original byte and every timezone in original order', () => {
        expect(decoded).toEqual([packed.grid, packed.zones]);
        expect(hash(decoded[0])).toBe(TZ_GRID_SHA256);
        expect(hash(JSON.stringify(decoded[1]))).toBe(TZ_ZONES_SHA256);
        expect(decoded[0]).toHaveLength(65024);
        expect(decoded[1]).toHaveLength(438);
    });
    it('changes only the two private data initializers inside the original function', () => {
        // Rollup supplies offsets at runtime; ESTree's base declaration type
        // omits these parser-specific fields.
        const original = parseAst(source).body.find((node) => node.type === 'FunctionDeclaration')! as unknown as {
            start: number;
            end: number;
        };
        const transformed = parseAst(packed.code).body.find(
            (node) => node.type === 'FunctionDeclaration',
        )! as unknown as { start: number; end: number };
        const restored = packed.code
            .slice(transformed.start, transformed.end)
            .replace('__tzTable[0]', () => JSON.stringify(packed.grid))
            .replace('__tzTable[1]', () => JSON.stringify(packed.zones));
        expect(restored === source.slice(original.start, original.end)).toBe(true);
        expect(() => packTimezoneSource(source + '\n', parseAst)).toThrow('Unreviewed tz-lookup source');
    });
    it('bounds allocation and rejects short, oversized, corrupt or mismatched embedded output', () => {
        const decode = (text: string, bytes = packed.payloadBytes, checksum = packed.checksum) =>
            decodeTimezoneData(text, bytes, packed.grid.length, packed.zones.length, checksum);
        expect(() => decode('A'.repeat(44001))).toThrow('Invalid embedded timezone bounds');
        expect(() => decode(packed.encoded, 80001)).toThrow('Invalid embedded timezone bounds');
        expect(() => decode(packed.encoded, packed.payloadBytes - 1)).toThrow();
        expect(() => decode(packed.encoded, packed.payloadBytes + 1)).toThrow();
        expect(() => decode(packed.encoded, packed.payloadBytes, packed.checksum ^ 1)).toThrow();
        expect(() => decode(packed.encoded.slice(0, 100))).toThrow();
    });
    it('matches worldwide, dateline, poles, quadtree boundaries and input coercion behavior', () => {
        for (let lat = -89; lat < 90; lat += 2)
            for (let lon = -180; lon <= 180; lon += 2) expect(lookup(lat, lon)).toBe(tzLookup(lat, lon));
        for (let lat = -90; lat <= 90; lat += 7.5)
            for (let lon = -180; lon <= 180; lon += 7.5)
                for (const delta of [-1e-9, 0, 1e-9]) {
                    const y = Math.max(-90, Math.min(90, lat + delta)),
                        x = Math.max(-180, Math.min(180, lon + delta));
                    expect(lookup(y, x)).toBe(tzLookup(y, x));
                }
        for (const [lat, lon] of [
            [NaN, 0],
            [91, 0],
            [0, 181],
            [-91, 0],
            [0, Infinity],
        ])
            expect(() => lookup(lat, lon)).toThrow('invalid coordinates');
        for (const [lat, lon] of [
            ['0', '180'],
            [null, false],
            [true, '0'],
        ] as const)
            expect(lookup(lat as unknown as number, lon as unknown as number)).toBe(
                tzLookup(lat as unknown as number, lon as unknown as number),
            );
    });
});
