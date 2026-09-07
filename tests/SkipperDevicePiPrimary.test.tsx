/**
 * The Skipper Device card with the Pi primary — Shane 2026-09-08: "we have on
 * the top line, primary the pi, then the next line says this device?? lets get
 * rid of this device unless there is no pi. also … change the wording to say,
 * The Pi is the Primary Device. thats all. but dont change the height of the
 * card."
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
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

describe('Skipper Device card while the Pi is primary', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-user');
    });

    it('says nothing about this device, reads "The Pi is the Primary Device", and keeps its height', () => {
        render(<SkipperDeviceControl claim={null} authenticatedUserId="skipper-user" updateSettings={vi.fn()} />);
        expect(screen.queryByText('This device')).toBeNull();
        expect(screen.queryByText('Boat GPS')).toBeNull();
        expect(screen.queryByTestId('skipper-device-gps-source')).toBeNull();
        expect(screen.getByTestId('skipper-device-pi-primary')).toHaveTextContent('The Pi is the Primary Device');
        expect(screen.queryByRole('button', { name: /Primary Device/ })).toBeNull();
        expect(screen.getByTestId('skipper-device-card')).toHaveClass('h-[120px]');
    });
});
