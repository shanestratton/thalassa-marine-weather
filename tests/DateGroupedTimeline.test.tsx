import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateGroupedTimeline } from '../components/DateGroupedTimeline';
import type { ShipLogEntry } from '../types';
import type { GroupedEntries } from '../utils/voyageData';

afterEach(cleanup);

function entries(count: number): ShipLogEntry[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `entry-${index}`,
        voyageId: 'long-voyage',
        entryType: index === 50 ? 'manual' : 'auto',
        timestamp: new Date(Date.UTC(2026, 8, 10, 12) - index * 5_000).toISOString(),
        latitude: -27,
        longitude: 153,
        positionFormatted: `position-${index}`,
        speedKts: 6.4,
        courseDeg: 35,
        notes: `point-${index}`,
        distanceNM: 0.01,
        cumulativeDistanceNM: index / 100,
    })) as ShipLogEntry[];
}

function group(points: ShipLogEntry[], date = '2026-09-10'): GroupedEntries {
    return {
        date,
        displayDate: date,
        entries: points,
        stats: { totalDistance: 10, avgSpeed: 6.4, maxSpeed: 6.4, entryCount: points.length },
    };
}

function mountedRows(container: HTMLElement): number {
    return container.querySelectorAll('button[aria-label*=" log entry "][aria-expanded]').length;
}

describe('DateGroupedTimeline long voyages', () => {
    it('keeps a 10,000-point multi-day voyage within one global mounted-row budget', () => {
        const points = entries(10_000);
        const groups = Array.from({ length: 100 }, (_, index) =>
            group(points.slice(index * 100, (index + 1) * 100), `day-${index}`),
        );
        const { container } = render(<DateGroupedTimeline groupedEntries={groups} />);

        expect(mountedRows(container)).toBe(50);
        expect(container.querySelectorAll('*').length).toBeLessThan(2_000);
        expect(screen.getByText('Entries 1–50 of 10,000')).toBeInTheDocument();
        expect(screen.queryByText('position-0')).not.toBeInTheDocument();
        expect(screen.queryByText('"point-50"')).not.toBeInTheDocument();
        expect(points).toHaveLength(10_000);
        expect(groups[99].entries).toHaveLength(100);
    });

    it('pages across date boundaries, reaches the final entry and keeps manual editing available', () => {
        const points = entries(101);
        const onEditEntry = vi.fn();
        const onDeleteEntry = vi.fn();
        const { container } = render(
            <DateGroupedTimeline
                groupedEntries={[group(points.slice(0, 25), 'first-day'), group(points.slice(25), 'second-day')]}
                onEditEntry={onEditEntry}
                onDeleteEntry={onDeleteEntry}
                voyageFirstEntryId={points[100].id}
                voyageLastEntryId={points[0].id}
            />,
        );

        expect(mountedRows(container)).toBe(50);
        expect(screen.getByText('End')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Previous entries' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Next entries' }));
        expect(mountedRows(container)).toBe(50);
        expect(screen.queryByText('"point-0"')).not.toBeInTheDocument();

        fireEvent.click(screen.getAllByRole('button', { name: /^Expand log entry / })[0]);
        expect(screen.getByText('position-50')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Edit log entry / }));
        expect(onEditEntry).toHaveBeenCalledWith(points[50]);
        fireEvent.click(screen.getByRole('button', { name: /^Delete log entry / }));
        expect(onDeleteEntry).toHaveBeenCalledWith(points[50].id);

        fireEvent.click(screen.getByRole('button', { name: 'Next entries' }));
        expect(mountedRows(container)).toBe(1);
        expect(screen.getByText('"point-100"')).toBeInTheDocument();
        expect(screen.getByText('Start')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next entries' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Previous entries' }));
        expect(screen.getByText('position-50')).toBeInTheDocument();
        expect(mountedRows(container)).toBe(50);
    });

    it('unmounts collapsed day rows and collapsed entry details', () => {
        const { container } = render(<DateGroupedTimeline groupedEntries={[group(entries(80), 'voyage-day')]} />);
        fireEvent.click(screen.getAllByRole('button', { name: /^Expand log entry / })[0]);
        expect(screen.getByText('position-0')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Collapse log entry / }));
        expect(screen.queryByText('position-0')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Collapse voyage-day' }));
        expect(mountedRows(container)).toBe(0);
        fireEvent.click(screen.getByRole('button', { name: 'Next entries' }));
        expect(mountedRows(container)).toBe(0);
        fireEvent.click(screen.getByRole('button', { name: 'Expand voyage-day' }));
        expect(mountedRows(container)).toBe(30);
        expect(screen.getByText('"point-79"')).toBeInTheDocument();
    });

    it('clamps a later page when filtering or deleting shrinks the result and handles no matches', () => {
        const points = entries(101);
        const { container, rerender } = render(<DateGroupedTimeline groupedEntries={[group(points)]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Next entries' }));
        fireEvent.click(screen.getByRole('button', { name: 'Next entries' }));
        rerender(<DateGroupedTimeline groupedEntries={[group(points.slice(0, 3))]} />);
        expect(mountedRows(container)).toBe(3);
        expect(screen.getByText('"point-0"')).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Log entry pages' })).not.toBeInTheDocument();
        rerender(<DateGroupedTimeline groupedEntries={[]} />);
        expect(mountedRows(container)).toBe(0);
        expect(screen.getByText('No Entries Match Filters')).toBeInTheDocument();
    });
});
