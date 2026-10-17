import { Inflate } from 'fflate';
import { OVERLAY_MAX_FEATURES, OVERLAY_MAX_VERTICES, ringContains, unwrapRing } from './model';
import type { Position } from 'geojson';

const EXPANDED = 16 * 1024 * 1024;
function fail(): never {
    throw Error('Invalid or unsupported shapefile ZIP. Use one WGS84 2D .shp/.dbf/.prj set.');
}
const decoder = new TextDecoder('utf-8', { fatal: true });
const crc32 = (data: Uint8Array) => {
    let c = -1;
    for (const b of data) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ -1) >>> 0;
};
/** Reject projected WGS84/UTM and ambiguous CRS; no coordinate guessing/reprojection. */
export function geographicWgs84(prj: string): boolean {
    let depth = 0,
        quoted = false,
        closed = -1;
    for (let i = prj.indexOf('['); i >= 0 && i < prj.length; i++) {
        if (prj[i] === '"') {
            if (quoted && prj[i + 1] === '"') {
                i++;
                continue;
            }
            quoted = !quoted;
        }
        if (quoted) continue;
        if (prj[i] === '[') depth++;
        if (prj[i] === ']' && --depth === 0) {
            closed = i;
            break;
        }
        if (depth < 0) return false;
    }
    return (
        !quoted &&
        depth === 0 &&
        closed >= 0 &&
        !prj.slice(closed + 1).trim() &&
        prj.length < 8192 &&
        /^\s*GEOGCS\s*\[/i.test(prj) &&
        !/PROJCS|PROJCRS|PROJECTION|CONVERSION|BOUNDCRS|COMPD_CS|VERT_CS|GEOCS|TOWGS84/i.test(prj) &&
        /DATUM\s*\[\s*"(?:D_)?WGS[_ ](?:1984|84)"/i.test(prj) &&
        /SPHEROID\s*\[\s*"WGS[_ ](?:1984|84)"\s*,\s*6378137(?:\.0*)?\s*,\s*298\.257223563/i.test(prj) &&
        /PRIMEM\s*\[\s*"Greenwich"\s*,\s*0(?:\.0*)?\s*\]/i.test(prj) &&
        /UNIT\s*\[\s*"(?:degree|degrees)"\s*,\s*0\.01745329251994[0-9]*\s*\]/i.test(prj) &&
        !/AXIS\s*\[\s*"(?:Lat|Latitude)"\s*,\s*NORTH\s*\]\s*,\s*AXIS/i.test(prj)
    );
}
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
        if (v.getUint32(i, true) === 0x06054b50) {
            end = i;
            break;
        }
    if (
        end < 0 ||
        v.getUint16(end + 4, true) ||
        v.getUint16(end + 6, true) ||
        end + 22 + v.getUint16(end + 20, true) !== bytes.length
    )
        fail();
    const count = v.getUint16(end + 10, true),
        start = v.getUint32(end + 16, true),
        size = v.getUint32(end + 12, true);
    if (!count || count > 8 || count !== v.getUint16(end + 8, true) || start + size !== end) fail();
    let offset = start,
        total = 0;
    const files = new Map<string, Uint8Array>(),
        ranges: [number, number][] = [];
    for (let i = 0; i < count; i++) {
        if (offset + 46 > end || v.getUint32(offset, true) !== 0x02014b50) fail();
        const flags = v.getUint16(offset + 8, true),
            method = v.getUint16(offset + 10, true),
            crc = v.getUint32(offset + 16, true),
            compressed = v.getUint32(offset + 20, true),
            expanded = v.getUint32(offset + 24, true),
            nameLength = v.getUint16(offset + 28, true),
            extra = v.getUint16(offset + 30, true),
            comment = v.getUint16(offset + 32, true),
            local = v.getUint32(offset + 42, true);
        if (
            flags & 1 ||
            ![0, 8].includes(method) ||
            v.getUint16(offset + 34, true) ||
            ((v.getUint32(offset + 38, true) >>> 16) & 0xf000) === 0xa000 ||
            offset + 46 + nameLength + extra + comment > end
        )
            fail();
        const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        if (
            !/^[a-z0-9_ .-]+(?:\/[a-z0-9_ .-]+)?\.(?:shp|shx|dbf|prj|cpg)$/i.test(name) ||
            name.includes('..') ||
            expanded > EXPANDED ||
            (total += expanded) > EXPANDED
        )
            fail();
        const key = name.split('/').at(-1)!.toLowerCase();
        if (files.has(key)) fail();
        if (
            local + 30 > start ||
            v.getUint32(local, true) !== 0x04034b50 ||
            v.getUint16(local + 6, true) !== flags ||
            v.getUint16(local + 8, true) !== method
        )
            fail();
        const ln = v.getUint16(local + 26, true),
            le = v.getUint16(local + 28, true),
            body = local + 30 + ln + le;
        if (
            decoder.decode(bytes.subarray(local + 30, local + 30 + ln)) !== name ||
            body + compressed > start ||
            ranges.some(([a, b]) => local < b && body + compressed > a)
        )
            fail();
        ranges.push([local, body + compressed]);
        const out = new Uint8Array(expanded);
        let used = 0;
        if (method === 0) {
            if (compressed !== expanded) fail();
            out.set(bytes.subarray(body, body + compressed));
            used = expanded;
        } else {
            const stream = new Inflate((chunk) => {
                if (used + chunk.length > expanded) fail();
                out.set(chunk, used);
                used += chunk.length;
            });
            for (let p = 0; p < compressed; p += 512)
                stream.push(bytes.subarray(body + p, body + Math.min(compressed, p + 512)), p + 512 >= compressed);
        }
        if (used !== expanded || crc32(out) !== crc) fail();
        files.set(key, out);
        offset += 46 + nameLength + extra + comment;
    }
    if (offset !== end) fail();
    return files;
}
function dbfNames(bytes: Uint8Array, encoding: string): Array<string | null> {
    if (bytes.length < 33) fail();
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        count = v.getUint32(4, true),
        header = v.getUint16(8, true),
        row = v.getUint16(10, true);
    if (
        count > OVERLAY_MAX_FEATURES ||
        header < 33 ||
        (header - 33) % 32 ||
        header + count * row > bytes.length ||
        bytes[header - 1] !== 13
    )
        fail();
    let pos = 1;
    const fields: { name: string; at: number; size: number }[] = [];
    for (let i = 32; i < header - 1; i += 32) {
        const name = new TextDecoder()
                .decode(bytes.subarray(i, i + 11))
                .replace(/\0.*$/, '')
                .toLowerCase(),
            length = bytes[i + 16];
        if (!length) fail();
        if (['name', 'label', 'title'].includes(name) && bytes[i + 11] === 67)
            fields.push({ name, at: pos, size: length });
        pos += length;
    }
    if (pos !== row) fail();
    const text = new TextDecoder(encoding, { fatal: true });
    return Array.from({ length: count }, (_, i) => {
        const p = header + i * row;
        if (![32, 42].includes(bytes[p])) fail();
        if (bytes[p] === 42) return null;
        const field = fields[0];
        return field ? text.decode(bytes.subarray(p + field.at, p + field.at + field.size)).trim() : '';
    });
}
function polygons(rings: Position[][]): Position[][][] {
    const area = (r: Position[]) => {
        const p = unwrapRing(r);
        return Math.abs(p.slice(1).reduce((s, b, i) => s + p[i][0] * b[1] - b[0] * p[i][1], 0));
    };
    const parents = rings.map(
        (r, i) =>
            rings
                .map((p, j) => ({ j, a: area(p) }))
                .filter(({ j, a }) => j !== i && a > area(r) && ringContains(rings[j], r[0][0], r[0][1]))
                .sort((a, b) => a.a - b.a)[0]?.j ?? -1,
    );
    const depth = (i: number): number => (parents[i] < 0 ? 0 : 1 + depth(parents[i]));
    return rings.flatMap((r, i) =>
        depth(i) % 2 ? [] : [[r, ...rings.filter((_, j) => parents[j] === i && depth(j) % 2 === 1)]],
    );
}
export function shapefileToGeoJSON(bytes: Uint8Array): unknown {
    const files = unzip(bytes),
        shapes = [...files.keys()].filter((k) => k.endsWith('.shp'));
    if (shapes.length !== 1) fail();
    const stem = shapes[0].slice(0, -4),
        prj = files.get(stem + '.prj'),
        dbf = files.get(stem + '.dbf'),
        shp = files.get(shapes[0]);
    if (
        !prj ||
        !dbf ||
        !shp ||
        !geographicWgs84(decoder.decode(prj)) ||
        [...files.keys()].some((k) => k.slice(0, -4) !== stem)
    )
        fail();
    const cpg = files.get(stem + '.cpg'),
        encoding = cpg ? decoder.decode(cpg).trim().toLowerCase() : 'windows-1252';
    if (!['utf-8', 'utf8', '65001', 'windows-1252', '1252'].includes(encoding)) fail();
    const names = dbfNames(dbf, ['utf-8', 'utf8', '65001'].includes(encoding) ? 'utf-8' : 'windows-1252');
    const v = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
    if (
        shp.length < 100 ||
        v.getInt32(0) !== 9994 ||
        v.getInt32(24) * 2 !== shp.length ||
        v.getInt32(28, true) !== 1000 ||
        ![1, 3, 5, 8].includes(v.getInt32(32, true))
    )
        fail();
    let offset = 100,
        index = 0,
        vertices = 0;
    const features = [];
    while (offset < shp.length) {
        if (offset + 12 > shp.length || index >= OVERLAY_MAX_FEATURES || v.getInt32(offset) !== index + 1) fail();
        const length = v.getInt32(offset + 4) * 2,
            end = offset + 8 + length,
            p = offset + 8,
            type = v.getInt32(p, true);
        if (length < 4 || end > shp.length || ![0, v.getInt32(32, true)].includes(type)) fail();
        const point = (at: number): Position => {
            if (at + 16 > end || ++vertices > OVERLAY_MAX_VERTICES) fail();
            return [v.getFloat64(at, true), v.getFloat64(at + 8, true)];
        };
        let geometry: unknown = null;
        if (type === 1) {
            if (length !== 20) fail();
            geometry = { type: 'Point', coordinates: point(p + 4) };
        } else if (type === 8) {
            if (length < 40) fail();
            const n = v.getInt32(p + 36, true);
            if (n < 1 || n > OVERLAY_MAX_VERTICES || p + 40 + 16 * n !== end) fail();
            geometry = { type: 'MultiPoint', coordinates: Array.from({ length: n }, (_, i) => point(p + 40 + 16 * i)) };
        } else if (type === 3 || type === 5) {
            if (length < 44) fail();
            const parts = v.getInt32(p + 36, true),
                n = v.getInt32(p + 40, true),
                base = p + 44 + 4 * parts;
            if (parts < 1 || parts > 1000 || n < 2 || n > OVERLAY_MAX_VERTICES || base + 16 * n !== end) fail();
            const starts = Array.from({ length: parts }, (_, i) => v.getInt32(p + 44 + 4 * i, true));
            if (starts[0] !== 0 || starts.some((x, i) => x < 0 || x >= n || (i > 0 && x <= starts[i - 1]))) fail();
            const lines = starts.map((s, i) =>
                Array.from({ length: (starts[i + 1] ?? n) - s }, (_, j) => point(base + 16 * (s + j))),
            );
            geometry =
                type === 3
                    ? { type: 'MultiLineString', coordinates: lines }
                    : { type: 'MultiPolygon', coordinates: polygons(lines) };
        }
        if (index >= names.length) fail();
        if (geometry && names[index] !== null)
            features.push({ type: 'Feature', properties: { name: names[index] }, geometry });
        index++;
        offset = end;
    }
    if (index !== names.length) fail();
    return { type: 'FeatureCollection', features };
}
