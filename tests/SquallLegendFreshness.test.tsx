import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SquallLegend } from '../components/map/SquallLegend';
import { squallSnapshotTimeMs, squallStatusStore } from '../services/weather/squallStatus';

const NOW = Date.parse('2026-09-27T06:00:00Z');
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    squallStatusStore.reset();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('squall legend data honesty', () => {
    it('does not claim Live for a newly downloaded old snapshot, and keeps aging without new data', async () => {
        squallStatusStore.set({
            phase: 'ready',
            tilesReady: true,
            snapshotTimeMs: NOW - 60 * 60_000,
            fetchedAtMs: NOW,
        });
        const rendered = render(<SquallLegend visible />);
        expect(screen.getByText('Snapshot 1h 0m old')).toBeInTheDocument();
        expect(screen.queryByText('Live')).not.toBeInTheDocument();
        expect(screen.getByText('Heavy-rain proxy · Rainbow.ai')).toBeInTheDocument();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(screen.getByText('Snapshot 1h 1m old')).toBeInTheDocument();
        rendered.unmount();
    });

    it('updates immediately on loading/failure events and admits an unknown snapshot clock', () => {
        const rendered = render(<SquallLegend visible />);
        expect(screen.getByText('Not loaded')).toBeInTheDocument();
        act(() => squallStatusStore.set({ phase: 'loading' }));
        expect(screen.getByText('Loading precipitation…')).toBeInTheDocument();
        act(() => squallStatusStore.set({ phase: 'error', error: 'Squall precipitation tiles unavailable' }));
        expect(screen.getByRole('alert')).toHaveTextContent('tiles unavailable');
        act(() => squallStatusStore.set({ phase: 'ready', tilesReady: true, error: null }));
        expect(screen.getByText('Snapshot time unknown')).toBeInTheDocument();
        rendered.unmount();
    });

    it('only interprets plausible epoch seconds and does not hide old snapshot age', () => {
        expect(squallSnapshotTimeMs(123, NOW)).toBeNull();
        expect(squallSnapshotTimeMs(NOW, NOW)).toBeNull();
        expect(squallSnapshotTimeMs((NOW + 2 * 60 * 60_000) / 1000, NOW)).toBeNull();
        expect(squallSnapshotTimeMs((NOW - 48 * 60 * 60_000) / 1000, NOW)).toBe(NOW - 48 * 60 * 60_000);
    });
});
