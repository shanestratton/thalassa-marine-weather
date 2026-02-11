/**
 * Community Track Browser
 * Browse and download shared tracks from the Thalassa community.
 * Full-screen modal with search, filters, and download capabilities.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { t } from '../theme';
import { TrackSharingService, SharedTrack, TrackCategory, BrowseFilters } from '../services/TrackSharingService';
import { ShipLogService } from '../services/ShipLogService';
import { importGPXToEntries } from '../services/gpxService';
import { getErrorMessage } from '../utils/logger';

interface CommunityTrackBrowserProps {
    isOpen: boolean;
    onClose: () => void;
    onImportComplete: () => void;
    onLocalImport: () => void; // Fallback to local file import
}

const CATEGORY_LABELS: Record<TrackCategory, string> = {
    anchorage: '⚓ Anchorage',
    port_entry: '🏗 Port Entry',
    bar_crossing: '🌊 Bar Crossing',
    reef_passage: '🪸 Reef Passage',
    coastal: '🏖 Coastal',
    offshore: '🌊 Offshore',
    walking: '🚶 Walking',
    driving: '🚗 Driving',
    pin_repairs: '🔧 Repairs',
    pin_food: '🍴 Food & Drink',
    pin_fuel: '⛽ Fuel',
    pin_supplies: '🛒 Supplies',
    pin_scenic: '📸 Scenic',
};

const SORT_OPTIONS = [
    { value: 'created_at', label: 'Newest' },
    { value: 'download_count', label: 'Popular' },
    { value: 'distance_nm', label: 'Distance' },
] as const;

export const CommunityTrackBrowser: React.FC<CommunityTrackBrowserProps> = ({
    isOpen,
    onClose,
    onImportComplete,
    onLocalImport,
}) => {
    const [tracks, setTracks] = useState<SharedTrack[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState<TrackCategory | ''>('');
    const [sortBy, setSortBy] = useState<BrowseFilters['sortBy']>('created_at');
    const [downloadingId, setDownloadingId] = useState<string | null>(null);
    const [importStatus, setImportStatus] = useState<string | null>(null);
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
    const [activeTab, setActiveTab] = useState<'browse' | 'mine'>('browse');
    const [myTracks, setMyTracks] = useState<SharedTrack[]>([]);
    const [myTracksLoading, setMyTracksLoading] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const fetchTracks = useCallback(async (searchQuery?: string) => {
        setLoading(true);
        setError(null);
        try {
            const filters: BrowseFilters = {
                sortBy: sortBy,
                sortOrder: sortBy === 'distance_nm' ? 'desc' : 'desc',
                limit: 30,
            };
            if (category) filters.category = category;
            if (searchQuery || search) filters.search = searchQuery ?? search;

            const result = await TrackSharingService.browseSharedTracks(filters);
            setTracks(result.tracks);
            setTotal(result.total);
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Failed to load tracks');
        } finally {
            setLoading(false);
        }
    }, [category, sortBy, search]);

    // Fetch on open and when filters change
    useEffect(() => {
        if (isOpen) {
            fetchTracks();
        }
    }, [isOpen, fetchTracks]);

    // Debounced search
    const handleSearchChange = (value: string) => {
        setSearch(value);
        if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = setTimeout(() => {
            fetchTracks(value);
        }, 400);
    };

    const handleDownload = async (track: SharedTrack) => {
        setDownloadingId(track.id);
        setImportStatus(null);
        try {
            // Download GPX data (Pro check happens server-side)
            const gpxData = await TrackSharingService.downloadTrack(track.id, true);
            if (!gpxData) {
                setImportStatus('Download failed — no data returned');
                return;
            }

            // Parse GPX and import as a new voyage
            const importedEntries = importGPXToEntries(gpxData);
            if (importedEntries.length === 0) {
                setImportStatus('No valid entries found in track');
                return;
            }

            // Stamp as community download for provenance tracking
            importedEntries.forEach(e => {
                Object.assign(e, { source: 'community_download' });
            });

            const { savedCount } = await ShipLogService.importGPXVoyage(importedEntries);
            setImportStatus(`✓ Imported "${track.title}" — ${savedCount} entries`);

            // Refresh parent data after short delay
            setTimeout(() => {
                onImportComplete();
            }, 1500);
        } catch (err: unknown) {
            setImportStatus(getErrorMessage(err) || 'Download failed');
        } finally {
            setDownloadingId(null);
        }
    };

    const fetchMyTracks = useCallback(async () => {
        setMyTracksLoading(true);
        try {
            const result = await TrackSharingService.getMySharedTracks();
            setMyTracks(result);
        } catch (err: unknown) {
        } finally {
            setMyTracksLoading(false);
        }
    }, []);

    const handleDeleteMyTrack = async (trackId: string) => {
        setDeletingId(trackId);
        try {
            const success = await TrackSharingService.deleteSharedTrack(trackId);
            if (success) {
                setMyTracks(prev => prev.filter(t => t.id !== trackId));
                setImportStatus('✓ Track removed from community');
                setTimeout(() => setImportStatus(null), 3000);
            } else {
                setImportStatus('Failed to delete track');
            }
        } catch (err: unknown) {
            setImportStatus(getErrorMessage(err) || 'Delete failed');
        } finally {
            setDeletingId(null);
        }
    };

    // Load my tracks when tab switches
    useEffect(() => {
        if (activeTab === 'mine' && isOpen) {
            fetchMyTracks();
        }
    }, [activeTab, isOpen, fetchMyTracks]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950" role="dialog" aria-modal="true" aria-label="Community track browser">
            {/* Header */}
            <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <h2 className="text-lg font-bold text-white">Community Tracks</h2>
                    </div>
                    <div className="flex items-center gap-2">
                        {/* Local file import button */}
                        <button
                            onClick={onLocalImport}
                            className={`px-3 py-1.5 bg-slate-800/50 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-bold transition-colors ${t.border.default} flex items-center gap-1`}
                            title="Import from device files"
                            aria-label="Local Import">
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            File
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 text-slate-400 hover:text-white transition-colors"
                            aria-label="Close">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Browse / My Tracks tab toggle */}
                <div className="flex gap-2 mb-3">
                    <button
                        onClick={() => setActiveTab('browse')}
                        className={`flex-1 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'browse'
                            ? 'bg-emerald-600 text-white'
                            : `bg-slate-800/60 text-slate-400 border border-white/10`
                            }`}
                    >
                        Browse {total > 0 && `(${total})`}
                    </button>
                    <button
                        onClick={() => setActiveTab('mine')}
                        className={`flex-1 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'mine'
                            ? 'bg-amber-600 text-white'
                            : `bg-slate-800/60 text-slate-400 ${t.border.default}`
                            }`}
                    >
                        My Shared Tracks
                    </button>
                </div>

                {/* Search & Filters — only show on browse tab */}
                {activeTab === 'browse' && (
                    <>
                        {/* Search */}
                        <div className="relative mb-3">
                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <input
                                type="text"
                                placeholder="Search tracks..."
                                value={search}
                                onChange={(e) => handleSearchChange(e.target.value)}
                                className={`w-full bg-slate-800/60 ${t.border.default} rounded-lg pl-9 pr-3 py-2.5 text-white text-sm focus:border-emerald-500 focus:outline-none placeholder-slate-500`}
                            />
                        </div>

                        {/* Filters Row */}
                        <div className="flex gap-2">
                            {/* Category filter */}
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value as TrackCategory | '')}
                                className={`flex-1 bg-slate-800/60 ${t.border.default} rounded-lg px-2 py-2 text-white text-sm font-bold focus:border-emerald-500 focus:outline-none`}
                            >
                                <option value="">All Categories</option>
                                {(Object.keys(CATEGORY_LABELS) as TrackCategory[]).map(cat => (
                                    <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
                                ))}
                            </select>
                            {/* Sort */}
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value as BrowseFilters['sortBy'])}
                                className={`bg-slate-800/60 ${t.border.default} rounded-lg px-2 py-2 text-white text-sm font-bold focus:border-emerald-500 focus:outline-none`}
                            >
                                {SORT_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </div>
                    </>
                )}
            </div>

            {/* Import Status Banner */}
            {importStatus && (
                <div className={`mx-4 mt-3 px-4 py-2.5 rounded-lg text-sm font-bold ${importStatus.startsWith('✓')
                    ? 'bg-emerald-900/40 border border-emerald-500/30 text-emerald-400'
                    : 'bg-red-900/40 border border-red-500/30 text-red-400'
                    }`}>
                    {importStatus}
                </div>
            )}

            {/* Safety Disclaimer Banner */}
            <div className="mx-4 mt-3 bg-amber-900/20 border border-amber-500/20 rounded-lg px-3 py-2.5">
                <div className="flex items-start gap-2">
                    <span className="text-amber-400 text-sm mt-0.5">⚠️</span>
                    <div>
                        <p className="text-sm font-bold text-amber-300">Navigation Disclaimer</p>
                        <p className="text-sm text-amber-400/70 leading-relaxed mt-0.5">
                            Community tracks are user-contributed, unverified, and <span className="font-bold">not suitable for navigation</span>. Depths vary with tide, weather, and vessel draft. Always verify conditions independently using official charts and local knowledge.
                        </p>
                    </div>
                </div>
            </div>

            {/* Track List */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
                {activeTab === 'mine' ? (
                    /* My Tracks tab */
                    myTracksLoading ? (
                        <div className="flex flex-col items-center justify-center h-48 text-slate-500">
                            <div className="w-8 h-8 border-2 border-amber-500/30 border-t-amber-400 rounded-full animate-spin mb-3" />
                            <p className="text-sm">Loading your tracks...</p>
                        </div>
                    ) : myTracks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-slate-500">
                            <p className="text-sm font-bold text-slate-400 mb-1">No shared tracks</p>
                            <p className="text-sm text-slate-600">Tracks you share will appear here for management.</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {myTracks.map(track => (
                                <MyTrackCard
                                    key={track.id}
                                    track={track}
                                    isDeleting={deletingId === track.id}
                                    onDelete={() => handleDeleteMyTrack(track.id)}
                                />
                            ))}
                        </div>
                    )
                ) : loading && tracks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-slate-500">
                        <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin mb-3" />
                        <p className="text-sm">Loading tracks...</p>
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center h-48 text-slate-500">
                        <p className="text-sm text-red-400 mb-2">{error}</p>
                        <button
                            onClick={() => fetchTracks()}
                            className="px-4 py-2 bg-slate-800/50 hover:bg-slate-700 text-white rounded-lg text-sm font-bold transition-colors"
                        >
                            Retry
                        </button>
                    </div>
                ) : tracks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-48 text-slate-500">
                        <svg className="w-12 h-12 mb-3 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <p className="text-sm font-bold text-slate-400 mb-1">No tracks found</p>
                        <p className="text-sm text-slate-600">Be the first to share a track!</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {tracks.map(track => (
                            <TrackCard
                                key={track.id}
                                track={track}
                                isDownloading={downloadingId === track.id}
                                onDownload={() => handleDownload(track)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

// --- Track Card ---

const TrackCard: React.FC<{
    track: SharedTrack;
    isDownloading: boolean;
    onDownload: () => void;
}> = ({ track, isDownloading, onDownload }) => {
    const createdDate = new Date(track.created_at);
    const dateStr = createdDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });

    const categoryLabel = CATEGORY_LABELS[track.category] || track.category;

    return (
        <div className={`bg-slate-900/70 ${t.border.subtle} rounded-xl p-4 transition-colors hover:border-white/10`}>
            {/* Title row */}
            <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-white truncate">{track.title}</h3>
                    {track.description && (
                        <p className="text-sm text-slate-400 mt-0.5 line-clamp-2">{track.description}</p>
                    )}
                </div>
                <button
                    onClick={onDownload}
                    disabled={isDownloading}
                    className={`shrink-0 px-3 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-1.5 ${isDownloading
                        ? 'bg-emerald-900/30 text-emerald-500/50 cursor-not-allowed'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95'
                        }`}
                    aria-label="Download">
                    {isDownloading ? (
                        <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                    )}
                    {isDownloading ? '...' : 'Import'}
                </button>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 text-sm text-slate-500">
                <span className="bg-slate-800/60 px-2 py-0.5 rounded text-slate-400 font-bold">
                    {categoryLabel}
                </span>
                {track.region && (
                    <span className="truncate">📍 {track.region}</span>
                )}
                <span>{track.distance_nm.toFixed(1)} NM</span>
                <span>{track.point_count} pts</span>
                <span className="ml-auto shrink-0">{dateStr}</span>
            </div>

            {/* Draft & Tide info */}
            {(track.vessel_draft_m || track.tide_info) && (
                <div className="flex items-center gap-3 mt-1.5 text-sm">
                    {track.vessel_draft_m && (
                        <span className="bg-sky-900/30 border border-sky-500/20 text-sky-400 px-2 py-0.5 rounded font-bold">
                            ⚓ {track.vessel_draft_m.toFixed(1)}m draft
                        </span>
                    )}
                    {track.tide_info && (
                        <span className="bg-slate-800/60 text-slate-400 px-2 py-0.5 rounded truncate">
                            🌊 {track.tide_info}
                        </span>
                    )}
                </div>
            )}

            {/* Download count */}
            {track.download_count > 0 && (
                <div className="mt-1.5 text-sm text-slate-600">
                    ↓ {track.download_count} download{track.download_count !== 1 ? 's' : ''}
                </div>
            )}
        </div>
    );
};

// --- My Track Card (with delete) ---

const MyTrackCard: React.FC<{
    track: SharedTrack;
    isDeleting: boolean;
    onDelete: () => void;
}> = ({ track, isDeleting, onDelete }) => {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const createdDate = new Date(track.created_at);
    const dateStr = createdDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });

    const categoryLabel = CATEGORY_LABELS[track.category] || track.category;

    return (
        <div className={`bg-slate-900/70 ${t.border.subtle} rounded-xl p-4 transition-colors hover:border-white/10`}>
            {/* Title row */}
            <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-white truncate">{track.title}</h3>
                    {track.description && (
                        <p className="text-sm text-slate-400 mt-0.5 line-clamp-2">{track.description}</p>
                    )}
                </div>
                {confirmDelete ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                        <button
                            onClick={() => { onDelete(); setConfirmDelete(false); }}
                            disabled={isDeleting}
                            className="px-3 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 text-white transition-all active:scale-95 flex items-center gap-1"
                        >
                            {isDeleting ? (
                                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : 'Confirm'}
                        </button>
                        <button
                            onClick={() => setConfirmDelete(false)}
                            className="px-2 py-2 rounded-lg text-sm font-bold bg-slate-800/50 text-slate-400 hover:text-white transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => setConfirmDelete(true)}
                        className="shrink-0 px-3 py-2 rounded-lg text-sm font-bold bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-500/20 transition-all active:scale-95 flex items-center gap-1.5"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Remove
                    </button>
                )}
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 text-sm text-slate-500">
                <span className="bg-slate-800/60 px-2 py-0.5 rounded text-slate-400 font-bold">
                    {categoryLabel}
                </span>
                {track.region && (
                    <span className="truncate">📍 {track.region}</span>
                )}
                <span>{track.distance_nm.toFixed(1)} NM</span>
                <span>{track.point_count} pts</span>
                <span className="ml-auto shrink-0">{dateStr}</span>
            </div>

            {/* Download count */}
            {track.download_count > 0 && (
                <div className="mt-1.5 text-sm text-slate-600">
                    ↓ {track.download_count} download{track.download_count !== 1 ? 's' : ''}
                </div>
            )}
        </div>
    );
};
