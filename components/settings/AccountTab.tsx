/**
 * AccountTab — System & Cloud settings panel: auth, API status, sync options.
 * Extracted from SettingsModal to reduce component size.
 */
import React, { useState, useEffect } from 'react';
import { Section, Row, Toggle, type SettingsTabProps } from './SettingsPrimitives';
import { CloudIcon, GearIcon, MapIcon, CompassIcon, LockIcon } from '../Icons';
import { AuthModal } from '../AuthModal';
import { useThalassa } from '../../context/ThalassaContext';
import { checkStormglassStatus, isStormglassKeyPresent, getOpenMeteoKey } from '../../services/weather/keys';
import { isGeminiConfigured } from '../../services/geminiService';
import { isSupabaseConfigured } from '../../services/supabase';

const isMapboxConfigured = () => {
    const envKey = process.env?.MAPBOX_ACCESS_TOKEN || (import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN);
    if (envKey && envKey.length > 5 && !envKey.includes('YOUR_')) return true;
    try {
        const local = localStorage.getItem('thalassa_mapbox_key');
        return !!local;
    } catch (e) {
        console.warn('Suppressed:', e);
        return false;
    }
};

const isOpenMeteoConfigured = () => {
    const key = getOpenMeteoKey();
    return key && key.length > 5 && !key.includes('YOUR_');
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

// ── Status Row sub-component ──
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
                        aria-label="Test"
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

export const AccountTab: React.FC<SettingsTabProps> = ({ settings, onSave }) => {
    const { user, logout } = useThalassa();
    const [authOpen, setAuthOpen] = useState(false);
    const [sgStatus, setSgStatus] = useState<{ status: string; message: string } | null>(null);

    useEffect(() => {
        setSgStatus({ status: 'LOADING', message: 'Checking...' });
        checkStormglassStatus().then((res: { status: string; message: string }) =>
            setSgStatus({ status: res.status, message: res.message }),
        );
    }, []);

    return (
        <div className="max-w-2xl mx-auto animate-in fade-in slide-in-from-right-4 duration-300">
            <AuthModal isOpen={authOpen} onClose={() => setAuthOpen(false)} />

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
                            aria-label="Auth Open"
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
                            <p className="text-xs text-gray-400">
                                {isSupabaseConfigured() ? 'Backend configured and ready' : 'Backend not configured'}
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
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5l16.5 9" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-white font-bold text-sm">Satellite Mode</p>
                                <p
                                    className={`text-xs mt-0.5 transition-colors ${settings.satelliteMode ? 'text-amber-300/70' : 'text-gray-400'}`}
                                >
                                    {settings.satelliteMode
                                        ? '~200 KB/day • Weather only'
                                        : 'For Iridium GO! & metered connections'}
                                </p>
                            </div>
                        </div>
                        <Toggle checked={!!settings.satelliteMode} onChange={(v) => onSave({ satelliteMode: v })} />
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
                                <span className="text-amber-200/70">Cloud sync paused to conserve bandwidth</span>
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
                                <p className="text-xs text-gray-400">Units, vessel profile, preferences</p>
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
                                <p className="text-xs text-gray-400">Track logs, waypoints, GPX data</p>
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
                                <p className="text-xs text-gray-400">Share and discover voyage tracks</p>
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
                    <StatusRow label="Mapbox" isConnected={isMapboxConfigured()} details={getKeyPreview('MAPBOX')} />
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
                            aria-label="Lock"
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
    );
};
