import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapWeatherControls } from '../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';
import { startPassageLookAhead, stopPassageLookAhead } from '../stores/passageHudStore';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;

function windGrid(totalHours = 3) {
    const frames = Array.from({ length: totalHours }, () => new Float32Array([1]));
    return {
        u: frames,
        v: frames,
        speed: frames,
        width: 1,
        height: 1,
        lats: [0],
        lons: [0],
        north: 0,
        south: 0,
        west: 0,
        east: 0,
        totalHours,
    };
}

function weather(overrides: Record<string, unknown> = {}): WeatherControlsWeather {
    return {
        activeLayers: new Set(['wind']),
        windForecastHours: [0, 3, 6],
        windForecastHoursRef: { current: [0, 3, 6] },
        windNowIdx: 0,
        windNowIdxRef: { current: 0 },
        windHour: 0,
        windTotalHours: 3,
        windPlaying: false,
        windReady: true,
        setWindHour: vi.fn(),
        setWindPlaying: vi.fn(),
        windModel: 'icon',
        setWindModel: vi.fn(),
        windState: { loading: false, error: null, grid: windGrid() },
        ...overrides,
    } as unknown as WeatherControlsWeather;
}

describe('MapWeatherControls', () => {
    const controls = { visible: true, embedded: false, controlsHidden: false, onControlsHiddenChange: vi.fn() };

    it('offers the same compact hide/reopen surface for non-weather layers alone', () => {
        const onControlsHiddenChange = vi.fn();
        const props = {
            ...controls,
            weather: weather({ activeLayers: new Set() }),
            extraLegend: <section aria-label="AIS legend">AIS targets · received age</section>,
            extraLegendCount: 2,
            onControlsHiddenChange,
        };
        const view = render(<MapWeatherControls {...props} />);
        expect(screen.getByRole('heading', { name: 'Chart layers' })).toBeVisible();
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Wind forecast model' })).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'AIS legend' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show layer key' }));
        expect(screen.getByRole('region', { name: 'AIS legend' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Hide layer key' })).toHaveTextContent('Layer key · 2');
        fireEvent.click(screen.getByRole('button', { name: 'Hide layer controls' }));
        expect(onControlsHiddenChange).toHaveBeenCalledWith(true);
        view.rerender(<MapWeatherControls {...props} controlsHidden />);
        expect(screen.queryByRole('region', { name: 'Chart layer controls' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show layer controls' }));
        expect(onControlsHiddenChange).toHaveBeenCalledWith(false);
    });

    it('combines weather and other chart keys without duplicating the weather timeline', () => {
        render(
            <MapWeatherControls
                {...controls}
                weather={weather()}
                extraLegend={<section aria-label="Route legend">Route review status</section>}
                extraLegendCount={1}
            />,
        );
        expect(screen.getAllByRole('slider')).toHaveLength(1);
        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Show layer key' }));
        expect(screen.getByRole('region', { name: 'Wind legend' })).toBeVisible();
        expect(screen.getByRole('region', { name: 'Route legend' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Hide layer key' })).toHaveTextContent('Layer key · 2');
    });

    it('leaves chart keys accessible during passage look-ahead with no second model picker or scrubber', () => {
        act(() => startPassageLookAhead());
        try {
            render(
                <MapWeatherControls
                    {...controls}
                    weather={weather()}
                    extraLegend={<section aria-label="Tides legend">Tide stations</section>}
                />,
            );
            expect(screen.getByRole('region', { name: 'Chart layer controls' })).toBeVisible();
            expect(screen.queryByRole('slider')).not.toBeInTheDocument();
            expect(screen.queryByRole('group', { name: 'Wind forecast model' })).not.toBeInTheDocument();
            expect(screen.queryByRole('group', { name: 'Weather layer controls' })).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Show layer key' }));
            expect(screen.getByRole('region', { name: 'Tides legend' })).toBeVisible();
            expect(screen.getByRole('button', { name: 'Hide layer controls' })).toBeVisible();
        } finally {
            act(() => stopPassageLookAhead());
        }
    });

    it('does not show a pressure scale while the selected drawable frame is still unavailable', () => {
        render(
            <MapWeatherControls
                {...controls}
                weather={weather({
                    activeLayers: new Set(['pressure']),
                    pressureSource: 'gfs',
                    framesReady: 22,
                    totalFrames: 22,
                    pressureValidTimeMs: null,
                    pressureTimeUnavailable: null,
                })}
            />,
        );
        expect(screen.getByRole('status')).toHaveTextContent('Loading');
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        expect(
            screen.getByRole('region', { name: 'Pressure legend' }).querySelector('[data-weather-scale]'),
        ).toBeNull();
    });

    it('uses contour-only pressure key when sharing with a non-weather overlay', () => {
        render(
            <MapWeatherControls
                {...controls}
                weather={weather({
                    activeLayers: new Set(['pressure', 'traffic']),
                    pressureSource: 'gfs',
                    framesReady: 22,
                    totalFrames: 22,
                    pressureValidTimeMs: Date.parse('2026-09-27T00:00:00Z'),
                })}
                extraLegend={<p>AIS targets</p>}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Show layer key' }));
        const legend = screen.getByRole('region', { name: 'Pressure legend' });
        expect(legend).toHaveTextContent('no pressure colour fill');
        expect(legend.querySelector('[data-weather-scale]')).toBeNull();
    });

    it('retains all atmospheric controls and one combined key without giving static imagery a live clock', () => {
        const input = weather({ activeLayers: new Set(['wind', 'rain', 'pressure', 'temperature', 'clouds']) });
        render(<MapWeatherControls weather={input} {...controls} />);
        expect(screen.getAllByRole('slider')).toHaveLength(1);
        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Control Air temperature' }));
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        expect(screen.getByText('Static tiles')).toBeVisible();
        expect(screen.getByText(/Frame time unavailable · Not controlled/)).toBeVisible();
        expect(screen.queryByText('● Live')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        for (const layer of ['Wind', 'Rain', 'Pressure', 'Air temperature', 'Clouds']) {
            expect(screen.getByRole('region', { name: `${layer} legend` })).toBeVisible();
        }
        expect(screen.getByText('Air temperature · °C')).toBeVisible();
        expect(screen.getByText('Cloud cover · %')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Control Wind' }));
        fireEvent.click(screen.getByRole('button', { name: 'Wind model ECMWF' }));
        expect(input.setWindModel).toHaveBeenCalledWith('ecmwf');
        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeVisible();
    });

    it('names actual wind UTC using the nonuniform source axis and keeps rain on its own UTC', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['wind', 'rain']),
                    windHour: 2,
                    windForecastHours: [0, 3, 9],
                    windState: {
                        loading: false,
                        error: null,
                        grid: { ...windGrid(), refTime: '2026-09-27T00:00:00Z' },
                    },
                    rainReady: true,
                    rainFrameCount: 1,
                    rainFrameIndex: 0,
                    rainNowIdxRef: { current: 0 },
                    unifiedFramesRef: {
                        current: [{ label: '08:20', type: 'radar', timeMs: Date.parse('2026-09-27T08:20:00Z') }],
                    },
                })}
                {...controls}
            />,
        );
        expect(screen.getByText('+9h')).toBeVisible();
        expect(screen.getByText('Forecast · Valid 09-27 09:00 UTC')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Control Rain' }));
        expect(screen.getByText('Radar · Valid 09-27 08:20 UTC')).toBeVisible();
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });

    it('preserves pressure fallback provenance, actual UTC and refresh failure without calling a fetch a model run', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['pressure']),
                    pressureSource: 'open-meteo',
                    pressureRefTime: '2026-09-27T00:00:00Z',
                    pressureClockMs: Date.parse('2026-09-27T10:00:00Z'),
                    pressureValidTimeMs: Date.parse('2026-09-27T10:00:00Z'),
                    pressureFetchedAtMs: Date.parse('2026-09-27T09:00:00Z'),
                    pressureError: 'Pressure refresh unavailable',
                    forecastHour: 10,
                    pressureNowIdx: 10,
                    totalFrames: 24,
                    framesReady: 24,
                    pressureFrameStepHours: 1,
                })}
                {...controls}
            />,
        );
        expect(screen.getByText(/GFS · Open-Meteo coarse fallback/)).toHaveTextContent(
            'Saved data; refresh unavailable',
        );
        expect(screen.getByText(/GFS · Open-Meteo coarse fallback/)).toHaveTextContent('Fetched 09-27 09:00 UTC');
        expect(screen.getByText(/GFS · Open-Meteo coarse fallback/)).toHaveTextContent('Valid 09-27 10:00 UTC');
        expect(screen.queryByText('Current')).not.toBeInTheDocument();
        expect(screen.queryByText(/● Live|09Z/)).not.toBeInTheDocument();
    });

    it('does not expose a competing pressure timeline or color key for an unaligned wind time', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['wind', 'pressure', 'clouds']),
                    pressureFollowsWind: true,
                    pressureSource: 'gfs',
                    framesReady: 22,
                    totalFrames: 22,
                    forecastHour: 0,
                    pressureNowIdx: 0,
                    pressureTimeUnavailable: 'Wind time is beyond pressure coverage',
                    pressureValidTimeMs: null,
                })}
                {...controls}
            />,
        );
        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeVisible();
        expect(screen.getByRole('alert')).toHaveTextContent('Wind time is beyond pressure coverage');
        fireEvent.click(screen.getByRole('button', { name: 'Control Pressure' }));
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        expect(
            screen.getByRole('region', { name: 'Pressure legend' }).querySelector('[data-weather-scale]'),
        ).toBeNull();
    });

    it('stands down during passage look-ahead but keeps the radar licence credit', () => {
        act(() => startPassageLookAhead());
        try {
            render(
                <MapWeatherControls
                    weather={weather({
                        activeLayers: new Set(['rain']),
                        rainReady: true,
                        rainFrameIndex: 0,
                        unifiedFramesRef: { current: [{ type: 'radar', label: 'Now' }] },
                    })}
                    {...controls}
                />,
            );
            expect(screen.queryByRole('region', { name: 'Weather controls' })).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Show weather controls' })).not.toBeInTheDocument();
            expect(screen.getByRole('link', { name: 'Rain radar data by RainViewer' })).toBeVisible();
        } finally {
            act(() => stopPassageLookAhead());
        }
    });
    it('labels the actual pressure valid UTC, stale source and failed refresh instead of live current', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['pressure']),
                    forecastHour: 4,
                    totalFrames: 22,
                    framesReady: 22,
                    pressureNowIdx: 4,
                    pressureFrameStepHours: 2,
                    pressureSource: 'gfs',
                    pressureRefTime: '2026-09-20T00:00:00Z',
                    pressureValidTimeMs: Date.parse('2026-09-20T08:00:00Z'),
                    pressureClockMs: Date.parse('2026-09-20T08:40:00Z'),
                    pressureError: 'failed',
                    setForecastHour: vi.fn(),
                    setIsPlaying: vi.fn(),
                    applyFrame: vi.fn(),
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );
        expect(screen.getByText('Near now')).toBeInTheDocument();
        expect(
            screen.getByText(
                'Model forecast · GFS 00Z · 8h old · Valid 09-20 08:00 UTC · Saved data; refresh unavailable',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText('Current')).not.toBeInTheDocument();
    });

    it('keeps a failed initial pressure load explicitly unavailable', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['pressure']),
                    forecastHour: 0,
                    totalFrames: 48,
                    framesReady: 0,
                    pressureNowIdx: 0,
                    pressureFrameStepHours: 2,
                    pressureSource: null,
                    pressureLoading: false,
                    pressureError: 'failed',
                    setForecastHour: vi.fn(),
                    setIsPlaying: vi.fn(),
                    applyFrame: vi.fn(),
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );
        expect(screen.getByText('Unavailable')).toBeInTheDocument();
        expect(screen.queryByText('Now')).not.toBeInTheDocument();
    });
    it('is absent outside the chart surface', () => {
        const { container } = render(
            <MapWeatherControls
                weather={weather()}
                visible={false}
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(container).toBeEmptyDOMElement();
    });

    it('shows the active wind timeline and retains a usable declutter path', () => {
        const onControlsHiddenChange = vi.fn();
        const input = weather();
        const { rerender } = render(
            <MapWeatherControls
                weather={input}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={onControlsHiddenChange}
            />,
        );

        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeInTheDocument();
        expect(screen.getByText('Near now')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Hide weather controls' }));
        expect(onControlsHiddenChange).toHaveBeenCalledWith(true);

        rerender(
            <MapWeatherControls
                weather={input}
                visible
                embedded={false}
                controlsHidden
                onControlsHiddenChange={onControlsHiddenChange}
            />,
        );
        expect(screen.queryByRole('slider', { name: 'Wind timeline' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Show weather controls' }));
        expect(onControlsHiddenChange).toHaveBeenLastCalledWith(false);
    });

    it('does not expose a particle-animation control for wind', () => {
        render(
            <MapWeatherControls
                weather={weather()}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.queryByRole('switch', { name: 'Particles animation' })).not.toBeInTheDocument();
    });

    it('labels a 48-frame hourly model with hourly offsets instead of the GFS schedule', () => {
        const forecastHours = Array.from({ length: 48 }, (_, index) => index);
        render(
            <MapWeatherControls
                weather={weather({
                    windForecastHours: forecastHours,
                    windForecastHoursRef: { current: forecastHours },
                    windHour: 9,
                    windTotalHours: 48,
                    windState: { loading: false, error: null, grid: windGrid(48) },
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByText('+9h')).toBeInTheDocument();
        expect(screen.queryByText('+72h')).not.toBeInTheDocument();
    });

    it('keeps the wind timeline when isobars overlay the wind layer', () => {
        // Pressure follows the wind clock in the hook, never a second slider.
        render(
            <MapWeatherControls
                weather={weather({ activeLayers: new Set(['wind', 'pressure']) })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeInTheDocument();
        expect(screen.getByText('Near now')).toBeInTheDocument();
    });

    it('uses the pressure grid time step rather than stretching every pressure timeline over 12 hours', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['pressure']),
                    forecastHour: 9,
                    totalFrames: 48,
                    framesReady: 48,
                    isPlaying: false,
                    pressureNowIdx: 0,
                    pressureFrameStepHours: 1,
                    pressureSource: 'open-meteo',
                    setForecastHour: vi.fn(),
                    setIsPlaying: vi.fn(),
                    applyFrame: vi.fn(),
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByText('+9h')).toBeInTheDocument();
        expect(screen.queryByText('+2.3h')).not.toBeInTheDocument();
        // "Fallback" until 2026-08-22. It named no provider — and Open-Meteo's
        // CC-BY terms require crediting them, on exactly this screen, which is
        // the one place the substitution is visible.
        expect(
            screen.getByText('Model forecast · GFS · Open-Meteo coarse fallback · Valid time unknown'),
        ).toBeInTheDocument();
        expect(screen.queryByRole('switch', { name: 'Particles animation' })).not.toBeInTheDocument();
    });

    it('keeps loading honest in the shared panel without a usable timeline', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    windReady: false,
                    windForecastHours: [],
                    windForecastHoursRef: { current: [] },
                    windTotalHours: 0,
                    windState: { loading: true, error: null, grid: null },
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByRole('status')).toHaveTextContent('Loading…');
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        expect(screen.queryByText('Now')).not.toBeInTheDocument();
        expect(screen.queryByText('Current')).not.toBeInTheDocument();
    });

    it('shows unavailable instead of live for an errored or absent wind grid', () => {
        const { rerender } = render(
            <MapWeatherControls
                weather={weather({
                    windReady: false,
                    windForecastHours: [],
                    windForecastHoursRef: { current: [] },
                    windTotalHours: 0,
                    windState: { loading: false, error: 'request failed', grid: null },
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByText('Unavailable')).toBeInTheDocument();
        expect(screen.queryByText('● Live')).not.toBeInTheDocument();

        rerender(
            <MapWeatherControls
                weather={weather({
                    windReady: false,
                    windForecastHours: [],
                    windForecastHoursRef: { current: [] },
                    windTotalHours: 0,
                    windState: { loading: false, error: null, grid: null },
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByText('Unavailable')).toBeInTheDocument();
        expect(screen.queryByText('Now')).not.toBeInTheDocument();
    });

    it('keeps wind and rain independently controllable without guessed index synchronization', () => {
        const setRainFrameIndex = vi.fn();
        const setWindHour = vi.fn();
        const setRainPlaying = vi.fn();
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['wind', 'rain']),
                    rainLoading: false,
                    rainReady: true,
                    rainFrameCount: 3,
                    rainFrameIndex: 1,
                    rainPlaying: false,
                    rainNowIdxRef: { current: 1 },
                    unifiedFramesRef: {
                        current: [
                            { label: '10:20', type: 'live' },
                            { label: '10:30', type: 'forecast' },
                        ],
                    },
                    setRainFrameIndex,
                    setWindHour,
                    setRainPlaying,
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Control Rain' }));
        expect(screen.getByText('10:30')).toBeInTheDocument();
        expect(screen.getByText('Forecast · Valid time unavailable')).toBeInTheDocument();
        expect(setRainFrameIndex).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByRole('slider', { name: 'Rain timeline' }), { key: 'ArrowRight' });
        expect(setRainFrameIndex).toHaveBeenCalledWith(2);
        expect(setRainPlaying).toHaveBeenCalledWith(false);
        expect(setWindHour).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Control Wind' }));
        expect(screen.getByRole('group', { name: 'Wind forecast model' })).toBeVisible();
        expect(screen.getByRole('slider', { name: 'Wind timeline' })).toBeVisible();
    });

    it('credits RainViewer while a radar frame is visible', () => {
        render(
            <MapWeatherControls
                weather={weather({
                    activeLayers: new Set(['rain']),
                    rainLoading: false,
                    rainReady: true,
                    rainFrameCount: 2,
                    rainFrameIndex: 0,
                    rainPlaying: false,
                    rainNowIdxRef: { current: 0 },
                    unifiedFramesRef: {
                        current: [
                            { label: 'Now', type: 'radar' },
                            { label: '+10m', type: 'forecast' },
                        ],
                    },
                    setRainFrameIndex: vi.fn(),
                    setRainPlaying: vi.fn(),
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByRole('link', { name: 'Rain radar data by RainViewer' })).toHaveAttribute(
            'href',
            'https://www.rainviewer.com/',
        );
    });

    it('keeps a 44px hide button inside the shared panel even with the key expanded', () => {
        render(
            <MapWeatherControls
                weather={weather({ activeLayers: new Set(['wind']) })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );
        const hide = screen.getByRole('button', { name: 'Hide weather controls' });
        expect(hide).toHaveClass('h-[44px]', 'w-[44px]');
        expect(hide.style.bottom).toBe('');
        const panel = screen.getByRole('region', { name: 'Weather controls' });
        expect(panel.style.bottom).toBe('calc(80px + env(safe-area-inset-bottom))');
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        expect(within(panel).getByRole('button', { name: 'Hide weather controls' })).toBe(hide);
        expect(screen.getByRole('region', { name: 'Wind legend' })).toBeVisible();
        cleanup();
        render(
            <MapWeatherControls
                weather={weather({ activeLayers: new Set(['wind']) })}
                visible
                embedded={false}
                controlsHidden
                onControlsHiddenChange={vi.fn()}
            />,
        );
        const show = screen.getByRole('button', { name: 'Show weather controls' });
        expect(show.style.bottom).toBe('calc(80px + env(safe-area-inset-bottom))');
    });

    it('the RainViewer credit sits centred under the basemap dropdown, shown or hidden', () => {
        // Shane 2026-09-06: out of the main viewing area, directly under the
        // dropdown at the top. MapBaseSelector: top = inset + 8px, h-12.
        for (const controlsHidden of [false, true]) {
            render(
                <MapWeatherControls
                    weather={weather({ activeLayers: new Set(['rain']), rainReady: true })}
                    visible
                    embedded={false}
                    controlsHidden={controlsHidden}
                    onControlsHiddenChange={vi.fn()}
                />,
            );
            const label = screen.queryByText('Radar by RainViewer');
            if (label) {
                const pill = label.parentElement as HTMLElement;
                expect(pill.className).toContain('left-1/2');
                expect(pill.className).toContain('-translate-x-1/2');
                expect(pill.style.top).toBe('calc(env(safe-area-inset-top) + 62px)');
                expect(pill.style.bottom).toBe('');
            }
            cleanup();
        }
    });
});
