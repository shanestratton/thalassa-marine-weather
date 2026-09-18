import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types';
import type { SettingsTabProps } from '../components/settings/SettingsPrimitives';

const mocks = vi.hoisted(() => ({
    updateSettings: vi.fn(),
    panelRender: vi.fn(),
    panelUnmount: vi.fn(),
}));

vi.mock('../stores/settingsStore', async () => {
    const { create } = await import('zustand');
    const useSettingsStore = create(() => ({
        settings: { subscriptionTier: 'free', piCacheHost: 'boat.local' } as UserSettings,
        updateSettings: mocks.updateSettings,
    }));
    return { useSettingsStore };
});

vi.mock('../components/settings/PiCacheTab', () => ({
    PiCacheTab: (props: SettingsTabProps) => {
        mocks.panelRender(props);
        React.useEffect(() => () => mocks.panelUnmount(), []);
        return (
            <section aria-label="Pi setup controls">
                <p>{props.settings.piCacheHost}</p>
                <button onClick={() => props.onSave({ piCachePrefetch: false })}>Save cache preference</button>
            </section>
        );
    },
}));

vi.mock('../context/SettingsContext', () => ({ useSettings: () => ({ resetSettings: vi.fn() }) }));
vi.mock('../services/weatherService', () => ({ reverseGeocode: vi.fn() }));
vi.mock('../services/GpsService', () => ({ GpsService: {} }));
vi.mock('../services/SubscriptionService', () => ({
    PUBLIC_BETA_ACCESS: { enabled: true, label: 'Public beta', message: 'All features available' },
}));
vi.mock('../components/settings/GeneralTab', () => ({
    GeneralTab: () => <section aria-label="Preferences controls" />,
}));
vi.mock('../components/settings/VesselTab', () => ({
    VesselTab: () => <section aria-label="Vessel profile controls" />,
}));
vi.mock('../components/settings/AccountTab', () => ({ AccountTab: () => null }));
vi.mock('../components/settings/AlertsTab', () => ({ AlertsTab: () => null }));
vi.mock('../components/settings/LocationsTab', () => ({ LocationsTab: () => null }));
vi.mock('../components/settings/VoyageLogTab', () => ({ VoyageLogTab: () => null }));
vi.mock('../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { BoatHardwareIntegrations } from '../components/vessel/BoatHardwareIntegrations';
import { SettingsView } from '../components/SettingsModal';
import { useSettingsStore } from '../stores/settingsStore';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

function renderSettings(): void {
    render(
        <SettingsView
            settings={useSettingsStore.getState().settings}
            onSave={mocks.updateSettings}
            onLocationSelect={vi.fn()}
            onBack={vi.fn()}
        />,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope(`hardware-move-${crypto.randomUUID()}`);
    useSettingsStore.setState({ settings: { subscriptionTier: 'free', piCacheHost: 'boat.local' } as UserSettings });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('Boat Network hardware disclosure', () => {
    it('mounts Pi controls only while its accessible disclosure is open', async () => {
        render(<BoatHardwareIntegrations />);
        const toggle = screen.getByRole('button', { name: 'Boat hardware & integrations' });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(mocks.panelRender).not.toHaveBeenCalled();

        fireEvent.click(toggle);
        const panel = await screen.findByRole('region', { name: 'Pi setup controls' });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const controlledId = toggle.getAttribute('aria-controls');
        expect(controlledId).toBeTruthy();
        expect(document.getElementById(controlledId!)).toContainElement(panel);

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('region', { name: 'Pi setup controls' })).not.toBeInTheDocument();
        expect(mocks.panelUnmount).toHaveBeenCalledOnce();
    });

    it('passes current settings and the existing save callback to the Pi controls', async () => {
        render(<BoatHardwareIntegrations />);
        fireEvent.click(screen.getByRole('button', { name: 'Boat hardware & integrations' }));
        await screen.findByRole('region', { name: 'Pi setup controls' });
        expect(screen.getByText('boat.local')).toBeInTheDocument();

        act(() => {
            useSettingsStore.setState({
                settings: { ...useSettingsStore.getState().settings, piCacheHost: 'updated-boat.local' },
            });
        });
        expect(screen.getByText('updated-boat.local')).toBeInTheDocument();
        expect(mocks.panelRender).toHaveBeenLastCalledWith({
            settings: useSettingsStore.getState().settings,
            onSave: mocks.updateSettings,
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save cache preference' }));
        expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ piCachePrefetch: false });
    });
});

describe('Settings after the hardware move', () => {
    it.each([false, true])('consumes a stale hardware hint and restores the default (desktop: %s)', (desktop) => {
        vi.spyOn(window, 'matchMedia').mockImplementation(
            (query) => ({ matches: desktop, media: query }) as MediaQueryList,
        );
        const hintKey = authScopedStorageKey('thalassa_settings_initial_tab');
        localStorage.setItem(hintKey, 'boatNetwork');

        renderSettings();

        expect(localStorage.getItem(hintKey)).toBeNull();
        expect(screen.queryByText('Advanced — Boat Hardware & Integrations')).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Pi setup controls' })).not.toBeInTheDocument();
        if (desktop) {
            expect(screen.getByRole('region', { name: 'Preferences controls' })).toBeInTheDocument();
        } else {
            expect(screen.getByRole('button', { name: 'Open Preferences settings' })).toBeInTheDocument();
            expect(screen.queryByRole('region', { name: 'Preferences controls' })).not.toBeInTheDocument();
        }
    });

    it('still opens and consumes a current vessel-profile hint', () => {
        const hintKey = authScopedStorageKey('thalassa_settings_initial_tab');
        localStorage.setItem(hintKey, 'vessel');

        renderSettings();

        expect(screen.getByRole('region', { name: 'Vessel profile controls' })).toBeInTheDocument();
        expect(localStorage.getItem(hintKey)).toBeNull();
    });
});
