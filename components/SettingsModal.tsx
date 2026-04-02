import React, { useState, useEffect } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SettingsModal');
import { UserSettings } from '../types';
import { BellIcon, ArrowRightIcon, BoatIcon, StarIcon, GearIcon, ServerIcon, MapPinIcon, MapIcon } from './Icons';
import { reverseGeocode } from '../services/weatherService';
import { useThalassa } from '../context/ThalassaContext';
import { GpsService } from '../services/GpsService';

import { AlertsTab } from './settings/AlertsTab';
import { AestheticsTab } from './settings/AestheticsTab';
import { VesselTab } from './settings/VesselTab';
import { GeneralTab } from './settings/GeneralTab';
import { AccountTab } from './settings/AccountTab';
import { LocationsTab } from './settings/LocationsTab';
import { SignalKTab } from './settings/SignalKTab';

import { ConfirmDialog } from './ui/ConfirmDialog';

interface SettingsViewProps {
    settings: UserSettings;
    onSave: (settings: Partial<UserSettings>) => void;
    onLocationSelect: (location: string) => void;
    onBack?: () => void;
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
            aria-label="Click"
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
            aria-label="Click"
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

type SettingsTab = 'general' | 'account' | 'vessel' | 'alerts' | 'scenery' | 'locations' | 'charts' | 'layout';

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
    {
        id: 'charts' as SettingsTab,
        label: 'Chart Server',
        description: 'Connect to AvNav or Signal K',
        icon: (c: string) => <MapIcon className={c} />,
        iconBg: 'bg-teal-500/15 text-teal-400 shadow-teal-500/10',
        iconHoverBg: 'group-hover:bg-teal-500/25',
    },
];

export const SettingsView: React.FC<SettingsViewProps> = React.memo(
    ({ settings, onSave, onLocationSelect, onBack }) => {
        const { resetSettings } = useThalassa();
        const [activeTab, setActiveTab] = useState<SettingsTab | null>(() => {
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
                            label={isObserver ? 'VESSEL (CREW)' : 'VESSEL PROFILE'}
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
                        <NavButton
                            active={activeTab === 'charts'}
                            onClick={() => setActiveTab('charts')}
                            icon={<MapIcon className="w-5 h-5" />}
                            label="CHART SERVER"
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
                    <div className="md:hidden flex-1 flex flex-col">
                        <div className="px-6 pt-8 pb-4">
                            <div className="flex items-center gap-3">
                                {onBack && (
                                    <button
                                        onClick={onBack}
                                        className="p-2 rounded-xl bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                                        aria-label="Back"
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
                        <div className="flex-1 px-4 pb-32 space-y-2">
                            {MENU_ITEMS.map((item) => {
                                return (
                                    <button
                                        aria-label="Active Tab"
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
                                            <p className="text-gray-300 text-xs mt-0.5">
                                                {item.id === 'vessel' && isObserver
                                                    ? 'Crew Member — tap to configure vessel'
                                                    : item.description}
                                            </p>
                                        </div>
                                        <ArrowRightIcon className="w-4 h-4 text-gray-400 group-hover:text-sky-400 group-hover:translate-x-1 transition-all" />
                                    </button>
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

                        {activeTab === 'charts' && <SignalKTab />}
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
