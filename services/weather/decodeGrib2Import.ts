/** Attachment-only GRIB2 reader. It never enters the legacy trusted-download decoder. */
import {
    GribFieldCollection,
    GribImportError,
    GRIB_IMPORT_LIMITS as LIMITS,
    type ImportedGribGrid,
    type ImportedGribFile,
} from './gribImportTypes';
const reject = (code: ConstructorParameters<typeof GribImportError>[0], message: string): never => {
    throw new GribImportError(code, message);
};
const requireValue = (ok: unknown, code: ConstructorParameters<typeof GribImportError>[0], message: string) => {
    if (!ok) reject(code, message);
};
const signed = (value: number, sign: number) => (value >= sign ? -1 : 1) * (value % sign);
const longitude = (n: number) => ((((n + 180) % 360) + 360) % 360) - 180;
type Grid = ImportedGribGrid & { scan: number };
function grid(view: DataView, at: number, length: number): Grid {
    requireValue(
        length === 72 &&
            view.getUint8(at + 5) === 0 &&
            view.getUint8(at + 10) === 0 &&
            view.getUint8(at + 11) === 0 &&
            view.getUint16(at + 12) === 0,
        'UNSUPPORTED_GRID',
        'GRIB2 import requires a full regular latitude/longitude grid (template 3.0).',
    );
    const width = view.getUint32(at + 30),
        height = view.getUint32(at + 34);
    requireValue(
        width >= 2 && height >= 2 && width * height <= LIMITS.gridPoints,
        'LIMIT',
        'The GRIB2 grid exceeds the point limit or is reduced.',
    );
    requireValue(
        view.getUint32(at + 6) === width * height,
        'MALFORMED',
        'The grid point count disagrees with its dimensions.',
    );
    requireValue(
        view.getUint32(at + 38) === 0 && [0, 0xffffffff].includes(view.getUint32(at + 42)),
        'UNSUPPORTED_GRID',
        'Custom basic-angle grids are unsupported.',
    );
    const coordinate = (offset: number) => signed(view.getUint32(at + offset), 0x80000000) / 1e6;
    const lat1 = coordinate(46),
        lon1 = coordinate(50),
        lat2 = coordinate(55),
        lon2 = coordinate(59);
    const flags = view.getUint8(at + 54),
        scan = view.getUint8(at + 71);
    requireValue(
        flags === 0x30 && !(scan & 0x1f),
        'UNSUPPORTED_GRID',
        'GRIB2 increments must be explicit and winds earth-relative; staggered/alternating scans are unsupported.',
    );
    const dx = view.getUint32(at + 63) / 1e6,
        dy = view.getUint32(at + 67) / 1e6;
    const endLat = lat1 + (scan & 64 ? 1 : -1) * (height - 1) * dy,
        endLon = lon1 + (scan & 128 ? -1 : 1) * (width - 1) * dx;
    requireValue(
        dx > 0 &&
            dy > 0 &&
            Math.abs(lat1) <= 90 &&
            Math.abs(lat2) <= 90 &&
            Math.abs(lon1) <= 360 &&
            Math.abs(lon2) <= 360 &&
            (width - 1) * dx <= 360 &&
            Math.abs(endLat - lat2) < 0.0000011 &&
            Math.abs(longitude(endLon - lon2)) < 0.0000011,
        'UNSUPPORTED_GRID',
        'GRIB2 endpoints disagree with the grid increments and scan.',
    );
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    const west = round(longitude(scan & 128 ? endLon : lon1)),
        south = Math.min(lat1, lat2),
        north = Math.max(lat1, lat2);
    return {
        width,
        height,
        north,
        south,
        west,
        east: round(west + (width - 1) * dx),
        lats: Array.from({ length: height }, (_, i) => round(south + i * dy)),
        lons: Array.from({ length: width }, (_, i) => round(west + i * dx)),
        scan,
    };
}
function values(
    view: DataView,
    dataAt: number,
    dataLength: number,
    representation: number,
    bitmap: number,
    bitmapLength: number,
    g: Grid,
    pressure: boolean,
    current: () => boolean,
): Float32Array {
    const cells = g.width * g.height,
        indicator = view.getUint8(bitmap + 5);
    requireValue(
        indicator === 0 || indicator === 255,
        'UNSUPPORTED_BITMAP',
        'GRIB2 predefined/reused bitmaps are unsupported.',
    );
    requireValue(
        indicator === 0 ? bitmapLength === 6 + Math.ceil(cells / 8) : bitmapLength === 6,
        'MALFORMED',
        'The GRIB2 bitmap has the wrong length.',
    );
    const bit = (at: number, i: number) => (view.getUint8(at + Math.floor(i / 8)) >> (7 - (i % 8))) & 1;
    let present = indicator === 255 ? cells : 0;
    if (!indicator) {
        for (let i = 0; i < cells; i++) {
            if (!(i & 4095) && !current()) reject('CANCELLED', 'GRIB decoding stopped.');
            present += bit(bitmap + 6, i);
        }
        for (let i = cells; i < (bitmapLength - 6) * 8; i++)
            requireValue(!bit(bitmap + 6, i), 'MALFORMED', 'Bitmap padding must be zero.');
    }
    const bits = view.getUint8(representation + 19),
        reference = view.getFloat32(representation + 11);
    const binary = 2 ** signed(view.getUint16(representation + 15), 0x8000),
        divisor = 10 ** signed(view.getUint16(representation + 17), 0x8000);
    requireValue(
        view.getUint16(representation + 9) === 0 && bits <= 32,
        'UNSUPPORTED_PACKING',
        'GRIB2 import supports simple packing (template 5.0) up to 32 bits.',
    );
    requireValue(
        view.getUint32(representation + 5) === present &&
            dataLength * 8 >= present * bits &&
            dataLength * 8 - present * bits < 8,
        'MALFORMED',
        'Packed values do not match the declared grid/bitmap.',
    );
    requireValue(
        Number.isFinite(reference) && Number.isFinite(binary) && binary > 0 && Number.isFinite(divisor) && divisor > 0,
        'MALFORMED',
        'Invalid GRIB2 packing scales.',
    );
    for (let i = present * bits; i < dataLength * 8; i++)
        requireValue(!bit(dataAt, i), 'MALFORMED', 'Packed padding must be zero.');
    const result = new Float32Array(cells);
    let cursor = 0;
    for (let i = 0; i < cells; i++) {
        if (!(i & 4095) && !current()) reject('CANCELLED', 'GRIB decoding stopped.');
        let value = NaN;
        if (indicator === 255 || bit(bitmap + 6, i)) {
            let packed = 0,
                left = bits;
            while (left) {
                const available = 8 - (cursor % 8),
                    take = Math.min(left, available);
                packed =
                    packed * 2 ** take +
                    ((view.getUint8(dataAt + Math.floor(cursor / 8)) >> (available - take)) & (2 ** take - 1));
                cursor += take;
                left -= take;
            }
            value = (reference + packed * binary) / divisor;
            requireValue(
                Number.isFinite(value) && (pressure ? value >= 30000 && value <= 120000 : Math.abs(value) <= 250),
                'MALFORMED',
                'Decoded GRIB2 values are outside the supported physical range.',
            );
        }
        const x0 = g.scan & 32 ? Math.floor(i / g.height) : i % g.width,
            y0 = g.scan & 32 ? i % g.height : Math.floor(i / g.width);
        const x = g.scan & 128 ? g.width - 1 - x0 : x0,
            y = g.scan & 64 ? y0 : g.height - 1 - y0;
        result[y * g.width + x] = value;
    }
    return result;
}
export function decodeGrib2Import(buffer: ArrayBuffer, current: () => boolean = () => true): ImportedGribFile {
    requireValue(buffer.byteLength <= LIMITS.fileBytes, 'LIMIT', 'The GRIB file exceeds the import byte limit.');
    const view = new DataView(buffer),
        fields = new GribFieldCollection(2);
    let offset = 0,
        messages = 0,
        sections = 0;
    while (offset < buffer.byteLength) {
        requireValue(current(), 'CANCELLED', 'GRIB decoding stopped.');
        requireValue(++messages <= LIMITS.messages, 'LIMIT', 'Too many GRIB messages.');
        requireValue(
            offset + 20 <= buffer.byteLength && view.getUint32(offset) === 0x47524942,
            'MALFORMED',
            'Invalid GRIB2 message header.',
        );
        requireValue(view.getUint8(offset + 7) === 2, 'UNSUPPORTED_EDITION', 'Mixed GRIB editions are unsupported.');
        requireValue(view.getUint32(offset + 8) === 0, 'LIMIT', 'The GRIB2 message exceeds the size limit.');
        const end = offset + view.getUint32(offset + 12),
            stop = end - 4,
            discipline = view.getUint8(offset + 6);
        requireValue(
            end >= offset + 20 && end <= buffer.byteLength && view.getUint32(stop) === 0x37373737,
            'MALFORMED',
            'Invalid GRIB2 message length/end marker.',
        );
        let at = offset + 16,
            state = 0,
            refTime = '',
            source = { centre: 0, subcentre: 0, process: 0, parameterTable: 0 },
            sourceKey = '',
            g: Grid | undefined;
        let component: 'u' | 'v' | 'p' | null = null,
            hours = 0,
            representation = 0,
            bitmap = 0,
            bitmapLength = 0;
        while (at < stop) {
            requireValue(current(), 'CANCELLED', 'GRIB decoding stopped.');
            requireValue(++sections <= 4096 && at + 5 <= stop, 'LIMIT', 'Too many or truncated GRIB2 sections.');
            const length = view.getUint32(at),
                number = view.getUint8(at + 4);
            requireValue(length >= 5 && at + length <= stop, 'MALFORMED', 'A GRIB2 section length is invalid.');
            if (number === 1) {
                requireValue(state === 0 && length === 21, 'MALFORMED', 'Invalid GRIB2 identification section.');
                const year = view.getUint16(at + 12),
                    month = view.getUint8(at + 14),
                    day = view.getUint8(at + 15),
                    hour = view.getUint8(at + 16),
                    minute = view.getUint8(at + 17),
                    second = view.getUint8(at + 18);
                const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
                requireValue(
                    year >= 1900 &&
                        year <= 2200 &&
                        month >= 1 &&
                        month <= 12 &&
                        day >= 1 &&
                        hour < 24 &&
                        minute < 60 &&
                        second < 60 &&
                        date.getUTCMonth() === month - 1 &&
                        date.getUTCDate() === day,
                    'MALFORMED',
                    'Invalid GRIB2 reference date.',
                );
                refTime = date.toISOString();
                source = {
                    centre: view.getUint16(at + 5),
                    subcentre: view.getUint16(at + 7),
                    parameterTable: view.getUint8(at + 9),
                    process: 0,
                };
                sourceKey = JSON.stringify([
                    source,
                    view.getUint8(at + 10),
                    view.getUint8(at + 11),
                    view.getUint8(at + 19),
                    view.getUint8(at + 20),
                ]);
                state = 1;
            } else if (number === 3) {
                requireValue(state === 1 || state === 7, 'MALFORMED', 'Unexpected GRIB2 grid section.');
                g = grid(view, at, length);
                state = 3;
            } else if (number === 4) {
                requireValue(
                    (state === 3 || state === 7) && g && length >= 34,
                    'MALFORMED',
                    'Invalid GRIB2 product section.',
                );
                const category = view.getUint8(at + 9),
                    parameter = view.getUint8(at + 10),
                    surface = view.getUint8(at + 22),
                    scale = signed(view.getUint8(at + 23), 128),
                    height = view.getUint32(at + 24) * 10 ** -scale;
                component =
                    discipline === 0 &&
                    category === 2 &&
                    (parameter === 2 || parameter === 3) &&
                    surface === 103 &&
                    height === 10
                        ? parameter === 2
                            ? 'u'
                            : 'v'
                        : discipline === 0 && category === 3 && parameter === 1 && surface === 101
                          ? 'p'
                          : null;
                if (component) {
                    requireValue(
                        length === 34 &&
                            view.getUint16(at + 5) === 0 &&
                            view.getUint16(at + 7) === 0 &&
                            view.getUint8(at + 28) === 255 &&
                            view.getUint8(at + 11) <= 2,
                        'UNSUPPORTED_PRODUCT',
                        'Only standard instantaneous non-ensemble GRIB2 wind/mean-sea-level pressure is supported.',
                    );
                    const units: Record<number, number> = {
                            0: 1 / 60,
                            1: 1,
                            2: 24,
                            10: 3,
                            11: 6,
                            12: 12,
                            13: 1 / 3600,
                        },
                        unit = units[view.getUint8(at + 17)];
                    requireValue(unit !== undefined, 'UNSUPPORTED_PRODUCT', 'Unsupported GRIB2 forecast time unit.');
                    hours = view.getUint32(at + 18) * unit;
                    requireValue(hours <= 744, 'LIMIT', 'The GRIB2 forecast extends beyond 31 days.');
                    source = { ...source, process: view.getUint8(at + 13) };
                } else fields.ignoredMessages++;
                state = 4;
            } else if (number === 5) {
                requireValue(state === 4 && length >= 11, 'MALFORMED', 'Unexpected GRIB2 packing section.');
                if (component)
                    requireValue(
                        length === 21 && view.getUint16(at + 9) === 0 && view.getUint8(at + 20) <= 1,
                        'UNSUPPORTED_PACKING',
                        'Unsupported GRIB2 packing; simple packing template 5.0 is required.',
                    );
                representation = at;
                state = 5;
            } else if (number === 6) {
                requireValue(state === 5 && length >= 6, 'MALFORMED', 'Unexpected GRIB2 bitmap section.');
                bitmap = at;
                bitmapLength = length;
                state = 6;
            } else if (number === 7) {
                requireValue(state === 6 && g, 'MALFORMED', 'Unexpected GRIB2 data section.');
                if (component) {
                    const { scan, ...geometry } = g!;
                    void scan;
                    fields.add(component, geometry, refTime, hours, source, sourceKey + ':' + source.process, () =>
                        values(
                            view,
                            at + 5,
                            length - 5,
                            representation,
                            bitmap,
                            bitmapLength,
                            g!,
                            component === 'p',
                            current,
                        ),
                    );
                }
                state = 7;
            } else reject('UNSUPPORTED_PRODUCT', 'Local-use or unknown GRIB2 sections are unsupported.');
            at += length;
        }
        requireValue(at === stop && state === 7, 'MALFORMED', 'The GRIB2 message has an incomplete field.');
        offset = end;
    }
    return fields.finish(current);
}
