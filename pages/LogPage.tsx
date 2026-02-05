/**
 * Log Page - Ship's GPS-based Log
 * Displays automatic voyage tracking with 15-minute GPS intervals
 */

import React, { useState, useEffect } from 'react';
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
import { exportToCSV, exportToPDF, sharePDF } from '../utils/logExport';
import { generateDemoVoyage } from '../utils/generateDemoLog';
import { useToast } from '../components/Toast';
import { VoyageStatsPanel } from '../components/VoyageStatsPanel';
import { LogFilterToolbar, LogFilters } from '../components/LogFilterToolbar';
import { DateGroupedTimeline } from '../components/DateGroupedTimeline';
import { MiniTrackMap } from '../components/MiniTrackMap';
import { EditEntryModal } from '../components/EditEntryModal';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { groupEntriesByDate, filterEntriesByType, searchEntries } from '../utils/voyageData';
import { useSettings } from '../context/SettingsContext';

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
    const [showAddModal, setShowAddModal] = useState(false);
    const [editEntry, setEditEntry] = useState<ShipLogEntry | null>(null);
    const [showTrackMap, setShowTrackMap] = useState(false);
    const [loading, setLoading] = useState(true);
    const [showStats, setShowStats] = useState(false);
    const [filters, setFilters] = useState<LogFilters>({
        types: ['auto', 'manual', 'waypoint'],
        searchQuery: ''
    });
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
            console.error('Failed to initialize Ship Log Service:', error);
            setLoading(false);
        }
    };

    const loadData = async () => {
        const status = ShipLogService.getTrackingStatus();
        setIsTracking(status.isTracking);
        setIsPaused(status.isPaused);

        // Try to get entries from database first
        let logs = await ShipLogService.getLogEntries(100);

        // If no database entries, show offline queue
        if (logs.length === 0) {
            const offlineEntries = await ShipLogService.getOfflineEntries();
            if (offlineEntries.length > 0) {
                console.log(`[LogPage] Displaying ${offlineEntries.length} offline entries`);
                logs = offlineEntries;
            }
        }

        setEntries(logs);
        setLoading(false);
    };

    const handleStartTracking = async () => {
        try {
            console.log('[LogPage] Starting tracking...');
            await ShipLogService.startTracking();
            console.log('[LogPage] Tracking started successfully');
            setIsTracking(true);
            setIsPaused(false);
            await loadData();
        } catch (error: any) {
            console.error('[LogPage] Error starting tracking:', error);
            alert(error.message || 'Failed to start tracking');
        }
    };

    const handlePauseTracking = async () => {
        await ShipLogService.pauseTracking();
        setIsTracking(false);
        setIsPaused(true);
    };

    const handleStopTracking = async () => {
        if (confirm('End voyage and stop tracking? This will finalize your log.')) {
            await ShipLogService.stopTracking();
            setIsTracking(false);
            setIsPaused(false);
            await loadData();
        }
    };

    const handleLoadDemoVoyage = () => {
        if (confirm('Load epic demo voyage (Brisbane → Nouméa ~770nm)? This will replace your current log entries.')) {
            const demoEntries = generateDemoVoyage();
            setEntries(demoEntries);
            toast.success(`Loaded ${demoEntries.length} demo entries! 🚢`);
        }
    };

    const handleClearLog = () => {
        if (confirm('Clear all log entries? This cannot be undone.')) {
            setEntries([]);
            toast.success('Log cleared');
        }
    };

    const handleDeleteEntry = (entryId: string) => {
        if (confirm('Delete this entry?')) {
            setEntries(prev => prev.filter(e => e.id !== entryId));
            toast.success('Entry deleted');
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

    const handleExportCSV = () => {
        const loadingId = toast.loading('Preparing CSV export...');

        exportToCSV(entries, 'ships_log.csv', {
            onProgress: (msg) => console.log(msg),
            onSuccess: () => {
                toast.hideToast(loadingId);
                toast.success('CSV exported successfully!');
            },
            onError: (err) => {
                toast.hideToast(loadingId);
                toast.error(err);
            }
        });
    };

    const handleExportPDF = () => {
        const loadingId = toast.loading('Preparing PDF export...');

        exportToPDF(entries, 'ships_log.pdf', {
            onProgress: (msg) => console.log(msg),
            onSuccess: () => {
                toast.hideToast(loadingId);
                toast.success('PDF opened for printing!');
            },
            onError: (err) => {
                toast.hideToast(loadingId);
                toast.error(err);
            }
        }, settings.vessel?.name, { vessel: settings.vessel, vesselUnits: settings.vesselUnits });
    };

    const handleShare = async () => {
        const loadingId = toast.loading('Preparing to share...');

        await sharePDF(entries, {
            onProgress: (msg) => console.log(msg),
            onSuccess: () => {
                toast.hideToast(loadingId);
                toast.success('Share sheet opened!');
            },
            onError: (err) => {
                toast.hideToast(loadingId);
                toast.error(err);
            }
        }, settings.vessel?.name, { vessel: settings.vessel, vesselUnits: settings.vesselUnits });
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
        <div className="flex flex-col h-full bg-slate-950">
            {/* Fullscreen Statistics View */}
            {showStats ? (
                <div className="flex flex-col h-full">
                    {/* Stats Content - fills available space */}
                    <div className="flex-1 overflow-auto p-4">
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

                    {/* Hide Statistics Button - Fixed at bottom */}
                    <div className="p-4 border-t border-white/10 bg-slate-900">
                        <button
                            onClick={() => setShowStats(false)}
                            className="w-full px-4 py-3 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg text-white text-sm font-bold transition-colors flex items-center justify-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Hide Statistics
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    {/* Header with Controls */}
                    <div className="p-4 bg-slate-900 border-b border-white/10 shrink-0">
                        <div className="flex justify-between items-center mb-2">
                            <h1 className="text-xl font-bold text-white flex items-center gap-2">
                                <AnchorIcon className="w-6 h-6 text-sky-400" />
                                Ship's Log
                                {isTracking && (
                                    <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
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

                        {/* Export Buttons */}
                        {entries.length > 0 && (
                            <div className="flex gap-2 mb-2">
                                <button
                                    onClick={handleShare}
                                    className="flex-1 px-3 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                    </svg>
                                    Share
                                </button>
                                <button
                                    onClick={handleExportCSV}
                                    className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                    CSV
                                </button>
                                <button
                                    onClick={handleExportPDF}
                                    className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                                    </svg>
                                    Print
                                </button>
                            </div>
                        )}

                        {/* Demo & Clear & Stats Buttons */}
                        <div className="flex gap-2">
                            <button
                                onClick={handleLoadDemoVoyage}
                                className="flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                                Demo
                            </button>
                            {entries.length > 0 && (
                                <>
                                    <button
                                        onClick={() => setShowStats(true)}
                                        className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                        </svg>
                                        Stats
                                    </button>
                                    <button
                                        onClick={handleClearLog}
                                        className="px-3 py-2 bg-red-600/80 hover:bg-red-600 text-white rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                        Clear
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Log Entries Timeline */}
                    <div className="flex-1 overflow-auto p-4">
                        {entries.length === 0 ? (
                            <div className="text-center py-16 text-slate-400">
                                <div className="text-4xl mb-4">⚓</div>
                                <p className="text-lg font-bold text-white mb-2">Your Voyage Awaits</p>
                                <p className="text-sm mb-6 max-w-xs mx-auto">
                                    "Twenty years from now you will be more disappointed by the things you didn't do than by the ones you did do."
                                </p>
                                <p className="text-xs text-slate-500">— Mark Twain</p>
                            </div>
                        ) : (
                            <>
                                {/* Mini Track Map Preview - Clickable */}
                                <button
                                    onClick={() => setShowTrackMap(true)}
                                    className="w-full mb-3 group"
                                >
                                    <div className="relative">
                                        <MiniTrackMap entries={entries} height={80} />
                                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors rounded-lg flex items-center justify-center">
                                            <span className="text-white text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 px-3 py-1 rounded-full">
                                                View Full Map
                                            </span>
                                        </div>
                                    </div>
                                </button>

                                {/* Filter Toolbar */}
                                <LogFilterToolbar
                                    filters={filters}
                                    onFiltersChange={setFilters}
                                    totalEntries={entries.length}
                                    filteredCount={filteredEntries.length}
                                    entryCounts={entryCounts}
                                />

                                {/* Date Grouped Timeline */}
                                <DateGroupedTimeline
                                    groupedEntries={groupedEntries}
                                    onDeleteEntry={handleDeleteEntry}
                                    onEditEntry={handleEditEntry}
                                />
                            </>
                        )}
                    </div>
                </>
            )}

            {/* Toast Notifications */}
            <toast.ToastContainer />

            {/* Add Manual Entry Button - Always visible, useful for manual-only users */}
            <div className="p-4 pt-0">
                <button
                    onClick={() => setShowAddModal(true)}
                    className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition-colors flex items-center justify-center gap-2"
                >
                    <PlusIcon className="w-5 h-5" />
                    Add Entry
                </button>
            </div>

            {/* Manual Entry Modal */}
            <AddEntryModal
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
                onSuccess={loadData}
            />

            {/* Edit Entry Modal */}
            <EditEntryModal
                isOpen={editEntry !== null}
                entry={editEntry}
                onClose={() => setEditEntry(null)}
                onSave={handleSaveEdit}
            />

            {/* Full Track Map Viewer */}
            <TrackMapViewer
                isOpen={showTrackMap}
                onClose={() => setShowTrackMap(false)}
                entries={entries}
            />
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
