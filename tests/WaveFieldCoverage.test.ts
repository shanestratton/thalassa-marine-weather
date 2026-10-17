import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ points: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoPoints: mocks.points }));
beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});
it('preserves publisher missing wave cells and interprets timezone UTC arrays as UTC', async () => {
    mocks.points.mockResolvedValue([
        {
            latitude: 1,
            longitude: 2,
            hourly: {
                time: ['2026-10-17T00:00', '2026-10-17T01:00'],
                wave_height: [null, 2],
                wave_period: [null, 8],
                wave_direction: [null, 90],
            },
        },
    ]);
    const { fetchWaveField } = await import('../services/weather/waveField');
    const result = await fetchWaveField({ north: 3, south: 0, west: 0, east: 3 }, '2026-10-17T00:00:00Z');
    expect(result?.referenceTimeIso).toBe('2026-10-17T00:00Z');
    expect(result?.samples[0].heightM[0]).toBeNaN();
    expect(result?.samples[0].periodS[0]).toBeNaN();
    expect(result?.samples[0].heightM[1]).toBe(2);
});
it('does not align a second sample with a different time axis onto the first sample', async () => {
    const row = (time: string[]) => ({
        hourly: { time, wave_height: [1, 2], wave_period: [8, 8], wave_direction: [0, 0] },
    });
    mocks.points.mockResolvedValue([
        row(['2026-10-17T00:00', '2026-10-17T01:00']),
        row(['2026-10-17T01:00', '2026-10-17T02:00']),
    ]);
    const { fetchWaveField } = await import('../services/weather/waveField');
    const result = await fetchWaveField({ north: 3, south: 0, west: 0, east: 3 }, '2026-10-17T00:00:00Z');
    expect(result?.samples).toHaveLength(1);
});
