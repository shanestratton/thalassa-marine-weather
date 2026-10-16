/** Clear the screen lives in the map dropdown; the retained scrubber keeps its own tap. */
import React, { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { MapBaseSelector } from '../components/map/MapBaseSelector';
import { MapWeatherControls } from '../components/map/MapWeatherControls';
import { CLEAR_VIEW_ROOT_CLASS, useObsClearView, type ObsClearView } from '../components/map/mapHub/useObsClearView';
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

let latest: ObsClearView;

/** Obs's chart frame, its clear view, and the weather controls wired as MapHub wires them. */
function Obs({ layers }: { layers: string[] }) {
    const frameRef = useRef<HTMLDivElement>(null);
    const [controlsHidden, setControlsHidden] = useState(true);
    const clearView = useObsClearView({
        frameRef,
        available: true,
        modeOwnsChart: false,
    });
    latest = clearView;
    return (
        <div ref={frameRef} data-obs-clear-view={clearView.on ? 'on' : undefined}>
            <div data-testid="chart" className="thalassa-chart-map" />
            <MapBaseSelector
                visible
                value="relief"
                onChange={vi.fn()}
                encCellCount={0}
                encVisible={false}
                onToggleEnc={vi.fn()}
                onClearView={clearView.hide}
            />
            {layers.length > 0 && (
                <MapWeatherControls
                    weather={weather(layers)}
                    visible
                    embedded={false}
                    controlsHidden={controlsHidden}
                    onControlsHiddenChange={setControlsHidden}
                    keepInClearView={clearView.available || clearView.on}
                />
            )}
        </div>
    );
}

function clearScreen() {
    fireEvent.click(screen.getByRole('button', { name: 'Map base: Relief' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Clear the screen/ }));
}

/** One finger held on the pill well past the app's 500 ms long press, and lifted. */
function longPress(el: Element) {
    act(() => {
        fireEvent.pointerDown(el, { isPrimary: true, clientX: 20, clientY: 700 });
        vi.advanceTimersByTime(1_000);
        fireEvent.pointerUp(el, { isPrimary: true, clientX: 20, clientY: 700 });
    });
}

const pill = () => screen.getByTestId('weather-status-pill');

beforeEach(() => {
    // Keep restore timing deterministic.
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    });
    window.localStorage.clear();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove(CLEAR_VIEW_ROOT_CLASS);
});

/** The pill's own element in MapWeatherControls' source, from its <button to its </button>. */
function pillSource(): string {
    const controls = readFileSync('components/map/MapWeatherControls.tsx', 'utf8');
    const at = controls.indexOf('data-testid="weather-status-pill"');
    expect(at).toBeGreaterThan(0);
    return controls.slice(controls.lastIndexOf('<button', at), controls.indexOf('</button>', at));
}

/** MapHub's one <MapWeatherControls … /> call: its props, up to the '/>' at the tag's own indent. */
function hubControlsCall(): string {
    const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
    expect(hub.split('<MapWeatherControls').length).toBe(2);
    const open = hub.indexOf('<MapWeatherControls');
    const indent = hub.slice(hub.lastIndexOf('\n', open) + 1, open);
    const close = hub.indexOf(`\n${indent}/>`, open);
    expect(close).toBeGreaterThan(open);
    return hub.slice(open, close);
}

describe('the scrubber pill keeps its own tap while the map dropdown clears the view', () => {
    // A check of behaviour, wired as MapHub wires it today. With only keepInClearView reaching
    // the controls there is nothing for the pill to call, so this alone cannot catch the old
    // hold coming back; the two source checks below are what catch that, under any prop name.
    it('in use, a long press on it is only a long press: the clear view stays as it was, off or on', () => {
        render(<Obs layers={['wind']} />);
        longPress(pill());
        expect(latest.on).toBe(false);
        act(() => {
            fireEvent.keyDown(document.body, { key: 'h' });
        });
        expect(latest.on).toBe(true);
        longPress(pill());
        expect(latest.on).toBe(true);
        // Nothing tells VoiceOver it is a switch, either.
        expect(pill()).not.toHaveAccessibleDescription(/press and hold/i);
    });

    it('its only handler is build 128’s tap: no pointer, touch, mouse or context-menu hold on it', () => {
        const element = pillSource();
        expect(element.match(/\bon[A-Z]\w*(?==)/g)).toEqual(['onClick']);
        expect(element).toContain('onClick={autoHide.show}');
        expect(element.match(/\bref=\{[^}]*\}/g)).toEqual(['ref={autoHide.triggerRef}']);
        expect(element).not.toMatch(/hold|haptic/i);
        // What MapHub can hand it about the clear view is a flag, not a callback.
        expect(readFileSync('components/map/MapWeatherControls.tsx', 'utf8')).toContain('keepInClearView?: boolean;');
    });

    it('MapHub hands the controls nothing of the clear view but the keep flag: no toggle, under any name', () => {
        const call = hubControlsCall();
        expect(call.match(/\bclearView\b[\w.]*/g)).toEqual(['clearView.available', 'clearView.on']);
        expect(call).toContain('keepInClearView={clearView.available || clearView.on}');
        expect(call).not.toMatch(/toggle|hold/i);
    });
});

describe('the map dropdown clears the screen on every chart view', () => {
    it('with a weather layer up: the pill stays over the clear chart', () => {
        render(<Obs layers={['wind']} />);
        clearScreen();
        expect(latest.on).toBe(true);
        expect(pill().hasAttribute('data-clear-view-keep')).toBe(true);
        fireEvent.click(screen.getByTestId('chart'));
        expect(latest.on).toBe(false);
    });

    it('with no weather layer, and so no pill', () => {
        render(<Obs layers={[]} />);
        expect(screen.queryByTestId('weather-status-pill')).toBeNull();
        clearScreen();
        expect(latest.on).toBe(true);
    });

    it('nothing about the weather gates it: MapHub hands the clear view no layer at all', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        const call = hub.slice(hub.indexOf('const clearView = useObsClearView({'));
        const block = call.slice(0, call.indexOf('});'));
        expect(block).toContain('available: obsShowing,');
        expect(hub).toContain('onClearView={clearView.available ? clearView.hide : undefined}');
        expect(block).not.toMatch(/activeLayers|weather\./);
        const hook = readFileSync('components/map/mapHub/useObsClearView.ts', 'utf8');
        const options = hook.slice(hook.indexOf('export interface UseObsClearViewOptions'));
        expect(options.slice(0, options.indexOf('}'))).not.toMatch(/weather|layer/i);
    });
});

describe('the pill in the clear view', () => {
    it('still works: a tap opens the timeline over the clear chart, and the clear view stays', () => {
        render(<Obs layers={['wind']} />);
        clearScreen();
        expect(latest.on).toBe(true);
        act(() => {
            fireEvent.pointerDown(pill(), { isPrimary: true, clientX: 20, clientY: 700 });
            vi.advanceTimersByTime(80);
            fireEvent.click(pill(), { clientX: 20, clientY: 700 });
        });
        // The tap was the pill's, not the "tap anywhere" that brings the controls back.
        expect(latest.on).toBe(true);
        const timeline = screen.getByRole('region', { name: 'Weather controls' });
        expect(timeline.hasAttribute('data-clear-view-keep')).toBe(true);
    });

    it('stays, with its timeline, while there is a forecast to scrub; a layer key alone hides with the rest', () => {
        const base = { visible: true, embedded: false, onControlsHiddenChange: vi.fn() };
        const { rerender } = render(
            <MapWeatherControls {...base} controlsHidden weather={weather(['wind'])} keepInClearView />,
        );
        expect(pill().hasAttribute('data-clear-view-keep')).toBe(true);
        rerender(<MapWeatherControls {...base} controlsHidden={false} weather={weather(['wind'])} keepInClearView />);
        expect(screen.getByRole('region', { name: 'Weather controls' }).hasAttribute('data-clear-view-keep')).toBe(
            true,
        );
        rerender(
            <MapWeatherControls
                {...base}
                controlsHidden
                weather={weather([])}
                extraLegend={<section aria-label="AIS legend">AIS</section>}
                extraLegendCount={1}
                keepInClearView
            />,
        );
        expect(pill().hasAttribute('data-clear-view-keep')).toBe(false);
    });

    it('is only marked on Obs: the desk planner’s pill is not', () => {
        render(
            <MapWeatherControls
                visible
                embedded={false}
                controlsHidden
                onControlsHiddenChange={vi.fn()}
                weather={weather(['wind'])}
            />,
        );
        expect(pill().hasAttribute('data-clear-view-keep')).toBe(false);
    });
});

describe('Preferences → Chart', () => {
    it('explains the dropdown action and tap to restore, with no obsolete gesture switch', async () => {
        vi.useRealTimers();
        vi.stubGlobal('__BUILD_STAMP__', '2026-10-16 00:00Z');
        const { GeneralTab } = await import('../components/settings/GeneralTab');
        const { DEFAULT_SETTINGS } = await import('../stores/settingsStore');
        render(
            <GeneralTab
                settings={DEFAULT_SETTINGS}
                onSave={vi.fn()}
                onLocationSelect={vi.fn()}
                onDetectLocation={vi.fn()}
                onShowFactoryReset={vi.fn()}
            />,
        );
        expect(screen.getByText('Clear the Obs screen').parentElement).toHaveTextContent(
            'Choose Clear the screen in the top-centre map dropdown to hide controls; tap the chart to bring them back.',
        );
        expect(screen.queryByRole('switch', { name: /Two-finger hold/ })).toBeNull();
    });
});
