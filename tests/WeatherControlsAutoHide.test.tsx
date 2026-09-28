import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWeatherControlsAutoHide, WEATHER_CONTROLS_IDLE_MS } from '../components/map/useWeatherControlsAutoHide';

interface HarnessProps {
    enabled?: boolean;
    initiallyHidden?: boolean;
    contextKey?: string;
    playbackFrame?: number;
    onChange?: (hidden: boolean) => void;
}

function Harness({
    enabled = true,
    initiallyHidden = false,
    contextKey = 'wind',
    playbackFrame = 0,
    onChange,
}: HarnessProps) {
    const [hidden, setHidden] = useState(initiallyHidden);
    const controls = useWeatherControlsAutoHide({
        enabled,
        hidden,
        contextKey,
        // Deliberately new on every render: the hook must use the newest callback
        // without restarting an idle timer for every playback frame.
        onHiddenChange: (next) => {
            onChange?.(next);
            setHidden(next);
        },
    });
    return (
        <>
            <button type="button">Outside</button>
            {hidden ? (
                <button type="button" ref={controls.triggerRef} onClick={controls.show}>
                    Reopen weather
                </button>
            ) : (
                <section ref={controls.panelRef} {...controls.interactionProps} aria-label="Weather panel">
                    <output aria-label="Playback frame">{playbackFrame}</output>
                    <button type="button">Model</button>
                    <button type="button">Play</button>
                    <input type="range" aria-label="Timeline" defaultValue="0" />
                    <select aria-label="Mooring colour" defaultValue="all">
                        <option value="all">All</option>
                        <option value="blue">Blue</option>
                    </select>
                    <input aria-label="Search" />
                    <textarea aria-label="Notes" />
                    <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Editable caption" />
                    <button type="button" onClick={controls.hide}>
                        Hide weather
                    </button>
                </section>
            )}
        </>
    );
}

function advance(ms: number) {
    act(() => vi.advanceTimersByTime(ms));
}
function focus(element: HTMLElement) {
    act(() => element.focus());
}
function pointer(target: Element | Document, type: 'pointerdown' | 'pointerup' | 'pointercancel', id = 1) {
    // jsdom's PointerEvent support varies; retain the actual pointer identity
    // instead of silently testing a Set containing only undefined.
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    fireEvent(target, event);
}
const panel = () => screen.queryByRole('region', { name: 'Weather panel' });

describe('useWeatherControlsAutoHide', () => {
    let documentHidden = false;
    beforeEach(() => {
        vi.useFakeTimers();
        documentHidden = false;
        vi.spyOn(document, 'hidden', 'get').mockImplementation(() => documentHidden);
    });
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('hides at six seconds of idle and gives a reopened panel a full fresh window', () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        expect(WEATHER_CONTROLS_IDLE_MS).toBe(6_000);
        advance(5_999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
        expect(onChange).toHaveBeenLastCalledWith(true);
        expect(vi.getTimerCount()).toBe(0);
        fireEvent.click(screen.getByRole('button', { name: 'Reopen weather' }));
        expect(onChange).toHaveBeenLastCalledWith(false);
        advance(5_999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
        expect(onChange.mock.calls).toEqual([[true], [false], [true]]);
    });

    it('does not postpone hiding for playback updates or callback identity changes, and calls the latest callback', () => {
        const first = vi.fn();
        const latest = vi.fn();
        const view = render(<Harness playbackFrame={0} onChange={first} />);
        for (let frame = 1; frame <= 5; frame++) {
            advance(1_000);
            view.rerender(<Harness playbackFrame={frame} onChange={latest} />);
        }
        expect(screen.getByLabelText('Playback frame')).toHaveTextContent('5');
        advance(999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
        expect(first).not.toHaveBeenCalled();
        expect(latest).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('gives a changed layer context a fresh idle window when there is no active interaction', () => {
        const view = render(<Harness contextKey="wind" />);
        advance(5_000);
        view.rerender(<Harness contextKey="rain" />);
        advance(5_999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
    });

    it.each(['pointerup', 'pointercancel'] as const)(
        'keeps a held pointer across context changes until %s, then restores focus on hiding',
        (release) => {
            const view = render(<Harness contextKey="wind" />);
            const range = screen.getByRole('slider', { name: 'Timeline' });
            pointer(range, 'pointerdown', 17);
            focus(range);
            advance(12_000);
            view.rerender(<Harness contextKey="rain" playbackFrame={10} />);
            advance(12_000);
            expect(panel()).toBeVisible();
            expect(vi.getTimerCount()).toBe(0);
            pointer(document, release, 17);
            advance(5_999);
            expect(panel()).toBeVisible();
            advance(1);
            expect(screen.getByRole('button', { name: 'Reopen weather' })).toHaveFocus();
        },
    );

    it('waits for every held pointer, not just the first release', () => {
        render(<Harness />);
        const range = screen.getByRole('slider', { name: 'Timeline' });
        pointer(range, 'pointerdown', 1);
        pointer(range, 'pointerdown', 2);
        pointer(document, 'pointerup', 1);
        advance(12_000);
        expect(panel()).toBeVisible();
        pointer(document, 'pointercancel', 2);
        advance(6_000);
        expect(panel()).not.toBeInTheDocument();
    });

    it('preserves keyboard focus across context changes and internal focus moves until focus leaves the panel', () => {
        const view = render(<Harness contextKey="wind" />);
        const model = screen.getByRole('button', { name: 'Model' });
        focus(model);
        fireEvent.keyDown(model, { key: 'ArrowRight' });
        view.rerender(<Harness contextKey="pressure" />);
        advance(12_000);
        focus(screen.getByRole('button', { name: 'Play' }));
        advance(12_000);
        expect(panel()).toBeVisible();
        expect(vi.getTimerCount()).toBe(0);
        focus(screen.getByRole('button', { name: 'Outside' }));
        advance(5_999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
    });

    it.each(['Mooring colour', 'Search', 'Notes', 'Editable caption'])(
        'keeps pointer-focused native/editable %s open across a context change',
        (name) => {
            const view = render(<Harness contextKey="wind" />);
            const field = screen.getByLabelText(name);
            pointer(field, 'pointerdown', 7);
            focus(field);
            pointer(document, 'pointerup', 7);
            view.rerender(<Harness contextKey="currents" />);
            advance(18_000);
            expect(panel()).toBeVisible();
            expect(vi.getTimerCount()).toBe(0);
            focus(screen.getByRole('button', { name: 'Outside' }));
            advance(6_000);
            expect(panel()).not.toBeInTheDocument();
        },
    );

    it('releases a keyboard hold when a pointer begins outside, without requiring another panel event', () => {
        render(<Harness />);
        focus(screen.getByRole('button', { name: 'Model' }));
        advance(8_000);
        pointer(screen.getByRole('button', { name: 'Outside' }), 'pointerdown', 9);
        advance(6_000);
        expect(panel()).not.toBeInTheDocument();
    });

    it.each(['click', 'input', 'change', 'scroll', 'wheel'] as const)(
        'restarts idle time after a genuine %s interaction',
        (type) => {
            render(<Harness />);
            advance(5_000);
            if (type === 'change') {
                // React's change plugin requires an actual editable target;
                // a synthetic change dispatched on the section is ignored.
                fireEvent.change(screen.getByRole('combobox', { name: 'Mooring colour' }), {
                    target: { value: 'blue' },
                });
            } else fireEvent(panel()!, new Event(type, { bubbles: true }));
            advance(5_999);
            expect(panel()).toBeVisible();
            advance(1);
            expect(panel()).not.toBeInTheDocument();
        },
    );

    it('pauses while the document is hidden and starts a full window on visibility resume', () => {
        render(<Harness />);
        advance(5_000);
        documentHidden = true;
        fireEvent(document, new Event('visibilitychange'));
        expect(vi.getTimerCount()).toBe(0);
        advance(60_000);
        expect(panel()).toBeVisible();
        fireEvent(window, new Event('focus'));
        expect(vi.getTimerCount()).toBe(0);
        documentHidden = false;
        fireEvent(document, new Event('visibilitychange'));
        advance(5_999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
    });

    it('pauses on window blur and resumes idle time on focus', () => {
        render(<Harness />);
        advance(4_000);
        fireEvent(window, new Event('blur'));
        advance(12_000);
        expect(panel()).toBeVisible();
        fireEvent(window, new Event('focus'));
        advance(5_999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
    });

    it.each([
        { enabled: false, initiallyHidden: false },
        { enabled: true, initiallyHidden: true },
        { enabled: false, initiallyHidden: true },
    ])('does not create an idle timer when disabled or already hidden: %s', (props) => {
        const onChange = vi.fn();
        render(<Harness {...props} onChange={onChange} />);
        expect(vi.getTimerCount()).toBe(0);
        fireEvent(window, new Event('focus'));
        fireEvent(document, new Event('visibilitychange'));
        advance(60_000);
        expect(onChange).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels an existing timer when disabled and starts fresh after re-enabling', () => {
        const view = render(<Harness />);
        advance(5_000);
        view.rerender(<Harness enabled={false} />);
        expect(vi.getTimerCount()).toBe(0);
        advance(60_000);
        expect(panel()).toBeVisible();
        view.rerender(<Harness enabled />);
        advance(5_999);
        expect(panel()).toBeVisible();
        advance(1);
        expect(panel()).not.toBeInTheDocument();
    });

    it('restores focus to the summary trigger after explicit hiding from a keyboard-focused control', () => {
        render(<Harness />);
        const hide = screen.getByRole('button', { name: 'Hide weather' });
        focus(hide);
        fireEvent.click(hide);
        expect(screen.getByRole('button', { name: 'Reopen weather' })).toHaveFocus();
        // jsdom schedules zero-delay selection bookkeeping on focus changes.
        advance(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('removes global listeners and cancels timers on unmount without later callbacks', () => {
        const added = vi.spyOn(document, 'addEventListener');
        const removed = vi.spyOn(document, 'removeEventListener');
        const windowAdded = vi.spyOn(window, 'addEventListener');
        const windowRemoved = vi.spyOn(window, 'removeEventListener');
        const onChange = vi.fn();
        const view = render(<Harness onChange={onChange} />);
        advance(5_000);
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'keydown', 'visibilitychange']) {
            const call = added.mock.calls.find(([event]) => event === type)!;
            expect(call).toBeDefined();
            expect(removed).toHaveBeenCalledWith(...call);
        }
        for (const type of ['blur', 'focus']) {
            const call = windowAdded.mock.calls.find(([event]) => event === type)!;
            expect(call).toBeDefined();
            expect(windowRemoved).toHaveBeenCalledWith(...call);
        }
        fireEvent(window, new Event('focus'));
        fireEvent(document, new Event('visibilitychange'));
        pointer(document, 'pointerup');
        advance(60_000);
        expect(onChange).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
