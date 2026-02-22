/**
 * decodeGrib2Wind — Pure JS GRIB2 decoder for GFS 10m U/V wind components.
 *
 * Parses a GRIB2 binary buffer containing exactly two messages (UGRD, VGRD)
 * with simple packing (Data Representation Template 5.0).
 *
 * Extracts grid dimensions from Section 3 and unpacked float values from
 * Sections 5 + 7 using the formula:
 *   Y = R + (packed_value × 2^E) / 10^D
 *
 * Returns { u, v, width, height } ready for WindParticleLayer.setWindData().
 */

export interface DecodedGrib2Wind {
    u: Float32Array;
    v: Float32Array;
    width: number;
    height: number;
    north: number;
    south: number;
    east: number;
    west: number;
}

// ── GRIB2 constants ───────────────────────────────────────────

const GRIB_MAGIC = 0x47524942; // "GRIB" in big-endian

// ── Bit extraction helper ─────────────────────────────────────

function extractBits(
    data: DataView,
    byteOffset: number,
    totalBits: number,
    bitsPerValue: number,
): number[] {
    const count = Math.floor(totalBits / bitsPerValue);
    const values: number[] = new Array(count);
    const mask = (1 << bitsPerValue) - 1;

    let bitPos = 0;
    for (let i = 0; i < count; i++) {
        const byteIdx = byteOffset + Math.floor(bitPos / 8);
        const bitOffset = bitPos % 8;
        const bitsInFirstByte = 8 - bitOffset;

        let value = 0;
        let bitsRemaining = bitsPerValue;

        // Read first partial byte
        value = data.getUint8(byteIdx) & ((1 << bitsInFirstByte) - 1);
        bitsRemaining -= bitsInFirstByte;

        if (bitsRemaining <= 0) {
            // All bits in first byte
            value >>= -bitsRemaining;
        } else {
            // Read full bytes
            let nextByte = byteIdx + 1;
            while (bitsRemaining >= 8) {
                value = (value << 8) | data.getUint8(nextByte++);
                bitsRemaining -= 8;
            }
            // Read final partial byte
            if (bitsRemaining > 0) {
                value = (value << bitsRemaining) |
                    (data.getUint8(nextByte) >> (8 - bitsRemaining));
            }
        }

        values[i] = value & mask;
        bitPos += bitsPerValue;
    }

    return values;
}

// ── Parse a single GRIB2 message ──────────────────────────────

interface Grib2Message {
    data: Float32Array;
    width: number;
    height: number;
    lat1: number;
    lat2: number;
    lon1: number;
    lon2: number;
}

function parseGrib2Message(buffer: ArrayBuffer, offset: number): { msg: Grib2Message; nextOffset: number } {
    const view = new DataView(buffer);

    // Section 0: Indicator — 16 bytes
    const magic = view.getUint32(offset, false);
    if (magic !== GRIB_MAGIC) {
        throw new Error(`Invalid GRIB2 magic at offset ${offset}: 0x${magic.toString(16)}`);
    }

    // Total message length (8 bytes at offset+8, but JS can't handle 64-bit)
    // Read as two 32-bit values
    const lenHi = view.getUint32(offset + 8, false);
    const lenLo = view.getUint32(offset + 12, false);
    const totalLength = lenHi > 0 ? lenHi * 0x100000000 + lenLo : lenLo;

    let pos = offset + 16; // Past Section 0

    let width = 0;
    let height = 0;
    let lat1 = 0, lat2 = 0, lon1 = 0, lon2 = 0;
    let refValue = 0;
    let binaryScale = 0;
    let decimalScale = 0;
    let bitsPerValue = 0;
    let numDataPoints = 0;
    let packedData: number[] = [];

    const endOfMessage = offset + totalLength;

    while (pos < endOfMessage - 4) {
        // Check for "7777" end marker
        if (
            view.getUint8(pos) === 0x37 && view.getUint8(pos + 1) === 0x37 &&
            view.getUint8(pos + 2) === 0x37 && view.getUint8(pos + 3) === 0x37
        ) {
            break;
        }

        const sectionLength = view.getUint32(pos, false);
        const sectionNum = view.getUint8(pos + 4);

        if (sectionLength < 5 || pos + sectionLength > endOfMessage) {
            break;
        }

        switch (sectionNum) {
            case 1: // Identification Section — skip
                break;

            case 3: {
                // Grid Definition Section
                // Template 3.0: Latitude/Longitude grid
                numDataPoints = view.getUint32(pos + 6, false);
                // Octets 31-34: Ni (number of points along a parallel = width)
                width = view.getUint32(pos + 30, false);
                // Octets 35-38: Nj (number of points along a meridian = height)
                height = view.getUint32(pos + 34, false);
                // Octets 47-50: La1 (latitude of first grid point) in microdegrees
                lat1 = view.getInt32(pos + 46, false) / 1e6;
                // Octets 51-54: Lo1 (longitude of first grid point) in microdegrees
                lon1 = view.getInt32(pos + 50, false) / 1e6;
                // Octets 56-59: La2 (latitude of last grid point)
                lat2 = view.getInt32(pos + 55, false) / 1e6;
                // Octets 60-63: Lo2 (longitude of last grid point)
                lon2 = view.getInt32(pos + 59, false) / 1e6;
                break;
            }

            case 5: {
                // Data Representation Section
                // Template 5.0: Simple packing
                // Octets 12-15: Reference value (R) — IEEE 754 float32
                refValue = view.getFloat32(pos + 11, false);
                // Octets 16-17: Binary scale factor (E) — signed int16
                binaryScale = view.getInt16(pos + 15, false);
                // Octets 18-19: Decimal scale factor (D) — signed int16
                decimalScale = view.getInt16(pos + 17, false);
                // Octet 20: Number of bits per packed value
                bitsPerValue = view.getUint8(pos + 19);
                break;
            }

            case 7: {
                // Data Section — packed values start at octet 6
                const dataStart = pos + 5;
                const dataBits = (sectionLength - 5) * 8;
                if (bitsPerValue > 0) {
                    packedData = extractBits(view, dataStart, dataBits, bitsPerValue);
                }
                break;
            }

            default:
                break;
        }

        pos += sectionLength;
    }

    // Unpack: Y = R + (packed × 2^E) / 10^D
    const factor2 = Math.pow(2, binaryScale);
    const factor10 = Math.pow(10, decimalScale);
    const count = Math.min(packedData.length, width * height);
    const data = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        data[i] = (refValue + packedData[i] * factor2) / factor10;
    }

    return {
        msg: { data, width, height, lat1, lat2, lon1, lon2 },
        nextOffset: offset + totalLength,
    };
}

// ── Public decoder ────────────────────────────────────────────

/**
 * Decode a GRIB2 buffer containing two messages (UGRD then VGRD).
 * Returns typed arrays and grid metadata for WindParticleLayer.
 */
export function decodeGrib2Wind(buffer: ArrayBuffer): DecodedGrib2Wind {
    if (buffer.byteLength < 32) {
        throw new Error(`GRIB2 buffer too small: ${buffer.byteLength} bytes`);
    }

    // Parse first message (UGRD)
    const { msg: msgU, nextOffset } = parseGrib2Message(buffer, 0);

    // Parse second message (VGRD)
    const { msg: msgV } = parseGrib2Message(buffer, nextOffset);

    if (msgU.width !== msgV.width || msgU.height !== msgV.height) {
        throw new Error(
            `Grid dimension mismatch: U=${msgU.width}×${msgU.height} V=${msgV.width}×${msgV.height}`,
        );
    }

    // Convert NOAA 0-360 longitudes back to -180..180
    // For full-globe grids (0..360), force to -180..180 since normLon(360) = 0
    const lonMin = Math.min(msgU.lon1, msgU.lon2);
    const lonMax = Math.max(msgU.lon1, msgU.lon2);
    const lonSpan = lonMax - lonMin;
    const isFullGlobe = lonSpan >= 359;

    const normLon = (lon: number) => lon > 180 ? lon - 360 : lon;

    let uData = msgU.data;
    let vData = msgV.data;

    // GRIB2 typically stores rows north-to-south (lat1=90, lat2=-90).
    // The particle engine and heatmap expect south-to-north (row 0 = south).
    // Flip all rows if the data is north-first.
    if (msgU.lat1 > msgU.lat2) {
        const w = msgU.width;
        const h = msgU.height;
        uData = new Float32Array(w * h);
        vData = new Float32Array(w * h);
        for (let row = 0; row < h; row++) {
            const srcOffset = row * w;
            const dstOffset = (h - 1 - row) * w;
            uData.set(msgU.data.subarray(srcOffset, srcOffset + w), dstOffset);
            vData.set(msgV.data.subarray(srcOffset, srcOffset + w), dstOffset);
        }
        console.log(`[decodeGrib2Wind] Flipped ${h} rows from north-first to south-first`);
    }

    return {
        u: uData,
        v: vData,
        width: msgU.width,
        height: msgU.height,
        north: Math.max(msgU.lat1, msgU.lat2),
        south: Math.min(msgU.lat1, msgU.lat2),
        east: isFullGlobe ? 180 : normLon(lonMax),
        west: isFullGlobe ? -180 : normLon(lonMin),
    };
}
