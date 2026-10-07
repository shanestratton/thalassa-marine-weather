/**
 * AlertsTab — the High seas and Long period rows tell the truth (build 123,
 * W1-02).
 *
 * The intro promises a check about every 30 min sent as a notification, but
 * the server job (supabase/functions/check-weather-alerts) has no wave or
 * swell-period check at all: those two alarms only ever fire from the in-app
 * check, while Thalassa is open. Until the look-ahead server check lands
 * (W2-03) the two rows say so; the other rows keep the intro's promise.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../stores/authStore', () => ({
    useAuthStore: (select: (s: { authChecked: boolean; user: unknown }) => unknown) =>
        select({ authChecked: true, user: { id: 'fixture-user' } }),
}));

import { AlertsTab } from '../components/settings/AlertsTab';
import type { NotificationPreferences } from '../types';

const notifications: NotificationPreferences = {
    wind: { enabled: true, threshold: 20 },
    gusts: { enabled: true, threshold: 30 },
    waves: { enabled: true, threshold: 2 },
    swellPeriod: { enabled: true, threshold: 12 },
    visibility: { enabled: false, threshold: 1 },
    uv: { enabled: false, threshold: 8 },
    tempHigh: { enabled: false, threshold: 35 },
    tempLow: { enabled: false, threshold: 5 },
    precipitation: { enabled: false },
};

const renderTab = () =>
    render(
        <AlertsTab
            settings={
                { notifications, units: { waveHeight: 'm', speed: 'kts' } } as unknown as React.ComponentProps<
                    typeof AlertsTab
                >['settings']
            }
            onSave={vi.fn()}
        />,
    );

describe('AlertsTab — which alarms the background check really covers', () => {
    it('says High seas and Long period are checked only with the app open', () => {
        renderTab();
        expect(screen.getAllByText('Only with app open')).toHaveLength(2);
        expect(screen.getByRole('spinbutton', { name: /^High seas threshold/ })).toHaveAccessibleDescription(
            /only with app open/i,
        );
        expect(screen.getByRole('spinbutton', { name: /^Long period threshold/ })).toHaveAccessibleDescription(
            /only with app open/i,
        );
    });

    it('leaves the alarms the server does check without the caveat', () => {
        renderTab();
        for (const title of ['High wind', 'Gusts', 'Low visibility', 'High UV', 'Heat', 'Cold']) {
            const field = screen.getByRole('spinbutton', { name: new RegExp(`^${title} threshold`) });
            expect(field).not.toHaveAccessibleDescription(/only with app open/i);
        }
    });

    it('keeps the row titles and the stored thresholds as they were', () => {
        renderTab();
        expect(screen.getByText('High seas')).toBeInTheDocument();
        expect(screen.getByText('Long period')).toBeInTheDocument();
        expect(screen.getByRole('spinbutton', { name: /^Long period threshold/ })).toHaveValue(12);
    });
});
