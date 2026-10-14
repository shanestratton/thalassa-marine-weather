/**
 * Obs's clear view (129-13): the controls off the chart and back, with no new
 * button (components/map/mapHub/useObsClearView.ts, ObsClearViewChrome.tsx).
 *
 * Shane, 2026-10-14: "We need a way to clear everything off the screen so we
 * can actually see the screen. A toggle of some kind. One that you can turn
 * on or off at the press of a (not another button)." "Maybe the scrubber
 * button. As that should stay."
 */
import React, { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import {
    CLEAR_VIEW_HINT_KEY,
    CLEAR_VIEW_ROOT_CLASS,
    useObsClearView,
    type ObsClearView,
} from '../components/map/mapHub/useObsClearView';
import { ObsClearViewChrome } from '../components/map/ObsClearViewChrome';
import { AlarmAudioService } from '../services/AlarmAudioService';

type Listener = (event: { originalEvent?: unknown }) => void;

/** Just enough of a Mapbox map: its container, and on/off/emit for its camera events. */
function fakeMap() {
    const listeners = new Map<string, Set<Listener>>();
    return {
        getContainer: () => document.querySelector<HTMLElement>('[data-testid="chart"]')!,
        on: (type: string, fn: Listener) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(fn);
        },
        off: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
        emit: (type: string, event: { originalEvent?: unknown }) => listeners.get(type)?.forEach((fn) => fn(event)),
    };
}

let map = fakeMap();
let latest: ObsClearView;
const chartClicks = vi.fn();
const mobClicks = vi.fn();

function Harness({
    available = true,
    modeOwnsChart = false,
    holdGesture = true,
}: {
    available?: boolean;
    modeOwnsChart?: boolean;
    holdGesture?: boolean;
}) {
    const frameRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef(map as unknown as mapboxgl.Map);
    const view = useObsClearView({ frameRef, mapRef, mapReady: true, available, modeOwnsChart, holdGesture });
    latest = view;
    return (
        <div ref={frameRef} data-testid="frame" data-obs-clear-view={view.on ? 'on' : undefined}>
            <div
                data-testid="chart"
                className="thalassa-chart-map"
                ref={(el) => {
                    // Mapbox's own listener: a native one on the chart, as its canvas container's.
                    if (el && !el.dataset.wired) {
                        el.dataset.wired = '1';
                        el.addEventListener('click', () => chartClicks());
                    }
                }}
            />
            <button type="button" data-clear-view-keep="" onClick={mobClicks}>
                MOB
            </button>
            <input aria-label="Search" />
            <ObsClearViewChrome view={view} />
        </div>
    );
}

function touch(type: string, points: { id: number; x: number; y: number }[]) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'touches', {
        value: points.map((p) => ({ identifier: p.id, clientX: p.x, clientY: p.y })),
    });
    screen.getByTestId('chart').dispatchEvent(event);
}

/** Two fingers down and held still for `ms` (lift() ends it: the hold is decided as they lift). */
function twoFingerHold(ms = 650) {
    act(() => {
        touch('touchstart', [{ id: 1, x: 100, y: 300 }]);
        touch('touchstart', [
            { id: 1, x: 100, y: 300 },
            { id: 2, x: 220, y: 300 },
        ]);
    });
    act(() => {
        vi.advanceTimersByTime(ms);
    });
}

function lift() {
    act(() => touch('touchend', []));
}

/** A tap: pointer down, then the click, `after` ms later. */
function tap(el: Element, after = 80) {
    act(() => {
        fireEvent.pointerDown(el, { isPrimary: true, clientX: 50, clientY: 50 });
        vi.advanceTimersByTime(after);
        fireEvent.click(el, { clientX: 50, clientY: 50 });
    });
}

beforeEach(() => {
    // Date too: jsdom stamps an event's timeStamp from it, and the hold is decided on those.
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    });
    map = fakeMap();
    chartClicks.mockClear();
    mobClicks.mockClear();
    window.localStorage.clear();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove(CLEAR_VIEW_ROOT_CLASS);
});

describe('two fingers held on the chart', () => {
    it('hide the controls; one tap anywhere brings them back and never reaches the chart', () => {
        render(<Harness />);
        twoFingerHold();
        lift();
        expect(latest.on).toBe(true);
        expect(screen.getByTestId('frame').dataset.obsClearView).toBe('on');
        // The tab bar goes too (not in split view).
        expect(document.documentElement.classList.contains(CLEAR_VIEW_ROOT_CLASS)).toBe(true);
        tap(screen.getByTestId('chart'));
        expect(latest.on).toBe(false);
        // Spent on bringing the controls back: Mapbox never sees it, so no weather readout.
        expect(chartClicks).not.toHaveBeenCalled();
        expect(document.documentElement.classList.contains(CLEAR_VIEW_ROOT_CLASS)).toBe(false);
        // With the controls showing, a tap is the chart's again.
        tap(screen.getByTestId('chart'));
        expect(chartClicks).toHaveBeenCalledTimes(1);
    });

    it('toggle back with a second hold', () => {
        render(<Harness />);
        twoFingerHold();
        lift();
        twoFingerHold();
        lift();
        expect(latest.on).toBe(false);
    });

    it('keep a long press the chart’s, so it still drops its pin', () => {
        render(<Harness />);
        twoFingerHold();
        lift();
        tap(screen.getByTestId('chart'), 600);
        expect(chartClicks).toHaveBeenCalledTimes(1);
        expect(latest.on).toBe(true);
    });

    it('leave MOB working in the clear view, and the clear view up', () => {
        render(<Harness />);
        twoFingerHold();
        lift();
        tap(screen.getByRole('button', { name: 'MOB' }));
        expect(mobClicks).toHaveBeenCalledTimes(1);
        expect(latest.on).toBe(true);
    });

    it('stand down for a pinch Mapbox began, not for the camera’s own moves', () => {
        render(<Harness />);
        act(() => {
            touch('touchstart', [
                { id: 1, x: 100, y: 300 },
                { id: 2, x: 220, y: 300 },
            ]);
            map.emit('zoomstart', { originalEvent: new Event('touchmove') });
            vi.advanceTimersByTime(700);
        });
        lift();
        expect(latest.on).toBe(false);
        act(() => {
            touch('touchstart', [
                { id: 1, x: 100, y: 300 },
                { id: 2, x: 220, y: 300 },
            ]);
            // Following the boat, or a storm's centre lock: no originalEvent.
            map.emit('zoomstart', {});
            vi.advanceTimersByTime(700);
        });
        lift();
        expect(latest.on).toBe(true);
    });

    it('do nothing while a mode owns the chart, with a dialog open, or with the Preferences switch off', () => {
        const { rerender } = render(<Harness modeOwnsChart />);
        twoFingerHold();
        lift();
        expect(latest.on).toBe(false);
        rerender(<Harness />);
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.getClientRects = () => [{}] as unknown as DOMRectList;
        document.body.append(dialog);
        twoFingerHold();
        lift();
        expect(latest.on).toBe(false);
        dialog.remove();
        rerender(<Harness holdGesture={false} />);
        twoFingerHold();
        lift();
        expect(latest.on).toBe(false);
        // The switch is the gesture's alone: the keyboard still clears.
        act(() => {
            fireEvent.keyDown(document.body, { key: 'h' });
        });
        expect(latest.on).toBe(true);
    });
});

describe('everything that brings the controls back', () => {
    it('MOB or any mode taking the chart, and leaving Obs', () => {
        const { rerender } = render(<Harness />);
        twoFingerHold();
        lift();
        expect(latest.on).toBe(true);
        rerender(<Harness modeOwnsChart />);
        expect(latest.on).toBe(false);
        rerender(<Harness />);
        twoFingerHold();
        lift();
        rerender(<Harness available={false} />);
        expect(latest.on).toBe(false);
    });

    it('any alarm', async () => {
        render(<Harness />);
        twoFingerHold();
        lift();
        expect(latest.on).toBe(true);
        await act(async () => {
            // The web alarm needs an AudioContext jsdom lacks; the controls come back regardless.
            await AlarmAudioService.acquire('collision-alarm')
                .then((token) => AlarmAudioService.release(token))
                .catch(() => undefined);
        });
        expect(latest.on).toBe(false);
    });

    it('the app going to the background', () => {
        render(<Harness />);
        twoFingerHold();
        lift();
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        expect(latest.on).toBe(false);
    });

    it('is never saved: a fresh Obs opens with its controls', () => {
        const { unmount } = render(<Harness />);
        twoFingerHold();
        lift();
        expect(latest.on).toBe(true);
        unmount();
        render(<Harness />);
        expect(latest.on).toBe(false);
        // Only the hint's "seen" is kept on the phone.
        expect(Object.keys({ ...window.localStorage })).toEqual([CLEAR_VIEW_HINT_KEY]);
    });
});

describe('keyboard, VoiceOver and the first-time hint', () => {
    it('H toggles and Escape brings the controls back, but not from a text field', () => {
        render(<Harness />);
        act(() => {
            fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: 'h' });
        });
        expect(latest.on).toBe(false);
        act(() => {
            fireEvent.keyDown(document.body, { key: 'H' });
        });
        expect(latest.on).toBe(true);
        act(() => {
            fireEvent.keyDown(document.body, { key: 'Escape' });
        });
        expect(latest.on).toBe(false);
        act(() => {
            fireEvent.keyDown(document.body, { key: 'h' });
        });
        act(() => {
            fireEvent.keyDown(document.activeElement ?? document.body, { key: 'h' });
        });
        expect(latest.on).toBe(false);
    });

    it('a hidden "Clear the screen" button for VoiceOver, and "Controls hidden" takes the focus', () => {
        render(<Harness />);
        const clear = screen.getByRole('button', { name: 'Clear the screen' });
        expect(clear).toHaveClass('sr-only');
        act(() => clear.click());
        const back = screen.getByRole('button', { name: 'Controls hidden. Double tap to show' });
        expect(back).toHaveClass('sr-only');
        expect(document.activeElement).toBe(back);
        act(() => back.click());
        expect(latest.on).toBe(false);
    });

    it('"Tap anywhere to bring the controls back" shows the first time on this phone only', () => {
        const { unmount } = render(<Harness />);
        twoFingerHold();
        lift();
        expect(screen.getByTestId('clear-view-hint')).toHaveTextContent('Tap anywhere to bring the controls back');
        act(() => {
            vi.advanceTimersByTime(4_100);
        });
        expect(screen.queryByTestId('clear-view-hint')).toBeNull();
        unmount();
        render(<Harness />);
        twoFingerHold();
        lift();
        expect(screen.queryByTestId('clear-view-hint')).toBeNull();
    });

    it('keeps the tab bar in split view, where it is The Glass’s too', () => {
        const pane = document.createElement('main');
        pane.dataset.splitPane = 'chart';
        document.body.append(pane);
        render(<Harness />, { container: pane.appendChild(document.createElement('div')) });
        twoFingerHold();
        lift();
        expect(latest.on).toBe(true);
        expect(document.documentElement.classList.contains(CLEAR_VIEW_ROOT_CLASS)).toBe(false);
        pane.remove();
    });
});

describe('what the stylesheet hides and keeps', () => {
    const css = readFileSync('index.css', 'utf8');
    const block = css.slice(css.indexOf('/* ── Clear view on Obs (129-13)'), css.indexOf('/* ── Chart map credits'));

    it('hides the frame’s controls, the storm card, the scale and the tab bar, in place', () => {
        expect(block).toContain(
            "[data-obs-clear-view='on'] > :not(.thalassa-chart-map, [data-clear-view-keep], [data-map-credit])",
        );
        expect(block).toContain("[data-obs-clear-view='on'] > .thalassa-chart-map > .storm-hud-badges");
        expect(block).toContain('.mapboxgl-ctrl-scale');
        expect(block).toContain('html.thalassa-obs-clear-view [data-thalassa-tab-bar]');
        // The chart page's corner controls App.tsx draws beside the frame (status, Calypso, offline).
        expect(block).toContain("main:has([data-obs-clear-view='on']) [data-obs-chrome]");
        expect(readFileSync('App.tsx', 'utf8').match(/data-obs-chrome=""/g)).toHaveLength(2);
        // visibility, never display: the map keeps its size and nothing moves.
        expect(block).not.toMatch(/display:\s*none/);
        // Mapbox's wordmark and attribution are never named, so never hidden.
        expect(block).not.toMatch(/mapboxgl-ctrl-(attrib|logo)/);
    });

    it('keeps MOB, the credits and the scrubber', () => {
        expect(block).toContain("[data-obs-clear-view='on'] :is([data-clear-view-keep], [data-map-credit])");
        expect(readFileSync('components/map/RadialHelmMenu.tsx', 'utf8')).toMatch(
            /data-clear-view-keep=""\s+aria-label=\{\s+tacticalState\.mobActive/,
        );
        expect(readFileSync('App.tsx', 'utf8').match(/data-thalassa-tab-bar=""/g)).toHaveLength(2);
    });
});
