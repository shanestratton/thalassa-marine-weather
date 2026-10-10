/**
 * The Settings menu fills its screen (Shane 2026-10-09: "i think the words can
 * be bigger also and take up the whole screen claude. same goes for the
 * settings main page"), but a search does not: one matching row stretched to
 * the bottom of the page would read as a broken list. The fill is a class the
 * full menu wears and a search takes off (styles/menu-page-fit.css draws it;
 * browser-tests/menu-pages-fit.spec.ts measures it).
 */
import React, { useRef } from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types';

vi.mock('../stores/settingsStore', async () => {
    const { create } = await import('zustand');
    const useSettingsStore = create(() => ({
        settings: { subscriptionTier: 'free' } as UserSettings,
        updateSettings: vi.fn(),
    }));
    return { useSettingsStore };
});
vi.mock('../context/SettingsContext', () => ({ useSettings: () => ({ resetSettings: vi.fn() }) }));
vi.mock('../services/weatherService', () => ({ reverseGeocode: vi.fn() }));
vi.mock('../services/GpsService', () => ({ GpsService: {} }));
vi.mock('../services/SubscriptionService', () => ({
    PUBLIC_BETA_ACCESS: { enabled: true, label: 'Public beta', message: 'All features available' },
}));
vi.mock('../components/settings/GeneralTab', () => ({ GeneralTab: () => null }));
vi.mock('../components/settings/VesselTab', () => ({ VesselTab: () => null }));
vi.mock('../components/settings/AccountTab', () => ({ AccountTab: () => null }));
vi.mock('../components/settings/AlertsTab', () => ({ AlertsTab: () => null }));
vi.mock('../components/settings/LocationsTab', () => ({ LocationsTab: () => null }));
vi.mock('../components/settings/VoyageLogTab', () => ({ VoyageLogTab: () => null }));
vi.mock('../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: { getConfig: vi.fn(async () => ({ enabled: true })) },
}));

import { SettingsView } from '../components/SettingsModal';
import { PanePortalScope } from '../context/PanePortalContext';
import { setAuthIdentityScope } from '../services/authIdentityScope';

// A home port away from Australia, so the Preferences row has its state.
const SETTINGS = { defaultLocation: 'Horta, Faial, Azores' } as UserSettings;

/** The phone's menu: Settings opens on its list inside a split pane, as on an iPhone. */
const Menu = ({ settings = SETTINGS }: { settings?: UserSettings }) => {
    const ref = useRef<HTMLElement>(null);
    return (
        <PanePortalScope enabled paneId="page" frameRef={ref}>
            <section ref={ref}>
                <SettingsView settings={settings} onSave={vi.fn()} onLocationSelect={vi.fn()} onBack={vi.fn()} />
            </section>
        </PanePortalScope>
    );
};

const list = () => document.querySelector('.settings-menu-list')!;
/** The phone menu's own controls (the wide layout's sidebar has a search too). */
const phone = () => within(document.querySelector<HTMLElement>('.settings-menu-screen')!);

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(`menu-fill-${crypto.randomUUID()}`);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: true, media: query }) as MediaQueryList);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('Settings menu fill (2026-10-09)', () => {
    it('fills the screen with the full menu, each section a group that shares the height', () => {
        render(<Menu />);
        expect(phone().getByRole('button', { name: /^Open Preferences settings, Home: Horta/ })).toBeInTheDocument();
        expect(list()).toHaveClass('settings-menu-fill');
        const groups = list().querySelectorAll(':scope > .settings-menu-group');
        expect(groups).toHaveLength(2);
        // Each row has its hooks: the title line, the title and its live state.
        const row = phone().getByRole('button', { name: /^Open Preferences settings/ });
        expect(row.querySelector('.settings-menu-line > .settings-menu-title')).toHaveTextContent('Preferences');
        expect(
            row.querySelector('.settings-menu-line > .settings-menu-title + .settings-menu-state'),
        ).toHaveTextContent('Home: Horta');
    });

    it('stops filling while a search is active, and fills again once it is cleared', () => {
        render(<Menu />);
        const search = phone().getByRole('searchbox', { name: 'Search settings' });
        fireEvent.change(search, { target: { value: 'alerts' } });
        expect(phone().getAllByRole('button', { name: /^Open .* settings/ })).toHaveLength(1);
        expect(list()).not.toHaveClass('settings-menu-fill');
        fireEvent.change(search, { target: { value: '   ' } });
        expect(list()).toHaveClass('settings-menu-fill');
        fireEvent.change(search, { target: { value: 'zzz-no-such-setting' } });
        expect(list()).not.toHaveClass('settings-menu-fill');
        fireEvent.click(phone().getByRole('button', { name: 'Clear search' }));
        expect(list()).toHaveClass('settings-menu-fill');
        expect(list().querySelectorAll(':scope > .settings-menu-group')).toHaveLength(2);
    });

    it('names and describes every row exactly as before', async () => {
        render(<Menu />);
        // Signed in (the identity scope above), the public page live.
        await phone().findByRole('button', { name: 'Open Public voyage page settings, Live' });
        // All six, in order: the hooks must not move a state into a
        // description, or a description into a name, on any row VoiceOver reads.
        const rows = phone().getAllByRole('button', { name: /^Open .* settings/ });
        expect(rows).toHaveLength(6);
        const expected: [name: string, description: string][] = [
            ['Open Preferences settings, Home: Horta', 'Display, units, clock, forecast model & support'],
            ['Open Vessel Profile settings', 'Boat, safety, comfort limits & crew'],
            ['Open Locations settings, None saved', 'Saved ports & anchorages'],
            ['Open Notifications settings', 'Wind, sea & weather alerts'],
            ['Open Account & Cloud settings, Signed in', 'Sign-in, sync & service status'],
            ['Open Public voyage page settings, Live', 'Where followers ashore see your voyage'],
        ];
        rows.forEach((row, index) => {
            const [name, description] = expected[index];
            expect(row).toHaveAccessibleName(name);
            expect(row).toHaveAccessibleDescription(description);
        });
    });

    // Build 126 (126-14): the row shows a short word so it stays on the title
    // line, while VoiceOver hears exactly what it heard before.
    it('signed out, both sign-in rows show "Sign in" and are heard as before', () => {
        setAuthIdentityScope(null);
        render(<Menu />);
        const account = phone().getByRole('button', { name: 'Open Account & Cloud settings, Not signed in' });
        const voyage = phone().getByRole('button', { name: 'Open Public voyage page settings, Needs sign-in' });
        for (const row of [account, voyage]) {
            const state = row.querySelector('.settings-menu-line > .settings-menu-title + .settings-menu-state')!;
            expect(state).toHaveTextContent(/^Sign in$/);
            // A fixed word: whole on the title line or not at all, never cut.
            expect(state).toHaveClass('settings-menu-state--word');
            expect(state).not.toHaveClass('truncate');
            expect(row.querySelector('.settings-menu-line')).toHaveClass('settings-menu-line--word');
        }
        expect(account.textContent).not.toMatch(/Not signed in/);
        expect(voyage.textContent).not.toMatch(/Needs sign-in/);
    });

    it('no alert on reads "Off", heard "All alerts off"; a home port keeps the free-text rule', () => {
        const notifications = { wind: { enabled: false }, waves: { enabled: false } };
        render(<Menu settings={{ ...SETTINGS, notifications } as unknown as UserSettings} />);
        const row = phone().getByRole('button', { name: 'Open Notifications settings, All alerts off' });
        expect(row.querySelector('.settings-menu-state')).toHaveTextContent(/^Off$/);
        const home = phone().getByRole('button', { name: /^Open Preferences settings, Home: Horta$/ });
        const state = home.querySelector('.settings-menu-state')!;
        expect(state).not.toHaveClass('settings-menu-state--word');
        expect(state).toHaveClass('truncate');
        expect(home.querySelector('.settings-menu-line')).not.toHaveClass('settings-menu-line--word');
    });
});
