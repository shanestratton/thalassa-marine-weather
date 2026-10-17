import { Unzlib } from 'fflate';
import {
    rasterBounds,
    rasterDimensions,
    rasterInput,
    rasterRequire as require,
    webMercator,
    inverseWebMercator,
    LOCAL_RASTER_BYTES,
    type LocalRasterImage,
} from './localRasterContract';

interface Tag {
    type: number;
    count: number;
    at: number;
    bytes: number;
}
const TYPE_BYTES: Readonly<Record<number, number>> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    6: 1,
    7: 1,
    8: 2,
    9: 4,
    10: 8,
    11: 4,
    12: 8,
};
function inflateStrip(input: Uint8Array, expected: number, check: () => void): Uint8Array {
    require(input.length >= 6 &&
        expected > 0 &&
        expected <= LOCAL_RASTER_BYTES, 'GeoTIFF decoded strip exceeds its pixel budget.');
    const output = new Uint8Array(expected);
    let length = 0,
        finished = false,
        a = 1,
        b = 0;
    const inflater = new Unzlib((chunk, final) => {
        check();
        require(length + chunk.length <= expected, 'GeoTIFF Deflate strip expands beyond its declared pixels.');
        output.set(chunk, length);
        length += chunk.length;
        for (const value of chunk) {
            a = (a + value) % 65521;
            b = (b + a) % 65521;
        }
        finished = final;
    });
    // Small input pushes bound each transient inflater output as well as the
    // exact aggregate destination. Never inflate a whole untrusted strip first.
    for (let at = 0; at < input.length; at += 1024) {
        check();
        inflater.push(input.subarray(at, Math.min(input.length, at + 1024)), at + 1024 >= input.length);
    }
    const trailer = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(input.length - 4, false);
    require(finished &&
        length === expected &&
        (b * 65536 + a) >>> 0 === trailer, 'GeoTIFF Deflate size or original Adler checksum disagrees.');
    return output;
}
function unpackBits(input: Uint8Array, expected: number, check: () => void): Uint8Array {
    const output = new Uint8Array(expected);
    let at = 0,
        out = 0;
    while (at < input.length) {
        check();
        const header = input[at++];
        if (header === 128) continue;
        const count = header <= 127 ? header + 1 : 257 - header;
        require(out + count <= expected, 'GeoTIFF PackBits run exceeds its declared strip.');
        if (header <= 127) {
            require(at + count <= input.length, 'GeoTIFF PackBits strip is incomplete.');
            output.set(input.subarray(at, at + count), out);
            at += count;
        } else {
            require(at < input.length, 'GeoTIFF PackBits repeated colour is missing.');
            output.fill(input[at++], out, out + count);
        }
        out += count;
    }
    require(out === expected, 'GeoTIFF PackBits strip does not fill its original pixels.');
    return output;
}
/** Explicit classic north-up GeoTIFF subset, with no guessed CRS, axes or missing-strip repair. */
export function decodeGeoTiff(bytes: Uint8Array, check: () => void): LocalRasterImage {
    rasterInput(bytes);
    check();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[0] === 73 && bytes[1] === 73;
    require(little || (bytes[0] === 77 && bytes[1] === 77), 'GeoTIFF byte order is invalid.');
    const range = (at: number, count: number) =>
        require(Number.isSafeInteger(at) &&
            Number.isSafeInteger(count) &&
            at >= 0 &&
            count >= 0 &&
            at + count <= bytes.length, 'GeoTIFF offset or length exceeds the original file.');
    const u16 = (at: number) => {
        range(at, 2);
        return view.getUint16(at, little);
    };
    const u32 = (at: number) => {
        range(at, 4);
        return view.getUint32(at, little);
    };
    require(u16(2) === 42, 'BigTIFF and non-classic TIFF files are unsupported. Export classic GeoTIFF or MBTiles.');
    const directory = u32(4),
        count = u16(directory);
    require(directory >= 8 && count > 0 && count <= 64, 'GeoTIFF image directory exceeds 64 fields.');
    range(directory, 2 + count * 12 + 4);
    require(u32(directory + 2 + count * 12) ===
        0, 'Multi-image/overview GeoTIFF is unsupported. Use a bounded MBTiles pyramid.');
    const tags = new Map<number, Tag>();
    let metadataBytes = 0;
    for (let index = 0; index < count; index++) {
        check();
        const entry = directory + 2 + index * 12,
            id = u16(entry),
            type = u16(entry + 2),
            length = u32(entry + 4);
        const size = TYPE_BYTES[type];
        require(!tags.has(id) &&
            size &&
            length > 0 &&
            length <= 16384 &&
            size * length <= 65536, 'GeoTIFF has a duplicate, unsupported or oversized field.');
        const at = size * length <= 4 ? entry + 8 : u32(entry + 8);
        metadataBytes += size * length;
        require(metadataBytes <= 128 * 1024, 'GeoTIFF metadata exceeds 128 KiB.');
        range(at, size * length);
        tags.set(id, { type, count: length, at, bytes: size * length });
    }
    for (const [id, types] of [
        [256, [3, 4]],
        [257, [3, 4]],
        [258, [3]],
        [259, [3]],
        [262, [3]],
        [273, [3, 4]],
        [274, [3]],
        [277, [3]],
        [278, [3, 4]],
        [279, [3, 4]],
        [284, [3]],
        [317, [3]],
        [320, [3]],
        [338, [3]],
        [339, [3]],
        [33550, [12]],
        [33922, [12]],
    ] as const) {
        const tag = tags.get(id);
        require(!tag ||
            (types as readonly number[]).includes(tag.type), `GeoTIFF field ${id} has an invalid TIFF type.`);
    }
    const numbers = (id: number, fallback?: readonly number[]): number[] => {
        const tag = tags.get(id);
        if (!tag) {
            require(fallback !== undefined, `GeoTIFF required field ${id} is missing.`);
            return [...fallback];
        }
        require([1, 3, 4, 12].includes(tag.type), `GeoTIFF numeric field ${id} has the wrong type.`);
        return Array.from({ length: tag.count }, (_, index) => {
            const at = tag.at + index * TYPE_BYTES[tag.type];
            const value =
                tag.type === 1
                    ? bytes[at]
                    : tag.type === 3
                      ? u16(at)
                      : tag.type === 4
                        ? u32(at)
                        : view.getFloat64(at, little);
            require(Number.isFinite(value), 'GeoTIFF contains a non-finite numeric field.');
            return value;
        });
    };
    const scalar = (id: number, fallback?: number) => {
        const value = numbers(id, fallback === undefined ? undefined : [fallback]);
        require(value.length === 1, `GeoTIFF field ${id} is not scalar.`);
        return value[0];
    };
    const width = scalar(256),
        height = scalar(257);
    rasterDimensions(width, height);
    require(!tags.has(322) &&
        !tags.has(323) &&
        !tags.has(324) &&
        !tags.has(
            325,
        ), 'Tiled GeoTIFF is unsupported in this bounded reader. Export a strip GeoTIFF or MBTiles pyramid.');
    require(scalar(274, 1) === 1 && scalar(284, 1) === 1, 'Only north-up, contiguous GeoTIFF samples are supported.');
    const samples = scalar(277, 1),
        photo = scalar(262),
        bits = numbers(258),
        sampleFormat = numbers(339, [1]);
    require([1, 3, 4].includes(samples) &&
        bits.length === samples &&
        bits.every((value) => value === 8) &&
        sampleFormat.every((value) => value === 1) &&
        (sampleFormat.length === 1 ||
            sampleFormat.length === samples), 'GeoTIFF requires 8-bit unsigned gray, palette, RGB or RGBA samples.');
    require(([0, 1, 3].includes(photo) && samples === 1) ||
        (photo === 2 &&
            [3, 4].includes(samples)), 'GeoTIFF colour model is unsupported. Export 8-bit RGB or palette GeoTIFF.');
    require(samples !== 4 ||
        (numbers(338).length === 1 &&
            scalar(338) === 2), 'GeoTIFF requires explicitly unassociated alpha; associated alpha is unsupported.');
    require(!tags.has(
        34264,
    ), 'Rotated or transformed GeoTIFF is unsupported. Export a rectified north-up MBTiles pyramid.');
    const scale = numbers(33550),
        tie = numbers(33922),
        keyTag = tags.get(34735);
    require(scale.length === 3 &&
        scale[0] > 0 &&
        scale[1] > 0 &&
        scale[2] === 0 &&
        tie.length === 6 &&
        tie[2] === 0 &&
        tie[5] === 0, 'GeoTIFF requires one explicit 2D tiepoint and positive pixel scale.');
    require(keyTag?.type === 3, 'GeoTIFF GeoKeyDirectory must be SHORT values.');
    const keys = numbers(34735);
    require(keys[0] === 1 &&
        keys[1] === 1 &&
        [0, 1].includes(keys[2]) &&
        keys[3] > 0 &&
        keys[3] <= 32 &&
        keys.length === 4 + keys[3] * 4, 'GeoTIFF GeoKey directory is malformed or oversized.');
    const crs = new Map<number, number>(),
        citations = new Set([1026, 2049, 3073]);
    const allowed = new Set([1024, 1025, 2048, 2050, 2051, 2054, 2056, 3072, 3076]);
    let prior = 0;
    for (let at = 4; at < keys.length; at += 4) {
        const [id, tag, length, value] = keys.slice(at, at + 4);
        require(id > prior && !crs.has(id), 'GeoTIFF GeoKeys must be unique and sorted.');
        prior = id;
        if (citations.has(id)) {
            const text = tags.get(34737);
            require(tag === 34737 &&
                text?.type === 2 &&
                length > 0 &&
                value + length <= text.count, 'GeoTIFF CRS citation reference is invalid.');
        } else {
            require(allowed.has(id) &&
                tag === 0 &&
                length === 1, 'GeoTIFF has an unsupported custom CRS or datum key.');
            crs.set(id, value);
        }
    }
    const geographic = crs.get(1024) === 2 && crs.get(2048) === 4326 && !crs.has(3072);
    const projected = crs.get(1024) === 1 && crs.get(3072) === 3857 && (!crs.has(2048) || crs.get(2048) === 4326);
    require(geographic ||
        projected, 'GeoTIFF CRS is not explicitly WGS84 EPSG:4326 or EPSG:3857. No datum transformation is guessed.');
    for (const [key, expected] of [
        [2050, 6326],
        [2051, 8901],
        [2054, 9102],
        [2056, 7030],
        [3076, 9001],
    ])
        require(!crs.has(key) ||
            crs.get(key) === expected, 'GeoTIFF datum, prime meridian or units conflict with WGS84.');
    const rasterType = crs.get(1025);
    require(rasterType === 1 || rasterType === 2, 'GeoTIFF must explicitly declare PixelIsArea or PixelIsPoint.');
    const shift = rasterType === 2 ? -0.5 : 0;
    const left = tie[3] + (shift - tie[0]) * scale[0],
        top = tie[4] - (shift - tie[1]) * scale[1];
    const right = left + width * scale[0],
        bottom = top - height * scale[1],
        radius = 6378137;
    const bounds = geographic
        ? [left, bottom, right, top]
        : [
              ((left / radius) * 180) / Math.PI,
              inverseWebMercator(bottom / radius),
              ((right / radius) * 180) / Math.PI,
              inverseWebMercator(top / radius),
          ];
    rasterBounds(bounds);
    const declaredRows = scalar(278, height),
        rows = Math.min(declaredRows, height),
        offsets = numbers(273),
        lengths = numbers(279);
    require(Number.isSafeInteger(declaredRows) &&
        declaredRows > 0 &&
        declaredRows <= 0xffffffff &&
        offsets.length === Math.ceil(height / rows) &&
        lengths.length === offsets.length &&
        offsets.length <= 1024, 'GeoTIFF strips are missing or exceed their row budget.');
    const compression = scalar(259, 1),
        predictor = scalar(317, 1);
    require([1, 8, 32946, 32773].includes(compression) &&
        [1, 2].includes(
            predictor,
        ), 'GeoTIFF compression or predictor is unsupported. Export uncompressed, Deflate or PackBits 8-bit GeoTIFF.');
    const intervals = offsets
        .map((at, index) => {
            range(at, lengths[index]);
            require(lengths[index] > 0, 'GeoTIFF has an empty encoded strip.');
            return [at, at + lengths[index]];
        })
        .sort((a, b) => a[0] - b[0]);
    require(intervals.every(
        (interval, index) => index === 0 || interval[0] >= intervals[index - 1][1],
    ), 'GeoTIFF encoded strips overlap.');
    const palette = photo === 3 ? numbers(320) : [];
    require(photo !== 3 || palette.length === 768, 'GeoTIFF palette must contain all 256 original RGB entries.');
    const noDataTag = tags.get(42113);
    let noData: number | null = null;
    if (noDataTag) {
        require(noDataTag.type === 2 && noDataTag.count <= 16, 'GeoTIFF nodata marker is invalid.');
        const value = new TextDecoder()
            .decode(bytes.subarray(noDataTag.at, noDataTag.at + noDataTag.count))
            .replace(/\0$/, '');
        require(/^\d{1,3}$/.test(value) &&
            Number(value) <= 255, 'GeoTIFF nodata marker is unsupported for unsigned pixels.');
        noData = Number(value);
    }
    // Both the original raw planes and each decoded strip have exact finite
    // admission before allocation. No whole-file inflater or inferred sea mask.
    const rawBytes = width * height * samples;
    require(rawBytes <= LOCAL_RASTER_BYTES, 'GeoTIFF raw samples exceed 4 MiB. Export a bounded MBTiles pyramid.');
    const original = new Uint8Array(rawBytes);
    let decoded = 0;
    for (let strip = 0; strip < offsets.length; strip++) {
        check();
        const rowCount = Math.min(rows, height - strip * rows),
            expected = width * rowCount * samples;
        require(expected > 0 &&
            expected <= LOCAL_RASTER_BYTES &&
            decoded + expected <= rawBytes, 'GeoTIFF decoded strips exceed the aggregate pixel budget.');
        const input = bytes.subarray(offsets[strip], offsets[strip] + lengths[strip]);
        const expanded =
            compression === 1
                ? input
                : compression === 32773
                  ? unpackBits(input, expected, check)
                  : inflateStrip(input, expected, check);
        require(expanded.length === expected, 'GeoTIFF strip length does not match its declared rows.');
        original.set(expanded, decoded);
        if (predictor === 2)
            for (let row = 0; row < rowCount; row++) {
                check();
                const start = decoded + row * width * samples;
                for (let column = samples; column < width * samples; column++)
                    original[start + column] = (original[start + column] + original[start + column - samples]) & 255;
            }
        decoded += expected;
    }
    require(decoded === rawBytes, 'GeoTIFF has missing decoded strips.');
    const rgba = new Uint8Array(width * height * 4),
        north = webMercator(bounds[3]),
        south = webMercator(bounds[1]);
    for (let row = 0; row < height; row++) {
        check();
        const lat = inverseWebMercator(north + ((south - north) * (row + 0.5)) / height);
        const modelY = geographic ? lat : webMercator(lat) * radius;
        const y = Math.floor((top - modelY) / scale[1]);
        require(y >= 0 && y < height, 'GeoTIFF target sample is outside its original rows.');
        for (let column = 0; column < width; column++) {
            const at = (y * width + column) * samples,
                out = (row * width + column) * 4,
                value = original[at];
            if (samples === 4 && original[at + 3] === 0) continue;
            if (
                noData !== null &&
                (samples === 1
                    ? value === noData
                    : original[at] === noData && original[at + 1] === noData && original[at + 2] === noData)
            )
                continue;
            if (photo === 3)
                rgba.set(
                    [
                        Math.round(palette[value] / 257),
                        Math.round(palette[value + 256] / 257),
                        Math.round(palette[value + 512] / 257),
                        255,
                    ],
                    out,
                );
            else if (samples === 1) {
                const gray = photo === 0 ? 255 - value : value;
                rgba.set([gray, gray, gray, 255], out);
            } else rgba.set([value, original[at + 1], original[at + 2], samples === 4 ? original[at + 3] : 255], out);
        }
    }
    return {
        width,
        height,
        rgba,
        bounds,
        datum: 'WGS84',
        sourceProjection: geographic ? 'EPSG:4326' : 'EPSG:3857',
        note: 'Original GeoTIFF georeferencing only. Chart sounding datum and currency are unverified; no vertical conversion.',
    };
}
