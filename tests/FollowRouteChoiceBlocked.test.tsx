/**
 * Blocked rows on the "Following a route?" sheet stay VISIBLE — disabled,
 * with the follow gate's reason on the row. Third design in four days:
 * pick-then-refuse (Shane 2026-08-10: "just show tracks that are ready to be
 * followed"), then hide-the-blocked (Shane 2026-08-13: "the saved routes do
 * not show up on the startup screen to select one"). Visible-but-disabled
 * is the synthesis this test pins down.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { FollowRouteChoice } from '../pages/log/LogSubComponents';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

vi.mock('../pages/log/useEndpointNames', () => ({
    useEndpointNames: () => ({ startLabel: 'Newport', endLabel: 'Tangalooma' }),
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

describe('FollowRouteChoice with a follow-gate refusal', () => {
    it('renders the row disabled with the gate reason visible', () => {
        const onPick = vi.fn();
        render(
            <FollowRouteChoice
                summary={summary}
                blockReason="This traced route has no valid check for its current waypoints. Open Route Tracer and check it again."
                onPick={onPick}
            />,
        );
        const row = screen.getByRole('button');
        expect(row).toBeDisabled();
        expect(row.textContent).toContain('Newport → Tangalooma');
        expect(row.textContent).toContain('Open Route Tracer');
        row.click();
        expect(onPick).not.toHaveBeenCalled();
    });

    it('stays pickable with no reason', () => {
        const onPick = vi.fn();
        render(<FollowRouteChoice summary={summary} blockReason={null} onPick={onPick} />);
        const row = screen.getByRole('button');
        expect(row).not.toBeDisabled();
        row.click();
        expect(onPick).toHaveBeenCalledTimes(1);
    });
});
