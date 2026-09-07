import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Releasing the skipper claim used to write `skipperDevice: undefined`. The
 * cloud patch is JSON, an undefined key is dropped on the wire, so the release
 * never reached the account and the other device kept seeing a claim nobody
 * held (2026-09-08). A release writes null — a key the merge can carry.
 */
vi.mock('../services/AnchorWatchService', () => ({ AnchorWatchService: { subscribe: vi.fn(() => vi.fn()) } }));

import { SkipperDeviceControl } from '../components/VesselHub';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getDeviceId } from '../services/skipperDevice';

describe('Skipper Device release', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-user');
    });

    it('writes skipperDevice: null, never undefined', () => {
        const updateSettings = vi.fn();
        render(
            <SkipperDeviceControl
                claim={{ deviceId: getDeviceId(), deviceName: 'This phone', claimedAt: new Date().toISOString() }}
                authenticatedUserId="skipper-user"
                updateSettings={updateSettings}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Release — this is not the Primary Device' }));
        expect(updateSettings).toHaveBeenCalledTimes(1);
        const patch = updateSettings.mock.calls[0][0] as Record<string, unknown>;
        expect(patch).toEqual({ skipperDevice: null });
        expect(Object.prototype.hasOwnProperty.call(patch, 'skipperDevice')).toBe(true);
        expect(JSON.parse(JSON.stringify(patch))).toEqual({ skipperDevice: null });
    });
});
