import {
    rasterBounds,
    rasterDimensions,
    rasterInput,
    rasterRequire as require,
    webMercator,
    inverseWebMercator,
    wgs84Mercator,
    inverseWgs84Mercator,
    type LocalRasterImage,
} from './localRasterContract';

interface Ref {
    x: number;
    y: number;
    lat: number;
    lon: number;
}
const values = (line: string) => line.slice(4).split(',').map(Number);
/** BSB v2/3 KAP image reader. No catalogue, missing-row repair or datum/projection fallback. */
export function decodeKap(bytes: Uint8Array, check: () => void): LocalRasterImage {
    rasterInput(bytes);
    check();
    let end = -1;
    for (let at = 0; at < Math.min(bytes.length - 1, 65536); at++) {
        if (bytes[at] === 26 && bytes[at + 1] === 0) {
            end = at;
            break;
        }
    }
    require(end > 0, 'KAP header is missing or exceeds 64 KiB. Choose the .kap image, not its .bsb catalogue.');
    require(bytes
        .subarray(0, end)
        .every(
            (byte) => byte === 10 || byte === 13 || byte === 9 || (byte >= 32 && byte < 127),
        ), 'KAP uses an unsupported binary or non-ASCII header.');
    const lines: string[] = [];
    for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split(/\r\n|\n|\r/)) {
        if (/^\s/.test(line) && lines.length) lines[lines.length - 1] += ',' + line.trim();
        else if (line && !line.startsWith('!')) lines.push(line);
    }
    require(lines.length <= 512, 'KAP header has too many records.');
    const one = (key: string, optional = false) => {
        const matches = lines.filter((line) => line.startsWith(key + '/'));
        require(matches.length === 1 ||
            (optional && matches.length === 0), `KAP ${key} record is missing or duplicated.`);
        return matches[0] ?? '';
    };
    require(/^VER\/[23](?:\.0+)?$/.test(one('VER')), 'Only BSB/KAP version 2 or 3 image encoding is supported.');
    const dimensions = one('BSB').match(/(?:\/|,)RA=(\d+),(\d+)(?:,|$)/);
    require(dimensions, 'KAP image dimensions are missing.');
    const width = Number(dimensions[1]),
        height = Number(dimensions[2]);
    rasterDimensions(width, height);
    const parameters = Object.fromEntries(
        [
            ...one('KNP')
                .slice(4)
                .matchAll(/(?:^|,)([A-Z]{2})=([^,]*)/g),
        ].map((match) => [match[1], match[2].trim()]),
    );
    require(['WGS84', 'WGS 84'].includes(
        parameters.GD?.toUpperCase() ?? '',
    ), 'KAP datum is not explicitly WGS84. Datum conversion is not supported.');
    require(parameters.PR?.toUpperCase() ===
        'MERCATOR', 'This KAP projection is unsupported. Export a WGS84 north-up Mercator image or MBTiles pyramid.');
    require(parameters.SK === undefined ||
        Number(parameters.SK) === 0, 'Skewed KAP charts are unsupported. Export a north-up MBTiles pyramid.');
    const shift = one('DTM', true);
    require(!shift ||
        (values(shift).length === 2 &&
            values(shift).every((value) => value === 0)), 'KAP datum shifts require an unsupported datum conversion.');
    const refs: Ref[] = [];
    const refIds = new Set<number>();
    for (const line of lines.filter((line) => line.startsWith('REF/'))) {
        const [id, x, y, lat, lon, extra] = values(line);
        require(extra === undefined &&
            [id, x, y, lat, lon].every(Number.isFinite) &&
            !refIds.has(id) &&
            x >= 0 &&
            x <= width &&
            y >= 0 &&
            y <= height &&
            Math.abs(lat) <= 85.05112878 &&
            Math.abs(lon) <= 180, 'KAP registration point is invalid or outside supported bounds.');
        refs.push({ x, y, lat, lon });
        refIds.add(id);
    }
    require(refs.length >= 3 &&
        refs.length <= 64, 'KAP needs 3–64 original registration points; no georeferencing is guessed.');
    const fit = (pixel: 'x' | 'y', model: (ref: Ref) => number) => {
        let a = refs[0],
            b = refs[0];
        for (const ref of refs) {
            if (ref[pixel] < a[pixel]) a = ref;
            if (ref[pixel] > b[pixel]) b = ref;
        }
        require(b[pixel] > a[pixel], 'KAP registration points cannot determine both image axes.');
        const scale = (model(b) - model(a)) / (b[pixel] - a[pixel]),
            origin = model(a) - scale * a[pixel];
        require(Number.isFinite(scale) &&
            scale !== 0 &&
            refs.every(
                (ref) => Math.abs((model(ref) - origin) / scale - ref[pixel]) <= 0.5,
            ), 'KAP registration is rotated, warped or inconsistent beyond half a pixel. Export a rectified MBTiles pyramid.');
        return { scale, origin };
    };
    const x = fit('x', (ref) => ref.lon),
        y = fit('y', (ref) => wgs84Mercator(ref.lat));
    require(x.scale > 0 && y.scale < 0, 'Only north-up, east-right KAP registration is supported.');
    // Axis-separable registration still requires non-collinear original points.
    require(refs.some((b, i) =>
        refs.some(
            (c, j) =>
                i !== j &&
                Math.abs((b.x - refs[0].x) * (c.y - refs[0].y) - (c.x - refs[0].x) * (b.y - refs[0].y)) > 1e-6,
        ),
    ), 'KAP registration points are collinear.');
    const bounds = [
        x.origin,
        inverseWgs84Mercator(y.origin + y.scale * height),
        x.origin + x.scale * width,
        inverseWgs84Mercator(y.origin),
    ];
    rasterBounds(bounds);
    const polygon = lines
        .filter((line) => line.startsWith('PLY/'))
        .map((line) => {
            const tuple = values(line);
            require(tuple.length === 3 &&
                tuple.every(Number.isFinite) &&
                Math.abs(tuple[1]) <= 85.05112878 &&
                Math.abs(tuple[2]) <= 180, 'KAP cutline is invalid.');
            return [tuple[2], tuple[1]] as const;
        });
    require(polygon.length === 0 ||
        (polygon.length >= 3 && polygon.length <= 128), 'KAP cutline must have 3–128 vertices.');
    const palette = new Map<number, readonly number[]>();
    for (const line of lines.filter((line) => line.startsWith('RGB/'))) {
        const [id, r, g, b, extra] = values(line);
        require(extra === undefined &&
            Number.isInteger(id) &&
            id >= 1 &&
            id <= 127 &&
            !palette.has(id) &&
            [r, g, b].every(
                (value) => Number.isInteger(value) && value >= 0 && value <= 255,
            ), 'KAP RGB palette is invalid.');
        palette.set(id, [r, g, b, 255]);
    }
    let at = end + 2;
    const depth = bytes[at++],
        ifm = one('IFM', true);
    require(depth >= 1 &&
        depth <= 7 &&
        (!ifm || Number(ifm.slice(4)) === depth) &&
        palette.size > 0, 'KAP palette depth is unsupported or inconsistent.');
    const indices = new Uint8Array(width * height),
        rowStarts: number[] = [];
    const number = (first: number) => {
        let value = first & 127,
            next = first,
            count = 1;
        while (next & 128) {
            require(at < bytes.length && count++ < 4, 'KAP row number is truncated or oversized.');
            next = bytes[at++];
            value = value * 128 + (next & 127);
        }
        return value;
    };
    for (let row = 0; row < height; row++) {
        check();
        rowStarts.push(at);
        require(at < bytes.length && number(bytes[at++]) === row + 1, 'KAP rows are missing or out of order.');
        let column = 0;
        while (true) {
            require(at < bytes.length, 'KAP pixel row is truncated.');
            let next = bytes[at++];
            if (next === 0) break;
            const index = (next & 127) >> (7 - depth);
            let run = next & ((1 << (7 - depth)) - 1),
                count = 1;
            while (next & 128) {
                require(at < bytes.length && count++ < 4, 'KAP pixel run is truncated or oversized.');
                next = bytes[at++];
                run = run * 128 + (next & 127);
            }
            run++;
            require(column + run <= width &&
                (index === 0 || palette.has(index)), 'KAP pixel run overruns the row or references an unknown colour.');
            indices.fill(index, row * width + column, row * width + column + run);
            column += run;
        }
        require(column === width, 'KAP row is incomplete; missing pixels are never filled with sea.');
    }
    if (at !== bytes.length) {
        const table = at;
        require(bytes.length - table === (height + 1) * 4, 'KAP has unsupported trailing image/index data.');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        require(rowStarts.every((offset, row) => view.getUint32(table + row * 4, false) === offset) &&
            view.getUint32(bytes.length - 4, false) ===
                table, 'KAP original row index disagrees with its decoded rows.');
    }
    const inside = (lon: number, lat: number) => {
        if (polygon.length === 0) return true;
        let result = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const a = polygon[i],
                b = polygon[j];
            if (a[1] > lat !== b[1] > lat && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0])
                result = !result;
        }
        return result;
    };
    const rgba = new Uint8Array(width * height * 4),
        north = webMercator(bounds[3]),
        south = webMercator(bounds[1]);
    for (let row = 0; row < height; row++) {
        check();
        const lat = inverseWebMercator(north + ((south - north) * (row + 0.5)) / height);
        const originalY = Math.floor((wgs84Mercator(lat) - y.origin) / y.scale);
        require(originalY >= 0 && originalY < height, 'KAP Mercator sample is outside its original image.');
        for (let column = 0; column < width; column++) {
            const index = indices[originalY * width + column],
                colour = palette.get(index);
            if (colour && inside(x.origin + x.scale * (column + 0.5), lat))
                rgba.set(colour, (row * width + column) * 4);
        }
    }
    return {
        width,
        height,
        rgba,
        bounds,
        datum: 'WGS84',
        sourceProjection: 'WGS84 Mercator',
        note: `Original KAP sounding datum: ${(parameters.SD || 'not supplied').slice(0, 120)}. No vertical conversion; chart currency and depths are unverified.`,
    };
}
