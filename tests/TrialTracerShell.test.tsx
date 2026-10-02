import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    TRACER_MIN_BODY_PX,
    TrialTracerShell,
    tracerNeedsSingleScroll,
} from '../components/autorouting/TrialTracerShell';

const warning = 'Unsaved trial proposal · not for navigation.';

describe('TrialTracerShell', () => {
    it('uses the manual Tracer heading while identifying auto trial separately', () => {
        const onToggle = vi.fn();
        const toggleRef = React.createRef<HTMLButtonElement>();
        render(
            <TrialTracerShell expanded onToggle={onToggle} warning={warning} panelId="trial-body" toggleRef={toggleRef}>
                <button type="button">Inspect a waypoint</button>
            </TrialTracerShell>,
        );
        const toggle = screen.getByRole('button', { name: 'Collapse tracer panel' });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(toggle).toHaveAttribute('aria-controls', 'trial-body');
        expect(screen.getByText('Auto · Trial')).toBeVisible();
        expect(toggleRef.current).toBe(toggle);
        fireEvent.click(toggle);
        expect(onToggle).toHaveBeenCalledTimes(1);
    });
    it('folds only the body; trial qualification and danger remain visible', () => {
        render(
            <TrialTracerShell
                expanded={false}
                onToggle={() => undefined}
                warning={warning}
                status="Danger reported · inspect route"
                statusTone="danger"
                collapsedControls={<button type="button">Undo edit</button>}
                footer={<button type="button">Save reviewed plan</button>}
            >
                <button type="button">Inspect a waypoint</button>
            </TrialTracerShell>,
        );
        expect(screen.getByText(warning)).toBeVisible();
        expect(screen.getByRole('status')).toHaveTextContent('Danger reported');
        expect(screen.getByRole('region', { name: 'Autorouting controls' })).toHaveAttribute(
            'data-status-tone',
            'danger',
        );
        expect(screen.queryByRole('button', { name: 'Inspect a waypoint' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save reviewed plan' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Undo edit' })).toBeVisible();
    });
    it('returns keyboard focus from newly hidden controls to the fold button', () => {
        const props = { onToggle: () => undefined, warning };
        const { rerender } = render(
            <TrialTracerShell {...props} expanded>
                <button type="button">Edit waypoint</button>
            </TrialTracerShell>,
        );
        screen.getByRole('button', { name: 'Edit waypoint' }).focus();
        rerender(
            <TrialTracerShell {...props} expanded={false}>
                <button type="button">Edit waypoint</button>
            </TrialTracerShell>,
        );
        expect(screen.getByRole('button', { name: 'Expand tracer panel' })).toHaveFocus();
    });
    it('keeps setup/review navigation inside the fold and restores keyboard focus', () => {
        const props = { onToggle: vi.fn(), warning, navigation: <button type="button">Review</button> };
        const { rerender } = render(
            <TrialTracerShell {...props} expanded>
                <p>Details</p>
            </TrialTracerShell>,
        );
        screen.getByRole('button', { name: 'Review' }).focus();
        rerender(
            <TrialTracerShell {...props} expanded={false}>
                <p>Details</p>
            </TrialTracerShell>,
        );
        expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Expand tracer panel' })).toHaveFocus();
        expect(screen.getByText(warning)).toBeVisible();
    });
    it('keeps chart wheel and touch gestures outside the card scroller', () => {
        const onWheel = vi.fn(),
            onTouchMove = vi.fn();
        render(
            <div onWheel={onWheel} onTouchMove={onTouchMove}>
                <TrialTracerShell expanded onToggle={() => undefined} warning={warning}>
                    <p>Waypoint details</p>
                </TrialTracerShell>
            </div>,
        );
        fireEvent.wheel(screen.getByText('Waypoint details'));
        fireEvent.touchMove(screen.getByText('Waypoint details'));
        expect(onWheel).not.toHaveBeenCalled();
        expect(onTouchMove).not.toHaveBeenCalled();
    });
    it('scrolls the whole card as one when the fixed rows starve the body (CI 36920384778)', () => {
        // The 1024 split on Linux fonts: a 317 px card whose wrapped status,
        // warning, tabs and actions took 302 px, leaving a 15 px body.
        expect(tracerNeedsSingleScroll(317, 302)).toBe(true);
        expect(tracerNeedsSingleScroll(317, 317 - TRACER_MIN_BODY_PX)).toBe(false);
        expect(tracerNeedsSingleScroll(736, 270)).toBe(false);
        // Unmeasured (jsdom, hidden): never switch layouts on a zero height.
        expect(tracerNeedsSingleScroll(0, 0)).toBe(false);
    });
    it('marks a short card single-scroll and keeps the warning and fold handle in it', () => {
        const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
            this: HTMLElement,
        ) {
            return this.classList.contains('trial-tracer-shell') ? 200 : 0;
        });
        const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
            this: HTMLElement,
        ) {
            return /trial-tracer-(heading|status|warning|footer)/.test(this.className) ? 30 : 0;
        });
        try {
            const props = { onToggle: () => undefined, warning, status: 'Chart checks complete · review required' };
            const { rerender } = render(
                <TrialTracerShell {...props} expanded footer={<button type="button">Clear</button>}>
                    <label>
                        Longitude
                        <input aria-label="destination longitude" />
                    </label>
                </TrialTracerShell>,
            );
            const card = screen.getByRole('region', { name: 'Autorouting controls' });
            // 200 px card - 4 x 30 px fixed rows = 80 px of body < 160 px.
            expect(card).toHaveAttribute('data-single-scroll', 'true');
            // The fold handle and 'Not for navigation' stay pinned: the CSS
            // reads their measured heights for the sticky offset and the
            // focus scroll-padding.
            expect(card.style.getPropertyValue('--tracer-heading-h')).toBe('30px');
            expect(card.style.getPropertyValue('--tracer-pinned-h')).toBe('60px');
            expect(screen.getByText(warning)).toBeVisible();
            expect(screen.getByRole('button', { name: 'Collapse tracer panel' })).toBeVisible();
            rerender(
                <TrialTracerShell {...props} expanded={false}>
                    <p>Folded</p>
                </TrialTracerShell>,
            );
            expect(card).not.toHaveAttribute('data-single-scroll');
        } finally {
            height.mockRestore();
            offset.mockRestore();
        }
    });
});
