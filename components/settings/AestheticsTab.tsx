/**
 * AestheticsTab — Display mode, orientation lock, always-on.
 * Extracted from SettingsModal monolith.
 */
import React from 'react';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { DisplayMode, ScreenOrientationType } from '../../types';

const DISPLAY_MODES: { value: DisplayMode; label: string; icon: string; desc: string; gradient: string }[] = [
    {
        value: 'light',
        label: 'Light',
        icon: '☀️',
        desc: 'Daytime use',
        gradient: 'from-amber-500/20 to-amber-600/20 border-amber-500/40 shadow-amber-500/20',
    },
    {
        value: 'dark',
        label: 'Dark',
        icon: '🌙',
        desc: 'Default',
        gradient: 'from-sky-500/20 to-sky-600/20 border-sky-500/40 shadow-sky-500/20',
    },
    {
        value: 'night',
        label: 'Night',
        icon: '🔴',
        desc: 'Red tint',
        gradient: 'from-red-500/20 to-red-600/20 border-red-500/40 shadow-red-500/20',
    },
    {
        value: 'auto',
        label: 'Auto',
        icon: '🔄',
        desc: 'Sunrise/sunset',
        gradient: 'from-violet-500/20 to-violet-600/20 border-violet-500/40 shadow-violet-500/20',
    },
];

const ORIENTATION_OPTIONS: {
    value: ScreenOrientationType;
    label: string;
    icon: string;
    desc: string;
    gradient: string;
    recommended?: boolean;
}[] = [
    {
        value: 'auto',
        label: 'Auto',
        icon: '🔄',
        desc: 'Rotates freely',
        gradient: 'from-sky-500/20 to-sky-600/20 border-sky-500/40 shadow-sky-500/20',
    },
    {
        value: 'portrait',
        label: 'Portrait',
        icon: '📱',
        desc: 'Recommended',
        gradient: 'from-emerald-500/20 to-emerald-600/20 border-emerald-500/40 shadow-emerald-500/20',
        recommended: true,
    },
    {
        value: 'landscape',
        label: 'Landscape',
        icon: '🖥️',
        desc: 'Wide view',
        gradient: 'from-amber-500/20 to-amber-600/20 border-amber-500/40 shadow-amber-500/20',
    },
];

export const AestheticsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const currentOrientation = settings.screenOrientation || 'auto';
    const currentMode = settings.displayMode || 'auto';

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            <Section title="Display Mode">
                <div className="p-4">
                    <p className="text-xs text-gray-400 mb-4">
                        Choose how Thalassa looks. Auto switches between light and dark based on sunrise/sunset times.
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                        {DISPLAY_MODES.map((opt) => {
                            const isActive = currentMode === opt.value;
                            return (
                                <button
                                    aria-label="Save theme selection"
                                    key={opt.value}
                                    onClick={() => onSave({ displayMode: opt.value })}
                                    className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all duration-300 active:scale-95 ${
                                        isActive
                                            ? `bg-gradient-to-br ${opt.gradient} shadow-lg`
                                            : 'bg-white/5 border-transparent hover:bg-white/10 hover:border-white/10'
                                    }`}
                                >
                                    <span className="text-xl">{opt.icon}</span>
                                    <span
                                        className={`text-[11px] font-black uppercase tracking-wider ${isActive ? 'text-white' : 'text-gray-400'}`}
                                    >
                                        {opt.label}
                                    </span>
                                    <span
                                        className={`text-[11px] leading-tight ${isActive ? 'text-white/70' : 'text-gray-400'}`}
                                    >
                                        {opt.desc}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </Section>

            <Section title="Visual Preferences">
                <Row>
                    <div className="flex-1">
                        <label className="text-sm text-white font-medium block">Always On Display</label>
                        <p className="text-xs text-gray-400">Prevent screen from sleeping</p>
                    </div>
                    <Toggle checked={settings.alwaysOn || false} onChange={(v) => onSave({ alwaysOn: v })} />
                </Row>
            </Section>

            <Section title="Display Orientation">
                <div className="p-4">
                    <p className="text-xs text-gray-400 mb-4">
                        Lock your screen orientation. Portrait is recommended for the best experience.
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                        {ORIENTATION_OPTIONS.map((opt) => {
                            const isActive = currentOrientation === opt.value;
                            return (
                                <button
                                    aria-label="Save theme selection"
                                    key={opt.value}
                                    onClick={() => onSave({ screenOrientation: opt.value })}
                                    className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-300 active:scale-95 ${
                                        isActive
                                            ? `bg-gradient-to-br ${opt.gradient} shadow-lg`
                                            : 'bg-white/5 border-transparent hover:bg-white/10 hover:border-white/10'
                                    }`}
                                >
                                    <span className="text-2xl">{opt.icon}</span>
                                    <span
                                        className={`text-xs font-black uppercase tracking-wider ${isActive ? 'text-white' : 'text-gray-400'}`}
                                    >
                                        {opt.label}
                                    </span>
                                    <span
                                        className={`text-[11px] ${isActive ? 'text-white/70' : opt.recommended ? 'text-emerald-400/70' : 'text-gray-400'}`}
                                    >
                                        {opt.desc}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </Section>
        </div>
    );
};
