import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanePortalContext } from '../context/PanePortalContext';
import { useRadioSelectorAnchor } from '../components/vessel/useRadioSelectorAnchor';

function Probe() {
    const { selectorRef, anchor } = useRadioSelectorAnchor();
    return (
        <>
            <div ref={selectorRef} data-testid="anchor" />
            <output data-testid="measurement">{JSON.stringify(anchor)}</output>
        </>
    );
}

function bounds(left: number, top: number, width: number): DOMRect {
    return { left, top, width, height: 72, x: left, y: top, right: left + width, bottom: top + 72, toJSON: () => ({}) };
}

function controlledAnimationFrames() {
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback: FrameRequestCallback) => {
            pending.set(++nextId, callback);
            return nextId;
        }),
    );
    vi.stubGlobal(
        'cancelAnimationFrame',
        vi.fn((id: number) => pending.delete(id)),
    );
    return {
        pending,
        flush() {
            const callbacks = [...pending.values()];
            pending.clear();
            act(() => callbacks.forEach((callback) => callback(0)));
        },
    };
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('radio call-selector portal anchor', () => {
    it('reserves the actual app header above a radio dialog, without moving call buttons', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return bounds(16, this.dataset.testid === 'radio-console-page' ? 102 : 174, 358);
        });
        render(
            <div data-testid="radio-console-page">
                <Probe />
            </div>,
        );
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({
            left: 16,
            top: 174,
            width: 358,
            dialogTop: 102,
        });
    });
    it('retains phone page coordinates below app chrome instead of assuming a header height', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds(16, 174, 358));
        render(<Probe />);
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 174, width: 358 });
    });

    it('subtracts the owning pane origin, including its border, and follows viewport reflow', () => {
        const host = document.createElement('div');
        const frame = document.createElement('div');
        const scope = { id: 'page', host, frameRef: { current: frame }, contentRef: { current: frame } };
        let selector = bounds(578, 214, 414);
        let origin = bounds(562, 138, 446);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return this === host ? origin : selector;
        });
        render(
            <PanePortalContext.Provider value={scope}>
                <Probe />
            </PanePortalContext.Provider>,
        );
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 76, width: 414 });

        selector = bounds(496, 188, 352);
        origin = bounds(480, 116, 384);
        fireEvent.resize(window);
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 72, width: 352 });
        selector = bounds(496, 176, 352);
        fireEvent.scroll(window);
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 60, width: 352 });
    });

    it('follows delayed page-entry phase and transform changes without a resize or running animation', async () => {
        const frames = controlledAnimationFrames();
        let selector = bounds(406, 174, 358);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => selector);
        render(
            <div
                data-testid="transition"
                data-transition-phase="entering"
                style={{ transform: 'translate3d(100%, 0, 0)', transition: 'none' }}
            >
                <Probe />
            </div>,
        );
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 406, top: 174, width: 358 });

        // PageTransition waits two animation frames before starting its CSS
        // transition. During that gap getAnimations() has no running entry;
        // transform-only movement never triggers our inert ResizeObserver mock.
        const transition = screen.getByTestId('transition');
        await act(async () => {
            transition.dataset.transitionPhase = 'animating';
            transition.style.transform = 'translate3d(0, 0, 0)';
            transition.style.transition = 'transform 280ms ease-out';
            selector = bounds(16, 174, 358);
            await Promise.resolve();
        });
        frames.flush();
        await act(async () => {
            transition.dataset.transitionPhase = 'idle';
            transition.style.transform = 'none';
            transition.style.transition = 'none';
            await Promise.resolve();
        });
        frames.flush();
        expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({ left: 16, top: 174, width: 358 });
    });

    it.each(['transitionend', 'transitioncancel'])(
        'remeasures the settled rectangle on %s without a resize',
        (eventName) => {
            let selector = bounds(406, 174, 358);
            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => selector);
            render(
                <div data-testid="transition">
                    <Probe />
                </div>,
            );
            expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({
                left: 406,
                top: 174,
                width: 358,
            });

            // No attribute mutation accompanies this event: the compositor has
            // finished (or cancelled) movement whose final layout must be sampled.
            selector = bounds(16, 174, 358);
            fireEvent(screen.getByTestId('transition'), new Event(eventName, { bubbles: true }));
            expect(JSON.parse(screen.getByTestId('measurement').textContent!)).toEqual({
                left: 16,
                top: 174,
                width: 358,
            });
        },
    );

    it('disconnects ancestor observations, transition listeners and pending frames on unmount', async () => {
        const frames = controlledAnimationFrames();
        const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds(406, 174, 358));
        const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
        const addListener = vi.spyOn(document, 'addEventListener');
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const view = render(
            <div data-testid="transition">
                <Probe />
            </div>,
        );
        const transition = screen.getByTestId('transition');
        Object.defineProperty(transition, 'getAnimations', { value: () => [{ playState: 'running' }] });
        fireEvent.resize(window);
        expect(frames.pending.size).toBeGreaterThan(0);

        view.unmount();
        expect(disconnect).toHaveBeenCalled();
        expect(frames.pending.size).toBe(0);
        for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) {
            const registration = addListener.mock.calls.find(([eventName]) => eventName === type);
            expect(registration).toBeDefined();
            expect(removeListener).toHaveBeenCalledWith(type, registration![1], true);
        }
        measure.mockClear();
        await act(async () => {
            transition.dataset.transitionPhase = 'idle';
            transition.style.transform = 'none';
            document.dispatchEvent(new Event('transitionend'));
            document.dispatchEvent(new Event('transitioncancel'));
            window.dispatchEvent(new Event('resize'));
            await Promise.resolve();
        });
        frames.flush();
        expect(measure).not.toHaveBeenCalled();
    });
});
