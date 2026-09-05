import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchProxy } = vi.hoisted(() => ({ fetchProxy: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: fetchProxy }));

import { clearPointWeatherCache, fetchPointWeather } from '../services/weather/pointWeather';

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

describe('point-weather source status', () => {
    beforeEach(() => {
        fetchProxy.mockReset();
        // fetchPointWeather caches by rounded coordinate as of 2026-09-05, so
        // without this the second test in this file would be served the first
        // one's answer and prove nothing.
        clearPointWeatherCache();
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

        await expect(fetchPointWeather(-27.47, 153.02)).resolves.toMatchObject({
            marineStatus: 'unavailable',
            waveHeightM: null,
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
        const pending = fetchPointWeather(-27.47, 153.02, (partial) => partials.push(partial.marineStatus));

        await vi.waitFor(() => expect(partials).toEqual(['pending']));
        releaseMarine({ current: { wave_height: 1.2, swell_wave_height: 0.8 } });
        await expect(pending).resolves.toMatchObject({ marineStatus: 'available' });
    });

    it('serves a second tap on the same cell without touching the network', async () => {
        fetchProxy.mockImplementation((operation: string) =>
            Promise.resolve(operation === 'forecast' ? atmospheric : { current: { wave_height: 1.1 } }),
        );

        await fetchPointWeather(-27.47, 153.02);
        const callsAfterFirst = fetchProxy.mock.calls.length;
        // Same cell to two decimals — the same question.
        await fetchPointWeather(-27.472, 153.018);
        expect(fetchProxy.mock.calls.length).toBe(callsAfterFirst);
    });

    it('distinguishes a valid land response from a provider failure', async () => {
        fetchProxy.mockImplementation((operation: string) =>
            Promise.resolve(operation === 'forecast' ? atmospheric : { current: { wave_height: null } }),
        );

        await expect(fetchPointWeather(-27.47, 153.02)).resolves.toMatchObject({ marineStatus: 'land' });
    });
});
