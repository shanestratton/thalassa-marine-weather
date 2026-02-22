/**
 * decodeWindBinary — Zero-copy decoder for pre-stripped interleaved
 * U/V binary wind data (32-bit float pairs).
 *
 * Input format: [U0, V0, U1, V1, U2, V2, ...] as IEEE 754 float32.
 * The backend strips GRIB headers; this receives raw float pairs.
 *
 * Grid dimensions are encoded in the first 8 bytes as two uint32
 * values (width, height) in little-endian, followed by width×height
 * interleaved float pairs.
 *
 * Wire format:
 *   [width: uint32LE][height: uint32LE][U0 V0 U1 V1 ... U(n-1) V(n-1)]
 *   where n = width × height
 */

export interface DecodedWindField {
    u: Float32Array;
    v: Float32Array;
    width: number;
    height: number;
}

export function decodeWindBinary(buffer: ArrayBuffer): DecodedWindField {
    const view = new DataView(buffer);

    if (buffer.byteLength < 8) {
        throw new Error(
            `[decodeWindBinary] Buffer too small: ${buffer.byteLength} bytes (need ≥8 for header)`,
        );
    }

    // First 8 bytes: grid dimensions as uint32 little-endian
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const gridSize = width * height;

    const expectedBytes = 8 + gridSize * 2 * 4; // header + (U,V) pairs × 4 bytes each
    if (buffer.byteLength < expectedBytes) {
        throw new Error(
            `[decodeWindBinary] Buffer size mismatch: got ${buffer.byteLength}, ` +
            `expected ${expectedBytes} for ${width}×${height} grid`,
        );
    }

    // Direct view into the float data region — no intermediate arrays
    const floatData = new Float32Array(buffer, 8, gridSize * 2);

    // De-interleave into separate U and V arrays
    const u = new Float32Array(gridSize);
    const v = new Float32Array(gridSize);

    for (let i = 0; i < gridSize; i++) {
        u[i] = floatData[i * 2];
        v[i] = floatData[i * 2 + 1];
    }

    return { u, v, width, height };
}

/**
 * Variant for backends that send separate U then V blocks
 * (not interleaved). Header: [width: u32][height: u32][U×n][V×n].
 */
export function decodeWindBinarySeparate(buffer: ArrayBuffer): DecodedWindField {
    const view = new DataView(buffer);

    if (buffer.byteLength < 8) {
        throw new Error(`[decodeWindBinarySeparate] Buffer too small: ${buffer.byteLength} bytes`);
    }

    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const gridSize = width * height;

    const expectedBytes = 8 + gridSize * 2 * 4;
    if (buffer.byteLength < expectedBytes) {
        throw new Error(
            `[decodeWindBinarySeparate] Buffer size mismatch: got ${buffer.byteLength}, ` +
            `expected ${expectedBytes} for ${width}×${height} grid`,
        );
    }

    // Direct Float32Array views — zero copy from the buffer
    const u = new Float32Array(buffer, 8, gridSize);
    const v = new Float32Array(buffer, 8 + gridSize * 4, gridSize);

    return { u, v, width, height };
}
