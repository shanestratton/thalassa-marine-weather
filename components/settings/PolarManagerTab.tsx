/**
 * PolarManagerTab — Tabbed interface for polar data input + Smart Polars.
 * Tab A: File Import (.pol / .csv)
 * Tab B: Manual Matrix (editable spreadsheet)
 *
 * Also includes:
 * - Factory vs Smart Polars toggle
 * - NMEA connection status
 * - Smart Polars stats & filter gate status
 * - PolarChart with overlay
 *
 * Yacht database selection has moved to VesselTab (Settings → Vessel Profile).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PolarData } from '../../types';
import { PolarChart } from './PolarChart';
import { parsePolarFile, validatePolarData, createEmptyPolar } from '../../utils/polarParser';
import { NmeaListenerService, type NmeaConnectionStatus } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { SmartPolarService, type FilterStatus } from '../../services/SmartPolarService';
import { SmartPolarStore } from '../../services/SmartPolarStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';

type InputTab = 'import' | 'manual';

interface PolarManagerTabProps {
    settings?: {
        polarSource?: 'factory' | 'smart';
        nmeaHost?: string;
        nmeaPort?: number;
        smartPolarsEnabled?: boolean;
        polarData?: PolarData;
        polarBoatModel?: string;
        polarSource_type?: 'database' | 'file_import' | 'manual';
    };
    onSave?: (patch: Record<string, unknown>) => void;
    onNavigateToNmea?: () => void;
}

export const PolarManagerTab: React.FC<PolarManagerTabProps> = ({ settings, onSave, onNavigateToNmea }) => {
    const [activeTab, setActiveTab] = useState<InputTab>('import');
    const [polarData, setPolarData] = useState<PolarData>(settings?.polarData || createEmptyPolar());
    const [boatModel, setBoatModel] = useState(settings?.polarBoatModel || '');
    const [source, setSource] = useState<'database' | 'file_import' | 'manual'>(settings?.polarSource_type || 'manual');
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<string | null>(settings?.polarData ? 'Loaded from device' : null);
    const [showAdvancedInput, setShowAdvancedInput] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);

    // Smart Polars state
    const [smartPolarData, setSmartPolarData] = useState<PolarData | null>(null);
    const [nmeaStatus, setNmeaStatus] = useState<NmeaConnectionStatus>('disconnected');
    const [filterStatus, setFilterStatus] = useState<FilterStatus | null>(null);
    const [smartStats, setSmartStats] = useState<{
        totalSamples: number;
        filledBuckets: number;
        totalBuckets: number;
    } | null>(null);
    const [polarSource, setPolarSource] = useState<'factory' | 'smart'>(settings?.polarSource || 'factory');
    const [smartEnabled, setSmartEnabled] = useState(settings?.smartPolarsEnabled || false);

    // Sync local state when settings prop changes (e.g. after onboarding)
    useEffect(() => {
        if (settings?.polarData) {
            setPolarData(settings.polarData);
        }
        if (settings?.polarBoatModel) {
            setBoatModel(settings.polarBoatModel);
        }
        if (settings?.polarSource_type) {
            setSource(settings.polarSource_type);
        }
    }, [settings?.polarData, settings?.polarBoatModel, settings?.polarSource_type]);

    // Load smart polar data on mount
    useEffect(() => {
        loadSmartPolarData();
    }, []);

    // Subscribe to NMEA + Smart Polar status
    useEffect(() => {
        const unsub1 = NmeaListenerService.onStatusChange(setNmeaStatus);
        const unsub2 = SmartPolarService.onStatusChange(setFilterStatus);
        setNmeaStatus(NmeaListenerService.getStatus());

        // Refresh smart polar data periodically
        const refreshInterval = setInterval(() => loadSmartPolarData(), 15000);

        return () => {
            unsub1();
            unsub2();
            clearInterval(refreshInterval);
        };
    }, []);

    const loadSmartPolarData = async () => {
        await SmartPolarStore.initialize();
        const exported = SmartPolarStore.exportToPolarData();
        setSmartPolarData(exported);
        setSmartStats(SmartPolarStore.getStats());
    };

    // Save polar data to settings (persisted locally via Capacitor Preferences)
    const savePolar = useCallback(
        (data: PolarData, model: string, src: string) => {
            setSaving(true);
            onSave?.({
                polarData: data,
                polarBoatModel: model,
                polarSource_type: src as 'database' | 'file_import' | 'manual',
            });
            setLastSaved(new Date().toLocaleTimeString());
            setSaving(false);
        },
        [onSave],
    );

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const updatePolar = useCallback(
        (newData: PolarData, model?: string, src?: string) => {
            setPolarData(newData);
            if (model !== undefined) setBoatModel(model);
            if (src !== undefined) setSource(src as typeof source);

            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                savePolar(newData, model ?? boatModel, src ?? source);
            }, 1500);
        },
        [boatModel, source, savePolar],
    );

    // Toggle Smart Polars
    const toggleSmartPolars = (enabled: boolean) => {
        setSmartEnabled(enabled);
        if (enabled) {
            NmeaListenerService.configure(settings?.nmeaHost || '192.168.1.1', settings?.nmeaPort || 10110);
            NmeaListenerService.start();
            NmeaStore.start();
            SmartPolarService.start();
        } else {
            SmartPolarService.stop();
            NmeaStore.stop();
            NmeaListenerService.stop();
        }
        onSave?.({ smartPolarsEnabled: enabled });
    };

    const togglePolarSource = (src: 'factory' | 'smart') => {
        setPolarSource(src);
        onSave?.({ polarSource: src });
    };

    const handleResetSmartData = async () => {
        await SmartPolarStore.reset();
        setSmartPolarData(null);
        setSmartStats(SmartPolarStore.getStats());
        setShowResetConfirm(false);
    };

    return (
        <div className="w-full max-w-2xl mx-auto flex flex-col h-full animate-in fade-in slide-in-from-right-4 duration-300">
            {/* ═══════════════════════════════════════════ */}
            {/* SMART POLARS SECTION */}
            {/* ═══════════════════════════════════════════ */}
            <div className="shrink-0">
                <SmartPolarsCard
                    smartEnabled={smartEnabled}
                    polarSource={polarSource}
                    nmeaStatus={nmeaStatus}
                    filterStatus={filterStatus}
                    smartStats={smartStats}
                    hasRpmData={NmeaListenerService.getHasRpmData()}
                    onToggleSmart={toggleSmartPolars}
                    onToggleSource={togglePolarSource}
                    onReset={() => setShowResetConfirm(true)}
                    onNavigateToNmea={onNavigateToNmea}
                />
            </div>

            {/* Polar Chart Visualization */}
            <div className="mt-4 flex-1 min-h-0 bg-white/[0.02] border border-white/[0.06] rounded-2xl p-4 mx-auto max-w-lg w-full flex flex-col">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex flex-col items-start gap-1">
                        <span className="text-xs font-bold text-sky-400 uppercase tracking-widest">Polar Diagram</span>
                        {boatModel && <span className="text-base font-black text-white">{boatModel}</span>}
                        {!boatModel && (
                            <span className="text-xs text-gray-500">
                                No yacht selected — choose one in Settings → Vessel Profile
                            </span>
                        )}
                    </div>
                    {/* 3-dot menu for advanced input */}
                    <button
                        onClick={() => setShowAdvancedInput(true)}
                        className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-all"
                        title="Advanced polar input"
                        aria-label="Advanced polar input"
                    >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                            <circle cx="10" cy="4" r="1.5" />
                            <circle cx="10" cy="10" r="1.5" />
                            <circle cx="10" cy="16" r="1.5" />
                        </svg>
                    </button>
                </div>
                <div className="flex-1 min-h-0 flex justify-center items-center">
                    <PolarChart data={polarData} overlayData={smartPolarData} />
                </div>

                {/* Save status */}
                <div className="flex items-center justify-center gap-2 mt-3">
                    {saving && (
                        <span className="flex items-center gap-1.5 text-[11px] text-sky-400">
                            <div className="w-3 h-3 border border-sky-400 border-t-transparent rounded-full animate-spin" />
                            Saving…
                        </span>
                    )}
                    {lastSaved && !saving && <span className="text-[11px] text-emerald-400">✓ Saved {lastSaved}</span>}
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ADVANCED POLAR INPUT — Overlay Card        */}
            {/* ═══════════════════════════════════════════ */}
            {showAdvancedInput && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
                    onClick={() => setShowAdvancedInput(false)}
                >
                    <div
                        className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-slate-900 border border-white/10 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-white/10 bg-slate-900/95 rounded-t-2xl">
                            <div className="flex items-center gap-2">
                                <div className="w-1 h-4 rounded-full bg-sky-500" />
                                <span className="text-sm font-bold text-white uppercase tracking-wider">
                                    Advanced Polar Input
                                </span>
                            </div>
                            <button
                                onClick={() => setShowAdvancedInput(false)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-all"
                                aria-label="Close advanced input"
                            >
                                <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        {/* Content */}
                        <div className="p-4">
                            {/* Tab Switcher */}
                            <div className="flex bg-black/40 p-1 rounded-xl border border-white/10 mb-6">
                                {(['import', 'manual'] as InputTab[]).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`flex-1 py-2.5 rounded-lg text-sm font-bold uppercase tracking-wider transition-all ${
                                            activeTab === tab
                                                ? 'bg-sky-600 text-white shadow-lg shadow-sky-500/30'
                                                : 'text-gray-400 hover:text-white'
                                        }`}
                                    >
                                        {tab === 'import' ? '📁 Import' : '✏️ Manual'}
                                    </button>
                                ))}
                            </div>

                            {activeTab === 'import' && (
                                <ImportTab
                                    onImport={(data, filename) => {
                                        updatePolar(data, filename, 'file_import');
                                        setShowAdvancedInput(false);
                                    }}
                                />
                            )}
                            {activeTab === 'manual' && (
                                <ManualTab
                                    polarData={polarData}
                                    onChange={(data) => updatePolar(data, boatModel, 'manual')}
                                />
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Reset Smart Polar confirmation dialog */}
            <ConfirmDialog
                isOpen={showResetConfirm}
                title="Reset Smart Polars"
                message="Reset all Smart Polar data? This cannot be undone."
                confirmLabel="Reset"
                cancelLabel="Cancel"
                destructive
                onConfirm={handleResetSmartData}
                onCancel={() => setShowResetConfirm(false)}
            />
        </div>
    );
};

// ═══════════════════════════════════════════
// SMART POLARS CARD
// ═══════════════════════════════════════════

const SmartPolarsCard: React.FC<{
    smartEnabled: boolean;
    polarSource: 'factory' | 'smart';
    nmeaStatus: NmeaConnectionStatus;
    filterStatus: FilterStatus | null;
    smartStats: { totalSamples: number; filledBuckets: number; totalBuckets: number } | null;
    hasRpmData: boolean;
    onToggleSmart: (enabled: boolean) => void;
    onToggleSource: (src: 'factory' | 'smart') => void;
    onReset: () => void;
    onNavigateToNmea?: () => void;
}> = ({
    smartEnabled,
    polarSource,
    nmeaStatus,
    filterStatus,
    smartStats,
    hasRpmData,
    onToggleSmart,
    onToggleSource,
    onReset,
    onNavigateToNmea,
}) => {
    const nmeaStatusConfig = {
        connected: { color: 'bg-emerald-400', label: 'Connected', icon: '🟢' },
        connecting: { color: 'bg-amber-400 animate-pulse', label: 'Connecting…', icon: '🟡' },
        disconnected: { color: 'bg-gray-500', label: 'Disconnected', icon: '⚪' },
        error: { color: 'bg-red-400', label: 'Error', icon: '🔴' },
    };

    const status = nmeaStatusConfig[nmeaStatus];
    const isDisconnected = nmeaStatus === 'disconnected';
    const fillPercent = smartStats ? Math.round((smartStats.filledBuckets / smartStats.totalBuckets) * 100) : 0;

    return (
        <div
            className={`rounded-2xl p-4 transition-all ${
                isDisconnected
                    ? 'bg-white/[0.02] border border-white/[0.06] opacity-70'
                    : 'bg-gradient-to-br from-emerald-500/5 to-sky-500/5 border border-emerald-500/20'
            }`}
        >
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <div className={`w-1 h-4 rounded-full ${isDisconnected ? 'bg-gray-600' : 'bg-emerald-500'}`} />
                    <span
                        className={`text-xs font-bold uppercase tracking-widest ${isDisconnected ? 'text-gray-500' : 'text-emerald-400'}`}
                    >
                        Smart Polars
                    </span>
                    {!hasRpmData && smartEnabled && (
                        <span className="text-[11px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-lg font-bold">
                            ⚠️ No RPM Data
                        </span>
                    )}
                </div>
                {/* Smart Polars Toggle */}
                <button
                    onClick={() => {
                        if (!smartEnabled && nmeaStatus === 'disconnected' && onNavigateToNmea) {
                            onNavigateToNmea();
                            return;
                        }
                        onToggleSmart(!smartEnabled);
                    }}
                    className={`relative w-11 h-6 rounded-full transition-all ${
                        smartEnabled ? 'bg-emerald-500' : nmeaStatus === 'disconnected' ? 'bg-gray-800' : 'bg-gray-700'
                    }`}
                    aria-label={smartEnabled ? 'Disable Smart Polars' : 'Enable Smart Polars'}
                >
                    <div
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-lg transition-transform ${smartEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
                    />
                </button>
            </div>

            {/* Explanation when disabled */}
            {!smartEnabled && (
                <div className="mb-3 px-3 py-2.5 bg-black/20 rounded-xl border border-white/5">
                    <p className="text-xs text-gray-400 leading-relaxed">
                        Smart Polars learns your boat's <span className="text-white font-bold">real performance</span>{' '}
                        by recording speed data from your onboard instruments via the{' '}
                        <span className="text-sky-400 font-bold">NMEA 2000 backbone</span>.
                    </p>
                    <p className="text-xs text-gray-500 mt-1.5">
                        {nmeaStatus === 'disconnected' ? (
                            <>
                                <span className="text-amber-400">⚠️ Not connected</span> —{' '}
                                {onNavigateToNmea ? (
                                    <button
                                        onClick={onNavigateToNmea}
                                        className="text-sky-400 underline underline-offset-2 font-bold"
                                    >
                                        Set up NMEA Gateway
                                    </button>
                                ) : (
                                    'configure your NMEA gateway first'
                                )}
                                .
                            </>
                        ) : (
                            <>
                                <span className="text-emerald-400">✅ NMEA connected</span> — flip the toggle to start
                                learning.
                            </>
                        )}
                    </p>
                </div>
            )}

            {smartEnabled && (
                <>
                    {/* NMEA Connection Status */}
                    <div className="flex items-center gap-2 mb-3 p-2 bg-black/20 rounded-xl">
                        <div className={`w-2 h-2 rounded-full ${status.color}`} />
                        <span className="text-[11px] font-bold text-gray-300 uppercase tracking-wider">
                            NMEA: {status.label}
                        </span>
                    </div>

                    {/* Filter Gate Status */}
                    {filterStatus && (
                        <div className="grid grid-cols-5 gap-1 mb-3">
                            <GateBadge label="Engine" status={filterStatus.engineOff} />
                            <GateBadge label="Heading" status={filterStatus.stableHeading} />
                            <GateBadge label="Wind" status={filterStatus.steadyWind} />
                            <GateBadge label="Speed" status={filterStatus.minimumSpeed} />
                            <GateBadge label="Steady" status={filterStatus.steadyState} />
                        </div>
                    )}

                    {/* Stats */}
                    {smartStats && (
                        <div className="grid grid-cols-3 gap-2 mb-4">
                            <div className="text-center p-2 bg-black/20 rounded-xl">
                                <p className="text-sm font-black text-white">
                                    {smartStats.totalSamples.toLocaleString()}
                                </p>
                                <p className="text-[11px] text-gray-500 uppercase tracking-widest">Samples</p>
                            </div>
                            <div className="text-center p-2 bg-black/20 rounded-xl">
                                <p className="text-sm font-black text-white">{smartStats.filledBuckets}</p>
                                <p className="text-[11px] text-gray-500 uppercase tracking-widest">Buckets</p>
                            </div>
                            <div className="text-center p-2 bg-black/20 rounded-xl">
                                <p className="text-sm font-black text-white">{fillPercent}%</p>
                                <p className="text-[11px] text-gray-500 uppercase tracking-widest">Coverage</p>
                            </div>
                        </div>
                    )}

                    {/* Recording indicator */}
                    {filterStatus?.recording && (
                        <div className="flex items-center gap-2 mb-3 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider">
                                Recording clean data
                            </span>
                            <span className="text-[11px] text-emerald-400/60 ml-auto font-mono">
                                {filterStatus.totalAccepted} accepted
                            </span>
                        </div>
                    )}
                </>
            )}

            {/* Polar Source Toggle */}
            {smartStats && smartStats.totalSamples > 0 && (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/5">
                    <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Routing Uses:</span>
                    <div className="flex-1 flex bg-black/40 p-0.5 rounded-lg">
                        <button
                            onClick={() => onToggleSource('factory')}
                            className={`flex-1 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all ${polarSource === 'factory' ? 'bg-sky-600 text-white' : 'text-gray-500'}`}
                        >
                            Factory
                        </button>
                        <button
                            onClick={() => onToggleSource('smart')}
                            className={`flex-1 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all ${polarSource === 'smart' ? 'bg-emerald-600 text-white' : 'text-gray-500'}`}
                        >
                            Smart
                        </button>
                    </div>
                    <button
                        onClick={onReset}
                        className="text-[11px] font-bold text-red-400/50 hover:text-red-400 uppercase tracking-wider transition-colors px-2"
                        aria-label="Reset Smart Polar data"
                    >
                        Reset
                    </button>
                </div>
            )}
        </div>
    );
};

const GateBadge: React.FC<{ label: string; status: 'pass' | 'fail' | 'unavailable' }> = ({ label, status }) => {
    const config = {
        pass: { bg: 'bg-emerald-500/20 border-emerald-500/30', text: 'text-emerald-400', dot: 'bg-emerald-400' },
        fail: { bg: 'bg-red-500/20 border-red-500/30', text: 'text-red-400', dot: 'bg-red-400' },
        unavailable: { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-500', dot: 'bg-gray-500' },
    };
    const c = config[status];
    return (
        <div className={`flex items-center justify-center gap-1 py-1.5 rounded-lg border ${c.bg}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
            <span className={`text-[11px] font-bold uppercase tracking-widest ${c.text}`}>{label}</span>
        </div>
    );
};

// ═══════════════════════════════════════════
// TAB B: FILE IMPORT
// ═══════════════════════════════════════════

const ImportTab: React.FC<{
    onImport: (data: PolarData, filename: string) => void;
}> = ({ onImport }) => {
    const [dragOver, setDragOver] = useState(false);
    const [fileName, setFileName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFile = async (file: File) => {
        setError(null);
        setWarnings([]);
        try {
            const content = await file.text();
            const data = parsePolarFile(content, file.name);
            const validation = validatePolarData(data);
            setWarnings(validation.warnings);
            setFileName(file.name);
            onImport(data, file.name.replace(/\.(pol|csv)$/i, ''));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to parse file');
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
    };

    return (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-4 rounded-full bg-amber-500" />
                <span className="text-[11px] font-bold text-amber-400 uppercase tracking-widest">
                    Import Polar File
                </span>
            </div>

            <div
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
                    dragOver
                        ? 'border-sky-400 bg-sky-500/10'
                        : 'border-white/10 hover:border-white/20 hover:bg-white/[0.02]'
                }`}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pol,.csv,.txt"
                    onChange={handleInputChange}
                    className="hidden"
                />
                <div className="text-3xl mb-3">{fileName ? '✅' : '📄'}</div>
                <p className="text-sm font-bold text-white mb-1">{fileName ? fileName : 'Drop polar file here'}</p>
                <p className="text-[11px] text-gray-500">Supports .pol (Expedition) and .csv (OpenCPN) formats</p>
            </div>

            {error && (
                <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <p className="text-xs text-red-400 font-bold">⚠️ {error}</p>
                </div>
            )}

            {warnings.length > 0 && (
                <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                    <p className="text-xs text-amber-400 font-bold mb-1">⚠️ Warnings:</p>
                    {warnings.map((w, i) => (
                        <p key={i} className="text-[11px] text-amber-300/70">
                            • {w}
                        </p>
                    ))}
                </div>
            )}

            <div className="mt-4 p-3 bg-white/[0.02] rounded-xl">
                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-2">Expected Format</p>
                <pre className="text-[11px] text-gray-500 font-mono overflow-x-auto">
                    {`TWA    6    8    10   12   15   20   25
45   4.2  5.1  5.8  6.2  6.5  6.4  6.0
60   4.8  5.7  6.4  6.9  7.2  7.1  6.7
90   5.2  6.2  7.0  7.5  7.9  7.8  7.3`}
                </pre>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════
// TAB C: MANUAL MATRIX
// ═══════════════════════════════════════════

const ManualTab: React.FC<{
    polarData: PolarData;
    onChange: (data: PolarData) => void;
}> = ({ polarData, onChange }) => {
    const updateCell = (angleIdx: number, windIdx: number, value: string) => {
        const num = parseFloat(value);
        const newMatrix = polarData.matrix.map((row, ai) =>
            row.map((cell, wi) => (ai === angleIdx && wi === windIdx ? (isNaN(num) ? 0 : num) : cell)),
        );
        onChange({ ...polarData, matrix: newMatrix });
    };

    return (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-4 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-widest">Manual Entry</span>
                <span className="text-[11px] text-gray-500 ml-auto">Boat speed in knots</span>
            </div>

            <div className="overflow-x-auto custom-scrollbar -mx-1 px-1">
                <table className="w-full border-collapse min-w-[500px]">
                    <thead>
                        <tr>
                            <th className="text-[11px] font-bold text-gray-500 uppercase tracking-wider p-2 text-left sticky left-0 bg-slate-950 z-10 min-w-[52px]">
                                TWA\TWS
                            </th>
                            {polarData.windSpeeds.map((ws) => (
                                <th
                                    key={ws}
                                    className="text-[11px] font-bold text-sky-400 uppercase tracking-wider p-2 text-center min-w-[52px]"
                                >
                                    {ws}kts
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {polarData.angles.map((angle, aIdx) => (
                            <tr key={angle} className="border-t border-white/5">
                                <td className="text-[11px] font-bold text-amber-400 p-2 sticky left-0 bg-slate-950 z-10">
                                    {angle}°
                                </td>
                                {polarData.windSpeeds.map((_, wIdx) => {
                                    const val = polarData.matrix[aIdx]?.[wIdx] ?? 0;
                                    const isAnomaly = checkAnomaly(polarData, aIdx, wIdx);
                                    return (
                                        <td key={wIdx} className="p-1">
                                            <input
                                                type="number"
                                                step="0.1"
                                                min="0"
                                                max="30"
                                                value={val || ''}
                                                onChange={(e) => updateCell(aIdx, wIdx, e.target.value)}
                                                placeholder="—"
                                                className={`w-full text-center text-xs font-mono py-1.5 px-1 rounded-lg outline-none transition-all ${
                                                    isAnomaly
                                                        ? 'bg-red-500/20 border border-red-500/40 text-red-300 focus:border-red-400'
                                                        : val > 0
                                                          ? 'bg-white/5 border border-white/10 text-white focus:border-sky-500 focus:bg-sky-500/5'
                                                          : 'bg-white/[0.02] border border-white/5 text-gray-500 focus:border-sky-500'
                                                }`}
                                            />
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="flex gap-2 mt-4">
                <button
                    onClick={() => onChange(createEmptyPolar())}
                    className="text-[11px] font-bold text-gray-400 uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
                >
                    Clear All
                </button>
            </div>
        </div>
    );
};

function checkAnomaly(data: PolarData, aIdx: number, wIdx: number): boolean {
    const val = data.matrix[aIdx]?.[wIdx] ?? 0;
    if (val <= 0) return false;

    const neighbors: number[] = [];
    if (aIdx > 0) neighbors.push(data.matrix[aIdx - 1]?.[wIdx] ?? 0);
    if (aIdx < data.angles.length - 1) neighbors.push(data.matrix[aIdx + 1]?.[wIdx] ?? 0);
    if (wIdx > 0) neighbors.push(data.matrix[aIdx]?.[wIdx - 1] ?? 0);
    if (wIdx < data.windSpeeds.length - 1) neighbors.push(data.matrix[aIdx]?.[wIdx + 1] ?? 0);

    const validNeighbors = neighbors.filter((n) => n > 0);
    if (validNeighbors.length === 0) return false;

    const avg = validNeighbors.reduce((a, b) => a + b, 0) / validNeighbors.length;
    return Math.abs(val - avg) / avg > 0.5;
}
