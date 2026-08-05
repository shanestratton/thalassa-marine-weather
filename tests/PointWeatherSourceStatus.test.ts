import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchProxy } = vi.hoisted(() => ({ fetchProxy: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: fetchProxy }));

import { fetchPointWeather } from '../services/weather/pointWeather';

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
    beforeEach(() => fetchProxy.mockReset());

    it('maps a rejected marine provider to an explicit partial-source state', () => {
        const source = readFileSync('services/weather/pointWeather.ts', 'utf8');
        expect(source).toContain("marine.status === 'rejected' ? 'unavailable'");
        expect(source).toContain("marineStatus: 'available' | 'land' | 'unavailable'");
    });

    it('distinguishes a valid land response from a provider failure', async () => {
        fetchProxy.mockImplementation((operation: string) =>
            Promise.resolve(operation === 'forecast' ? atmospheric : { current: { wave_height: null } }),
        );

        await expect(fetchPointWeather(-27.47, 153.02)).resolves.toMatchObject({ marineStatus: 'land' });
    });
});
