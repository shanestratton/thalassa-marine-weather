import { AROME_DOMAINS } from '../../services/weather/aromeDomains';
import { AROME_HOURLY_UNITS } from '../../services/weather/aromePointContract';

export const AROME_TEST_RUN = Date.UTC(2026, 9, 17);
export const AROME_TEST_POINT = { lat: -20, lon: 166 };
export const AROME_TEST_MODEL = AROME_DOMAINS[0].id;

/** Fictional values on the real documented grid; no observed/native proof. */
export function aromePointFixture() {
    return {
        schema: 1,
        model: AROME_TEST_MODEL,
        provider: 'Météo-France',
        product: 'AROME-OM',
        licence: 'Etalab-2.0',
        runUtc: '2026-10-17T00:00:00Z',
        cohortSha256: 'a'.repeat(64),
        maskSha256: 'b'.repeat(64),
        seaCell: {
            latitude: -20,
            longitude: 166,
            i: 400,
            j: 400,
            landFraction: 0,
            method: 'nearest-original-sea-cell',
        },
        hourly_units: { ...AROME_HOURLY_UNITS },
        hourly: {
            time: Array.from({ length: 49 }, (_, index) => AROME_TEST_RUN / 1000 + index * 3600),
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
