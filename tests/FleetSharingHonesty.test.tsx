/**
 * Settings → Preferences → "Share what you hear" says only what it does
 * (build 126, 126-01b; roadmap: "'Share what you hear' stops promising
 * earnings and either really shares or hides until it can").
 *
 * - A build without the fleet-feed relay (VITE_FLEET_FEED_URL empty, as every
 *   build is until the relay has a public address) shows no switch: one
 *   honest line, and no consent sheet to accept for something that sends
 *   nothing.
 * - The consent key moved to v2, so an opt-in given in a build that could not
 *   share lapses: the first build that can share asks again. It must never
 *   spring back to life on its own.
 * - Nothing "earns": the watch ledger grants nothing, so the words say a quiet
 *   ocean "counts the same", which is what the ledger does (time on watch).
 *
 * Fictional skipper 'skipper-1' on 'Albatross'.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ user: { id: 'skipper-1' } as { id: string } | null }));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: mocks.user }),
}));
vi.mock('../components/nmea/useNmeaStore', () => ({
    useNmeaConnectionStatus: () => ({ status: 'disconnected' }),
}));
vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: vi.fn(async () => ({ Authorization: 'Bearer test' })),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { FleetSharingSection } from '../components/settings/FleetSharingSection';
import { __resetAisShareForTest, isShareEnabled, startWatch } from '../services/AisShareService';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const RELAY = 'https://relay.example/fleet-feed';
const HONEST = /Sharing what your gateway hears needs a relay this build doesn.t have yet\. It stays off until then\./;

const theSwitch = () => screen.queryByRole('switch', { name: 'Share what you hear' });

beforeEach(() => {
    localStorage.clear();
    mocks.user = { id: 'skipper-1' };
    setAuthIdentityScope(null);
    setAuthIdentityScope('skipper-1');
    __resetAisShareForTest();
});

afterEach(() => {
    cleanup();
    __resetAisShareForTest();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    act(() => {
        setAuthIdentityScope(null);
    });
});

describe('a build without the share relay', () => {
    beforeEach(() => vi.stubEnv('VITE_FLEET_FEED_URL', ''));

    it('offers no switch, only the honest line', () => {
        render(<FleetSharingSection />);
        expect(theSwitch()).toBeNull();
        expect(screen.queryAllByRole('switch')).toHaveLength(0);
        expect(document.body.textContent).toMatch(HONEST);
    });

    it('has no consent sheet to reach', () => {
        render(<FleetSharingSection />);
        // Whatever is there to press, nothing opens a consent sheet.
        for (const control of screen.queryAllByRole('switch')) fireEvent.click(control);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Share what I hear' })).toBeNull();
        expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('promises nothing it cannot do: no earnings, no "nothing is being sent" after a dead switch', () => {
        render(<FleetSharingSection />);
        const text = document.body.textContent ?? '';
        expect(text).not.toMatch(/\bearn/i);
        expect(text).not.toMatch(/no share relay configured/i);
    });
});

describe('a build with the share relay', () => {
    beforeEach(() => vi.stubEnv('VITE_FLEET_FEED_URL', RELAY));

    it('offers the switch, off by default', () => {
        render(<FleetSharingSection />);
        expect(theSwitch()).toHaveAttribute('aria-checked', 'false');
        expect(document.body.textContent).not.toMatch(HONEST);
    });

    it('an opt-in stored under the old v1 key lapses: off, unswitched, no watch timer', () => {
        // 'skipper-1' switched it on in a build that had no relay.
        localStorage.setItem(authScopedStorageKey('ais_share_enabled_v1'), 'true');
        vi.useFakeTimers();
        expect(isShareEnabled()).toBe(false);
        startWatch();
        expect(vi.getTimerCount()).toBe(0);
        render(<FleetSharingSection />);
        expect(theSwitch()).toHaveAttribute('aria-checked', 'false');
        expect(screen.queryByText(/On watch/)).toBeNull();
    });

    it('asks first, and neither the sheet nor the card promises earnings: a quiet ocean counts the same', () => {
        render(<FleetSharingSection />);
        fireEvent.click(theSwitch()!);
        const sheet = screen.getByRole('dialog', { name: 'Share what you hear' });
        expect(sheet.textContent).not.toMatch(/\bearn/i);
        expect(sheet.textContent).toMatch(/counts the same/);
        // A global app: no one country's harbour as the yardstick.
        expect(sheet.textContent).not.toMatch(/Sydney/);
        fireEvent.click(screen.getByRole('button', { name: 'Share what I hear' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(theSwitch()).toHaveAttribute('aria-checked', 'true');
        // The card under the switch, sharing: the low-data line counts the same too.
        expect(screen.getByRole('switch', { name: 'Low-data link' })).toBeInTheDocument();
        const text = document.body.textContent ?? '';
        expect(text).not.toMatch(/\bearn/i);
        expect(text).toMatch(/Counts the same\./);
    });
});
