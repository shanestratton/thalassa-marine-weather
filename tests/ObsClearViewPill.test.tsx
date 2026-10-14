/**
 * The scrubber's pill as the clear view's button (129-13). Shane, 14 Oct:
 * "Maybe the scrubber button. As that should stay." Press and hold it to
 * clear the screen or bring the controls back; a tap still opens the
 * timeline; with a forecast to scrub, the pill and the timeline stay in the
 * clear view. And Preferences → Chart's way out for the two-finger hold.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { MapWeatherControls, PILL_HOLD_MS } from '../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';

type WeatherControlsWeather = ReturnType<typeof useWeatherLayers>;

function weather(layers: string[]): WeatherControlsWeather {
    const frames = Array.from({ length: 3 }, () => new Float32Array([1]));
    return {
        activeLayers: new Set(layers),
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
        windState: {
            loading: false,
            error: null,
            grid: { u: frames, v: frames, speed: frames, width: 1, height: 1, lats: [0], lons: [0], totalHours: 3 },
        },
    } as unknown as WeatherControlsWeather;
}

const base = { visible: true, embedded: false, controlsHidden: true, onControlsHiddenChange: vi.fn() };

beforeEach(() => {
    vi.useFakeTimers();
    base.onControlsHiddenChange.mockClear();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('the scrubber pill', () => {
    it('held, clears the screen (and the lift does not also open the timeline)', () => {
        const onHold = vi.fn();
        render(<MapWeatherControls {...base} weather={weather(['wind'])} clearView={{ onHold }} />);
        const pill = screen.getByTestId('weather-status-pill');
        act(() => {
            fireEvent.pointerDown(pill, { clientX: 20, clientY: 700 });
            vi.advanceTimersByTime(PILL_HOLD_MS);
        });
        expect(onHold).toHaveBeenCalledTimes(1);
        fireEvent.pointerUp(pill);
        fireEvent.click(pill);
        expect(base.onControlsHiddenChange).not.toHaveBeenCalled();
    });

    it('tapped, still opens the timeline; a press the browser takes for a scroll is not a hold', () => {
        const onHold = vi.fn();
        render(<MapWeatherControls {...base} weather={weather(['wind'])} clearView={{ onHold }} />);
        const pill = screen.getByTestId('weather-status-pill');
        act(() => {
            fireEvent.pointerDown(pill, { clientX: 20, clientY: 700 });
            vi.advanceTimersByTime(120);
        });
        fireEvent.pointerUp(pill);
        fireEvent.click(pill);
        expect(base.onControlsHiddenChange).toHaveBeenCalledWith(false);
        for (const end of [fireEvent.pointerCancel, fireEvent.pointerLeave]) {
            act(() => {
                fireEvent.pointerDown(pill, { clientX: 20, clientY: 700 });
                vi.advanceTimersByTime(200);
                end(pill);
                vi.advanceTimersByTime(PILL_HOLD_MS * 2);
            });
        }
        expect(onHold).not.toHaveBeenCalled();
    });

    it('stays in the clear view, with its timeline, while there is a forecast to scrub; a layer key alone does not', () => {
        const { rerender } = render(
            <MapWeatherControls {...base} weather={weather(['wind'])} clearView={{ onHold: vi.fn() }} />,
        );
        expect(screen.getByTestId('weather-status-pill').hasAttribute('data-clear-view-keep')).toBe(true);
        expect(screen.getByTestId('weather-status-pill')).toHaveAccessibleDescription(
            /Press and hold to clear the screen/,
        );
        rerender(
            <MapWeatherControls
                {...base}
                controlsHidden={false}
                weather={weather(['wind'])}
                clearView={{ onHold: vi.fn() }}
            />,
        );
        expect(screen.getByRole('region', { name: 'Weather controls' }).hasAttribute('data-clear-view-keep')).toBe(
            true,
        );
        rerender(
            <MapWeatherControls
                {...base}
                weather={weather([])}
                extraLegend={<section aria-label="AIS legend">AIS</section>}
                extraLegendCount={1}
                clearView={{ onHold: vi.fn() }}
            />,
        );
        expect(screen.getByTestId('weather-status-pill').hasAttribute('data-clear-view-keep')).toBe(false);
    });

    it('is only the clear view’s button on Obs: the desk planner’s pill holds nothing', () => {
        render(<MapWeatherControls {...base} weather={weather(['wind'])} />);
        const pill = screen.getByTestId('weather-status-pill');
        expect(pill.hasAttribute('data-clear-view-keep')).toBe(false);
        expect(pill).not.toHaveAccessibleDescription(/Press and hold/);
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toContain(
            'clearView={clearView.available || clearView.on ? { onHold: clearView.toggle } : undefined}',
        );
    });
});

describe('Preferences → Chart', () => {
    it('"Two-finger hold clears the chart": on by default, and saves obsClearViewHold', async () => {
        vi.useRealTimers();
        vi.stubGlobal('__BUILD_STAMP__', '2026-10-14 00:00Z');
        const { GeneralTab } = await import('../components/settings/GeneralTab');
        const { DEFAULT_SETTINGS } = await import('../stores/settingsStore');
        expect(DEFAULT_SETTINGS.obsClearViewHold).not.toBe(false);
        const onSave = vi.fn();
        const props = {
            onSave,
            onLocationSelect: vi.fn(),
            onDetectLocation: vi.fn(),
            onShowFactoryReset: vi.fn(),
        };
        const { unmount } = render(React.createElement(GeneralTab, { settings: DEFAULT_SETTINGS, ...props }));
        const toggle = screen.getByRole('switch', { name: 'Two-finger hold clears the chart' });
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        // In the Chart section's card, beside the other chart switches.
        const card = toggle.parentElement!.parentElement as HTMLElement;
        expect(card.previousElementSibling?.textContent).toBe('Chart');
        expect(card.textContent).toContain('Show ENC charts when Obs opens');
        fireEvent.click(toggle);
        expect(onSave).toHaveBeenCalledWith({ obsClearViewHold: false });
        unmount();
        render(
            React.createElement(GeneralTab, { settings: { ...DEFAULT_SETTINGS, obsClearViewHold: false }, ...props }),
        );
        const off = screen.getByRole('switch', { name: 'Two-finger hold clears the chart' });
        expect(off.getAttribute('aria-checked')).toBe('false');
        fireEvent.click(off);
        expect(onSave).toHaveBeenCalledWith({ obsClearViewHold: true });
        // MapHub reads it as "on unless exactly false".
        expect(readFileSync('components/map/MapHub.tsx', 'utf8')).toContain(
            'holdGesture: settings.obsClearViewHold !== false,',
        );
    });
});
