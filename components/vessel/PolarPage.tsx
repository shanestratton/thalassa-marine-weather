/**
 * PolarPage — Standalone Polar Manager page for the Vessel Hub.
 *
 * Wraps PolarManagerTab with an onBack nav header and connects
 * to the settings context for persist.
 */
import React, { useCallback } from 'react';
import { PolarManagerTab } from '../settings/PolarManagerTab';
import { useSettings } from '../../context/SettingsContext';
import { PageHeader } from '../ui/PageHeader';
import { authScopedStorageKey } from '../../services/authIdentityScope';

/**
 * Settings → Preferences, where the Smart Polars switch lives (UX scorecard
 * run 8). The same deep link the Vessel hub uses for Vessel Profile: Settings
 * reads the tab once when it opens, then clears it.
 */
const openPreferences = () => {
    try {
        localStorage.setItem(authScopedStorageKey('thalassa_settings_initial_tab'), 'general');
    } catch {
        /* private mode / quota — Settings opens on its menu instead */
    }
    window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'settings' } }));
};

interface PolarPageProps {
    onBack: () => void;
    onNavigateToNmea?: () => void;
    onOpenVesselProfile?: () => void;
}

export const PolarPage: React.FC<PolarPageProps> = ({ onBack, onNavigateToNmea, onOpenVesselProfile }) => {
    const { settings, updateSettings } = useSettings();

    const handleSave = useCallback(
        (patch: Record<string, unknown>) => {
            updateSettings(patch as Parameters<typeof updateSettings>[0]);
        },
        [updateSettings],
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
                <div
                    className="flex-1 overflow-hidden px-4 min-h-0"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                >
                    <PolarManagerTab
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        settings={settings as any}
                        onSave={handleSave}
                        onNavigateToNmea={onNavigateToNmea}
                        onOpenVesselProfile={onOpenVesselProfile}
                        onOpenPreferences={openPreferences}
                    />
                </div>
            </div>
        </div>
    );
};
