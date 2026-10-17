/**
 * Settings → Alerts once the background check looks ahead (129-07): the
 * look-ahead choice (6, 12 or 24 h; 24 by default), "Good window opens"
 * (off by default) and the status at the position the check reads, in the
 * server's own words (in the skipper's units, UKMO never quoted).
 *
 * Capability rule: all of it stays hidden until the deployed function reports
 * its version through weather_alert_status() (held migration
 * 20261014190000): a build that ships before the deploy never offers a choice
 * nothing honours. Until then High seas and Long period keep W1-02's "Only
 * with app open"; once the server checks the seas too, that caveat goes, as
 * W1-02 said it would.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ ahead: vi.fn(), official: vi.fn(), cyclone: vi.fn() }));
vi.mock('../services/weatherAlertStatus', () => ({ fetchWeatherAlertStatus: status.ahead }));
vi.mock('../services/officialAlertsWatchStatus', () => ({ fetchOfficialAlertsWatchStatus: status.official }));
vi.mock('../services/cycloneWatchStatus', () => ({ fetchCycloneWatchStatus: status.cyclone }));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (select: (s: { authChecked: boolean; user: unknown }) => unknown) =>
        select({ authChecked: true, user: { id: 'fixture-user' } }),
}));

import { AlertsTab } from '../components/settings/AlertsTab';
import type { NotificationPreferences } from '../types';

const notifications: NotificationPreferences = {
    wind: { enabled: true, threshold: 25 },
    gusts: { enabled: false, threshold: 30 },
    waves: { enabled: true, threshold: 6.56 },
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
                    units: { waveHeight: 'm', speed: 'kts' },
                    defaultLocation: 'Κέρκυρα',
                    ...extra,
                } as unknown as React.ComponentProps<typeof AlertsTab>['settings']
            }
            onSave={onSave}
        />,
    );
    return onSave;
}

const LINES = [
    'Wind: models disagree: ECMWF 28 kt, ICON 14 kt, UKMO not shown (your limit 25 kt).',
    'Seas: no wave model here.',
];
const answered = (over: Record<string, unknown> = {}) => ({
    version: 2,
    ranAt: new Date().toISOString(),
    basis: 'saved',
    lines: LINES,
    ...over,
});

describe('Settings → Alerts: looking ahead', () => {
    beforeEach(() => {
        status.ahead.mockReset();
        status.official.mockResolvedValue(null);
        status.cyclone.mockResolvedValue(null);
    });

    it('is hidden until the deployed function reports its version, and while the question is out', async () => {
        status.ahead.mockReturnValue(new Promise(() => undefined));
        renderTab();
        expect(screen.queryByRole('group', { name: 'Look ahead' })).toBeNull();
        expect(screen.queryByRole('switch', { name: 'Good window opens' })).toBeNull();
        // Until the server checks the seas, W1-02's caveat stays.
        expect(screen.getAllByText('Only with app open')).toHaveLength(2);
    });

    it('stays hidden when nothing answers, or an older function does', async () => {
        status.ahead.mockResolvedValue(null);
        renderTab();
        await waitFor(() => expect(status.ahead).toHaveBeenCalled());
        expect(screen.queryByRole('group', { name: 'Look ahead' })).toBeNull();
        expect(screen.queryByText(/models disagree/)).toBeNull();
    });

    it('an older function (version 1) is not the look-ahead check', async () => {
        status.ahead.mockResolvedValue(answered({ version: 1 }));
        renderTab();
        await waitFor(() => expect(status.ahead).toHaveBeenCalled());
        await Promise.resolve();
        expect(screen.queryByRole('group', { name: 'Look ahead' })).toBeNull();
        expect(screen.getAllByText('Only with app open')).toHaveLength(2);
    });

    it('once it answers: 24 h by default, and a choice is saved', async () => {
        status.ahead.mockResolvedValue(answered());
        const onSave = renderTab();
        const group = await screen.findByRole('group', { name: 'Look ahead' });
        const buttons = within(group).getAllByRole('button');
        expect(buttons.map((b) => b.textContent)).toEqual(['6 h', '12 h', '24 h']);
        expect(within(group).getByRole('button', { name: '24 h' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(within(group).getByRole('button', { name: '12 h' }));
        expect(onSave).toHaveBeenCalledWith({ alertLookaheadHours: 12 });
    });

    it('shows the stored choice', async () => {
        status.ahead.mockResolvedValue(answered());
        renderTab({ alertLookaheadHours: 6 });
        const group = await screen.findByRole('group', { name: 'Look ahead' });
        expect(within(group).getByRole('button', { name: '6 h' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(group).getByRole('button', { name: '24 h' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('"Good window opens" is off by default and turning it on is saved', async () => {
        status.ahead.mockResolvedValue(answered());
        const onSave = renderTab();
        const sw = await screen.findByRole('switch', { name: 'Good window opens' });
        expect(sw).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(sw);
        expect(onSave).toHaveBeenCalledWith({ goodWindowAlerts: true });
    });

    it('says what the check saw at the position, in its own words, with the credit', async () => {
        status.ahead.mockResolvedValue(answered());
        renderTab();
        for (const line of LINES) expect(await screen.findByText(line)).toBeInTheDocument();
        expect(screen.getByText(/at Κέρκυρα/)).toBeInTheDocument();
        expect(screen.getByText('Forecast data: ECMWF, DWD ICON. UKMO counted, never quoted.')).toBeInTheDocument();
        expect(screen.getByText(/2 of 3 models/)).toBeInTheDocument();
    });

    it('the intro claims agreement only for wind and gusts: seas are one wave model, the rest this hour', async () => {
        status.ahead.mockResolvedValue(answered());
        renderTab({ alertLookaheadHours: 12 });
        await screen.findByRole('group', { name: 'Look ahead' });
        const intro = screen.getByText(/^Checked about every 30 min/);
        expect(intro).toHaveTextContent('Wind and gusts: up to 12 h ahead, sent when 2 of 3 models agree.');
        expect(intro).toHaveTextContent('Seas: up to 12 h ahead, from one named wave model.');
        expect(intro).toHaveTextContent('The rest: the hour under way.');
        // Not one promise over all eight thresholds.
        expect(intro.textContent).not.toMatch(/position, up to/);
    });

    it('credits Météo-France when a line quotes its wave model', async () => {
        status.ahead.mockResolvedValue(
            answered({ lines: ['Seas: below your 2 m for the next 24 h: Météo-France MFWAM up to 0.2 m.'] }),
        );
        renderTab();
        expect(
            await screen.findByText('Forecast data: ECMWF, DWD ICON, Météo-France. UKMO counted, never quoted.'),
        ).toBeInTheDocument();
    });

    it('drops "Only with app open" once the server checks the seas too', async () => {
        status.ahead.mockResolvedValue(answered());
        renderTab();
        await screen.findByRole('group', { name: 'Look ahead' });
        expect(screen.queryByText('Only with app open')).toBeNull();
        expect(screen.getByRole('spinbutton', { name: /^High seas threshold/ })).not.toHaveAccessibleDescription(
            /only with app open/i,
        );
    });

    it('says when the check has gone quiet, and when it read the last known position', async () => {
        const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
        status.ahead.mockResolvedValue(answered({ ranAt: old, basis: 'last-known', lines: [] }));
        renderTab();
        expect(await screen.findByText(/^Not checked since /)).toBeInTheDocument();
        expect(screen.getByText(/at your last known position/)).toBeInTheDocument();
    });

    it('with no row for this account yet, says it has not checked here', async () => {
        status.ahead.mockResolvedValue(answered({ basis: null, lines: [] }));
        renderTab();
        expect(await screen.findByText(/Not checked at your position yet/)).toBeInTheDocument();
    });
});
