/**
 * Settings → Vessel Profile shares a crew member's date of birth with their
 * skipper after an edit (129-14), and clears the shared one only when this
 * screen had one and it was cleared here: an edit on a device that never had
 * a date of birth leaves another device's alone. Fictional people only.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ share: vi.fn() }));

vi.mock('../services/crew/crewFloatPlanDetails', () => ({
    shareMyFloatPlanDetails: mocks.share,
}));

import { useShareMyFloatPlanDetailsOnEdit } from '../hooks/useShareMyFloatPlanDetailsOnEdit';

type Vessel = Parameters<typeof useShareMyFloatPlanDetailsOnEdit>[0];

const DELAY = 20;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const withBirth: Vessel = {
    contactPhone: '0400 000 002',
    crewRoster: [{ name: 'Thomas Okafor', dateOfBirth: '1992-02-29', age: 34, rank: 'Skipper' }],
};
const ageOnly: Vessel = {
    contactPhone: '0400 000 002',
    crewRoster: [{ name: 'Thomas Okafor', age: 34, rank: 'Skipper' }],
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
    mocks.share.mockReset();
    mocks.share.mockResolvedValue('shared');
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useShareMyFloatPlanDetailsOnEdit and a date of birth', () => {
    it('an entered date of birth is shared with the age it gives today', async () => {
        const { rerender } = renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, DELAY), {
            initialProps: { vessel: ageOnly },
        });
        rerender({ vessel: withBirth });
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
        expect(mocks.share).toHaveBeenCalledWith(
            { name: 'Thomas Okafor', phone: '0400 000 002', age: 34, dateOfBirth: '1992-02-29' },
            { from: 'edit' },
        );
    });

    it('clearing the date of birth this screen had clears the shared one', async () => {
        const { rerender } = renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, DELAY), {
            initialProps: { vessel: withBirth },
        });
        rerender({ vessel: { ...withBirth, crewRoster: [{ name: 'Thomas Okafor', rank: 'Skipper' }] } });
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
        expect(mocks.share).toHaveBeenCalledWith(
            { name: 'Thomas Okafor', phone: '0400 000 002', age: null },
            { from: 'edit', clearDateOfBirth: true },
        );
    });

    it('an edit on a device that never had a date of birth does not clear one', async () => {
        const { rerender } = renderHook(({ vessel }) => useShareMyFloatPlanDetailsOnEdit(vessel, DELAY), {
            initialProps: { vessel: ageOnly },
        });
        rerender({ vessel: { ...ageOnly, contactPhone: '0400 000 003' } });
        await waitFor(() => expect(mocks.share).toHaveBeenCalledTimes(1));
        expect(mocks.share).toHaveBeenCalledWith(
            { name: 'Thomas Okafor', phone: '0400 000 003', age: 34 },
            { from: 'edit' },
        );
        await pause(DELAY * 2);
        expect(mocks.share).toHaveBeenCalledTimes(1);
    });
});
