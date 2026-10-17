import {
    validateCurrentSeries,
    type CurrentSeries,
    type CurrentModel,
    type CurrentPlanes,
} from '../../services/weather/currentSeries';
import { currentRegionBounds } from '../../services/weather/api/currentRegionalContract';

type NumericPlane = Float32Array | Float64Array;
export interface ProviderVector {
    name: string;
    standardName: string;
    longName?: string;
    units: string;
    values: NumericPlane;
    fillValues: number[];
}
export interface ProviderComponent {
    timeValues: Float64Array;
    timeUnits: string;
    calendar: string;
    east: ProviderVector;
    north: ProviderVector;
    known?: Uint8Array;
}
export interface ProviderCurrentWindow {
    model: CurrentModel;
    dataset: string;
    sourceSha256: string;
    regionId: string;
    runMs: number;
    expiresMs: number;
    depthM: number;
    crs: string;
    gridLayout: string;
    latitudes: NumericPlane;
    longitudes: NumericPlane;
    ocean: ProviderComponent;
    tide?: ProviderComponent;
}
const assert = (value: unknown, label: string): void => {
    if (!value) throw new Error('Current provider window: ' + label);
};
const bytes = (plane: NumericPlane | Uint8Array): void =>
    assert(plane.byteOffset === 0 && plane.buffer.byteLength === plane.byteLength, 'oversized backing buffer');

/** CF standard/gregorian UTC only. Never interpret a missing run or a model index as a valid time. */
export function providerCurrentTimes(input: ProviderComponent): number[] {
    assert(['standard', 'gregorian', 'proleptic_gregorian'].includes(input.calendar), 'unsupported calendar');
    const match = /^(hours|days|seconds) since (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:Z| UTC)?$/.exec(
        input.timeUnits,
    );
    assert(match, 'unsupported UTC time units');
    const parts = match!.slice(2).map(Number);
    // CF's standard calendar is mixed Julian/Gregorian before 1582. This bounded
    // adapter deliberately accepts only modern UTC epochs it can interpret exactly.
    assert(parts[0] >= 1583, 'unsupported pre-Gregorian reference');
    const reference = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    assert(
        new Date(reference).toISOString().slice(0, 19) ===
            match!.slice(2).slice(0, 3).join('-') + 'T' + match!.slice(5).join(':'),
        'invalid time reference',
    );
    assert(
        input.timeValues instanceof Float64Array && input.timeValues.length >= 2 && input.timeValues.length <= 121,
        'time shape',
    );
    bytes(input.timeValues);
    const multiplier = match![1] === 'hours' ? 3600000 : match![1] === 'days' ? 86400000 : 1000;
    return Array.from(input.timeValues, (offset) => {
        const actual = reference + offset * multiplier,
            rounded = Math.round(actual);
        assert(
            Number.isFinite(actual) && Number.isSafeInteger(rounded) && Math.abs(actual - rounded) <= 0.01,
            'nonintegral UTC milliseconds',
        );
        return rounded;
    });
}

/** Bounded rectilinear source windows only; native curvilinear RTOFS is intentionally unsupported. */
export function normaliseProviderCurrentWindow(input: ProviderCurrentWindow): CurrentSeries {
    assert(input.crs === 'EPSG:4326' && input.gridLayout === 'rectilinear', 'unsupported projection/curvilinear grid');
    const region = currentRegionBounds(input.regionId);
    assert(region, 'fixed region identity');
    const lat = input.latitudes,
        rawLon = input.longitudes;
    assert(
        [lat, rawLon].every(
            (axis) =>
                (axis instanceof Float32Array || axis instanceof Float64Array) && axis.length >= 2 && axis.length <= 64,
        ),
        'coordinate dimensions',
    );
    bytes(lat);
    bytes(rawLon);
    assert(
        Array.from(rawLon).every((value) => Number.isFinite(value) && value >= -180 && value <= 360),
        'longitude convention',
    );
    const center = (region!.west + region!.east) / 2;
    const lon = Array.from(rawLon, (value) => center + ((value - center + 540) % 360) - 180);
    const axis = (values: ArrayLike<number>) => {
        const first = values[0],
            last = values[values.length - 1],
            step = (last - first) / (values.length - 1);
        assert(Number.isFinite(step) && step !== 0, 'coordinate direction');
        for (let i = 0; i < values.length; i++)
            assert(
                Number.isFinite(values[i]) && Math.abs(values[i] - (first + i * step)) <= 0.00002,
                'nonregular coordinate grid',
            );
        return { first, last, increasing: step > 0 };
    };
    const y = axis(lat),
        x = axis(lon),
        north = Math.max(y.first, y.last),
        south = Math.min(y.first, y.last),
        west = Math.min(x.first, x.last),
        east = Math.max(x.first, x.last);
    assert(north <= 90 && south >= -90 && west >= -180 && east <= 180, 'split dateline window before normalization');
    assert(
        north >= region!.north && south <= region!.south && west <= region!.west && east >= region!.east,
        'incomplete source coverage',
    );
    const cells = lat.length * rawLon.length;
    let decoded = 0;
    const component = (raw: ProviderComponent, tide: boolean): CurrentPlanes => {
        const times = providerCurrentTimes(raw),
            length = times.length * cells;
        decoded += length * 9;
        assert(decoded <= 8 * 1024 * 1024, 'decoded window cap');
        const expectedNames = tide
            ? ['utide', 'vtide']
            : input.model === 'CMEMS'
              ? ['uo', 'vo']
              : ['u_velocity', 'v_velocity'];
        if (tide) assert(input.model === 'CMEMS', 'unsupported tidal provider');
        for (const [index, vector] of [raw.east, raw.north].entries()) {
            const standard = tide
                ? ['surface_sea_water_x_velocity_due_to_tide', 'surface_sea_water_y_velocity_due_to_tide'][index]
                : ['eastward_sea_water_velocity', 'northward_sea_water_velocity'][index];
            assert(
                vector.name === expectedNames[index] && vector.standardName === standard,
                'unverified vector basis/component identity',
            );
            if (tide)
                assert(
                    vector.longName?.startsWith(
                        index === 0 ? 'Eastward tide-induced velocity' : 'Northward tide-induced velocity',
                    ),
                    'unverified tidal direction',
                );
            assert(['m/s', 'm s-1'].includes(vector.units), 'unsupported velocity units');
            assert(
                (vector.values instanceof Float32Array || vector.values instanceof Float64Array) &&
                    vector.values.length === length,
                'velocity dimensions',
            );
            bytes(vector.values);
            assert(
                Array.isArray(vector.fillValues) &&
                    vector.fillValues.length <= 4 &&
                    vector.fillValues.every(Number.isFinite),
                'fill metadata',
            );
        }
        if (raw.known) {
            assert(raw.known instanceof Uint8Array && raw.known.length === length, 'known mask dimensions');
            bytes(raw.known);
        }
        const u: Float32Array[] = [],
            v: Float32Array[] = [],
            known: Uint8Array[] = [];
        for (let t = 0; t < times.length; t++) {
            const a = new Float32Array(cells),
                b = new Float32Array(cells),
                mask = new Uint8Array(cells);
            for (let r = 0; r < lat.length; r++)
                for (let c = 0; c < rawLon.length; c++) {
                    const original =
                            t * cells +
                            (y.increasing ? lat.length - 1 - r : r) * rawLon.length +
                            (x.increasing ? c : rawLon.length - 1 - c),
                        target = r * rawLon.length + c;
                    const eastward = raw.east.values[original],
                        northward = raw.north.values[original],
                        marker = raw.known?.[original] ?? 1;
                    assert(marker === 0 || marker === 1, 'known mask');
                    assert(
                        ![eastward, northward].some((value) => !Number.isFinite(value) && !Number.isNaN(value)),
                        'infinite velocity',
                    );
                    const missing =
                        marker === 0 ||
                        Number.isNaN(eastward) ||
                        Number.isNaN(northward) ||
                        raw.east.fillValues.includes(eastward) ||
                        raw.north.fillValues.includes(northward);
                    if (missing) {
                        a[target] = NaN;
                        b[target] = NaN;
                        continue;
                    }
                    assert(Math.abs(eastward) <= 20 && Math.abs(northward) <= 20, 'velocity outside source contract');
                    a[target] = eastward;
                    b[target] = northward;
                    mask[target] = 1;
                }
            u.push(a);
            v.push(b);
            known.push(mask);
        }
        return { times, cadenceHours: input.model === 'CMEMS' ? 1 : 3, u, v, known };
    };
    const series: CurrentSeries = {
        schema: 1,
        model: input.model,
        dataset: input.dataset,
        generation: 'unpublished',
        sourceSha256: input.sourceSha256,
        runMs: input.runMs,
        expiresMs: input.expiresMs,
        units: 'm/s',
        vectorBasis: 'true-east-north',
        depthM: input.depthM,
        tiles: [
            {
                id: input.regionId,
                sourceSha256: input.sourceSha256,
                north,
                south,
                west,
                east,
                width: rawLon.length,
                height: lat.length,
                ocean: component(input.ocean, false),
                ...(input.tide ? { tide: component(input.tide, true) } : {}),
            },
        ],
    };
    validateCurrentSeries(series);
    return series;
}
