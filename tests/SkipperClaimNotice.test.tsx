/**
 * The notice exists because the single-publisher veto was silent, so these
 * tests are mostly about WHEN IT STAYS QUIET. A banner that cries wolf on a
 * healthy boat gets ignored, and then the one day it is right it is invisible
 * again — which is the whole failure this component was built to end.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const settings: Record<string, unknown> = {};

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: Record<string, unknown> }) => unknown) => selector({ settings }),
}));

// The real module reads a per-install id out of localStorage; pin the identity
// so "held here" vs "held elsewhere" is explicit rather than ambient.
const THIS_DEVICE = 'dev-this-phone';
vi.mock('../services/skipperDevice', async () => {
    const actual = await vi.importActual<typeof import('../services/skipperDevice')>('../services/skipperDevice');
    return {
        ...actual,
        holdsClaim: (claim: { deviceId?: string } | null | undefined) => claim?.deviceId === THIS_DEVICE,
        claimAgeLabel: () => '2 hours ago',
    };
});

import { SkipperClaimNotice } from '../pages/log/SkipperClaimNotice';

const OTHER_CLAIM = { deviceId: 'dev-the-ipad', deviceName: "Shane's iPad", claimedAt: '2026-08-08T00:00:00.000Z' };

const renderNotice = (isTracking = true) =>
    render(<SkipperClaimNotice isTracking={isTracking} onOpenVessel={() => {}} />);

beforeEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
});

describe('SkipperClaimNotice', () => {
    it('warns when live share is on and another device holds the claim', () => {
        settings.liveTrackShare = true;
        settings.skipperDevice = OTHER_CLAIM;
        renderNotice();
        expect(screen.getByText(/Recording, not publishing/i)).toBeTruthy();
        expect(screen.getByText("Shane's iPad")).toBeTruthy();
        // The reassurance matters as much as the warning — the passage itself
        // is safe, and a skipper who thinks otherwise will stop the voyage.
        expect(screen.getByText(/logged safely/i)).toBeTruthy();
        expect(screen.getByLabelText(/take over skipper publishing/i)).toBeTruthy();
    });

    it('stays silent when this device holds the claim', () => {
        settings.liveTrackShare = true;
        settings.skipperDevice = { ...OTHER_CLAIM, deviceId: THIS_DEVICE };
        const { container } = renderNotice();
        expect(container.firstChild).toBeNull();
    });

    it('stays silent when no claim exists at all — the trickle publishes freely', () => {
        settings.liveTrackShare = true;
        settings.skipperDevice = undefined;
        const { container } = renderNotice();
        expect(container.firstChild).toBeNull();
    });

    it('stays silent when live share is off — nothing was going to publish anyway', () => {
        settings.liveTrackShare = false;
        settings.skipperDevice = OTHER_CLAIM;
        const { container } = renderNotice();
        expect(container.firstChild).toBeNull();
    });

    it('stays silent when not recording', () => {
        settings.liveTrackShare = true;
        settings.skipperDevice = OTHER_CLAIM;
        const { container } = renderNotice(false);
        expect(container.firstChild).toBeNull();
    });

    it('does not offer takeover itself — the Vessel card owns that decision', () => {
        settings.liveTrackShare = true;
        settings.skipperDevice = OTHER_CLAIM;
        renderNotice();
        // One action, and it navigates. A confirm-free takeover button here
        // would make this the fifth writer of a deliberately exclusive claim.
        expect(screen.getAllByRole('button')).toHaveLength(1);
    });
});
