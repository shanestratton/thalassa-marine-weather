import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';
import { lifetimeVoyageStats } from '../utils/lifetimeVoyageStats';
import { LogStatsFullscreen } from '../pages/log/LogStatsFullscreen';
import { StatsSheet } from '../pages/log/StatsSheet';
import { VoyageStatsRollup } from '../pages/log/VoyageStatsRollup';

vi.mock('../pages/log/LogSubComponents', () => ({
    StatBox: ({ label, value }: { label: string; value: string }) => (
        <div>
            {label}: {value}
        </div>
    ),
}));
vi.mock('../components/VoyageStatsPanel', () => ({
    VoyageStatsPanel: ({ entries }: { entries: ShipLogEntry[] }) => (
        <div data-testid="point-details">{entries.length} points</div>
    ),
}));

const archived: VoyageSummary = {
    voyageId: 'archived',
    entryCount: 2000,
    startedAt: '2026-09-23T00:00:00Z',
    departedAt: '2026-09-23T01:00:00Z',
    endedAt: '2026-09-24T03:00:00Z',
    totalDistanceNM: 156.2,
    avgSpeedKts: 6,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: -20,
    firstLon: 148,
    lastLat: -21,
    lastLon: 149,
    firstIsOnWater: true,
    landFraction: 0,
};
const lifetime = lifetimeVoyageStats([], [archived]);
const point = {
    id: 'resident',
    userId: 'owner',
    voyageId: 'recent',
    timestamp: '2026-09-25T00:00:00Z',
    latitude: -20,
    longitude: 148,
    positionFormatted: '',
    entryType: 'auto',
    cumulativeDistanceNM: 0.1,
} as ShipLogEntry;

afterEach(cleanup);

describe('lifetime log statistics presentation', () => {
    it('shows archived lifetime totals, not a loaded slice of points, in All Voyages', () => {
        render(
            <LogStatsFullscreen
                dispatch={vi.fn()}
                selectedVoyageId={null}
                scopedStatsEntries={[point]}
                lifetimeStats={lifetime}
            />,
        );
        expect(screen.getByText('Lifetime · includes archived voyages')).toBeVisible();
        expect(screen.getByText('156.2')).toBeVisible();
        expect(screen.getAllByText('1d 2h')).toHaveLength(2); // sea time and longest
        expect(screen.getByText(/2,000 recorded entries/)).toBeVisible();
        expect(screen.queryByTestId('point-details')).not.toBeInTheDocument();
        expect(screen.queryByText('0.1')).not.toBeInTheDocument();
    });

    it('preserves individual-voyage point details and does not substitute lifetime totals', () => {
        render(
            <LogStatsFullscreen
                dispatch={vi.fn()}
                selectedVoyageId="recent"
                scopedStatsEntries={[point]}
                lifetimeStats={lifetime}
            />,
        );
        expect(screen.getByTestId('point-details')).toHaveTextContent('1 points');
        expect(screen.getByText('Distance: 0.1 NM')).toBeVisible();
        expect(screen.queryByText('156.2')).not.toBeInTheDocument();
    });

    it('offers All Voyages with archived-only history and keeps Close usable', () => {
        const select = vi.fn();
        render(
            <StatsSheet
                onClose={vi.fn()}
                onShowStats={vi.fn()}
                onSelectVoyage={select}
                entries={[]}
                selectedVoyageId={null}
                currentVoyageId={null}
                voyageGroups={[]}
                lifetimeStats={lifetime}
            />,
        );
        expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
        expect(screen.getByRole('button', { name: /Selected Voyage/ })).toBeDisabled();
        const all = screen.getByRole('button', { name: /All Voyages/ });
        expect(all).toHaveTextContent('2000 entries');
        fireEvent.click(all);
        expect(select).toHaveBeenCalledWith(null);
    });

    it('labels the rollup as lifetime, keeps six metrics for one real voyage, and marks partial refreshes', () => {
        render(
            <VoyageStatsRollup
                voyageStats={lifetime.totals}
                records={lifetime.records}
                notice="Archive refresh unavailable; showing last loaded history."
            />,
        );
        expect(screen.getByText('Lifetime · includes archived')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Voyage stats' }));
        for (const label of ['Distance', 'Sea Time', 'Voyages', 'Farthest', 'Fastest avg', 'Longest']) {
            expect(screen.getByText(label)).toBeVisible();
        }
        expect(screen.getByRole('status')).toHaveTextContent('showing last loaded history');
    });
});
