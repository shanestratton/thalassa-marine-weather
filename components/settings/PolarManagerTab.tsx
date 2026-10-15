/**
 * PolarManagerTab — Tabbed interface for polar data input + Smart Polars.
 * Tab A: File Import (Expedition polars and TWA × TWS tables: .pol / .csv /
 *        .txt), with a preview, refusing a file routes cannot sail on (132-B22)
 * Tab B: Manual Matrix (editable spreadsheet)
 *
 * Polar edits and imports you can't lose (132-B22): an edit waiting out its
 * 1.5 s saves when the page closes or the app goes to the background, and the
 * save line says 'Saving…' while it waits; 'Clear all' and an import over a
 * polar with figures ask first.
 *
 * Also includes:
 * - One line at the top: which polar routes really sail (130-B6)
 * - Smart Polars state, with a link to its switch in Settings → Preferences
 *   (moved there, UX scorecard run 8; see SmartPolarsSetting)
 * - Your polar vs Smart for routing ('Factory' until build 131, 130-B6)
 * - Where the learner hears the boat from (services/smartPolarFeed)
 * - Smart Polars stats & filter gate status
 * - PolarChart with overlay
 *
 * Yacht database selection has moved to VesselTab (Settings → Vessel Profile).
 */
import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import type { PolarData, VesselProfile } from '../../types';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { PolarChart } from './PolarChart';
import {
    readPolarFile,
    validatePolarData,
    createEmptyPolar,
    PolarFileError,
    type PolarFileFormat,
} from '../../utils/polarParser';
import { whyRoutesCannotSail, yourPolarAsSailed } from '../../services/routingPolar';
import { SmartPolarService, type FilterStatus } from '../../services/SmartPolarService';
import { learnerFeedState, subscribeLearnerFeedState, type LearnerFeedState } from '../../services/smartPolarFeed';
import { SmartPolarStore } from '../../services/SmartPolarStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { OverlayPortal } from '../ui/OverlayPortal';
import { CheckIcon, CheckCircleIcon, AlertTriangleIcon, DownloadIcon, EditIcon, XIcon, MinusIcon } from '../Icons';
import { RowChevron } from './SettingsPrimitives';
import { Button } from '../ui/Button';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('PolarManagerTab');

/**
 * What a failed polar import says. The parser's own reasons (PolarFileError)
 * pass through; any other failure (the file could not be read) is logged and
 * said plainly, so raw error text never reaches the screen (UX scorecard run 9).
 */
function describePolarImportError(caught: unknown): string {
    const raw = caught instanceof Error ? caught.message : String(caught);
    if (caught instanceof PolarFileError) return raw.endsWith('.') ? raw : `${raw}.`;
    log.warn('Polar import failed:', raw);
    return 'This file could not be read as a polar. Choose a polar file (.pol, .csv or .txt) and try again.';
}

type InputTab = 'import' | 'manual';
type PolarKind = 'database' | 'file_import' | 'manual';

/** A table with a figure in it: what 'Clear all' or an import would lose. Same test PolarChart uses for its own empty state. */
const hasFigures = (data: PolarData | null | undefined) => data?.matrix.some((row) => row.some((v) => v > 0)) ?? false;

/** How long an edit waits before it saves: typing a figure is one save, not one per keystroke. */
const EDIT_SAVE_DELAY_MS = 1500;

/** One look for every link that leaves this page — underlined sky text and a
 *  trailing chevron — so a skipper can tell them from the bordered in-page
 *  button (three treatments before; UX scorecard run 9). */
const OFF_PAGE_LINK_CLASS = 'inline-flex items-center text-xs font-bold text-sky-300';

/** The page's one card heading: the neutral section-heading token in the
 *  caption ink, as every other card heading in the Boat Binder (CHANNELS,
 *  COMPATIBLE SOFTWARE, ENGINE). Sky blue made the headings read as links
 *  beside the page's real links (UX scorecard run 10). */
const CARD_HEADING_CLASS = 'ui-section-heading text-gray-400';

/** Stretches a 16 px line to a 44 px hit area without growing its row: the
 *  app's hit-target-44 ::before (44 px tall, centred), widened from a 44 px
 *  square to the link's full width. For links in a line of text or a card
 *  head, where a 44 px flow box pushed the layout apart. */
const HIT_AREA_44_CLASS = 'hit-target-44 before:w-[max(100%,44px)]!';

const OffPageLinkText: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <span className="inline-flex items-center gap-1">
        <span className="underline underline-offset-2">{children}</span>
        <RowChevron className="w-3.5 h-3.5 text-sky-300" />
    </span>
);

interface PolarManagerTabProps {
    settings?: {
        polarSource?: 'factory' | 'smart';
        nmeaHost?: string;
        nmeaPort?: number;
        smartPolarsEnabled?: boolean;
        polarData?: PolarData;
        polarBoatModel?: string;
        polarSource_type?: 'database' | 'file_import' | 'manual';
        /** Her cruising speed scales a yacht-database shape, as routes scale it. */
        vessel?: VesselProfile | null;
    };
    /** Which polar routes really sail: the routing resolver's words, as the passage banner prints them. */
    routesSailOn?: string;
    onSave?: (patch: Record<string, unknown>) => void;
    onNavigateToNmea?: () => void;
    /** Opens Settings so the skipper can pick a yacht under Vessel Profile. */
    onOpenVesselProfile?: () => void;
    /** Opens Settings → Preferences, where the Smart Polars switch lives. */
    onOpenPreferences?: () => void;
}

export const PolarManagerTab: React.FC<PolarManagerTabProps> = ({
    settings,
    routesSailOn,
    onSave,
    onNavigateToNmea,
    onOpenVesselProfile,
    onOpenPreferences,
}) => {
    const [activeTab, setActiveTab] = useState<InputTab>('import');
    const [polarData, setPolarData] = useState<PolarData>(settings?.polarData || createEmptyPolar());
    const [boatModel, setBoatModel] = useState(settings?.polarBoatModel || '');
    const [source, setSource] = useState<PolarKind>(settings?.polarSource_type || 'manual');
    // An edit waiting out EDIT_SAVE_DELAY_MS: the save line says 'Saving…'
    // until it is written (it read 'Saving…' for no time at all before).
    const [pending, setPending] = useState(false);
    // The time of this visit's last save; '' for a polar loaded as saved
    // (it read 'Saved Loaded from device').
    const [lastSaved, setLastSaved] = useState<string | null>(settings?.polarData ? '' : null);
    const [showAdvancedInput, setShowAdvancedInput] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    /** An import waiting for 'Replace polar': her polar has figures it would replace. */
    const [replaceWith, setReplaceWith] = useState<{ data: PolarData; name: string } | null>(null);

    // Smart Polars state
    const [smartPolarData, setSmartPolarData] = useState<PolarData | null>(null);
    const [feed, setFeed] = useState<LearnerFeedState>(learnerFeedState);
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
    /** The edit the timer will save; written now if she leaves first (132-B22). */
    const pendingRef = useRef<{ data: PolarData; model: string; src: PolarKind } | null>(null);
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const advancedDialogRef = useFocusTrap(showAdvancedInput, {
        initialFocusRef: advancedCloseRef,
        onEscape: () => setShowAdvancedInput(false),
    });

    const loadSmartPolarData = useCallback(async () => {
        const requestId = ++smartLoadRequestRef.current;
        try {
            // The live grid, never initialize(): this refreshes every 15 s, and a
            // reload from disk would drop the learner's samples not yet saved.
            await SmartPolarStore.ensureLoaded();
            if (!mountedRef.current || requestId !== smartLoadRequestRef.current) return;
            setSmartPolarData(SmartPolarStore.exportToPolarData());
            setSmartStats(SmartPolarStore.getStats());
        } catch {
            if (!mountedRef.current || requestId !== smartLoadRequestRef.current) return;
            setSmartPolarData(null);
            setSmartStats(null);
        }
    }, []);

    // Save the waiting edit, if there is one, to settings (persisted locally
    // via Capacitor Preferences). Called by the timer, by an import or a
    // cleared table, and when she leaves — closing the page used to clear the
    // timer and lose the edit (132-B22).
    const flushPending = useCallback(() => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const edit = pendingRef.current;
        pendingRef.current = null;
        if (mountedRef.current) setPending(false);
        if (!edit) return;
        onSaveRef.current?.({ polarData: edit.data, polarBoatModel: edit.model, polarSource_type: edit.src });
        if (mountedRef.current) setLastSaved(new Date().toLocaleTimeString());
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            smartLoadRequestRef.current += 1;
            // Leaving the page: Back, a tab, another screen.
            flushPending();
        };
    }, [flushPending]);

    // Leaving the app — the home screen, another app, the phone locking — saves
    // a waiting edit too: iOS may never run the page again to save it.
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') flushPending();
        };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', flushPending);
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pagehide', flushPending);
        };
    }, [flushPending]);

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

    // Subscribe to the learner's feed + Smart Polar status
    useEffect(() => {
        const unsub1 = subscribeLearnerFeedState(setFeed);
        const unsub2 = SmartPolarService.onStatusChange(setFilterStatus);
        setFeed(learnerFeedState());

        // Refresh smart polar data periodically
        const refreshInterval = setInterval(() => void loadSmartPolarData(), 15000);

        return () => {
            unsub1();
            unsub2();
            clearInterval(refreshInterval);
        };
    }, [loadSmartPolarData]);

    /** Show a changed polar, and save it after EDIT_SAVE_DELAY_MS — or now, with `now`. */
    const updatePolar = useCallback(
        (newData: PolarData, model: string, src: PolarKind, now = false) => {
            setPolarData(newData);
            setBoatModel(model);
            setSource(src);
            pendingRef.current = { data: newData, model, src };
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            if (now) {
                flushPending();
                return;
            }
            setPending(true);
            saveTimerRef.current = setTimeout(flushPending, EDIT_SAVE_DELAY_MS);
        },
        [flushPending],
    );

    /** An import, saved at once: it replaces the whole table. */
    const applyImport = (data: PolarData, name: string) => {
        updatePolar(data, name, 'file_import', true);
        setReplaceWith(null);
        setShowAdvancedInput(false);
    };

    // A polar with figures is asked about first: an import replaces every one.
    const requestImport = (data: PolarData, name: string) => {
        if (hasFigures(polarData)) setReplaceWith({ data, name });
        else applyImport(data, name);
    };

    const clearAll = () => {
        updatePolar(createEmptyPolar(), boatModel, 'manual', true);
        setShowClearConfirm(false);
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

    // The figures routes sail on (130-B6): a yacht-database shape scaled to
    // her cruising speed exactly as routes scale it, her own figures as
    // given. The chart and the table show these, and an edit saves them as
    // her own figures: editing the raw shape made every route ~45% slow.
    const vessel = settings?.vessel;
    const shown = useMemo(() => yourPolarAsSailed(polarData, source, vessel), [polarData, source, vessel]);

    const chartIsEmpty = !hasFigures(shown.polar) && !hasFigures(smartPolarData);

    return (
        // The page (PolarPage) already keeps clear of the tab bar; this added a
        // second 5.5 rem + safe area of empty scroll under the save line (132-B22).
        <div className="w-full max-w-2xl mx-auto flex flex-col h-full overflow-y-auto pb-4 animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Which polar routes really sail (130-B6), in the resolver's own
                words — the passage banner's, the HUD's and Plan Your Day's —
                so the skipper never has to guess which table counts. A long
                imported file name wraps rather than running off. */}
            {routesSailOn && (
                <p
                    className="shrink-0 mb-3 px-1 text-sm leading-snug text-gray-300 [overflow-wrap:anywhere]"
                    data-testid="polars-routes-sail-on"
                >
                    <span className="font-bold text-white">Routes sail on:</span> {routesSailOn}
                </p>
            )}

            {/* ═══════════════════════════════════════════ */}
            {/* SMART POLARS SECTION */}
            {/* ═══════════════════════════════════════════ */}
            <div className="shrink-0">
                <SmartPolarsCard
                    smartEnabled={smartEnabled}
                    polarSource={polarSource}
                    feed={feed}
                    filterStatus={filterStatus}
                    smartStats={smartStats}
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
                    <h2 className={CARD_HEADING_CLASS}>Polar diagram</h2>
                    {boatModel ? (
                        <span className="text-base font-black text-white">{boatModel}</span>
                    ) : (
                        <>
                            <p className="text-sm text-gray-400">No boat design chosen</p>
                            {/* The secondary-button look, like Enter polar figures
                                under it: a button in the card head, not a fourth
                                underlined link (UX scorecard run 10). It opens
                                Settings at Vessel profile, where the yacht
                                database is (PolarPage, 132-B22: it opened the
                                Settings menu); one line at 375 pt. */}
                            {onOpenVesselProfile ? (
                                <Button variant="secondary" onClick={onOpenVesselProfile} className="mt-2 text-white">
                                    <span>Choose one in Settings</span>
                                </Button>
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
                        <PolarChart data={shown.polar} overlayData={smartPolarData} emptyLabel="No polar yet" />
                    </div>
                )}

                {/* Save status: 'Saving…' while an edit waits to be written —
                    it is written then, or as she leaves (132-B22). */}
                <div
                    className="flex items-center justify-center gap-2 mt-3"
                    role="status"
                    data-testid="polar-save-state"
                >
                    {pending && (
                        <span className="flex items-center gap-1.5 text-xs text-sky-300">
                            <span
                                aria-hidden="true"
                                className="w-3 h-3 border border-sky-400 border-t-transparent rounded-full animate-spin"
                            />
                            Saving…
                        </span>
                    )}
                    {lastSaved !== null && !pending && (
                        <span className="text-xs text-emerald-400 inline-flex items-center gap-1">
                            <CheckIcon className="w-3 h-3" />
                            <span>{lastSaved ? `Saved ${lastSaved}` : 'Saved'}</span>
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

                            {activeTab === 'import' && <ImportTab onImport={requestImport} />}
                            {activeTab === 'manual' && (
                                <ManualTab
                                    polarData={shown.polar}
                                    scaledToKts={shown.scaledToKts}
                                    onChange={(data) => updatePolar(data, boatModel, 'manual')}
                                    onClearAll={() => setShowClearConfirm(true)}
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

            {/* 'Clear all' and an import over her figures ask first (132-B22):
                one tap emptied the table, and an import replaced it, with no
                way back. They open over the figures dialog, which stays. */}
            <ConfirmDialog
                isOpen={showClearConfirm}
                title="Clear every figure?"
                message="Your polar table will be emptied. Until you enter new figures, routes use the generic cruising polar. This can't be undone."
                confirmLabel="Clear all"
                cancelLabel="Keep figures"
                destructive
                onConfirm={clearAll}
                onCancel={() => setShowClearConfirm(false)}
            />
            <ConfirmDialog
                isOpen={replaceWith !== null}
                title="Replace your polar?"
                message={`${boatModel ? `Your polar (${boatModel})` : 'Your polar figures'} will be replaced by the figures from ${replaceWith?.name ?? 'this file'}. This can't be undone.`}
                confirmLabel="Replace polar"
                cancelLabel="Keep mine"
                destructive
                onConfirm={() => {
                    if (replaceWith) applyImport(replaceWith.data, replaceWith.name);
                }}
                onCancel={() => setReplaceWith(null)}
            />
        </div>
    );
};

// ═══════════════════════════════════════════
// SMART POLARS CARD
// ═══════════════════════════════════════════

/**
 * Where the learner hears the boat from (build 126, 126-B6a). Not this phone's
 * socket: that never opens on a Pi boat, and read "NMEA: Disconnected" there
 * while the Pi fed every instrument.
 */
const FEED_WORDS: Record<LearnerFeedState, { color: string; label: string }> = {
    pi: { color: 'bg-emerald-400', label: 'Instruments: via the Pi' },
    gateway: { color: 'bg-emerald-400', label: 'Instruments: via the NMEA gateway' },
    // By lane, not by place: a lane says nothing about where the phone is.
    cloud: {
        color: 'bg-amber-400',
        label: 'Seen through the cloud only: learning needs a direct link to the Pi or the gateway',
    },
    quiet: { color: 'bg-gray-500', label: 'The Pi is on; her instruments are quiet' },
    none: { color: 'bg-gray-500', label: 'Not reaching the boat' },
};

const SmartPolarsCard: React.FC<{
    smartEnabled: boolean;
    polarSource: 'factory' | 'smart';
    feed: LearnerFeedState;
    filterStatus: FilterStatus | null;
    smartStats: { totalSamples: number; filledBuckets: number; totalBuckets: number } | null;
    onOpenPreferences?: () => void;
    onToggleSource: (src: 'factory' | 'smart') => void;
    onReset: () => void;
    onNavigateToNmea?: () => void;
}> = ({
    smartEnabled,
    polarSource,
    feed,
    filterStatus,
    smartStats,
    onOpenPreferences,
    onToggleSource,
    onReset,
    onNavigateToNmea,
}) => {
    const status = FEED_WORDS[feed];
    // The Pi or a gateway: something to learn from.
    const reaching = feed === 'pi' || feed === 'gateway';
    const fillPercent = smartStats ? Math.round((smartStats.filledBuckets / smartStats.totalBuckets) * 100) : 0;

    return (
        <div
            className={`rounded-2xl p-4 transition-all ${
                !reaching
                    ? // Dim the chrome only: opacity-70 on the card put its daylight
                      // text at 3.45–4.3:1 (UX scorecard run 6).
                      'bg-white/2 border border-white/6'
                    : 'bg-linear-to-br from-emerald-500/5 to-sky-500/5 border border-emerald-500/20'
            }`}
        >
            {/* gap-x-3 + wrap: at 375 pt the heading ran into its caption
                ('SMART POLARSNeeds NMEA gateway'). One card-heading style with
                the Polar diagram card below (UX scorecard run 7). A 4 px row
                gap keeps a wrapped status line tight under the heading (UX
                scorecard run 9). */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-4">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className={CARD_HEADING_CLASS}>Smart Polars</h2>
                    {/* Neither RPM nor alternator voltage reaches the learner. */}
                    {smartEnabled && filterStatus?.engineOff === 'unavailable' && (
                        <span className="text-xs text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-lg font-bold inline-flex items-center gap-1">
                            <AlertTriangleIcon className="w-3 h-3" />
                            <span>No engine data: the engine-off check is skipped</span>
                        </span>
                    )}
                </div>
                {/* The switch lives in Settings → Preferences, the home for
                    switches (UX scorecard run 8). Here, its state and the way
                    there, in one line. The ::before stretches the 16 px line to
                    a 44 px hit area without growing the row, so this heading
                    sits as high in its card as Polar diagram does in the next
                    (a 44 px flow box pushed it 14 pt lower; UX scorecard run 9).
                    Named as a sentence: 'Off Change in Preferences' had no
                    subject. */}
                {onOpenPreferences ? (
                    <button
                        type="button"
                        onClick={onOpenPreferences}
                        aria-label={`Smart Polars is ${smartEnabled ? 'on' : 'off'}. Change in Preferences`}
                        className={`${OFF_PAGE_LINK_CLASS} ${HIT_AREA_44_CLASS} gap-1.5`}
                    >
                        <span className={smartEnabled ? 'text-emerald-400' : 'text-gray-300'}>
                            {smartEnabled ? 'On' : 'Off'}
                        </span>
                        <span aria-hidden="true" className="text-gray-400">
                            ·
                        </span>
                        <OffPageLinkText>Change in Preferences</OffPageLinkText>
                    </button>
                ) : (
                    <span className={`text-xs font-bold ${smartEnabled ? 'text-emerald-400' : 'text-gray-300'}`}>
                        {smartEnabled ? 'On' : 'Off'} · change it in Settings → Preferences
                    </span>
                )}
            </div>

            {/* Explanation when disabled */}
            {!smartEnabled && (
                <div className="mb-3 px-3 py-2.5 bg-black/20 rounded-xl border border-white/5">
                    {/* Emphasis in white, not link blue: only the real link below
                        is blue (UX scorecard run 7). */}
                    <p className="text-xs text-gray-400 leading-relaxed">
                        Smart Polars learns your boat's <span className="text-white font-bold">real speeds</span> from
                        her instruments (the Pi or an NMEA gateway).
                    </p>
                    <p className="text-xs text-gray-400 mt-2">
                        {reaching ? (
                            <>
                                <span className="text-emerald-400 inline-flex items-center gap-1">
                                    <CheckCircleIcon className="w-3 h-3" />
                                    <span>{status.label}</span>
                                </span>{' '}
                                — turn it on in Preferences.
                            </>
                        ) : (
                            <>
                                {/* Amber on the glyph only: amber text measured under AA
                                    on this box in daylight (UX scorecard run 6). */}
                                <span className="text-gray-200 font-bold inline-flex items-center gap-1">
                                    <AlertTriangleIcon className="w-3 h-3 text-amber-400" />
                                    <span>{status.label}</span>
                                </span>
                                {/* The page's one off-page link look; its hit area
                                    reaches past the line instead of a 44 px box
                                    that doubled the line's height. Through the
                                    cloud, or a Pi with her instruments quiet,
                                    there is nothing to set up. */}
                                {feed === 'none' && onNavigateToNmea && (
                                    <>
                                        {' '}
                                        —{' '}
                                        <button
                                            type="button"
                                            onClick={onNavigateToNmea}
                                            className={`${OFF_PAGE_LINK_CLASS} ${HIT_AREA_44_CLASS}`}
                                        >
                                            <OffPageLinkText>Set up instruments</OffPageLinkText>
                                        </button>
                                    </>
                                )}
                            </>
                        )}
                    </p>
                </div>
            )}

            {smartEnabled && (
                <>
                    {/* Where the instruments come from: a sentence, so sentence case. */}
                    <div className="flex items-center gap-2 mb-3 p-2 bg-black/20 rounded-xl">
                        <div className={`w-2 h-2 shrink-0 rounded-full ${status.color}`} />
                        <span className="text-xs font-bold text-gray-300">{status.label}</span>
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
                        {/* Named from the visible word, with which one is in use.
                            'Your polar', not 'Factory' (130-B6): it is the polar
                            the skipper chose — from the yacht database,
                            imported or typed in — not a factory's. */}
                        <button
                            type="button"
                            aria-label="Your polar for routing"
                            aria-pressed={polarSource === 'factory'}
                            onClick={() => onToggleSource('factory')}
                            className={`flex-1 min-h-11 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg transition-all ${polarSource === 'factory' ? 'bg-sky-600 text-white' : 'text-gray-400'}`}
                        >
                            Your polar
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

const kn = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * The import preview's words (132-B22): what the file was read as, its size,
 * and her best figure in it — a number a skipper can check against what she
 * knows of the boat before it replaces her polar.
 */
function previewWords(polar: PolarData, format: PolarFileFormat): { read: string; size: string; fastest: string } {
    const { windSpeeds: ws, angles } = polar;
    let best = { v: 0, twa: 0, tws: 0 };
    polar.matrix.forEach((row, a) =>
        row.forEach((v, w) => {
            if (v > best.v) best = { v, twa: angles[a], tws: ws[w] };
        }),
    );
    return {
        read: format === 'expedition' ? 'Read as an Expedition polar' : 'Read as a TWA × TWS table',
        size: `${ws.length} wind speeds (${ws[0]}–${ws[ws.length - 1]} kn) × ${angles.length} angles (${angles[0]}–${angles[angles.length - 1]}°)`,
        fastest: `Fastest: ${kn(best.v)} kn at ${best.twa}° in ${best.tws} kn of wind`,
    };
}

interface ImportPreview {
    polar: PolarData;
    format: PolarFileFormat;
    fileName: string;
    /** What the polar is called once imported: the file name without its extension. */
    name: string;
    warnings: string[];
}

const ImportTab: React.FC<{
    /** 'Use this polar': her page asks first if it would replace figures. */
    onImport: (data: PolarData, name: string) => void;
}> = ({ onImport }) => {
    const [dragOver, setDragOver] = useState(false);
    const [fileName, setFileName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Read, check, preview — nothing is saved until 'Use this polar' (132-B22:
    // a chosen file replaced her polar at once, unseen, and a file routes
    // could not sail on was saved, so every route sailed the generic polar).
    const handleFile = async (file: File) => {
        setError(null);
        setPreview(null);
        setFileName(file.name);
        try {
            const read = readPolarFile(await file.text());
            const why = whyRoutesCannotSail(read.polar);
            if (why) {
                setError(`Routes can't sail on this file: ${why}. Your polar has not changed.`);
                return;
            }
            setPreview({
                ...read,
                fileName: file.name,
                name: file.name.replace(/\.(pol|csv|txt)$/i, ''),
                warnings: validatePolarData(read.polar).warnings,
            });
        } catch (e) {
            setError(describePolarImportError(e));
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
        // Cleared, so choosing the same file again (fixed in another app) reads it again.
        e.target.value = '';
        if (file) handleFile(file);
    };

    const words = preview ? previewWords(preview.polar, preview.format) : null;

    return (
        <div className="bg-white/3 border border-white/6 rounded-2xl p-4">
            {/* The page's one card-heading style, not an amber bar here and an
                emerald one on Manual (UX scorecard run 7). */}
            <h3 className={`mb-4 ${CARD_HEADING_CLASS}`}>Import a polar file</h3>

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
                    {preview ? (
                        <CheckCircleIcon className="w-7 h-7 text-emerald-400" />
                    ) : (
                        <DownloadIcon className="w-7 h-7 text-sky-400/70" />
                    )}
                </div>
                <p className="text-sm font-bold text-white mb-1 [overflow-wrap:anywhere]">
                    {fileName ? fileName : 'Drop polar file here'}
                </p>
                {/* What it reads, by layout: a .pol is either (132-B22: it
                    said .pol was Expedition, and read every .pol as a table). */}
                <p className="text-xs text-gray-400">Reads Expedition polars and TWA × TWS tables (.pol, .csv, .txt)</p>
            </button>

            {error && (
                <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl" role="alert">
                    <p className="text-xs text-red-400 font-bold inline-flex items-center gap-1.5">
                        <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0" />
                        <span>{error}</span>
                    </p>
                </div>
            )}

            {preview && words && (
                <div
                    className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3"
                    data-testid="polar-import-preview"
                >
                    <p className="text-xs font-bold text-gray-300">{words.read}</p>
                    <p className="mt-1 text-xs text-gray-400">{words.size}</p>
                    <p className="text-xs text-gray-400">{words.fastest}</p>
                    <div className="mx-auto mt-3 aspect-square w-full max-w-[240px]">
                        <PolarChart data={preview.polar} />
                    </div>

                    {preview.warnings.length > 0 && (
                        <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                            <p className="text-xs text-amber-400 font-bold mb-1 inline-flex items-center gap-1.5">
                                <AlertTriangleIcon className="w-3.5 h-3.5" />
                                <span>Warnings:</span>
                            </p>
                            {preview.warnings.map((w, i) => (
                                <p key={i} className="text-xs text-amber-200">
                                    • {w}
                                </p>
                            ))}
                        </div>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                            variant="secondary"
                            onClick={() => fileInputRef.current?.click()}
                            className="flex-1 text-white"
                        >
                            Choose another file
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => onImport(preview.polar, preview.name)}
                            className="flex-1"
                        >
                            Use this polar
                        </Button>
                    </div>
                </div>
            )}

            <div className="mt-4 p-3 bg-white/2 rounded-xl">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Expected format</p>
                <p className="text-xs text-gray-400 mb-1">A table: wind speeds across, angles down</p>
                <pre className="text-xs text-gray-400 font-mono overflow-x-auto">
                    {`TWA    6    8    10   12   15   20   25
45   4.2  5.1  5.8  6.2  6.5  6.4  6.0
60   4.8  5.7  6.4  6.9  7.2  7.1  6.7
90   5.2  6.2  7.0  7.5  7.9  7.8  7.3`}
                </pre>
                <p className="text-xs text-gray-400 mt-3 mb-1">
                    Or Expedition: a wind speed, then angle and speed pairs
                </p>
                <pre className="text-xs text-gray-400 font-mono overflow-x-auto">
                    {`!Expedition polar
6    42  4.6  60  5.5  90  5.7  150  3.7
10   40  6.0  60  6.8  90  7.1  150  5.6`}
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
    /** The cruising speed a yacht-database shape is shown scaled to; null for her own figures. */
    scaledToKts: number | null;
    onChange: (data: PolarData) => void;
    /** 'Clear all': her page asks first (132-B22). */
    onClearAll: () => void;
}> = ({ polarData, scaledToKts, onChange, onClearAll }) => {
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
                <h3 className={CARD_HEADING_CLASS}>Type the figures</h3>
                <span className="text-xs text-gray-400">Boat speed in knots</span>
            </div>

            {/* What these figures are, and what an edit does (130-B6): one
                changed cell saves the whole table as her own figures. */}
            {scaledToKts !== null && (
                <p className="mb-4 text-xs leading-relaxed text-gray-400">
                    The yacht database figures, scaled to her cruising speed of {Math.round(scaledToKts * 10) / 10} kn:
                    the figures routes sail on. Change one and the whole table becomes your own figures, and stops
                    following her cruising speed.
                </p>
            )}

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
                                            {/* 0.01 kn: what a scaled database
                                                figure is shown to (130-B6). */}
                                            <input
                                                type="number"
                                                step="0.01"
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
                    onClick={onClearAll}
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
