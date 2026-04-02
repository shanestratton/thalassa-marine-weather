/**
 * useLogPageState — Custom hook extracting all state & business logic from LogPage.
 *
 * Before: LogPage had 26 useState calls, 30+ handlers, and derived data
 * all in a single 1200-line component.
 *
 * After: LogPage is a pure rendering shell (~500 lines of JSX).
 * All state, effects, and handlers live here.
 */

import { useState, useEffect, useCallback, useMemo, useReducer, useRef } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useLogPageState');
import type { ShipLogEntry } from '../types';
import { ShipLogService } from '../services/ShipLogService';
import { supabase } from '../services/supabase';
import { BgGeoManager } from '../services/BgGeoManager';

import { useToast } from '../components/Toast';
import { useSettings } from '../context/SettingsContext';
import { groupEntriesByDate, filterEntriesByType, searchEntries } from '../utils/voyageData';
import { exportVoyageAsGPX, shareGPXFile, readGPXFile, importGPXToEntries } from '../services/gpxService';
import { TrackSharingService, TrackCategory } from '../services/TrackSharingService';
import { LogFilters } from '../components/LogFilterToolbar';
import { getErrorMessage } from '../utils/logger';

// ─── STATE SHAPE ──────────────────────────────────────────────────────────────

interface LogPageState {
    entries: ShipLogEntry[];
    isTracking: boolean;
    isPaused: boolean;
    isRapidMode: boolean;
    loading: boolean;

    // UI modals / sheets
    showAddModal: boolean;
    showTrackMap: boolean;
    showStats: boolean;
    showStopVoyageDialog: boolean;
    showVoyageChoiceDialog: boolean;
    showCommunityBrowser: boolean;
    actionSheet: 'export' | 'import' | 'share' | 'share_form' | 'pin' | 'stats' | null;

    // Edit / selection
    editEntry: ShipLogEntry | null;
    selectedVoyageId: string | null;
    deleteVoyageId: string | null;
    currentVoyageId: string | undefined;
    lastVoyageId: string | null;
    expandedVoyages: Set<string>;
    gpsStatus: 'locked' | 'stale' | 'none';

    // Filters
    filters: LogFilters;
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

type LogPageAction =
    | {
          type: 'LOAD_DATA';
          entries: ShipLogEntry[];
          isTracking: boolean;
          isPaused: boolean;
          isRapidMode: boolean;
          currentVoyageId: string | undefined;
      }
    | { type: 'SET_ENTRIES'; entries: ShipLogEntry[] }
    | { type: 'UPDATE_ENTRIES'; updater: (prev: ShipLogEntry[]) => ShipLogEntry[] }
    | { type: 'SET_TRACKING'; isTracking: boolean; isPaused: boolean }
    | { type: 'SET_RAPID_MODE'; isRapidMode: boolean }
    | { type: 'SET_GPS_STATUS'; status: 'locked' | 'stale' | 'none' }
    | { type: 'SHOW_ADD_MODAL'; show: boolean }
    | { type: 'SHOW_TRACK_MAP'; show: boolean }
    | { type: 'SHOW_STATS'; show: boolean }
    | { type: 'SHOW_STOP_DIALOG'; show: boolean }
    | { type: 'SHOW_VOYAGE_CHOICE'; show: boolean; lastVoyageId?: string | null }
    | { type: 'SHOW_COMMUNITY_BROWSER'; show: boolean }
    | { type: 'SET_ACTION_SHEET'; sheet: 'export' | 'import' | 'share' | 'share_form' | 'pin' | 'stats' | null }
    | { type: 'SET_EDIT_ENTRY'; entry: ShipLogEntry | null }
    | { type: 'SET_FILTERS'; filters: LogFilters }
    | { type: 'SELECT_VOYAGE'; voyageId: string | null }
    | { type: 'TOGGLE_VOYAGE'; voyageId: string }
    | { type: 'REQUEST_DELETE_VOYAGE'; voyageId: string | null }
    | { type: 'DONE_LOADING' };

// ─── REDUCER ──────────────────────────────────────────────────────────────────

const initialState: LogPageState = {
    entries: [],
    isTracking: false,
    isPaused: false,
    isRapidMode: false,
    loading: true,
    showAddModal: false,
    showTrackMap: false,
    showStats: false,
    showStopVoyageDialog: false,
    showVoyageChoiceDialog: false,
    showCommunityBrowser: false,
    actionSheet: null,
    editEntry: null,
    selectedVoyageId: null,
    deleteVoyageId: null,
    currentVoyageId: undefined,
    lastVoyageId: null,
    expandedVoyages: new Set(),
    gpsStatus: 'none',
    filters: { types: ['auto', 'manual', 'waypoint'], searchQuery: '' },
};

function logPageReducer(state: LogPageState, action: LogPageAction): LogPageState {
    switch (action.type) {
        case 'LOAD_DATA': {
            // Preserve user's expand/collapse state during polls.
            // Only auto-expand active voyage on FIRST load (when entries are empty).
            const expandedVoyages =
                action.currentVoyageId && state.entries.length === 0
                    ? new Set([action.currentVoyageId])
                    : state.expandedVoyages;
            return {
                ...state,
                entries: action.entries,
                isTracking: action.isTracking,
                isPaused: action.isPaused,
                isRapidMode: action.isRapidMode,
                currentVoyageId: action.currentVoyageId,
                expandedVoyages,
                loading: false,
            };
        }
        case 'SET_ENTRIES':
            return { ...state, entries: action.entries };
        case 'UPDATE_ENTRIES':
            return { ...state, entries: action.updater(state.entries) };
        case 'SET_TRACKING':
            return { ...state, isTracking: action.isTracking, isPaused: action.isPaused, isRapidMode: false };
        case 'SET_RAPID_MODE':
            return { ...state, isRapidMode: action.isRapidMode };
        case 'SET_GPS_STATUS':
            return { ...state, gpsStatus: action.status };
        case 'SHOW_ADD_MODAL':
            return { ...state, showAddModal: action.show };
        case 'SHOW_TRACK_MAP':
            return { ...state, showTrackMap: action.show };
        case 'SHOW_STATS':
            return { ...state, showStats: action.show };
        case 'SHOW_STOP_DIALOG':
            return { ...state, showStopVoyageDialog: action.show };
        case 'SHOW_VOYAGE_CHOICE':
            return {
                ...state,
                showVoyageChoiceDialog: action.show,
                lastVoyageId: action.lastVoyageId !== undefined ? action.lastVoyageId : state.lastVoyageId,
            };
        case 'SHOW_COMMUNITY_BROWSER':
            return { ...state, showCommunityBrowser: action.show };
        case 'SET_ACTION_SHEET':
            return { ...state, actionSheet: action.sheet };
        case 'SET_EDIT_ENTRY':
            return { ...state, editEntry: action.entry };
        case 'SET_FILTERS':
            return { ...state, filters: action.filters };
        case 'SELECT_VOYAGE':
            return { ...state, selectedVoyageId: action.voyageId };
        case 'TOGGLE_VOYAGE': {
            const next = new Set(state.expandedVoyages);
            if (next.has(action.voyageId)) next.delete(action.voyageId);
            else next.add(action.voyageId);
            return { ...state, expandedVoyages: next };
        }
        case 'REQUEST_DELETE_VOYAGE':
            return { ...state, deleteVoyageId: action.voyageId };
        case 'DONE_LOADING':
            return { ...state, loading: false };
        default:
            return state;
    }
}

// ─── HELPER: Group entries by voyage ──────────────────────────────────────────

function groupEntriesByVoyage(entries: ShipLogEntry[]) {
    const voyageMap = new Map<string, ShipLogEntry[]>();

    entries.forEach((entry) => {
        const voyageId = entry.voyageId || 'default_voyage';
        if (!voyageMap.has(voyageId)) {
            voyageMap.set(voyageId, []);
        }
        voyageMap.get(voyageId)!.push(entry);
    });

    return Array.from(voyageMap.entries())
        .map(([voyageId, entries]) => ({
            voyageId,
            entries: entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
        }))
        .sort((a, b) => {
            const aTime = new Date(a.entries[0]?.timestamp || 0).getTime();
            const bTime = new Date(b.entries[0]?.timestamp || 0).getTime();
            return bTime - aTime;
        });
}

// ─── HOOK ─────────────────────────────────────────────────────────────────────

export function useLogPageState() {
    const [state, dispatch] = useReducer(logPageReducer, initialState);
    const toast = useToast();
    const { settings } = useSettings();

    // ── Archive state (separate from main state to avoid re-renders on every poll) ──
    const [archivedVoyages, setArchivedVoyages] = useState<ReturnType<typeof groupEntriesByVoyage>>([]);
    const [careerEntries, setCareerEntries] = useState<ShipLogEntry[]>([]);

    // Guard: prevents loadData from overwriting optimistic tracking=false during stop
    const stoppingRef = useRef(false);

    // ── Initialization ──────────────────────────────────────────────────────

    const ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    const loadData = useCallback(async () => {
        const status = ShipLogService.getTrackingStatus();
        const voyageId = ShipLogService.getCurrentVoyageId();

        // Fetch from BOTH sources and merge — ensures entries are visible
        // whether they're synced to Supabase or still in the offline queue.
        const [dbEntries, offlineEntries] = await Promise.all([
            ShipLogService.getLogEntries(10_000_000),
            ShipLogService.getOfflineEntries(),
        ]);

        // Merge + deduplicate by entry ID (offline entries may not yet be in Supabase)
        const seen = new Set<string>();
        const merged: ShipLogEntry[] = [];
        for (const entry of [...dbEntries, ...offlineEntries]) {
            const key = entry.id;
            if (key && !seen.has(key)) {
                seen.add(key);
                merged.push(entry);
            }
        }

        // Sort newest first
        merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        dispatch({
            type: 'LOAD_DATA',
            entries: merged,
            // While stopping, keep tracked state as false to prevent UI bounce
            isTracking: stoppingRef.current ? false : status.isTracking,
            isPaused: stoppingRef.current ? false : status.isPaused,
            isRapidMode: stoppingRef.current ? false : status.isRapidMode,
            currentVoyageId: voyageId,
        });

        // Load archived voyages and career entries in parallel (non-blocking)
        reloadCareerData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── One-time auto-archive of old voyages (>30 days) ──
    // Runs ONCE after initial load, never during polling.
    const hasAutoArchived = useRef(false);

    useEffect(() => {
        if (hasAutoArchived.current) return;
        if (state.loading || state.entries.length === 0) return;

        hasAutoArchived.current = true;
        const now = Date.now();
        const voyages = groupEntriesByVoyage(state.entries);

        for (const v of voyages) {
            // Find the MOST RECENT entry in the voyage
            const newestTimestamp = Math.max(...v.entries.map((e) => new Date(e.timestamp).getTime()));
            if (newestTimestamp > 0 && now - newestTimestamp > ARCHIVE_AGE_MS) {
                ShipLogService.archiveVoyage(v.voyageId)
                    .then(() => loadData())
                    .catch((e) => {
                        console.warn(`[useLogPageState]`, e);
                    });
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.loading, state.entries.length]);

    // Reusable career + archive data refresh
    const reloadCareerData = useCallback(() => {
        Promise.all([ShipLogService.getArchivedEntries(), ShipLogService.getAllEntriesForCareer()])
            .then(([archived, career]) => {
                setArchivedVoyages(groupEntriesByVoyage(archived));
                setCareerEntries(career);
            })
            .catch((e) => {
                console.warn(`[useLogPageState]`, e);
            });
    }, []);

    useEffect(() => {
        let mounted = true;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
            /* Safety: dismiss spinner after 5s if init hangs (web/no Capacitor) */
            if (mounted) dispatch({ type: 'DONE_LOADING' });
        }, 5000);
        // Pre-warm GPS plugin on mount — saves 1-2s when user taps Start
        BgGeoManager.ensureReady().catch((e) => {
            console.warn(`[useLogPageState]`, e);
        });
        (async () => {
            try {
                await ShipLogService.initialize();
                if (mounted) await loadData();

                // FIX: Supabase auth session may still be rehydrating from storage
                // on cold starts. If getLogEntries returned [] because getUser() was
                // null, retry after a short delay to give the session time to restore.
                // This is the root cause of "empty LogPage on first visit".
                retryTimer = setTimeout(async () => {
                    if (mounted) await loadData();
                }, 1500);
            } catch (e) {
                log.warn('Init failed:', e);
                /* Init or load failure — stop spinner to show empty state */
                if (mounted) dispatch({ type: 'DONE_LOADING' });
            } finally {
                clearTimeout(timeout);
            }
        })();

        // AUTH SESSION LISTENER: Reload data when Supabase session becomes available.
        // Handles the case where the user navigates to LogPage before auth finishes.
        let authUnsubscribe: (() => void) | undefined;
        if (supabase) {
            const {
                data: { subscription },
            } = supabase.auth.onAuthStateChange((event) => {
                if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                    if (mounted) loadData();
                }
            });
            authUnsubscribe = () => subscription.unsubscribe();
        }

        return () => {
            mounted = false;
            clearTimeout(timeout);
            if (retryTimer) clearTimeout(retryTimer);
            authUnsubscribe?.();
        };
    }, [loadData]);

    // ── GPS Status Polling ──────────────────────────────────────────────────

    useEffect(() => {
        if (!state.isTracking) {
            dispatch({ type: 'SET_GPS_STATUS', status: 'none' });
            return;
        }
        const poll = () => {
            if (!document.hidden) dispatch({ type: 'SET_GPS_STATUS', status: ShipLogService.getGpsStatus() });
        };
        poll();
        const id = setInterval(poll, 5000);
        return () => clearInterval(id);
    }, [state.isTracking]);

    // ── Entry Refresh Polling — live updates while tracking ──────────────────
    // RAPID INITIAL POLL: Poll every 1s for the first 10s after tracking starts
    // so the first track card appears almost instantly. Then fall back to 5s/3s.
    // This is lightweight — just reads from local DB, no GPS calls.

    useEffect(() => {
        if (!state.isTracking) return;

        const normalPollMs = state.isRapidMode ? 3_000 : 5_000;
        const BURST_POLL_MS = 1_000;
        const BURST_DURATION_MS = 10_000;

        // Start with rapid polling
        let currentId = setInterval(() => {
            if (!document.hidden) loadData();
        }, BURST_POLL_MS);

        // After burst period, switch to normal polling
        const burstTimeout = setTimeout(() => {
            clearInterval(currentId);
            currentId = setInterval(() => {
                if (!document.hidden) loadData();
            }, normalPollMs);
        }, BURST_DURATION_MS);

        return () => {
            clearInterval(currentId);
            clearTimeout(burstTimeout);
        };
    }, [state.isTracking, state.isRapidMode, loadData]);

    // ── Tracking Handlers ───────────────────────────────────────────────────

    const handleStartTracking = useCallback(async () => {
        const voyages = groupEntriesByVoyage(state.entries);
        // Only offer to continue real device-tracked voyages, not suggested/imported tracks
        const realVoyages = voyages.filter(
            (v) => !v.entries.some((e) => e.source === 'planned_route' || (e.source && e.source !== 'device')),
        );
        if (realVoyages.length > 0) {
            const recentVoyageId = realVoyages[0]?.voyageId;
            if (recentVoyageId) {
                dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: true, lastVoyageId: recentVoyageId });
                return;
            }
        }
        // Instant UI response — dispatch first, service call is fire-and-forget
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        ShipLogService.startTracking()
            .then(() => loadData())
            .catch((error: unknown) => {
                dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
                toast.error(getErrorMessage(error) || 'Failed to start tracking');
            });
    }, [state.entries, loadData, toast]);

    const startTrackingWithNewVoyage = useCallback(async () => {
        // Instant UI response — dispatch first, service call is fire-and-forget
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        ShipLogService.startTracking()
            .then(() => loadData())
            .catch((error: unknown) => {
                dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
                toast.error(getErrorMessage(error) || 'Failed to start tracking');
            });
    }, [loadData, toast]);

    const continueLastVoyage = useCallback(async () => {
        // Instant UI response — dispatch first, service call is fire-and-forget
        dispatch({ type: 'SET_TRACKING', isTracking: true, isPaused: false });
        dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false });
        ShipLogService.startTracking(false, state.lastVoyageId || undefined)
            .then(() => loadData())
            .catch((error: unknown) => {
                dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
                toast.error(getErrorMessage(error) || 'Failed to continue tracking');
            });
    }, [state.lastVoyageId, loadData, toast]);

    const handlePauseTracking = useCallback(async () => {
        await ShipLogService.pauseTracking();
        dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: true });
    }, []);

    const handleToggleRapidMode = useCallback(async () => {
        const newState = !state.isRapidMode;
        await ShipLogService.setRapidMode(newState);
        dispatch({ type: 'SET_RAPID_MODE', isRapidMode: newState });
    }, [state.isRapidMode]);

    const handleStopTracking = useCallback(() => {
        dispatch({ type: 'SHOW_STOP_DIALOG', show: true });
    }, []);

    const confirmStopVoyage = useCallback(async () => {
        dispatch({ type: 'SHOW_STOP_DIALOG', show: false });
        // Instant UI response — dispatch first, guard prevents polls from overwriting
        stoppingRef.current = true;
        dispatch({ type: 'SET_TRACKING', isTracking: false, isPaused: false });
        try {
            await ShipLogService.stopTracking();
        } catch (e) {
            log.warn('swallow:', e);
        }
        // Clear the guard, then reload to pick up final state
        stoppingRef.current = false;
        await loadData();
    }, [loadData]);

    // ── Entry CRUD ──────────────────────────────────────────────────────────

    // ── Soft-delete with undo ──
    const [deletedEntry, setDeletedEntry] = useState<ShipLogEntry | null>(null);
    const deletingEntryRef = useRef(false);
    const entriesRef = useRef(state.entries);
    entriesRef.current = state.entries;

    const handleDeleteEntry = useCallback((entryId: string) => {
        // Guard: prevent double-fire from stale callbacks
        if (deletingEntryRef.current) return;
        deletingEntryRef.current = true;

        const entry = entriesRef.current.find((e) => e.id === entryId);
        if (!entry) {
            deletingEntryRef.current = false;
            return;
        }

        // Remove from UI immediately
        dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => prev.filter((e) => e.id !== entryId) });
        setDeletedEntry(entry);
    }, []);

    // Called by UndoToast after 5s — performs the actual API delete
    const handleDismissDeleteEntry = useCallback(async () => {
        if (!deletedEntry) return;
        const entry = deletedEntry;
        setDeletedEntry(null);
        deletingEntryRef.current = false;
        try {
            const success = await ShipLogService.deleteEntry(entry.id);
            if (!success) {
                toast.error('Failed to delete entry');
                dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, entry] });
            }
        } catch (e) {
            toast.error('Failed to delete entry');
            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, entry] });
        }
    }, [deletedEntry, toast]);

    const handleUndoDeleteEntry = useCallback(() => {
        if (deletedEntry) {
            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, deletedEntry] });
            toast.success('Entry restored');
        }
        setDeletedEntry(null);
        deletingEntryRef.current = false;
    }, [deletedEntry, toast]);

    const handleEditEntry = useCallback((entry: ShipLogEntry) => {
        dispatch({ type: 'SET_EDIT_ENTRY', entry });
    }, []);

    const handleSaveEdit = useCallback(
        (entryId: string, updates: { notes?: string; waypointName?: string }) => {
            dispatch({
                type: 'UPDATE_ENTRIES',
                updater: (prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e)),
            });
            toast.success('Entry updated');
        },
        [toast],
    );

    // ── Voyage Management ───────────────────────────────────────────────────

    const toggleVoyage = useCallback((voyageId: string) => {
        dispatch({ type: 'TOGGLE_VOYAGE', voyageId });
    }, []);

    // ── Soft-delete voyage with undo ──
    const [deletedVoyage, setDeletedVoyage] = useState<{
        voyageId: string;
        entries: ShipLogEntry[];
    } | null>(null);

    const handleDeleteVoyageRequest = useCallback(
        async (voyageId: string) => {
            // Check for shared tracks first — those need a confirmation
            try {
                const sharedTracks = await TrackSharingService.getSharedTracksByVoyageId(voyageId);
                if (sharedTracks.length > 0) {
                    const trackInfo = sharedTracks
                        .map((t) => `"${t.title}" (${t.download_count || 0} downloads)`)
                        .join(', ');
                    setShowSharedVoyageWarning({ voyageId, trackInfo });
                    return;
                }
            } catch (e) {
                log.warn('shared track check failed:', e);
            }

            // Soft-delete: remove from UI, UndoToast owns the 5s countdown
            const voyageEntries = state.entries.filter((e) => e.voyageId === voyageId);
            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => prev.filter((e) => e.voyageId !== voyageId) });
            setDeletedVoyage({ voyageId, entries: voyageEntries });
        },
        [state.entries],
    );

    // Called by UndoToast after 5s — performs the actual voyage delete
    const handleDismissDeleteVoyage = useCallback(async () => {
        if (!deletedVoyage) return;
        const { voyageId } = deletedVoyage;
        setDeletedVoyage(null);
        await executeVoyageDelete(voyageId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deletedVoyage]);

    const handleUndoDeleteVoyage = useCallback(() => {
        if (deletedVoyage) {
            dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => [...prev, ...deletedVoyage.entries] });
            toast.success('Voyage restored');
        }
        setDeletedVoyage(null);
    }, [deletedVoyage, toast]);

    // Track shared voyage warning state for ConfirmDialog in UI
    const [showSharedVoyageWarning, setShowSharedVoyageWarning] = useState<{
        voyageId: string;
        trackInfo: string;
    } | null>(null);

    const handleConfirmDeleteVoyage = useCallback(async () => {
        if (!state.deleteVoyageId) return;
        const voyageId = state.deleteVoyageId;

        // Check if this voyage has been shared to the community
        try {
            const sharedTracks = await TrackSharingService.getSharedTracksByVoyageId(voyageId);
            if (sharedTracks.length > 0) {
                const trackInfo = sharedTracks
                    .map((t) => `"${t.title}" (${t.download_count || 0} downloads)`)
                    .join(', ');
                // Show custom confirm dialog instead of native confirm()
                setShowSharedVoyageWarning({ voyageId, trackInfo });
                return; // Wait for user to confirm via UI
            }
        } catch (e) {
            log.warn('shared track check failed:', e);
        }

        // No shared tracks — proceed directly
        await executeVoyageDelete(voyageId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.deleteVoyageId]);

    const executeVoyageDelete = useCallback(
        async (voyageId: string) => {
            // Delete community shares if any
            try {
                await TrackSharingService.deleteSharedTracksByVoyageId(voyageId);
            } catch (e) {
                /* ok — may not exist */
            }

            const success = await ShipLogService.deleteVoyage(voyageId);
            if (success) {
                dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => prev.filter((e) => e.voyageId !== voyageId) });
                reloadCareerData();
            } else {
                toast.error('Failed to delete voyage');
            }
            dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null });
            setShowSharedVoyageWarning(null);
        },
        [toast, reloadCareerData],
    );

    const confirmDeleteSharedVoyage = useCallback(() => {
        if (showSharedVoyageWarning) {
            executeVoyageDelete(showSharedVoyageWarning.voyageId);
        }
    }, [showSharedVoyageWarning, executeVoyageDelete]);

    const cancelDeleteSharedVoyage = useCallback(() => {
        dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: null });
        setShowSharedVoyageWarning(null);
    }, []);

    // ── Export / Share ───────────────────────────────────────────────────────

    const handleExportCSV = useCallback(async () => {
        const { exportToCSV } = await import('../utils/logExport');
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter((e) => e.voyageId === state.selectedVoyageId)
            : state.entries;
        exportToCSV(targetEntries, 'ships_log.csv', {
            onProgress: () => {},
            onSuccess: () => {},
            onError: (err) => toast.error(err),
        });
    }, [state.selectedVoyageId, state.entries, toast]);

    const handleShare = useCallback(async () => {
        const { sharePDF } = await import('../utils/logExport');
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter((e) => e.voyageId === state.selectedVoyageId)
            : state.entries;
        await sharePDF(
            targetEntries,
            {
                onProgress: () => {},
                onSuccess: () => {},
                onError: (err) => toast.error(err),
            },
            settings.vessel?.name,
            { vessel: settings.vessel, vesselUnits: settings.vesselUnits, units: settings.units },
        );
    }, [state.selectedVoyageId, state.entries, settings.vessel, settings.vesselUnits, settings.units, toast]);

    const handleExportThenDelete = useCallback(async () => {
        await handleShare();
    }, [handleShare]);

    const handleExportGPX = useCallback(async () => {
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter((e) => e.voyageId === state.selectedVoyageId)
            : state.entries;
        if (targetEntries.length === 0) return;
        const voyageName = state.selectedVoyageId ? `Voyage ${state.selectedVoyageId.slice(0, 8)}` : 'All Voyages';
        const gpxXml = exportVoyageAsGPX(targetEntries, voyageName, settings.vessel?.name);
        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
        await shareGPXFile(gpxXml, `${voyageName.replace(/\s+/g, '_').toLowerCase()}.gpx`);
    }, [state.selectedVoyageId, state.entries, settings.vessel?.name]);

    const handleImportGPXFile = useCallback(
        async (file: File) => {
            try {
                const gpxXml = await readGPXFile(file);
                const entries = importGPXToEntries(gpxXml);
                if (entries.length === 0) {
                    toast.error('No valid track points found in file');
                    return;
                }
                // Stamp with provenance
                entries.forEach((e) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (e as any).source = 'gpx_import';
                });
                const { savedCount } = await ShipLogService.importGPXVoyage(entries);
                toast.success(`Imported ${savedCount} entries from ${file.name}`);
                await loadData();
            } catch (err: unknown) {
                toast.error(getErrorMessage(err) || 'Failed to import GPX file');
            }
        },
        [toast, loadData],
    );

    const handleShareToCommunity = useCallback(
        async (shareData: { title: string; description: string; category: TrackCategory; region: string }) => {
            dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
            const targetEntries = state.selectedVoyageId
                ? state.entries.filter((e) => e.voyageId === state.selectedVoyageId)
                : state.entries;
            if (targetEntries.length === 0) {
                toast.error('No entries to share');
                return;
            }

            try {
                const result = await TrackSharingService.shareTrack(targetEntries, {
                    title: shareData.title,
                    description: shareData.description,
                    tags: [],
                    category: shareData.category,
                    region: shareData.region,
                });
                if (result) {
                    toast.success('Track shared to community!');
                } else {
                    toast.error('Failed to share track');
                }
            } catch (err: unknown) {
                toast.error(getErrorMessage(err) || 'Share failed');
            }
        },
        [state.selectedVoyageId, state.entries, toast],
    );

    // ── Derived State ───────────────────────────────────────────────────────

    const filteredEntries = useMemo(() => {
        let filtered = state.entries;
        filtered = filterEntriesByType(filtered, state.filters.types);
        filtered = searchEntries(filtered, state.filters.searchQuery);
        return filtered;
    }, [state.entries, state.filters]);

    const groupedEntries = useMemo(() => {
        const newestFirst = [...filteredEntries].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
        return groupEntriesByDate(newestFirst);
    }, [filteredEntries]);

    const entryCounts = useMemo(
        () => ({
            auto: state.entries.filter((e) => e.entryType === 'auto').length,
            manual: state.entries.filter((e) => e.entryType === 'manual').length,
            waypoint: state.entries.filter((e) => e.entryType === 'waypoint').length,
        }),
        [state.entries],
    );

    const voyageGroups = useMemo(() => {
        const groups = groupEntriesByVoyage(state.entries);
        // Sort: planned routes first, then by newest timestamp
        return groups.sort((a, b) => {
            const aPlanned = a.entries.some((e) => e.source === 'planned_route');
            const bPlanned = b.entries.some((e) => e.source === 'planned_route');
            if (aPlanned && !bPlanned) return -1;
            if (!aPlanned && bPlanned) return 1;
            // Then by most recent timestamp
            const aTime = Math.max(...a.entries.map((e) => new Date(e.timestamp).getTime()));
            const bTime = Math.max(...b.entries.map((e) => new Date(e.timestamp).getTime()));
            return bTime - aTime;
        });
    }, [state.entries]);

    const hasNonDeviceEntries = useMemo(() => {
        const targetEntries = state.selectedVoyageId
            ? state.entries.filter((e) => e.voyageId === state.selectedVoyageId)
            : state.entries;
        return targetEntries.some((e) => e.source && e.source !== 'device');
    }, [state.entries, state.selectedVoyageId]);

    // Total distance: sum each voyage's max cumulative distance
    const totalDistance = useMemo(() => {
        const voyageMap = new Map<string, number>();
        filteredEntries.forEach((e) => {
            const vid = e.voyageId || 'default';
            const current = voyageMap.get(vid) || 0;
            voyageMap.set(vid, Math.max(current, e.cumulativeDistanceNM || 0));
        });
        let total = 0;
        voyageMap.forEach((d) => {
            total += d;
        });
        return total;
    }, [filteredEntries]);

    // Average speed: across all entries with speed > 0
    const avgSpeed = useMemo(() => {
        const withSpeed = filteredEntries.filter((e) => e.speedKts && e.speedKts > 0);
        return withSpeed.length > 0 ? withSpeed.reduce((sum, e) => sum + (e.speedKts || 0), 0) / withSpeed.length : 0;
    }, [filteredEntries]);

    // ── Career Totals ───────────────────────────────────────────────────────
    // Only counts the user's own maritime voyages:
    //   1. Source must be 'device' (or undefined for legacy entries) — excludes imports & community
    //   2. Voyage's first entry must not be explicitly marked as land (isOnWater !== false)

    const careerTotals = useMemo(() => {
        // Merge career DB entries + current state entries (which include offline queue),
        // then deduplicate by entry ID. This ensures unsync'd entries still count.
        const combined = new Map<string, ShipLogEntry>();
        for (const e of careerEntries) {
            if (e.id) combined.set(e.id, e);
        }
        for (const e of state.entries) {
            if (e.id) combined.set(e.id, e);
        }
        const source = Array.from(combined.values());

        // Step 1: Filter to device-only entries
        const ownEntries = source.filter((e) => !e.source || e.source === 'device');

        // Step 2: Group into voyages
        const groups = groupEntriesByVoyage(ownEntries);

        // Step 3: Filter out land-based voyages (majority vote)
        // If ≥60% of entries with water data are on land, classify as land track.
        // This prevents coastal GPS jitter from misclassifying car drives as maritime.
        const maritimeGroups = groups.filter((g) => {
            const withWaterData = g.entries.filter((e) => e.isOnWater !== undefined);
            if (withWaterData.length === 0) return true; // No data → assume water (fail-open)
            const landCount = withWaterData.filter((e) => e.isOnWater === false).length;
            return landCount / withWaterData.length < 0.6; // ≥60% land → land track
        });

        let distance = 0;
        let timeMs = 0;
        maritimeGroups.forEach((g) => {
            distance += Math.max(0, ...g.entries.map((e) => e.cumulativeDistanceNM || 0));
            if (g.entries.length >= 2) {
                const sorted = [...g.entries].sort(
                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                );
                timeMs +=
                    new Date(sorted[sorted.length - 1].timestamp).getTime() - new Date(sorted[0].timestamp).getTime();
            }
        });
        return {
            totalDistance: distance,
            totalTimeAtSeaHrs: Math.round((timeMs / (1000 * 60 * 60)) * 10) / 10,
            totalVoyages: maritimeGroups.length,
        };
    }, [careerEntries, state.entries]);

    // ── Archive handlers ─────────────────────────────────────────────────────

    const handleArchiveVoyage = useCallback(
        async (voyageId: string) => {
            const success = await ShipLogService.archiveVoyage(voyageId);
            if (success) {
                // Immediately remove from active view
                dispatch({ type: 'UPDATE_ENTRIES', updater: (prev) => prev.filter((e) => e.voyageId !== voyageId) });
                toast.success('Voyage archived');
                reloadCareerData();
            } else {
                toast.error('Failed to archive voyage — check if the "archived" column exists in Supabase');
            }
        },
        [toast, reloadCareerData],
    );

    const handleUnarchiveVoyage = useCallback(
        async (voyageId: string) => {
            const success = await ShipLogService.unarchiveVoyage(voyageId);
            if (success) {
                await loadData();
                reloadCareerData();
                toast.success('Voyage restored');
            } else {
                toast.error('Failed to unarchive voyage');
            }
        },
        [loadData, reloadCareerData, toast],
    );

    // ── Public API ──────────────────────────────────────────────────────────

    return {
        // Raw state
        state,
        dispatch,

        // Settings (needed by JSX)
        settings,

        // Tracking
        handleStartTracking,
        startTrackingWithNewVoyage,
        continueLastVoyage,
        handlePauseTracking,
        handleToggleRapidMode,
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
        handleExportCSV,
        handleShare,
        handleExportThenDelete,
        handleExportGPX,
        handleImportGPXFile,
        handleShareToCommunity,

        // Derived state
        filteredEntries,
        groupedEntries,
        entryCounts,
        voyageGroups,
        hasNonDeviceEntries,
        totalDistance,
        avgSpeed,
        careerTotals,

        // Archive
        archivedVoyages,
        handleArchiveVoyage,
        handleUnarchiveVoyage,
    };
}
