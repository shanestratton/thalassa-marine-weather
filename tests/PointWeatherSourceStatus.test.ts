import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchProxy } = vi.hoisted(() => ({ fetchProxy: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: fetchProxy }));

import { clearPointWeatherCache, fetchPointWeather } from '../services/weather/pointWeather';
import { clearSeaPartitionsCache } from '../services/weather/seaPartitions';

const atmospheric = {
    current: {
        temperature_2m: 24,
        relative_humidity_2m: 70,
        wind_speed_10m: 18,
        wind_direction_10m: 90,
        wind_gusts_10m: 25,
        pressure_msl: 1012,
        cloud_cover: 20,
    },
};

/**
 * One MFWAM + GFS Wave hour at the cell (lat, lon), as proxy-openmeteo answers
 * a two-model hourly call (130-04): suffixed keys, unix seconds. Off Cascais,
 * Portugal: the cell 2.4 km from the tap, inside the snap guard (6.1 km at 38.7°N).
 */
function seaReply(hM: number | null, cellLat = 38.708336, cellLon = -9.625) {
    const hour = Math.floor(Date.now() / 3_600_000) * 3600;
    return {
        latitude: cellLat,
        longitude: cellLon,
        hourly_units: { time: 'unixtime', wave_height_meteofrance_wave: 'm' },
        hourly: {
            time: [hour],
            wave_height_meteofrance_wave: [hM],
            wave_period_meteofrance_wave: [hM === null ? null : 9],
            wave_direction_meteofrance_wave: [hM === null ? null : 300],
            swell_wave_height_meteofrance_wave: [hM === null ? null : hM * 0.8],
            wave_height_ncep_gfswave025: [1.3],
        },
    };
}
const LAT = 38.7;
const LON = -9.6;

describe('point-weather source status', () => {
    beforeEach(() => {
        fetchProxy.mockReset();
        // fetchPointWeather caches by rounded coordinate as of 2026-09-05, so
        // without this the second test in this file would be served the first
        // one's answer and prove nothing. The sea's own cell cache (the tap's
        // 1/12° cell, 1 h) likewise.
        clearPointWeatherCache();
        clearSeaPartitionsCache();
    });

    it('maps a rejected marine provider to an explicit partial-source state', async () => {
        // BEHAVIOURAL, not a string match. This used to assert the literal
        // `marine.status === 'rejected' ? 'unavailable'`, which broke the
        // moment the implementation stopped using Promise.allSettled — while
        // the behaviour it cared about was unchanged. The three states are the
        // contract; how they are computed is not.
        fetchProxy.mockImplementation((operation: string) =>
            operation === 'forecast' ? Promise.resolve(atmospheric) : Promise.reject(new Error('marine down')),
        );

        await expect(fetchPointWeather(LAT, LON)).resolves.toMatchObject({
            marineStatus: 'unavailable',
            sea: null,
        });
    });

    it('reports the atmospherics before the sea has answered', async () => {
        // The bubble paints from this partial rather than holding a complete
        // answer behind the slower request (Shane 2026-09-05: "i would like it
        // to be quicker"). A marine block that has not answered must read
        // 'pending' — never 'land', which is a different fact.
        let releaseMarine: (value: unknown) => void = () => {};
        fetchProxy.mockImplementation((operation: string) =>
            operation === 'forecast'
                ? Promise.resolve(atmospheric)
                : new Promise((resolve) => {
                      releaseMarine = resolve;
                  }),
        );

        const partials: string[] = [];
        const pending = fetchPointWeather(LAT, LON, (partial) => partials.push(partial.marineStatus));

        await vi.waitFor(() => expect(partials).toEqual(['pending']));
        releaseMarine(seaReply(1.2));
        await expect(pending).resolves.toMatchObject({ marineStatus: 'available', sea: { total: { hM: 1.2 } } });
    });

    it('serves a second tap on the same cell without touching the network', async () => {
        fetchProxy.mockImplementation((operation: string) =>
            Promise.resolve(operation === 'forecast' ? atmospheric : seaReply(1.1)),
        );

        await fetchPointWeather(LAT, LON);
        const callsAfterFirst = fetchProxy.mock.calls.length;
        // Same cell to two decimals — the same question.
        await fetchPointWeather(38.702, -9.598);
        expect(fetchProxy.mock.calls.length).toBe(callsAfterFirst);
    });

    it('distinguishes water no wave model reaches from a provider failure (and never calls it land)', async () => {
        // A cell that answered nulls, and one 17 km out (refused by the guard):
        // both are 'sheltered', a different fact from 'unavailable'.
        fetchProxy.mockImplementation((operation: string) =>
            Promise.resolve(operation === 'forecast' ? atmospheric : seaReply(null)),
        );
        await expect(fetchPointWeather(LAT, LON)).resolves.toMatchObject({ marineStatus: 'sheltered', sea: null });

        clearPointWeatherCache();
        clearSeaPartitionsCache();
        fetchProxy.mockImplementation((operation: string) =>
            Promise.resolve(operation === 'forecast' ? atmospheric : seaReply(1.4, 38.708336, -9.791664)),
        );
        await expect(fetchPointWeather(LAT, LON)).resolves.toMatchObject({ marineStatus: 'sheltered', sea: null });
    });

    it('a malformed marine reply is a failure, not a shelter', async () => {
        fetchProxy.mockImplementation((operation: string) =>
            Promise.resolve(operation === 'forecast' ? atmospheric : { current: { wave_height: 1.1 } }),
        );
        await expect(fetchPointWeather(LAT, LON)).resolves.toMatchObject({ marineStatus: 'unavailable', sea: null });
    });

    it('a second tap is never refused on the first tap’s reply: it asks for its own point', async () => {
        // Off Cascais, a headland's 1/12° cell (38.667-38.75°N, 9.5-9.417°W)
        // that MFWAM has dry, both taps in it and in one old 0.05° bucket. The
        // first tap's reply is the wet cell east of it, 4.8 km off. The second,
        // further west, is 8.5 km from that cell (the bound is 6.1 km at 38.7°N)
        // but 6.0 km from the wet cell west of it, which its own reply names.
        fetchProxy.mockImplementation((operation: string, params: { longitude: string }) =>
            Promise.resolve(
                operation === 'forecast'
                    ? atmospheric
                    : params.longitude === '-9.4300'
                      ? seaReply(1.4, 38.708336, -9.375)
                      : seaReply(1.1, 38.708336, -9.541664),
            ),
        );
        await expect(fetchPointWeather(38.7083, -9.43)).resolves.toMatchObject({
            marineStatus: 'available',
            sea: { total: { hM: 1.4 } },
        });
        await expect(fetchPointWeather(38.7083, -9.473)).resolves.toMatchObject({
            marineStatus: 'available',
            sea: { total: { hM: 1.1 } },
        });
        expect(fetchProxy.mock.calls.filter(([op]) => op === 'marine')).toHaveLength(2);
    });
});
