/**
 * The voyage card's Follow button and a red finding (package 125-05 review
 * fix-up, 2026-10-09).
 *
 * A plan the router drew red where no tide clears it (Shane, 2026-10-08:
 * "better we just have red at the "dry" zones") is a red finding: following
 * it takes two taps — the routecheck's own "tap again to follow anyway"
 * (build 124), never a second gate. The follow sheet's rows had it; the
 * card's Follow button did not: the refusal fell through to "Couldn't load
 * this saved route — please try again" on every tap, and the plan could never
 * be followed from its card. Now the first tap says why and arms the second;
 * the second accepts the finding (the same set the sheet's rows use) before
 * it follows.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
const publish = vi.hoisted(() => vi.fn());
vi.mock('../components/Toast', () => ({ useToast: () => toast }));
vi.mock('../context/FollowRouteContext', () => ({
    useFollowRoute: () => ({ isFollowing: false, voyageId: null }),
}));
vi.mock('../services/shiplog/publishFollowedRoute', () => ({ publishFollowedRouteDetailed: publish }));

import { FollowRouteButton } from '../pages/log/LogSubComponents';
import { TRACE_ROUTE_USE_BLOCK_PREFIX } from '../pages/log/logPageTypes';

/** followPlannedRouteLocally's refusal for a red plan (pages/LogPage). */
const refusal = () =>
    new Error(
        `${TRACE_ROUTE_USE_BLOCK_PREFIX}Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m. Tap the route twice to follow anyway.`,
    );

const button = () => screen.getByRole('button');
const flush = () => act(async () => {});

beforeEach(() => {
    toast.error.mockReset();
    toast.info.mockReset();
    toast.success.mockReset();
    publish.mockReset();
    publish.mockResolvedValue({ result: 'not-tracking' });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('125-05 — a red plan follows from its card on the second tap', () => {
    it('the first tap says why and arms; the second accepts the finding, then follows', async () => {
        const accepted = new Set<string>();
        const onAcceptFinding = vi.fn(() => accepted.add('plan-1'));
        const onFollow = vi.fn(async () => {
            if (!accepted.has('plan-1')) throw refusal();
            return true;
        });
        render(<FollowRouteButton voyageId="plan-1" onFollow={onFollow} onAcceptFinding={onAcceptFinding} />);

        fireEvent.click(button());
        await flush();
        expect(onFollow).toHaveBeenCalledTimes(1);
        expect(onAcceptFinding).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(toast.error.mock.calls[0][0]).toBe(
            'Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m. Tap Follow again to follow anyway.',
        );
        expect(button()).toHaveAccessibleName('Tap again to follow anyway');
        expect(button().textContent).toContain('Anyway');
        expect(publish).not.toHaveBeenCalled();

        fireEvent.click(button());
        await flush();
        expect(onAcceptFinding).toHaveBeenCalledTimes(1);
        expect(onFollow).toHaveBeenCalledTimes(2);
        // Accepted BEFORE the follow reads it.
        expect(onAcceptFinding.mock.invocationCallOrder[0]).toBeLessThan(onFollow.mock.invocationCallOrder[1]);
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith('plan-1');
    });

    it('the arming lapses after 4 s: the next tap is a first tap again', async () => {
        vi.useFakeTimers();
        const onAcceptFinding = vi.fn();
        const onFollow = vi.fn(async () => {
            throw refusal();
        });
        render(<FollowRouteButton voyageId="plan-1" onFollow={onFollow} onAcceptFinding={onAcceptFinding} />);
        fireEvent.click(button());
        await flush();
        expect(button()).toHaveAccessibleName('Tap again to follow anyway');
        act(() => {
            vi.advanceTimersByTime(4_001);
        });
        expect(button()).toHaveAccessibleName('Follow this route');
        fireEvent.click(button());
        await flush();
        expect(onAcceptFinding).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledTimes(2);
    });

    it('any other failure still says the route could not be loaded, and arms nothing', async () => {
        const onAcceptFinding = vi.fn();
        const onFollow = vi.fn(async () => false);
        render(<FollowRouteButton voyageId="plan-1" onFollow={onFollow} onAcceptFinding={onAcceptFinding} />);
        fireEvent.click(button());
        await flush();
        expect(toast.error).toHaveBeenCalledWith('Couldn’t load this saved route — please try again');
        expect(button()).toHaveAccessibleName('Follow this route');
        fireEvent.click(button());
        await flush();
        expect(onAcceptFinding).not.toHaveBeenCalled();
    });
});
