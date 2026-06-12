/**
 * SlideToAction — Component tests.
 *
 * Gesture tests drive the pointer-event path directly. The track has no
 * layout in jsdom, so getBoundingClientRect is stubbed to a 300px track
 * (maxTravel = 300 - 56 = 244px; threshold 0.85 ⇒ confirm at ≥207.4px).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { SlideToAction } from '../components/ui/SlideToAction';

const TRACK_RECT = { left: 0, top: 0, right: 300, bottom: 56, width: 300, height: 56, x: 0, y: 0, toJSON: () => ({}) };

/** Render and return the track element with a real-sized rect stubbed in. */
function renderTrack(onConfirm: () => void, props: Partial<React.ComponentProps<typeof SlideToAction>> = {}) {
    const { container } = render(<SlideToAction label="Drop Anchor" thumbIcon="⚓" onConfirm={onConfirm} {...props} />);
    const track = container.firstElementChild as HTMLElement;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(TRACK_RECT as DOMRect);
    return { track, container };
}

const thumbOf = (track: HTMLElement): HTMLElement => track.querySelector('[class*="cursor-grab"]') as HTMLElement;

/** jsdom has no PointerEvent — fireEvent.pointer* drops clientX. Build
 *  MouseEvents with pointer type names so coordinates actually arrive
 *  (the component reads only type + clientX; pointerId is guarded). */
const pointer = (el: HTMLElement, type: string, clientX = 0): void => {
    fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
};

describe('SlideToAction', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<SlideToAction label="Start Tracking" thumbIcon="⚓" onConfirm={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('displays the label text', () => {
        render(<SlideToAction label="Set Anchor" thumbIcon="⚓" onConfirm={vi.fn()} />);
        expect(screen.getByText('Set Anchor')).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<SlideToAction label="Go" thumbIcon="⚓" onConfirm={vi.fn()} />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('does not throw on rerender', () => {
        expect(() => {
            const { rerender } = render(<SlideToAction label="Slide" thumbIcon="⚓" onConfirm={vi.fn()} />);
            rerender(<SlideToAction label="Slide" thumbIcon="⚓" onConfirm={vi.fn()} />);
        }).not.toThrow();
    });

    // ── Gesture behaviour (field bug 2026-06-13: thumb froze mid-track) ──

    it('full slide past the threshold confirms and resets the thumb', () => {
        const onConfirm = vi.fn();
        const { track } = renderTrack(onConfirm);
        pointer(track, 'pointerdown', 28);
        pointer(track, 'pointermove', 290);
        pointer(track, 'pointerup');
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(thumbOf(track).style.transform).toBe('translateX(0px)');
    });

    it('short slide springs back without confirming', () => {
        const onConfirm = vi.fn();
        const { track } = renderTrack(onConfirm);
        pointer(track, 'pointerdown', 28);
        pointer(track, 'pointermove', 150);
        pointer(track, 'pointerup');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(thumbOf(track).style.transform).toBe('translateX(0px)');
    });

    it('pointercancel mid-drag springs back instead of freezing (the stuck-at-3/4 bug)', () => {
        const onConfirm = vi.fn();
        const { track } = renderTrack(onConfirm);
        pointer(track, 'pointerdown', 28);
        pointer(track, 'pointermove', 210);
        expect(thumbOf(track).style.transform).not.toBe('translateX(0px)');
        // iOS cancels the touch (system gesture / notification banner)
        pointer(track, 'pointercancel');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(thumbOf(track).style.transform).toBe('translateX(0px)');
        // and the NEXT gesture still works
        pointer(track, 'pointerdown', 28);
        pointer(track, 'pointermove', 290);
        pointer(track, 'pointerup');
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('cancel past the threshold still never confirms', () => {
        const onConfirm = vi.fn();
        const { track } = renderTrack(onConfirm);
        pointer(track, 'pointerdown', 28);
        pointer(track, 'pointermove', 290);
        pointer(track, 'pointercancel');
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('disabled slider ignores the whole gesture', () => {
        const onConfirm = vi.fn();
        const { track } = renderTrack(onConfirm, { disabled: true });
        pointer(track, 'pointerdown', 28);
        pointer(track, 'pointermove', 290);
        pointer(track, 'pointerup');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(thumbOf(track).style.transform).toBe('translateX(0px)');
    });
});
