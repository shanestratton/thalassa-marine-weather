/**
 * @filesize-justified Page orchestrator with shared state across list/detail/export views. Sub-views share 10+ state variables.
 */
/**
 * Log Page - Ship's GPS-based Log
 *
 * Pure rendering shell — all state management lives in useLogPageState hook.
 * This file is ONLY responsible for JSX layout.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../utils/createLogger';
import { triggerHaptic } from '../utils/system';

const log = createLogger('LogPage');
import { PlayIcon, StopIcon, MapPinIcon } from '../components/Icons';
import { AddEntryModal } from '../components/AddEntryModal';
import { useToast } from '../components/Toast';
import { SlideToAction } from '../components/ui/SlideToAction';
import { VoyageStatsPanel } from '../components/VoyageStatsPanel';
import { EditEntryModal } from '../components/EditEntryModal';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { LiveMiniMap } from '../components/LiveMiniMap';
import { DeleteVoyageModal } from '../components/DeleteVoyageModal';
import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';

import { UndoToast } from '../components/ui/UndoToast';
import { EmptyTrackRemovedModal } from '../components/ui/EmptyTrackRemovedModal';
import { GpsAcquiringOverlay } from '../components/ui/GpsAcquiringOverlay';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PageHeader } from '../components/ui/PageHeader';
import { useLogPageState } from '../hooks/useLogPageState';
import { useUI } from '../context/UIContext';
import { ShipLogEntry } from '../types';

import { reverseGeocode } from '../services/weatherService';
import { reverseGeocodeContext } from '../services/weather/api/geocoding';
import { computePersonalRecords, matchPlannedRouteByCoords } from '../services/shiplog/VoyageSummary';
import { evaluatePropulsionConflict } from '../services/shiplog/propulsion';
import { ShipLogService } from '../services/ShipLogService';
import { VoyageCard, StatBox, MenuBtn, FollowRouteChoice } from './log/LogSubComponents';
import { VoyageChoiceDialog, StopVoyageDialog } from './log/VoyageDialogs';
import { ExportSheet } from './log/ExportSheet';
import { GpsDisclaimerModal } from './log/GpsDisclaimerModal';
import { ImportSheet } from './log/ImportSheet';
import { ShareSheet } from './log/ShareSheet';
import { ShareFormSheet } from './log/ShareFormSheet';
import { StatsSheet } from './log/StatsSheet';
import { publishFollowedRoute } from '../services/shiplog/publishFollowedRoute';

// Inline icons not in Icons.tsx
const PlusIcon = ({ className }: { className?: string }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
);

const _AnchorIcon = ({ className }: { className?: string }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
);

export const LogPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
    // Navigation helper was used by the old Diary kebab item;
    // Diary now has its own tile in the Vessel-tab → Sharing section
    // (2026-05-17). The destructure stays as a `_` placeholder so
    // useUI() is still called — keeps the hook's effect/subscription
    // semantics if other code starts depending on it.

    const { setPage: _setPage } = useUI();
    const {
        state,
        dispatch,
        settings: _settings,
        // Tracking
        handleStartTracking,
        startTrackingWithNewVoyage,
        continueLastVoyage,

        // handleToggleRapidMode + handleTogglePrecisionMode no longer
        // destructured 2026-05-17 — both kebab menu items removed when
        // Precision Mode became the always-on tracking pipeline. The
        // hook still exposes them for future paywall gating.
        handleStopTracking,
        confirmStopVoyage,
        // Entry CRUD
        handleDeleteEntry,
        handleUndoDeleteEntry,
        handleDismissDeleteEntry,
        deletedEntry,
        handleEditEntry,
        handleSaveEdit,
        loadData,
        // Voyage management
        toggleVoyage,
        handleDeleteVoyageRequest,
        handleConfirmDeleteVoyage,
        deletedVoyage,
        handleUndoDeleteVoyage,
        handleDismissDeleteVoyage,
        showSharedVoyageWarning,
        confirmDeleteSharedVoyage,
        cancelDeleteSharedVoyage,
        // Export / share
        handleExportCSV: _handleExportCSV,
        handleShare,
        handleExportThenDelete,
        handleExportGPX,
        handleImportGPXFile,
        handleShareToCommunity,
        // Derived state
        filteredEntries,
        groupedEntries: _groupedEntries,
        entryCounts: _entryCounts,
        listVoyages,
        voyageStats,
        loadVoyageEntries,
        loadAllEntries,
        hasNonDeviceEntries,
        totalDistance: _totalDistance,
        avgSpeed: _avgSpeed,
        careerTotals,
        // Archive
        archivedVoyages,
        handleArchiveVoyage,
        handleUnarchiveVoyage,
        // Empty-track tidy announcement
        emptyPruneNotice,
        clearEmptyPruneNotice,
    } = useLogPageState();

    const toast = useToast();

    // ── Cast-off "Follow a route?" prompt (Shane 2026-07-17) ──
    // When a fresh voyage starts and the skipper has suggested routes saved,
    // ask which (if any) to broadcast on the public page. Publishing is tied
    // to the active voyage (setVoyagePlanLink); "Just recording" skips it.
    // One prompt per voyage — a ref so re-renders don't re-open it.
    const [followPromptVoyageId, setFollowPromptVoyageId] = React.useState<string | null>(null);
    const followPromptedRef = React.useRef<string | null>(null);
    const plannedSummaries = React.useMemo(
        () => (state.summaries ?? []).filter((s) => s.isPlannedRoute && s.voyageId),
        [state.summaries],
    );
    React.useEffect(() => {
        const vid = state.currentVoyageId;
        if (!state.isTracking || !vid) return;
        if (followPromptedRef.current === vid) return; // already asked this voyage
        if (plannedSummaries.length === 0) return; // nothing to follow
        followPromptedRef.current = vid;
        setFollowPromptVoyageId(vid);
    }, [state.isTracking, state.currentVoyageId, plannedSummaries.length]);
    const [showMenu, setShowMenu] = useState(false);
    const [showArchived, setShowArchived] = useState(false);

    // Stable identity for the TrackMapViewer prop — the old inline
    // .filter() minted a new array every render, defeating the viewer's
    // React.memo and forcing a full Leaflet layer rebuild on every
    // 1–5 s live-tracking poll tick.
    // Planned-vs-actual overlay: when a single sailed voyage is open, find
    // its planned route by start/end coords and overlay it (the viewer
    // already styles source==='planned_route' as a dashed purple plan
    // line and partitions per voyageId). Null when there's no plan.
    const matchedPlannedId = React.useMemo(() => {
        const summaries = state.summaries ?? [];
        if (!state.selectedVoyageId) return null;
        const sailed = summaries.find((s) => s.voyageId === state.selectedVoyageId);
        if (!sailed || sailed.isPlannedRoute) return null;
        return matchPlannedRouteByCoords(sailed, summaries);
    }, [state.selectedVoyageId, state.summaries]);

    const trackMapEntries = React.useMemo(() => {
        if (!state.selectedVoyageId) return state.entries;
        return state.entries.filter(
            (e) =>
                e.voyageId === state.selectedVoyageId || (matchedPlannedId != null && e.voyageId === matchedPlannedId),
        );
    }, [state.entries, state.selectedVoyageId, matchedPlannedId]);

    // Load the matched planned route's points when the track map opens so
    // they're resident for the overlay.
    useEffect(() => {
        if (state.showTrackMap && matchedPlannedId) void loadVoyageEntries(matchedPlannedId);
    }, [state.showTrackMap, matchedPlannedId, loadVoyageEntries]);

    // Career personal records — derived purely from voyage summaries.
    const records = React.useMemo(() => computePersonalRecords(state.summaries ?? []), [state.summaries]);

    // "Recording" vs "Acquiring GPS fix…" — keyed on whether the active
    // voyage has a real recorded position yet. gpsStatus alone can't be
    // trusted for this: an engine-start replay fix makes it read
    // 'locked' immediately while nothing trustworthy has been captured.
    const hasRecordedFix = React.useMemo(
        () =>
            !!state.currentVoyageId &&
            state.entries.some(
                (e) =>
                    e.voyageId === state.currentVoyageId &&
                    !!e.latitude &&
                    !!e.longitude &&
                    !(e.latitude === 0 && e.longitude === 0),
            ),
        [state.entries, state.currentVoyageId],
    );

    // Full-screen "Acquiring GPS fix…" takeover (Shane 2026-07-03: the tiny
    // header badge is invisible in sunlight — the first minutes of a track
    // silently don't record while the skipper thinks they do). Shows while
    // tracking with no trustworthy recorded fix; clears ITSELF on first fix;
    // manual dismiss drops back to the header badge for this voyage only.
    const [gpsOverlayDismissedFor, setGpsOverlayDismissedFor] = useState<string | null>(null);
    const gpsOverlayOpen =
        state.isTracking &&
        !hasRecordedFix &&
        !!state.currentVoyageId &&
        gpsOverlayDismissedFor !== state.currentVoyageId;

    // ── Departure prompts (share-live? / link-a-plan?) MOVED OUT ─────
    // These two "at departure" nudges now live in a global, always-mounted
    // <DeparturePrompts/> (App.tsx), driven by ShipLogService's tracking
    // listener. They used to be here, but the app mounts one view at a time
    // and a voyage is cast off from the helm — so LogPage wasn't mounted and
    // neither prompt ever fired (Shane 2026-07-05). See DeparturePrompts.tsx.

    // Engine on/off — user-declared while tracking, stamped onto track
    // points for the sail/motor split. Mirrors ShipLogService's sticky
    // state (undefined until first declared this voyage).
    const [engineRunning, setEngineRunningState] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        setEngineRunningState(state.isTracking ? ShipLogService.getEngineRunning() : undefined);
    }, [state.isTracking, state.currentVoyageId]);
    const toggleEngine = useCallback(async (running: boolean) => {
        await ShipLogService.setEngineRunning(running);
        setEngineRunningState(running);
        setNudgeDismiss(null); // resolving the toggle clears any nudge
        triggerHaptic('light');
    }, []);

    // ── Propulsion mismatch nudge ──
    // When the declared engine state and the live heuristic estimate
    // SUSTAINEDLY disagree, gently suggest flipping the toggle. Only fires
    // on a real, debounced conflict (see evaluatePropulsionConflict's
    // hysteresis), and a Dismiss snoozes it for 10 min for that state.
    const recentActiveEntries = React.useMemo(() => {
        if (!state.currentVoyageId) return [];
        const cutoff = Date.now() - 5 * 60 * 1000;
        return state.entries.filter((e) => e.voyageId === state.currentVoyageId && Date.parse(e.timestamp) >= cutoff);
    }, [state.entries, state.currentVoyageId]);

    const propConflict = React.useMemo(
        () => evaluatePropulsionConflict(recentActiveEntries, engineRunning),
        [recentActiveEntries, engineRunning],
    );

    const [nudgeDismiss, setNudgeDismiss] = useState<{ until: number; forDeclared: boolean | undefined } | null>(null);
    const showPropNudge =
        state.isTracking &&
        propConflict.conflict &&
        !(nudgeDismiss && nudgeDismiss.forDeclared === engineRunning && Date.now() < nudgeDismiss.until);

    // Live mini-map expansion — tap the little map to blow it up to a
    // fullscreen live view (stats stay overlaid), tap again to shrink.
    const [liveMapExpanded, setLiveMapExpanded] = useState(false);
    useEffect(() => {
        if (!state.isTracking) setLiveMapExpanded(false);
    }, [state.isTracking]);

    // GPS Disclaimer modal state
    const [showGpsDisclaimer, setShowGpsDisclaimer] = useState(false);
    const pendingStartRef = useRef<(() => void) | null>(null);

    const checkGpsDisclaimer = useCallback(async (onProceed: () => void) => {
        try {
            const { value } = await Preferences.get({ key: 'gps_disclaimer_dismissed' });
            if (value === 'true') {
                onProceed();
            } else {
                pendingStartRef.current = onProceed;
                setShowGpsDisclaimer(true);
            }
        } catch {
            onProceed(); // fail-open
        }
    }, []);

    const dismissGpsDisclaimer = useCallback(async (dontShowAgain: boolean) => {
        if (dontShowAgain) {
            await Preferences.set({ key: 'gps_disclaimer_dismissed', value: 'true' });
        }
        setShowGpsDisclaimer(false);
        if (pendingStartRef.current) {
            pendingStartRef.current();
            pendingStartRef.current = null;
        }
    }, []);

    // Share form auto-fill state
    const [shareAutoTitle, setShareAutoTitle] = useState('');
    const [shareAutoRegion, setShareAutoRegion] = useState('');
    const shareFormResetRef = useRef(0);

    // Share a self-contained summary-card PNG of the scoped voyage.
    const handleShareImage = useCallback(async () => {
        const scoped = state.selectedVoyageId
            ? state.entries.filter((e) => e.voyageId === state.selectedVoyageId)
            : state.entries;
        if (scoped.filter((e) => e.latitude && e.longitude).length < 2) {
            toast.error('Not enough track to make a card yet');
            return;
        }
        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
        try {
            const { shareVoyageCard } = await import('../services/shiplog/voyageShareCard');
            await shareVoyageCard(scoped, { title: shareAutoTitle || undefined });
        } catch (err) {
            if (err instanceof Error && err.name !== 'AbortError') {
                log.warn('share image failed:', err);
                toast.error('Could not create the image');
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.selectedVoyageId, state.entries, shareAutoTitle, toast]);

    // ── Listen for planned route save from Passage Planner ──
    useEffect(() => {
        const handlePlannedRoute = async (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail?.waypoints?.length || !detail?.departure || !detail?.arrival) return;

            try {
                const { waypoints, departure, arrival, departureTime, totalDistanceNM, totalDurationHours } = detail;
                const voyageId = `planned_${Date.now()}`;
                const depTime = new Date(departureTime).getTime();

                // Create log entries for each waypoint
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const entries: Partial<ShipLogEntry>[] = waypoints.map((wp: any, idx: number) => ({
                    voyageId,
                    timestamp: wp.eta || new Date(depTime + wp.timeHours * 3600_000).toISOString(),
                    latitude: wp.lat,
                    longitude: wp.lon,
                    entryType: idx === 0 ? 'manual' : 'waypoint',
                    source: 'planned_route',
                    waypointName: wp.id === 'DEP' ? departure.name : wp.id === 'ARR' ? arrival.name : wp.id,
                    notes:
                        wp.id === 'DEP'
                            ? `Departure: ${departure.name}`
                            : wp.id === 'ARR'
                              ? `Arrival: ${arrival.name} — ${totalDistanceNM?.toFixed(0)} NM, ${totalDurationHours?.toFixed(0)}h`
                              : `Course change: ${wp.bearingChange}° → ${wp.bearing}°`,
                    speedKts: wp.speed,
                    courseDeg: wp.bearing,
                    windSpeed: wp.tws,
                    distanceNM:
                        idx > 0 ? Math.round((wp.distanceNM - (waypoints[idx - 1]?.distanceNM || 0)) * 10) / 10 : 0,
                    cumulativeDistanceNM: wp.distanceNM,
                }));

                // Save to Supabase
                const { supabase } = await import('../services/supabase');
                if (!supabase) throw new Error('Supabase not initialised');
                for (const entry of entries) {
                    await supabase.from('ship_logs').insert(entry);
                }

                toast.success(`Planned route saved: ${departure.name} → ${arrival.name}`);
                loadData(); // Refresh the log page
            } catch (err) {
                log.error('Failed to save planned route:', err);
                toast.error('Failed to save planned route');
            }
        };

        window.addEventListener('thalassa:save-planned-route', handlePlannedRoute);
        return () => window.removeEventListener('thalassa:save-planned-route', handlePlannedRoute);
    }, [loadData, toast]);

    // Destructure frequently used state for JSX readability.
    // `isRapidMode` and `isPrecisionMode` no longer destructured here
    // 2026-05-17 — the UI toggles that consumed them were removed when
    // Precision became always-on. State remains in the reducer for
    // potential paywall-gating UI to read directly.
    const {
        entries,
        isTracking,
        loading,
        showAddModal,
        showTrackMap,
        showStats,
        showStopVoyageDialog,
        showVoyageChoiceDialog,
        showCommunityBrowser,
        actionSheet,
        editEntry,
        selectedVoyageId,
        deleteVoyageId,
        currentVoyageId,
        expandedVoyages,
        gpsStatus,
        filters: _filters,
    } = state;

    // Auto-fill share form when panel opens
    useEffect(() => {
        if (actionSheet !== 'share' && actionSheet !== 'share_form') {
            setShareAutoTitle('');
            setShareAutoRegion('');
            return;
        }

        const targetEntries = selectedVoyageId ? entries.filter((e) => e.voyageId === selectedVoyageId) : entries;

        if (targetEntries.length === 0) return;

        const sorted = [...targetEntries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const resetId = ++shareFormResetRef.current;

        // Reverse geocode start and end for title
        (async () => {
            try {
                const [startName, endName] = await Promise.all([
                    first.waypointName &&
                    first.waypointName !== 'Voyage Start' &&
                    first.waypointName !== 'Latest Position'
                        ? Promise.resolve(first.waypointName)
                        : reverseGeocode(first.latitude, first.longitude),
                    last.id !== first.id
                        ? last.waypointName &&
                          last.waypointName !== 'Voyage Start' &&
                          last.waypointName !== 'Latest Position'
                            ? Promise.resolve(last.waypointName)
                            : reverseGeocode(last.latitude, last.longitude)
                        : Promise.resolve(null),
                ]);
                if (resetId !== shareFormResetRef.current) return; // stale
                const title =
                    endName && endName !== startName ? `${startName || 'Unknown'} → ${endName}` : startName || '';
                setShareAutoTitle(title);
            } catch (e) {
                log.warn('fallback to empty:', e);
            }
        })();

        // Auto-detect region from start location
        // GeoContext.name is already "City, State, Country" — extract region by dropping city
        (async () => {
            try {
                const ctx = await reverseGeocodeContext(first.latitude, first.longitude);
                if (resetId !== shareFormResetRef.current) return; // stale
                if (ctx && ctx.name) {
                    const parts = ctx.name.split(',').map((p) => p.trim());
                    // Drop the city (first part) to get "State, Country"
                    const region = parts.length > 1 ? parts.slice(1).join(', ') : parts[0];
                    setShareAutoRegion(region);
                }
            } catch (e) {
                log.warn('fallback to empty:', e);
            }
        })();
    }, [actionSheet, selectedVoyageId, entries]);

    // No full-page spinner: the page shell + the Start control render
    // immediately (starting a track is network-free), and only the
    // voyage LIST shows a skeleton while history loads. The old
    // early-return here held the entire page — Start button included —
    // hostage to auth rehydrate + the Supabase summaries fetch.

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            {/* Fullscreen Statistics View */}
            {showStats ? (
                <div className="flex flex-col h-full">
                    <div className="flex items-center justify-between p-4 border-b border-white/10">
                        <h2 className="text-lg font-bold text-white">Voyage Statistics</h2>
                        <button
                            aria-label="Close statistics"
                            onClick={() => dispatch({ type: 'SHOW_STATS', show: false })}
                            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-auto p-4 md:p-8 flex flex-col justify-center md:max-w-3xl md:mx-auto">
                        {(() => {
                            // All-Voyages aggregate excludes suggested/
                            // planned routes (source='planned_route') so
                            // they don't inflate distance / speed / entry
                            // totals. A single selected voyage shows its
                            // own entries verbatim (the user explicitly
                            // drilled into it). 2026-05-20.
                            const scopedEntries = selectedVoyageId
                                ? filteredEntries.filter((e) => e.voyageId === selectedVoyageId)
                                : filteredEntries.filter((e) => e.source !== 'planned_route');

                            let scopedDistance = 0;
                            if (selectedVoyageId) {
                                // Single voyage: max cumulative distance
                                scopedDistance =
                                    scopedEntries.length > 0
                                        ? Math.max(...scopedEntries.map((e) => e.cumulativeDistanceNM || 0))
                                        : 0;
                            } else {
                                // All voyages: sum each voyage's max cumulative distance
                                const voyageMap = new Map<string, number>();
                                scopedEntries.forEach((e) => {
                                    const vid = e.voyageId || 'default';
                                    const current = voyageMap.get(vid) || 0;
                                    voyageMap.set(vid, Math.max(current, e.cumulativeDistanceNM || 0));
                                });
                                voyageMap.forEach((d) => {
                                    scopedDistance += d;
                                });
                            }

                            const speedEntries = scopedEntries.filter((e) => e.speedKts && e.speedKts > 0);
                            const scopedAvgSpeed =
                                speedEntries.length > 0
                                    ? speedEntries.reduce((sum, e) => sum + (e.speedKts || 0), 0) / speedEntries.length
                                    : 0;
                            return (
                                <div className="grid grid-cols-3 gap-3 mb-4">
                                    <StatBox label="Distance" value={`${(scopedDistance ?? 0).toFixed(1)} NM`} />
                                    <StatBox label="Avg Speed" value={`${(scopedAvgSpeed ?? 0).toFixed(1)} kts`} />
                                    <StatBox label="Entries" value={scopedEntries.length} />
                                </div>
                            );
                        })()}
                        <VoyageStatsPanel
                            entries={
                                selectedVoyageId
                                    ? filteredEntries.filter((e) => e.voyageId === selectedVoyageId)
                                    : filteredEntries
                            }
                        />
                    </div>
                </div>
            ) : (
                <div className="flex flex-col h-full">
                    {/* ── Header ── */}
                    <PageHeader
                        title="Ship's Log"
                        subtitle={
                            isTracking ? (
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <span
                                        className={`w-1.5 h-1.5 rounded-full ${
                                            gpsStatus === 'locked'
                                                ? 'bg-emerald-400 animate-pulse'
                                                : gpsStatus === 'stale'
                                                  ? 'bg-amber-400 animate-pulse'
                                                  : 'bg-red-500 animate-pulse'
                                        }`}
                                    />
                                    <span
                                        className={`text-[10px] font-bold uppercase tracking-widest ${
                                            gpsStatus === 'locked'
                                                ? 'text-emerald-400/80'
                                                : gpsStatus === 'stale'
                                                  ? 'text-amber-300/80'
                                                  : 'text-red-400/80'
                                        }`}
                                    >
                                        {gpsStatus === 'locked' && hasRecordedFix ? 'Recording' : 'Acquiring GPS fix…'}
                                    </span>
                                </div>
                            ) : (
                                'GPS Voyage Recorder'
                            )
                        }
                        onBack={onBack}
                        action={
                            <div className="relative">
                                <button
                                    aria-label="Open menu"
                                    onClick={() => setShowMenu(!showMenu)}
                                    className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                        <circle cx="10" cy="4" r="1.5" />
                                        <circle cx="10" cy="10" r="1.5" />
                                        <circle cx="10" cy="16" r="1.5" />
                                    </svg>
                                </button>
                                {/* Overflow Menu */}
                                {showMenu && (
                                    <>
                                        <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                                        <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-slate-800 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                                            {/* Rapid Mode + Precision Mode toggles were removed
                                                from this menu 2026-05-17. Precision Mode is now
                                                always-on whenever tracking is active (the
                                                canonical "hi-fi 2 Hz + live decimation" pipeline),
                                                so the toggle was just visual noise. Rapid Mode is
                                                preserved in the service for potential future
                                                paywall gating but no longer surfaced in the UI —
                                                "having two tracking modes, one of which works"
                                                was the wrong story. The handler hooks
                                                (handleToggleRapidMode, handleTogglePrecisionMode)
                                                stay in the hook in case we re-expose them as a
                                                Skipper-tier gate. */}
                                            {/* Diary kebab item REMOVED 2026-05-17 — Diary now
                                                has its own prominent full-card tile in the new
                                                Vessel-tab → Sharing section (paired with
                                                Scuttlebutt). The kebab was the right rescue
                                                home when Diary was otherwise orphaned, but for
                                                the "share your voyage" conversion story it
                                                deserves real presence, not menu-burial. */}
                                            <MenuBtn
                                                icon="📊"
                                                label="Statistics"
                                                onClick={() => {
                                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'stats' });
                                                    setShowMenu(false);
                                                }}
                                                disabled={entries.length === 0}
                                            />
                                            <MenuBtn
                                                icon="🗺"
                                                label="Track Map"
                                                onClick={() => {
                                                    dispatch({ type: 'SHOW_TRACK_MAP', show: true });
                                                    setShowMenu(false);
                                                }}
                                                disabled={entries.length === 0}
                                            />
                                            <MenuBtn
                                                icon="📤"
                                                label="Export"
                                                onClick={() => {
                                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'export' });
                                                    setShowMenu(false);
                                                }}
                                                disabled={entries.length === 0}
                                            />
                                            <MenuBtn
                                                icon="📥"
                                                label="Import"
                                                onClick={() => {
                                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'import' });
                                                    setShowMenu(false);
                                                }}
                                            />
                                            <MenuBtn
                                                icon="🔗"
                                                label="Share"
                                                onClick={() => {
                                                    dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share' });
                                                    setShowMenu(false);
                                                }}
                                                disabled={entries.length === 0}
                                            />
                                        </div>
                                    </>
                                )}
                            </div>
                        }
                    />

                    {/* ── Voyage Totals — three hero gauge tiles ──
                        Polished 2026-05-17 — gradient backdrops per
                        accent colour, icon glyph in the upper-right
                        corner of each, larger metric + inline unit
                        suffix, brighter labels. Stats use
                        `sailedVoyageGroups` — the SAILED subset of the
                        cards below, with suggested/planned routes excluded
                        (2026-05-20) so aspirational routes don't inflate
                        the distance / time / voyage totals. */}
                    {(() => {
                        // Aggregated server-side from voyage SUMMARIES (accurate
                        // across the whole history, no points loaded). voyageStats
                        // already excludes suggested/planned routes.
                        const totalNmRaw = voyageStats.totalNm;
                        const totalMs = voyageStats.totalMs;
                        const totalHrs = Math.round((totalMs / (1000 * 60 * 60)) * 10) / 10;
                        const atSeaValue = totalHrs < 24 ? totalHrs.toString() : Math.round(totalHrs / 24).toString();
                        const atSeaUnit = totalHrs < 24 ? 'hrs' : 'days';
                        return (
                            <div className="shrink-0 px-4 pb-3">
                                <div className="grid grid-cols-3 gap-2.5">
                                    {/* ── NM Sailed ── */}
                                    <div className="relative rounded-2xl overflow-hidden border border-sky-500/15 bg-gradient-to-br from-sky-500/[0.10] via-sky-500/[0.04] to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(56,189,248,0.15)]">
                                        {/* Soft top-edge highlight */}
                                        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-sky-400/40 to-transparent" />
                                        {/* Compass-needle icon, top-right */}
                                        <svg
                                            className="absolute top-2.5 right-2.5 w-4 h-4 text-sky-400/40"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.8}
                                            aria-hidden="true"
                                        >
                                            <circle cx="12" cy="12" r="9" />
                                            <path
                                                d="M14.5 9.5L11 13l-1.5-1.5L13 8z"
                                                fill="currentColor"
                                                stroke="none"
                                            />
                                            <path
                                                d="M9.5 14.5L13 11l1.5 1.5L11 16z"
                                                fill="currentColor"
                                                stroke="none"
                                                opacity="0.4"
                                            />
                                        </svg>
                                        <div className="text-[10px] font-bold text-sky-300/70 uppercase tracking-widest mb-2">
                                            Distance
                                        </div>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-2xl font-black text-white tabular-nums leading-none">
                                                {totalNmRaw.toFixed(1)}
                                            </span>
                                            <span className="text-[11px] font-bold text-sky-300/60 uppercase tracking-wider">
                                                nm
                                            </span>
                                        </div>
                                    </div>
                                    {/* ── At Sea ── */}
                                    <div className="relative rounded-2xl overflow-hidden border border-emerald-500/15 bg-gradient-to-br from-emerald-500/[0.10] via-emerald-500/[0.04] to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(16,185,129,0.15)]">
                                        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
                                        {/* Clock-like circle-with-tick icon */}
                                        <svg
                                            className="absolute top-2.5 right-2.5 w-4 h-4 text-emerald-400/40"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.8}
                                            aria-hidden="true"
                                        >
                                            <circle cx="12" cy="12" r="9" />
                                            <path d="M12 7v5l3 2" strokeLinecap="round" />
                                        </svg>
                                        <div className="text-[10px] font-bold text-emerald-300/70 uppercase tracking-widest mb-2">
                                            Time at Sea
                                        </div>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-2xl font-black text-white tabular-nums leading-none">
                                                {atSeaValue}
                                            </span>
                                            <span className="text-[11px] font-bold text-emerald-300/60 uppercase tracking-wider">
                                                {atSeaUnit}
                                            </span>
                                        </div>
                                    </div>
                                    {/* ── Voyages ── */}
                                    <div className="relative rounded-2xl overflow-hidden border border-amber-500/15 bg-gradient-to-br from-amber-500/[0.10] via-amber-500/[0.04] to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(245,158,11,0.15)]">
                                        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-amber-400/40 to-transparent" />
                                        {/* Anchor icon */}
                                        <svg
                                            className="absolute top-2.5 right-2.5 w-4 h-4 text-amber-400/40"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.8}
                                            aria-hidden="true"
                                        >
                                            <circle cx="12" cy="5" r="2" />
                                            <path d="M12 7v13" strokeLinecap="round" />
                                            <path d="M8 11h8" strokeLinecap="round" />
                                            <path d="M5 15a7 7 0 0014 0" strokeLinecap="round" />
                                        </svg>
                                        <div className="text-[10px] font-bold text-amber-300/70 uppercase tracking-widest mb-2">
                                            Voyages
                                        </div>
                                        <div className="flex items-baseline gap-1">
                                            <span className="text-2xl font-black text-white tabular-nums leading-none">
                                                {voyageStats.voyageCount}
                                            </span>
                                            <span className="text-[11px] font-bold text-amber-300/60 uppercase tracking-wider">
                                                {voyageStats.voyageCount === 1 ? 'log' : 'logs'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* ── Personal records strip — career bests from summaries.
                        Shown in the list view (not while the live card fills
                        the screen), only once there's qualifying history. */}
                    {!isTracking && records.voyageCount >= 2 && (
                        <div className="px-4 mb-2">
                            <div className="grid grid-cols-3 gap-2">
                                {[
                                    {
                                        label: 'Longest',
                                        value: `${records.longestPassageNM.toFixed(0)}`,
                                        unit: 'NM',
                                        icon: '🛣️',
                                    },
                                    {
                                        label: 'Fastest avg',
                                        value: `${records.fastestAvgKts.toFixed(1)}`,
                                        unit: 'kt',
                                        icon: '⚡',
                                    },
                                    {
                                        label: 'Longest trip',
                                        value: (() => {
                                            const h = records.longestDurationMs / 3600000;
                                            return h >= 24 ? `${Math.floor(h / 24)}d` : `${Math.round(h)}h`;
                                        })(),
                                        unit: '',
                                        icon: '⏱️',
                                    },
                                ].map((r) => (
                                    <div
                                        key={r.label}
                                        className="rounded-xl bg-slate-900/40 border border-amber-500/15 px-2 py-2 text-center"
                                    >
                                        <div className="text-[9px] uppercase tracking-wider text-amber-400/70 font-bold flex items-center justify-center gap-1">
                                            <span>{r.icon}</span>
                                            {r.label}
                                        </div>
                                        <div className="text-lg font-extrabold text-white tabular-nums mt-0.5">
                                            {r.value}
                                            {r.unit && (
                                                <span className="text-[10px] text-white/40 ml-0.5">{r.unit}</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {isTracking ? (
                        <>
                            {/* ── TRACKING MODE: Live card fills entire space ── */}
                            {currentVoyageId &&
                                (() => {
                                    const activeEntries = entries.filter((e) => e.voyageId === currentVoyageId);
                                    const dist =
                                        activeEntries.length > 0
                                            ? Math.max(0, ...activeEntries.map((e) => e.cumulativeDistanceNM || 0))
                                            : 0;
                                    const sorted = [...activeEntries].sort(
                                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                                    );
                                    const first = sorted[0];
                                    const last = sorted[sorted.length - 1];
                                    const durationMs =
                                        first && last
                                            ? new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()
                                            : 0;
                                    const durationHrs = Math.floor(durationMs / 3600000);
                                    const durationMins = Math.floor((durationMs % 3600000) / 60000);
                                    const speeds = activeEntries.filter((e) => e.speedKts && e.speedKts > 0);
                                    const liveAvgSpeed =
                                        speeds.length > 0
                                            ? speeds.reduce((s, e) => s + (e.speedKts || 0), 0) / speeds.length
                                            : 0;
                                    return (
                                        <div className="flex-1 min-h-0 flex flex-col rounded-2xl bg-gradient-to-br from-emerald-500/10 to-slate-900/80 border border-emerald-500/20 p-4 mx-4 mt-2 mb-2">
                                            <div className="flex items-center gap-2 mb-3 shrink-0">
                                                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                                <span className="text-xs font-bold text-red-400 uppercase tracking-wider">
                                                    Live Recording
                                                </span>
                                            </div>
                                            {first?.waypointName &&
                                                first.waypointName !== 'Voyage Start' &&
                                                first.waypointName !== 'Latest Position' && (
                                                    <div className="text-xs text-slate-400 mb-3 shrink-0">
                                                        Departed: {first.waypointName}
                                                    </div>
                                                )}
                                            <div className="grid grid-cols-3 gap-3 shrink-0">
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                                                        {(dist ?? 0).toFixed(1)}
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">NM</div>
                                                </div>
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                                                        {durationHrs}h {durationMins}m
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">Duration</div>
                                                </div>
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                                                        {(liveAvgSpeed ?? 0).toFixed(1)}
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">Avg kts</div>
                                                </div>
                                            </div>

                                            {/* Engine on/off — declares propulsion so the
                                                voyage's sail/motor split is real data. */}
                                            <div className="flex items-center gap-2 mt-3 shrink-0">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                                    Engine
                                                </span>
                                                <div className="flex rounded-full bg-slate-900/60 border border-white/10 p-0.5">
                                                    <button
                                                        onClick={() => toggleEngine(true)}
                                                        className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${
                                                            engineRunning === true
                                                                ? 'bg-amber-500 text-white'
                                                                : 'text-white/55'
                                                        }`}
                                                    >
                                                        Motor
                                                    </button>
                                                    <button
                                                        onClick={() => toggleEngine(false)}
                                                        className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${
                                                            engineRunning === false
                                                                ? 'bg-emerald-500 text-white'
                                                                : 'text-white/55'
                                                        }`}
                                                    >
                                                        Sailing
                                                    </button>
                                                </div>
                                                {engineRunning === undefined && (
                                                    <span className="text-[10px] text-white/35">— tap to log</span>
                                                )}
                                            </div>

                                            {/* Live Mini Map — grows to fill all remaining space.
                                                Tap to expand fullscreen. Until the first accepted
                                                fix lands there's nothing to draw, so say what's
                                                happening instead of showing a silent empty map.
                                                UNMOUNTED while any fullscreen map is open — iOS
                                                WebKit composites Leaflet's transformed layers above
                                                fixed overlays regardless of z-index, so a live map
                                                redrawing underneath bled through as a second track. */}
                                            <div className="mt-3 flex-1 min-h-[100px] relative">
                                                {!liveMapExpanded && !showTrackMap && (
                                                    <LiveMiniMap
                                                        entries={activeEntries}
                                                        height="100%"
                                                        isLive={true}
                                                        onTap={() => setLiveMapExpanded(true)}
                                                    />
                                                )}
                                                {!hasRecordedFix && (
                                                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-slate-950/60 backdrop-blur-[2px] pointer-events-none">
                                                        <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                                                        <span className="text-[11px] font-bold text-amber-300/90 uppercase tracking-widest">
                                                            Acquiring GPS fix…
                                                        </span>
                                                        <span className="text-[10px] text-white/40">
                                                            Recording starts at the first clean fix
                                                        </span>
                                                    </div>
                                                )}
                                            </div>

                                            {/* ── Fullscreen live map — tap map (or chevron) to shrink ──
                                                transform-gpu promotes the overlay to its own composited
                                                layer so iOS can't paint underlying map tiles above it. */}
                                            {liveMapExpanded && (
                                                <div className="fixed inset-0 z-[9990] bg-slate-950 transform-gpu">
                                                    <LiveMiniMap
                                                        entries={activeEntries}
                                                        height="100%"
                                                        isLive={true}
                                                        freeZoom={true}
                                                        onTap={() => setLiveMapExpanded(false)}
                                                        className="!rounded-none !border-0"
                                                    />

                                                    {/* Top info bar — same stats as the card */}
                                                    <div
                                                        className="absolute top-0 left-0 right-0 z-[1001] px-4 pointer-events-none"
                                                        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
                                                    >
                                                        <div className="flex items-center gap-2">
                                                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                                            <span className="text-xs font-bold text-red-400 uppercase tracking-wider drop-shadow-lg">
                                                                Live Recording
                                                            </span>
                                                        </div>
                                                        <div className="text-[13px] text-white/90 flex gap-4 mt-1.5 font-bold drop-shadow-lg tabular-nums">
                                                            <span>{(dist ?? 0).toFixed(1)} NM</span>
                                                            <span>
                                                                {durationHrs}h {durationMins}m
                                                            </span>
                                                            <span>{(liveAvgSpeed ?? 0).toFixed(1)} avg kts</span>
                                                            <span>{activeEntries.length} pts</span>
                                                        </div>
                                                        <div className="text-[10px] text-white/40 mt-1 drop-shadow-lg">
                                                            Tap map to shrink
                                                        </div>
                                                    </div>

                                                    {/* Explicit collapse affordance */}
                                                    <button
                                                        aria-label="Shrink map"
                                                        onClick={() => setLiveMapExpanded(false)}
                                                        className="absolute right-4 z-[1001] w-10 h-10 rounded-full bg-slate-900/80 border border-white/10 text-white/80 flex items-center justify-center active:scale-95 transition-transform"
                                                        style={{ top: 'max(16px, env(safe-area-inset-top))' }}
                                                    >
                                                        <svg
                                                            className="w-5 h-5"
                                                            fill="none"
                                                            viewBox="0 0 24 24"
                                                            stroke="currentColor"
                                                        >
                                                            <path
                                                                strokeLinecap="round"
                                                                strokeLinejoin="round"
                                                                strokeWidth={2}
                                                                d="M9 9L4 4m0 0v4m0-4h4m7 5l5-5m0 0v4m0-4h-4M9 15l-5 5m0 0v-4m0 4h4m7-5l5 5m0 0v-4m0 4h-4"
                                                            />
                                                        </svg>
                                                    </button>

                                                    {!hasRecordedFix && (
                                                        <div className="absolute inset-0 z-[1000] flex flex-col items-center justify-center gap-2 bg-slate-950/60 backdrop-blur-[2px] pointer-events-none">
                                                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                                                            <span className="text-[11px] font-bold text-amber-300/90 uppercase tracking-widest">
                                                                Acquiring GPS fix…
                                                            </span>
                                                            <span className="text-[10px] text-white/40">
                                                                Recording starts at the first clean fix
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })()}

                            {/* ── Stop / New Entry — pinned at bottom ── */}
                            <div
                                className="shrink-0 px-4 pt-2"
                                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                            >
                                <div className="flex gap-2">
                                    <button
                                        aria-label="Stop tracking"
                                        onClick={() => {
                                            triggerHaptic('medium');
                                            handleStopTracking();
                                        }}
                                        className="flex-1 h-14 rounded-2xl font-extrabold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 active:scale-[0.97]"
                                    >
                                        <StopIcon className="w-4 h-4" />
                                        Stop
                                    </button>
                                    <button
                                        aria-label="Export voyage"
                                        onClick={async () => {
                                            try {
                                                const voyageEntries = entries
                                                    .filter((e: { voyageId: string }) => e.voyageId === currentVoyageId)
                                                    .sort(
                                                        (a: { timestamp: string }, b: { timestamp: string }) =>
                                                            new Date(b.timestamp).getTime() -
                                                            new Date(a.timestamp).getTime(),
                                                    );
                                                const latestEntry = voyageEntries[0];
                                                const pinLat = latestEntry?.latitude;
                                                const pinLon = latestEntry?.longitude;
                                                if (!pinLat || !pinLon) {
                                                    toast.error('No GPS position available yet');
                                                    return;
                                                }
                                                const mapsUrl = `https://maps.google.com/?q=${pinLat.toFixed(6)},${pinLon.toFixed(6)}`;
                                                const message = `\u{1F4CD} My Current Position\n\nLat: ${pinLat.toFixed(4)}\u00B0  Lon: ${pinLon.toFixed(4)}\u00B0\n\nView on map: ${mapsUrl}\n\nShared via Thalassa \u{26F5}`;
                                                if (navigator.share) {
                                                    await navigator.share({ title: 'My Position', text: message });
                                                } else {
                                                    await navigator.clipboard.writeText(message);
                                                    toast.success('Position copied to clipboard');
                                                }
                                            } catch (err: unknown) {
                                                if (err instanceof Error && err.name !== 'AbortError') {
                                                    log.warn('Share failed:', err);
                                                }
                                            }
                                        }}
                                        className="w-14 h-14 shrink-0 rounded-2xl font-extrabold text-xs transition-all flex items-center justify-center bg-teal-500/15 border border-teal-500/30 text-teal-400 hover:bg-teal-500/25 active:scale-[0.97]"
                                        title="Share your position"
                                    >
                                        <MapPinIcon className="w-5 h-5" />
                                    </button>
                                    <button
                                        aria-label="Add log entry"
                                        onClick={() => dispatch({ type: 'SHOW_ADD_MODAL', show: true })}
                                        className="flex-1 h-14 px-4 rounded-2xl font-extrabold text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white shadow-lg shadow-sky-500/25 active:scale-[0.98]"
                                    >
                                        <PlusIcon className="w-5 h-5" />
                                        New Log Entry
                                    </button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* ── NOT TRACKING: Scrollable voyage list ── */}
                            <div
                                className="flex-1 overflow-y-auto px-4 snap-y snap-proximity scroll-pt-2"
                                style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom) + 16px)' }}
                            >
                                {/* The smaller "X TODAY · Y VOYAGES · Z NM"
                                    status row that used to live here was
                                    removed 2026-05-17 — it was a duplicate
                                    of the three big gauge tiles up at the
                                    top of the page, just in worse formatting
                                    (and using a different — broken — data
                                    source for the totals). Career counts now
                                    live in one place: the gauge tile grid. */}

                                {/* Past Voyage Cards */}
                                {loading && listVoyages.length === 0 ? (
                                    /* History still hydrating (cache miss / first network
                                       load) — skeleton cards, NOT the "Begin Your Log"
                                       empty state, and never a page-wide spinner: the
                                       Start control below is live the whole time. */
                                    <div className="space-y-3 px-1 py-2" aria-label="Loading voyages">
                                        {[0, 1, 2].map((i) => (
                                            <div
                                                key={i}
                                                className="rounded-2xl bg-slate-900/40 border border-white/5 p-4 animate-pulse"
                                            >
                                                <div className="h-3 w-28 bg-white/10 rounded mb-3" />
                                                <div className="h-2.5 w-44 bg-white/5 rounded mb-2" />
                                                <div className="h-2.5 w-36 bg-white/5 rounded" />
                                            </div>
                                        ))}
                                    </div>
                                ) : listVoyages.length === 0 ? (
                                    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-12">
                                        {/* Decorative maritime line art */}
                                        <div className="relative w-24 h-24 mb-6">
                                            <svg viewBox="0 0 96 96" fill="none" className="w-full h-full">
                                                {/* Outer ring — dashed */}
                                                <circle
                                                    cx="48"
                                                    cy="48"
                                                    r="44"
                                                    stroke="rgba(56,189,248,0.12)"
                                                    strokeWidth="1"
                                                    strokeDasharray="3 5"
                                                />
                                                {/* Middle ring — solid faint */}
                                                <circle
                                                    cx="48"
                                                    cy="48"
                                                    r="32"
                                                    stroke="rgba(56,189,248,0.08)"
                                                    strokeWidth="0.5"
                                                />
                                                {/* Compass rose petals */}
                                                <path d="M48 4L51 44H45L48 4Z" fill="rgba(56,189,248,0.25)" />
                                                <path d="M48 92L45 52H51L48 92Z" fill="rgba(56,189,248,0.10)" />
                                                <path d="M4 48L44 45V51L4 48Z" fill="rgba(56,189,248,0.10)" />
                                                <path d="M92 48L52 51V45L92 48Z" fill="rgba(56,189,248,0.10)" />
                                                {/* Center dot */}
                                                <circle cx="48" cy="48" r="3" fill="rgba(56,189,248,0.30)" />
                                                {/* Track line suggestion — curved */}
                                                <path
                                                    d="M20 70 C32 55, 64 42, 76 28"
                                                    stroke="rgba(52,211,153,0.25)"
                                                    strokeWidth="1.5"
                                                    strokeDasharray="4 3"
                                                    strokeLinecap="round"
                                                />
                                                {/* Waypoint dots on the track */}
                                                <circle cx="20" cy="70" r="2.5" fill="rgba(52,211,153,0.35)" />
                                                <circle cx="48" cy="49" r="2" fill="rgba(52,211,153,0.25)" />
                                                <circle cx="76" cy="28" r="2.5" fill="rgba(52,211,153,0.35)" />
                                            </svg>
                                        </div>
                                        <p className="text-base font-bold text-white mb-1.5">Begin Your Log</p>
                                        <p className="text-[13px] text-white/40 max-w-[260px] text-center leading-relaxed">
                                            Every great voyage starts with a single position. Slide below to begin GPS
                                            tracking.
                                        </p>
                                    </div>
                                ) : (
                                    listVoyages.map((summary) => (
                                        <VoyageCard
                                            suppressMiniMap={showTrackMap || liveMapExpanded}
                                            recordBadge={
                                                records.voyageCount >= 2
                                                    ? records.longestPassageVoyageId === summary.voyageId
                                                        ? 'longest'
                                                        : records.fastestVoyageId === summary.voyageId
                                                          ? 'fastest'
                                                          : records.longestDurationVoyageId === summary.voyageId
                                                            ? 'longestTrip'
                                                            : null
                                                    : null
                                            }
                                            key={summary.voyageId}
                                            summary={summary}
                                            entries={entries.filter((e) => e.voyageId === summary.voyageId)}
                                            isSelected={selectedVoyageId === summary.voyageId}
                                            isExpanded={expandedVoyages.has(summary.voyageId)}
                                            onToggle={() => toggleVoyage(summary.voyageId)}
                                            onSelect={() => {
                                                void loadVoyageEntries(summary.voyageId);
                                                dispatch({ type: 'SELECT_VOYAGE', voyageId: summary.voyageId });
                                            }}
                                            onDelete={() => handleDeleteVoyageRequest(summary.voyageId)}
                                            onArchive={() => handleArchiveVoyage(summary.voyageId)}
                                            onShowMap={() => {
                                                void loadVoyageEntries(summary.voyageId);
                                                dispatch({ type: 'SELECT_VOYAGE', voyageId: summary.voyageId });
                                                dispatch({ type: 'SHOW_TRACK_MAP', show: true });
                                            }}
                                            onNeedEntries={() => loadVoyageEntries(summary.voyageId)}
                                            filteredEntries={filteredEntries}
                                            onDeleteEntry={handleDeleteEntry}
                                            onEditEntry={handleEditEntry}
                                        />
                                    ))
                                )}

                                {/* ── Archived Voyages ── */}
                                {archivedVoyages.length > 0 && (
                                    <div className="mt-4">
                                        <button
                                            aria-label="Toggle archived voyages"
                                            onClick={() => setShowArchived(!showArchived)}
                                            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 active:scale-[0.98] transition-all"
                                        >
                                            <div className="flex items-center gap-2">
                                                <svg
                                                    className="w-4 h-4 text-amber-400"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        strokeWidth={2}
                                                        d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8"
                                                    />
                                                </svg>
                                                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                                                    Archived Voyages
                                                </span>
                                                <span className="text-[11px] font-bold text-amber-300/60 bg-amber-500/15 px-1.5 py-0.5 rounded-full">
                                                    {archivedVoyages.length}
                                                </span>
                                            </div>
                                            <svg
                                                className={`w-4 h-4 text-amber-400 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                            >
                                                <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    strokeWidth={2}
                                                    d="M19 9l-7 7-7-7"
                                                />
                                            </svg>
                                        </button>

                                        {showArchived && (
                                            <div className="mt-2 space-y-2">
                                                {archivedVoyages.map((voyage) => (
                                                    <div
                                                        key={voyage.voyageId}
                                                        className="rounded-2xl bg-slate-900/30 backdrop-blur-md border border-amber-500/10 p-4 flex items-center justify-between"
                                                    >
                                                        <div className="min-w-0">
                                                            <div className="flex items-center gap-2 mb-0.5">
                                                                <span className="text-xs font-bold text-white/80">
                                                                    {new Date(
                                                                        voyage.entries[voyage.entries.length - 1]
                                                                            ?.timestamp || '',
                                                                    )
                                                                        .toLocaleDateString('en-AU', {
                                                                            day: '2-digit',
                                                                            month: 'short',
                                                                            year: '2-digit',
                                                                        })
                                                                        .toUpperCase()}
                                                                </span>
                                                                <span className="text-[11px] font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full uppercase">
                                                                    Archived
                                                                </span>
                                                            </div>
                                                            <div className="text-[11px] text-white/60">
                                                                {voyage.entries.length} entries ·{' '}
                                                                {Math.max(
                                                                    0,
                                                                    ...voyage.entries.map(
                                                                        (e) => e.cumulativeDistanceNM || 0,
                                                                    ),
                                                                ).toFixed(1)}{' '}
                                                                NM
                                                            </div>
                                                        </div>
                                                        <button
                                                            aria-label="Unarchive voyage"
                                                            onClick={() => handleUnarchiveVoyage(voyage.voyageId)}
                                                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-amber-400 bg-amber-500/15 border border-amber-500/20 uppercase tracking-wider active:scale-[0.95] transition-all"
                                                        >
                                                            Unarchive
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* ── Slide to Start CTA — pinned at bottom ── */}
                            <div
                                className="shrink-0 px-4 pt-2"
                                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
                            >
                                <SlideToAction
                                    label="Slide to Start Tracking"
                                    thumbIcon={<PlayIcon className="w-5 h-5 text-white" />}
                                    onConfirm={() => checkGpsDisclaimer(handleStartTracking)}
                                    theme="emerald"
                                />
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* ── Acquiring-GPS modal toast ──
                A just-started voyage records nothing until the first clean
                fix lands, so a full-width banner makes the wait visible
                instead of the easy-to-miss inline chips. Shows whenever
                we're tracking but have no real recorded position yet, and
                auto-dismisses the instant a fix arrives (hasRecordedFix
                flips). z above the fullscreen maps; pointer-events-none so
                it never blocks the Stop button underneath. */}
            {isTracking && !hasRecordedFix && (
                <div
                    className="fixed inset-x-0 z-[10000] flex justify-center px-4 pointer-events-none animate-in fade-in slide-in-from-top-4 duration-300"
                    style={{ top: 'calc(env(safe-area-inset-top) + 12px)' }}
                    role="status"
                    aria-live="polite"
                >
                    <div className="w-full max-w-sm flex items-center gap-3 rounded-2xl bg-slate-900/95 border border-amber-400/30 shadow-2xl shadow-black/40 px-4 py-3 backdrop-blur-md">
                        <span className="relative flex h-3 w-3 shrink-0">
                            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
                            <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-400" />
                        </span>
                        <div className="min-w-0">
                            <div className="text-[13px] font-bold text-amber-300 uppercase tracking-widest">
                                Acquiring GPS fix…
                            </div>
                            <div className="text-[11px] text-white/50 leading-snug">
                                Recording starts at the first clean fix
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Propulsion mismatch nudge ──
                Bottom banner (above the Stop controls) that appears only
                when the declared engine state and the live estimate
                sustainedly disagree. One tap fixes it; Dismiss snoozes.
                Honest wording ("Looks like…") — it's a forecast-grade
                estimate, not a certainty. pointer-events-auto so the
                buttons work; sits above the bottom nav. */}
            {showPropNudge && propConflict.suggested && (
                <div
                    className="fixed inset-x-0 z-[10000] flex justify-center px-4 animate-in fade-in slide-in-from-bottom-4 duration-300"
                    style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 76px)' }}
                    role="alert"
                >
                    <div className="w-full max-w-sm rounded-2xl bg-slate-900/96 border border-sky-400/40 shadow-2xl shadow-black/50 px-4 py-3 backdrop-blur-md">
                        <div className="flex items-start gap-2.5">
                            <span className="text-lg leading-none mt-0.5">
                                {propConflict.suggested === 'sail' ? '⛵' : '⚙'}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-bold text-white">
                                    {propConflict.suggested === 'sail'
                                        ? 'Looks like you’re sailing'
                                        : 'Looks like you’re under power'}
                                </div>
                                <div className="text-[11px] text-white/55 leading-snug mt-0.5">
                                    Logged as {engineRunning ? 'motoring' : 'sailing'} — switch it?
                                </div>
                                <div className="flex gap-2 mt-2.5">
                                    <button
                                        onClick={() => toggleEngine(propConflict.suggested === 'motor')}
                                        className="flex-1 h-9 rounded-xl bg-sky-500 text-white text-[12px] font-extrabold uppercase tracking-wider active:scale-[0.97] transition-transform"
                                    >
                                        Switch to {propConflict.suggested === 'sail' ? 'Sailing' : 'Motoring'}
                                    </button>
                                    <button
                                        onClick={() =>
                                            setNudgeDismiss({
                                                until: Date.now() + 10 * 60 * 1000,
                                                forDeclared: engineRunning,
                                            })
                                        }
                                        className="px-3 h-9 rounded-xl bg-white/10 text-white/60 text-[12px] font-bold active:scale-[0.97] transition-transform"
                                    >
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Empty-track tidy announcement — big friendly modal with a
                5 s countdown ring, replaces the plain toast. */}
            <EmptyTrackRemovedModal count={emptyPruneNotice} onClose={clearEmptyPruneNotice} />
            <GpsAcquiringOverlay
                open={gpsOverlayOpen}
                onDismiss={() => setGpsOverlayDismissedFor(state.currentVoyageId ?? null)}
            />

            {/* Departure prompts (share-live? / link-a-plan?) now render
                globally from <DeparturePrompts/> in App.tsx — see the note
                where their effects used to live. */}

            {/* Toast Notifications */}
            <toast.ToastContainer />

            {/* GPS Accuracy Disclaimer Modal */}
            <GpsDisclaimerModal
                isOpen={showGpsDisclaimer}
                onDismiss={async (dontShowAgain) => dismissGpsDisclaimer(dontShowAgain)}
            />

            {/* Manual Entry Modal */}
            <AddEntryModal
                isOpen={showAddModal}
                onClose={() => dispatch({ type: 'SHOW_ADD_MODAL', show: false })}
                onSuccess={loadData}
                selectedVoyageId={selectedVoyageId}
            />

            {/* Edit Entry Modal */}
            <EditEntryModal
                isOpen={editEntry !== null}
                entry={editEntry}
                onClose={() => dispatch({ type: 'SET_EDIT_ENTRY', entry: null })}
                onSave={handleSaveEdit}
            />

            {/* Full Track Map Viewer — shows selected voyage or all */}
            <TrackMapViewer
                isOpen={showTrackMap}
                onClose={() => dispatch({ type: 'SHOW_TRACK_MAP', show: false })}
                entries={trackMapEntries}
            />

            {/* Community Track Browser */}
            <CommunityTrackBrowser
                isOpen={showCommunityBrowser}
                onClose={() => dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: false })}
                onImportComplete={loadData}
            />

            {/* ========== ACTION SHEET MODALS ========== */}

            {/* EXPORT ACTION SHEET */}
            {actionSheet === 'export' && (
                <ExportSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    selectedVoyageId={selectedVoyageId}
                    hasNonDeviceEntries={hasNonDeviceEntries}
                    onExportPDF={handleShare}
                    onExportGPX={handleExportGPX}
                />
            )}

            {actionSheet === 'import' && (
                <ImportSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onImportGPXFile={handleImportGPXFile}
                    onShowCommunityBrowser={() => {
                        dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true });
                        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
                    }}
                    onImportComplete={loadData}
                />
            )}

            {actionSheet === 'share' && (
                <ShareSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onShowShareForm={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share_form' })}
                    onShowCommunityBrowser={() => {
                        dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true });
                        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
                    }}
                    onShareImage={handleShareImage}
                    hasNonDeviceEntries={hasNonDeviceEntries}
                    selectedVoyageId={selectedVoyageId}
                />
            )}

            {actionSheet === 'share_form' && (
                <ShareFormSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onBack={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share' })}
                    onShowCommunityBrowser={() => {
                        dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true });
                        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
                    }}
                    onShareToCommunity={handleShareToCommunity}
                    shareAutoTitle={shareAutoTitle}
                    shareAutoRegion={shareAutoRegion}
                />
            )}

            {actionSheet === 'stats' && (
                <StatsSheet
                    onClose={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                    onSelectVoyage={(id) => {
                        // Stats need the full points: lazy-load the selected
                        // voyage, or ALL voyages for the "All Voyages" deep-dive.
                        if (id) void loadVoyageEntries(id);
                        else void loadAllEntries();
                        dispatch({ type: 'SELECT_VOYAGE', voyageId: id });
                    }}
                    onShowStats={() => dispatch({ type: 'SHOW_STATS', show: true })}
                    entries={entries}
                    selectedVoyageId={selectedVoyageId}
                    currentVoyageId={currentVoyageId ?? null}
                    voyageGroups={listVoyages}
                />
            )}

            {/* Cast-off "Follow a route?" sheet — appears when a fresh voyage
                starts and there are suggested routes to broadcast (Shane
                2026-07-17). Tapping one publishes it to the public page; "Just
                recording" skips. Publish-only (v1): the route also draws on
                your own chart via the card's FOLLOW button. */}
            {followPromptVoyageId && (
                // TOP-DOCKED, just under the "Ship's Log" header (Shane 2026-07-19:
                // "can it start at the top just below where it says ship's log").
                // It was an items-end sheet, so it opened at the far bottom of the
                // screen — furthest from where the eye already was. The pt clears
                // the safe area plus PageHeader; pb keeps it off the home
                // indicator, and max-h-full then resolves against what is left,
                // so the card can never run off either end.
                <div
                    className="fixed inset-0 z-[10055] flex items-start justify-center bg-black/60 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[calc(env(safe-area-inset-top)+5.5rem)]"
                    onClick={() => setFollowPromptVoyageId(null)}
                >
                    <div
                        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="shrink-0 border-b border-white/10 px-5 py-4">
                            <div className="text-sm font-black uppercase tracking-widest text-emerald-300">
                                Following a route?
                            </div>
                            <div className="mt-0.5 text-[12px] text-gray-400">
                                Pick one to show on your public page — or just record the track.
                            </div>
                        </div>
                        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
                            {plannedSummaries.map((s) => (
                                <FollowRouteChoice
                                    key={s.voyageId}
                                    summary={s}
                                    onPick={() => {
                                        void publishFollowedRoute(s.voyageId).then((result) => {
                                            if (result === 'linked')
                                                toast.success('Your public page now follows this route');
                                            else toast.error('Couldn’t publish — try the Follow button, or Settings');
                                        });
                                        setFollowPromptVoyageId(null);
                                    }}
                                />
                            ))}
                        </div>
                        <div className="shrink-0 border-t border-white/10 px-5 py-3">
                            <button
                                onClick={() => setFollowPromptVoyageId(null)}
                                className="w-full rounded-xl bg-white/10 py-2.5 text-[12px] font-black uppercase tracking-widest text-gray-300 active:scale-95"
                            >
                                Just recording
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Voyage Choice Dialog - Continue or New */}
            {showVoyageChoiceDialog && (
                <VoyageChoiceDialog
                    onContinue={continueLastVoyage}
                    onNewVoyage={async () => {
                        dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false });
                        await startTrackingWithNewVoyage();
                    }}
                    onCancel={() => dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false })}
                />
            )}

            {/* Stop Voyage Confirmation Dialog */}
            {showStopVoyageDialog && (
                <StopVoyageDialog
                    onConfirm={confirmStopVoyage}
                    onCancel={() => dispatch({ type: 'SHOW_STOP_DIALOG', show: false })}
                />
            )}

            {/* Delete Voyage Confirmation Modal */}
            {deleteVoyageId &&
                (() => {
                    const voyageEntries = entries.filter((e) => e.voyageId === deleteVoyageId);
                    const sortedEntries = [...voyageEntries].sort(
                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                    );
                    const first = sortedEntries[0];
                    const last = sortedEntries[sortedEntries.length - 1];
                    const startDate = first ? new Date(first.timestamp) : new Date();
                    const endDate = last ? new Date(last.timestamp) : new Date();
                    const totalDays = Math.max(
                        1,
                        Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)),
                    );
                    const voyageTotalDistance = Math.max(...voyageEntries.map((e) => e.cumulativeDistanceNM || 0), 0);

                    const formatLoc = (e: ShipLogEntry | undefined) => {
                        if (!e) return 'Unknown';
                        if (e.waypointName) return e.waypointName;
                        return `${Math.abs(e.latitude ?? 0).toFixed(2)}°${(e.latitude ?? 0) >= 0 ? 'N' : 'S'}`;
                    };

                    return (
                        <DeleteVoyageModal
                            isOpen={true}
                            onClose={() => dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null })}
                            onExportFirst={handleExportThenDelete}
                            onDelete={handleConfirmDeleteVoyage}
                            voyageInfo={{
                                startLocation: formatLoc(first),
                                endLocation: formatLoc(last),
                                totalDays,
                                totalEntries: voyageEntries.length,
                                totalDistance: voyageTotalDistance,
                            }}
                        />
                    );
                })()}
            {/* Undo toast for entry deletion */}
            <UndoToast
                isOpen={!!deletedEntry}
                message={`Entry deleted`}
                onUndo={handleUndoDeleteEntry}
                onDismiss={handleDismissDeleteEntry}
                duration={5000}
            />
            {/* Undo toast for voyage deletion */}
            <UndoToast
                isOpen={!!deletedVoyage}
                message={`Voyage deleted`}
                onUndo={handleUndoDeleteVoyage}
                onDismiss={handleDismissDeleteVoyage}
                duration={5000}
            />

            {/* Shared voyage warning confirm dialog */}
            <ConfirmDialog
                isOpen={!!showSharedVoyageWarning}
                title="Community Shared Voyage"
                message={`This voyage has been shared to the community as ${showSharedVoyageWarning?.trackInfo || ''}. Deleting it will also remove it from the community.`}
                confirmLabel="Delete Anyway"
                cancelLabel="Cancel"
                destructive
                onConfirm={confirmDeleteSharedVoyage}
                onCancel={cancelDeleteSharedVoyage}
            />
        </div>
    );
};

// --- SUB-COMPONENTS ---
