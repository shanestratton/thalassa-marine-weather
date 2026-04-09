/**
 * decodeWindBinary — Unit tests
 *
 * Tests the zero-copy binary wind decoder: interleaved and separate
 * formats, header parsing, size validation, and data accuracy.
 */

import { describe, it, expect } from 'vitest';
import { decodeWindBinary, decodeWindBinarySeparate } from '../services/weather/decodeWindBinary';

// ── Helper: build a binary buffer ───────────────────────────────

function buildInterleavedBuffer(width: number, height: number, uValues: number[], vValues: number[]): ArrayBuffer {
    const gridSize = width * height;
    const buffer = new ArrayBuffer(8 + gridSize * 2 * 4);
    const view = new DataView(buffer);

    // Header: width, height (uint32 LE)
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);

    // Interleaved float pairs: [U0, V0, U1, V1, ...]
    const floats = new Float32Array(buffer, 8, gridSize * 2);
    for (let i = 0; i < gridSize; i++) {
        floats[i * 2] = uValues[i] ?? 0;
        floats[i * 2 + 1] = vValues[i] ?? 0;
    }

    return buffer;
}

function buildSeparateBuffer(width: number, height: number, uValues: number[], vValues: number[]): ArrayBuffer {
    const gridSize = width * height;
    const buffer = new ArrayBuffer(8 + gridSize * 2 * 4);
    const view = new DataView(buffer);

    view.setUint32(0, width, true);
    view.setUint32(4, height, true);

    // Separate blocks: [U0, U1, ..., Un, V0, V1, ..., Vn]
    const uArr = new Float32Array(buffer, 8, gridSize);
    const vArr = new Float32Array(buffer, 8 + gridSize * 4, gridSize);
    for (let i = 0; i < gridSize; i++) {
        uArr[i] = uValues[i] ?? 0;
        vArr[i] = vValues[i] ?? 0;
    }

    return buffer;
}

// ── decodeWindBinary (interleaved) ──────────────────────────────

describe('decodeWindBinary', () => {
    it('decodes a 2×2 grid correctly', () => {
        const u = [1.5, -2.0, 3.0, -0.5];
        const v = [0.5, 1.0, -1.5, 2.0];
        const buffer = buildInterleavedBuffer(2, 2, u, v);

        const result = decodeWindBinary(buffer);

        expect(result.width).toBe(2);
        expect(result.height).toBe(2);
        expect(result.u.length).toBe(4);
        expect(result.v.length).toBe(4);

        for (let i = 0; i < 4; i++) {
            expect(result.u[i]).toBeCloseTo(u[i], 5);
            expect(result.v[i]).toBeCloseTo(v[i], 5);
        }
    });

    it('decodes a 1×1 grid', () => {
        const buffer = buildInterleavedBuffer(1, 1, [5.5], [-3.2]);
        const result = decodeWindBinary(buffer);

        expect(result.width).toBe(1);
        expect(result.height).toBe(1);
        expect(result.u[0]).toBeCloseTo(5.5, 5);
        expect(result.v[0]).toBeCloseTo(-3.2, 5);
    });

    it('throws for buffer too small (< 8 bytes)', () => {
        const buffer = new ArrayBuffer(4);
        expect(() => decodeWindBinary(buffer)).toThrow('Buffer too small');
    });

    it('throws for buffer size mismatch', () => {
        // Header says 10×10 but buffer is tiny
        const buffer = new ArrayBuffer(16);
        const view = new DataView(buffer);
        view.setUint32(0, 10, true);
        view.setUint32(4, 10, true);
        expect(() => decodeWindBinary(buffer)).toThrow('Buffer size mismatch');
    });

    it('handles zero values correctly', () => {
        const buffer = buildInterleavedBuffer(2, 2, [0, 0, 0, 0], [0, 0, 0, 0]);
        const result = decodeWindBinary(buffer);

        for (let i = 0; i < 4; i++) {
            expect(result.u[i]).toBe(0);
            expect(result.v[i]).toBe(0);
        }
    });
});

// ── decodeWindBinarySeparate ─────────────────────────────────────

describe('decodeWindBinarySeparate', () => {
    it('decodes a 2×2 grid correctly', () => {
        const u = [1.5, -2.0, 3.0, -0.5];
        const v = [0.5, 1.0, -1.5, 2.0];
        const buffer = buildSeparateBuffer(2, 2, u, v);

        const result = decodeWindBinarySeparate(buffer);

        expect(result.width).toBe(2);
        expect(result.height).toBe(2);

        for (let i = 0; i < 4; i++) {
            expect(result.u[i]).toBeCloseTo(u[i], 5);
            expect(result.v[i]).toBeCloseTo(v[i], 5);
        }
    });

    it('throws for buffer too small', () => {
        expect(() => decodeWindBinarySeparate(new ArrayBuffer(4))).toThrow('Buffer too small');
    });

    it('throws for buffer size mismatch', () => {
        const buffer = new ArrayBuffer(16);
        const view = new DataView(buffer);
        view.setUint32(0, 5, true);
        view.setUint32(4, 5, true);
        expect(() => decodeWindBinarySeparate(buffer)).toThrow('Buffer size mismatch');
    });
});
