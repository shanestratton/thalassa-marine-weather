/**
 * The Skipper Device card with the Pi primary — Shane 2026-09-08: "we have on
 * the top line, primary the pi, then the next line says this device?? lets get
 * rid of this device unless there is no pi. also … change the wording to say,
 * The Pi is the Primary Device. thats all. but dont change the height of the
 * card."
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/AnchorWatchService', () => ({ AnchorWatchService: { subscribe: vi.fn(() => vi.fn()) } }));
vi.mock('../hooks/useCloudTelemetry', () => ({
    useCloudTelemetry: () => ({
        latest: { source: 'pi', deviceLabel: 'calypso', reportedAt: Date.now() - 3_000 },
        piPrimary: true,
    }),
}));

import { SkipperDeviceControl } from '../components/VesselHub';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getDeviceId } from '../services/skipperDevice';

const DAY = 24 * 3_600_000;
// Fictional devices (the repo is public).
const FORGOTTEN = {
    deviceId: 'dev-fictional-old-install',
    deviceName: 'iPhone/iPad · 7e1a',
    claimedAt: new Date(Date.now() - 32 * DAY).toISOString(),
};

describe('Skipper Device card while the Pi is primary', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-user');
    });

    it('says nothing about this device, reads "The Pi is the Primary Device", and keeps its height', () => {
        render(<SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={vi.fn()} />);
        expect(screen.queryByText(/this phone/i)).toBeNull();
        expect(screen.queryByText('Boat GPS')).toBeNull();
        expect(screen.queryByTestId('skipper-device-gps-source')).toBeNull();
        expect(screen.getByTestId('skipper-device-pi-primary')).toHaveTextContent('The Pi is the Primary Device');
        expect(screen.queryByRole('button', { name: /primary/i })).toBeNull();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[calc(7rem_+_2px)]');
    });

    // Build 125 (125-12), Shane 2026-10-09 at the marina, the Pi reporting:
    // "tapping 'Publish from this device' on the Vessel page will fix it - - i
    // cannot find that message??" With the Pi primary the card had NO button,
    // so a claim held by a forgotten install could not be taken over at all —
    // and the Pi does not publish the public track, so nobody did. Two ideas
    // were one line: where the POSITION comes from, and who PUBLISHES the page.
    it('separates the position source from the public page, and offers the takeover when another device holds it', () => {
        const updateSettings = vi.fn();
        render(
            <SkipperDeviceControl
                claim={FORGOTTEN}
                authenticatedUserId="skipper-user"
                updateSettings={updateSettings}
            />,
        );
        expect(screen.getByText('Position: the Pi')).toBeInTheDocument();
        expect(screen.getByTestId('skipper-device-publisher')).toHaveTextContent(
            'Public page: iPhone/iPad · 7e1a · claimed 32 days ago',
        );
        expect(screen.queryByTestId('skipper-device-pi-primary')).toBeNull();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[calc(7rem_+_2px)]');

        fireEvent.click(screen.getByRole('button', { name: 'Publish from this device' }));
        expect(screen.getByRole('dialog', { name: 'Take over skipper publishing?' })).toHaveTextContent(
            'iPhone/iPad · 7e1a holds your public page — claimed 32 days ago.',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
        expect(updateSettings).toHaveBeenCalledTimes(1);
        expect(updateSettings).toHaveBeenCalledWith({
            skipperDevice: expect.objectContaining({ deviceId: getDeviceId() }),
        });
    });

    it('names this phone as the publisher while the Pi gives the position, and keeps the Pi line', () => {
        render(
            <SkipperDeviceControl
                claim={{ deviceId: getDeviceId(), deviceName: 'iPhone · 9f3a', claimedAt: new Date().toISOString() }}
                authenticatedUserId="skipper-user"
                updateSettings={vi.fn()}
            />,
        );
        expect(screen.getByTestId('skipper-device-publisher')).toHaveTextContent(/^Public page: this phone$/);
        expect(screen.getByTestId('skipper-device-pi-primary')).toHaveTextContent('The Pi is the Primary Device');
        expect(screen.queryByRole('button', { name: 'Publish from this device' })).toBeNull();
    });

    it('never says the Pi publishes the public page — it does not yet', () => {
        const { rerender } = render(
            <SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={vi.fn()} />,
        );
        // Unclaimed, every signed-in phone that records with live share on publishes.
        expect(screen.getByTestId('skipper-device-publisher')).toHaveTextContent(/^Public page: any signed-in phone$/);
        expect(screen.getByTestId('skipper-device-publisher')).not.toHaveTextContent(/Pi/);
        rerender(
            <SkipperDeviceControl claim={FORGOTTEN} authenticatedUserId="skipper-user" updateSettings={vi.fn()} />,
        );
        expect(screen.getByTestId('skipper-device-publisher')).not.toHaveTextContent(/Pi/);
        expect(screen.getByTestId('skipper-device-card')).not.toHaveTextContent(/Pi (publishes|is publishing)/i);
    });
});
