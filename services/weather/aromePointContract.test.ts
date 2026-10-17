import { describe, expect, it } from 'vitest';
import { AROME_DOMAINS } from './aromeDomains';
import { AROME_HOURLY_UNITS, parseAromePoint } from './aromePointContract';
import { regionalModelFor } from './regionalModels';

const run = Date.UTC(2026, 9, 17);
const point = { lat: -20, lon: 166 };
const model = AROME_DOMAINS[0].id;
function fixture() {
    return {
        schema: 1,
        model,
        provider: 'Météo-France',
        product: 'AROME-OM',
        licence: 'Etalab-2.0',
        runUtc: '2026-10-17T00:00:00Z',
        cohortSha256: 'a'.repeat(64),
        maskSha256: 'b'.repeat(64),
        seaCell: {
            latitude: -20,
            longitude: 166,
            i: 300,
            j: 240,
            landFraction: 0,
            method: 'nearest-original-sea-cell',
        },
        hourly_units: { ...AROME_HOURLY_UNITS },
        hourly: {
            time: Array.from({ length: 49 }, (_, index) => run / 1000 + index * 3600),
            wind_speed_10m: Array(49).fill(10),
            wind_direction_10m: Array(49).fill(90),
            wind_gusts_10m: Array(49).fill(null),
            pressure_msl: Array(49).fill(null),
            temperature_2m: Array(49).fill(null),
            relative_humidity_2m: Array(49).fill(null),
            precipitation: Array(49).fill(null),
        },
    };
}

describe('14206 original AROME-OM point admission', () => {
    it('binds only NCALED to the observed original grid and preserves both other domains', () => {
        expect(AROME_DOMAINS[0]).toMatchObject({
            region: [-26, -13.75, 158.5, 171.5],
            width: 521,
            height: 491,
        });
        expect(AROME_DOMAINS[0].width * AROME_DOMAINS[0].height).toBe(255811);
        expect(AROME_DOMAINS[1]).toMatchObject({
            region: [-25.25, -12.6, -157.5, -144.5],
            width: 521,
            height: 507,
        });
        expect(AROME_DOMAINS[2]).toMatchObject({
            region: [9.7, 22.9, -75.3, -51.7],
            width: 945,
            height: 529,
        });
    });

    it('refuses the old wider grid indices for the same physical point', () => {
        const data = fixture();
        expect(
            parseAromePoint({ ...data, seaCell: { ...data.seaCell, i: 400, j: 400 } }, model, point, run),
        ).toBeNull();
    });

    it('admits only an original current sea cell and preserves every original clock and gap', () => {
        const value = fixture();
        expect(parseAromePoint(value, model, point, run + 3600_000)).toBe(value);
        expect(value.hourly.time[48]).toBe(run / 1000 + 48 * 3600);
        expect(value.hourly.wind_gusts_10m).toEqual(Array(49).fill(null));
    });

    it('preserves genuine calm as zero wind with unknown direction', () => {
        const data = fixture();
        data.hourly.wind_speed_10m = Array(49).fill(0);
        data.hourly.wind_direction_10m = Array(49).fill(null);
        expect(parseAromePoint(data, model, point, run)).toBe(data);
    });

    it.each([
        ['New Caledonia', -22.3, 166.4, AROME_DOMAINS[0].id],
        ['Vanuatu', -17.73, 168.32, AROME_DOMAINS[0].id],
        ['French Polynesia', -17.5, -149.5, AROME_DOMAINS[1].id],
        ['Antilles', 14.6, -61.1, AROME_DOMAINS[2].id],
    ])('selects an own-source candidate for %s without claiming data are installed', (_name, lat, lon, id) => {
        const candidate = regionalModelFor(Number(lat), Number(lon));
        expect(candidate?.id).toBe(id);
        expect(candidate?.transport).toBe('wx-arome');
        expect(candidate?.resolutionKm).toBe(2.5);
        expect(candidate?.horizonHours).toBe(48);
    });

    it.each([
        ['provider', 'global'],
        ['product', 'IFS'],
        ['licence', 'unknown'],
        ['model', 'meteofrance_arome_france'],
        ['schema', 2],
        ['cohortSha256', 'missing'],
        ['maskSha256', '0'],
        ['runUtc', '2026-10-17T00:00:00'],
        ['runUtc', '2026-10-17T01:00:00Z'],
        ['runUtc', '2026-02-30T00:00:00Z'],
    ])('refuses wrong source fact %s=%s', (field, value) => {
        expect(parseAromePoint({ ...fixture(), [field]: value }, model, point, run)).toBeNull();
    });

    it.each([
        ['landFraction', 1],
        ['landFraction', 0.01],
        ['landFraction', null],
        ['method', 'nearest'],
        ['i', 401],
        ['j', 801],
        ['i', 521],
        ['j', 491],
        ['i', -1],
        ['i', 400.5],
        ['latitude', -20.001],
        ['longitude', Number.NaN],
    ])('refuses unqualified or mismatched sea cell %s=%s', (field, value) => {
        const data = fixture();
        expect(
            parseAromePoint({ ...data, seaCell: { ...data.seaCell, [field]: value } }, model, point, run),
        ).toBeNull();
    });

    it.each([
        ['wind_speed_10m', -1],
        ['wind_speed_10m', 201],
        ['wind_speed_10m', '10'],
        ['wind_direction_10m', Number.NaN],
        ['wind_direction_10m', 361],
        ['pressure_msl', 100_000],
        ['temperature_2m', 290],
        ['relative_humidity_2m', 101],
        ['precipitation', -1],
    ])('refuses invalid canonical value %s=%s', (variable, value) => {
        const data = fixture();
        expect(
            parseAromePoint(
                { ...data, hourly: { ...data.hourly, [variable]: Array(49).fill(value) } },
                model,
                point,
                run,
            ),
        ).toBeNull();
    });

    it('does not restamp an expired run, borrow a distant cell or fabricate a partial horizon', () => {
        const data = fixture();
        expect(parseAromePoint(data, model, point, run - 1)).toBeNull();
        expect(parseAromePoint(data, model, point, run + 18 * 3600_000)).toBe(data);
        expect(parseAromePoint(data, model, point, run + 18 * 3600_000 + 1)).toBeNull();
        expect(parseAromePoint(data, model, { lat: -20.1, lon: 166 }, run)).toBeNull();
        expect(parseAromePoint(data, model, { lat: -35, lon: 166 }, run)).toBeNull();
        expect(parseAromePoint(data, model, { lat: Number.NaN, lon: 166 }, run)).toBeNull();
        expect(
            parseAromePoint(
                { ...data, hourly: { ...data.hourly, time: data.hourly.time.slice(1) } },
                model,
                point,
                run,
            ),
        ).toBeNull();
        const times = [...data.hourly.time];
        times[2] = times[1];
        expect(parseAromePoint({ ...data, hourly: { ...data.hourly, time: times } }, model, point, run)).toBeNull();
        expect(
            parseAromePoint(
                { ...data, hourly_units: { ...data.hourly_units, wind_speed_10m: 'm/s' } },
                model,
                point,
                run,
            ),
        ).toBeNull();
        expect(
            parseAromePoint(
                { ...data, hourly: { ...data.hourly, wind_speed_10m: Array(49).fill(null) } },
                model,
                point,
                run,
            ),
        ).toBeNull();
    });
});
