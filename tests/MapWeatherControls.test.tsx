import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapWeatherControls } from '../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;

function weather(overrides: Record<string, unknown> = {}): WeatherControlsWeather {
    return {
        activeLayers: new Set(['wind']),
        windForecastHoursRef: { current: [0, 3, 6] },
        windNowIdxRef: { current: 0 },
        windHour: 0,
        windTotalHours: 3,
        windPlaying: false,
        setWindHour: vi.fn(),
        setWindPlaying: vi.fn(),
        windModel: 'icon',
        setWindModel: vi.fn(),
        windState: { loading: false },
        ...overrides,
    } as WeatherControlsWeather;
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
});
