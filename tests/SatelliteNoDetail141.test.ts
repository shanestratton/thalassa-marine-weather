import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decode } from 'fast-png';
import { satelliteViewportAlphaFraction } from '../services/weather/satelliteViewBytes';

it.each([
    ['first-observation-transparent.png', 334, '3c6c50f94ab35e9f96c772731fe6b7950048179bc81b8ab0396cc1edbde89163'],
    ['first-observation-opaque-uniform.png', 914, 'a6abef1ba59fbf23b409ed7f36433fa12da60252b5dc8661e34f65fa83ab8049'],
] as const)('holds actual first-provider observation %s without Ready/clear-sky inference', (file, size, hash) => {
    const bytes = readFileSync(`tests/fixtures/satellite141/${file}`);
    expect(bytes.length).toBe(size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
    const image = decode(bytes, { checkCrc: true });
    expect([image.width, image.height, image.channels, image.depth]).toEqual([256, 256, 4, 8]);
    expect(() => satelliteViewportAlphaFraction(new Uint8ClampedArray(image.data))).toThrow('coverage unknown');
});
it('admits nonuniform source detail and preserves actual partial-alpha coverage as a warning fact only', () => {
    expect(satelliteViewportAlphaFraction(new Uint8ClampedArray([0, 0, 0, 255, 1, 2, 3, 255]))).toBe(1);
    expect(
        satelliteViewportAlphaFraction(new Uint8ClampedArray([0, 0, 0, 255, 1, 2, 3, 100, 5, 9, 10, 0, 8, 8, 8, 0])),
    ).toBe(0.5);
});
it('does not promote hidden RGB variation or varying alpha to visible source detail', () => {
    expect(() => satelliteViewportAlphaFraction(new Uint8ClampedArray([0, 0, 0, 255, 90, 10, 10, 0]))).toThrow(
        'coverage unknown',
    );
    expect(() => satelliteViewportAlphaFraction(new Uint8ClampedArray([5, 5, 5, 255, 5, 5, 5, 100]))).toThrow(
        'coverage unknown',
    );
});
it('holds malformed and unbounded decoded planes', () => {
    for (const pixels of [
        new Uint8ClampedArray(),
        new Uint8ClampedArray(3),
        new Uint8ClampedArray(1024 * 1024 * 4 + 4),
    ])
        expect(() => satelliteViewportAlphaFraction(pixels)).toThrow('pixel bound');
});
