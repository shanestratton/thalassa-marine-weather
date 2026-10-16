// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    normaliseProviderCurrentWindow,
    providerCurrentTimes,
    type ProviderComponent,
    type ProviderCurrentWindow,
} from '../tools/currents138/providerWindow';
import { createCurrentSeriesSampler } from '../services/weather/currentSeries';

const at = Date.UTC(2026, 9, 16, 12);
const hour = 3600000;
function component(tide = false): ProviderComponent {
    return {
        timeValues: new Float64Array([0, 1]),
        timeUnits: 'hours since 2026-10-16 12:00:00',
        calendar: 'standard',
        east: {
            name: tide ? 'utide' : 'uo',
            standardName: tide ? 'surface_sea_water_x_velocity_due_to_tide' : 'eastward_sea_water_velocity',
            longName: 'Eastward tide-induced velocity',
            units: 'm s-1',
            values: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]),
            fillValues: [-9999],
        },
        north: {
            name: tide ? 'vtide' : 'vo',
            standardName: tide ? 'surface_sea_water_y_velocity_due_to_tide' : 'northward_sea_water_velocity',
            longName: 'Northward tide-induced velocity',
            units: 'm/s',
            values: new Float64Array([-1, -2, -3, -4, -5, -6, -7, -8]),
            fillValues: [-9999],
        },
    };
}
function source(): ProviderCurrentWindow {
    return {
        model: 'CMEMS',
        dataset: 'fixture-generated',
        sourceSha256: 'a'.repeat(64),
        regionId: 't-45-90',
        runMs: at,
        expiresMs: at + 4 * hour,
        depthM: 0.494,
        crs: 'EPSG:4326',
        gridLayout: 'rectilinear',
        latitudes: new Float64Array([0, 2]),
        longitudes: new Float64Array([0, 2]),
        ocean: component(),
    };
}

describe('bounded provider-window normalizer', () => {
    it('preserves actual source identity and reverses south-to-north rows without changing vectors', () => {
        const input = source(),
            result = normaliseProviderCurrentWindow(input);
        expect(result.dataset).toBe('fixture-generated');
        expect(result.sourceSha256).toBe(input.sourceSha256);
        expect(result.runMs).toBe(at);
        expect(result.depthM).toBe(0.494);
        expect(Array.from(result.tiles[0].ocean.u[0])).toEqual([3, 4, 1, 2]);
        expect(Array.from(result.tiles[0].ocean.v[1])).toEqual([-7, -8, -5, -6]);
        expect(createCurrentSeriesSampler(result)(0, 0, at)?.u).toBe(1);
        expect(createCurrentSeriesSampler(result)(2, 2, at + hour)?.v).toBe(-8);
    });
    it('converts actual CF offsets from 1950 and 1900 epochs with no implicit sample-index clock', () => {
        const input = component();
        input.timeUnits = 'hours since 1950-01-01 00:00:00 UTC';
        input.timeValues = new Float64Array([
            (at - Date.UTC(1950, 0, 1)) / hour,
            (at - Date.UTC(1950, 0, 1)) / hour + 1,
        ]);
        expect(providerCurrentTimes(input)).toEqual([at, at + hour]);
        input.timeUnits = 'days since 1900-12-31 00:00:00Z';
        input.timeValues = new Float64Array([
            (at - Date.UTC(1900, 11, 31)) / 86400000,
            (at - Date.UTC(1900, 11, 31)) / 86400000 + 1 / 24,
        ]);
        expect(providerCurrentTimes(input)).toEqual([at, at + hour]);
        input.timeUnits = 'seconds since 2026-10-16 12:00:00Z';
        input.timeValues = new Float64Array([0, 3600]);
        expect(providerCurrentTimes(input)).toEqual([at, at + hour]);
    });
    it.each([
        ['360_day', 'hours since 2026-10-16 12:00:00'],
        ['standard', 'hours since 1500-01-01 00:00:00'],
        ['standard', 'hours since 2026-02-30 00:00:00'],
        ['standard', 'hours since 2026-10-16 12:00:00+03:00'],
        ['standard', 'months since 2026-10-16 12:00:00'],
    ])('refuses unsupported or invalid time metadata (%s, %s)', (calendar, timeUnits) => {
        expect(() => providerCurrentTimes({ ...component(), calendar, timeUnits })).toThrow(/calendar|reference|units/);
    });
    it('refuses time holes, unrepresented milliseconds and oversized backing views', () => {
        const input = source();
        input.ocean.timeValues = new Float64Array([0, 2]);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/time axis/);
        input.ocean.timeValues = new Float64Array([0, 0.0000001]);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/nonintegral UTC/);
        input.ocean.timeValues = new Float64Array(new ArrayBuffer(32), 8, 2);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/backing buffer/);
    });
    it('reverses descending columns and splits equivalent 0–360 degrees into a fixed dateline tile', () => {
        const input = source();
        input.regionId = 't-45-0';
        input.longitudes = new Float64Array([182, 180]);
        const result = normaliseProviderCurrentWindow(input),
            tile = result.tiles[0];
        expect([tile.west, tile.east]).toEqual([-180, -178]);
        expect(Array.from(tile.ocean.u[0])).toEqual([4, 3, 2, 1]);
        expect(createCurrentSeriesSampler(result)(0, 180, at)?.u).toBe(2);
        input.regionId = 't-45-179';
        input.longitudes = new Float64Array([178, 180]);
        expect(normaliseProviderCurrentWindow(input).tiles[0].east).toBe(180);
    });
    it('rejects invalid longitude conventions and incomplete or irregular grids', () => {
        const input = source();
        input.longitudes = new Float64Array([1080, 1082]);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/longitude convention/);
        input.longitudes = new Float64Array([0.5, 2]);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/incomplete source coverage/);
        input.longitudes = new Float64Array([0, 1, 2.1]);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/nonregular/);
        input.longitudes = new Float64Array([0, 2]);
        input.latitudes = new Float64Array([0, NaN]);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/coordinate direction/);
    });
    it('preserves zero as known while NaN, fill values and explicit missing masks stay unknown', () => {
        const input = source();
        input.ocean.east.values[0] = 0;
        input.ocean.north.values[0] = 0;
        input.ocean.east.values[1] = -9999;
        input.ocean.north.values[2] = NaN;
        input.ocean.known = new Uint8Array([1, 1, 1, 0, 1, 1, 1, 1]);
        const series = normaliseProviderCurrentWindow(input),
            sample = createCurrentSeriesSampler(series);
        expect(sample(0, 0, at)).toMatchObject({ u: 0, v: 0 });
        for (const [lat, lon] of [
            [0, 2],
            [2, 0],
            [2, 2],
        ])
            expect(sample(lat, lon, at)).toBeNull();
        expect(sample(0, 2, at + hour)?.u).toBe(6);
        expect(Number.isNaN(series.tiles[0].ocean.u[0][0])).toBe(true);
    });
    it('refuses infinities, unbounded velocity, malformed masks, units and component identities', () => {
        for (const value of [Infinity, -Infinity, 21]) {
            const input = source();
            input.ocean.east.values[0] = value;
            expect(() => normaliseProviderCurrentWindow(input)).toThrow(/infinite|outside source contract/);
        }
        const input = source();
        input.ocean.known = new Uint8Array(8).fill(2);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/known mask/);
        delete input.ocean.known;
        input.ocean.east.units = 'knots';
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/units/);
        input.ocean.east.units = 'm/s';
        input.ocean.east.name = 'utotal';
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/basis/);
    });
    it('keeps independently timed tide coverage separate and requires documented tide directions', () => {
        const input = source();
        input.tide = component(true);
        input.tide.timeValues = new Float64Array([1, 2]);
        const series = normaliseProviderCurrentWindow(input);
        expect(series.tiles[0].tide?.times).toEqual([at + hour, at + 2 * hour]);
        expect(createCurrentSeriesSampler(series, 'ocean+tide')(0, 0, at)).toBeNull();
        expect(createCurrentSeriesSampler(series, 'ocean+tide')(0, 0, at + hour)).toMatchObject({ u: 6, v: -6 });
        input.tide.east.longName = 'grid-x tide velocity';
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/tidal direction/);
    });
    it('accepts only independently verified rectilinear east/north RTOFS subsets with actual three-hour times', () => {
        const input = source();
        input.model = 'RTOFS';
        input.ocean.east.name = 'u_velocity';
        input.ocean.north.name = 'v_velocity';
        input.ocean.timeValues = new Float64Array([0, 3]);
        const series = normaliseProviderCurrentWindow(input);
        expect(series.tiles[0].ocean.times).toEqual([at, at + 3 * hour]);
        input.ocean.east.standardName = 'sea_water_x_velocity';
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/basis/);
        input.ocean.east.standardName = 'eastward_sea_water_velocity';
        input.gridLayout = 'curvilinear';
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/curvilinear/);
        input.gridLayout = 'rectilinear';
        input.crs = 'EPSG:3413';
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/projection/);
    });
    it('rejects cross-provider tide, dimension mismatches and aggregate decoded windows above the existing cap', () => {
        const input = source();
        input.model = 'RTOFS';
        input.tide = component(true);
        input.ocean.east.name = 'u_velocity';
        input.ocean.north.name = 'v_velocity';
        input.ocean.timeValues = new Float64Array([0, 3]);
        expect(() => normaliseProviderCurrentWindow(input)).toThrow(/tidal provider/);
        const short = source();
        short.ocean.east.values = new Float32Array(1);
        expect(() => normaliseProviderCurrentWindow(short)).toThrow(/dimensions/);
        const large = source();
        large.expiresMs = at + 120 * hour;
        large.latitudes = new Float64Array(Array.from({ length: 64 }, (_, i) => (2 * i) / 63));
        large.longitudes = new Float64Array(Array.from({ length: 64 }, (_, i) => (2 * i) / 63));
        const cells = 64 * 64,
            steps = 121;
        large.ocean.timeValues = new Float64Array(Array.from({ length: steps }, (_, i) => i));
        large.ocean.east.values = new Float32Array(cells * steps).fill(1);
        large.ocean.north.values = new Float32Array(cells * steps).fill(1);
        large.tide = { ...component(true), timeValues: large.ocean.timeValues };
        large.tide.east.values = large.ocean.east.values;
        large.tide.north.values = large.ocean.north.values;
        expect(() => normaliseProviderCurrentWindow(large)).toThrow(/decoded window cap/);
    });
});
