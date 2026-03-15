/**
 * decodeGrib2Pressure — Decode concatenated GRIB2 messages containing PRMSL data.
 *
 * Reuses the same Section 3/5/7 parsing logic as decodeGrib2Wind.ts but
 * treats each message as one forecast hour of pressure data (in Pascals).
 *
 * Returns an array of decoded grids, one per forecast hour, ready for
 * the isobar contour generator.
 */

// ── Types ─────────────────────────────────────────────────────

export interface PressureFrame {
    /** Pressure values in hPa (mbar), row-major [height × width] */
    pressure: Float32Array;
    width: number;
    height: number;
    north: number;
    south: number;
    east: number;
    west: number;
    /** Grid spacing in degrees */
    dx: number;
    dy: number;
}

export interface DecodedPressureGrid {
    frames: PressureFrame[];
    width: number;
    height: number;
    north: number;
    south: number;
    east: number;
    west: number;
    lats: number[];
    lons: number[];
}

// ── GRIB2 constants ───────────────────────────────────────────

const GRIB_MAGIC = 0x47524942; // "GRIB"

// ── Bit extraction helper ─────────────────────────────────────

function extractBits(data: DataView, byteOffset: number, totalBits: number, bitsPerValue: number): number[] {
    const values: number[] = [];
    const count = Math.floor(totalBits / bitsPerValue);
    let bitPos = 0;

    for (let i = 0; i < count; i++) {
        const startBit = bitPos;
        let value = 0;
        let bitsLeft = bitsPerValue;

        while (bitsLeft > 0) {
            const byteIdx = byteOffset + Math.floor((startBit + (bitsPerValue - bitsLeft)) / 8);
            const bitIdx = (startBit + (bitsPerValue - bitsLeft)) % 8;
            const available = 8 - bitIdx;
            const take = Math.min(bitsLeft, available);

            if (byteIdx >= data.byteLength) break;

            const mask = ((1 << take) - 1) << (available - take);
            const bits = (data.getUint8(byteIdx) & mask) >> (available - take);
            value = (value << take) | bits;
            bitsLeft -= take;
        }

        values.push(value);
        bitPos += bitsPerValue;
    }

    return values;
}

// ── Parse a single GRIB2 message ──────────────────────────────

interface Grib2PressureMessage {
    data: Float32Array;
    width: number;
    height: number;
    lat1: number;
    lat2: number;
    lon1: number;
    lon2: number;
    dx: number;
    dy: number;
}

function parseGrib2Message(buffer: ArrayBuffer, offset: number): { msg: Grib2PressureMessage; nextOffset: number } {
    const view = new DataView(buffer);

    const magic = view.getUint32(offset, false);
    if (magic !== GRIB_MAGIC) {
        throw new Error(`Invalid GRIB2 magic at offset ${offset}`);
    }

    const lenHi = view.getUint32(offset + 8, false);
    const lenLo = view.getUint32(offset + 12, false);
    const totalLength = lenHi > 0 ? lenHi * 0x100000000 + lenLo : lenLo;

    let pos = offset + 16;

    let width = 0,
        height = 0;
    let lat1 = 0,
        lat2 = 0,
        lon1 = 0,
        lon2 = 0;
    let dx = 0,
        dy = 0;
    let refValue = 0,
        binaryScale = 0,
        decimalScale = 0,
        bitsPerValue = 0;
    let packedData: number[] = [];

    const endOfMessage = offset + totalLength;

    while (pos < endOfMessage - 4) {
        if (
            view.getUint8(pos) === 0x37 &&
            view.getUint8(pos + 1) === 0x37 &&
            view.getUint8(pos + 2) === 0x37 &&
            view.getUint8(pos + 3) === 0x37
        ) {
            break;
        }

        const sectionLength = view.getUint32(pos, false);
        const sectionNum = view.getUint8(pos + 4);

        if (sectionLength < 5 || pos + sectionLength > endOfMessage) break;

        switch (sectionNum) {
            case 3: {
                width = view.getUint32(pos + 30, false);
                height = view.getUint32(pos + 34, false);
                lat1 = view.getInt32(pos + 46, false) / 1e6;
                lon1 = view.getInt32(pos + 50, false) / 1e6;

                let la2Raw = view.getInt32(pos + 55, false) / 1e6;
                let lo2Raw = view.getInt32(pos + 59, false) / 1e6;

                if (Math.abs(la2Raw) > 90.001) {
                    la2Raw = view.getInt32(pos + 56, false) / 1e6;
                    lo2Raw = view.getInt32(pos + 60, false) / 1e6;
                }

                const la2Valid = Math.abs(la2Raw) <= 90.001;
                const lo2Valid = lo2Raw > 0 && lo2Raw <= 360.001;

                if (la2Valid && lo2Valid) {
                    lat2 = la2Raw;
                    lon2 = lo2Raw;
                } else {
                    const dLat = width > 1 && height > 1 ? 180.0 / (height - 1) : 1.0;
                    const dLon = width > 1 ? 360.0 / width : 1.0;
                    lat2 = la2Valid ? la2Raw : lat1 - (height - 1) * dLat;
                    lon2 = lo2Valid ? lo2Raw : lon1 + (width - 1) * dLon;
                }

                // Grid spacing
                dx = width > 1 ? Math.abs(lon2 - lon1) / (width - 1) : 1;
                dy = height > 1 ? Math.abs(lat1 - lat2) / (height - 1) : 1;
                break;
            }

            case 5: {
                refValue = view.getFloat32(pos + 11, false);
                binaryScale = view.getInt16(pos + 15, false);
                decimalScale = view.getInt16(pos + 17, false);
                bitsPerValue = view.getUint8(pos + 19);
                break;
            }

            case 7: {
                const dataStart = pos + 5;
                const dataBits = (sectionLength - 5) * 8;
                if (bitsPerValue > 0) {
                    packedData = extractBits(view, dataStart, dataBits, bitsPerValue);
                }
                break;
            }
        }

        pos += sectionLength;
    }

    // Unpack values: Y = R + (X × 2^E) / 10^D
    const E = Math.pow(2, binaryScale);
    const D = Math.pow(10, decimalScale);
    const numValues = width * height;
    const data = new Float32Array(numValues);

    for (let i = 0; i < numValues && i < packedData.length; i++) {
        // PRMSL is in Pascals — convert to hPa (divide by 100)
        data[i] = (refValue + packedData[i] * E) / D / 100;
    }

    return {
        msg: { data, width, height, lat1, lat2, lon1, lon2, dx, dy },
        nextOffset: offset + totalLength,
    };
}

// ── Public decoder ────────────────────────────────────────────

/**
 * Decode a concatenated GRIB2 buffer containing N messages (one PRMSL per forecast hour).
 * Returns a DecodedPressureGrid with all frames and grid metadata.
 */
export function decodeGrib2Pressure(buffer: ArrayBuffer): DecodedPressureGrid {
    const frames: PressureFrame[] = [];
    let offset = 0;

    while (offset < buffer.byteLength - 16) {
        try {
            const { msg, nextOffset } = parseGrib2Message(buffer, offset);

            // Normalize longitude: GFS uses 0-360, we want -180 to 180
            const normLon = (lon: number) => (lon > 180 ? lon - 360 : lon);

            frames.push({
                pressure: msg.data,
                width: msg.width,
                height: msg.height,
                north: Math.max(msg.lat1, msg.lat2),
                south: Math.min(msg.lat1, msg.lat2),
                east: normLon(Math.max(msg.lon1, msg.lon2)),
                west: normLon(Math.min(msg.lon1, msg.lon2)),
                dx: msg.dx,
                dy: msg.dy,
            });

            offset = nextOffset;
        } catch (e) {
            // Try to find next GRIB magic
            offset++;
            while (offset < buffer.byteLength - 4) {
                const view = new DataView(buffer);
                if (view.getUint32(offset, false) === GRIB_MAGIC) break;
                offset++;
            }
        }
    }

    if (frames.length === 0) {
        throw new Error('[GRIB2-Pressure] No valid messages found');
    }

    const f0 = frames[0];

    // Build lat/lon arrays from the first frame
    const lats: number[] = [];
    const lons: number[] = [];

    // GFS data is typically N→S (lat1=90, lat2=-90). We want S→N for contour generation.
    const latStart = f0.south;
    const latEnd = f0.north;
    for (let i = 0; i < f0.height; i++) {
        lats.push(latStart + i * f0.dy);
    }

    for (let i = 0; i < f0.width; i++) {
        lons.push(f0.west + i * f0.dx);
    }

    return {
        frames,
        width: f0.width,
        height: f0.height,
        north: f0.north,
        south: f0.south,
        east: f0.east,
        west: f0.west,
        lats,
        lons,
    };
}
