/**
 * Tablet split view, 2026-10-02 (Shane on his iPad):
 * - "can the settings behave the same way as on the iphone?": Settings in a
 *   split pane opens on the menu list (a full-width tablet keeps opening on
 *   Preferences in two columns), and its layout follows the container, not
 *   the screen.
 * - "the glass page is missing the location box": the pinned Glass pane draws
 *   the location box itself.
 */
import React, { useRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
vi.mock('../components/settings/GeneralTab', () => ({
    GeneralTab: () => <section aria-label="Preferences controls" />,
}));
vi.mock('../components/settings/VesselTab', () => ({ VesselTab: () => null }));
vi.mock('../components/settings/AccountTab', () => ({ AccountTab: () => null }));
vi.mock('../components/settings/AlertsTab', () => ({ AlertsTab: () => null }));
vi.mock('../components/settings/LocationsTab', () => ({ LocationsTab: () => null }));
vi.mock('../components/settings/VoyageLogTab', () => ({ VoyageLogTab: () => null }));
vi.mock('../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { SettingsView } from '../components/SettingsModal';
import { PanePortalScope } from '../context/PanePortalContext';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const Settings = () => (
    <SettingsView settings={{} as UserSettings} onSave={vi.fn()} onLocationSelect={vi.fn()} onBack={vi.fn()} />
);
const InPane: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const ref = useRef<HTMLElement>(null);
    return (
        <PanePortalScope enabled paneId="page" frameRef={ref}>
            <section ref={ref}>{children}</section>
        </PanePortalScope>
    );
};

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(`split-${crypto.randomUUID()}`);
    // A tablet-width screen in both cases.
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: true, media: query }) as MediaQueryList);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('Settings in the tablet split view (2026-10-02)', () => {
    it('opens on the menu list inside a split pane, like the iPhone', () => {
        render(
            <InPane>
                <Settings />
            </InPane>,
        );
        expect(screen.getByRole('button', { name: /^Open Preferences settings/ })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Preferences controls' })).toBeNull();
    });

    it('still opens on Preferences full width on a tablet', () => {
        render(<Settings />);
        expect(screen.getByRole('region', { name: 'Preferences controls' })).toBeInTheDocument();
    });

    it('lays out from its container, not the screen', () => {
        const src = readFileSync(resolve(__dirname, '../components/SettingsModal.tsx'), 'utf8');
        expect(src).toContain('<div className="@container w-full h-full">');
        expect(src).toMatch(/@3xl:flex-row/);
        // No screen-width layout breakpoints left in Settings.
        expect(src).not.toMatch(/\bmd:/);
    });
});

describe('The pinned Glass pane draws the location box (2026-10-02)', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');

    it('renders one shared location box in the header and in the split Glass pane', () => {
        expect(app).toMatch(/const renderLocationBox = \(inPane: boolean\) =>/);
        expect(app).toContain('renderLocationBox(false)');
        const pane = app.slice(
            app.indexOf('data-split-pane="glass"'),
            app.indexOf('<aside', app.indexOf('data-split-pane="glass"')),
        );
        expect(pane).toContain('renderLocationBox(true)');
        expect(pane).toContain('data-testid="split-glass-location"');
    });

    it('pulls the Glass up by its brand row and gap only, so its location slot shows', () => {
        expect(app).toMatch(
            /const splitGlassPullUpPx = glassTopLayout\.brandRowHeightPx \+ glassTopLayout\.cardGapPx - SPLIT_LOCATION_TOP_PX;/,
        );
        expect(app).not.toMatch(/env\(safe-area-inset-top\)\) \+ \$\{glassTopLayout\.locationHeaderHeightPx\}px\)\)`/);
    });
});
