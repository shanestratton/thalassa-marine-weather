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

interface PolarPageProps {
    onBack: () => void;
    onNavigateToNmea?: () => void;
}

export const PolarPage: React.FC<PolarPageProps> = ({ onBack, onNavigateToNmea }) => {
    const { settings, updateSettings } = useSettings();

    const handleSave = useCallback((patch: Record<string, unknown>) => {
        updateSettings(patch as Parameters<typeof updateSettings>[0]);
    }, [updateSettings]);

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">

                <PageHeader
                    title="Polars"
                    subtitle="Performance Data"
                    onBack={onBack}
                    breadcrumbs={['Ship\'s Office', 'Polars']}
                />

                {/* ═══ POLAR MANAGER CONTENT ═══ */}
                <div className="flex-1 overflow-hidden px-4 min-h-0" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                    <PolarManagerTab
                        settings={settings as any}
                        onSave={handleSave}
                        onNavigateToNmea={onNavigateToNmea}
                    />
                </div>
            </div>
        </div>
    );
};
