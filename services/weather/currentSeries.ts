/** Public forecast vectors. A missing/masked sample is unknown, never a calm current. */
export const CURRENT_SERIES_MAX_BYTES = 8 * 1024 * 1024;
export const CURRENT_SERIES_MAX_TILES = 8;
export const CURRENT_SERIES_MAX_CELLS = 4096;
export const CURRENT_SERIES_MAX_STEPS = 121;
const HOUR_MS = 3_600_000;

export type CurrentModel = 'CMEMS' | 'RTOFS';
export type CurrentComponents = 'ocean' | 'ocean+tide';
export interface CurrentBounds {
    north: number;
    south: number;
    west: number;
    east: number;
}
export interface CurrentPlanes {
    /** Actual UTC sample instants; index is never assumed to be forecast hour. */
    times: number[];
    cadenceHours: 1 | 3;
    u: Float32Array[];
    v: Float32Array[];
    /** One means both components are known; zero includes land and missing data. */
    known: Uint8Array[];
}
export interface CurrentSeriesTile extends CurrentBounds {
    id: string;
    sourceSha256: string;
    width: number;
    height: number;
    /** North-to-south rows, west-to-east columns, geographic degrees. */
    ocean: CurrentPlanes;
    tide?: CurrentPlanes;
}
export interface CurrentSeries {
    schema: 1;
    model: CurrentModel;
    dataset: string;
    generation: string;
    sourceSha256: string;
    runMs: number;
    expiresMs: number;
    units: 'm/s';
    vectorBasis: 'true-east-north';
    depthM: number;
    tiles: CurrentSeriesTile[];
}
export interface CurrentSample {
    u: number;
    v: number;
    model: CurrentModel;
    generation: string;
    components: CurrentComponents;
    runMs: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clock = (n: unknown): n is number => finite(n) && Number.isSafeInteger(n) && n >= 946_684_800_000;
const text = (n: unknown): n is string => typeof n === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(n);
const assert = (value: unknown, message: string): void => {
    if (!value) throw new Error(`Current series: ${message}`);
};

export function validCurrentBounds(bounds: CurrentBounds): boolean {
    return (
        !!bounds &&
        [bounds.north, bounds.south, bounds.west, bounds.east].every(finite) &&
        bounds.north <= 90 &&
        bounds.south >= -90 &&
        bounds.north > bounds.south &&
        bounds.west >= -180 &&
        bounds.east <= 180 &&
        bounds.east > bounds.west
    );
}

/** Validate before sampling or cloning; unknown cells may be NaN but never infinite. */
export function validateCurrentSeries(series: CurrentSeries): number {
    assert(series?.schema === 1 && ['CMEMS', 'RTOFS'].includes(series.model), 'model/schema');
    assert(text(series.dataset) && text(series.generation), 'identity');
    assert(typeof series.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(series.sourceSha256), 'source hash');
    assert(clock(series.runMs) && clock(series.expiresMs) && series.expiresMs > series.runMs, 'source clock');
    assert(series.expiresMs - series.runMs <= 6 * 24 * HOUR_MS, 'source expiry horizon');
    assert(series.units === 'm/s' && series.vectorBasis === 'true-east-north', 'unverified units/vector basis');
    assert(finite(series.depthM) && series.depthM >= 0 && series.depthM <= 10, 'surface depth');
    assert(
        Array.isArray(series.tiles) && series.tiles.length > 0 && series.tiles.length <= CURRENT_SERIES_MAX_TILES,
        'tiles',
    );
    const ids = new Set<string>();
    let bytes = 0;
    for (const tile of series.tiles) {
        assert(text(tile?.id) && !ids.has(tile.id), 'duplicate/invalid tile identity');
        assert(typeof tile.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(tile.sourceSha256), 'tile source hash');
        ids.add(tile.id);
        assert(validCurrentBounds(tile), 'bounds');
        const cells = tile.width * tile.height;
        assert(
            Number.isInteger(tile.width) &&
                Number.isInteger(tile.height) &&
                tile.width >= 2 &&
                tile.height >= 2 &&
                cells <= CURRENT_SERIES_MAX_CELLS,
            'dimensions',
        );
        for (const [component, planes] of [
            ['ocean', tile.ocean],
            ['tide', tile.tide],
        ] as const) {
            if (!planes) {
                assert(component === 'tide', 'missing ocean');
                continue;
            }
            assert(component !== 'tide' || series.model === 'CMEMS', 'unverified tidal model');
            const { times, u, v, known } = planes;
            assert(planes.cadenceHours === (series.model === 'CMEMS' ? 1 : 3), 'provider cadence');
            assert(Array.isArray(times) && times.length >= 2 && times.length <= CURRENT_SERIES_MAX_STEPS, 'time count');
            assert(
                times.every(
                    (at, index) =>
                        clock(at) &&
                        at >= series.runMs &&
                        (!index || at - times[index - 1] === planes.cadenceHours * HOUR_MS),
                ) &&
                    times[times.length - 1] - times[0] <= (component === 'tide' ? 72 : 120) * HOUR_MS &&
                    times[times.length - 1] <= series.expiresMs,
                'time axis',
            );
            assert(
                [u, v, known].every((frames) => Array.isArray(frames) && frames.length === times.length),
                'plane count',
            );
            for (let step = 0; step < times.length; step++) {
                assert(
                    u[step] instanceof Float32Array &&
                        v[step] instanceof Float32Array &&
                        known[step] instanceof Uint8Array &&
                        [u[step], v[step], known[step]].every((plane) => plane.length === cells),
                    'plane dimensions',
                );
                // Require exact backing lengths: a tiny view cannot smuggle a large cloned buffer.
                for (const plane of [u[step], v[step], known[step]]) {
                    assert(
                        plane.byteOffset === 0 && plane.buffer.byteLength === plane.byteLength,
                        'oversized backing buffer',
                    );
                    bytes += plane.byteLength;
                    assert(bytes <= CURRENT_SERIES_MAX_BYTES, 'decoded memory cap');
                }
                for (let cell = 0; cell < cells; cell++) {
                    const mask = known[step][cell];
                    assert(mask === 0 || mask === 1, 'known mask');
                    const values = [u[step][cell], v[step][cell]];
                    assert(
                        values.every((n) => Number.isNaN(n) || (finite(n) && Math.abs(n) <= 20)),
                        'velocity',
                    );
                    assert(mask === 0 || values.every(finite), 'known nonfinite velocity');
                }
            }
        }
    }
    return bytes;
}

function samplePlanes(tile: CurrentSeriesTile, planes: CurrentPlanes, lat: number, lon: number, at: number) {
    const times = planes.times;
    if (at < times[0] || at > times[times.length - 1]) return null;
    let lower = 0,
        upper = times.length - 1;
    while (upper - lower > 1) {
        const mid = (lower + upper) >> 1;
        if (times[mid] <= at) lower = mid;
        else upper = mid;
    }
    const fraction = (at - times[lower]) / (times[upper] - times[lower]);
    const row = ((tile.north - lat) / (tile.north - tile.south)) * (tile.height - 1);
    const col = ((lon - tile.west) / (tile.east - tile.west)) * (tile.width - 1);
    const r = Math.floor(row),
        c = Math.floor(col),
        fy = row - r,
        fx = col - c;
    const corners = [
        [r * tile.width + c, (1 - fy) * (1 - fx)],
        [r * tile.width + Math.min(c + 1, tile.width - 1), (1 - fy) * fx],
        [Math.min(r + 1, tile.height - 1) * tile.width + c, fy * (1 - fx)],
        [Math.min(r + 1, tile.height - 1) * tile.width + Math.min(c + 1, tile.width - 1), fy * fx],
    ];
    let u = 0,
        v = 0;
    for (const [step, temporalWeight] of [
        [lower, 1 - fraction],
        [upper, fraction],
    ]) {
        if (temporalWeight === 0) continue;
        for (const [index, spatialWeight] of corners) {
            const weight = temporalWeight * spatialWeight;
            if (weight === 0) continue;
            if (planes.known[step][index] !== 1) return null;
            const east = planes.u[step][index],
                north = planes.v[step][index];
            if (!finite(east) || !finite(north)) return null;
            u += east * weight;
            v += north * weight;
        }
    }
    return { u, v };
}

/** Construct once at the trust boundary, not inside the routing node loop. */
export function createCurrentSeriesSampler(series: CurrentSeries, components: CurrentComponents = 'ocean') {
    validateCurrentSeries(series);
    return (lat: number, lon: number, at: number): CurrentSample | null => {
        if (![lat, lon, at].every(finite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        for (const tile of series.tiles) {
            // +180 and -180 describe the same meridian. Each half still needs its own verified tile.
            const x = lon === 180 && tile.west === -180 ? -180 : lon === -180 && tile.east === 180 ? 180 : lon;
            if (lat < tile.south || lat > tile.north || x < tile.west || x > tile.east) continue;
            const ocean = samplePlanes(tile, tile.ocean, lat, x, at);
            if (!ocean) continue;
            const tide = components === 'ocean+tide' && tile.tide ? samplePlanes(tile, tile.tide, lat, x, at) : null;
            if (components === 'ocean+tide' && !tide) continue;
            return {
                u: ocean.u + (tide?.u ?? 0),
                v: ocean.v + (tide?.v ?? 0),
                model: series.model,
                generation: series.generation,
                components,
                runMs: series.runMs,
            };
        }
        return null;
    };
}

/** A request crossing180 is two ordinary bboxes, never a nearly-global download. */
export function splitCurrentBounds(bounds: CurrentBounds): CurrentBounds[] | null {
    if (
        !bounds ||
        ![bounds.north, bounds.south, bounds.west, bounds.east].every(finite) ||
        bounds.north > 90 ||
        bounds.south < -90 ||
        bounds.north <= bounds.south ||
        Math.abs(bounds.west) > 180 ||
        Math.abs(bounds.east) > 180 ||
        bounds.east === bounds.west
    )
        return null;
    if (bounds.east > bounds.west) return [{ ...bounds }];
    return [
        ...(bounds.west < 180 ? [{ ...bounds, east: 180 }] : []),
        ...(bounds.east > -180 ? [{ ...bounds, west: -180 }] : []),
    ];
}
