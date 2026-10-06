import { describe, expect, it, vi } from 'vitest';
import { summarizeWeatherControls, type WeatherControlSummaryInput } from '../components/map/weatherControlSummary';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';
import type { CmemsLayerId } from '../components/map/CmemsAttribution';

type Weather = ReturnType<typeof useWeatherLayers>;
const NOW = Date.parse('2026-09-27T10:00:00Z');
const REFERENCE = '2026-09-27T06:00:00Z';
const fields = Array.from({ length: 3 }, () => new Float32Array([1]));
function weather(patch: Record<string, unknown> = {}): Weather {
    return {
        windReady: true,
        windHour: 1.5,
        windForecastHours: [0, 1, 6],
        windModel: 'ecmwf',
        windPlaying: false,
        windState: {
            loading: false,
            error: null,
            grid: { refTime: REFERENCE, totalHours: 3, u: fields, v: fields, speed: fields },
        },
        rainReady: true,
        rainLoading: false,
        rainImageLoading: false,
        rainFrameIndex: 0,
        rainPlaying: false,
        unifiedFramesRef: {
            current: [{ type: 'radar', label: 'Incorrect label', timeMs: Date.parse('2026-09-27T09:40:00Z') }],
        },
        pressureClockMs: NOW,
        pressureSource: 'gfs',
        pressureRefTime: REFERENCE,
        pressureFetchedAtMs: NOW,
        pressureValidTimeMs: NOW,
        framesReady: 12,
        pressureFollowsWind: false,
        pressureLoading: false,
        pressureError: null,
        pressureTimeUnavailable: null,
        isPlaying: false,
        currentsHour: 3,
        currentsNowIdx: 1,
        currentsPlaying: false,
        wavesHour: 3,
        wavesNowIdx: 1,
        wavesPlaying: false,
        sstStep: 3,
        sstNowIdx: 1,
        sstPlaying: false,
        chlStep: 3,
        chlNowIdx: 1,
        chlPlaying: false,
        seaiceStep: 3,
        seaiceNowIdx: 1,
        seaicePlaying: false,
        mldStep: 3,
        mldNowIdx: 1,
        mldPlaying: false,
        ...patch,
    } as unknown as Weather;
}
function summary(patch: Partial<WeatherControlSummaryInput> = {}, data: Record<string, unknown> = {}) {
    return summarizeWeatherControls({
        weather: weather(data),
        activeLayer: 'wind',
        activeWeatherLayers: ['wind'],
        ...patch,
    });
}
const ready = {
    phase: 'ready' as const,
    requestedStep: 3,
    verifiedStep: 3,
    sourceGeneration: 'verified-generation',
    presentation: 'visible' as const,
    attempt: 1,
    retry: vi.fn(),
};

describe('weatherControlSummary', () => {
    it('reports a fractional nonuniform wind UTC, selected model and paused state without wall-clock reads', () => {
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
            throw new Error('Must be pure');
        });
        try {
            const result = summary();
            expect(result.primary).toBe('Wind · ECMWF · Paused');
            expect(result.secondary).toBe('09-27 09:30 UTC');
            expect(result.tone).toBe('neutral');
            expect(result.accessibleText).toContain('Model forecast, not observations');
        } finally {
            clock.mockRestore();
        }
    });

    it('normalizes the velocity alias, deduplicates layers and exposes the playing state', () => {
        const result = summary(
            { activeLayer: 'velocity', activeWeatherLayers: ['wind', 'velocity', 'rain'], extraLegendCount: 2 },
            { windPlaying: true },
        );
        expect(result.primary).toBe('Wind · ECMWF · Playing · +3 layers');
        expect(result.secondary).toContain('Independent times');
        expect(result.accessibleText).toContain('2 additional chart-layer legends');
    });

    it.each([-1, 3, NaN, Infinity])('never clamps invalid wind frame %s to a plausible clock', (windHour) => {
        const result = summary({}, { windHour });
        expect(result.secondary).toContain('UTC unknown');
        expect(result.tone).toBe('warning');
        expect(result.secondary).not.toMatch(/\d\d:\d\d/);
    });

    it.each([
        [0, 6, 1],
        [0, NaN, 6],
        [0, 1],
        [-1, 1, 6],
    ])('rejects malformed source wind axes %s', (...windForecastHours) => {
        const result = summary({}, { windForecastHours });
        expect(result.secondary).toContain('UTC unknown');
        expect(result.tone).toBe('warning');
    });

    it('handles missing vector arrays as unavailable instead of throwing or inventing readiness', () => {
        const result = summary(
            {},
            { windState: { grid: { refTime: REFERENCE, totalHours: 3 }, loading: false, error: null } },
        );
        expect(result.primary).toContain('Unavailable');
        expect(result.tone).toBe('warning');
    });

    it('uses the source rain UTC and distinguishes radar from forecast independently of wind', () => {
        const result = summary({ activeLayer: 'rain', activeWeatherLayers: ['wind', 'rain'] });
        expect(result.primary).toBe('Rain · Radar · Paused · +1 layer');
        expect(result.secondary).toBe('09-27 09:40 UTC · Independent times');
        expect(result.accessibleText).toContain('RainViewer');
        expect(result.accessibleText).not.toContain('Incorrect label');
        const forecast = summary(
            { activeLayer: 'rain', activeWeatherLayers: ['rain'] },
            {
                rainPlaying: true,
                unifiedFramesRef: { current: [{ type: 'forecast', timeMs: NOW + 90_000 }] },
            },
        );
        expect(forecast.primary).toBe('Rain · Forecast · Playing');
        expect(forecast.secondary).toBe('09-27 10:01 UTC');
        expect(forecast.accessibleText).toContain('Rainbow.ai');
    });

    it('does not invent a rain UTC from a display label', () => {
        const result = summary(
            { activeLayer: 'rain', activeWeatherLayers: ['rain'] },
            { unifiedFramesRef: { current: [{ type: 'radar', label: '10:00' }] } },
        );
        expect(result.secondary).toContain('UTC unknown');
        expect(result.tone).toBe('warning');
    });

    it('keeps non-selected pressure coverage failure visible and retains all warning reasons accessibly', () => {
        const result = summary(
            { activeWeatherLayers: ['wind', 'pressure', 'rain'] },
            {
                pressureTimeUnavailable: 'Wind time is beyond pressure coverage',
                pressureValidTimeMs: null,
                pressureRefTime: '2026-09-27T00:00:00Z',
                pressureError: 'Offline refresh',
                rainReady: false,
            },
        );
        expect(result.primary).toContain('+2 layers');
        expect(result.secondary).toContain('Pressure outside coverage');
        expect(result.secondary).toContain('alerts');
        expect(result.tone).toBe('warning');
        expect(result.accessibleText).toContain('Wind time is beyond pressure coverage');
        expect(result.accessibleText).toContain('Stale pressure model run: 10 hours old');
        expect(result.accessibleText).toContain('Offline refresh');
        expect(result.accessibleText).toContain('Rain imagery is unavailable');
    });

    it('names old pressure run age visibly even when a refresh also failed', () => {
        const result = summary(
            { activeLayer: 'pressure', activeWeatherLayers: ['pressure'] },
            { pressureRefTime: '2026-09-27T00:00:00Z', pressureError: 'Network error' },
        );
        expect(result.primary).toContain('GFS 10h old');
        expect(result.secondary).toContain('Pressure refresh failed');
        expect(result.secondary).toContain('09-27 10:00 UTC');
        expect(result.tone).toBe('warning');
    });

    it('does not call the Open-Meteo time axis a known model run', () => {
        const result = summary(
            { activeLayer: 'pressure', activeWeatherLayers: ['pressure'] },
            { pressureSource: 'open-meteo', pressureRefTime: '2026-09-20T00:00:00Z', pressureFollowsWind: true },
        );
        expect(result.primary).toBe('Pressure · Open-Meteo · Follows wind');
        expect(result.secondary).toContain('Pressure run age unknown');
        expect(result.accessibleText).toContain('coarse fallback');
        expect(result.accessibleText).not.toContain('168h old');
    });

    it('uses pressure actual UTC and marks null drawable selection as pending, never playing', () => {
        const result = summary(
            { activeLayer: 'pressure', activeWeatherLayers: ['pressure'] },
            { pressureValidTimeMs: null, isPlaying: true },
        );
        expect(result.primary).toContain('Loading');
        expect(result.primary).not.toContain('Playing');
        expect(result.tone).toBe('loading');
        expect(result.secondary).toContain('UTC unknown');
    });

    it.each([undefined, NaN])('never reads a hidden wall clock for pressure run age (%s)', (pressureClockMs) => {
        const result = summary({ activeLayer: 'pressure', activeWeatherLayers: ['pressure'] }, { pressureClockMs });
        expect(result.accessibleText).toContain('model run age is unknown');
        expect(result.tone).toBe('warning');
    });

    it('exposes future run clocks and overdue fetches as distinct warnings', () => {
        const result = summary(
            { activeLayer: 'pressure', activeWeatherLayers: ['pressure'] },
            { pressureRefTime: '2026-09-28T00:00:00Z', pressureFetchedAtMs: NOW - 3_600_000 },
        );
        expect(result.secondary).toContain('Pressure run in future');
        expect(result.accessibleText).toContain('last fetched 60 minutes ago');
    });

    it('fails closed for an unknown pressure provider and never reads Date.now for missing pressure clocks', () => {
        expect(
            summary({ activeLayer: 'pressure', activeWeatherLayers: ['pressure'] }, { pressureSource: 'unknown' })
                .primary,
        ).toContain('Unavailable');
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
            throw new Error('Must be pure');
        });
        try {
            const result = summary(
                { activeLayer: 'pressure', activeWeatherLayers: ['pressure'] },
                { pressureClockMs: undefined },
            );
            expect(result.secondary).toContain('run age unknown');
        } finally {
            clock.mockRestore();
        }
    });

    it.each(['temperature', 'clouds'] as const)('keeps %s static/time uncertainty visible', (layer) => {
        const result = summary({ activeLayer: layer, activeWeatherLayers: [layer] });
        expect(result.primary).toContain('OpenWeather · Static');
        expect(result.secondary).toContain('UTC unknown');
        expect(result.accessibleText).toContain('tile availability are not exposed');
        expect(result.primary + result.secondary).not.toContain('Live');
    });

    it.each([
        ['currents', '+2h'],
        ['waves', '+6h'],
        ['sst', '+2d'],
        ['chl', '+2d'],
        ['seaice', '+2d'],
        ['mld', '+2d'],
    ] as const)('respects %s cadence without inventing a valid UTC', (layer, offset) => {
        const result = summary({
            activeLayer: layer,
            activeWeatherLayers: [layer],
            cmemsLayerStates: { [layer]: ready },
        });
        expect(result.primary).toContain('CMEMS · Paused');
        expect(result.secondary).toContain(`${offset} · UTC unknown`);
        expect(result.accessibleText).toContain('Copernicus Marine');
        expect(result.tone).toBe('warning');
    });

    it.each([{ verifiedStep: 2 }, { presentation: 'hidden' as const }, { sourceGeneration: null }, { attempt: 0 }])(
        'requires exact rendered CMEMS readiness %s',
        (patch) => {
            const layer: CmemsLayerId = 'currents';
            const result = summary(
                {
                    activeLayer: layer,
                    activeWeatherLayers: [layer],
                    cmemsLayerStates: { currents: { ...ready, ...patch } },
                },
                { currentsPlaying: true },
            );
            expect(result.primary).toContain('Loading');
            expect(result.primary).not.toContain('Playing');
            expect(result.secondary).toContain('verifying');
        },
    );

    it('keeps another layer loading visible without replacing the selected layer clock', () => {
        const result = summary({ activeWeatherLayers: ['wind', 'rain'] }, { rainLoading: true });
        expect(result.secondary).toBe('09-27 09:30 UTC · Rain loading');
        expect(result.tone).toBe('loading');
    });

    it('summarizes extra-only keys and preserves look-ahead context', () => {
        expect(
            summary({ activeLayer: null, activeWeatherLayers: [], extraLegendCount: 4, lookingAhead: true }),
        ).toEqual({
            primary: 'Layer key · 4 layers',
            secondary: 'Look-ahead · Tap for key',
            tone: 'neutral',
            accessibleText: 'Layer key · 4 layers. Look-ahead · Tap for key.',
        });
        expect(summary({ activeWeatherLayers: [], extraLegendCount: NaN }).primary).toBe('Layer key · 0 layers');
    });

    it('falls back when the selected layer has been disabled and retains warnings during look-ahead', () => {
        const result = summary(
            { activeLayer: 'temperature', activeWeatherLayers: ['wind', 'pressure'], lookingAhead: true },
            { pressureError: 'Refresh unavailable' },
        );
        expect(result.primary).toBe('Wind · ECMWF · Look-ahead · +1 layer');
        expect(result.secondary).toContain('Pressure refresh failed');
        expect(result.accessibleText).toContain('use the passage timeline');
    });

    it('does not mutate the caller snapshot or invoke playback/retry functions', () => {
        const input = Object.freeze({
            weather: Object.freeze(weather()),
            activeLayer: 'wind' as const,
            activeWeatherLayers: Object.freeze(['wind', 'currents'] as const),
            cmemsLayerStates: { currents: Object.freeze({ ...ready }) },
        });
        expect(() => summarizeWeatherControls(input)).not.toThrow();
        expect(ready.retry).not.toHaveBeenCalled();
        const result = summarizeWeatherControls(input);
        expect(result.primary.length).toBeLessThanOrEqual(64);
        expect(result.secondary.length).toBeLessThanOrEqual(80);
    });
});

describe('weatherControlSummary close-in wind readout', () => {
    const model = { value: '8 kt SE', source: 'model' as const, stale: false };
    const boat = { value: '14 kt SSW', source: 'boat' as const, stale: false };

    it('puts the local model value in the wind pill, named by model, with the play state below', () => {
        const result = summary({ windCloseIn: model });
        expect(result.primary).toBe('Wind · 8 kt SE · ECMWF');
        expect(result.secondary).toBe('Paused · 09-27 09:30 UTC');
        expect(result.tone).toBe('neutral');
        expect(result.accessibleText).toContain('Wind at the screen centre: 8 kt SE, ECMWF model forecast');
    });

    it('names the boat when the instruments are shown, and says when they are stale', () => {
        const result = summary({ windCloseIn: boat });
        expect(result.primary).toBe('Wind · 14 kt SSW · Boat');
        expect(result.secondary).toBe('True wind · Boat instruments');
        expect(result.accessibleText).toContain("Wind at the boat: 14 kt SSW, the boat's own true-wind instruments");
        // Stale leads, so a 320 px pill that truncates the end still shows it.
        expect(summary({ windCloseIn: { ...boat, stale: true } }).secondary).toBe(
            'Stale · True wind · Boat instruments',
        );
    });

    it('says Calm in the same place', () => {
        expect(summary({ windCloseIn: { value: 'Calm', source: 'model', stale: false } }).primary).toBe(
            'Wind · Calm · ECMWF',
        );
    });

    it('keeps the layer count and the alerts', () => {
        const result = summary({ windCloseIn: model, activeWeatherLayers: ['wind', 'rain'] });
        expect(result.primary).toBe('Wind · 8 kt SE · ECMWF · +1 layer');
        expect(result.secondary).toBe('Paused · 09-27 09:30 UTC · Independent times');
        const refreshing = summary(
            { windCloseIn: model },
            { windState: { loading: true, error: null, grid: weather().windState.grid } },
        );
        expect(refreshing.secondary).toBe('Paused · 09-27 09:30 UTC · Wind refreshing');
    });

    it('never dresses an unready or unselected wind layer with a local value', () => {
        const loading = summary(
            { windCloseIn: model },
            { windReady: false, windState: { loading: true, error: null } },
        );
        expect(loading.primary).toBe('Wind · ECMWF · Loading');
        const rain = summary({ windCloseIn: model, activeLayer: 'rain', activeWeatherLayers: ['wind', 'rain'] });
        expect(rain.primary).toBe('Rain · Radar · Paused · +1 layer');
        expect(summary({ windCloseIn: null }).primary).toBe('Wind · ECMWF · Paused');
    });

    it('keeps Look-ahead as the state while the passage strip drives the clock', () => {
        const result = summary({ windCloseIn: model, lookingAhead: true });
        expect(result.primary).toBe('Wind · 8 kt SE · ECMWF');
        expect(result.secondary).toBe('Look-ahead · 09-27 09:30 UTC');
    });
});
