/**
 * The "Following a route?" sheet wears the saved-routes grammar.
 *
 * Shane 2026-08-30 asked for the Passage Planning layout — "the gold standard"
 * — on this sheet. Most of it is styling, but one rule is load-bearing: the
 * trailing badge lives OUTSIDE the truncating name span, so a long route name
 * cannot eat it. It used to live inside.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { FollowRouteChoice } from '../pages/log/LogSubComponents';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

vi.mock('../pages/log/useEndpointNames', () => ({
    useEndpointNames: () => ({
        startLabel: 'Manly Boat Harbour Marina Berth',
        endLabel: 'Tangalooma Wrecks Anchorage North',
    }),
}));

const summary: VoyageSummary = {
    voyageId: 'plan-1',
    entryCount: 12,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T04:00:00.000Z',
    totalDistanceNM: 18.4,
    avgSpeedKts: 5.2,
    hasManual: false,
    isPlannedRoute: true,
    isImported: false,
    firstLat: -27.2,
    firstLon: 153.1,
    lastLat: -27.18,
    lastLon: 153.37,
    firstIsOnWater: true,
    landFraction: 0,
};

afterEach(cleanup);

describe('saved-routes grammar on the follow sheet', () => {
    it('keeps the ⇄ badge OUT of the truncating name span', () => {
        render(<FollowRouteChoice summary={summary} reversible onPick={vi.fn()} />);

        const badge = screen.getByTitle('Return leg also saved');
        // The badge must not be truncatable, and must not sit inside the
        // element that truncates. A long name would otherwise clip the one
        // mark telling the skipper a direction was chosen on their behalf.
        expect(badge.className).toContain('shrink-0');
        expect(badge.closest('.truncate')).toBeNull();
    });

    it('truncates only the name', () => {
        render(<FollowRouteChoice summary={summary} reversible onPick={vi.fn()} />);
        const truncating = document.querySelector('.truncate');
        expect(truncating).not.toBeNull();
        expect(truncating?.textContent).toBe('Manly Boat Harbour Marina Berth → Tangalooma Wrecks Anchorage North');
        expect(truncating?.textContent).not.toContain('⇄');
    });

    it('marks a route with a pin, not the compass reserved for a passage', () => {
        // This sheet has no passages to show: VoyageSummary carries no tripId
        // or legOrdinal, so passage/leg structure is not derivable here. Using
        // the compass would promise a grouping that does not exist.
        const { container } = render(<FollowRouteChoice summary={summary} onPick={vi.fn()} />);
        expect(container.textContent).toContain('📍');
        expect(container.textContent).not.toContain('🧭');
    });

    it('still shows the block reason and its way out', () => {
        render(
            <FollowRouteChoice
                summary={summary}
                blockReason="No valid check for its current waypoints."
                onCheckRoute={vi.fn()}
                onPick={vi.fn()}
            />,
        );
        expect(screen.getByText('No valid check for its current waypoints.')).toBeInTheDocument();
        expect(screen.getByText('Tap to check it in Route Tracer →')).toBeInTheDocument();
    });
});
