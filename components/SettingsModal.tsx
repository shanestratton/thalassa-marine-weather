import React, { useState, useEffect } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SettingsModal');
import { UserSettings } from '../types';
import { BellIcon, ArrowRightIcon, BoatIcon, StarIcon, GearIcon, ServerIcon, MapPinIcon } from './Icons';
import { reverseGeocode } from '../services/weatherService';
import { useThalassa } from '../context/ThalassaContext';
import { GpsService } from '../services/GpsService';

import { AlertsTab } from './settings/AlertsTab';
import { AestheticsTab } from './settings/AestheticsTab';
import { VesselTab } from './settings/VesselTab';
import { GeneralTab } from './settings/GeneralTab';
import { AccountTab } from './settings/AccountTab';
import { LocationsTab } from './settings/LocationsTab';
import { CalypsoIntegrationsTab } from './settings/CalypsoIntegrationsTab';
import { CalypsoKnowledgeTab } from './settings/CalypsoKnowledgeTab';
import { PiCacheTab } from './settings/PiCacheTab';
import { VoyageLogTab } from './settings/VoyageLogTab';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { authScopedStorageKey } from '../services/authIdentityScope';

interface SettingsViewProps {
    settings: UserSettings;
    onSave: (settings: Partial<UserSettings>) => void;
    onLocationSelect: (location: string) => void;
    onBack?: () => void;
}

// Settings tab-nav button. Rewritten 2026-05-17 to align with the
// Minimal v3 active-state language that the bottom nav adopted on
// the same day. The previous treatment was three signals stacked
// (gradient bg + 20 px sky-glow shadow + left-border highlight +
// scale-110 icon tile + animate-pulse arrow + translate-x label) —
// fine in isolation but it screamed against the toned-down bottom
// nav within the same app session. One active-state language now:
// solid sky-500 left-bar (the "you are here" anchor) + brighter
// label/icon (the inherent color cue) + subtle bg tint. No glow,
// no scale, no pulse.
const NavButton = React.memo(
    ({
        active,
        onClick,
        icon,
        label,
    }: {
        active: boolean;
        onClick: () => void;
        icon: React.ReactNode;
        label: string;
    }) => (
        <button
            aria-label={label}
            onClick={onClick}
            className={`relative flex items-center gap-3 w-full pl-4 pr-3 py-2.5 rounded-lg transition-colors duration-150 text-left ${
                active ? 'bg-white/[0.04] text-white' : 'text-slate-400 hover:bg-white/[0.03] hover:text-slate-200'
            }`}
        >
            {/* Single-pixel anchor bar. Solid sky-500 at full opacity
                so it reads cleanly without a halo. Mirrors the bottom-
                nav indicator-dot pattern: one solid mark, no glow. */}
            {active && (
                <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-sky-500" aria-hidden="true" />
            )}
            <span className={active ? 'text-sky-300' : 'text-slate-400'}>{icon}</span>
            <span className="font-semibold text-sm tracking-wide">{label}</span>
        </button>
    ),
);

const _MobileNavTab = React.memo(
    ({
        active,
        onClick,
        icon,
        label,
    }: {
        active: boolean;
        onClick: () => void;
        icon: React.ReactNode;
        label: string;
    }) => (
        <button
            aria-label={label}
            onClick={onClick}
            className={`flex items-center gap-2 px-4 py-2 rounded-full whitespace-nowrap transition-all duration-300 ${active ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/30' : 'bg-white/5 text-gray-400 border border-white/5'}`}
        >
            {icon}
            <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
        </button>
    ),
);

// Toggle — imported from ./settings/SettingsPrimitives

// Section, Row — imported from ./settings/SettingsPrimitives

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MetricInput = ({
    label,
    valInStandard,
    unitType,
    unitOptions,
    onChangeValue,
    onChangeUnit,
    placeholder,
    isEstimated,
}: {
    label: string;
    valInStandard: number;
    unitType: string;
    unitOptions: string[];
    onChangeValue: (v: number) => void;
    onChangeUnit: (u: string) => void;
    placeholder?: string;
    isEstimated?: boolean;
}) => {
    const isWeight = unitOptions.includes('lbs');
    const [localStr, setLocalStr] = useState<string>('');

    useEffect(() => {
        const displayVal = isWeight
            ? unitType === 'kg'
                ? valInStandard * 0.453592
                : unitType === 'tonnes'
                  ? valInStandard * 0.000453592
                  : valInStandard
            : unitType === 'm'
              ? valInStandard * 0.3048
              : valInStandard;

        const currentParsed = parseFloat(localStr);
        if (isNaN(currentParsed) || Math.abs(currentParsed - displayVal) > 0.01) {
            setLocalStr(displayVal.toFixed(2));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [valInStandard, unitType, isWeight]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => setLocalStr(e.target.value);

    const handleBlur = () => {
        const num = parseFloat(localStr);
        if (!isNaN(num)) {
            const standard = isWeight
                ? unitType === 'kg'
                    ? num * 2.20462
                    : unitType === 'tonnes'
                      ? num * 2204.62
                      : num
                : unitType === 'm'
                  ? num * 3.28084
                  : num;
            onChangeValue(standard);
            setLocalStr(num.toFixed(2));
        }
    };

    return (
        <div className="flex-1 min-w-[120px] group">
            <div className="flex justify-between items-center mb-1.5 ml-1">
                <label
                    className={`text-[11px] uppercase tracking-wider font-bold block transition-colors ${isEstimated ? 'text-red-400' : 'text-gray-400 group-hover:text-sky-300'}`}
                >
                    {label}
                </label>
                {isEstimated && (
                    <span className="text-[11px] bg-red-500/10 border border-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-bold uppercase shadow-[0_0_10px_rgba(239,68,68,0.2)]">
                        Est.
                    </span>
                )}
            </div>
            <div
                className={`flex bg-black/40 border rounded-xl overflow-hidden transition-all duration-300 ${isEstimated ? 'border-red-500/50 focus-within:border-red-500 focus-within:shadow-[0_0_15px_rgba(239,68,68,0.3)]' : 'border-white/10 focus-within:border-sky-500 focus-within:shadow-[0_0_15px_rgba(14,165,233,0.3)] group-hover:border-white/20'}`}
            >
                <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={localStr}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    className={`flex-1 bg-transparent px-3 py-2 outline-none w-full text-sm font-mono placeholder-gray-700 transition-colors ${isEstimated ? 'text-red-300' : 'text-white focus:text-sky-200'}`}
                    placeholder={placeholder}
                />
                <select
                    value={unitType}
                    onChange={(e) => onChangeUnit(e.target.value)}
                    className="bg-white/5 text-gray-300 text-xs font-bold px-3 py-2 outline-none border-l border-white/10 hover:text-white hover:bg-white/10 focus:bg-white/10 cursor-pointer uppercase transition-all appearance-none bg-no-repeat bg-[length:10px_10px] bg-[right_8px_center]"
                    style={{
                        backgroundImage:
                            'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 10 6%27%3E%3Cpath d=%27M1 1l4 4 4-4%27 stroke=%27%2394a3b8%27 stroke-width=%271.5%27 fill=%27none%27 stroke-linecap=%27round%27/%3E%3C/svg%3E")',
                        paddingRight: '24px',
                    }}
                >
                    {unitOptions.map((opt: string) => (
                        <option key={opt} value={opt} className="bg-slate-900 text-gray-300">
                            {opt}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
};

type SettingsTab =
    | 'general'
    | 'account'
    | 'vessel'
    | 'alerts'
    | 'scenery'
    | 'locations'
    | 'layout'
    | 'calypso'
    | 'calypsoKnowledge'
    | 'boatNetwork'
    | 'voyageLog';

/**
 * Section grouping for the Settings tab list.
 *
 * Scorecard fix 2026-05-17: the previous flat list of 10 tabs put
 * Pi Cache and Calypso (which 95 % of users will never touch — they
 * exist for the on-boat hardware integration story) on the same
 * shelf as Account and Notifications (which every user touches).
 * That dilutes discoverability for the items that matter and makes
 * the Settings surface read as "everything-and-the-kitchen-sink".
 *
 * Now grouped into four sections, declared in render order:
 *   - essentials      — what every user actually configures
 *   - sharing         — outward-facing (cloud sync, public log)
 *   - appearance      — personalisation
 *   - advanced        — boat-hardware + integrations, collapsed
 *
 * The Advanced section collapses by default (via <details>) so it
 * doesn't take cognitive space until the user goes looking for it.
 */
type SettingsGroup = 'essentials' | 'sharing' | 'appearance' | 'advanced';

const SETTINGS_GROUPS: { id: SettingsGroup; label: string; collapsibleByDefault: boolean }[] = [
    { id: 'essentials', label: 'Essentials', collapsibleByDefault: false },
    { id: 'sharing', label: 'Account & Sharing', collapsibleByDefault: false },
    { id: 'appearance', label: 'Appearance', collapsibleByDefault: false },
    { id: 'advanced', label: 'Advanced — Boat Hardware & Integrations', collapsibleByDefault: true },
];

const MENU_ITEMS: {
    id: SettingsTab;
    label: string;
    description: string;
    icon: (cls: string) => React.ReactNode;
    iconBg: string;
    iconHoverBg: string;
    group: SettingsGroup;
}[] = [
    // ── ESSENTIALS ──────────────────────────────────────────────
    {
        id: 'general',
        label: 'Preferences',
        description: 'Units, location & AI personality',
        icon: (c) => <GearIcon className={c} />,
        iconBg: 'bg-sky-500/15 text-sky-400 shadow-sky-500/10',
        iconHoverBg: 'group-hover:bg-sky-500/25',
        group: 'essentials',
    },
    {
        id: 'vessel',
        label: 'Vessel Profile',
        description: 'Boat specs, rig & safety gear',
        icon: (c) => <BoatIcon className={c} />,
        iconBg: 'bg-amber-500/15 text-amber-400 shadow-amber-500/10',
        iconHoverBg: 'group-hover:bg-amber-500/25',
        group: 'essentials',
    },
    {
        id: 'locations',
        label: 'Locations',
        description: 'Saved ports & anchorages',
        icon: (c) => <MapPinIcon className={c} />,
        iconBg: 'bg-emerald-500/15 text-emerald-400 shadow-emerald-500/10',
        iconHoverBg: 'group-hover:bg-emerald-500/25',
        group: 'essentials',
    },
    {
        id: 'alerts',
        label: 'Notifications',
        description: 'Anchor alarm, weather alerts',
        icon: (c) => <BellIcon className={c} />,
        iconBg: 'bg-red-500/15 text-red-400 shadow-red-500/10',
        iconHoverBg: 'group-hover:bg-red-500/25',
        group: 'essentials',
    },

    // ── ACCOUNT & SHARING ───────────────────────────────────────
    {
        id: 'account',
        label: 'System & Cloud',
        description: 'Cloud sync, API keys & account',
        icon: (c) => <ServerIcon className={c} />,
        iconBg: 'bg-purple-500/15 text-purple-400 shadow-purple-500/10',
        iconHoverBg: 'group-hover:bg-purple-500/25',
        group: 'sharing',
    },
    {
        id: 'voyageLog',
        label: 'Voyage Log',
        description: 'Public passage page & API',
        icon: (c) => (
            <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0a8.949 8.949 0 004.951-1.488M12 21a8.949 8.949 0 01-4.951-1.488M3.6 9h16.8M3.6 15h16.8M12 3a13.5 13.5 0 000 18 13.5 13.5 0 000-18z"
                />
            </svg>
        ),
        iconBg: 'bg-sky-500/15 text-sky-400 shadow-sky-500/10',
        iconHoverBg: 'group-hover:bg-sky-500/25',
        group: 'sharing',
    },

    // ── APPEARANCE ──────────────────────────────────────────────
    {
        id: 'scenery',
        label: 'Aesthetics',
        description: 'Theme, colors & environment',
        icon: (c) => <StarIcon className={c} />,
        iconBg: 'bg-sky-500/15 text-sky-400 shadow-sky-500/10',
        iconHoverBg: 'group-hover:bg-sky-500/25',
        group: 'appearance',
    },

    // ── ADVANCED — collapsed by default ─────────────────────────
    {
        id: 'calypso',
        label: 'Calypso',
        description: 'Music & email integrations',
        icon: (c) => (
            <svg className={c} viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M19 11h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72z" />
            </svg>
        ),
        iconBg: 'bg-cyan-500/15 text-cyan-400 shadow-cyan-500/10',
        iconHoverBg: 'group-hover:bg-cyan-500/25',
        group: 'advanced',
    },
    {
        id: 'calypsoKnowledge',
        label: "Calypso's Knowledge",
        description: 'Teach Calypso about your boat',
        icon: (c) => (
            <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                />
            </svg>
        ),
        iconBg: 'bg-cyan-500/15 text-cyan-400 shadow-cyan-500/10',
        iconHoverBg: 'group-hover:bg-cyan-500/25',
        group: 'advanced',
    },
    {
        id: 'boatNetwork',
        label: 'Boat Network',
        description: 'Pi cache, Signal K & AvNav charts',
        icon: (c) => (
            <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
                />
            </svg>
        ),
        iconBg: 'bg-emerald-500/15 text-emerald-400 shadow-emerald-500/10',
        iconHoverBg: 'group-hover:bg-emerald-500/25',
        group: 'advanced',
    },
];

/** Small section header used on both desktop sidebar and mobile menu. */
const SettingsSectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500 px-2 pt-4 pb-1.5">{children}</p>
);

/**
 * "Frequently Used" tap-count tracking — added 2026-05-17.
 *
 * Why: search shipped earlier in the day fixed the "I know what I want
 * but not which section it lives in" problem. The remaining friction
 * is the user who taps the SAME 2-3 tabs every time (Vessel Profile,
 * Notifications, Aesthetics) and still has to either search or scan
 * the section list every visit. A "Frequently Used" row at the top
 * of the menu drops their journey to one tap.
 *
 * Storage: simple `Record<SettingsTab, number>` keyed by tap count
 * persisted to localStorage. No clock decay — settings access is
 * infrequent enough that lifetime count is a fine proxy for "do I use
 * this." A user who reconfigures their boat once never sees that tab
 * dominate the row because all the OTHER tabs are still 0.
 *
 * Floor: minimum 3 taps before a tab qualifies, so the row doesn't
 * pop up on day-one with whatever the user happened to tap first.
 * Capped at 3 items so the row stays compact.
 */
const TAB_USAGE_KEY = 'thalassa_settings_tab_usage';
const FREQ_USED_MIN_TAPS = 3;
const FREQ_USED_MAX_ITEMS = 3;

function loadTabUsage(): Record<string, number> {
    if (typeof window === 'undefined') return {};
    try {
        const raw = localStorage.getItem(TAB_USAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
    } catch {
        return {};
    }
}

function bumpTabUsage(id: SettingsTab): void {
    if (typeof window === 'undefined') return;
    try {
        const usage = loadTabUsage();
        usage[id] = (usage[id] || 0) + 1;
        localStorage.setItem(TAB_USAGE_KEY, JSON.stringify(usage));
    } catch {
        // Storage quota / private browsing — best-effort only.
    }
}

export const SettingsView: React.FC<SettingsViewProps> = React.memo(
    ({ settings, onSave, onLocationSelect, onBack }) => {
        const { resetSettings } = useThalassa();
        const [activeTab, setActiveTab] = useState<SettingsTab | null>(() => {
            // Deep-link from outside: callers (e.g. the "Set up your
            // vessel" CTA in VesselHub, the "Personalise →" link in
            // RoutePlanner's Active Vessel indicator) write the
            // target tab to localStorage right before setPage('settings').
            // Pick it up here on mount, then clear the key so a
            // subsequent normal entry shows the default tab. Same
            // shape as the existing `thalassa_settings_return_to`
            // hint used by the back-button logic.
            if (typeof window !== 'undefined') {
                const deepLinkKey = authScopedStorageKey('thalassa_settings_initial_tab');
                const deepLink = localStorage.getItem(deepLinkKey) as SettingsTab | null;
                if (deepLink) {
                    localStorage.removeItem(deepLinkKey);
                    return deepLink;
                }
            }
            // Desktop (md breakpoint): default to 'general' so content area isn't empty
            // Mobile: default to null to show the vertical menu screen
            if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) {
                return 'general';
            }
            return null;
        });
        const [_detectingLoc, setDetectingLoc] = useState(false);
        const [showFactoryReset, setShowFactoryReset] = useState(false);
        const isObserver = settings?.vessel?.type === 'observer';

        // Settings tab search — added 2026-05-17 (scorecard fix #11).
        // 10 tabs is a lot even after the section grouping; "where do I
        // change the anchor alarm radius" still needs hunting. Search
        // filters MENU_ITEMS by label + description so the user can type
        // "anchor" and see the matching tabs surface.
        // Empty query passes through (shows the full section list).
        const [tabQuery, setTabQuery] = useState('');
        const filteredMenuItems = React.useMemo(() => {
            const q = tabQuery.trim().toLowerCase();
            if (!q) return MENU_ITEMS;
            return MENU_ITEMS.filter(
                (m) => m.label.toLowerCase().includes(q) || m.description.toLowerCase().includes(q),
            );
        }, [tabQuery]);
        const searchIsActive = tabQuery.trim().length > 0;

        // Frequently-used tracking — see TAB_USAGE_KEY docstring.
        // State seeded from localStorage on mount; bumped on every tab
        // selection so the memo recomputes and the row updates live.
        const [tabUsage, setTabUsage] = useState<Record<string, number>>(() => loadTabUsage());
        const frequentlyUsedTabs = React.useMemo(() => {
            return Object.entries(tabUsage)
                .filter(([, count]) => count >= FREQ_USED_MIN_TAPS)
                .sort((a, b) => b[1] - a[1])
                .slice(0, FREQ_USED_MAX_ITEMS)
                .map(([id]) => MENU_ITEMS.find((m) => m.id === id))
                .filter((m): m is (typeof MENU_ITEMS)[number] => Boolean(m));
        }, [tabUsage]);
        const handleSelectTab = React.useCallback((id: SettingsTab) => {
            bumpTabUsage(id);
            setTabUsage(loadTabUsage());
            setActiveTab(id);
        }, []);

        const _updateUnit = (type: keyof typeof settings.units, value: string) => {
            onSave({ units: { ...settings.units, [type]: value } });
        };

        const handleDetectLocation = () => {
            setDetectingLoc(true);
            GpsService.getCurrentPosition({ staleLimitMs: 30_000 }).then(async (pos) => {
                if (pos) {
                    const { latitude, longitude } = pos;
                    let resolvedName = `WP ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
                    try {
                        const name = await reverseGeocode(latitude, longitude);
                        if (name) resolvedName = name;
                    } catch (e) {
                        log.warn(' fallback to WP coords:', e);
                    }
                    onSave({ defaultLocation: resolvedName });
                }
                setDetectingLoc(false);
            });
        };

        return (
            <div className="w-full max-w-6xl mx-auto h-full flex flex-col md:flex-row pb-24 relative">
                {/* Ambient Background Glows */}
                <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
                    <div className="absolute top-10 left-10 w-96 h-96 bg-sky-500/10 rounded-full blur-[100px]"></div>
                    <div className="absolute bottom-10 right-10 w-96 h-96 bg-sky-500/10 rounded-full blur-[100px]"></div>
                </div>

                {/* --- DESKTOP SIDEBAR (unchanged) --- */}
                <div className="hidden md:flex w-72 border-r border-white/5 p-6 flex-col gap-3 shrink-0 relative z-10 bg-gradient-to-b from-transparent via-white/[0.02] to-transparent">
                    <div className="mb-6 px-2">
                        <h2 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-sky-300 flex items-center gap-3 drop-shadow-sm">
                            <GearIcon className="w-6 h-6 text-sky-400" />
                            SETTINGS
                        </h2>
                        <p className="text-[11px] text-sky-300/60 font-mono tracking-widest uppercase mt-1 ml-9">
                            Control Center
                        </p>
                    </div>

                    {/* Tab search — solves "I know what I want to change
                        but not which section it lives in" for the 10-tab
                        Settings surface. Sits between the header and the
                        section list; when active, sections collapse and
                        every matching tab renders flat. */}
                    <div className="relative mb-3 px-2">
                        <svg
                            className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M21 21l-4.34-4.34m0 0A8 8 0 103.32 12.32a8 8 0 0013.34 4.34z"
                            />
                        </svg>
                        <input
                            type="search"
                            value={tabQuery}
                            onChange={(e) => setTabQuery(e.target.value)}
                            placeholder="Search settings…"
                            className="w-full h-9 pl-9 pr-8 rounded-lg bg-white/[0.04] border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500/40 focus:bg-white/[0.06] transition-colors"
                            aria-label="Search settings tabs"
                        />
                        {tabQuery && (
                            <button
                                type="button"
                                onClick={() => setTabQuery('')}
                                aria-label="Clear search"
                                className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-300"
                            >
                                <svg
                                    className="w-3 h-3"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* Frequently Used — top-of-menu shortcut row. Surfaces
                        the user's 3 most-tapped tabs once any tab has 3+
                        taps. Hidden during search (search supersedes it).
                        See TAB_USAGE_KEY docstring for tracking details. */}
                    {!searchIsActive && frequentlyUsedTabs.length > 0 && (
                        <div className="mb-2">
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-sky-400/80 px-2 pt-2 pb-1.5 flex items-center gap-1.5">
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                    <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" />
                                </svg>
                                Frequently Used
                            </p>
                            <div className="space-y-0.5">
                                {frequentlyUsedTabs.map((item) => (
                                    <NavButton
                                        key={`freq-${item.id}`}
                                        active={activeTab === item.id}
                                        onClick={() => handleSelectTab(item.id)}
                                        icon={item.icon('w-5 h-5')}
                                        label={
                                            item.id === 'vessel' && isObserver
                                                ? 'VESSEL (CREW)'
                                                : item.label.toUpperCase()
                                        }
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Desktop sidebar — driven by MENU_ITEMS + SETTINGS_GROUPS.
                        Before 2026-05-17 this was a hardcoded list of 7
                        NavButtons that omitted three of the registered
                        tabs (Voyage Log, etc), so
                        desktop users couldn't reach them. Now the same
                        source-of-truth feeds both desktop and mobile,
                        with section headers + an Advanced disclosure
                        that collapses by default.

                        When `searchIsActive`, sections collapse and
                        filtered items render flat — the section labels
                        would be visual noise when the user has already
                        narrowed by text. */}
                    <div className="space-y-0.5">
                        {searchIsActive ? (
                            filteredMenuItems.length === 0 ? (
                                <p className="text-xs text-slate-400 px-2 py-3 leading-relaxed">
                                    No settings match <strong className="text-white/80">"{tabQuery}"</strong>.
                                </p>
                            ) : (
                                filteredMenuItems.map((item) => (
                                    <NavButton
                                        key={item.id}
                                        active={activeTab === item.id}
                                        onClick={() => handleSelectTab(item.id)}
                                        icon={item.icon('w-5 h-5')}
                                        label={
                                            item.id === 'vessel' && isObserver
                                                ? 'VESSEL (CREW)'
                                                : item.label.toUpperCase()
                                        }
                                    />
                                ))
                            )
                        ) : (
                            SETTINGS_GROUPS.map((group) => {
                                const items = MENU_ITEMS.filter((m) => m.group === group.id);
                                if (items.length === 0) return null;
                                const itemsJsx = items.map((item) => (
                                    <NavButton
                                        key={item.id}
                                        active={activeTab === item.id}
                                        onClick={() => handleSelectTab(item.id)}
                                        icon={item.icon('w-5 h-5')}
                                        label={
                                            item.id === 'vessel' && isObserver
                                                ? 'VESSEL (CREW)'
                                                : item.label.toUpperCase()
                                        }
                                    />
                                ));
                                if (group.collapsibleByDefault) {
                                    return (
                                        <details key={group.id} className="group/details">
                                            <summary className="list-none cursor-pointer flex items-center gap-1 px-2 pt-4 pb-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-slate-500 hover:text-slate-300 transition-colors">
                                                <svg
                                                    className="w-3 h-3 transition-transform group-open/details:rotate-90"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth={2.5}
                                                    aria-hidden="true"
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M9 5l7 7-7 7"
                                                    />
                                                </svg>
                                                <span>{group.label}</span>
                                            </summary>
                                            <div className="space-y-0.5">{itemsJsx}</div>
                                        </details>
                                    );
                                }
                                return (
                                    <div key={group.id}>
                                        <SettingsSectionLabel>{group.label}</SettingsSectionLabel>
                                        <div className="space-y-0.5">{itemsJsx}</div>
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="mt-auto pt-6 border-t border-white/5">
                        <div className="bg-gradient-to-br from-sky-500/20 to-purple-500/20 rounded-xl p-4 border border-sky-500/30">
                            <div className="flex items-center gap-2 mb-2">
                                <StarIcon className="w-4 h-4 text-sky-300" filled />
                                <span className="text-xs font-bold text-sky-200 uppercase tracking-wider">
                                    Thalassa Pro
                                </span>
                            </div>
                            <p className="text-[12px] text-sky-200/70 mb-3">
                                Your subscription is active. Access to all premium features.
                            </p>
                        </div>
                    </div>
                </div>

                {/* --- MOBILE: Vertical Menu Screen (shown when no tab selected) --- */}
                {activeTab === null && (
                    <div className="md:hidden flex-1 flex flex-col">
                        <div className="px-6 pt-8 pb-4">
                            <div className="flex items-center gap-3">
                                {onBack && (
                                    <button
                                        onClick={onBack}
                                        className="p-2 rounded-xl bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                                        aria-label="Go back"
                                    >
                                        <svg
                                            className="w-5 h-5"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                        >
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                                        </svg>
                                    </button>
                                )}
                                <div>
                                    <h2 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-sky-300 flex items-center gap-3">
                                        <GearIcon className="w-6 h-6 text-sky-400" />
                                        SETTINGS
                                    </h2>
                                    <p className="text-[11px] text-sky-300/60 font-mono tracking-widest uppercase mt-1 ml-9">
                                        Control Center
                                    </p>
                                </div>
                            </div>
                        </div>
                        {/* Mobile menu — same grouping as the desktop
                            sidebar (single source of truth in MENU_ITEMS
                            + SETTINGS_GROUPS). Advanced collapses by
                            default; the chevron rotates open/close.
                            When search is active, sections collapse and
                            matching tabs render flat (same pattern as the
                            desktop sidebar). */}
                        <div className="flex-1 px-4 pb-32 space-y-3">
                            {/* Search input — same component shape as desktop,
                                slightly taller (h-11 for thumb-friendly tap). */}
                            <div className="relative pt-1">
                                <svg
                                    className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M21 21l-4.34-4.34m0 0A8 8 0 103.32 12.32a8 8 0 0013.34 4.34z"
                                    />
                                </svg>
                                <input
                                    type="search"
                                    value={tabQuery}
                                    onChange={(e) => setTabQuery(e.target.value)}
                                    placeholder="Search settings…"
                                    className="w-full h-11 pl-9 pr-9 rounded-xl bg-white/[0.04] border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-500/40 focus:bg-white/[0.06] transition-colors"
                                    aria-label="Search settings tabs"
                                />
                                {tabQuery && (
                                    <button
                                        type="button"
                                        onClick={() => setTabQuery('')}
                                        aria-label="Clear search"
                                        className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 min-w-[44px] min-h-[44px] rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-300"
                                    >
                                        <svg
                                            className="w-3.5 h-3.5"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M6 18L18 6M6 6l12 12"
                                            />
                                        </svg>
                                    </button>
                                )}
                            </div>

                            {/* Frequently Used — mobile variant. Same data + rule
                                as desktop sidebar; renders the cards-style buttons
                                used elsewhere in the mobile menu. */}
                            {!searchIsActive && frequentlyUsedTabs.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-sky-400/80 px-2 pt-2 pb-1.5 flex items-center gap-1.5">
                                        <svg
                                            className="w-3 h-3"
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            aria-hidden="true"
                                        >
                                            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" />
                                        </svg>
                                        Frequently Used
                                    </p>
                                    {frequentlyUsedTabs.map((item) => (
                                        <button
                                            aria-label={`Open ${item.label} settings`}
                                            key={`freq-${item.id}`}
                                            onClick={() => handleSelectTab(item.id)}
                                            className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-sky-500/[0.05] border border-sky-500/15 hover:bg-sky-500/[0.08] hover:border-sky-500/25 transition-all duration-300 active:scale-[0.98] text-left"
                                        >
                                            <div
                                                className={`p-3 rounded-xl ${item.iconBg} ${item.iconHoverBg} group-hover:scale-110 transition-all duration-300 shadow-lg`}
                                            >
                                                {item.icon('w-6 h-6')}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-white font-bold text-sm tracking-wide">
                                                    {item.label}
                                                </p>
                                                <p className="text-gray-300 text-xs mt-0.5">
                                                    {item.id === 'vessel' && isObserver
                                                        ? 'Crew Member — tap to configure vessel'
                                                        : item.description}
                                                </p>
                                            </div>
                                            <ArrowRightIcon className="w-4 h-4 text-gray-400 group-hover:text-sky-400 group-hover:translate-x-1 transition-all" />
                                        </button>
                                    ))}
                                </div>
                            )}

                            {searchIsActive && filteredMenuItems.length === 0 && (
                                <p className="text-sm text-slate-400 px-2 py-4 leading-relaxed">
                                    No settings match <strong className="text-white/80">"{tabQuery}"</strong>.
                                </p>
                            )}
                            {searchIsActive &&
                                filteredMenuItems.map((item) => (
                                    <button
                                        aria-label={`Open ${item.label} settings`}
                                        key={item.id}
                                        onClick={() => handleSelectTab(item.id)}
                                        className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.07] hover:border-white/10 transition-all duration-300 active:scale-[0.98] text-left"
                                    >
                                        <div
                                            className={`p-3 rounded-xl ${item.iconBg} ${item.iconHoverBg} group-hover:scale-110 transition-all duration-300 shadow-lg`}
                                        >
                                            {item.icon('w-6 h-6')}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-white font-bold text-sm tracking-wide">{item.label}</p>
                                            <p className="text-gray-300 text-xs mt-0.5">
                                                {item.id === 'vessel' && isObserver
                                                    ? 'Crew Member — tap to configure vessel'
                                                    : item.description}
                                            </p>
                                        </div>
                                        <ArrowRightIcon className="w-4 h-4 text-gray-400 group-hover:text-sky-400 group-hover:translate-x-1 transition-all" />
                                    </button>
                                ))}
                            {!searchIsActive &&
                                SETTINGS_GROUPS.map((group) => {
                                    const items = MENU_ITEMS.filter((m) => m.group === group.id);
                                    if (items.length === 0) return null;
                                    const itemButtons = items.map((item) => (
                                        <button
                                            aria-label={`Open ${item.label} settings`}
                                            key={item.id}
                                            onClick={() => handleSelectTab(item.id)}
                                            className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.07] hover:border-white/10 transition-all duration-300 active:scale-[0.98] text-left"
                                        >
                                            <div
                                                className={`p-3 rounded-xl ${item.iconBg} ${item.iconHoverBg} group-hover:scale-110 transition-all duration-300 shadow-lg`}
                                            >
                                                {item.icon('w-6 h-6')}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-white font-bold text-sm tracking-wide">
                                                    {item.label}
                                                </p>
                                                <p className="text-gray-300 text-xs mt-0.5">
                                                    {item.id === 'vessel' && isObserver
                                                        ? 'Crew Member — tap to configure vessel'
                                                        : item.description}
                                                </p>
                                            </div>
                                            <ArrowRightIcon className="w-4 h-4 text-gray-400 group-hover:text-sky-400 group-hover:translate-x-1 transition-all" />
                                        </button>
                                    ));
                                    if (group.collapsibleByDefault) {
                                        return (
                                            <details key={group.id} className="group/details">
                                                <summary className="list-none cursor-pointer flex items-center gap-1.5 px-2 py-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-500 hover:text-slate-300 transition-colors">
                                                    <svg
                                                        className="w-3 h-3 transition-transform group-open/details:rotate-90"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth={2.5}
                                                        aria-hidden="true"
                                                    >
                                                        <path
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                            d="M9 5l7 7-7 7"
                                                        />
                                                    </svg>
                                                    <span>{group.label}</span>
                                                </summary>
                                                <div className="space-y-2 mt-1">{itemButtons}</div>
                                            </details>
                                        );
                                    }
                                    return (
                                        <div key={group.id} className="space-y-2">
                                            <SettingsSectionLabel>{group.label}</SettingsSectionLabel>
                                            {itemButtons}
                                        </div>
                                    );
                                })}
                        </div>
                    </div>
                )}

                <div
                    className={`flex-1 flex flex-col h-full bg-transparent overflow-hidden ${activeTab === null ? 'hidden md:flex' : ''}`}
                >
                    {/* Mobile: Section header with X close button */}
                    {activeTab !== null && (
                        <div className="md:hidden flex items-center gap-3 px-5 pt-6 pb-3 sticky top-0 z-20 bg-slate-950/90 border-b border-white/5">
                            <button
                                onClick={() => setActiveTab(null)}
                                className="p-2 rounded-xl bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                                aria-label="Back to settings menu"
                            >
                                <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                                </svg>
                            </button>
                            <h3 className="text-lg font-black text-white uppercase tracking-wider">
                                {MENU_ITEMS.find((m) => m.id === activeTab)?.label || 'Settings'}
                            </h3>
                        </div>
                    )}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-10 pb-48">
                        {activeTab === 'locations' && (
                            <LocationsTab settings={settings} onSave={onSave} onLocationSelect={onLocationSelect} />
                        )}

                        {activeTab === 'account' && <AccountTab settings={settings} onSave={onSave} />}

                        {activeTab === 'general' && (
                            <GeneralTab
                                settings={settings}
                                onSave={onSave}
                                onLocationSelect={onLocationSelect}
                                onDetectLocation={handleDetectLocation}
                                onShowFactoryReset={() => setShowFactoryReset(true)}
                            />
                        )}

                        {activeTab === 'vessel' && <VesselTab settings={settings} onSave={onSave} />}

                        {activeTab === 'alerts' && <AlertsTab settings={settings} onSave={onSave} />}

                        {activeTab === 'scenery' && <AestheticsTab settings={settings} onSave={onSave} />}

                        {activeTab === 'calypso' && <CalypsoIntegrationsTab settings={settings} onSave={onSave} />}

                        {activeTab === 'calypsoKnowledge' && (
                            <CalypsoKnowledgeTab settings={settings} onSave={onSave} />
                        )}

                        {activeTab === 'boatNetwork' && <PiCacheTab settings={settings} onSave={onSave} />}

                        {activeTab === 'voyageLog' && <VoyageLogTab settings={settings} onSave={onSave} />}
                    </div>
                </div>

                {/* Factory Reset confirmation dialog */}
                <ConfirmDialog
                    isOpen={showFactoryReset}
                    title="Factory Reset"
                    message="Restore all settings to default? This cannot be undone."
                    confirmLabel="Reset Everything"
                    cancelLabel="Cancel"
                    destructive
                    onConfirm={() => {
                        setShowFactoryReset(false);
                        resetSettings();
                    }}
                    onCancel={() => setShowFactoryReset(false)}
                />
            </div>
        );
    },
);
