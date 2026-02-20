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
}

export const PolarPage: React.FC<PolarPageProps> = ({ onBack }) => {
    const { settings, updateSettings } = useSettings();

    const handleSave = useCallback((patch: Record<string, unknown>) => {
        updateSettings(patch as Parameters<typeof updateSettings>[0]);
    }, [updateSettings]);

    return (
        <div className="w-full max-w-2xl mx-auto px-4 pb-24 pt-4 animate-in fade-in duration-300 overflow-y-auto h-full">

            {/* ═══ HEADER ═══ */}
            <div className="flex items-center gap-3 mb-5">
                <button onClick={onBack} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h1 className="text-lg font-black text-white tracking-wide">Polar Manager</h1>
                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Performance Data</p>
                </div>
            </div>

            {/* ═══ POLAR MANAGER CONTENT ═══ */}
            <PolarManagerTab
                settings={settings as any}
                onSave={handleSave}
            />
        </div>
    );
};
