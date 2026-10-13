/**
 * Settings → Alerts, beside the cyclone switch (129-06): "Official marine
 * warnings at the boat" (on by default) and its "Small craft advisories"
 * sub-switch (on, and mutable). Both stay hidden until the official warnings
 * watcher has answered (official_alerts_watch_status, held migration
 * 20261014160000): a build that ships before the deploy never offers a switch
 * nothing honours. Land warnings are in the app only, and it says so.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ official: vi.fn(), cyclone: vi.fn() }));
vi.mock('../services/officialAlertsWatchStatus', () => ({ fetchOfficialAlertsWatchStatus: status.official }));
vi.mock('../services/cycloneWatchStatus', () => ({ fetchCycloneWatchStatus: status.cyclone }));
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
                {
                    notifications,
                    units: {},
                    homePort: 'Zzbaytown (39.1, -76.4)',
                    ...extra,
                } as unknown as React.ComponentProps<typeof AlertsTab>['settings']
            }
            onSave={onSave}
        />,
    );
    return onSave;
}

const MARINE = { name: 'Official marine warnings at the boat' };
const SMALL_CRAFT = { name: 'Small craft advisories' };
const answered = () => ({ ranAt: new Date().toISOString() });

describe('Official marine warnings at the boat', () => {
    beforeEach(() => {
        status.official.mockReset();
        status.cyclone.mockReset();
        status.cyclone.mockResolvedValue(null);
    });

    it('is hidden until the watcher answers, and while the question is out', async () => {
        status.official.mockResolvedValue(null);
        renderTab();
        await waitFor(() => expect(status.official).toHaveBeenCalled());
        expect(screen.queryByRole('switch', MARINE)).toBeNull();
        expect(screen.queryByRole('switch', SMALL_CRAFT)).toBeNull();
        expect(screen.queryByText(/official/i)).toBeNull();
    });

    it('stays hidden while the question is still out', () => {
        status.official.mockReturnValue(new Promise(() => undefined));
        renderTab();
        expect(screen.queryByRole('switch', MARINE)).toBeNull();
    });

    it('once answered: both on by default; turning each off is saved', async () => {
        status.official.mockResolvedValue(answered());
        const onSave = renderTab();
        const marine = await screen.findByRole('switch', MARINE);
        const smallCraft = screen.getByRole('switch', SMALL_CRAFT);
        expect(marine).toHaveAttribute('aria-checked', 'true');
        expect(smallCraft).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(smallCraft);
        expect(onSave).toHaveBeenCalledWith({ smallCraftAdvisories: false });
        fireEvent.click(marine);
        expect(onSave).toHaveBeenCalledWith({ officialMarineWarnings: false });
    });

    it('says what each sends, and that land warnings stay in the app', async () => {
        status.official.mockResolvedValue(answered());
        renderTab();
        await screen.findByRole('switch', MARINE);
        const section = screen.getByRole('heading', { level: 2, name: 'Official warnings' }).parentElement!;
        expect(within(section).getByText(/at once/)).toBeInTheDocument();
        expect(within(section).getByText(/07:00/)).toBeInTheDocument();
        expect(within(section).getByText(/Land warnings show in the app only/)).toBeInTheDocument();
    });

    it('reads saved offs as off; with marine warnings off the sub-switch cannot be turned on', async () => {
        status.official.mockResolvedValue(answered());
        const onSave = renderTab({ officialMarineWarnings: false, smallCraftAdvisories: false });
        expect(await screen.findByRole('switch', MARINE)).toHaveAttribute('aria-checked', 'false');
        const smallCraft = screen.getByRole('switch', SMALL_CRAFT);
        expect(smallCraft).toHaveAttribute('aria-checked', 'false');
        expect(smallCraft).toBeDisabled();
        fireEvent.click(smallCraft);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('says when the watcher last checked if it has gone quiet', async () => {
        status.official.mockResolvedValue({ ranAt: '2026-09-01T03:10:00Z' });
        renderTab();
        expect(await screen.findByText('Not checked since 1 Sep 03:10 UTC')).toBeInTheDocument();
    });

    it('sits beside the cyclone switch, each hidden or shown by its own watcher', async () => {
        status.official.mockResolvedValue(answered());
        status.cyclone.mockResolvedValue({ ranAt: new Date().toISOString(), unavailableSince: null });
        renderTab();
        await screen.findByRole('switch', MARINE);
        await screen.findByRole('switch', { name: 'Cyclone warnings near the boat' });
        const official = screen.getByRole('heading', { level: 2, name: 'Official warnings' }).parentElement!;
        const cyclones = screen.getByRole('heading', { level: 2, name: 'Cyclones' }).parentElement!;
        // Neighbouring sections: the safety pushes sit together.
        expect([official.nextElementSibling, official.previousElementSibling]).toContain(cyclones);
    });
});
