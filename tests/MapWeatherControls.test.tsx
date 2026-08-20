import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapWeatherControls } from '../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';

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

        expect(screen.getByRole('button', { name: 'Wind layer' })).toBeInTheDocument();
        expect(screen.getByText('Now')).toBeInTheDocument();
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
        expect(screen.queryByRole('button', { name: 'Wind layer' })).not.toBeInTheDocument();
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
        // Wind + pressure is the synoptic overlay: ONE scrubber (wind's), the
        // isobar frame follows it inside useWeatherLayers. The LegendDock
        // used for other layer pairs must not replace the timeline here.
        render(
            <MapWeatherControls
                weather={weather({ activeLayers: new Set(['wind', 'pressure']) })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByRole('button', { name: 'Wind layer' })).toBeInTheDocument();
        expect(screen.getByText('Now')).toBeInTheDocument();
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
        expect(screen.getByText('Fallback · Forecast')).toBeInTheDocument();
        expect(screen.queryByRole('switch', { name: 'Particles animation' })).not.toBeInTheDocument();
    });

    it('leaves wind loading feedback to the centred OBS status instead of rendering a bottom pill', () => {
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

        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
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

    it('keeps the wind and rain pair synchronised to the rain timeline', () => {
        const setRainFrameIndex = vi.fn();
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
                })}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );

        expect(screen.getByText('10:30')).toBeInTheDocument();
        expect(screen.getByText('Forecast')).toBeInTheDocument();
        expect(setRainFrameIndex).not.toHaveBeenCalled();
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

    it('the hide button shares the scrubber row with the button that opened it', () => {
        // One thumb spot: the "Weather controls" pill sits at bottom 80px +
        // inset; pressing it must put the minimise button on the SAME row
        // (right of the scrubber), not 60px higher up the right edge
        // (Shane, 2026-08-21).
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
        expect(hide.style.bottom).toBe('calc(80px + env(safe-area-inset-bottom))');

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
});
