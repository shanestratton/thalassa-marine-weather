import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: vi.fn(() => vi.fn()),
    },
}));

import { SkipperDeviceControl } from '../components/VesselHub';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getDeviceId, type SkipperClaim } from '../services/skipperDevice';

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

        const takeover = screen.getByRole('button', { name: 'Press to make this the primary device' });
        fireEvent.click(takeover);
        expect(screen.getByRole('dialog', { name: 'Take over skipper publishing?' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel action' }));
        expect(screen.queryByRole('dialog', { name: 'Take over skipper publishing?' })).not.toBeInTheDocument();
        expect(updateSettings).not.toHaveBeenCalled();

        fireEvent.click(takeover);
        const confirm = screen.getByRole('button', { name: 'Confirm action' });
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

        fireEvent.click(screen.getByRole('button', { name: 'Press to make this the primary device' }));
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

        fireEvent.click(screen.getByRole('button', { name: 'Press to make this the primary device' }));
        rerender(
            <SkipperDeviceControl
                claim={recentOtherClaim({ deviceId: 'new-holder', claimedAt: new Date(Date.now() + 1).toISOString() })}
                authenticatedUserId="skipper-user"
                updateSettings={updateSettings}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }));

        expect(updateSettings).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: 'Take over skipper publishing?' })).not.toBeInTheDocument();
    });

    it('keeps the card footprint fixed when this device claims or releases publishing', () => {
        const updateSettings = vi.fn();
        const { rerender } = render(
            <SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={updateSettings} />,
        );

        expect(screen.getByText('No device claimed yet — any signed-in device can publish.')).toBeInTheDocument();
        expect(screen.queryByText(/Claim one to make it the single source/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');
        expect(screen.getByRole('button', { name: 'Press to make this the primary device' })).toHaveClass(
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
        expect(screen.getByRole('button', { name: 'Release — let another device take it' })).toHaveClass(
            'h-11',
            'whitespace-nowrap',
        );
    });
});
