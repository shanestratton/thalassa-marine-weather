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
    const REASON = 'This traced route has no valid check for its current waypoints.';

    it('is TAPPABLE and routes to the fix rather than sitting inert', () => {
        // The row was disabled until 2026-08-13, which read as broken:
        // "i cannot actually accept it. it has no way of selecting". A
        // disabled control with explanatory microcopy is still a dead end —
        // every refusal this gate issues is fixable in Route Tracer, so the
        // row has to carry you there.
        const onPick = vi.fn();
        const onCheckRoute = vi.fn();
        render(
            <FollowRouteChoice
                summary={summary}
                blockReason={REASON}
                onCheckRoute={onCheckRoute}
                onPick={onPick}
            />,
        );
        const row = screen.getByRole('button');
        expect(row).not.toBeDisabled();
        expect(row.textContent).toContain('Newport → Tangalooma');
        expect(row.textContent).toContain(REASON);
        expect(row.textContent).toContain('Route Tracer');

        row.click();
        // Goes to the fix, and never silently starts following an unchecked line.
        expect(onCheckRoute).toHaveBeenCalledTimes(1);
        expect(onPick).not.toHaveBeenCalled();
    });

    it('falls back to inert when no route out is supplied', () => {
        const onPick = vi.fn();
        render(<FollowRouteChoice summary={summary} blockReason={REASON} onPick={onPick} />);
        const row = screen.getByRole('button');
        expect(row).toBeDisabled();
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
