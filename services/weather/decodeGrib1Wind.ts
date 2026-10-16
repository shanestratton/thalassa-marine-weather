/** Strict GRIB edition 1 wind-import foundation. Pure: no storage, network, DOM or provider fallback. */
import {
    GribFieldCollection,
    GribImportError,
    GRIB_IMPORT_LIMITS as GRIB1_LIMITS,
    type GribImportCode,
    type ImportedGribFile,
} from './gribImportTypes';
export { GribImportError, GRIB_IMPORT_LIMITS as GRIB1_LIMITS } from './gribImportTypes';
export type { GribImportCode } from './gribImportTypes';
const fail = (code: GribImportCode, message: string): never => {
    throw new GribImportError(code, message);
};
const check = (condition: unknown, code: GribImportCode, message: string): void => {
    if (!condition) fail(code, message);
};
const u24 = (view: DataView, at: number) => view.getUint8(at) * 65536 + view.getUint16(at + 1);
const signMagnitude16 = (value: number) => (value & 0x8000 ? -1 : 1) * (value & 0x7fff);
const signMagnitude24 = (value: number) => (value & 0x800000 ? -1 : 1) * (value & 0x7fffff);
const normLon = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;

export function gribEdition(buffer: ArrayBuffer): 1 | 2 {
    check(buffer.byteLength >= 8, 'NOT_GRIB', 'The file does not contain a GRIB header.');
    const view = new DataView(buffer);
    check(view.getUint32(0) === 0x47524942, 'NOT_GRIB', 'The file does not start with GRIB.');
    const edition = view.getUint8(7);
    if (edition === 1 || edition === 2) return edition;
    return fail('UNSUPPORTED_EDITION', 'This GRIB edition is unsupported.');
}

/** Structurally compatible with the app WindGrid; axes and rows always increase east/north. */
export interface Grib1WindGrid {
    edition: 1;
    u: Float32Array[];
    v: Float32Array[];
    speed: Float32Array[];
    width: number;
    height: number;
    north: number;
    south: number;
    east: number;
    west: number;
    lats: number[];
    lons: number[];
    totalHours: number;
    stepHours: number[];
    refTime: string;
    validUntil: string;
    source: { centre: number; subcentre: number; process: number; parameterTable: number };
    ignoredMessages: number;
}
interface Grid {
    width: number;
    height: number;
    north: number;
    south: number;
    west: number;
    east: number;
    dx: number;
    dy: number;
    negativeI: boolean;
    positiveJ: boolean;
    adjacentJ: boolean;
}
interface Section {
    at: number;
    length: number;
}

/** Source: NCEP ON388 section 4. GRIB1 uses IBM hexadecimal floating point, not IEEE float32. */
function ibmFloat(view: DataView, at: number): number {
    const head = view.getUint8(at),
        fraction = u24(view, at + 1);
    return (head & 0x80 ? -1 : 1) * (fraction / 0x1000000) * 16 ** ((head & 0x7f) - 64);
}
function section(view: DataView, at: number, end: number, minimum: number): Section {
    check(at + 3 <= end, 'MALFORMED', 'A GRIB section header is truncated.');
    const length = u24(view, at);
    check(length >= minimum && at + length <= end, 'MALFORMED', 'A GRIB section length is invalid.');
    return { at, length };
}
function gridDefinition(view: DataView, section: Section): Grid {
    const { at, length } = section;
    check(
        length === 32 && view.getUint8(at + 3) === 0 && view.getUint8(at + 4) === 255,
        'UNSUPPORTED_GRID',
        'Only full regular latitude/longitude grids are supported.',
    );
    check(view.getUint8(at + 5) === 0, 'UNSUPPORTED_GRID', 'This grid projection is unsupported.');
    const width = view.getUint16(at + 6),
        height = view.getUint16(at + 8);
    check(
        width >= 2 && height >= 2 && width !== 65535 && height !== 65535,
        'UNSUPPORTED_GRID',
        'Reduced, singleton and predefined grids are unsupported.',
    );
    check(width * height <= GRIB1_LIMITS.gridPoints, 'LIMIT', 'The GRIB grid exceeds the point limit.');
    const lat1 = signMagnitude24(u24(view, at + 10)) / 1000;
    const lon1 = signMagnitude24(u24(view, at + 13)) / 1000;
    const lat2 = signMagnitude24(u24(view, at + 17)) / 1000;
    const lon2 = signMagnitude24(u24(view, at + 20)) / 1000;
    const flags = view.getUint8(at + 16),
        scan = view.getUint8(at + 27);
    check(
        (flags & 0x80) !== 0 && (flags & 0x3f) === 0,
        'UNSUPPORTED_GRID',
        'Explicit increments and earth-relative U/V components are required.',
    );
    check(
        (scan & 0x1f) === 0 && [28, 29, 30, 31].every((i) => view.getUint8(at + i) === 0),
        'UNSUPPORTED_GRID',
        'Alternating or reserved grid scanning modes are unsupported.',
    );
    const di = view.getUint16(at + 23),
        dj = view.getUint16(at + 25);
    check(
        di > 0 && di !== 65535 && dj > 0 && dj !== 65535,
        'UNSUPPORTED_GRID',
        'The grid increments are missing or invalid.',
    );
    const dx = di / 1000,
        dy = dj / 1000;
    const negativeI = !!(scan & 0x80),
        positiveJ = !!(scan & 0x40),
        adjacentJ = !!(scan & 0x20);
    const span = (width - 1) * dx,
        otherLat = lat1 + (positiveJ ? 1 : -1) * dy * (height - 1);
    const otherLon = lon1 + (negativeI ? -1 : 1) * span;
    check(
        Math.abs(lat1) <= 90 &&
            Math.abs(lat2) <= 90 &&
            Math.abs(lon1) <= 360 &&
            Math.abs(lon2) <= 360 &&
            span <= 360 &&
            Math.abs(otherLat - lat2) < 0.0011 &&
            Math.abs(normLon(otherLon - lon2)) < 0.0011,
        'UNSUPPORTED_GRID',
        'Grid endpoints do not agree with the increments and scanning mode.',
    );
    const milli = (value: number) => Math.round(value * 1000) / 1000;
    const west = milli(normLon(negativeI ? otherLon : lon1));
    return {
        width,
        height,
        north: Math.max(lat1, lat2),
        south: Math.min(lat1, lat2),
        west,
        east: milli(west + span),
        dx,
        dy,
        negativeI,
        positiveJ,
        adjacentJ,
    };
}
function productTime(view: DataView, pds: Section): { refTime: string; hours: number } {
    const at = pds.at;
    check(
        pds.length >= 28 &&
            pds.length <= 40 &&
            Array.from({ length: pds.length - 28 }, (_, i) => view.getUint8(at + 28 + i)).every((v) => v === 0),
        'UNSUPPORTED_PRODUCT',
        'Ensemble and local product extensions are unsupported.',
    );
    const yearOfCentury = view.getUint8(at + 12),
        century = view.getUint8(at + 24);
    const year = (century - 1) * 100 + yearOfCentury;
    const month = view.getUint8(at + 13),
        day = view.getUint8(at + 14),
        hour = view.getUint8(at + 15),
        minute = view.getUint8(at + 16);
    check(
        yearOfCentury >= 1 &&
            yearOfCentury <= 100 &&
            year >= 1900 &&
            year <= 2200 &&
            month >= 1 &&
            month <= 12 &&
            day >= 1 &&
            day <= 31 &&
            hour <= 23 &&
            minute <= 59,
        'MALFORMED',
        'The GRIB reference date is invalid.',
    );
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    check(
        date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day,
        'MALFORMED',
        'The GRIB reference date is invalid.',
    );
    const multiplier: Record<number, number> = { 0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12 };
    const unit = multiplier[view.getUint8(at + 17)];
    check(unit !== undefined, 'UNSUPPORTED_PRODUCT', 'Calendar-based or unsupported forecast units are not accepted.');
    const p1 = view.getUint8(at + 18),
        p2 = view.getUint8(at + 19),
        range = view.getUint8(at + 20);
    check(
        (range === 0 && p2 === 0) || (range === 1 && p1 === 0 && p2 === 0) || range === 10,
        'UNSUPPORTED_PRODUCT',
        'Only instantaneous wind analysis or forecast fields are supported.',
    );
    check(
        view.getUint16(at + 21) === 0 && view.getUint8(at + 23) === 0,
        'UNSUPPORTED_PRODUCT',
        'Averaged or incomplete time products are unsupported.',
    );
    const hours = (range === 10 ? p1 * 256 + p2 : p1) * unit;
    check(hours >= 0 && hours <= 24 * 31, 'LIMIT', 'The forecast extends beyond the import time limit.');
    return { refTime: date.toISOString(), hours };
}
const bit = (view: DataView, at: number, index: number) =>
    (view.getUint8(at + Math.floor(index / 8)) >> (7 - (index % 8))) & 1;
function padding(view: DataView, at: number, bytes: number, used: number, unused: number): void {
    check(unused <= 15 && bytes * 8 - used === unused, 'MALFORMED', 'Packed data length does not match its grid.');
    for (let i = used; i < bytes * 8; i++) check(bit(view, at, i) === 0, 'MALFORMED', 'GRIB padding must be zero.');
}
function unpack(
    view: DataView,
    bds: Section,
    bms: Section | undefined,
    grid: Grid,
    decimal: number,
    current: () => boolean,
    pressure = false,
): Float32Array {
    const cells = grid.width * grid.height;
    let present = cells;
    if (bms) {
        check(view.getUint16(bms.at + 4) === 0, 'UNSUPPORTED_BITMAP', 'Predefined bitmaps are unsupported.');
        padding(view, bms.at + 6, bms.length - 6, cells, view.getUint8(bms.at + 3));
        present = 0;
        for (let i = 0; i < cells; i++) {
            if ((i & 4095) === 0 && !current()) fail('CANCELLED', 'GRIB decoding stopped.');
            present += bit(view, bms.at + 6, i);
        }
    }
    const at = bds.at,
        flags = view.getUint8(at + 3),
        bits = view.getUint8(at + 10);
    check((flags & 0xd0) === 0, 'UNSUPPORTED_PACKING', 'Only grid-point simple packing is supported.');
    check(bits <= 32, 'UNSUPPORTED_PACKING', 'Packed values wider than 32 bits are unsupported.');
    padding(view, at + 11, bds.length - 11, present * bits, flags & 15);
    const reference = ibmFloat(view, at + 6),
        binary = 2 ** signMagnitude16(view.getUint16(at + 4)),
        divisor = 10 ** decimal;
    check(
        Number.isFinite(reference) && Number.isFinite(binary) && binary > 0 && Number.isFinite(divisor) && divisor > 0,
        'MALFORMED',
        'GRIB scale factors are not finite.',
    );
    const data = new Float32Array(cells);
    let cursor = 0;
    for (let i = 0; i < cells; i++) {
        if ((i & 4095) === 0 && !current()) fail('CANCELLED', 'GRIB decoding stopped.');
        let value = NaN;
        if (!bms || bit(view, bms.at + 6, i)) {
            let packed = 0,
                left = bits;
            while (left > 0) {
                const available = 8 - (cursor % 8),
                    take = Math.min(left, available);
                packed =
                    packed * 2 ** take +
                    ((view.getUint8(at + 11 + Math.floor(cursor / 8)) >> (available - take)) & (2 ** take - 1));
                cursor += take;
                left -= take;
            }
            value = (reference + packed * binary) / divisor;
            check(
                Number.isFinite(value) && (pressure ? value >= 30000 && value <= 120000 : Math.abs(value) <= 250),
                'MALFORMED',
                'A decoded wind component is outside the supported physical range.',
            );
        }
        const scanI = grid.adjacentJ ? Math.floor(i / grid.height) : i % grid.width;
        const scanJ = grid.adjacentJ ? i % grid.height : Math.floor(i / grid.width);
        const x = grid.negativeI ? grid.width - 1 - scanI : scanI;
        const y = grid.positiveJ ? scanJ : grid.height - 1 - scanJ;
        data[y * grid.width + x] = value;
    }
    return data;
}

/** Rejects the entire import on an unsupported wind field, broken pair or malformed message. */
export function decodeGrib1File(
    buffer: ArrayBuffer,
    shouldContinue: () => boolean = () => true,
    windOnly = false,
): ImportedGribFile {
    check(buffer.byteLength <= GRIB1_LIMITS.fileBytes, 'LIMIT', 'The GRIB file exceeds the import byte limit.');
    check(gribEdition(buffer) === 1, 'UNSUPPORTED_EDITION', 'The GRIB1 decoder cannot read this edition.');
    const view = new DataView(buffer),
        fields = new GribFieldCollection(1);
    let offset = 0,
        messages = 0;
    while (offset < buffer.byteLength) {
        check(shouldContinue(), 'CANCELLED', 'GRIB decoding stopped.');
        check(++messages <= GRIB1_LIMITS.messages, 'LIMIT', 'The GRIB file contains too many messages.');
        check(
            offset + 12 <= buffer.byteLength && view.getUint32(offset) === 0x47524942,
            'MALFORMED',
            'A message is truncated or bytes appear between GRIB messages.',
        );
        check(view.getUint8(offset + 7) === 1, 'UNSUPPORTED_EDITION', 'Mixed GRIB editions are unsupported.');
        const end = offset + u24(view, offset + 4),
            stop = end - 4;
        check(
            end >= offset + 51 && end <= buffer.byteLength && view.getUint32(stop) === 0x37373737,
            'MALFORMED',
            'A GRIB message length or end marker is invalid.',
        );
        const pds = section(view, offset + 8, stop, 28),
            at = pds.at,
            flags = view.getUint8(at + 7);
        check((flags & 0x3f) === 0, 'MALFORMED', 'Reserved product flags are set.');
        let cursor = at + pds.length,
            gds: Section | undefined,
            bms: Section | undefined;
        if (flags & 0x80) {
            gds = section(view, cursor, stop, 6);
            cursor += gds.length;
        }
        if (flags & 0x40) {
            bms = section(view, cursor, stop, 6);
            cursor += bms.length;
        }
        const bds = section(view, cursor, stop, 11);
        check(cursor + bds.length === stop, 'MALFORMED', 'Unexpected data appears after the packed field.');
        offset = end;
        const parameter = view.getUint8(at + 8);
        const pressure = !windOnly && parameter === 2 && view.getUint8(at + 9) === 102 && view.getUint16(at + 10) === 0;
        if (
            !pressure &&
            ((parameter !== 33 && parameter !== 34) || view.getUint8(at + 9) !== 105 || view.getUint16(at + 10) !== 10)
        ) {
            fields.ignoredMessages++;
            continue;
        }
        check(
            [1, 2, 3].includes(view.getUint8(at + 3)),
            'UNSUPPORTED_PRODUCT',
            'Local parameter tables are unsupported.',
        );
        check(gds, 'UNSUPPORTED_GRID', 'An explicit grid description is required.');
        const decodedGrid = gridDefinition(view, gds!),
            time = productTime(view, pds);
        const identity = {
            centre: view.getUint8(at + 4),
            subcentre: view.getUint8(at + 25),
            process: view.getUint8(at + 5),
            parameterTable: view.getUint8(at + 3),
        };
        const { width, height, north, south, west, east, dx, dy } = decodedGrid;
        const grid = {
            width,
            height,
            north,
            south,
            west,
            east,
            lats: Array.from({ length: height }, (_, i) => south + i * dy),
            lons: Array.from({ length: width }, (_, i) => west + i * dx),
        };
        fields.add(
            pressure ? 'p' : parameter === 33 ? 'u' : 'v',
            grid,
            time.refTime,
            time.hours,
            identity,
            JSON.stringify(identity),
            () =>
                unpack(view, bds, bms, decodedGrid, signMagnitude16(view.getUint16(at + 26)), shouldContinue, pressure),
        );
    }
    return fields.finish(shouldContinue);
}

export function decodeGrib1Wind(buffer: ArrayBuffer, shouldContinue: () => boolean = () => true): Grib1WindGrid {
    const file = decodeGrib1File(buffer, shouldContinue, true);
    check(file.wind, 'INCOMPLETE_WIND', 'No supported 10-metre U/V wind pair was found.');
    return file.wind as Grib1WindGrid;
}
