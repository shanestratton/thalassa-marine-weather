/**
 * The notice exists because the single-publisher veto was silent, so these
 * tests are mostly about WHEN IT STAYS QUIET. A banner that cries wolf on a
 * healthy boat gets ignored, and then the one day it is right it is invisible
 * again — which is the whole failure this component was built to end.
 *
 * Build 125 (125-12), Shane 2026-10-09: "tapping 'Publish from this device' on
 * the Vessel page will fix it - - i cannot find that message??" The button
 * only navigated, and the Vessel card it led to said something else (or, with
 * the Pi primary, offered nothing). It now takes over IN PLACE, through the
 * same deliberate confirm the Vessel card uses, and the copy says what we
 * actually know about the holder: "last published 2 hours ago", or "claimed
 * 32 days ago" — never "no sign of it since", which a holder on an older build
 * (publishing without a heartbeat) would make false.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    updateSettings: vi.fn(),
    userId: 'skipper-user' as string | null,
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: Record<string, unknown>; updateSettings: unknown }) => unknown) =>
        selector({ settings: harness.settings, updateSettings: harness.updateSettings }),
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) =>
        selector({ user: harness.userId ? { id: harness.userId } : null }),
}));

import { SkipperClaimNotice } from '../pages/log/SkipperClaimNotice';
import { setAuthIdentityScope } from '../services/authIdentityScope';

// Fictional devices (the repo is public).
const THIS_DEVICE = 'dev-fictional-this-phone';
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const OTHER_CLAIM = {
    deviceId: 'dev-fictional-tablet',
    deviceName: 'iPad · 77c1',
    claimedAt: ago(40 * 24 * 60 * MIN),
    lastSeenAt: ago(2 * 60 * MIN),
};
const OLD_SHAPE = {
    deviceId: 'dev-fictional-old-install',
    deviceName: 'iPhone/iPad · 7e1a',
    claimedAt: ago(32 * 24 * 60 * MIN),
};

const renderNotice = (isTracking = true) => render(<SkipperClaimNotice isTracking={isTracking} />);

beforeEach(() => {
    for (const key of Object.keys(harness.settings)) delete harness.settings[key];
    harness.updateSettings.mockReset();
    harness.userId = 'skipper-user';
    localStorage.clear();
    localStorage.setItem('thalassa_device_id', THIS_DEVICE);
    setAuthIdentityScope('skipper-user');
});

describe('SkipperClaimNotice', () => {
    it('warns when live share is on and another device holds the claim', () => {
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = OTHER_CLAIM;
        renderNotice();
        expect(screen.getByText(/Recording, not publishing/i)).toBeTruthy();
        expect(screen.getByText('iPad · 77c1')).toBeTruthy();
        // The reassurance matters as much as the warning — the passage itself
        // is safe, and a skipper who thinks otherwise will stop the voyage.
        expect(screen.getByText(/logged safely/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Publish from this device' })).toBeTruthy();
    });

    it('says when the holder last published, not when it claimed', () => {
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = OTHER_CLAIM;
        renderNotice();
        expect(screen.getByTestId('skipper-claim-notice-text')).toHaveTextContent(
            'Live share is on, but iPad · 77c1 holds your public page (last published 2 hours ago).',
        );
        expect(screen.queryByText(/active .* ago/)).toBeNull();
    });

    it('says only "claimed …" for an old claim with no heartbeat — it may be publishing from an older build', () => {
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = OLD_SHAPE;
        renderNotice();
        expect(screen.getByTestId('skipper-claim-notice-text')).toHaveTextContent(
            'iPhone/iPad · 7e1a holds your public page (claimed 32 days ago).',
        );
        expect(screen.queryByText(/no sign of it/)).toBeNull();
    });

    it('stays silent when this device holds the claim', () => {
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = { ...OTHER_CLAIM, deviceId: THIS_DEVICE };
        const { container } = renderNotice();
        expect(container.firstChild).toBeNull();
    });

    it('stays silent when no claim exists at all — the trickle publishes freely', () => {
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = undefined;
        const { container } = renderNotice();
        expect(container.firstChild).toBeNull();
    });

    it('stays silent when live share is off — nothing was going to publish anyway', () => {
        harness.settings.liveTrackShare = false;
        harness.settings.skipperDevice = OTHER_CLAIM;
        const { container } = renderNotice();
        expect(container.firstChild).toBeNull();
    });

    it('stays silent when not recording', () => {
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = OTHER_CLAIM;
        const { container } = renderNotice(false);
        expect(container.firstChild).toBeNull();
    });

    it('takes over in place, through the confirm that names the holder and when it was last seen', () => {
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = OLD_SHAPE;
        renderNotice();

        const publish = screen.getByRole('button', { name: 'Publish from this device' });
        fireEvent.click(publish);
        const dialog = screen.getByRole('dialog', { name: 'Take over skipper publishing?' });
        expect(dialog).toHaveTextContent(
            'iPhone/iPad · 7e1a holds your public page — claimed 32 days ago. Taking over stops that device publishing and starts this one.',
        );

        // Cancel changes nothing: the takeover stays deliberate.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog', { name: 'Take over skipper publishing?' })).toBeNull();
        expect(harness.updateSettings).not.toHaveBeenCalled();

        fireEvent.click(publish);
        const confirm = screen.getByRole('button', { name: 'Take over' });
        fireEvent.click(confirm);
        fireEvent.click(confirm);
        expect(harness.updateSettings).toHaveBeenCalledTimes(1);
        expect(harness.updateSettings).toHaveBeenCalledWith({
            skipperDevice: expect.objectContaining({ deviceId: THIS_DEVICE }),
        });
    });

    it('offers no takeover while signed out — a signed-out phone publishes nothing', () => {
        harness.userId = null;
        harness.settings.liveTrackShare = true;
        harness.settings.skipperDevice = OLD_SHAPE;
        renderNotice();
        const publish = screen.getByRole('button', { name: 'Publish from this device' });
        expect(publish).toBeDisabled();
        fireEvent.click(publish);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(harness.updateSettings).not.toHaveBeenCalled();
    });
});
