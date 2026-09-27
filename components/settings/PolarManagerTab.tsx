/**
 * PolarManagerTab — Tabbed interface for polar data input + Smart Polars.
 * Tab A: File Import (.pol / .csv)
 * Tab B: Manual Matrix (editable spreadsheet)
 *
 * Also includes:
 * - Smart Polars state, with a link to its switch in Settings → Preferences
 *   (moved there, UX scorecard run 8; see SmartPolarsSetting)
 * - Factory vs Smart polar data for routing
 * - NMEA connection status
 * - Smart Polars stats & filter gate status
 * - PolarChart with overlay
 *
 * Yacht database selection has moved to VesselTab (Settings → Vessel Profile).
 */
import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import type { PolarData } from '../../types';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { PolarChart } from './PolarChart';
import { parsePolarFile, validatePolarData, createEmptyPolar } from '../../utils/polarParser';
import { NmeaListenerService, type NmeaConnectionStatus } from '../../services/NmeaListenerService';
import { SmartPolarService, type FilterStatus } from '../../services/SmartPolarService';
import { SmartPolarStore } from '../../services/SmartPolarStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { OverlayPortal } from '../ui/OverlayPortal';
import { CheckIcon, CheckCircleIcon, AlertTriangleIcon, DownloadIcon, EditIcon, XIcon, MinusIcon } from '../Icons';
import { RowChevron } from './SettingsPrimitives';
import { Button } from '../ui/Button';

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
    /** Opens Settings so the skipper can pick a yacht under Vessel Profile. */
    onOpenVesselProfile?: () => void;
    /** Opens Settings → Preferences, where the Smart Polars switch lives. */
    onOpenPreferences?: () => void;
}

export const PolarManagerTab: React.FC<PolarManagerTabProps> = ({
    settings,
    onSave,
    onNavigateToNmea,
    onOpenVesselProfile,
    onOpenPreferences,
}) => {
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
    // Read from settings: the switch is in Preferences now, and this page shows
    // what it says.
    const smartEnabled = settings?.smartPolarsEnabled === true;
    const advancedTitleId = useId();
    const advancedCloseRef = useRef<HTMLButtonElement>(null);
    const mountedRef = useRef(true);
    const smartLoadRequestRef = useRef(0);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const advancedDialogRef = useFocusTrap(showAdvancedInput, {
        initialFocusRef: advancedCloseRef,
        onEscape: () => setShowAdvancedInput(false),
    });

    const loadSmartPolarData = useCallback(async () => {
        const requestId = ++smartLoadRequestRef.current;
        try {
            await SmartPolarStore.initialize();
            if (!mountedRef.current || requestId !== smartLoadRequestRef.current) return;
            setSmartPolarData(SmartPolarStore.exportToPolarData());
            setSmartStats(SmartPolarStore.getStats());
        } catch {
            if (!mountedRef.current || requestId !== smartLoadRequestRef.current) return;
            setSmartPolarData(null);
            setSmartStats(null);
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            smartLoadRequestRef.current += 1;
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, []);

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
        void loadSmartPolarData();
    }, [loadSmartPolarData]);

    // Subscribe to NMEA + Smart Polar status
    useEffect(() => {
        const unsub1 = NmeaListenerService.onStatusChange(setNmeaStatus);
        const unsub2 = SmartPolarService.onStatusChange(setFilterStatus);
        setNmeaStatus(NmeaListenerService.getStatus());

        // Refresh smart polar data periodically
        const refreshInterval = setInterval(() => void loadSmartPolarData(), 15000);

        return () => {
            unsub1();
            unsub2();
            clearInterval(refreshInterval);
        };
    }, [loadSmartPolarData]);

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

    // Same test PolarChart uses for its own empty state.
    const hasFigures = (data: PolarData | null | undefined) =>
        data?.matrix.some((row) => row.some((v) => v > 0)) ?? false;
    const chartIsEmpty = !hasFigures(polarData) && !hasFigures(smartPolarData);

    return (
        <div className="w-full max-w-2xl mx-auto flex flex-col h-full overflow-y-auto pb-[calc(5.5rem+env(safe-area-inset-bottom))] animate-in fade-in slide-in-from-right-4 duration-300">
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
                    onOpenPreferences={onOpenPreferences}
                    onToggleSource={togglePolarSource}
                    onReset={() => setShowResetConfirm(true)}
                    onNavigateToNmea={onNavigateToNmea}
                />
            </div>

            {/* Polar Chart Visualization */}
            <div className="mt-4 shrink-0 bg-white/2 border border-white/6 rounded-2xl p-4 mx-auto max-w-lg w-full flex flex-col">
                {/* A named button, not an unlabelled ⋮, is the way in to typing or
                    importing figures (UX scorecard run 6). */}
                <div className="mb-4 flex flex-col items-start gap-1">
                    <h2 className="text-xs font-bold text-sky-300 uppercase tracking-widest">Polar diagram</h2>
                    {boatModel ? (
                        <span className="text-base font-black text-white">{boatModel}</span>
                    ) : (
                        <>
                            <p className="text-sm text-gray-400">No boat design chosen</p>
                            {onOpenVesselProfile ? (
                                <button
                                    type="button"
                                    onClick={onOpenVesselProfile}
                                    className="inline-flex min-h-11 items-center text-xs font-bold text-sky-300 underline underline-offset-2"
                                >
                                    Choose one in Settings, under Vessel profile
                                </button>
                            ) : (
                                <p className="text-xs text-gray-400">Choose one in Settings, under Vessel profile</p>
                            )}
                        </>
                    )}
                    <Button variant="secondary" onClick={() => setShowAdvancedInput(true)} className="mt-2 text-white">
                        <EditIcon className="w-4 h-4" />
                        <span>Enter polar figures</span>
                    </Button>
                </div>
                {/* With no figures the empty rings took ~350 pt and showed nothing,
                    pushing the save state off the card; a short placeholder keeps
                    'Enter polar figures' the obvious next step (UX scorecard run 7). */}
                {chartIsEmpty ? (
                    <div className="flex min-h-[120px] w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/10 px-4 text-center">
                        <p className="text-sm font-bold text-gray-300">No polar yet</p>
                        <p className="text-xs text-gray-400">The diagram draws as soon as there are figures.</p>
                    </div>
                ) : (
                    <div className="aspect-square w-full max-h-[360px] mx-auto flex justify-center items-center">
                        <PolarChart data={polarData} overlayData={smartPolarData} emptyLabel="No polar yet" />
                    </div>
                )}

                {/* Save status */}
                <div className="flex items-center justify-center gap-2 mt-3">
                    {saving && (
                        <span className="flex items-center gap-1.5 text-xs text-sky-300">
                            <div className="w-3 h-3 border border-sky-400 border-t-transparent rounded-full animate-spin" />
                            Saving…
                        </span>
                    )}
                    {lastSaved && !saving && (
                        <span className="text-xs text-emerald-400 inline-flex items-center gap-1">
                            <CheckIcon className="w-3 h-3" />
                            <span>Saved {lastSaved}</span>
                        </span>
                    )}
                </div>
            </div>

            {/* ═══════════════════════════════════════════ */}
            {/* ENTER POLAR FIGURES — Overlay Card          */}
            {/* ═══════════════════════════════════════════ */}
            {showAdvancedInput && (
                <OverlayPortal
                    className="flex items-center justify-center p-4 bg-black/70"
                    onClick={() => setShowAdvancedInput(false)}
                    role="presentation"
                >
                    <div
                        ref={advancedDialogRef}
                        className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-slate-900 border border-white/10 rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={advancedTitleId}
                    >
                        {/* Header */}
                        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-white/10 bg-slate-900/95 rounded-t-2xl">
                            <div className="flex items-center gap-2">
                                <h2 id={advancedTitleId} className="text-base font-bold text-white">
                                    Enter polar figures
                                </h2>
                            </div>
                            <button
                                type="button"
                                ref={advancedCloseRef}
                                onClick={() => setShowAdvancedInput(false)}
                                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-all"
                                aria-label="Close polar figures"
                            >
                                <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        {/* Content */}
                        <div className="p-4">
                            {/* Tab Switcher */}
                            <div
                                className="flex bg-black/40 p-1 rounded-xl border border-white/10 mb-6"
                                role="group"
                                aria-label="Polar input method"
                            >
                                {(['import', 'manual'] as InputTab[]).map((tab) => (
                                    <button
                                        type="button"
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        aria-pressed={activeTab === tab}
                                        className={`flex-1 min-h-11 py-2.5 rounded-lg text-sm font-bold uppercase tracking-wider transition-all inline-flex items-center justify-center gap-1.5 ${
                                            activeTab === tab
                                                ? 'bg-sky-600 text-white shadow-lg shadow-sky-500/30'
                                                : 'text-gray-400 hover:text-white'
                                        }`}
                                    >
                                        {tab === 'import' ? (
                                            <DownloadIcon className="w-4 h-4" />
                                        ) : (
                                            <EditIcon className="w-4 h-4" />
                                        )}
                                        <span>{tab === 'import' ? 'Import' : 'Manual'}</span>
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
                </OverlayPortal>
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
    onOpenPreferences?: () => void;
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
    onOpenPreferences,
    onToggleSource,
    onReset,
    onNavigateToNmea,
}) => {
    // Status dot color (the unused icon field used to be 🟢🟡⚪🔴; removed
    // since nothing rendered them — the `color` background dot conveys
    // the state already).
    const nmeaStatusConfig = {
        connected: { color: 'bg-emerald-400', label: 'Connected' },
        connecting: { color: 'bg-amber-400 animate-pulse', label: 'Connecting…' },
        disconnected: { color: 'bg-gray-500', label: 'Disconnected' },
        error: { color: 'bg-red-400', label: 'Error' },
    };

    const status = nmeaStatusConfig[nmeaStatus];
    const isDisconnected = nmeaStatus === 'disconnected';
    const fillPercent = smartStats ? Math.round((smartStats.filledBuckets / smartStats.totalBuckets) * 100) : 0;

    return (
        <div
            className={`rounded-2xl p-4 transition-all ${
                isDisconnected
                    ? // Dim the chrome only: opacity-70 on the card put its daylight
                      // text at 3.45–4.3:1 (UX scorecard run 6).
                      'bg-white/2 border border-white/6'
                    : 'bg-linear-to-br from-emerald-500/5 to-sky-500/5 border border-emerald-500/20'
            }`}
        >
            {/* gap-3 + wrap: at 375 pt the heading ran into its caption
                ('SMART POLARSNeeds NMEA gateway'). One card-heading style with
                the Polar diagram card below (UX scorecard run 7). */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xs font-bold text-sky-300 uppercase tracking-widest">Smart Polars</h2>
                    {!hasRpmData && smartEnabled && (
                        <span className="text-xs text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-lg font-bold inline-flex items-center gap-1">
                            <AlertTriangleIcon className="w-3 h-3" />
                            <span>No RPM data</span>
                        </span>
                    )}
                </div>
                {/* The switch lives in Settings → Preferences, the home for
                    switches (UX scorecard run 8). Here, its state and the way
                    there, in one line. */}
                {onOpenPreferences ? (
                    <button
                        type="button"
                        onClick={onOpenPreferences}
                        className="inline-flex min-h-11 items-center gap-1.5 text-xs font-bold text-sky-300"
                    >
                        <span className={smartEnabled ? 'text-emerald-400' : 'text-gray-300'}>
                            {smartEnabled ? 'On' : 'Off'}
                        </span>
                        <span aria-hidden="true" className="text-gray-400">
                            ·
                        </span>
                        <span className="underline underline-offset-2">Change in Preferences</span>
                        <RowChevron className="w-3.5 h-3.5 text-sky-300" />
                    </button>
                ) : (
                    <span className={`text-xs font-bold ${smartEnabled ? 'text-emerald-400' : 'text-gray-300'}`}>
                        {smartEnabled ? 'On' : 'Off'} · switch in Settings → Preferences
                    </span>
                )}
            </div>

            {/* Explanation when disabled */}
            {!smartEnabled && (
                <div className="mb-3 px-3 py-2.5 bg-black/20 rounded-xl border border-white/5">
                    {/* Emphasis in white, not link blue: only the real link below
                        is blue (UX scorecard run 7). */}
                    <p className="text-xs text-gray-400 leading-relaxed">
                        Smart Polars learns your boat's <span className="text-white font-bold">real performance</span>{' '}
                        by recording speed data from your onboard instruments via the{' '}
                        <span className="text-white font-bold">NMEA 2000 backbone</span>.
                    </p>
                    <p className="text-xs text-gray-400 mt-1.5">
                        {nmeaStatus === 'disconnected' ? (
                            <>
                                {/* Amber on the glyph only: amber text measured under AA
                                    on this box in daylight (UX scorecard run 6). */}
                                <span className="text-gray-200 font-bold inline-flex items-center gap-1">
                                    <AlertTriangleIcon className="w-3 h-3 text-amber-400" />
                                    <span>Not connected</span>
                                </span>{' '}
                                —{' '}
                                {onNavigateToNmea ? (
                                    <button
                                        type="button"
                                        onClick={onNavigateToNmea}
                                        className="inline-flex min-h-11 items-center text-sky-300 underline underline-offset-2 font-bold"
                                    >
                                        Set up NMEA gateway
                                    </button>
                                ) : (
                                    'configure your NMEA gateway first'
                                )}
                                .
                            </>
                        ) : (
                            <>
                                <span className="text-emerald-400 inline-flex items-center gap-1">
                                    <CheckCircleIcon className="w-3 h-3" />
                                    <span>NMEA connected</span>
                                </span>{' '}
                                — turn it on in Preferences.
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
                        <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">
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
                                <p className="text-xs text-gray-400 uppercase tracking-widest">Samples</p>
                            </div>
                            <div className="text-center p-2 bg-black/20 rounded-xl">
                                <p className="text-sm font-black text-white">{smartStats.filledBuckets}</p>
                                <p className="text-xs text-gray-400 uppercase tracking-widest">Buckets</p>
                            </div>
                            <div className="text-center p-2 bg-black/20 rounded-xl">
                                <p className="text-sm font-black text-white">{fillPercent}%</p>
                                <p className="text-xs text-gray-400 uppercase tracking-widest">Coverage</p>
                            </div>
                        </div>
                    )}

                    {/* Recording indicator */}
                    {filterStatus?.recording && (
                        <div className="flex items-center gap-2 mb-3 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                                Recording clean data
                            </span>
                            <span className="text-xs text-emerald-400/80 ml-auto font-mono">
                                {filterStatus.totalAccepted} accepted
                            </span>
                        </div>
                    )}
                </>
            )}

            {/* Polar Source Toggle */}
            {smartStats && smartStats.totalSamples > 0 && (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/5">
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Routing uses</span>
                    <div className="flex-1 flex bg-black/40 p-0.5 rounded-lg">
                        {/* Named from the visible word, with which one is in use. */}
                        <button
                            type="button"
                            aria-label="Factory polar data for routing"
                            aria-pressed={polarSource === 'factory'}
                            onClick={() => onToggleSource('factory')}
                            className={`flex-1 min-h-11 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all ${polarSource === 'factory' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                        >
                            Factory
                        </button>
                        <button
                            type="button"
                            aria-label="Smart polar data for routing"
                            aria-pressed={polarSource === 'smart'}
                            onClick={() => onToggleSource('smart')}
                            className={`flex-1 min-h-11 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all ${polarSource === 'smart' ? 'bg-emerald-600 text-white' : 'text-gray-400'}`}
                        >
                            Smart
                        </button>
                    </div>
                    <button
                        onClick={onReset}
                        className="hit-target-44 py-2 px-2 text-xs font-bold text-red-300 hover:text-red-400 uppercase tracking-wider transition-colors"
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
    // Pass/fail carried by colour alone was invisible to colour-blind users
    // and to VoiceOver — a glyph per state plus a spoken suffix fixes both.
    const config = {
        pass: {
            bg: 'bg-emerald-500/20 border-emerald-500/30',
            text: 'text-emerald-400',
            Icon: CheckIcon,
            spoken: 'passed',
        },
        fail: { bg: 'bg-red-500/20 border-red-500/30', text: 'text-red-400', Icon: XIcon, spoken: 'failed' },
        unavailable: {
            bg: 'bg-gray-500/10 border-gray-500/20',
            text: 'text-gray-400',
            Icon: MinusIcon,
            spoken: 'unavailable',
        },
    };
    const c = config[status];
    return (
        <div className={`flex items-center justify-center gap-1 py-1.5 rounded-lg border ${c.bg}`}>
            <span aria-hidden="true" className={`inline-flex ${c.text}`}>
                <c.Icon className="w-3 h-3" />
            </span>
            <span className={`text-xs font-bold uppercase tracking-wide ${c.text}`}>
                {label}
                <span className="sr-only">: {c.spoken}</span>
            </span>
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
        <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
            {/* The page's one card-heading style, not an amber bar here and an
                emerald one on Manual (UX scorecard run 7). */}
            <h3 className="mb-4 text-xs font-bold text-sky-300 uppercase tracking-widest">Import a polar file</h3>

            <input
                ref={fileInputRef}
                type="file"
                accept=".pol,.csv,.txt"
                onChange={handleInputChange}
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
            />
            <button
                type="button"
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
                    dragOver ? 'border-sky-400 bg-sky-500/10' : 'border-white/10 hover:border-white/20 hover:bg-white/2'
                } w-full`}
            >
                <div className="mb-3 flex justify-center">
                    {fileName ? (
                        <CheckCircleIcon className="w-7 h-7 text-emerald-400" />
                    ) : (
                        <DownloadIcon className="w-7 h-7 text-sky-400/70" />
                    )}
                </div>
                <p className="text-sm font-bold text-white mb-1">{fileName ? fileName : 'Drop polar file here'}</p>
                <p className="text-xs text-gray-400">Supports .pol (Expedition) and .csv (OpenCPN) formats</p>
            </button>

            {error && (
                <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <p className="text-xs text-red-400 font-bold inline-flex items-center gap-1.5">
                        <AlertTriangleIcon className="w-3.5 h-3.5" />
                        <span>{error}</span>
                    </p>
                </div>
            )}

            {warnings.length > 0 && (
                <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                    <p className="text-xs text-amber-400 font-bold mb-1 inline-flex items-center gap-1.5">
                        <AlertTriangleIcon className="w-3.5 h-3.5" />
                        <span>Warnings:</span>
                    </p>
                    {warnings.map((w, i) => (
                        <p key={i} className="text-xs text-amber-200">
                            • {w}
                        </p>
                    ))}
                </div>
            )}

            <div className="mt-4 p-3 bg-white/2 rounded-xl">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Expected format</p>
                <pre className="text-xs text-gray-400 font-mono overflow-x-auto">
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
        <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-4">
                <h3 className="text-xs font-bold text-sky-300 uppercase tracking-widest">Type the figures</h3>
                <span className="text-xs text-gray-400">Boat speed in knots</span>
            </div>

            <div className="overflow-x-auto custom-scrollbar -mx-1 px-1">
                <table className="w-full border-collapse min-w-[500px]">
                    <caption className="sr-only">Polar boat speed matrix in knots</caption>
                    <thead>
                        <tr>
                            <th
                                scope="col"
                                className="text-xs font-bold text-gray-400 uppercase tracking-wider p-2 text-left sticky left-0 bg-slate-950 z-10 min-w-[52px]"
                            >
                                TWA\TWS
                            </th>
                            {polarData.windSpeeds.map((ws) => (
                                <th
                                    key={ws}
                                    scope="col"
                                    className="text-xs font-bold text-sky-300 uppercase tracking-wider p-2 text-center min-w-[52px]"
                                >
                                    {ws}kts
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {polarData.angles.map((angle, aIdx) => (
                            <tr key={angle} className="border-t border-white/5">
                                <th
                                    scope="row"
                                    className="text-xs font-bold text-amber-400 p-2 sticky left-0 bg-slate-950 z-10"
                                >
                                    {angle}°
                                </th>
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
                                                aria-label={`Boat speed at ${angle} degrees true wind angle and ${polarData.windSpeeds[wIdx]} knots true wind speed`}
                                                placeholder="—"
                                                className={`w-full min-h-11 text-center text-xs font-mono py-1.5 px-1 rounded-lg outline-hidden transition-all ${
                                                    isAnomaly
                                                        ? 'bg-red-500/20 border border-red-500/40 text-red-300 focus:border-red-400'
                                                        : val > 0
                                                          ? 'bg-white/5 border border-white/10 text-white focus:border-sky-500 focus:bg-sky-500/5'
                                                          : 'bg-white/2 border border-white/5 text-gray-400 focus:border-sky-500'
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
                    type="button"
                    aria-label="Clear all polar matrix values"
                    onClick={() => onChange(createEmptyPolar())}
                    className="min-h-11 text-xs font-bold text-gray-300 uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
                >
                    Clear all
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
