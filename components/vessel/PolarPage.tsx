/**
 * PolarPage — Standalone Polar Manager page for the Vessel Hub.
 *
 * Wraps PolarManagerTab with an onBack nav header and connects
 * to the settings context for persist.
 */
import React, { useCallback, useMemo } from 'react';
import { PolarManagerTab } from '../settings/PolarManagerTab';
import { useSettings } from '../../context/SettingsContext';
import { useRoutingPolar } from '../../hooks/useRoutingPolar';
import { PageHeader } from '../ui/PageHeader';
import { authScopedStorageKey } from '../../services/authIdentityScope';

/**
 * The Settings page to open at: Settings reads the tab once when it opens,
 * then clears it — the deep link the Vessel hub uses for Vessel Profile.
 */
const openSettingsAt = (tab: 'general' | 'vessel') => {
    try {
        localStorage.setItem(authScopedStorageKey('thalassa_settings_initial_tab'), tab);
    } catch {
        /* private mode / quota — Settings opens on its menu instead */
    }
};

/** Settings → Preferences, where the Smart Polars switch lives (UX scorecard run 8). */
const openPreferences = () => {
    openSettingsAt('general');
    window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'settings' } }));
};

interface PolarPageProps {
    onBack: () => void;
    onNavigateToNmea?: () => void;
    onOpenVesselProfile?: () => void;
}

export const PolarPage: React.FC<PolarPageProps> = ({ onBack, onNavigateToNmea, onOpenVesselProfile }) => {
    const { settings, updateSettings } = useSettings();
    // The polar routes really sail (130-B6): the resolver the passage HUD and
    // Plan Your Day sail on, so the page's top line is their words too.
    const routing = useRoutingPolar(settings.vessel);

    const handleSave = useCallback(
        (patch: Record<string, unknown>) => {
            updateSettings(patch as Parameters<typeof updateSettings>[0]);
        },
        [updateSettings],
    );

    // 'Choose one in Settings' opens Settings at Vessel profile, where the
    // yacht database is (132-B22): it opened the Settings menu, one more tap
    // and a hunt away.
    const openVesselProfile = useMemo(
        () =>
            onOpenVesselProfile
                ? () => {
                      openSettingsAt('vessel');
                      onOpenVesselProfile();
                  }
                : undefined,
        [onOpenVesselProfile],
    );

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Polars"
                    subtitle="Performance data"
                    onBack={onBack}
                    breadcrumbs={['Boat Binder', 'Polars']}
                />

                {/* ═══ POLAR MANAGER CONTENT ═══ */}
                {/* The page's one clearance for the tab bar (132-B22: the tab
                    under it added a second). */}
                <div
                    className="flex-1 overflow-hidden px-4 min-h-0"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                    data-testid="polars-page-body"
                >
                    <PolarManagerTab
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        settings={settings as any}
                        routesSailOn={routing.label}
                        onSave={handleSave}
                        onNavigateToNmea={onNavigateToNmea}
                        onOpenVesselProfile={openVesselProfile}
                        onOpenPreferences={openPreferences}
                    />
                </div>
            </div>
        </div>
    );
};
