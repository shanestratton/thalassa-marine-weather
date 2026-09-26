import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: vi.fn(() => vi.fn()),
    },
}));

// The real sign-in sheet pulls in the auth providers; a marker dialog is
// enough to show the signed-out button opens it.
vi.mock('../components/SignInScreen', () => ({
    SignInScreen: ({ isOpen }: { isOpen?: boolean }) =>
        isOpen ? <div role="dialog" aria-label="Sign in to Thalassa" /> : null,
}));

import { SkipperDeviceControl } from '../components/VesselHub';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getDeviceId, type SkipperClaim } from '../services/skipperDevice';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';

function recentOtherClaim(overrides: Partial<SkipperClaim> = {}): SkipperClaim {
    return {
        deviceId: 'other-device',
        deviceName: "Skipper's iPad",
        claimedAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('SkipperDeviceControl takeover confirmation', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-user');
    });

    it('cancels without changing the claim, then confirms exactly once', () => {
        const updateSettings = vi.fn();
        const claim = recentOtherClaim();
        render(
            <SkipperDeviceControl claim={claim} authenticatedUserId="skipper-user" updateSettings={updateSettings} />,
        );

        const takeover = screen.getByRole('button', { name: 'Make this phone primary' });
        fireEvent.click(takeover);
        expect(screen.getByRole('dialog', { name: 'Take over skipper publishing?' })).toBeInTheDocument();

        // ConfirmDialog buttons are named by their visible labels (no aria-label override).
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog', { name: 'Take over skipper publishing?' })).not.toBeInTheDocument();
        expect(updateSettings).not.toHaveBeenCalled();

        fireEvent.click(takeover);
        const confirm = screen.getByRole('button', { name: 'Take over' });
        fireEvent.click(confirm);
        fireEvent.click(confirm);

        expect(updateSettings).toHaveBeenCalledTimes(1);
        expect(updateSettings).toHaveBeenCalledWith({
            skipperDevice: expect.objectContaining({
                deviceId: getDeviceId(),
            }),
        });
    });

    it('drops a pending confirmation when identity changes', () => {
        const updateSettings = vi.fn();
        render(
            <SkipperDeviceControl
                claim={recentOtherClaim()}
                authenticatedUserId="skipper-user"
                updateSettings={updateSettings}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Make this phone primary' }));
        expect(screen.getByRole('dialog', { name: 'Take over skipper publishing?' })).toBeInTheDocument();

        act(() => setAuthIdentityScope('different-user'));

        expect(screen.queryByRole('dialog', { name: 'Take over skipper publishing?' })).not.toBeInTheDocument();
        expect(updateSettings).not.toHaveBeenCalled();
    });

    it('refuses to confirm if the live holder changed while the dialog was open', () => {
        const updateSettings = vi.fn();
        const firstClaim = recentOtherClaim();
        const { rerender } = render(
            <SkipperDeviceControl
                claim={firstClaim}
                authenticatedUserId="skipper-user"
                updateSettings={updateSettings}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Make this phone primary' }));
        rerender(
            <SkipperDeviceControl
                claim={recentOtherClaim({ deviceId: 'new-holder', claimedAt: new Date(Date.now() + 1).toISOString() })}
                authenticatedUserId="skipper-user"
                updateSettings={updateSettings}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Take over' }));

        expect(updateSettings).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: 'Take over skipper publishing?' })).not.toBeInTheDocument();
    });

    it('keeps the card footprint fixed when this device claims or releases publishing', () => {
        const updateSettings = vi.fn();
        const { rerender } = render(
            <SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={updateSettings} />,
        );

        expect(
            screen.getByText(
                'No phone is primary yet — any signed-in phone can post the boat’s position to your public page.',
            ),
        ).toBeInTheDocument();
        // A sighted skipper reads the state too, not just a screen reader — and
        // no "Primary device" label stands in for a claim that does not exist.
        // Plain phone words, not "No primary device yet" (UX scorecard run 7).
        // No boat GPS here, so the row has room for the rule in full.
        expect(screen.getByTestId('skipper-device-status')).toHaveTextContent(/^Any signed-in phone can post$/);
        expect(screen.queryByText(/Claim one to make it the single source/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');
        expect(screen.getByRole('button', { name: 'Make this phone primary' })).toHaveClass(
            'h-11',
            'whitespace-nowrap',
        );

        rerender(
            <SkipperDeviceControl
                claim={{ deviceId: getDeviceId(), deviceName: 'This iPhone/iPad', claimedAt: new Date().toISOString() }}
                authenticatedUserId="skipper-user"
                updateSettings={updateSettings}
            />,
        );

        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');
        expect(screen.getByTestId('skipper-device-status')).toHaveTextContent('Primary: this phone');
        expect(screen.getByRole('button', { name: 'Release — stop being primary' })).toHaveClass(
            'h-11',
            'whitespace-nowrap',
        );
    });

    it('keeps the sign-in condition when the Boat GPS pill shortens the status', () => {
        // Beside the Boat GPS pill the row has no room for "Any signed-in phone
        // can post", and "Any phone can post" would drop the sign-in a post
        // needs, so the short form names the state instead.
        const feed = vi.spyOn(NmeaGpsProvider, 'getFeedStatus').mockReturnValue('live');
        try {
            render(<SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={vi.fn()} />);
            expect(screen.getByTestId('skipper-device-gps-source')).toHaveTextContent('Boat GPS');
            expect(screen.getByTestId('skipper-device-status')).toHaveTextContent(/^No primary phone yet$/);
            expect(screen.getByTestId('skipper-device-status')).toHaveAttribute(
                'title',
                'No phone is primary yet — any signed-in phone can post the boat’s position to your public page.',
            );
        } finally {
            feed.mockRestore();
        }
    });

    it('asks for a sign-in instead of offering a claim while signed out', () => {
        // Signed out, a claim publishes nothing, so offering "Make this phone
        // primary" promised an action that could not happen (UX scorecard
        // run 6). The button says what is needed and opens sign-in.
        const updateSettings = vi.fn();
        render(<SkipperDeviceControl claim={null} authenticatedUserId={null} updateSettings={updateSettings} />);

        expect(screen.queryByRole('button', { name: 'Make this phone primary' })).not.toBeInTheDocument();
        const signIn = screen.getByRole('button', { name: 'Sign in to make this phone primary' });
        expect(signIn).toHaveClass('h-11', 'whitespace-nowrap');
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');

        fireEvent.click(signIn);
        expect(screen.getByRole('dialog', { name: 'Sign in to Thalassa' })).toBeInTheDocument();
        expect(updateSettings).not.toHaveBeenCalled();
    });

    it('names the active vessel this device publishes for, without growing the card', () => {
        // Publishing authority alone never said WHICH of up to five fleet
        // vessels it speaks for. The name has to appear, and it has to appear
        // inside the existing fixed footprint — a long boat name must truncate
        // rather than push the claim button out of an overflow-hidden card.
        const { rerender } = render(
            <SkipperDeviceControl
                claim={{ deviceId: getDeviceId(), deviceName: 'This iPhone/iPad', claimedAt: new Date().toISOString() }}
                authenticatedUserId="skipper-user"
                updateSettings={vi.fn()}
                vesselName="Serene Summer"
            />,
        );

        const vessel = screen.getByTestId('skipper-device-vessel');
        expect(vessel).toHaveTextContent('Serene Summer');
        expect(vessel).toHaveClass('truncate');
        // Still shown alongside the claim badge, and still 120px tall.
        expect(screen.getByText('This device')).toBeInTheDocument();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');

        rerender(
            <SkipperDeviceControl
                claim={null}
                authenticatedUserId="skipper-user"
                updateSettings={vi.fn()}
                vesselName={'Extraordinarily Long Vessel Name That Would Wrap'}
            />,
        );
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');

        // An unnamed vessel must not render an empty slot.
        rerender(<SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={vi.fn()} />);
        expect(screen.queryByTestId('skipper-device-vessel')).not.toBeInTheDocument();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');
    });
});
