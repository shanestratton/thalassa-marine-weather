import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchPressureGrid, generateIsobars } from '../services/weather/isobars';
import { pressureFrameValidAt } from '../services/weather/pressureProvenance';

const points = vi.hoisted(() => vi.fn());
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoPoints: points }));

const times = ['2026-09-20T02:00', '2026-09-20T03:00', '2026-09-20T04:00'];
const hourly = () => ({
    time: times,
    pressure_msl: [1012, 1014, 1016],
    wind_speed_10m: [10, 12, 14],
    wind_direction_10m: [90, 100, 110],
});
beforeEach(() => {
    points.mockImplementation((_operation, coords) => Promise.resolve(coords.map(() => ({ hourly: hourly() }))));
});

describe('pressure grid clock and fallback integrity', () => {
    it('uses the shared provider UTC axis rather than pretending fetch time is model time', async () => {
        const grid = await fetchPressureGrid(2, 0, 0, 2, 4);
        expect(grid?.refTime).toBe('2026-09-20T02:00:00.000Z');
        expect(grid && pressureFrameValidAt(grid, 2)).toBe(Date.parse('2026-09-20T04:00:00Z'));
        expect(points).toHaveBeenCalledWith(
            'forecast',
            expect.any(Array),
            expect.objectContaining({ timezone: 'UTC', models: 'ncep_gfs025' }),
        );
    });

    it('refuses missing, inconsistent or non-hourly clocks instead of drawing wrongly timed fields', async () => {
        for (const badTime of [
            undefined,
            ['2026-09-20T02:00', '2026-09-20T04:00', '2026-09-20T05:00'],
            ['not-time', ...times.slice(1)],
        ]) {
            points.mockImplementation((_operation, coords) =>
                Promise.resolve(coords.map(() => ({ hourly: { ...hourly(), time: badTime } }))),
            );
            expect(await fetchPressureGrid(2, 0, 0, 2, 4)).toBeNull();
        }
        points.mockImplementation((_operation, coords) =>
            Promise.resolve(
                coords.map((_p: unknown, i: number) => ({
                    hourly: { ...hourly(), time: i === 1 ? times.map((t) => t.replace('09-20', '09-21')) : times },
                })),
            ),
        );
        expect(await fetchPressureGrid(2, 0, 0, 2, 4)).toBeNull();
    });

    it('refuses missing/non-MSL-like pressure instead of filling fake values', async () => {
        points.mockImplementation((_operation, coords) =>
            Promise.resolve(coords.map(() => ({ hourly: { ...hourly(), pressure_msl: [1012, null, 1016] } }))),
        );
        expect(await fetchPressureGrid(2, 0, 0, 2, 4)).toBeNull();
        points.mockImplementation((_operation, coords) =>
            Promise.resolve(coords.map(() => ({ hourly: { ...hourly(), pressure_msl: [600, 610, 620] } }))),
        );
        expect(await fetchPressureGrid(2, 0, 0, 2, 4)).toBeNull();
    });

    it('fails over if the primary cannot identify its forecast run', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    frames: [
                        [
                            [1010, 1012, 1014],
                            [1011, 1013, 1015],
                            [1012, 1014, 1016],
                        ],
                    ],
                    lats: [0, 1, 2],
                    lons: [0, 1, 2],
                    fhrs: [0],
                }),
            ),
        );
        const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        try {
            const result = await generateIsobars(2, 0, 0, 2, 4);
            expect(result?.grid.source).toBe('open-meteo');
            expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
        } finally {
            fetchMock.mockRestore();
            canvas.mockRestore();
        }
    });
});

describe('pressure refresh lifecycle wiring', () => {
    const source = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
    const refresh = source.slice(
        source.indexOf('// ── Pressure scrubber:'),
        source.indexOf('// ── Center map when switching layers'),
    );
    it('retries an initial unavailable load and resumes from focus, online and visibility', () => {
        expect(refresh.indexOf('if (!grid ||')).toBeLessThan(refresh.indexOf('if (!grid) return'));
        for (const event of ['focus', 'online', 'visibilitychange']) {
            expect(refresh).toContain(`addEventListener('${event}', refresh)`);
            expect(refresh).toContain(`removeEventListener('${event}', refresh)`);
        }
        expect(refresh).toContain("document.visibilityState === 'hidden'");
        expect(refresh).toContain('PRESSURE_REFRESH_MS');
    });
    it('cancels abandoned frame generation and preserves only deliberate manual valid time', () => {
        expect(source).toContain('if (cachedGridRef.current !== grid) return;');
        expect(/const previousValidAt\s*=\s*manual\s*\?\s*pressureFrameValidAt/.test(source)).toBe(true);
        expect(source).toContain('pressureValidTimeMs: pressureFrameValidAt');
    });
});
