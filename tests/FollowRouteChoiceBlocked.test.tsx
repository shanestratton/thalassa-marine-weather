/**
 * Rows on the "Following a route?" sheet: a warning, not a wall (build 124).
 *
 * Design history, five versions now: pick-then-refuse (Shane 2026-08-10: "just
 * show tracks that are ready to be followed"), hide-the-blocked (2026-08-13:
 * "the saved routes do not show up"), show-them-disabled (2026-08-13: "i
 * cannot actually accept it. it has no way of selecting"), tap-to-fix — and
 * now three states, because the check itself kept getting lost and "punters
 * just aren't going to use it" (2026-10-08):
 *
 *  - green: checked, follow on tap;
 *  - amber: not checked (yet), follow on tap, the reason on the row and a
 *    trailing "Check now";
 *  - red: a real check found something nobody acknowledged. Two taps, the
 *    same "tap again" pattern as Sail, and a trailing Review / Fix in tracer.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { FollowRouteChoice } from '../pages/log/LogSubComponents';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import type { TraceFollowStatus } from '../services/traceVerification';

vi.mock('../pages/log/useEndpointNames', () => ({
    useEndpointNames: () => ({ startLabel: 'Cowes', endLabel: 'Lymington' }),
}));

const summary: VoyageSummary = {
    voyageId: 'plan-1',
    entryCount: 41,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T04:00:00.000Z',
    totalDistanceNM: 12.4,
    avgSpeedKts: 5.2,
    hasManual: false,
    isPlannedRoute: true,
    isImported: false,
    firstLat: 50.766,
    firstLon: -1.297,
    lastLat: 50.754,
    lastLon: -1.533,
    firstIsOnWater: true,
    landFraction: 0,
};

const amber: TraceFollowStatus = { tone: 'unchecked', code: 'aged', reason: 'Last checked 4 Sep' };
const red: TraceFollowStatus = { tone: 'finding', code: 'finding', reason: 'Pins 14→15: crosses charted land' };
const green: TraceFollowStatus = {
    tone: 'checked',
    code: 'ok',
    reason: null,
    checkedAt: '2026-10-03T09:00:00.000Z',
};

const main = () => screen.getByRole('button', { name: /^Cowes → Lymington/ });

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('an amber row follows on the first tap', () => {
    it('says why on the row, and the row tap picks', () => {
        const onPick = vi.fn();
        const onCheckNow = vi.fn();
        render(<FollowRouteChoice summary={summary} followStatus={amber} onCheckNow={onCheckNow} onPick={onPick} />);
        expect(main().textContent).toContain('Last checked 4 Sep');
        expect(main()).not.toBeDisabled();
        fireEvent.click(main());
        expect(onPick).toHaveBeenCalledTimes(1);
        expect(onPick.mock.calls[0][0]).not.toBe(true);
        expect(onCheckNow).not.toHaveBeenCalled();
    });

    it('Check now runs the check and does not follow', () => {
        const onPick = vi.fn();
        const onCheckNow = vi.fn();
        render(<FollowRouteChoice summary={summary} followStatus={amber} onCheckNow={onCheckNow} onPick={onPick} />);
        fireEvent.click(screen.getByRole('button', { name: /^Check now/ }));
        expect(onCheckNow).toHaveBeenCalledTimes(1);
        expect(onPick).not.toHaveBeenCalled();
    });

    it('while checking, shows progress and a Stop, and still follows on tap', () => {
        const onPick = vi.fn();
        const onStopCheck = vi.fn();
        render(
            <FollowRouteChoice
                summary={summary}
                followStatus={amber}
                checking
                checkingLabel="Checking… 12 of 41"
                onCheckNow={vi.fn()}
                onStopCheck={onStopCheck}
                onPick={onPick}
            />,
        );
        expect(main().textContent).toContain('Checking… 12 of 41');
        fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
        expect(onStopCheck).toHaveBeenCalledTimes(1);
        fireEvent.click(main());
        expect(onPick).toHaveBeenCalledTimes(1);
    });

    it('never nests a button inside a button', () => {
        const { container } = render(
            <FollowRouteChoice summary={summary} followStatus={amber} onCheckNow={vi.fn()} onPick={vi.fn()} />,
        );
        expect(container.querySelectorAll('button button')).toHaveLength(0);
        expect(container.querySelectorAll('button')).toHaveLength(2);
    });
});

describe('a red row takes two taps, like Sail', () => {
    it('the first tap arms and does not pick; the second picks, accepting the finding', () => {
        const onPick = vi.fn();
        render(<FollowRouteChoice summary={summary} followStatus={red} onFixInTracer={vi.fn()} onPick={onPick} />);
        expect(main().textContent).toContain('Pins 14→15: crosses charted land');
        fireEvent.click(main());
        expect(onPick).not.toHaveBeenCalled();
        expect(main().textContent).toContain('Tap again to follow anyway');
        fireEvent.click(main());
        expect(onPick).toHaveBeenCalledTimes(1);
        expect(onPick).toHaveBeenCalledWith(true);
    });

    it('disarms after 4 s, so a later tap only arms again', () => {
        vi.useFakeTimers();
        const onPick = vi.fn();
        render(<FollowRouteChoice summary={summary} followStatus={red} onPick={onPick} />);
        fireEvent.click(main());
        expect(main().textContent).toContain('Tap again to follow anyway');
        act(() => {
            vi.advanceTimersByTime(4_100);
        });
        expect(main().textContent).not.toContain('Tap again to follow anyway');
        fireEvent.click(main());
        expect(onPick).not.toHaveBeenCalled();
    });

    it('offers Review when the finding can be acknowledged here', () => {
        const onReview = vi.fn();
        const onPick = vi.fn();
        render(
            <FollowRouteChoice
                summary={summary}
                followStatus={{ ...red, reason: 'Pins 3→4: charted wreck' }}
                onReview={onReview}
                onFixInTracer={vi.fn()}
                onPick={onPick}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
        expect(onReview).toHaveBeenCalledTimes(1);
        expect(onPick).not.toHaveBeenCalled();
    });

    it('otherwise offers Fix in tracer', () => {
        const onFixInTracer = vi.fn();
        render(
            <FollowRouteChoice summary={summary} followStatus={red} onFixInTracer={onFixInTracer} onPick={vi.fn()} />,
        );
        fireEvent.click(screen.getByRole('button', { name: /^Fix in tracer/ }));
        expect(onFixInTracer).toHaveBeenCalledTimes(1);
    });
});

describe('a green row is plain', () => {
    it('shows when it was checked, has no trailing action, and picks on tap', () => {
        const onPick = vi.fn();
        const { container } = render(<FollowRouteChoice summary={summary} followStatus={green} onPick={onPick} />);
        expect(main().textContent).toContain('12.4 NM · 41 pts · checked 3 Oct');
        expect(container.querySelectorAll('button')).toHaveLength(1);
        fireEvent.click(main());
        expect(onPick).toHaveBeenCalledTimes(1);
    });

    it('an ordinary planner route (no trace, no status) is pickable with no tint', () => {
        const onPick = vi.fn();
        render(<FollowRouteChoice summary={summary} followStatus={null} onPick={onPick} />);
        expect(main().textContent).toContain('12.4 NM · 41 pts');
        expect(main().textContent).not.toContain('checked');
        fireEvent.click(main());
        expect(onPick).toHaveBeenCalledTimes(1);
    });
});
