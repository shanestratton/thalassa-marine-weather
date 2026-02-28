/**
 * PolarPage — Standalone Polar Manager page for the Vessel Hub.
 *
 * Wraps PolarManagerTab with an onBack nav header and connects
 * to the settings context for persist.
 */
import React, { useCallback } from 'react';
import { PolarManagerTab } from '../settings/PolarManagerTab';
import { useSettings } from '../../context/SettingsContext';

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

                {/* ═══ HEADER ═══ */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center gap-3">
                        <button onClick={onBack} aria-label="Go back" className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center">
                            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <div className="flex-1">
                            <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Polars</h1>
                            <p className="text-xs text-gray-500 font-bold uppercase tracking-widest">Performance Data</p>
                        </div>
                    </div>
                </div>

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
