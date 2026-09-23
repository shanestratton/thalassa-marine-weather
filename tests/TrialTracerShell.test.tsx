import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrialTracerShell } from '../components/autorouting/TrialTracerShell';

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
});
