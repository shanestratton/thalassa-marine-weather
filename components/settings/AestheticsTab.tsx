/**
 * AestheticsTab — Display mode, orientation lock, always-on.
 * Extracted from SettingsModal monolith.
 */
import React, { useState } from 'react';
import { readScreenDimSettings, writeScreenDimSettings, type ScreenDimSettings } from '../../services/screenDim';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { DisplayMode, ScreenOrientationType } from '../../types';
import { SunIcon, MoonIcon, RefreshIcon, PhoneIcon } from '../Icons';

// Small inline icon for "Night mode" — a red-tint moon.
const RedMoonIcon = ({ className }: { className?: string }) => (
    <MoonIcon className={`${className ?? ''} text-red-400`} />
);
// Inline icon for landscape orientation — phone rotated 90°.
const LandscapeIcon = ({ className }: { className?: string }) => (
    <span className="inline-flex rotate-90">
        <PhoneIcon className={className} />
    </span>
);

const DISPLAY_MODES: {
    value: DisplayMode;
    label: string;
    Icon: React.FC<{ className?: string }>;
    desc: string;
    gradient: string;
}[] = [
    {
        value: 'light',
        label: 'Light',
        Icon: SunIcon,
        // One line each, so the four tiles stand level: 'Daytime use' took two
        // lines and 'Light / dark by sun' three (UX scorecard run 10).
        desc: 'Daytime',
        gradient: 'from-amber-500/20 to-amber-600/20 border-amber-500/40 shadow-amber-500/20',
    },
    {
        value: 'dark',
        label: 'Dark',
        Icon: MoonIcon,
        desc: 'Default',
        gradient: 'from-sky-500/20 to-sky-600/20 border-sky-500/40 shadow-sky-500/20',
    },
    {
        value: 'night',
        label: 'Night',
        Icon: RedMoonIcon,
        desc: 'Red tint',
        gradient: 'from-red-500/20 to-red-600/20 border-red-500/40 shadow-red-500/20',
    },
    {
        value: 'auto',
        label: 'Auto',
        Icon: RefreshIcon,
        // Honest: auto resolves to light/DARK at sunrise/sunset — it never
        // selects the red Night tint (useAppController: `isNight ? 'dark' :
        // 'light'`). The old "Sunrise/sunset" read as "picks Night for me",
        // so a skipper could leave it on Auto expecting red at 2am. The intro
        // above the tiles says light and dark; the tile keeps to one line.
        desc: 'By the sun',
        gradient: 'from-violet-500/20 to-violet-600/20 border-violet-500/40 shadow-violet-500/20',
    },
];

const ORIENTATION_OPTIONS: {
    value: ScreenOrientationType;
    label: string;
    Icon: React.FC<{ className?: string }>;
    desc: string;
    gradient: string;
    recommended?: boolean;
}[] = [
    {
        value: 'auto',
        label: 'Auto',
        Icon: RefreshIcon,
        desc: 'Rotates freely',
        gradient: 'from-sky-500/20 to-sky-600/20 border-sky-500/40 shadow-sky-500/20',
    },
    {
        value: 'portrait',
        label: 'Portrait',
        Icon: PhoneIcon,
        desc: 'Recommended',
        gradient: 'from-emerald-500/20 to-emerald-600/20 border-emerald-500/40 shadow-emerald-500/20',
        recommended: true,
    },
    {
        value: 'landscape',
        label: 'Landscape',
        Icon: LandscapeIcon,
        desc: 'Wide view',
        gradient: 'from-amber-500/20 to-amber-600/20 border-amber-500/40 shadow-amber-500/20',
    },
];

/**
 * Display mode — the four tiles. Leads Settings → Preferences: it is what a
 * skipper reaches for at night (the red Night tint).
 */
export const DisplayModeSection: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const currentMode = settings.displayMode || 'auto';
    return (
        <Section title="Display mode">
            <div className="p-4">
                <p className="text-xs text-gray-400 mb-4">
                    Choose how Thalassa looks. Auto switches between light and dark based on sunrise/sunset times.
                </p>
                <div className="grid grid-cols-4 gap-2">
                    {DISPLAY_MODES.map((opt) => {
                        const isActive = currentMode === opt.value;
                        return (
                            <button
                                aria-label={`${opt.label} display mode — ${opt.desc}`}
                                aria-pressed={isActive}
                                key={opt.value}
                                onClick={() => onSave({ displayMode: opt.value })}
                                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all duration-300 active:scale-95 ${
                                    isActive
                                        ? `bg-linear-to-br ${opt.gradient} shadow-lg`
                                        : 'bg-white/5 border-transparent hover:bg-white/10 hover:border-white/10'
                                }`}
                            >
                                <span className={`inline-flex ${isActive ? 'text-white' : 'text-gray-300'}`}>
                                    <opt.Icon className="w-5 h-5" />
                                </span>
                                <span
                                    className={`text-xs font-black uppercase tracking-wider ${isActive ? 'text-white' : 'text-gray-400'}`}
                                >
                                    {opt.label}
                                </span>
                                <span
                                    className={`text-xs leading-tight whitespace-nowrap ${isActive ? 'text-white/70' : 'text-gray-400'}`}
                                >
                                    {opt.desc}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </Section>
    );
};

/** A waiting option's words: AlertsTab's disarmed ink, AA in both display modes. */
const WAITING_INK = 'text-[#94a3b8] [.display-light_&]:text-[#5b6b80]';

/**
 * Always on display, and the dim that only works under it. The dim row sits
 * indented under its parent, and while Always on display is off it reads as
 * waiting and says why: it looked fully live, so switching it on seemed to do
 * nothing (UX scorecard run 10). The switch itself still works either way —
 * the preference is kept for when Always on display comes on.
 */
export const VisualPreferencesSection: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    // Device display preference (like theme) — localStorage via screenDim,
    // announced with an event so the app-root ScreenDimHost reacts live.
    const [dim, setDim] = useState(readScreenDimSettings);
    const updateDim = (next: ScreenDimSettings) => {
        setDim(next);
        writeScreenDimSettings(next);
    };
    const alwaysOn = settings.alwaysOn || false;

    return (
        <Section title="Visual preferences">
            <Row>
                <div className="flex-1">
                    <label className="text-sm text-white font-medium block">Always on display</label>
                    <p className="text-xs text-gray-400">Prevent screen from sleeping</p>
                </div>
                <Toggle label="Always on display" checked={alwaysOn} onChange={(v) => onSave({ alwaysOn: v })} />
            </Row>
            {/* Indented under Always on display: it is that switch's option.
                Waiting, its words step down to the Notifications page's
                disarmed ink (a colour, not opacity, so it keeps AA: ~7:1 on
                the dark card, ~5:1 on the daylight one). */}
            <Row className="pl-10">
                <div className="flex-1">
                    <label className={`text-sm font-medium block ${alwaysOn ? 'text-white' : WAITING_INK}`}>
                        Dim while always on
                    </label>
                    <p className={`text-xs ${alwaysOn ? 'text-gray-400' : WAITING_INK}`}>
                        Dims after 20 s idle to save battery — any touch wakes it. Alarms and MOB always show at full
                        brightness.
                    </p>
                    {!alwaysOn && (
                        <p className="mt-1 text-xs font-semibold text-gray-300">
                            Applies while Always on display is on
                        </p>
                    )}
                </div>
                <Toggle
                    label={
                        alwaysOn ? 'Dim while always on' : 'Dim while always on, applies while Always on display is on'
                    }
                    checked={dim.enabled}
                    onChange={(v) => updateDim({ ...dim, enabled: v })}
                />
            </Row>
            {dim.enabled && (
                <div className="pl-10 pr-4 pb-4">
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-xs text-gray-400">Dim strength</span>
                        <span className="text-sm font-black text-emerald-400 font-mono tabular-nums">{dim.level}%</span>
                    </div>
                    <input
                        aria-label="Screen dim strength"
                        type="range"
                        min={50}
                        max={95}
                        step={5}
                        value={dim.level}
                        onChange={(e) => updateDim({ ...dim, level: Number(e.target.value) })}
                        className="w-full h-2 bg-slate-800/60 rounded-full accent-emerald-500 appearance-none cursor-pointer"
                        style={{ touchAction: 'none' }}
                    />
                </div>
            )}
        </Section>
    );
};

/** Orientation lock — set once, so Preferences keeps it low on the page. */
export const OrientationSection: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const currentOrientation = settings.screenOrientation || 'auto';
    return (
        <Section title="Display orientation">
            <div className="p-4">
                <p className="text-xs text-gray-400 mb-4">
                    Lock your screen orientation. Portrait is recommended for the best experience.
                </p>
                <div className="grid grid-cols-3 gap-2">
                    {ORIENTATION_OPTIONS.map((opt) => {
                        const isActive = currentOrientation === opt.value;
                        return (
                            <button
                                aria-label={`${opt.label} orientation`}
                                aria-pressed={isActive}
                                key={opt.value}
                                onClick={() => onSave({ screenOrientation: opt.value })}
                                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-300 active:scale-95 ${
                                    isActive
                                        ? `bg-linear-to-br ${opt.gradient} shadow-lg`
                                        : 'bg-white/5 border-transparent hover:bg-white/10 hover:border-white/10'
                                }`}
                            >
                                <span className={`inline-flex ${isActive ? 'text-white' : 'text-gray-300'}`}>
                                    <opt.Icon className="w-6 h-6" />
                                </span>
                                <span
                                    className={`text-xs font-black uppercase tracking-wider ${isActive ? 'text-white' : 'text-gray-400'}`}
                                >
                                    {opt.label}
                                </span>
                                <span
                                    className={`text-xs ${isActive ? 'text-white/70' : opt.recommended ? 'text-emerald-400/70' : 'text-gray-400'}`}
                                >
                                    {opt.desc}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </Section>
    );
};

/**
 * The three appearance sections, without a page wrapper. Settings →
 * Preferences has mounted them since 2026-09-09 (Shane: "can we move the
 * entire aesthetics page to a section inside the preference page"), each on
 * its own so Units can follow Display mode (UX scorecard run 10). This
 * all-in-one form backs AestheticsTab below, the former standalone tab.
 */
export const AestheticsSections: React.FC<SettingsTabProps> = ({ settings, onSave }) => (
    <>
        <DisplayModeSection settings={settings} onSave={onSave} />
        <VisualPreferencesSection settings={settings} onSave={onSave} />
        <OrientationSection settings={settings} onSave={onSave} />
    </>
);

export const AestheticsTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => (
    <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
        <AestheticsSections settings={settings} onSave={onSave} />
    </div>
);
