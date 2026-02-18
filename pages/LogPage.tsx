/**
 * Log Page - Ship's GPS-based Log
 * 
 * Pure rendering shell — all state management lives in useLogPageState hook.
 * This file is ONLY responsible for JSX layout.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
    PlayIcon,

    StopIcon,
    CompassIcon,
    WindIcon
} from '../components/Icons';
import { AddEntryModal } from '../components/AddEntryModal';
import { useToast } from '../components/Toast';
import { VoyageStatsPanel } from '../components/VoyageStatsPanel';
import { DateGroupedTimeline } from '../components/DateGroupedTimeline';
import { EditEntryModal } from '../components/EditEntryModal';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { VoyageHeader } from '../components/VoyageHeader';
import { DeleteVoyageModal } from '../components/DeleteVoyageModal';
import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';
import { RegionAutocomplete } from '../components/RegionAutocomplete';
import { groupEntriesByDate } from '../utils/voyageData';
import { useLogPageState } from '../hooks/useLogPageState';
import { ShipLogEntry } from '../types';
import { t } from '../theme';
import { reverseGeocode } from '../services/weatherService';
import { reverseGeocodeContext } from '../services/weather/api/geocoding';

// Inline icons not in Icons.tsx
const PlusIcon = ({ className }: { className?: string }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
);

const AnchorIcon = ({ className }: { className?: string }) => (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
);


export const LogPage: React.FC = () => {
    const {
        state,
        dispatch,
        settings,
        // Tracking
        handleStartTracking,
        startTrackingWithNewVoyage,
        continueLastVoyage,

        handleToggleRapidMode,
        handleStopTracking,
        confirmStopVoyage,
        // Entry CRUD
        handleDeleteEntry,
        handleEditEntry,
        handleSaveEdit,
        loadData,
        // Voyage management
        toggleVoyage,
        handleDeleteVoyageRequest,
        handleConfirmDeleteVoyage,
        // Export / share
        handleExportCSV,
        handleShare,
        handleExportThenDelete,
        handleExportGPX,
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
    } = useLogPageState();

    const toast = useToast();
    const [isExportingPDF, setIsExportingPDF] = useState(false);
    const [isExportingGPX, setIsExportingGPX] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [showArchived, setShowArchived] = useState(false);

    // Share form auto-fill state
    const [shareAutoTitle, setShareAutoTitle] = useState('');
    const [shareAutoRegion, setShareAutoRegion] = useState('');
    const shareFormResetRef = useRef(0);

    // Destructure frequently used state for JSX readability
    const {
        entries, isTracking, isRapidMode, loading,
        showAddModal, showTrackMap, showStats, showStopVoyageDialog,
        showVoyageChoiceDialog, showCommunityBrowser, actionSheet,
        editEntry, selectedVoyageId, deleteVoyageId, currentVoyageId,
        expandedVoyages, gpsStatus, filters,
    } = state;

    // Auto-fill share form when panel opens
    useEffect(() => {
        if (actionSheet !== 'share' && actionSheet !== 'share_form') {
            setShareAutoTitle('');
            setShareAutoRegion('');
            return;
        }

        const targetEntries = selectedVoyageId
            ? entries.filter(e => e.voyageId === selectedVoyageId)
            : entries;

        if (targetEntries.length === 0) return;

        const sorted = [...targetEntries].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const resetId = ++shareFormResetRef.current;

        // Reverse geocode start and end for title
        (async () => {
            try {
                const [startName, endName] = await Promise.all([
                    first.waypointName && first.waypointName !== 'Voyage Start' && first.waypointName !== 'Latest Position'
                        ? Promise.resolve(first.waypointName)
                        : reverseGeocode(first.latitude, first.longitude),
                    last.id !== first.id
                        ? (last.waypointName && last.waypointName !== 'Voyage Start' && last.waypointName !== 'Latest Position'
                            ? Promise.resolve(last.waypointName)
                            : reverseGeocode(last.latitude, last.longitude))
                        : Promise.resolve(null),
                ]);
                if (resetId !== shareFormResetRef.current) return; // stale
                const title = endName && endName !== startName
                    ? `${startName || 'Unknown'} → ${endName}`
                    : startName || '';
                setShareAutoTitle(title);
            } catch { /* fallback to empty */ }
        })();

        // Auto-detect region from start location
        // GeoContext.name is already "City, State, Country" — extract region by dropping city
        (async () => {
            try {
                const ctx = await reverseGeocodeContext(first.latitude, first.longitude);
                if (resetId !== shareFormResetRef.current) return; // stale
                if (ctx && ctx.name) {
                    const parts = ctx.name.split(',').map(p => p.trim());
                    // Drop the city (first part) to get "State, Country"
                    const region = parts.length > 1 ? parts.slice(1).join(', ') : parts[0];
                    setShareAutoRegion(region);
                }
            } catch { /* fallback to empty */ }
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
        <div className="relative h-full bg-slate-950 overflow-hidden md:flex md:justify-center">
            {/* Fullscreen Statistics View */}
            {showStats ? (
                <div className="flex flex-col h-full">
                    <div className="flex items-center justify-between p-4 border-b border-white/10">
                        <h2 className="text-lg font-bold text-white">Voyage Statistics</h2>
                        <button
                            onClick={() => dispatch({ type: 'SHOW_STATS', show: false })}
                            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-auto p-4 md:p-8 flex flex-col justify-center md:max-w-3xl md:mx-auto">
                        {(() => {
                            const scopedEntries = selectedVoyageId
                                ? filteredEntries.filter(e => e.voyageId === selectedVoyageId)
                                : filteredEntries;
                            const scopedDistance = scopedEntries.length > 0
                                ? Math.max(...scopedEntries.map(e => e.cumulativeDistanceNM || 0))
                                : 0;
                            const speedEntries = scopedEntries.filter(e => e.speedKts);
                            const scopedAvgSpeed = speedEntries.length > 0
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
                        <VoyageStatsPanel entries={selectedVoyageId ? filteredEntries.filter(e => e.voyageId === selectedVoyageId) : filteredEntries} />
                    </div>
                </div>
            ) : (
                <div className="flex flex-col h-full">
                    {/* ── Header: SHIP'S LOG + 3-dot menu ── */}
                    <div className="shrink-0 px-4 pt-3 pb-2">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Ship's Log</h1>
                                {isTracking && (
                                    <span
                                        className={`w-2.5 h-2.5 rounded-full ${gpsStatus === 'locked'
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
                                                    <MenuBtn icon="⚡" label={isRapidMode ? 'Rapid Mode (ON)' : 'Rapid Mode'} onClick={() => { handleToggleRapidMode(); setShowMenu(false); }} accent={isRapidMode} />
                                                    <div className="border-t border-white/5" />
                                                </>
                                            )}
                                            <MenuBtn icon="📊" label="Statistics" onClick={() => { dispatch({ type: 'SET_ACTION_SHEET', sheet: 'stats' }); setShowMenu(false); }} disabled={entries.length === 0} />
                                            <MenuBtn icon="🗺" label="Track Map" onClick={() => { dispatch({ type: 'SHOW_TRACK_MAP', show: true }); setShowMenu(false); }} disabled={entries.length === 0} />
                                            <MenuBtn icon="📤" label="Export" onClick={() => { dispatch({ type: 'SET_ACTION_SHEET', sheet: 'export' }); setShowMenu(false); }} disabled={entries.length === 0} />
                                            <MenuBtn icon="🔗" label="Share" onClick={() => { dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share' }); setShowMenu(false); }} disabled={entries.length === 0} />
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* ── Career Totals Strip ── */}
                    <div className="shrink-0 px-4 pb-3">
                        <div className="rounded-2xl bg-slate-900/40 backdrop-blur-md border border-white/10 p-3">
                            <div className="flex items-center justify-center mb-2">
                                <span className="px-2.5 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/20 text-[10px] font-bold text-sky-400 uppercase tracking-widest">Career Totals</span>
                            </div>
                            <div className="grid grid-cols-3 divide-x divide-white/10">
                                <div className="text-center px-2">
                                    <div className="text-lg font-extrabold text-white">{(careerTotals.totalDistance ?? 0).toFixed(1)}</div>
                                    <div className="text-[10px] text-slate-500 uppercase tracking-wider">NM Sailed</div>
                                </div>
                                <div className="text-center px-2">
                                    <div className="text-lg font-extrabold text-white">{careerTotals.totalTimeAtSeaHrs < 24 ? `${careerTotals.totalTimeAtSeaHrs}h` : `${Math.round(careerTotals.totalTimeAtSeaHrs / 24)}d`}</div>
                                    <div className="text-[10px] text-slate-500 uppercase tracking-wider">At Sea</div>
                                </div>
                                <div className="text-center px-2">
                                    <div className="text-lg font-extrabold text-white">{careerTotals.totalVoyages}</div>
                                    <div className="text-[10px] text-slate-500 uppercase tracking-wider">Voyages</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ── Scrollable Voyage List ── */}
                    <div className="flex-1 overflow-y-auto px-4 pb-24">
                        {/* Live Recording Card */}
                        {isTracking && currentVoyageId && (() => {
                            const activeEntries = entries.filter(e => e.voyageId === currentVoyageId);
                            const dist = activeEntries.length > 0 ? Math.max(0, ...activeEntries.map(e => e.cumulativeDistanceNM || 0)) : 0;
                            const sorted = [...activeEntries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                            const first = sorted[0];
                            const last = sorted[sorted.length - 1];
                            const durationMs = first && last ? new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime() : 0;
                            const durationHrs = Math.floor(durationMs / 3600000);
                            const durationMins = Math.floor((durationMs % 3600000) / 60000);
                            const speeds = activeEntries.filter(e => e.speedKts && e.speedKts > 0);
                            const liveAvgSpeed = speeds.length > 0 ? speeds.reduce((s, e) => s + (e.speedKts || 0), 0) / speeds.length : 0;
                            return (
                                <div className="mb-4 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-slate-900/80 border border-emerald-500/20 p-4">
                                    <div className="flex items-center gap-2 mb-3">
                                        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                        <span className="text-xs font-bold text-red-400 uppercase tracking-wider">Live Recording</span>
                                    </div>
                                    {first?.waypointName && first.waypointName !== 'Voyage Start' && first.waypointName !== 'Latest Position' && (
                                        <div className="text-xs text-slate-400 mb-3">Departed: {first.waypointName}</div>
                                    )}
                                    <div className="grid grid-cols-3 gap-3">
                                        <div>
                                            <div className="text-2xl font-extrabold text-emerald-400">{(dist ?? 0).toFixed(1)}</div>
                                            <div className="text-[10px] text-slate-500 uppercase">NM</div>
                                        </div>
                                        <div>
                                            <div className="text-2xl font-extrabold text-emerald-400">{durationHrs}h {durationMins}m</div>
                                            <div className="text-[10px] text-slate-500 uppercase">Duration</div>
                                        </div>
                                        <div>
                                            <div className="text-2xl font-extrabold text-emerald-400">{(liveAvgSpeed ?? 0).toFixed(1)}</div>
                                            <div className="text-[10px] text-slate-500 uppercase">Avg kts</div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })()}

                        {/* Past Voyage Cards */}
                        {voyageGroups.length === 0 && !isTracking ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 px-6 py-16">
                                <div className="relative w-20 h-20 mb-5">
                                    <svg viewBox="0 0 96 96" fill="none" className="w-full h-full text-sky-500/30">
                                        <circle cx="48" cy="48" r="44" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" />
                                        <circle cx="48" cy="48" r="6" fill="currentColor" fillOpacity="0.3" />
                                        <path d="M48 8L52 44H44L48 8Z" fill="currentColor" fillOpacity="0.6" />
                                        <path d="M48 88L44 52H52L48 88Z" fill="currentColor" fillOpacity="0.3" />
                                    </svg>
                                </div>
                                <p className="text-base font-bold text-white mb-1">Your Voyage Awaits</p>
                                <p className="text-sm text-white/50 max-w-[240px] text-center">Start tracking to record GPS positions, waypoints, and voyage data.</p>
                            </div>
                        ) : (
                            voyageGroups
                                .filter(v => !(isTracking && v.voyageId === currentVoyageId))
                                .map(voyage => <VoyageCard key={voyage.voyageId} voyage={voyage} isSelected={selectedVoyageId === voyage.voyageId} isExpanded={expandedVoyages.has(voyage.voyageId)} onToggle={() => toggleVoyage(voyage.voyageId)} onSelect={() => dispatch({ type: 'SELECT_VOYAGE', voyageId: voyage.voyageId })} onDelete={() => handleDeleteVoyageRequest(voyage.voyageId)} onShowMap={() => { dispatch({ type: 'SELECT_VOYAGE', voyageId: voyage.voyageId }); dispatch({ type: 'SHOW_TRACK_MAP', show: true }); }} filteredEntries={filteredEntries} onDeleteEntry={handleDeleteEntry} onEditEntry={handleEditEntry} />)
                        )}

                        {/* ── Archived Voyages ── */}
                        {archivedVoyages.length > 0 && (
                            <div className="mt-4">
                                <button
                                    onClick={() => setShowArchived(!showArchived)}
                                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 active:scale-[0.98] transition-all"
                                >
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
                                        </svg>
                                        <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">Archived Voyages</span>
                                        <span className="text-[10px] font-bold text-amber-300/60 bg-amber-500/15 px-1.5 py-0.5 rounded-full">{archivedVoyages.length}</span>
                                    </div>
                                    <svg className={`w-4 h-4 text-amber-400 transition-transform ${showArchived ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                </button>

                                {showArchived && (
                                    <div className="mt-2 space-y-2">
                                        {archivedVoyages.map(voyage => (
                                            <div key={voyage.voyageId} className="rounded-2xl bg-slate-900/30 backdrop-blur-md border border-amber-500/10 p-4 flex items-center justify-between">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2 mb-0.5">
                                                        <span className="text-xs font-bold text-white/80">
                                                            {new Date(voyage.entries[voyage.entries.length - 1]?.timestamp || '').toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: '2-digit' }).toUpperCase()}
                                                        </span>
                                                        <span className="text-[9px] font-bold text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full uppercase">Archived</span>
                                                    </div>
                                                    <div className="text-[11px] text-white/50">
                                                        {voyage.entries.length} entries · {Math.max(0, ...voyage.entries.map(e => e.cumulativeDistanceNM || 0)).toFixed(1)} NM
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => handleUnarchiveVoyage(voyage.voyageId)}
                                                    className="px-3 py-1.5 rounded-lg text-[10px] font-bold text-amber-400 bg-amber-500/15 border border-amber-500/20 uppercase tracking-wider active:scale-[0.95] transition-all"
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
                </div>
            )}

            {/* Toast Notifications */}
            <toast.ToastContainer />

            {/* Start/Stop Tracking + New Entry — fixed above nav bar */}
            <div className="fixed left-0 right-0 z-[850] px-4 flex gap-2" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}>
                {isTracking ? (
                    <>
                        <button
                            onClick={handleStopTracking}
                            className="px-4 py-3 rounded-2xl font-extrabold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 active:scale-[0.97]"
                        >
                            <StopIcon className="w-4 h-4" />
                            Stop
                        </button>
                        <button
                            onClick={() => dispatch({ type: 'SHOW_ADD_MODAL', show: true })}
                            className="flex-1 px-4 py-3 rounded-2xl font-extrabold text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98]"
                        >
                            <PlusIcon className="w-5 h-5" />
                            New Log Entry
                        </button>
                    </>
                ) : (
                    <button
                        onClick={handleStartTracking}
                        className="flex-1 px-4 py-3.5 rounded-2xl font-extrabold text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-400 hover:to-green-500 text-white shadow-lg shadow-emerald-500/25 active:scale-[0.98]"
                    >
                        <PlayIcon className="w-5 h-5" />
                        Start Tracking
                    </button>
                )}
            </div>

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
                entries={selectedVoyageId ? entries.filter(e => e.voyageId === selectedVoyageId) : entries}
            />

            {/* Community Track Browser */}
            <CommunityTrackBrowser
                isOpen={showCommunityBrowser}
                onClose={() => dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: false })}
                onImportComplete={loadData}
                onLocalImport={() => { dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: false }); }}
            />

            {/* ========== ACTION SHEET MODALS ========== */}

            {/* EXPORT ACTION SHEET — full screen panel */}
            {actionSheet === 'export' && (
                <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
                    {/* Header bar */}
                    <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-sky-500/20 flex items-center justify-center">
                                    <svg className="w-4.5 h-4.5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                </div>
                                <h2 className="text-lg font-bold text-white">Export Voyage</h2>
                            </div>
                            <button
                                onClick={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                                className="p-2 text-slate-400 hover:text-white transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <p className="text-sm text-slate-400 mt-2">
                            {selectedVoyageId ? 'Export the selected voyage' : 'Export all voyage data'}
                        </p>
                    </div>

                    {/* Content — vertically centered */}
                    <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                        <div className="space-y-4 max-w-lg mx-auto w-full">
                            {/* PDF Card — disabled for imported/community tracks (provenance) */}
                            <button
                                onClick={async () => {
                                    if (!hasNonDeviceEntries && !isExportingPDF) {
                                        setIsExportingPDF(true);
                                        try {
                                            await handleShare();
                                        } finally {
                                            setIsExportingPDF(false);
                                        }
                                        dispatch({ type: 'SET_ACTION_SHEET', sheet: null });
                                    }
                                }}
                                disabled={hasNonDeviceEntries}
                                className={`w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all relative overflow-hidden ${hasNonDeviceEntries || isExportingPDF
                                    ? 'bg-slate-800/30 border-slate-700/30 cursor-not-allowed opacity-50'
                                    : 'bg-gradient-to-r from-sky-500/15 to-sky-600/5 border-sky-500/20 hover:border-sky-400/40'
                                    }`}
                            >
                                <div className="w-14 h-14 rounded-xl bg-sky-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-6 4h4" />
                                    </svg>
                                </div>
                                {isExportingPDF && (
                                    <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center z-10">
                                        <div className="flex items-center gap-3">
                                            <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
                                            <span className="text-sky-300 text-sm font-medium">Generating PDF…</span>
                                        </div>
                                    </div>
                                )}
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">Official Deck Log</div>
                                    {hasNonDeviceEntries ? (
                                        <div className="text-amber-400 text-sm mt-1">⚠️ Unavailable — contains imported or community data</div>
                                    ) : (
                                        <div className="text-slate-400 text-sm mt-1">PDF with charts, positions &amp; weather data</div>
                                    )}
                                </div>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>

                            {/* GPX Card */}
                            <button
                                onClick={async () => {
                                    if (!isExportingGPX) {
                                        setIsExportingGPX(true);
                                        try {
                                            await handleExportGPX();
                                        } finally {
                                            setIsExportingGPX(false);
                                        }
                                    }
                                }}
                                className={`w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all relative overflow-hidden ${isExportingGPX
                                    ? 'bg-slate-800/30 border-slate-700/30 cursor-not-allowed opacity-50'
                                    : 'bg-gradient-to-r from-emerald-500/15 to-emerald-600/5 border-emerald-500/20 hover:border-emerald-400/40'
                                    }`}
                            >
                                <div className="w-14 h-14 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                                    </svg>
                                </div>
                                {isExportingGPX && (
                                    <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center z-10">
                                        <div className="flex items-center gap-3">
                                            <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div>
                                            <span className="text-emerald-300 text-sm font-medium">Exporting GPX…</span>
                                        </div>
                                    </div>
                                )}
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">GPS Track (GPX)</div>
                                    <div className="text-slate-400 text-sm mt-1">Import into OpenCPN, Navionics, or any chartplotter</div>
                                </div>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* SHARE ACTION SHEET — card menu matching Export layout */}
            {actionSheet === 'share' && (
                <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
                    {/* Header bar */}
                    <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center">
                                    <svg className="w-4.5 h-4.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                    </svg>
                                </div>
                                <h2 className="text-lg font-bold text-white">Share</h2>
                            </div>
                            <button
                                onClick={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                                className="p-2 text-slate-400 hover:text-white transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <p className="text-sm text-slate-400 mt-2">
                            {selectedVoyageId ? 'Share the selected voyage' : 'Share your voyage data with the community'}
                        </p>
                    </div>

                    {/* Content — vertically centered */}
                    <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                        <div className="space-y-4 max-w-lg mx-auto w-full">
                            {/* Community Share Card */}
                            <button
                                onClick={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share_form' })}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all bg-gradient-to-r from-violet-500/15 to-violet-600/5 border-violet-500/20 hover:border-violet-400/40"
                            >
                                <div className="w-14 h-14 rounded-xl bg-violet-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">Community Share</div>
                                    <div className="text-slate-400 text-sm mt-1">Share your track, route, or anchorage with others</div>
                                </div>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>

                            {/* Browse Community Card */}
                            <button
                                onClick={() => { dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true }); dispatch({ type: 'SET_ACTION_SHEET', sheet: null }); }}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all bg-gradient-to-r from-cyan-500/15 to-cyan-600/5 border-cyan-500/20 hover:border-cyan-400/40"
                            >
                                <div className="w-14 h-14 rounded-xl bg-cyan-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">Browse Community</div>
                                    <div className="text-slate-400 text-sm mt-1">Discover and import anchorages, passages & routes</div>
                                </div>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* SHARE FORM ACTION SHEET — full screen panel */}
            {actionSheet === 'share_form' && (
                <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
                    <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-2">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <button
                                    onClick={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: 'share' })}
                                    className="p-1.5 text-slate-400 hover:text-white transition-colors -ml-1"
                                >
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                    </svg>
                                </button>
                                <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center">
                                    <svg className="w-4.5 h-4.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                    </svg>
                                </div>
                                <h2 className="text-lg font-bold text-white">Community Share</h2>
                            </div>
                            <button
                                onClick={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                                className="p-2 text-slate-400 hover:text-white transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto px-4 py-3">
                        <div className="space-y-3 max-w-lg mx-auto w-full">

                            {/* Offline Banner */}
                            {typeof navigator !== 'undefined' && !navigator.onLine && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium">
                                    <span>📡</span>
                                    <span>Sharing requires internet. Your tracks are saved locally.</span>
                                </div>
                            )}

                            {/* Share Track Form */}
                            <div className="rounded-2xl bg-gradient-to-b from-violet-500/10 to-slate-900/80 border border-violet-500/20 p-4 space-y-3">

                                {/* Title */}
                                <div>
                                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Title *</label>
                                    <input
                                        id="share-title"
                                        type="text"
                                        placeholder={shareAutoTitle || 'e.g. "Moreton Bay Anchorage"'}
                                        className="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all"
                                    />
                                </div>

                                {/* Description */}
                                <div>
                                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Description</label>
                                    <textarea
                                        id="share-description"
                                        rows={2}
                                        placeholder="Brief description of the route, conditions, or points of interest..."
                                        className="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all resize-none"
                                    />
                                </div>

                                {/* Category + Region — side by side */}
                                <div className="flex gap-3">
                                    <div className="flex-1">
                                        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Category</label>
                                        <select
                                            id="share-category"
                                            defaultValue="coastal"
                                            className="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white text-sm font-medium focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all appearance-none cursor-pointer"
                                            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
                                        >
                                            <option value="anchorage">⚓ Anchorage</option>
                                            <option value="port_entry">🏗 Port Entry</option>
                                            <option value="bar_crossing">🌊 Bar Crossing</option>
                                            <option value="reef_passage">🪸 Reef Passage</option>
                                            <option value="coastal">🏖 Coastal</option>
                                            <option value="offshore">🌊 Offshore</option>
                                            <option value="walking">🚶 Walking</option>
                                            <option value="driving">🚗 Driving</option>
                                        </select>
                                    </div>
                                    <div className="flex-1">
                                        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Region</label>
                                        <RegionAutocomplete
                                            id="share-region"
                                            defaultValue={shareAutoRegion}
                                            placeholder='e.g. "QLD, Australia"'
                                            inputClassName="w-full px-3 py-2.5 rounded-xl bg-slate-800/80 border border-white/10 text-white placeholder-slate-500 text-sm font-medium focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 transition-all"
                                        />
                                    </div>
                                </div>

                                {/* Submit Button */}
                                <button
                                    onClick={() => {
                                        const rawTitle = (document.getElementById('share-title') as HTMLInputElement)?.value?.trim();
                                        const title = rawTitle || shareAutoTitle; // fallback to auto-fill
                                        const description = (document.getElementById('share-description') as HTMLTextAreaElement)?.value?.trim() || '';
                                        const category = (document.getElementById('share-category') as HTMLSelectElement)?.value || 'coastal';
                                        const region = (document.getElementById('share-region') as HTMLInputElement)?.value?.trim() || shareAutoRegion;
                                        if (!title) {
                                            (document.getElementById('share-title') as HTMLInputElement)?.focus();
                                            return;
                                        }
                                        handleShareToCommunity({ title, description, category: category as any, region });
                                    }}
                                    className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-600 to-amber-500 text-white font-bold text-sm tracking-wide shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40 active:scale-[0.98] transition-all"
                                >
                                    🚀 Share Track
                                </button>
                            </div>

                            {/* Browse Community */}
                            <button
                                onClick={() => { dispatch({ type: 'SHOW_COMMUNITY_BROWSER', show: true }); dispatch({ type: 'SET_ACTION_SHEET', sheet: null }); }}
                                className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl bg-gradient-to-r from-cyan-500/15 to-cyan-600/5 border border-cyan-500/20 hover:border-cyan-400/40 active:scale-[0.98] transition-all"
                            >
                                <div className="w-10 h-10 rounded-xl bg-cyan-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-5 h-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-sm">Browse Community</div>
                                    <div className="text-slate-400 text-xs">Discover anchorages, passages &amp; routes</div>
                                </div>
                                <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            )}


            {/* STATS ACTION SHEET — full screen panel */}
            {actionSheet === 'stats' && (
                <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
                    <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                                    <svg className="w-4.5 h-4.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                    </svg>
                                </div>
                                <h2 className="text-lg font-bold text-white">Voyage Statistics</h2>
                            </div>
                            <button
                                onClick={() => dispatch({ type: 'SET_ACTION_SHEET', sheet: null })}
                                className="p-2 text-slate-400 hover:text-white transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <p className="text-sm text-slate-400 mt-2">Analyze your sailing performance</p>
                    </div>

                    <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                        <div className="space-y-4 max-w-lg mx-auto w-full">
                            {(() => {
                                // Use the highlighted card, or fall back to active/first voyage
                                const effectiveVoyageId = selectedVoyageId || currentVoyageId || voyageGroups[0]?.voyageId || null;
                                const voyageEntryCount = effectiveVoyageId ? entries.filter(e => e.voyageId === effectiveVoyageId).length : 0;
                                return (
                                    <button
                                        onClick={() => { dispatch({ type: 'SELECT_VOYAGE', voyageId: effectiveVoyageId }); dispatch({ type: 'SHOW_STATS', show: true }); dispatch({ type: 'SET_ACTION_SHEET', sheet: null }); }}
                                        className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-amber-500/15 to-amber-600/5 border border-amber-500/20 hover:border-amber-400/40 active:scale-[0.98] transition-all"
                                    >
                                        <div className="w-14 h-14 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                                            <svg className="w-7 h-7 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                            </svg>
                                        </div>
                                        <div className="flex-1 text-left">
                                            <div className="text-white font-bold text-lg">Selected Voyage</div>
                                            <div className="text-slate-400 text-sm mt-1">Stats for the highlighted track</div>
                                        </div>
                                        {voyageEntryCount > 0 && (
                                            <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-400 text-xs font-bold">
                                                {voyageEntryCount} pts
                                            </span>
                                        )}
                                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                        </svg>
                                    </button>
                                );
                            })()}

                            {/* All Voyages Card */}
                            <button
                                onClick={() => { dispatch({ type: 'SELECT_VOYAGE', voyageId: null }); dispatch({ type: 'SHOW_STATS', show: true }); dispatch({ type: 'SET_ACTION_SHEET', sheet: null }); }}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-purple-500/15 to-purple-600/5 border border-purple-500/20 hover:border-purple-400/40 active:scale-[0.98] transition-all"
                            >
                                <div className="w-14 h-14 rounded-xl bg-purple-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">All Voyages</div>
                                    <div className="text-slate-400 text-sm mt-1">Combined statistics across every voyage</div>
                                </div>
                                <span className="px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-400 text-xs font-bold">
                                    {entries.length} pts
                                </span>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Voyage Choice Dialog - Continue or New */}
            {showVoyageChoiceDialog && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-slate-800 rounded-2xl border border-white/10 p-6 max-w-sm w-full shadow-2xl">
                        <h3 className="text-xl font-bold text-white mb-2 text-center">Start Tracking</h3>
                        <p className="text-slate-400 text-sm text-center mb-6">
                            You have an existing voyage. Would you like to continue it or start a new one?
                        </p>

                        <div className="space-y-3">
                            <button
                                onClick={continueLastVoyage}
                                className="w-full py-3 bg-sky-600 hover:bg-sky-700 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                Continue Last Voyage
                            </button>

                            <button
                                onClick={async () => {
                                    dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false });
                                    await startTrackingWithNewVoyage();
                                }}
                                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                                Start New Voyage
                            </button>

                            <button
                                onClick={() => dispatch({ type: 'SHOW_VOYAGE_CHOICE', show: false })}
                                className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl font-bold transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Stop Voyage Confirmation Dialog */}
            {showStopVoyageDialog && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-slate-800 rounded-2xl border border-white/10 p-6 max-w-sm w-full shadow-2xl">
                        <h3 className="text-lg font-bold text-white mb-2">End Voyage?</h3>
                        <p className="text-slate-400 text-sm mb-6">
                            This will finalize your voyage log. You won't be able to add more entries to this voyage.
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => dispatch({ type: 'SHOW_STOP_DIALOG', show: false })}
                                className="flex-1 py-3 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl font-bold transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmStopVoyage}
                                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold transition-colors"
                            >
                                End Voyage
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Voyage Confirmation Modal */}
            {deleteVoyageId && (() => {
                const voyageEntries = entries.filter(e => e.voyageId === deleteVoyageId);
                const sortedEntries = [...voyageEntries].sort((a, b) =>
                    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                );
                const first = sortedEntries[0];
                const last = sortedEntries[sortedEntries.length - 1];
                const startDate = first ? new Date(first.timestamp) : new Date();
                const endDate = last ? new Date(last.timestamp) : new Date();
                const totalDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
                const voyageTotalDistance = Math.max(...voyageEntries.map(e => e.cumulativeDistanceNM || 0), 0);

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
                            totalDistance: voyageTotalDistance
                        }}
                    />
                );
            })()}
        </div>
    );
};

// --- SUB-COMPONENTS ---

const StatBox: React.FC<{ label: string; value: string | number }> = React.memo(({ label, value }) => (
    <div className="bg-slate-800 rounded-lg p-3 text-center">
        <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">{label}</div>
        <div className="text-xl font-bold text-white">{value}</div>
    </div>
));

const LogEntryCard: React.FC<{ entry: ShipLogEntry }> = React.memo(({ entry }) => {
    const timestamp = new Date(entry.timestamp);
    const timeStr = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const typeColors = {
        auto: 'bg-green-500/20 text-green-400 border-green-500/30',
        manual: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
        waypoint: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    };

    return (
        <div className="bg-slate-800/40 rounded-lg p-3 border border-white/5 mb-2">
            <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold border ${typeColors[entry.entryType]}`}>
                        {entry.entryType.toUpperCase()}
                    </span>
                    <span className="text-sm text-white">{timeStr}</span>
                    <span className="text-xs text-slate-500">{dateStr}</span>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-1 text-slate-400">
                    <CompassIcon className="w-3 h-3" rotation={0} />
                    {entry.latitude?.toFixed(4)}°, {entry.longitude?.toFixed(4)}°
                </div>
                {entry.speedKts !== null && (
                    <div className="flex items-center gap-1 text-slate-400">
                        <span>Speed: {(entry.speedKts ?? 0).toFixed(1)} kts</span>
                    </div>
                )}
                {entry.windSpeed !== null && entry.windSpeed !== undefined && (
                    <div className="flex items-center gap-1 text-slate-400">
                        <WindIcon className="w-3 h-3" />
                        {entry.windSpeed} kts {entry.windDirection}°
                    </div>
                )}
                {entry.notes && (
                    <div className="col-span-2 text-slate-300 italic">
                        {entry.notes}
                    </div>
                )}
            </div>
        </div>
    );
});

// ── MenuBtn — overflow menu item ──

const MenuBtn: React.FC<{
    icon: string;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    accent?: boolean;
}> = React.memo(({ icon, label, onClick, disabled, danger, accent }) => (
    <button
        onClick={onClick}
        disabled={disabled}
        className={`w-full px-4 py-3 text-left text-sm font-medium flex items-center gap-3 transition-colors ${disabled
            ? 'text-slate-600 cursor-not-allowed'
            : danger
                ? 'text-red-400 hover:bg-red-500/10'
                : accent
                    ? 'text-amber-400 hover:bg-amber-500/10'
                    : 'text-slate-300 hover:bg-white/5'
            }`}
    >
        <span className="text-base">{icon}</span>
        {label}
    </button>
));

// ── VoyageCard — compact past voyage summary ──

const VoyageCard: React.FC<{
    voyage: { voyageId: string; entries: ShipLogEntry[] };
    isSelected: boolean;
    isExpanded: boolean;
    onToggle: () => void;
    onSelect: () => void;
    onDelete: () => void;
    onShowMap: () => void;
    filteredEntries: ShipLogEntry[];
    onDeleteEntry: (id: string) => void;
    onEditEntry: (entry: ShipLogEntry) => void;
}> = React.memo(({ voyage, isSelected, isExpanded, onToggle, onSelect, onDelete, onShowMap, filteredEntries, onDeleteEntry, onEditEntry }) => {
    // --- Swipe-to-delete ---
    const [swipeOffset, setSwipeOffset] = useState(0);
    const touchStartX = useRef(0);
    const deleteThreshold = 80;
    const handleSwipeStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0].clientX; };
    const handleSwipeMove = (e: React.TouchEvent) => {
        const diff = touchStartX.current - e.touches[0].clientX;
        setSwipeOffset(Math.max(0, Math.min(diff, deleteThreshold + 20)));
    };
    const handleSwipeEnd = () => { setSwipeOffset(s => s >= deleteThreshold ? deleteThreshold : 0); };

    const sorted = [...voyage.entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const dist = Math.max(0, ...voyage.entries.map(e => e.cumulativeDistanceNM || 0));
    const durationMs = first && last ? new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime() : 0;
    const durationHrs = Math.floor(durationMs / 3600000);
    const durationMins = Math.floor((durationMs % 3600000) / 60000);
    const durationLabel = durationHrs >= 24 ? `${Math.ceil(durationHrs / 24)}d` : `${durationHrs}h ${durationMins}m`;
    const dateLabel = first ? new Date(first.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';
    const hasManual = voyage.entries.some(e => e.entryType === 'manual');
    const speedEntries = voyage.entries.filter(e => e.speedKts);
    const avgSpeed = speedEntries.length > 0
        ? speedEntries.reduce((sum, e) => sum + (e.speedKts || 0), 0) / speedEntries.length
        : 0;

    // Detect imported/community tracks (not official device data)
    const isImported = voyage.entries.some(e => e.source && e.source !== 'device');

    const startName = first?.waypointName && first.waypointName !== 'Voyage Start' && first.waypointName !== 'Latest Position' ? first.waypointName : null;
    const endName = last?.waypointName && last.waypointName !== 'Voyage Start' && last.waypointName !== 'Latest Position' ? last.waypointName : null;

    const voyageFilteredEntries = voyage.entries.filter(e => filteredEntries.some(f => f.id === e.id));

    return (
        <div className="mb-3 relative overflow-hidden rounded-2xl">
            {/* Delete button revealed on swipe-left */}
            <button
                onClick={() => { setSwipeOffset(0); onDelete(); }}
                className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-2xl transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            >
                <div className="flex flex-col items-center gap-1">
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span className="text-[10px] font-bold text-white uppercase">Delete</span>
                </div>
            </button>
            <div
                className={`w-full rounded-2xl overflow-hidden transition-all flex relative backdrop-blur-md ${isImported
                    ? (isExpanded
                        ? 'bg-amber-900/30 border border-amber-500/30'
                        : 'bg-amber-950/30 border border-amber-500/15 hover:border-amber-500/25')
                    : (isExpanded
                        ? 'bg-slate-800/50 border border-sky-500/30'
                        : 'bg-slate-900/40 border border-white/5 hover:border-white/15')
                    }`}
                style={{ transform: `translateX(-${swipeOffset}px)`, transition: swipeOffset === 0 || swipeOffset === deleteThreshold ? 'transform 0.2s ease-out' : 'none' }}
                onTouchStart={handleSwipeStart}
                onTouchMove={handleSwipeMove}
                onTouchEnd={handleSwipeEnd}
            >
                {/* LEFT — route info, expands timeline */}
                <button
                    onClick={() => { if (swipeOffset === 0) onToggle(); else setSwipeOffset(0); }}
                    className="flex-1 p-4 text-left min-w-0"
                >
                    <div className="flex items-start justify-between mb-1">
                        <div className="text-[11px] text-slate-500 uppercase tracking-wider font-medium">{dateLabel}</div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-base font-extrabold text-white">{(dist ?? 0).toFixed(1)} <span className="text-[10px] text-slate-400 font-normal">NM</span></span>
                            <span className="text-[10px] text-slate-600">|</span>
                            <span className="text-xs font-bold text-slate-300">{durationLabel}</span>
                        </div>
                    </div>
                    {(startName || endName) && (
                        <div className="text-sm text-slate-300 mb-1 truncate">
                            {startName || '—'} → {endName || '—'}
                        </div>
                    )}
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500">{voyage.entries.length} entries</span>
                        {avgSpeed > 0 && <span className="text-[10px] text-slate-500">· {(avgSpeed ?? 0).toFixed(1)} kts avg</span>}
                        {hasManual && (
                            <span className="px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/20 text-[9px] font-bold text-purple-400 uppercase">Manual</span>
                        )}
                        {isImported && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/20 text-[9px] font-bold text-amber-400 uppercase">Imported</span>
                        )}
                    </div>
                    {isImported && (
                        <div className="text-[9px] text-amber-400/60 mt-1">⚠ Unverified track — not from onboard GPS</div>
                    )}
                </button>

                {/* RIGHT — map button */}
                <button
                    onClick={() => { if (swipeOffset === 0) onShowMap(); else setSwipeOffset(0); }}
                    className="shrink-0 w-14 flex flex-col items-center justify-center border-l border-white/5 hover:bg-white/5 transition-colors text-slate-400 hover:text-sky-400"
                    title="View on map"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                    </svg>
                    <span className="text-[8px] uppercase font-bold tracking-wider mt-0.5">Map</span>
                </button>
            </div>

            {/* Expanded: show full timeline */}
            {isExpanded && (
                <div className="ml-2 border-l-2 border-sky-500/20 pl-3 mt-1 mb-1">
                    <DateGroupedTimeline
                        groupedEntries={groupEntriesByDate(voyageFilteredEntries)}
                        onDeleteEntry={onDeleteEntry}
                        onEditEntry={onEditEntry}
                        voyageFirstEntryId={voyage.entries[voyage.entries.length - 1]?.id}
                        voyageLastEntryId={voyage.entries[0]?.id}
                    />
                </div>
            )}
        </div>
    );
});
