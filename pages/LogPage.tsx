/**
 * Log Page - Ship's GPS-based Log
 *
 * Pure rendering shell — all state management lives in useLogPageState hook.
 * This file is ONLY responsible for JSX layout.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../utils/createLogger';

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
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useLogPageState } from '../hooks/useLogPageState';
import { ShipLogEntry } from '../types';

import { reverseGeocode } from '../services/weatherService';
import { reverseGeocodeContext } from '../services/weather/api/geocoding';
import { VoyageCard, StatBox, MenuBtn } from './log/LogSubComponents';
import { VoyageChoiceDialog, StopVoyageDialog } from './log/VoyageDialogs';
import { ExportSheet } from './log/ExportSheet';
import { GpsDisclaimerModal } from './log/GpsDisclaimerModal';
import { ImportSheet } from './log/ImportSheet';
import { ShareSheet } from './log/ShareSheet';
import { ShareFormSheet } from './log/ShareFormSheet';
import { StatsSheet } from './log/StatsSheet';

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
    const {
        state,
        dispatch,
        settings: _settings,
        // Tracking
        handleStartTracking,
        startTrackingWithNewVoyage,
        continueLastVoyage,

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
        voyageGroups,
        hasNonDeviceEntries,
        totalDistance: _totalDistance,
        avgSpeed: _avgSpeed,
        careerTotals,
        // Archive
        archivedVoyages,
        handleArchiveVoyage,
        handleUnarchiveVoyage,
    } = useLogPageState();

    const toast = useToast();
    const [showMenu, setShowMenu] = useState(false);
    const [showArchived, setShowArchived] = useState(false);

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

    // Destructure frequently used state for JSX readability
    const {
        entries,
        isTracking,
        isRapidMode,
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

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

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
                            const scopedEntries = selectedVoyageId
                                ? filteredEntries.filter((e) => e.voyageId === selectedVoyageId)
                                : filteredEntries;

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
                    {/* ── Header: SHIP'S LOG + 3-dot menu ── */}
                    <div className="shrink-0 px-4 pt-3 pb-2">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {onBack && (
                                    <button
                                        aria-label="Go back"
                                        onClick={onBack}
                                        className="p-1.5 -ml-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                    >
                                        <svg
                                            className="w-5 h-5"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M15.75 19.5L8.25 12l7.5-7.5"
                                            />
                                        </svg>
                                    </button>
                                )}
                                <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">
                                    Ship's Log
                                </h1>
                                {isTracking && (
                                    <span
                                        className={`w-2.5 h-2.5 rounded-full ${
                                            gpsStatus === 'locked'
                                                ? 'bg-emerald-400 animate-pulse'
                                                : gpsStatus === 'stale'
                                                  ? 'bg-amber-400 animate-pulse'
                                                  : 'bg-red-500 animate-pulse'
                                        }`}
                                    />
                                )}
                            </div>
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
                                            {isTracking && (
                                                <>
                                                    <MenuBtn
                                                        icon="⚡"
                                                        label={isRapidMode ? 'Rapid Mode (ON)' : 'Rapid Mode'}
                                                        onClick={() => {
                                                            handleToggleRapidMode();
                                                            setShowMenu(false);
                                                        }}
                                                        accent={isRapidMode}
                                                    />
                                                    <div className="border-t border-white/5" />
                                                </>
                                            )}
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
                        </div>
                    </div>

                    {/* ── Career Totals Strip ── */}
                    <div className="shrink-0 px-4 pb-3">
                        <div className="rounded-2xl bg-gradient-to-r from-sky-500/15 via-indigo-500/10 to-purple-500/15 backdrop-blur-md border border-sky-400/20 p-3">
                            <div className="flex items-center justify-center mb-2">
                                <span className="px-2.5 py-0.5 rounded-full bg-sky-500/25 border border-sky-400/30 text-[11px] font-bold text-sky-300 uppercase tracking-widest shadow-[0_0_8px_rgba(56,189,248,0.15)]">
                                    Career Totals
                                </span>
                            </div>
                            <div className="grid grid-cols-3 divide-x divide-white/10">
                                <div className="text-center px-2">
                                    <div className="text-lg font-extrabold text-sky-300">
                                        {(careerTotals.totalDistance ?? 0).toFixed(1)}
                                    </div>
                                    <div className="text-[11px] text-white/60 uppercase tracking-wider font-medium">
                                        NM Sailed
                                    </div>
                                </div>
                                <div className="text-center px-2">
                                    <div className="text-lg font-extrabold text-emerald-300">
                                        {careerTotals.totalTimeAtSeaHrs < 24
                                            ? `${careerTotals.totalTimeAtSeaHrs}h`
                                            : `${Math.round(careerTotals.totalTimeAtSeaHrs / 24)}d`}
                                    </div>
                                    <div className="text-[11px] text-white/60 uppercase tracking-wider font-medium">
                                        At Sea
                                    </div>
                                </div>
                                <div className="text-center px-2">
                                    <div className="text-lg font-extrabold text-amber-300">
                                        {careerTotals.totalVoyages}
                                    </div>
                                    <div className="text-[11px] text-white/60 uppercase tracking-wider font-medium">
                                        Voyages
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

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
                                                    <div className="text-2xl font-extrabold text-emerald-400">
                                                        {(dist ?? 0).toFixed(1)}
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">NM</div>
                                                </div>
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400">
                                                        {durationHrs}h {durationMins}m
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">Duration</div>
                                                </div>
                                                <div>
                                                    <div className="text-2xl font-extrabold text-emerald-400">
                                                        {(liveAvgSpeed ?? 0).toFixed(1)}
                                                    </div>
                                                    <div className="text-[11px] text-slate-500 uppercase">Avg kts</div>
                                                </div>
                                            </div>
                                            {/* Live Mini Map — grows to fill all remaining space */}
                                            <div className="mt-3 flex-1 min-h-[100px]">
                                                <LiveMiniMap entries={activeEntries} height="100%" isLive={true} />
                                            </div>
                                        </div>
                                    );
                                })()}

                            {/* ── Stop / New Entry — pinned at bottom ── */}
                            <div
                                className="shrink-0 px-4 pt-2"
                                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
                            >
                                <div className="flex gap-2">
                                    <button
                                        aria-label="Stop tracking"
                                        onClick={handleStopTracking}
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
                                {/* Past Voyage Cards */}
                                {voyageGroups.length === 0 ? (
                                    <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-16">
                                        <div className="relative w-20 h-20 mb-5">
                                            <svg
                                                viewBox="0 0 96 96"
                                                fill="none"
                                                className="w-full h-full text-sky-500/30"
                                            >
                                                <circle
                                                    cx="48"
                                                    cy="48"
                                                    r="44"
                                                    stroke="currentColor"
                                                    strokeWidth="1.5"
                                                    strokeDasharray="4 4"
                                                />
                                                <circle cx="48" cy="48" r="6" fill="currentColor" fillOpacity="0.3" />
                                                <path d="M48 8L52 44H44L48 8Z" fill="currentColor" fillOpacity="0.6" />
                                                <path
                                                    d="M48 88L44 52H52L48 88Z"
                                                    fill="currentColor"
                                                    fillOpacity="0.3"
                                                />
                                            </svg>
                                        </div>
                                        <p className="text-base font-bold text-white mb-1">Your Voyage Awaits</p>
                                        <p className="text-sm text-white/60 max-w-[240px] text-center">
                                            Start tracking to record GPS positions, waypoints, and voyage data.
                                        </p>
                                    </div>
                                ) : (
                                    voyageGroups.map((voyage) => (
                                        <VoyageCard
                                            key={voyage.voyageId}
                                            voyage={voyage}
                                            isSelected={selectedVoyageId === voyage.voyageId}
                                            isExpanded={expandedVoyages.has(voyage.voyageId)}
                                            onToggle={() => toggleVoyage(voyage.voyageId)}
                                            onSelect={() =>
                                                dispatch({ type: 'SELECT_VOYAGE', voyageId: voyage.voyageId })
                                            }
                                            onDelete={() => handleDeleteVoyageRequest(voyage.voyageId)}
                                            onArchive={() => handleArchiveVoyage(voyage.voyageId)}
                                            onShowMap={() => {
                                                dispatch({ type: 'SELECT_VOYAGE', voyageId: voyage.voyageId });
                                                dispatch({ type: 'SHOW_TRACK_MAP', show: true });
                                            }}
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
                                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
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
                entries={selectedVoyageId ? entries.filter((e) => e.voyageId === selectedVoyageId) : entries}
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
                    onSelectVoyage={(id) => dispatch({ type: 'SELECT_VOYAGE', voyageId: id })}
                    onShowStats={() => dispatch({ type: 'SHOW_STATS', show: true })}
                    entries={entries}
                    selectedVoyageId={selectedVoyageId}
                    currentVoyageId={currentVoyageId ?? null}
                    voyageGroups={voyageGroups}
                />
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
