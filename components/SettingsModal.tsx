import React, { useState, useEffect } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SettingsModal');
import { UserSettings, LengthUnit } from '../types';
import {
    CompassIcon,
    BellIcon,
    ArrowRightIcon,
    BoatIcon,
    StarIcon,
    GearIcon,
    MapIcon,
    ServerIcon,
    TrashIcon,
    MapPinIcon,
    LockIcon,
    CloudIcon,
} from './Icons';
import { reverseGeocode } from '../services/weatherService';
import { checkStormglassStatus, isStormglassKeyPresent, getOpenMeteoKey } from '../services/weather/keys';
import { AuthModal } from './AuthModal';
import { useThalassa } from '../context/ThalassaContext';
import { isSupabaseConfigured } from '../services/supabase';
import { isGeminiConfigured } from '../services/geminiService';
import { GpsService } from '../services/GpsService';

import { Section, Row, Toggle } from './settings/SettingsPrimitives';
import { AlertsTab } from './settings/AlertsTab';
import { AestheticsTab } from './settings/AestheticsTab';
import { VesselTab } from './settings/VesselTab';
import { ConfirmDialog } from './ui/ConfirmDialog';

const isMapboxConfigured = () => {
    const envKey = process.env?.MAPBOX_ACCESS_TOKEN || (import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN);
    if (envKey && envKey.length > 5) return true;
    if (typeof window !== 'undefined') {
        const local = localStorage.getItem('thalassa_mapbox_key');
        if (local && local.length > 5) return true;
    }
    return false;
};

const isOpenMeteoConfigured = () => {
    const key = getOpenMeteoKey();
    return key && key.length > 5;
};

const getKeyPreview = (keyName: 'GEMINI' | 'STORMGLASS' | 'MAPBOX') => {
    let val = '';
    if (keyName === 'GEMINI') {
        val =
            process.env?.API_KEY ||
            process.env?.GEMINI_API_KEY ||
            (import.meta.env && import.meta.env.VITE_GEMINI_API_KEY);
    } else if (keyName === 'STORMGLASS') {
        val = process.env?.STORMGLASS_API_KEY || (import.meta.env && import.meta.env.VITE_STORMGLASS_API_KEY);
    } else if (keyName === 'MAPBOX') {
        val = process.env?.MAPBOX_ACCESS_TOKEN || (import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN);
    }
    if (!val || val.length < 5 || val.includes('YOUR_')) return 'MISSING';
    return `Ends in ...${val.slice(-4)}`;
};

interface SettingsViewProps {
    settings: UserSettings;
    onSave: (settings: Partial<UserSettings>) => void;
    onLocationSelect: (location: string) => void;
}

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
            onClick={onClick}
            className={`group relative flex items-center gap-3 w-full p-3 rounded-xl transition-all duration-300 text-left overflow-hidden ${active ? 'bg-gradient-to-r from-sky-500/20 to-sky-600/20 text-white shadow-[0_0_20px_rgba(14,165,233,0.15)] border border-sky-500/30' : 'text-gray-400 hover:bg-white/5 hover:text-white border border-transparent'}`}
        >
            {active && (
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-sky-400 shadow-[0_0_10px_2px_rgba(56,189,248,0.5)]"></div>
            )}
            <div
                className={`p-2 rounded-lg transition-all duration-300 ${active ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/40 scale-110' : 'bg-white/5 text-gray-400 group-hover:bg-white/10 group-hover:text-white group-hover:scale-105'}`}
            >
                {icon}
            </div>
            <span
                className={`font-bold text-sm tracking-wide transition-all ${active ? 'text-white translate-x-1' : ''}`}
            >
                {label}
            </span>
            {active && <ArrowRightIcon className="w-4 h-4 ml-auto text-sky-400 animate-pulse" />}
        </button>
    ),
);

const MobileNavTab = React.memo(
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
                    className={`text-[11px] uppercase tracking-wider font-bold block transition-colors ${isEstimated ? 'text-red-400' : 'text-gray-500 group-hover:text-sky-300'}`}
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

type SettingsTab = 'general' | 'account' | 'vessel' | 'alerts' | 'scenery' | 'locations' | 'layout';

const MENU_ITEMS: {
    id: SettingsTab;
    label: string;
    description: string;
    icon: (cls: string) => React.ReactNode;
    iconBg: string;
    iconHoverBg: string;
}[] = [
    {
        id: 'general',
        label: 'Preferences',
        description: 'Units, location & AI personality',
        icon: (c) => <GearIcon className={c} />,
        iconBg: 'bg-sky-500/15 text-sky-400 shadow-sky-500/10',
        iconHoverBg: 'group-hover:bg-sky-500/25',
    },
    {
        id: 'locations',
        label: 'Locations',
        description: 'Saved ports & anchorages',
        icon: (c) => <MapPinIcon className={c} />,
        iconBg: 'bg-emerald-500/15 text-emerald-400 shadow-emerald-500/10',
        iconHoverBg: 'group-hover:bg-emerald-500/25',
    },
    {
        id: 'account',
        label: 'System & Cloud',
        description: 'Cloud sync, API keys & account',
        icon: (c) => <ServerIcon className={c} />,
        iconBg: 'bg-purple-500/15 text-purple-400 shadow-purple-500/10',
        iconHoverBg: 'group-hover:bg-purple-500/25',
    },
    {
        id: 'vessel',
        label: 'Vessel Profile',
        description: 'Boat specs, rig & safety gear',
        icon: (c) => <BoatIcon className={c} />,
        iconBg: 'bg-amber-500/15 text-amber-400 shadow-amber-500/10',
        iconHoverBg: 'group-hover:bg-amber-500/25',
    },

    {
        id: 'alerts',
        label: 'Notifications',
        description: 'Anchor alarm, weather alerts',
        icon: (c) => <BellIcon className={c} />,
        iconBg: 'bg-red-500/15 text-red-400 shadow-red-500/10',
        iconHoverBg: 'group-hover:bg-red-500/25',
    },
    {
        id: 'scenery',
        label: 'Aesthetics',
        description: 'Theme, colors & environment',
        icon: (c) => <StarIcon className={c} />,
        iconBg: 'bg-sky-500/15 text-sky-400 shadow-sky-500/10',
        iconHoverBg: 'group-hover:bg-sky-500/25',
    },
];

export const SettingsView: React.FC<SettingsViewProps> = ({ settings, onSave, onLocationSelect }) => {
    const { user, logout, resetSettings } = useThalassa();
    const [activeTab, setActiveTab] = useState<SettingsTab | null>(() => {
        // Desktop (md breakpoint): default to 'general' so content area isn't empty
        // Mobile: default to null to show the vertical menu screen
        if (typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches) {
            return 'general';
        }
        return null;
    });
    const [detectingLoc, setDetectingLoc] = useState(false);
    const [authOpen, setAuthOpen] = useState(false);
    const [sgStatus, setSgStatus] = useState<{ status: string; message: string } | null>(null);
    const [showFactoryReset, setShowFactoryReset] = useState(false);

    // Environment theme state

    useEffect(() => {
        if (activeTab === 'account') {
            setSgStatus({ status: 'LOADING', message: 'Checking...' });
            checkStormglassStatus().then((res) => setSgStatus({ status: res.status, message: res.message }));
        }
    }, [activeTab]);

    // Safe update helper - only sends 'units' delta
    const updateUnit = (type: keyof typeof settings.units, value: string) => {
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

    // UPDATED STATUS ROW
    const StatusRow = ({
        label,
        isConnected,
        status,
        details,
        loading,
        onTest,
    }: {
        label: string;
        isConnected?: boolean;
        status?: string;
        details?: string;
        loading?: boolean;
        onTest?: () => void;
    }) => {
        const isMissing = status === 'MISSING_KEY' || (!isConnected && !status);
        const isActive = status === 'OK' || isConnected;
        let indicatorColor = 'bg-red-500 shadow-red-500/20';
        let textColor = 'text-red-400';
        let displayText = details || (isActive ? 'ACTIVE' : 'MISSING');

        if (loading) {
            indicatorColor = 'bg-yellow-500 animate-pulse';
            textColor = 'text-yellow-400';
            displayText = 'CHECKING...';
        } else if (isActive) {
            indicatorColor = 'bg-emerald-500 shadow-emerald-500/50';
            textColor = 'text-emerald-400';
        } else if (isMissing) {
            indicatorColor = 'bg-sky-500 shadow-sky-500/50';
            textColor = 'text-sky-300';
            displayText = 'FREE MODE';
        }

        return (
            <div className="flex items-center justify-between p-3 bg-black/20 rounded-lg border border-white/5">
                <div className="flex items-center gap-3">
                    <div className={`w-2.5 h-2.5 rounded-full shadow-lg ${indicatorColor}`}></div>
                    <span className="text-xs font-bold text-white uppercase tracking-wider">{label}</span>
                </div>
                <div className="flex items-center gap-3">
                    <span className={`text-[11px] font-mono font-medium ${textColor}`}>{displayText}</span>
                    {onTest && (
                        <button
                            onClick={onTest}
                            className="px-2 py-1 rounded bg-white/5 border border-white/10 text-[11px] font-bold text-white uppercase"
                        >
                            Test
                        </button>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="w-full max-w-6xl mx-auto h-full flex flex-col md:flex-row pb-24 relative">
            {/* Ambient Background Glows */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
                <div className="absolute top-10 left-10 w-96 h-96 bg-sky-500/10 rounded-full blur-[100px]"></div>
                <div className="absolute bottom-10 right-10 w-96 h-96 bg-sky-500/10 rounded-full blur-[100px]"></div>
            </div>

            <AuthModal isOpen={authOpen} onClose={() => setAuthOpen(false)} />

            {/* --- DESKTOP SIDEBAR (unchanged) --- */}
            <div className="hidden md:flex w-72 border-r border-white/5 p-6 flex-col gap-3 shrink-0 relative z-10 bg-gradient-to-b from-transparent via-white/[0.02] to-transparent">
                <div className="mb-8 px-2">
                    <h2 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-sky-300 flex items-center gap-3 drop-shadow-sm">
                        <GearIcon className="w-6 h-6 text-sky-400" />
                        SETTINGS
                    </h2>
                    <p className="text-[11px] text-sky-300/60 font-mono tracking-widest uppercase mt-1 ml-9">
                        Control Center
                    </p>
                </div>

                <div className="space-y-1">
                    <NavButton
                        active={activeTab === 'general'}
                        onClick={() => setActiveTab('general')}
                        icon={<GearIcon className="w-5 h-5" />}
                        label="PREFERENCES"
                    />
                    <NavButton
                        active={activeTab === 'locations'}
                        onClick={() => setActiveTab('locations')}
                        icon={<MapPinIcon className="w-5 h-5" />}
                        label="LOCATIONS"
                    />
                    <NavButton
                        active={activeTab === 'account'}
                        onClick={() => setActiveTab('account')}
                        icon={<ServerIcon className="w-5 h-5" />}
                        label="SYSTEM & CLOUD"
                    />
                    <NavButton
                        active={activeTab === 'vessel'}
                        onClick={() => setActiveTab('vessel')}
                        icon={<BoatIcon className="w-5 h-5" />}
                        label="VESSEL PROFILE"
                    />

                    <NavButton
                        active={activeTab === 'alerts'}
                        onClick={() => setActiveTab('alerts')}
                        icon={<BellIcon className="w-5 h-5" />}
                        label="NOTIFICATIONS"
                    />
                    <NavButton
                        active={activeTab === 'scenery'}
                        onClick={() => setActiveTab('scenery')}
                        icon={<StarIcon className="w-5 h-5" />}
                        label="AESTHETICS"
                    />
                </div>

                <div className="mt-auto pt-6 border-t border-white/5">
                    <div className="bg-gradient-to-br from-sky-500/20 to-purple-500/20 rounded-xl p-4 border border-sky-500/30">
                        <div className="flex items-center gap-2 mb-2">
                            <StarIcon className="w-4 h-4 text-sky-300" filled />
                            <span className="text-xs font-bold text-sky-200 uppercase tracking-wider">
                                Thalassa Pro
                            </span>
                        </div>
                        <p className="text-[11px] text-sky-200/70 mb-3">
                            Your subscription is active. Access to all premium features.
                        </p>
                    </div>
                </div>
            </div>

            {/* --- MOBILE: Vertical Menu Screen (shown when no tab selected) --- */}
            {activeTab === null && (
                <div className="md:hidden flex-1 flex flex-col overflow-y-auto">
                    <div className="px-6 pt-8 pb-4">
                        <h2 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-sky-300 flex items-center gap-3">
                            <GearIcon className="w-6 h-6 text-sky-400" />
                            SETTINGS
                        </h2>
                        <p className="text-[11px] text-sky-300/60 font-mono tracking-widest uppercase mt-1 ml-9">
                            Control Center
                        </p>
                    </div>
                    <div className="flex-1 px-4 pb-32 space-y-2">
                        {MENU_ITEMS.map((item) => (
                            <button
                                key={item.id}
                                onClick={() => setActiveTab(item.id)}
                                className="group w-full flex items-center gap-4 p-4 rounded-2xl bg-white/[0.03] border border-white/5 hover:bg-white/[0.07] hover:border-white/10 transition-all duration-300 active:scale-[0.98] text-left"
                            >
                                <div
                                    className={`p-3 rounded-xl ${item.iconBg} ${item.iconHoverBg} group-hover:scale-110 transition-all duration-300 shadow-lg`}
                                >
                                    {item.icon('w-6 h-6')}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-white font-bold text-sm tracking-wide">{item.label}</p>
                                    <p className="text-gray-500 text-xs mt-0.5">{item.description}</p>
                                </div>
                                <ArrowRightIcon className="w-4 h-4 text-gray-500 group-hover:text-sky-400 group-hover:translate-x-1 transition-all" />
                            </button>
                        ))}
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
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-10 pb-32">
                    {activeTab === 'locations' && (
                        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                            <Section title="Saved Ports & Anchorages">
                                <div className="flex flex-col gap-2 p-2">
                                    {(settings.savedLocations || []).map((loc, i) => (
                                        <div
                                            key={i}
                                            className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-xl group hover:bg-white/10 transition-colors"
                                        >
                                            <div
                                                className="flex items-center gap-4 flex-1 cursor-pointer"
                                                onClick={() => onLocationSelect(loc)}
                                            >
                                                <div className="p-2 rounded-full bg-sky-500/20 text-sky-400">
                                                    <MapPinIcon className="w-5 h-5" />
                                                </div>
                                                <span className="font-bold text-white text-sm">{loc}</span>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onSave({
                                                        savedLocations: settings.savedLocations.filter(
                                                            (l) => l !== loc,
                                                        ),
                                                    });
                                                }}
                                                className="p-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                            >
                                                <TrashIcon className="w-5 h-5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </Section>
                        </div>
                    )}

                    {activeTab === 'account' && (
                        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                            {/* Account Connection Hero */}
                            <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-white/10 rounded-2xl p-6 mb-8 shadow-2xl relative overflow-hidden">
                                <div className="absolute top-0 right-0 p-32 bg-sky-500/10 rounded-full blur-3xl pointer-events-none -translate-y-1/2 translate-x-1/2"></div>
                                <div className="flex flex-col items-center gap-4 relative z-10 text-center">
                                    <div
                                        className={`w-16 h-16 rounded-2xl flex items-center justify-center shadow-xl ${user ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 shadow-emerald-500/30' : 'bg-gradient-to-br from-slate-600 to-slate-700'}`}
                                    >
                                        <CloudIcon className={`w-8 h-8 ${user ? 'text-white' : 'text-gray-400'}`} />
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white">
                                            {user ? 'Connected to Cloud' : 'Cloud Connection'}
                                        </h3>
                                        <p className="text-sm text-gray-400 max-w-md mt-1">
                                            {user
                                                ? 'Your data is synced securely to the cloud.'
                                                : 'Sign in to sync settings, voyage data, and share community tracks.'}
                                        </p>
                                    </div>
                                    {!user ? (
                                        <button
                                            onClick={() => setAuthOpen(true)}
                                            className="bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white font-bold py-3 px-8 rounded-xl text-xs uppercase tracking-wider transition-all shadow-lg shadow-sky-500/30 active:scale-95"
                                        >
                                            Sign In with Email
                                        </button>
                                    ) : (
                                        <div className="flex flex-col gap-3 items-center w-full">
                                            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-xl">
                                                <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50 animate-pulse"></div>
                                                <span className="text-sm text-emerald-300 font-mono font-bold">
                                                    {user.email || user.phone}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Sync Status */}
                            {user && (
                                <Section title="Sync Status">
                                    <Row>
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-emerald-500/20 text-emerald-300 rounded-lg">
                                                <CloudIcon className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <p className="text-white font-bold text-sm">Cloud Sync</p>
                                                <p className="text-[11px] text-emerald-400 uppercase tracking-wide font-bold">
                                                    Connected
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50"></div>
                                            <span className="text-xs text-emerald-400 font-bold">ACTIVE</span>
                                        </div>
                                    </Row>
                                    <Row>
                                        <div className="flex-1">
                                            <label className="text-sm text-white font-medium block">Supabase</label>
                                            <p className="text-xs text-gray-500">
                                                {isSupabaseConfigured()
                                                    ? 'Backend configured and ready'
                                                    : 'Backend not configured'}
                                            </p>
                                        </div>
                                        <div
                                            className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider ${isSupabaseConfigured() ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}
                                        >
                                            {isSupabaseConfigured() ? 'Ready' : 'Missing'}
                                        </div>
                                    </Row>
                                </Section>
                            )}

                            {/* Satellite Mode */}
                            <Section title="Network Mode">
                                <div
                                    className={`mx-3 mt-2 mb-3 rounded-xl border p-4 transition-all duration-500 ${settings.satelliteMode ? 'bg-gradient-to-br from-amber-500/15 to-orange-500/10 border-amber-500/30 shadow-[0_0_20px_rgba(245,158,11,0.1)]' : 'bg-white/[0.03] border-white/5'}`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div
                                                className={`p-2.5 rounded-xl transition-all duration-500 ${settings.satelliteMode ? 'bg-amber-500/20 text-amber-400 shadow-lg shadow-amber-500/20 scale-110' : 'bg-white/5 text-gray-400'}`}
                                            >
                                                <svg
                                                    className="w-5 h-5"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={1.5}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M8.288 15.038a5.25 5.25 0 017.424-7.424m-5.303 5.303a2.25 2.25 0 013.182-3.182M12 21a9 9 0 100-18 9 9 0 000 18z"
                                                    />
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M3.75 7.5l16.5 9"
                                                    />
                                                </svg>
                                            </div>
                                            <div>
                                                <p className="text-white font-bold text-sm">Satellite Mode</p>
                                                <p
                                                    className={`text-xs mt-0.5 transition-colors ${settings.satelliteMode ? 'text-amber-300/70' : 'text-gray-500'}`}
                                                >
                                                    {settings.satelliteMode
                                                        ? '~200 KB/day • Weather only'
                                                        : 'For Iridium GO! & metered connections'}
                                                </p>
                                            </div>
                                        </div>
                                        <Toggle
                                            checked={!!settings.satelliteMode}
                                            onChange={(v) => onSave({ satelliteMode: v })}
                                        />
                                    </div>
                                    {settings.satelliteMode && (
                                        <div className="mt-3 pt-3 border-t border-amber-500/20 space-y-1.5 animate-in fade-in slide-in-from-top-2 duration-300">
                                            <div className="flex items-center gap-2 text-[11px]">
                                                <div className="w-1.5 h-1.5 rounded-full bg-amber-400"></div>
                                                <span className="text-amber-200/70">
                                                    Weather updates every 3 hours (StormGlass only)
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px]">
                                                <div className="w-1.5 h-1.5 rounded-full bg-amber-400"></div>
                                                <span className="text-amber-200/70">
                                                    Log entries stored on-device until back on land
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px]">
                                                <div className="w-1.5 h-1.5 rounded-full bg-amber-400"></div>
                                                <span className="text-amber-200/70">
                                                    Cloud sync paused to conserve bandwidth
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </Section>

                            {/* Data Sync Options */}
                            {user && (
                                <Section title="Data Sync">
                                    <Row>
                                        <div className="flex items-center gap-3 flex-1">
                                            <div className="p-2 bg-sky-500/20 text-sky-300 rounded-lg">
                                                <GearIcon className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <p className="text-white font-bold text-sm">Sync Settings</p>
                                                <p className="text-xs text-gray-500">
                                                    Units, vessel profile, preferences
                                                </p>
                                            </div>
                                        </div>
                                        <Toggle
                                            checked={settings.cloudSyncSettings !== false}
                                            onChange={(v) => onSave({ cloudSyncSettings: v })}
                                        />
                                    </Row>
                                    <Row>
                                        <div className="flex items-center gap-3 flex-1">
                                            <div className="p-2 bg-amber-500/20 text-amber-300 rounded-lg">
                                                <MapIcon className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <p className="text-white font-bold text-sm">Sync Voyages</p>
                                                <p className="text-xs text-gray-500">Track logs, waypoints, GPX data</p>
                                            </div>
                                        </div>
                                        <Toggle
                                            checked={settings.cloudSyncVoyages !== false}
                                            onChange={(v) => onSave({ cloudSyncVoyages: v })}
                                        />
                                    </Row>
                                    <Row>
                                        <div className="flex items-center gap-3 flex-1">
                                            <div className="p-2 bg-purple-500/20 text-purple-300 rounded-lg">
                                                <CompassIcon rotation={0} className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <p className="text-white font-bold text-sm">Community Sharing</p>
                                                <p className="text-xs text-gray-500">
                                                    Share and discover voyage tracks
                                                </p>
                                            </div>
                                        </div>
                                        <Toggle
                                            checked={settings.cloudSyncCommunity !== false}
                                            onChange={(v) => onSave({ cloudSyncCommunity: v })}
                                        />
                                    </Row>
                                </Section>
                            )}

                            <Section title="API Services">
                                <div className="p-3 space-y-2">
                                    <StatusRow
                                        label="StormGlass"
                                        isConnected={isStormglassKeyPresent()}
                                        status={sgStatus?.status}
                                        details={sgStatus ? `${sgStatus.status}: ${sgStatus.message}` : undefined}
                                        loading={sgStatus?.status === 'LOADING'}
                                    />
                                    <StatusRow
                                        label="Gemini AI"
                                        isConnected={isGeminiConfigured()}
                                        details={isGeminiConfigured() ? 'Via Edge Function' : 'Not configured'}
                                    />
                                    <StatusRow
                                        label="Mapbox"
                                        isConnected={isMapboxConfigured()}
                                        details={getKeyPreview('MAPBOX')}
                                    />
                                    <StatusRow
                                        label="Supabase"
                                        isConnected={isSupabaseConfigured()}
                                        details={isSupabaseConfigured() ? 'Connected' : 'Not configured'}
                                    />
                                    <StatusRow
                                        label="Open-Meteo"
                                        isConnected={!!isOpenMeteoConfigured()}
                                        details={isOpenMeteoConfigured() ? 'Commercial API' : 'FREE MODE'}
                                    />
                                </div>
                            </Section>

                            {/* Account Actions */}
                            {user && (
                                <Section title="Account">
                                    <Row>
                                        <button
                                            onClick={logout}
                                            className="w-full py-3 bg-red-500/10 text-red-400 rounded-xl text-xs font-bold uppercase flex items-center justify-center gap-2 hover:bg-red-500/20 transition-colors active:scale-95"
                                        >
                                            <LockIcon className="w-4 h-4" />
                                            Sign Out
                                        </button>
                                    </Row>
                                </Section>
                            )}
                        </div>
                    )}

                    {activeTab === 'general' && (
                        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
                            <Section title="Location & Time">
                                <Row>
                                    <div className="flex-1">
                                        <label className="text-sm text-white font-medium block">Default Port</label>
                                    </div>
                                    <div className="flex gap-2">
                                        <div className="relative">
                                            <input
                                                type="text"
                                                value={settings.defaultLocation || ''}
                                                onChange={(e) => onSave({ defaultLocation: e.target.value })}
                                                className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm w-48"
                                                placeholder="City, Country"
                                            />
                                        </div>
                                        <button
                                            onClick={handleDetectLocation}
                                            className="p-2 bg-sky-500/20 text-sky-400 rounded-lg"
                                        >
                                            <CompassIcon rotation={0} className="w-4 h-4" />
                                        </button>
                                    </div>
                                </Row>
                            </Section>

                            <Section title="Units">
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4">
                                    {/* Speed */}
                                    <div>
                                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                                            Wind Speed
                                        </label>
                                        <select
                                            value={settings.units.speed}
                                            onChange={(e) => updateUnit('speed', e.target.value)}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                        >
                                            <option value="kts">Knots</option>
                                            <option value="mph">MPH</option>
                                            <option value="kmh">KM/H</option>
                                            <option value="mps">M/S</option>
                                        </select>
                                    </div>
                                    {/* Distance */}
                                    <div>
                                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                                            Distance
                                        </label>
                                        <select
                                            value={settings.units.distance}
                                            onChange={(e) => updateUnit('distance', e.target.value)}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                        >
                                            <option value="nm">Nautical Miles</option>
                                            <option value="mi">Miles</option>
                                            <option value="km">Kilometers</option>
                                        </select>
                                    </div>
                                    {/* Seas (Wave Height) */}
                                    <div>
                                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                                            Seas (Wave Height)
                                        </label>
                                        <select
                                            value={settings.units.waveHeight || 'm'}
                                            onChange={(e) => updateUnit('waveHeight', e.target.value)}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                        >
                                            <option value="m">Meters</option>
                                            <option value="ft">Feet</option>
                                        </select>
                                    </div>

                                    {/* Tides / Length */}
                                    <div>
                                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                                            Tides / Length
                                        </label>
                                        <select
                                            value={settings.units.length}
                                            onChange={(e) => {
                                                const val = e.target.value;
                                                onSave({
                                                    units: {
                                                        ...settings.units,
                                                        length: val as LengthUnit,
                                                        tideHeight: val as LengthUnit,
                                                    },
                                                });
                                            }}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                        >
                                            <option value="ft">Feet</option>
                                            <option value="m">Meters</option>
                                        </select>
                                    </div>
                                    {/* Temperature */}
                                    <div>
                                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                                            Temperature
                                        </label>
                                        <select
                                            value={settings.units.temp}
                                            onChange={(e) => updateUnit('temp', e.target.value)}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                        >
                                            <option value="C">Celsius</option>
                                            <option value="F">Fahrenheit</option>
                                        </select>
                                    </div>
                                    {/* Visibility */}
                                    <div>
                                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                                            Visibility
                                        </label>
                                        <select
                                            value={settings.units.visibility || 'nm'}
                                            onChange={(e) => updateUnit('visibility', e.target.value)}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                        >
                                            <option value="nm">Nautical Miles</option>
                                            <option value="mi">Miles</option>
                                            <option value="km">Kilometers</option>
                                        </select>
                                    </div>
                                    {/* Volume */}
                                    <div>
                                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                                            Liquid Volume
                                        </label>
                                        <select
                                            value={settings.units.volume || 'gal'}
                                            onChange={(e) => updateUnit('volume', e.target.value)}
                                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                                        >
                                            <option value="gal">Gallons</option>
                                            <option value="l">Liters</option>
                                        </select>
                                    </div>
                                </div>
                            </Section>
                            <Section title="Legal">
                                <div className="p-4">
                                    <button
                                        onClick={() => window.open('/terms.html', '_blank')}
                                        className="w-full flex items-center gap-3 p-3 bg-white/[0.03] border border-white/5 rounded-xl hover:bg-white/[0.07] hover:border-white/10 transition-all active:scale-[0.98] text-left"
                                    >
                                        <div className="p-2 bg-white/5 rounded-lg">
                                            <svg
                                                className="w-4 h-4 text-gray-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={1.5}
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                                />
                                            </svg>
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-sm text-white font-bold">
                                                Terms of Service & Privacy Policy
                                            </p>
                                            <p className="text-xs text-gray-500 mt-0.5">
                                                View our terms, conditions, and data practices
                                            </p>
                                        </div>
                                        <ArrowRightIcon className="w-4 h-4 text-gray-500" />
                                    </button>
                                </div>
                            </Section>
                            <Section title="Danger Zone">
                                <div className="p-4">
                                    <button
                                        onClick={() => setShowFactoryReset(true)}
                                        className="w-full py-3 bg-red-500/10 text-red-400 rounded-xl text-xs font-bold uppercase flex items-center justify-center gap-2"
                                    >
                                        <TrashIcon className="w-4 h-4" /> Factory Reset
                                    </button>
                                </div>
                            </Section>
                        </div>
                    )}

                    {activeTab === 'vessel' && <VesselTab settings={settings} onSave={onSave} />}

                    {activeTab === 'alerts' && <AlertsTab settings={settings} onSave={onSave} />}

                    {activeTab === 'scenery' && <AestheticsTab settings={settings} onSave={onSave} />}
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
};
