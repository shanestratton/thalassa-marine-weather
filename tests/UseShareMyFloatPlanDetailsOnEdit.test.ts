/**
 * Settings → Vessel Profile shares a crew member's own name, mobile and age
 * with their skipper's float plan after an edit (Shane 2026-10-04): never on
 * just opening the screen, and still when the screen closes inside the wait.
 * Fictional people and numbers only: the repository is public.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ share: vi.fn() }));

vi.mock('../services/crew/crewFloatPlanDetails', () => ({
    shareMyFloatPlanDetails: mocks.share,
}));

import { useShareMyFloatPlanDetailsOnEdit } from '../hooks/useShareMyFloatPlanDetailsOnEdit';

type Vessel = Parameters<typeof useShareMyFloatPlanDetailsOnEdit>[0];

const OPENED: Vessel = {
    contactPhone: '0491 570 156',
    crewRoster: [{ name: 'Thomas Okafor', age: 34, rank: 'Skipper' }],
};
const EDITED: Vessel = { ...OPENED, contactPhone: '0491 570 157' };
const DELAY = 20;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
    mocks.share.mockReset();
    mocks.share.mockResolvedValue('shared');
});

describe('useShareMyFloatPlanDetailsOnEdit', () => {
    it('shares nothing on just opening the screen', async () => {
        renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, DELAY), {
            initialProps: { vessel: OPENED },
        });
        await pause(DELAY * 4);
        expect(mocks.share).not.toHaveBeenCalled();
    });

    it('shares an edit, as an edit, once the typing stops', async () => {
        const { rerender } = renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, DELAY), {
            initialProps: { vessel: OPENED },
        });
        rerender({ vessel: { ...OPENED, contactPhone: '0491 570 15' } });
        rerender({ vessel: EDITED });
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
        expect(mocks.share).toHaveBeenCalledWith(
            { name: 'Thomas Okafor', phone: '0491 570 157', age: 34 },
            { from: 'edit' },
        );
    });

    it('still shares the last edit when Settings closes inside the wait', async () => {
        const { rerender, unmount } = renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, 60_000), {
            initialProps: { vessel: OPENED },
        });
        rerender({ vessel: EDITED });
        unmount();
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
        expect(mocks.share).toHaveBeenCalledWith(
            { name: 'Thomas Okafor', phone: '0491 570 157', age: 34 },
            { from: 'edit' },
        );
    });

    it('does not share again on close once the edit has gone', async () => {
        const { rerender, unmount } = renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, DELAY), {
            initialProps: { vessel: OPENED },
        });
        rerender({ vessel: EDITED });
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
        unmount();
        await pause(DELAY * 2);
        expect(mocks.share).toHaveBeenCalledTimes(1);
    });

    it('an edit back to what the screen opened with is still shared', async () => {
        const { rerender } = renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, DELAY), {
            initialProps: { vessel: OPENED },
        });
        rerender({ vessel: EDITED });
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
        rerender({ vessel: OPENED });
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(2));
        expect(mocks.share).toHaveBeenLastCalledWith(
            { name: 'Thomas Okafor', phone: '0491 570 156', age: 34 },
            { from: 'edit' },
        );
    });
});
