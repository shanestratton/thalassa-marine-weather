/**
 * The skipper device card names which GPS speaks for the boat.
 *
 * Shane's rule (2026-08-30): "if there is a pi connected, well stiff, that is
 * the source of truth for gps, as long as it has got one that is." The card is
 * where that promise is made visible, so it must never claim a boat fix the
 * boat is not actually delivering.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getFeedStatus } = vi.hoisted(() => ({ getFeedStatus: vi.fn() }));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: { getFeedStatus },
}));

import { SkipperDeviceControl } from '../components/VesselHub';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const card = () => screen.getByTestId('skipper-device-gps-source');

function renderCard() {
    render(<SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={vi.fn()} />);
}

describe('skipper device card — GPS source of truth', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-user');
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('names the BOAT GPS when the vessel feed is live', () => {
        getFeedStatus.mockReturnValue('live');
        renderCard();
        expect(card()).toHaveTextContent('Boat GPS');
    });

    it('still names the boat GPS on a usable-but-stale feed', () => {
        // Between 6.5 s and 13 s the fix is old but real. Demoting to "Phone"
        // here would flap the label every time a 5 s publish ran late.
        getFeedStatus.mockReturnValue('stale');
        renderCard();
        expect(card()).toHaveTextContent('Boat GPS');
    });

    it('shows only THIS DEVICE when the gateway has no position behind it', () => {
        // "as long as it has got one that is" — a Pi that is connected but has
        // no GPS reads 'unavailable', and the card must not promise a boat fix
        // that does not exist. (Shane 2026-09-06: "if no pi, then just THIS
        // DEVICE" — the phone is not a peer to name, it is what is left.)
        getFeedStatus.mockReturnValue('unavailable');
        renderCard();
        expect(card()).not.toHaveTextContent('Boat GPS');
        expect(card()).toHaveTextContent('This device');
    });

    it('notices the feed GOING AWAY, which emits no event', () => {
        getFeedStatus.mockReturnValue('live');
        renderCard();
        expect(card()).toHaveTextContent('Boat GPS');

        getFeedStatus.mockReturnValue('unavailable');
        act(() => {
            vi.advanceTimersByTime(2_100);
        });
        expect(card()).not.toHaveTextContent('Boat GPS');
        expect(card()).toHaveTextContent('This device');
    });

    it('recovers to the boat GPS without a remount', () => {
        getFeedStatus.mockReturnValue('unavailable');
        renderCard();
        expect(card()).not.toHaveTextContent('Boat GPS');
        expect(card()).toHaveTextContent('This device');

        getFeedStatus.mockReturnValue('live');
        act(() => {
            vi.advanceTimersByTime(2_100);
        });
        expect(card()).toHaveTextContent('Boat GPS');
    });

    it('keeps the card at its fixed height', () => {
        // The source rides on the existing status line precisely because the
        // card cannot grow — a new row would push the claim button out.
        getFeedStatus.mockReturnValue('live');
        renderCard();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');
    });
});
