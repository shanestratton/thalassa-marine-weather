/**
 * The Log notice's button does the takeover where the skipper is standing
 * (build 125, 125-12). Shane 2026-10-09: "tapping 'Publish from this device'
 * on the Vessel page will fix it - - i cannot find that message??"
 *
 * End to end through the one store both sides read: the notice's button opens
 * the confirm in place, a confirmed takeover writes this device's claim, and
 * the trickle — which re-reads the claim before every push — publishes on its
 * next push. Cancel leaves it vetoed.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
    const state = {
        settings: { liveTrackShare: true } as Record<string, unknown>,
        updateSettings: (patch: Record<string, unknown>) => {
            state.settings = { ...state.settings, ...patch };
        },
    };
    return { state, upserts: [] as unknown[][] };
});

vi.mock('../stores/settingsStore', () => {
    const useSettingsStore = (selector: (state: typeof store.state) => unknown) => selector(store.state);
    useSettingsStore.getState = () => store.state;
    return {
        useSettingsStore,
        refreshSkipperClaim: vi.fn(async () => undefined),
        writeSkipperClaimIfUnchanged: vi.fn(async () => 'failed'),
    };
});
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
}));
vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => ({
            upsert: async (rows: unknown[]) => {
                store.upserts.push(rows);
                return { error: null };
            },
            delete: () => ({ eq: () => ({ lt: async () => ({ error: null }) }) }),
        }),
    },
    getCurrentUser: async () => ({ id: 'user-1' }),
}));
const queue = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../services/shiplog/OfflineQueue', () => ({ getOfflineEntries: async () => queue.slice() }));
vi.mock('@capacitor/preferences', () => {
    const prefs = new Map<string, string>();
    return {
        Preferences: {
            get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
            set: async ({ key, value }: { key: string; value: string }) => {
                prefs.set(key, value);
            },
        },
    };
});

import { SkipperClaimNotice } from '../pages/log/SkipperClaimNotice';
import { noteLiveTrickleHeartbeat, startLiveTrickle, stopLiveTrickle } from '../services/shiplog/LiveTrickle';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const flush = async (pred?: () => boolean) => {
    for (let i = 0; i < 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (pred?.()) return;
    }
};

// A holder seen ten minutes ago: no automatic handover, so only the skipper's
// deliberate takeover can unblock this device. Fictional names.
const LIVE_ELSEWHERE = {
    deviceId: 'dev-fictional-tablet',
    deviceName: 'iPad · 77c1',
    claimedAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
};

const fix = (offsetSec: number) => ({
    id: `fix-${offsetSec}`,
    voyageId: 'voyage-1',
    timestamp: new Date(Date.now() - 120_000 + offsetSec * 1000).toISOString(),
    latitude: 63.43 + offsetSec * 1e-5,
    longitude: 10.39,
    speedKts: 4.2,
    courseDeg: 270,
    entryType: 'auto',
    owner_user_id: 'user-1',
});

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_device_id', 'dev-fictional-this-phone');
    setAuthIdentityScope('user-1');
    store.state.settings = { liveTrackShare: true, skipperDevice: LIVE_ELSEWHERE };
    store.upserts.length = 0;
    queue.length = 0;
    queue.push(fix(0));
});

afterEach(async () => {
    await stopLiveTrickle(false);
});

describe('the Log notice takes over in place', () => {
    it('confirm → the claim is this device’s → the trickle publishes on its next push', async () => {
        startLiveTrickle('voyage-1');
        await flush();
        // Vetoed while the tablet holds the page.
        expect(store.upserts).toHaveLength(0);

        const { rerender } = render(<SkipperClaimNotice isTracking />);
        fireEvent.click(screen.getByRole('button', { name: 'Publish from this device' }));
        expect(screen.getByRole('dialog', { name: 'Take over skipper publishing?' })).toHaveTextContent(
            'iPad · 77c1 holds your public page — last published 10 minutes ago.',
        );
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
        });
        expect((store.state.settings.skipperDevice as { deviceId: string }).deviceId).toBe('dev-fictional-this-phone');
        rerender(<SkipperClaimNotice isTracking />);
        // The notice has nothing left to say.
        expect(screen.queryByText(/Recording, not publishing/i)).toBeNull();

        queue.push(fix(40));
        noteLiveTrickleHeartbeat();
        await flush(() => store.upserts.length >= 1);
        expect(store.upserts).toHaveLength(1);
    });

    it('cancel leaves the page with its holder and this device recording, not publishing', async () => {
        startLiveTrickle('voyage-1');
        render(<SkipperClaimNotice isTracking />);
        fireEvent.click(screen.getByRole('button', { name: 'Publish from this device' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(store.state.settings.skipperDevice).toEqual(LIVE_ELSEWHERE);
        noteLiveTrickleHeartbeat();
        await flush();
        expect(store.upserts).toHaveLength(0);
    });
});
