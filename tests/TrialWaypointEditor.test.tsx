import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrialWaypointEditor, type TrialWaypointEditorProps } from '../components/autorouting/TrialWaypointEditor';
import { formatLatDegMin, formatLonDegMin } from '../utils/formatDegMin';

const props = (): TrialWaypointEditorProps => ({
    waypointNumber: 8,
    coordinates: [153.092, -27.21],
    moving: false,
    candidate: null,
    onBeginMove: vi.fn(),
    onConfirmMove: vi.fn(),
    onCancelMove: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
});

describe('TrialWaypointEditor', () => {
    it('shows the selected waypoint coordinates and delegates actions', () => {
        const p = props();
        render(<TrialWaypointEditor {...p} />);
        expect(screen.getByRole('heading', { name: 'Waypoint 8' })).toBeVisible();
        expect(screen.getByText(formatLatDegMin(p.coordinates[1]))).toBeVisible();
        expect(screen.getByText(formatLonDegMin(p.coordinates[0]))).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Move' }));
        fireEvent.click(screen.getByRole('button', { name: 'Show on chart' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close waypoint editor' }));
        expect(p.onBeginMove).toHaveBeenCalledOnce();
        expect(p.onFocus).toHaveBeenCalledOnce();
        expect(p.onClose).toHaveBeenCalledOnce();
    });
    it('explains locked profile pins and cannot offer a move', () => {
        const p = props();
        render(<TrialWaypointEditor {...p} lockedReason="Verified canal gate is fixed." />);
        const button = screen.getByRole('button', { name: 'Move' });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription('Verified canal gate is fixed.');
        fireEvent.click(button);
        expect(p.onBeginMove).not.toHaveBeenCalled();
    });
    it('requires a candidate before confirmation and keeps the recheck qualification visible', () => {
        const p = props();
        const { rerender } = render(<TrialWaypointEditor {...p} moving />);
        expect(screen.getByText('Tap chart to place waypoint.')).toBeVisible();
        expect(screen.getByText('Moving restarts chart checks. Provider checks no longer apply.')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Confirm move' })).toBeDisabled();
        const candidate: [number, number] = [153.1, -27.3];
        rerender(<TrialWaypointEditor {...p} moving candidate={candidate} />);
        expect(screen.getByText(formatLatDegMin(candidate[1]))).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
        expect(p.onConfirmMove).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(p.onCancelMove).toHaveBeenCalledOnce();
    });
    it('displays validation errors without claiming the candidate is safe', () => {
        render(<TrialWaypointEditor {...props()} moving error="This point is outside mapped water." />);
        expect(screen.getByRole('alert')).toHaveTextContent('This point is outside mapped water.');
        expect(screen.getByRole('button', { name: 'Confirm move' })).toBeDisabled();
    });
    it('offers undo only with a checkpoint and outside an unconfirmed move', () => {
        const p = props();
        const onUndo = vi.fn();
        const { rerender } = render(<TrialWaypointEditor {...p} />);
        expect(screen.queryByRole('button', { name: /Undo last move/ })).not.toBeInTheDocument();
        rerender(<TrialWaypointEditor {...p} onUndo={onUndo} />);
        fireEvent.click(screen.getByRole('button', { name: /Undo last move/ }));
        expect(onUndo).toHaveBeenCalledOnce();
        rerender(<TrialWaypointEditor {...p} onUndo={onUndo} moving />);
        expect(screen.queryByRole('button', { name: /Undo last move/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    });
});
