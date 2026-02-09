/**
 * Log Page - Ship's GPS-based Log
 * Displays automatic voyage tracking with 15-minute GPS intervals
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ShipLogService } from '../services/ShipLogService';
import { ShipLogEntry } from '../types';
import {
    PlayIcon,
    PauseIcon,
    StopIcon,
    CompassIcon,
    WindIcon
} from '../components/Icons';
import { AddEntryModal } from '../components/AddEntryModal';
import { exportToCSV, sharePDF } from '../utils/logExport';
import { useToast } from '../components/Toast';
import { VoyageStatsPanel } from '../components/VoyageStatsPanel';
import { LogFilterToolbar, LogFilters } from '../components/LogFilterToolbar';
import { DateGroupedTimeline } from '../components/DateGroupedTimeline';
import { EditEntryModal } from '../components/EditEntryModal';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { VoyageHeader } from '../components/VoyageHeader';
import { DeleteVoyageModal } from '../components/DeleteVoyageModal';
import { CommunityTrackBrowser } from '../components/CommunityTrackBrowser';
import { groupEntriesByDate, filterEntriesByType, searchEntries } from '../utils/voyageData';
import { useSettings } from '../context/SettingsContext';
import { exportVoyageAsGPX, shareGPXFile } from '../services/gpxService';
import { TrackSharingService, SharedTrackInput } from '../services/TrackSharingService';

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
    const [entries, setEntries] = useState<ShipLogEntry[]>([]);
    const [isTracking, setIsTracking] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [isRapidMode, setIsRapidMode] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const [editEntry, setEditEntry] = useState<ShipLogEntry | null>(null);
    const [showTrackMap, setShowTrackMap] = useState(false);
    const [loading, setLoading] = useState(true);
    const [showStats, setShowStats] = useState(false);
    const [filters, setFilters] = useState<LogFilters>({
        types: ['auto', 'manual', 'waypoint'],
        searchQuery: ''
    });

    // Voyage management state
    const [expandedVoyages, setExpandedVoyages] = useState<Set<string>>(new Set());
    const [deleteVoyageId, setDeleteVoyageId] = useState<string | null>(null);
    const [currentVoyageId, setCurrentVoyageId] = useState<string | undefined>();
    const [showVoyageChoiceDialog, setShowVoyageChoiceDialog] = useState(false);
    const [lastVoyageId, setLastVoyageId] = useState<string | null>(null);
    const [selectedVoyageId, setSelectedVoyageId] = useState<string | null>(null);
    const [showStopVoyageDialog, setShowStopVoyageDialog] = useState(false);
    const [actionSheet, setActionSheet] = useState<'export' | 'share' | 'stats' | null>(null);
    const [gpsStatus, setGpsStatus] = useState<'locked' | 'stale' | 'none'>('none');
    const [showCommunityBrowser, setShowCommunityBrowser] = useState(false);

    const toast = useToast();
    const { settings } = useSettings();

    // Load tracking status and entries
    useEffect(() => {
        initializeService();
    }, []);

    const initializeService = async () => {
        try {
            await ShipLogService.initialize();
            await loadData();
        } catch (error) {
            setLoading(false);
        }
    };

    const loadData = async () => {
        const status = ShipLogService.getTrackingStatus();
        setIsTracking(status.isTracking);
        setIsPaused(status.isPaused);
        setIsRapidMode(status.isRapidMode);

        // Get current voyage ID if tracking
        const voyageId = ShipLogService.getCurrentVoyageId();
        setCurrentVoyageId(voyageId);

        // Expand current voyage by default
        if (voyageId) {
            setExpandedVoyages(new Set([voyageId]));
        }

        // Try to get entries from database first
        let logs = await ShipLogService.getLogEntries(100);

        // If no database entries, show offline queue
        if (logs.length === 0) {
            const offlineEntries = await ShipLogService.getOfflineEntries();
            if (offlineEntries.length > 0) {
                logs = offlineEntries;
            }
        }

        setEntries(logs);
        setLoading(false);
    };

    // GPS STATUS POLLING — check GPS health every 5 seconds while tracking
    useEffect(() => {
        if (!isTracking) {
            setGpsStatus('none');
            return;
        }
        const poll = () => setGpsStatus(ShipLogService.getGpsStatus());
        poll(); // immediate check
        const id = setInterval(poll, 5000);
        return () => clearInterval(id);
    }, [isTracking]);

    const handleStartTracking = async () => {
        try {
            // Calculate voyage groups to check if any voyages exist
            const voyages = groupEntriesByVoyage(entries);

            // Only ask about continuing if there are existing voyages
            if (voyages.length > 0) {
                // Get the most recent voyage ID (voyages are sorted newest first)
                const recentVoyageId = voyages[0]?.voyageId;
                if (recentVoyageId) {
                    setLastVoyageId(recentVoyageId);
                    setShowVoyageChoiceDialog(true);
                    return;
                }
            }
            // No existing voyages, start new directly
            await startTrackingWithNewVoyage();
        } catch (error: any) {
            alert(error.message || 'Failed to start tracking');
        }
    };

    const startTrackingWithNewVoyage = async () => {
        await ShipLogService.startTracking();
        setIsTracking(true);
        setIsPaused(false);
        await loadData();
    };

    const continueLastVoyage = async () => {
        await ShipLogService.startTracking(false, lastVoyageId || undefined);
        setIsTracking(true);
        setIsPaused(false);
        setShowVoyageChoiceDialog(false);
        await loadData();
    };

    const handlePauseTracking = async () => {
        await ShipLogService.pauseTracking();
        setIsTracking(false);
        setIsPaused(true);
        setIsRapidMode(false);
    };

    const handleToggleRapidMode = async () => {
        const newState = !isRapidMode;
        await ShipLogService.setRapidMode(newState);
        setIsRapidMode(newState);
    };

    const handleStopTracking = () => {
        setShowStopVoyageDialog(true);
    };

    const confirmStopVoyage = async () => {
        setShowStopVoyageDialog(false);
        await ShipLogService.stopTracking();
        setIsTracking(false);
        setIsPaused(false);
        await loadData();
    };



    const handleDeleteEntry = async (entryId: string) => {
        if (confirm('Delete this entry?')) {
            // Delete from database permanently
            const success = await ShipLogService.deleteEntry(entryId);
            if (success) {
                // Remove from local state
                setEntries(prev => prev.filter(e => e.id !== entryId));
                // Silent deletion - no toast
            } else {
                toast.error('Failed to delete entry');
            }
        }
    };

    const handleEditEntry = (entry: ShipLogEntry) => {
        setEditEntry(entry);
    };

    const handleSaveEdit = (entryId: string, updates: { notes?: string; waypointName?: string }) => {
        setEntries(prev => prev.map(e =>
            e.id === entryId ? { ...e, ...updates } : e
        ));
        toast.success('Entry updated');
    };

    // Voyage management handlers
    const toggleVoyage = (voyageId: string) => {
        setExpandedVoyages(prev => {
            const newSet = new Set(prev);
            if (newSet.has(voyageId)) {
                newSet.delete(voyageId);
            } else {
                newSet.add(voyageId);
            }
            return newSet;
        });
    };

    const handleDeleteVoyageRequest = (voyageId: string) => {
        setDeleteVoyageId(voyageId);
    };

    const handleConfirmDeleteVoyage = async () => {
        if (!deleteVoyageId) return;

        const success = await ShipLogService.deleteVoyage(deleteVoyageId);
        if (success) {
            setEntries(prev => prev.filter(e => e.voyageId !== deleteVoyageId));
            // Silent delete - no toast needed
        } else {
            toast.error('Failed to delete voyage');
        }
        setDeleteVoyageId(null);
    };

    const handleExportThenDelete = async () => {
        // Export first, then show delete confirmation again
        await handleShare();
        // Keep modal open - user can click delete afterward
    };

    // Group entries by voyage
    const groupEntriesByVoyage = (entries: ShipLogEntry[]) => {
        const voyageMap = new Map<string, ShipLogEntry[]>();

        entries.forEach(entry => {
            const voyageId = entry.voyageId || 'default_voyage';
            if (!voyageMap.has(voyageId)) {
                voyageMap.set(voyageId, []);
            }
            voyageMap.get(voyageId)!.push(entry);
        });

        // Sort voyages by most recent first
        return Array.from(voyageMap.entries())
            .map(([voyageId, entries]) => ({
                voyageId,
                entries: entries.sort((a, b) =>
                    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                )
            }))
            .sort((a, b) => {
                const aTime = new Date(a.entries[0]?.timestamp || 0).getTime();
                const bTime = new Date(b.entries[0]?.timestamp || 0).getTime();
                return bTime - aTime;
            });
    };

    const voyageGroups = useMemo(() => groupEntriesByVoyage(entries), [entries]);

    const handleExportCSV = () => {
        exportToCSV(entries, 'ships_log.csv', {
            onProgress: () => { },
            onSuccess: () => {
                // Silent success
            },
            onError: (err) => {
                toast.error(err);
            }
        });
    };

    const handleShare = async () => {
        await sharePDF(entries, {
            onProgress: () => { },
            onSuccess: () => {
                // Silent success
            },
            onError: (err) => {
                toast.error(err);
            }
        }, settings.vessel?.name, { vessel: settings.vessel, vesselUnits: settings.vesselUnits });
    };

    // GPX export — selected voyage or all (native share sheet)
    const handleExportGPX = async () => {
        const targetEntries = selectedVoyageId
            ? entries.filter(e => e.voyageId === selectedVoyageId)
            : entries;
        if (targetEntries.length === 0) return;
        const voyageName = selectedVoyageId
            ? `Voyage ${selectedVoyageId.slice(0, 8)}`
            : 'All Voyages';
        const gpxXml = exportVoyageAsGPX(targetEntries, voyageName, settings.vessel?.name);
        setActionSheet(null);
        await shareGPXFile(gpxXml, `${voyageName.replace(/\s+/g, '_').toLowerCase()}.gpx`);
    };

    // Community share — share selected voyage track
    const handleShareToCommunity = async () => {
        setActionSheet(null);
        const targetEntries = selectedVoyageId
            ? entries.filter(e => e.voyageId === selectedVoyageId)
            : entries;
        if (targetEntries.length === 0) {
            toast.error('No entries to share');
            return;
        }
        // For now use a simple prompt-based flow
        const title = prompt('Track title (e.g. "Moreton Bay Anchorage")');
        if (!title) return;
        const description = prompt('Short description') || '';
        const category = prompt('Category: anchorage, port_entry, bar_crossing, reef_passage, coastal, offshore, walking, driving') || 'coastal';
        const region = prompt('Region (e.g. "Queensland, AU")') || '';

        try {
            const result = await TrackSharingService.shareTrack(targetEntries, {
                title,
                description,
                tags: [],
                category: category as any,
                region,
            });
            if (result) {
                toast.success('Track shared to community!');
            } else {
                toast.error('Failed to share track');
            }
        } catch (err: any) {
            toast.error(err.message || 'Share failed');
        }
    };

    // Apply filters
    const filteredEntries = React.useMemo(() => {
        let filtered = entries;

        // Filter by type
        filtered = filterEntriesByType(filtered, filters.types);

        // Search
        filtered = searchEntries(filtered, filters.searchQuery);

        return filtered;
    }, [entries, filters]);

    // Group by date - with newest first for display
    const groupedEntries = React.useMemo(() => {
        // Sort entries newest first for display
        const newestFirst = [...filteredEntries].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        return groupEntriesByDate(newestFirst);
    }, [filteredEntries]);

    // Calculate entry counts by type
    const entryCounts = React.useMemo(() => ({
        auto: entries.filter(e => e.entryType === 'auto').length,
        manual: entries.filter(e => e.entryType === 'manual').length,
        waypoint: entries.filter(e => e.entryType === 'waypoint').length
    }), [entries]);

    // Calculate stats
    const totalDistance = filteredEntries.length > 0 ? filteredEntries[0].cumulativeDistanceNM || 0 : 0;
    const avgSpeed = filteredEntries.length > 0
        ? filteredEntries.filter(e => e.speedKts).reduce((sum, e) => sum + (e.speedKts || 0), 0) / filteredEntries.filter(e => e.speedKts).length
        : 0;

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
                    {/* Stats Header with Close Button */}
                    <div className="flex items-center justify-between p-4 border-b border-white/10">
                        <h2 className="text-lg font-bold text-white">Voyage Statistics</h2>
                        <button
                            onClick={() => setShowStats(false)}
                            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                        >
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    {/* Stats Content - centered with flex */}
                    <div className="flex-1 overflow-auto p-4 md:p-8 flex flex-col justify-center md:max-w-3xl md:mx-auto">
                        {/* Key Stats Row */}
                        <div className="grid grid-cols-3 gap-3 mb-4">
                            <div className="bg-gradient-to-br from-emerald-500/20 to-emerald-600/20 border border-emerald-500/30 rounded-lg p-3 text-center">
                                <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">Distance</div>
                                <div className="text-2xl font-bold text-white">{totalDistance.toFixed(1)} <span className="text-sm opacity-70">NM</span></div>
                            </div>
                            <div className="bg-gradient-to-br from-blue-500/20 to-blue-600/20 border border-blue-500/30 rounded-lg p-3 text-center">
                                <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">Avg Speed</div>
                                <div className="text-2xl font-bold text-white">{avgSpeed.toFixed(1)} <span className="text-sm opacity-70">kts</span></div>
                            </div>
                            <div className="bg-gradient-to-br from-purple-500/20 to-purple-600/20 border border-purple-500/30 rounded-lg p-3 text-center">
                                <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">Entries</div>
                                <div className="text-2xl font-bold text-white">{entries.length}</div>
                            </div>
                        </div>

                        {/* Full Voyage Stats */}
                        <VoyageStatsPanel entries={filteredEntries} />
                    </div>
                </div>
            ) : (
                <div className="flex flex-col h-full">
                    {/* Header with Controls - FIXED at top */}
                    <div className="shrink-0 p-4 bg-slate-900 border-b border-white/10 z-20">
                        <div className="flex justify-between items-center mb-2">
                            <h1 className="text-xl font-bold text-white flex items-center gap-2">
                                <AnchorIcon className="w-6 h-6 text-sky-400" />
                                Ship's Log
                                {isTracking && (
                                    <span
                                        className={`w-2.5 h-2.5 rounded-full ${gpsStatus === 'locked'
                                            ? 'bg-emerald-400 animate-pulse'
                                            : gpsStatus === 'stale'
                                                ? 'bg-amber-400 animate-pulse'
                                                : 'bg-red-500 animate-pulse'
                                            }`}
                                        title={gpsStatus === 'locked' ? 'GPS locked' : gpsStatus === 'stale' ? 'GPS stale' : 'No GPS signal'}
                                    />
                                )}
                            </h1>

                            {/* Tracking Controls */}
                            <div className="flex gap-2">
                                {!isTracking && !isPaused && (
                                    <button
                                        onClick={handleStartTracking}
                                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-bold flex items-center gap-1.5 transition-colors"
                                    >
                                        <PlayIcon className="w-4 h-4" />
                                        Start
                                    </button>
                                )}

                                {isTracking && (
                                    <button
                                        onClick={handleToggleRapidMode}
                                        className={`px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1.5 transition-all ${isRapidMode
                                                ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse shadow-lg shadow-red-500/30'
                                                : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                                            }`}
                                        title={isRapidMode ? 'Rapid GPS active (5s) — tap to disable' : 'Enable rapid GPS (5s intervals)'}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <circle cx="12" cy="12" r="3" strokeWidth={2} />
                                            <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4m10-10h-4M6 12H2" />
                                        </svg>
                                        {isRapidMode ? '5s' : 'Rapid'}
                                    </button>
                                )}

                                {isTracking && (
                                    <button
                                        onClick={handlePauseTracking}
                                        className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm font-bold flex items-center gap-1.5 transition-colors"
                                    >
                                        <PauseIcon className="w-4 h-4" />
                                        Pause
                                    </button>
                                )}

                                {(isTracking || isPaused) && (
                                    <button
                                        onClick={handleStopTracking}
                                        className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-bold flex items-center gap-1.5 transition-colors"
                                    >
                                        <StopIcon className="w-4 h-4" />
                                        Stop
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Action Bar — 4 buttons */}
                        <div className="grid grid-cols-4 gap-2 mb-2">
                            <button
                                onClick={() => setActionSheet('export')}
                                disabled={entries.length === 0}
                                className={`px-2 py-2.5 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-1 ${entries.length > 0
                                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 active:scale-95'
                                    : 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                                    }`}
                            >
                                <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                Export
                            </button>
                            <button
                                onClick={() => setActionSheet('share')}
                                disabled={entries.length === 0}
                                className={`px-2 py-2.5 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-1 ${entries.length > 0
                                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 active:scale-95'
                                    : 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                                    }`}
                            >
                                <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                </svg>
                                Share
                            </button>
                            <button
                                onClick={() => setActionSheet('stats')}
                                disabled={entries.length === 0}
                                className={`px-2 py-2.5 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-1 ${entries.length > 0
                                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 active:scale-95'
                                    : 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                                    }`}
                            >
                                <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                </svg>
                                Stats
                            </button>
                            <button
                                onClick={() => setShowTrackMap(true)}
                                disabled={entries.length === 0}
                                className={`px-2 py-2.5 rounded-xl text-xs font-bold transition-all flex flex-col items-center justify-center gap-1 ${entries.length > 0
                                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 active:scale-95'
                                    : 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                                    }`}
                            >
                                <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                                </svg>
                                Map
                            </button>
                        </div>

                        {/* Search and Filter Row */}
                        <div className="flex gap-2 items-center">
                            {/* Search */}
                            <div className="relative flex-1 max-w-[160px]">
                                <input
                                    type="text"
                                    placeholder="Search..."
                                    value={filters.searchQuery}
                                    onChange={(e) => setFilters({ ...filters, searchQuery: e.target.value })}
                                    className="w-full bg-slate-800/60 border border-white/5 rounded-lg px-3 py-2 pl-8 text-white text-xs placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                                />
                                <svg
                                    className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                                {filters.searchQuery && (
                                    <button
                                        onClick={() => setFilters({ ...filters, searchQuery: '' })}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                                    >
                                        ×
                                    </button>
                                )}
                            </div>

                            {/* A/M/W Type Filters */}
                            <div className="flex gap-1">
                                <button
                                    onClick={() => {
                                        const newTypes = filters.types.includes('auto')
                                            ? filters.types.filter(t => t !== 'auto')
                                            : [...filters.types, 'auto'] as ('auto' | 'manual' | 'waypoint')[];
                                        setFilters({ ...filters, types: newTypes });
                                    }}
                                    className={`min-w-[48px] min-h-[36px] px-3 py-1.5 rounded-lg border text-xs font-bold transition-all active:scale-95 ${filters.types.includes('auto')
                                        ? 'bg-green-500/30 border-green-500/60 text-green-400'
                                        : (filters.types.includes('manual') || filters.types.includes('waypoint'))
                                            ? 'bg-slate-800/30 border-white/5 text-slate-600 opacity-40'
                                            : 'bg-slate-800/60 border-white/5 text-slate-500'
                                        }`}
                                >
                                    A
                                </button>
                                <button
                                    onClick={() => {
                                        const newTypes = filters.types.includes('manual')
                                            ? filters.types.filter(t => t !== 'manual')
                                            : [...filters.types, 'manual'] as ('auto' | 'manual' | 'waypoint')[];
                                        setFilters({ ...filters, types: newTypes });
                                    }}
                                    className={`min-w-[48px] min-h-[36px] px-3 py-1.5 rounded-lg border text-xs font-bold transition-all active:scale-95 ${filters.types.includes('manual')
                                        ? 'bg-purple-500/30 border-purple-500/60 text-purple-400'
                                        : filters.types.includes('auto')
                                            ? 'bg-slate-800/30 border-white/5 text-slate-600 opacity-40'
                                            : 'bg-slate-800/60 border-white/5 text-slate-500'
                                        }`}
                                >
                                    M
                                </button>
                                <button
                                    onClick={() => {
                                        const newTypes = filters.types.includes('waypoint')
                                            ? filters.types.filter(t => t !== 'waypoint')
                                            : [...filters.types, 'waypoint'] as ('auto' | 'manual' | 'waypoint')[];
                                        setFilters({ ...filters, types: newTypes });
                                    }}
                                    className={`min-w-[48px] min-h-[36px] px-3 py-1.5 rounded-lg border text-xs font-bold transition-all active:scale-95 ${filters.types.includes('waypoint')
                                        ? 'bg-blue-500/30 border-blue-500/60 text-blue-400'
                                        : filters.types.includes('auto')
                                            ? 'bg-slate-800/30 border-white/5 text-slate-600 opacity-40'
                                            : 'bg-slate-800/60 border-white/5 text-slate-500'
                                        }`}
                                >
                                    W
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Log Entries Timeline - Scrollable area */}
                    <div className="flex-1 overflow-y-auto">
                        <div className="p-4 min-h-full flex flex-col">
                            {entries.length === 0 ? (
                                <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
                                    <div className="text-6xl mb-4">⚓</div>
                                    <p className="text-lg font-bold text-white mb-2">Your Voyage Awaits</p>
                                    <p className="text-sm mb-6 max-w-xs mx-auto text-center">
                                        "Twenty years from now you will be more disappointed by the things you didn't do than by the ones you did do."
                                    </p>
                                    <p className="text-xs text-slate-500">— Mark Twain</p>
                                </div>
                            ) : (
                                <>
                                    {voyageGroups.map((voyage, index) => {
                                        const isExpanded = expandedVoyages.has(voyage.voyageId);
                                        const isActive = voyage.voyageId === currentVoyageId;
                                        const voyageFilteredEntries = voyage.entries.filter(e => filteredEntries.some(f => f.id === e.id));

                                        if (voyageFilteredEntries.length === 0) return null;

                                        return (
                                            <div key={voyage.voyageId}>
                                                <VoyageHeader
                                                    voyageId={voyage.voyageId}
                                                    entries={voyageFilteredEntries}
                                                    isActive={isActive}
                                                    isSelected={selectedVoyageId === voyage.voyageId || (!selectedVoyageId && index === 0)}
                                                    isExpanded={isExpanded}
                                                    onToggle={() => toggleVoyage(voyage.voyageId)}
                                                    onSelect={() => setSelectedVoyageId(voyage.voyageId)}
                                                    onDelete={() => handleDeleteVoyageRequest(voyage.voyageId)}
                                                />

                                                {/* Collapsible date groups within voyage */}
                                                {isExpanded && (
                                                    <div className="ml-2 border-l-2 border-slate-700/50 pl-3 mb-4">
                                                        <DateGroupedTimeline
                                                            groupedEntries={groupEntriesByDate(voyageFilteredEntries)}
                                                            onDeleteEntry={handleDeleteEntry}
                                                            onEditEntry={handleEditEntry}
                                                            voyageFirstEntryId={voyage.entries[voyage.entries.length - 1]?.id}
                                                            voyageLastEntryId={voyage.entries[0]?.id}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Toast Notifications */}
            <toast.ToastContainer />

            {/* Add Manual Entry Button - FIXED at bottom using absolute positioning */}
            <div className="absolute bottom-0 left-0 right-0 z-20 p-4 pt-2 border-t border-white/10 bg-slate-900">
                <button
                    onClick={() => isTracking && setShowAddModal(true)}
                    disabled={!isTracking}
                    className={`w-full px-4 py-3 rounded-lg font-bold transition-colors flex items-center justify-center gap-2 ${isTracking
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                        }`}
                >
                    <PlusIcon className="w-5 h-5" />
                    {isTracking ? 'Add Manual Entry' : 'Start Tracking to Add Entry'}
                </button>
            </div>

            {/* Manual Entry Modal */}
            <AddEntryModal
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
                onSuccess={loadData}
                selectedVoyageId={selectedVoyageId}
            />

            {/* Edit Entry Modal */}
            <EditEntryModal
                isOpen={editEntry !== null}
                entry={editEntry}
                onClose={() => setEditEntry(null)}
                onSave={handleSaveEdit}
            />

            {/* Full Track Map Viewer — shows selected voyage or all */}
            <TrackMapViewer
                isOpen={showTrackMap}
                onClose={() => setShowTrackMap(false)}
                entries={selectedVoyageId ? entries.filter(e => e.voyageId === selectedVoyageId) : entries}
            />

            {/* Community Track Browser */}
            <CommunityTrackBrowser
                isOpen={showCommunityBrowser}
                onClose={() => setShowCommunityBrowser(false)}
                onImportComplete={loadData}
                onLocalImport={() => { setShowCommunityBrowser(false); }}
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
                                onClick={() => setActionSheet(null)}
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
                            {/* PDF Card */}
                            <button
                                onClick={() => { handleShare(); setActionSheet(null); }}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-sky-500/15 to-sky-600/5 border border-sky-500/20 hover:border-sky-400/40 active:scale-[0.98] transition-all"
                            >
                                <div className="w-14 h-14 rounded-xl bg-sky-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-6 4h4" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">Official Deck Log</div>
                                    <div className="text-slate-400 text-sm mt-1">PDF with charts, positions &amp; weather data</div>
                                </div>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>

                            {/* GPX Card */}
                            <button
                                onClick={() => { handleExportGPX(); }}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-emerald-500/15 to-emerald-600/5 border border-emerald-500/20 hover:border-emerald-400/40 active:scale-[0.98] transition-all"
                            >
                                <div className="w-14 h-14 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                                    </svg>
                                </div>
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

            {/* SHARE ACTION SHEET — full screen panel */}
            {actionSheet === 'share' && (
                <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]">
                    <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center">
                                    <svg className="w-4.5 h-4.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                    </svg>
                                </div>
                                <h2 className="text-lg font-bold text-white">Community Sharing</h2>
                            </div>
                            <button
                                onClick={() => setActionSheet(null)}
                                className="p-2 text-slate-400 hover:text-white transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <p className="text-sm text-slate-400 mt-2">Share tracks with sailors worldwide</p>
                    </div>

                    <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                        <div className="space-y-4 max-w-lg mx-auto w-full">
                            {/* Share Track Card */}
                            <button
                                onClick={handleShareToCommunity}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-violet-500/15 to-violet-600/5 border border-violet-500/20 hover:border-violet-400/40 active:scale-[0.98] transition-all"
                            >
                                <div className="w-14 h-14 rounded-xl bg-violet-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">Share This Track</div>
                                    <div className="text-slate-400 text-sm mt-1">Upload to the Thalassa community for others to discover</div>
                                </div>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>

                            {/* Browse Community Card */}
                            <button
                                onClick={() => { setShowCommunityBrowser(true); setActionSheet(null); }}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-cyan-500/15 to-cyan-600/5 border border-cyan-500/20 hover:border-cyan-400/40 active:scale-[0.98] transition-all"
                            >
                                <div className="w-14 h-14 rounded-xl bg-cyan-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">Browse Community</div>
                                    <div className="text-slate-400 text-sm mt-1">Discover anchorages, passages &amp; routes from other sailors</div>
                                </div>
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
                                onClick={() => setActionSheet(null)}
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
                            {/* This Voyage Card */}
                            <button
                                onClick={() => { setShowStats(true); setActionSheet(null); }}
                                className="w-full flex items-center gap-4 p-5 rounded-2xl bg-gradient-to-r from-amber-500/15 to-amber-600/5 border border-amber-500/20 hover:border-amber-400/40 active:scale-[0.98] transition-all"
                            >
                                <div className="w-14 h-14 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                                    <svg className="w-7 h-7 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                    </svg>
                                </div>
                                <div className="flex-1 text-left">
                                    <div className="text-white font-bold text-lg">This Voyage</div>
                                    <div className="text-slate-400 text-sm mt-1">Stats for the selected voyage track</div>
                                </div>
                                {selectedVoyageId && (
                                    <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-400 text-xs font-bold">
                                        {entries.filter(e => e.voyageId === selectedVoyageId).length} pts
                                    </span>
                                )}
                                <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>

                            {/* All Voyages Card */}
                            <button
                                onClick={() => { setSelectedVoyageId(null); setShowStats(true); setActionSheet(null); }}
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
                                    setShowVoyageChoiceDialog(false);
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
                                onClick={() => setShowVoyageChoiceDialog(false)}
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
                                onClick={() => setShowStopVoyageDialog(false)}
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
                const totalDistance = Math.max(...voyageEntries.map(e => e.cumulativeDistanceNM || 0), 0);

                const formatLoc = (e: ShipLogEntry | undefined) => {
                    if (!e) return 'Unknown';
                    if (e.waypointName) return e.waypointName;
                    return `${Math.abs(e.latitude).toFixed(2)}°${e.latitude >= 0 ? 'N' : 'S'}`;
                };

                return (
                    <DeleteVoyageModal
                        isOpen={true}
                        onClose={() => setDeleteVoyageId(null)}
                        onExportFirst={handleExportThenDelete}
                        onDelete={handleConfirmDeleteVoyage}
                        voyageInfo={{
                            startLocation: formatLoc(first),
                            endLocation: formatLoc(last),
                            totalDays,
                            totalEntries: voyageEntries.length,
                            totalDistance
                        }}
                    />
                );
            })()}
        </div>
    );
};

// --- SUB-COMPONENTS ---

const StatBox: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
    <div className="bg-slate-800 rounded-lg p-3 text-center">
        <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">{label}</div>
        <div className="text-xl font-bold text-white">{value}</div>
    </div>
);

const LogEntryCard: React.FC<{ entry: ShipLogEntry }> = ({ entry }) => {
    const timestamp = new Date(entry.timestamp);
    const timeStr = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // Entry type colors
    const typeColors = {
        auto: 'bg-green-500/20 text-green-400 border-green-500/30',
        manual: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
        waypoint: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    };

    return (
        <div className="bg-slate-800/50 border border-white/10 rounded-xl p-4 hover:bg-slate-800 transition-colors">
            {/* Header: Time + Type */}
            <div className="flex justify-between items-start mb-3">
                <div>
                    <div className="text-white font-bold text-lg">{timeStr}</div>
                    <div className="text-slate-400 text-xs">{dateStr}</div>
                </div>
                <span className={`px-2 py-1 rounded-lg text-xs font-bold uppercase border ${typeColors[entry.entryType]}`}>
                    {entry.entryType}
                </span>
            </div>

            {/* Position */}
            <div className="mb-3">
                <div className="text-xs text-slate-400 mb-1">Position</div>
                <div className="text-emerald-400 font-mono font-bold text-base">
                    {entry.positionFormatted}
                </div>
            </div>

            {/* Navigation Stats */}
            {(entry.distanceNM || entry.speedKts || entry.courseDeg !== undefined) && (
                <div className="grid grid-cols-3 gap-2 mb-3">
                    {entry.distanceNM !== undefined && (
                        <div className="bg-slate-900/50 rounded-lg p-2">
                            <div className="text-[10px] text-slate-400 uppercase">Distance</div>
                            <div className="text-sm font-bold text-white">{entry.distanceNM.toFixed(1)} NM</div>
                        </div>
                    )}
                    {entry.speedKts !== undefined && (
                        <div className="bg-slate-900/50 rounded-lg p-2">
                            <div className="text-[10px] text-slate-400 uppercase">Speed</div>
                            <div className="text-sm font-bold text-white">{entry.speedKts.toFixed(1)} kts</div>
                        </div>
                    )}
                    {entry.courseDeg !== undefined && (
                        <div className="bg-slate-900/50 rounded-lg p-2 flex items-center gap-2">
                            <CompassIcon className="w-4 h-4 text-sky-400" rotation={entry.courseDeg} />
                            <div>
                                <div className="text-[10px] text-slate-400 uppercase">Course</div>
                                <div className="text-sm font-bold text-white">{entry.courseDeg}°</div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Weather Snapshot */}
            {(entry.windSpeed || entry.waveHeight) && (
                <div className="pt-2 border-t border-white/5 text-xs text-slate-400 flex items-center gap-3">
                    {entry.windSpeed && (
                        <span className="flex items-center gap-1">
                            <WindIcon className="w-3 h-3" />
                            {entry.windSpeed}kts {entry.windDirection}
                        </span>
                    )}
                    {entry.waveHeight && <span>Seas: {entry.waveHeight.toFixed(1)}m</span>}
                    {entry.airTemp && <span>Air: {entry.airTemp}°</span>}
                </div>
            )}

            {/* Notes */}
            {entry.notes && (
                <div className="mt-3 pt-3 border-t border-white/5">
                    <div className="text-xs text-slate-400 mb-1">Notes</div>
                    <div className="text-sm text-white italic">"{entry.notes}"</div>
                </div>
            )}

            {/* Waypoint Name */}
            {entry.waypointName && (
                <div className="mt-2 px-2 py-1 bg-blue-500/10 border border-blue-500/20 rounded text-blue-400 text-xs font-bold">
                    📍 {entry.waypointName}
                </div>
            )}
        </div>
    );
};
