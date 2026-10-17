/**
 * "Cyclone warnings near the boat" (129-09): a safety push, on by default and
 * never paywalled, in Settings → Alerts with the app's other pushed alerts.
 * Hidden until the watcher's cron has answered, so a build that ships before
 * the deploy never offers a switch nothing honours. Once it has answered, a
 * watcher that has gone quiet or lost its feed says so: never an all-clear.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../services/cycloneWatchStatus', () => ({ fetchCycloneWatchStatus: status.fetch }));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (select: (s: { authChecked: boolean; user: unknown }) => unknown) =>
        select({ authChecked: true, user: { id: 'fixture-user' } }),
}));

import { AlertsTab } from '../components/settings/AlertsTab';
import type { NotificationPreferences } from '../types';

const notifications: NotificationPreferences = {
    wind: { enabled: false, threshold: 20 },
    gusts: { enabled: false, threshold: 30 },
    waves: { enabled: false, threshold: 2 },
    swellPeriod: { enabled: false, threshold: 12 },
    visibility: { enabled: false, threshold: 1 },
    uv: { enabled: false, threshold: 8 },
    tempHigh: { enabled: false, threshold: 35 },
    tempLow: { enabled: false, threshold: 5 },
    precipitation: { enabled: false },
};

function renderTab(extra: Record<string, unknown> = {}) {
    const onSave = vi.fn();
    render(
        <AlertsTab
            settings={
                { notifications, units: {}, ...extra } as unknown as React.ComponentProps<typeof AlertsTab>['settings']
            }
            onSave={onSave}
        />,
    );
    return onSave;
}

const SWITCH = { name: 'Cyclone warnings near the boat' };

describe('Cyclone warnings near the boat', () => {
    beforeEach(() => {
        status.fetch.mockReset();
    });

    it('is hidden until the watcher answers', async () => {
        status.fetch.mockResolvedValue(null);
        renderTab();
        await waitFor(() => expect(status.fetch).toHaveBeenCalled());
        expect(screen.queryByRole('switch', SWITCH)).toBeNull();
        expect(screen.queryByText(/cyclone/i)).toBeNull();
    });

    it('stays hidden while the question is still out', () => {
        status.fetch.mockReturnValue(new Promise(() => undefined));
        renderTab();
        expect(screen.queryByRole('switch', SWITCH)).toBeNull();
    });

    it('once the watcher has answered, is on by default, and turning it off is saved', async () => {
        status.fetch.mockResolvedValue({ ranAt: new Date().toISOString(), unavailableSince: null });
        const onSave = renderTab();
        const sw = await screen.findByRole('switch', SWITCH);
        expect(sw).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(/600 NM/)).toBeInTheDocument();
        expect(screen.getByText(/300 NM/)).toBeInTheDocument();
        fireEvent.click(sw);
        expect(onSave).toHaveBeenCalledWith({ cycloneWarnings: false });
    });

    it('reads a saved off as off', async () => {
        status.fetch.mockResolvedValue({ ranAt: new Date().toISOString(), unavailableSince: null });
        renderTab({ cycloneWarnings: false });
        expect(await screen.findByRole('switch', SWITCH)).toHaveAttribute('aria-checked', 'false');
    });

    it('says when the watcher last checked if it has gone quiet', async () => {
        status.fetch.mockResolvedValue({ ranAt: '2026-09-01T03:10:00Z', unavailableSince: null });
        renderTab();
        expect(await screen.findByText('Not checked since 1 Sep 03:10 UTC')).toBeInTheDocument();
    });

    it('says when the account has no saved position for the watch to measure from', async () => {
        status.fetch.mockResolvedValue({ ranAt: new Date().toISOString(), unavailableSince: null });
        renderTab({ homePort: 'Suva' });
        expect(await screen.findByText(/No home port position is saved/)).toBeInTheDocument();
    });

    it('says nothing of the kind when a home port or the weather location has one', async () => {
        status.fetch.mockResolvedValue({ ranAt: new Date().toISOString(), unavailableSince: null });
        renderTab({ homePort: 'Suva (-18.1416, 178.4419)' });
        await screen.findByRole('switch', SWITCH);
        expect(screen.queryByText(/No home port position is saved/)).toBeNull();
        cleanup();
        renderTab({ defaultLocation: 'Nukuʻalofa', defaultLocationCoords: { lat: -21.14, lon: -175.2 } });
        await screen.findByRole('switch', SWITCH);
        expect(screen.queryByText(/No home port position is saved/)).toBeNull();
    });

    it('says the data is unavailable, never that there are no cyclones', async () => {
        status.fetch.mockResolvedValue({ ranAt: new Date().toISOString(), unavailableSince: '2026-10-14T03:10:00Z' });
        renderTab();
        expect(await screen.findByText('Cyclone data unavailable since 14 Oct 03:10 UTC')).toBeInTheDocument();
        expect(screen.queryByText(/no cyclones|all clear/i)).toBeNull();
    });
});
