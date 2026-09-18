/**
 * The look-ahead scrubber along the bottom of the chart.
 *
 * Shane 2026-09-17: "a scrubber along the bottom … the vessel going along the
 * route as its normal cruising speed". 2026-09-18: seven days, and a button to
 * change the model.
 *
 * A thumb on a moving boat is a blunt instrument: the whole track must take a
 * touch, both ends must be reachable exactly, and Play must stop at the end
 * rather than throw the ghost back onto the boat.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { RouteTimeScrubber, fmtAhead, type RouteTimeScrubberProps } from '../components/passage/RouteTimeScrubber';

const HOUR = 3_600_000;
const NOW = new Date(2026, 8, 18, 9, 0, 0).getTime(); // a Friday, 09:00 local

// jsdom has no PointerEvent, so fireEvent.pointerDown arrives without a clientX.
// A MouseEvent of the same TYPE carries one, and React listens by type.
const pointer = (el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX?: number) =>
    act(() => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
    });

const setup = (over: Partial<RouteTimeScrubberProps> = {}) => {
    const props: RouteTimeScrubberProps = {
        aheadMs: 0,
        maxMs: 20 * HOUR,
        endsAtArrival: true,
        playing: false,
        nowMs: NOW,
        windCoverageHours: null,
        modelLabel: 'ECMWF',
        modelProvider: 'ECMWF',
        cruiseKts: 6,
        onAhead: vi.fn(),
        onPlaying: vi.fn(),
        onOpenModel: vi.fn(),
        ...over,
    };
    const view = render(<RouteTimeScrubber {...props} />);
    const track = screen.getByTestId('route-scrub-track');
    // jsdom lays nothing out: give the track a box to be touched in.
    track.getBoundingClientRect = () =>
        ({ left: 100, width: 200, top: 0, right: 300, bottom: 28, height: 28, x: 100, y: 0, toJSON() {} }) as DOMRect;
    return { props, track, ...view };
};

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('what it says', () => {
    it('shows the CLOCK time she will be there — the offset is on the strip and on the ghost', () => {
        setup({ aheadMs: 6 * HOUR });
        expect(screen.getByTestId('route-scrub-moment').textContent).toBe('Fri 15:00');
    });

    it('carries no LIVE button of its own: the strip beside it has the way back, and the track needs the width', () => {
        setup();
        expect(screen.queryByTestId('route-scrub-exit')).toBeNull();
        expect(screen.getByTestId('route-time-scrubber').querySelectorAll('button')).toHaveLength(2);
    });

    it('reads NOW at the start, minutes under the hour, days past two', () => {
        expect(fmtAhead(0)).toBe('NOW');
        expect(fmtAhead(25 * 60_000)).toBe('+25 min');
        expect(fmtAhead(6.5 * HOUR)).toBe('+6.5 h');
        expect(fmtAhead(48 * HOUR)).toBe('+2 d');
        expect(fmtAhead(75 * HOUR)).toBe('+3 d 3 h');
        expect(fmtAhead(7 * 24 * HOUR)).toBe('+7 d');
    });

    it('credits the forecast’s source beside the numbers, and NEVER truncates it — a licence condition', () => {
        setup({ modelLabel: 'UKMO', modelProvider: 'UK Met Office' });
        const credit = screen.getByTestId('route-scrub-credit');
        expect(credit.textContent).toBe('Forecast data: UK Met Office');
        // It may wrap on a narrow phone. It may not be cut off with an ellipsis.
        expect(credit.className).not.toMatch(/truncate|line-clamp|text-ellipsis|overflow-hidden|whitespace-nowrap/);
    });

    it('names the model on the button that changes it', () => {
        const { props } = setup({ modelLabel: 'ICON' });
        const button = screen.getByTestId('route-scrub-model');
        expect(button.textContent).toContain('ICON');
        fireEvent.click(button);
        expect(props.onOpenModel).toHaveBeenCalled();
    });

    it('is a slider to a screen reader, valued in the words a skipper would use', () => {
        const { track } = setup({ aheadMs: 3 * HOUR });
        expect(track.getAttribute('role')).toBe('slider');
        expect(track.getAttribute('aria-valuetext')).toBe('Fri 12:00 · +3 h');
        expect(track.getAttribute('aria-valuemax')).toBe(String(20 * 60));
    });
});

describe('where the chart’s wind stops', () => {
    it('marks how far the wind FIELD reaches, and says so once the ghost has sailed past it', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 60 * HOUR, endsAtArrival: true, windCoverageHours: 46.4 });
        expect(screen.getByTestId('route-scrub-coverage').style.width).toBe('46.4%');
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Chart wind ends +46 h — numbers continue');
    });

    it('says nothing about it while the ghost is inside the field, or when the wind layer is off', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 10 * HOUR, windCoverageHours: 46 });
        expect(screen.queryByTestId('route-scrub-note')).toBeNull();
        cleanup();
        setup({ maxMs: 100 * HOUR, aheadMs: 60 * HOUR, windCoverageHours: null });
        expect(screen.queryByTestId('route-scrub-note')).toBeNull();
        expect(screen.queryByTestId('route-scrub-coverage')).toBeNull();
    });

    it('at the end of the axis it says WHICH end: she arrives, or the forecast runs out', () => {
        setup({ aheadMs: 20 * HOUR, endsAtArrival: true });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Arrives, at 6.0 kn cruising');
        cleanup();
        setup({ maxMs: 168 * HOUR, aheadMs: 168 * HOUR, endsAtArrival: false });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Seven days — the forecast stops here');
    });
});

describe('chart layers that are NOT at this moment', () => {
    it('says so by name: their own time pills are stood down, so nothing else on the glass can', () => {
        setup({ aheadMs: 6 * HOUR, unsyncedLayers: ['rain', 'currents'] });
        expect(screen.getByTestId('route-scrub-unsynced').textContent).toBe(
            'Chart rain, currents: still at their own time',
        );
        cleanup();
        setup({ aheadMs: 6 * HOUR, unsyncedLayers: ['rain'] });
        expect(screen.getByTestId('route-scrub-unsynced').textContent).toBe('Chart rain: still at its own time');
    });

    it('is not said at NOW, when their time IS this time — and not at all when every layer follows', () => {
        setup({ aheadMs: 0, unsyncedLayers: ['rain'] });
        expect(screen.queryByTestId('route-scrub-unsynced')).toBeNull();
        cleanup();
        setup({ aheadMs: 6 * HOUR });
        expect(screen.queryByTestId('route-scrub-unsynced')).toBeNull();
    });

    it('does not push the wind-field note off the glass: both honesty notes show together', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 60 * HOUR, windCoverageHours: 46, unsyncedLayers: ['rain'] });
        expect(screen.getByTestId('route-scrub-unsynced')).toBeTruthy();
        expect(screen.getByTestId('route-scrub-note').textContent).toContain('Chart wind ends +46 h');
    });
});

describe('under a thumb', () => {
    it('a touch ANYWHERE on the track moves it there, on five-minute marks', () => {
        const { props, track } = setup();
        pointer(track, 'pointerdown', 150);
        expect(props.onAhead).toHaveBeenLastCalledWith(5 * HOUR);
        pointer(track, 'pointermove', 151);
        // 0.255 of 20 h = 5 h 06 min → the 5 h 05 mark
        expect(props.onAhead).toHaveBeenLastCalledWith(5 * HOUR + 5 * 60_000);
    });

    it('both ends are reachable exactly, and a drag off the end stays on it', () => {
        const { props, track } = setup({ maxMs: 20 * HOUR + 123_456 });
        pointer(track, 'pointerdown', 900);
        expect(props.onAhead).toHaveBeenLastCalledWith(20 * HOUR + 123_456);
        pointer(track, 'pointermove', -50);
        expect(props.onAhead).toHaveBeenLastCalledWith(0);
    });

    it('does not move on a hover — only between down and up', () => {
        const { props, track } = setup();
        pointer(track, 'pointermove', 250);
        expect(props.onAhead).not.toHaveBeenCalled();
        pointer(track, 'pointerdown', 150);
        pointer(track, 'pointerup');
        (props.onAhead as ReturnType<typeof vi.fn>).mockClear();
        pointer(track, 'pointermove', 250);
        expect(props.onAhead).not.toHaveBeenCalled();
    });

    it('taking hold of it stops Play', () => {
        const { props, track } = setup({ playing: true });
        pointer(track, 'pointerdown', 150);
        expect(props.onPlaying).toHaveBeenCalledWith(false);
    });

    it('steps an hour with the arrow keys, six with Shift or Page, and jumps with Home and End', () => {
        const { props, track } = setup({ aheadMs: 6 * HOUR });
        fireEvent.keyDown(track, { key: 'ArrowRight' });
        expect(props.onAhead).toHaveBeenLastCalledWith(7 * HOUR);
        fireEvent.keyDown(track, { key: 'ArrowLeft', shiftKey: true });
        expect(props.onAhead).toHaveBeenLastCalledWith(0);
        fireEvent.keyDown(track, { key: 'PageUp' });
        expect(props.onAhead).toHaveBeenLastCalledWith(12 * HOUR);
        fireEvent.keyDown(track, { key: 'End' });
        expect(props.onAhead).toHaveBeenLastCalledWith(20 * HOUR);
        fireEvent.keyDown(track, { key: 'Home' });
        expect(props.onAhead).toHaveBeenLastCalledWith(0);
    });

    it('a touch that carries no position is ignored, not turned into NaN for three followers', () => {
        const { props, track } = setup();
        fireEvent.pointerDown(track, { pointerId: 1 });
        expect(props.onAhead).not.toHaveBeenCalled();
    });

    it('a passage with nothing left to scrub is a dead slider, not a divide by zero', () => {
        const { props, track } = setup({ maxMs: 0 });
        pointer(track, 'pointerdown', 150);
        fireEvent.keyDown(track, { key: 'ArrowRight' });
        expect(props.onAhead).not.toHaveBeenCalled();
        expect(track.getAttribute('aria-disabled')).toBe('true');
        expect((screen.getByTestId('route-scrub-play') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('Play', () => {
    it('walks forward and STOPS at the end — it never throws the ghost back onto the boat', () => {
        vi.useFakeTimers();
        let ahead = 19 * HOUR;
        const onAhead = vi.fn((ms: number) => {
            ahead = ms;
        });
        const onPlaying = vi.fn();
        const { rerender, props } = setup({ aheadMs: ahead, playing: true, onAhead, onPlaying });
        for (let i = 0; i < 40 && !onPlaying.mock.calls.length; i++) {
            act(() => {
                vi.advanceTimersByTime(100);
            });
            rerender(<RouteTimeScrubber {...props} aheadMs={ahead} playing onAhead={onAhead} onPlaying={onPlaying} />);
        }
        expect(ahead).toBe(20 * HOUR);
        expect(onPlaying).toHaveBeenCalledWith(false);
        const calls = onAhead.mock.calls.map(([ms]) => ms as number);
        expect(calls.every((ms, i) => i === 0 || ms >= calls[i - 1])).toBe(true);
    });

    it('crosses a week in about the same time as a day: a sweep, not a wait', () => {
        vi.useFakeTimers();
        const { props } = setup({ maxMs: 168 * HOUR, playing: true });
        act(() => {
            vi.advanceTimersByTime(100);
        });
        // 168 h / 24 s × 0.1 s = 0.7 h a tick
        expect(props.onAhead).toHaveBeenLastCalledWith(0.7 * HOUR);
    });

    it('pressed at the end, it starts again from now', () => {
        const { props } = setup({ aheadMs: 20 * HOUR });
        fireEvent.click(screen.getByTestId('route-scrub-play'));
        expect(props.onAhead).toHaveBeenCalledWith(0);
        expect(props.onPlaying).toHaveBeenCalledWith(true);
    });
});
