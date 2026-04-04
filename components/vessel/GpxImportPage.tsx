/**
 * GpxImportPage — Import GPX files from OpenCPN, Navionics, and other navigation software.
 *
 * Supports:
 *   - File picker (native + web fallback)
 *   - GPX 1.1 routes (<rte>), tracks (<trk>), and waypoints (<wpt>)
 *   - Preview before import (map + summary stats)
 *   - Import into Ship's Log as a new voyage
 *   - Re-export as Thalassa GPX with weather extensions
 */

import React, { useState, useRef, useCallback } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('GpxImport');
import {
    readGPXFile,
    importGPXToEntries,
    extractGPXRouteWaypoints,
    type GpxRouteData,
} from '../../services/gpxService';
import { ShipLogService } from '../../services/ShipLogService';
import type { ShipLogEntry } from '../../types';
import { triggerHaptic } from '../../utils/system';
import { useUI } from '../../context/UIContext';

interface GpxImportPageProps {
    onBack: () => void;
}

interface GpxPreview {
    filename: string;
    entries: Partial<ShipLogEntry>[];
    metadata: {
        name: string;
        description: string;
        creator: string;
        time: string;
    };
    stats: {
        trackPoints: number;
        waypoints: number;
        totalDistanceNM: number;
        duration: string;
        bounds: {
            minLat: number;
            maxLat: number;
            minLon: number;
            maxLon: number;
        } | null;
    };
    rawXml: string;
}

type ImportState = 'idle' | 'reading' | 'previewing' | 'importing' | 'success' | 'error';

export const GpxImportPage: React.FC<GpxImportPageProps> = ({ onBack }) => {
    const [state, setState] = useState<ImportState>('idle');
    const [preview, setPreview] = useState<GpxPreview | null>(null);
    const [routeData, setRouteData] = useState<GpxRouteData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [importResult, setImportResult] = useState<{ voyageId: string; savedCount: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { setPage } = useUI();

    // ── Parse GPX metadata from raw XML ──
    const parseMetadata = useCallback((xml: string) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'application/xml');

        const getText = (tag: string): string => {
            const el = doc.querySelector(tag);
            return el?.textContent || '';
        };

        const metaName = getText('metadata > name') || getText('trk > name') || getText('rte > name');
        const metaDesc = getText('metadata > desc') || getText('trk > desc') || getText('rte > desc');
        const metaCreator = doc.documentElement?.getAttribute('creator') || '';
        const metaTime = getText('metadata > time') || getText('time') || '';

        return {
            name: metaName || 'Unnamed Route',
            description: metaDesc,
            creator: metaCreator,
            time: metaTime,
        };
    }, []);

    // ── Handle file selection ──
    const handleFileSelect = useCallback(
        async (file: File) => {
            try {
                setState('reading');
                setError(null);
                triggerHaptic('light');

                const rawXml = await readGPXFile(file);
                const entries = importGPXToEntries(rawXml);

                if (entries.length === 0) {
                    throw new Error('No track points or waypoints found in this GPX file.');
                }

                const metadata = parseMetadata(rawXml);

                // Calculate stats
                const trackPoints = entries.filter((e) => e.entryType === 'auto').length;
                const waypoints = entries.filter((e) => e.entryType === 'waypoint' || e.entryType === 'manual').length;

                const lastEntry = entries[entries.length - 1];
                const totalDistanceNM = lastEntry?.cumulativeDistanceNM || 0;

                // Calculate duration
                const firstTime = entries[0]?.timestamp ? new Date(entries[0].timestamp).getTime() : 0;
                const lastTime = lastEntry?.timestamp ? new Date(lastEntry.timestamp).getTime() : 0;
                const durationMs = lastTime - firstTime;
                const hours = Math.floor(durationMs / 3600000);
                const minutes = Math.floor((durationMs % 3600000) / 60000);
                const duration = hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m` : 'Unknown';

                // Calculate bounds
                const lats = entries.filter((e) => e.latitude !== undefined).map((e) => e.latitude!);
                const lons = entries.filter((e) => e.longitude !== undefined).map((e) => e.longitude!);
                const bounds =
                    lats.length > 0
                        ? {
                              minLat: Math.min(...lats),
                              maxLat: Math.max(...lats),
                              minLon: Math.min(...lons),
                              maxLon: Math.max(...lons),
                          }
                        : null;

                setPreview({
                    filename: file.name,
                    entries,
                    metadata,
                    stats: {
                        trackPoints,
                        waypoints,
                        totalDistanceNM: Math.round(totalDistanceNM * 10) / 10,
                        duration,
                        bounds,
                    },
                    rawXml,
                });

                setState('previewing');
                triggerHaptic('light');

                // Also try to extract navigable route for the Passage Planner
                try {
                    const route = extractGPXRouteWaypoints(rawXml);
                    setRouteData(route);
                    if (route) {
                        log.info(
                            `[Import] Route detected: ${route.routeName} — ${route.waypoints.length} waypoints, ${route.totalDistanceNM} NM`,
                        );
                    }
                } catch (routeErr) {
                    log.warn('[Import] Route extraction failed (non-critical):', routeErr);
                    setRouteData(null);
                }

                log.info(
                    `[Import] Parsed ${file.name}: ${trackPoints} track points, ${waypoints} waypoints, ${totalDistanceNM.toFixed(1)} NM`,
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Failed to parse GPX file';
                setError(msg);
                setState('error');
                triggerHaptic('heavy');
                log.error('[Import] Parse error:', err);
            }
        },
        [parseMetadata],
    );

    // ── Import into Ship's Log ──
    const handleImport = useCallback(async () => {
        if (!preview) return;

        try {
            setState('importing');
            triggerHaptic('medium');

            const result = await ShipLogService.importGPXVoyage(preview.entries);
            setImportResult(result);
            setState('success');
            triggerHaptic('light');
            log.info(`[Import] ✓ Imported ${result.savedCount} entries as voyage ${result.voyageId}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to import voyage';
            setError(msg);
            setState('error');
            triggerHaptic('heavy');
            log.error('[Import] Import error:', err);
        }
    }, [preview]);

    // ── Reset state ──
    const handleReset = useCallback(() => {
        setState('idle');
        setPreview(null);
        setRouteData(null);
        setError(null);
        setImportResult(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    // ── Route to Passage Planner ──
    const handleRouteToPlanner = useCallback(() => {
        if (!routeData) return;
        triggerHaptic('medium');

        // Build the passage-mode event detail
        const detail: Record<string, unknown> = {
            departure: {
                lat: routeData.origin.lat,
                lon: routeData.origin.lon,
                name: routeData.origin.name,
            },
            arrival: {
                lat: routeData.destination.lat,
                lon: routeData.destination.lon,
                name: routeData.destination.name,
            },
        };

        // Include intermediate waypoints if any
        if (routeData.waypoints.length > 2) {
            detail.via = routeData.waypoints.slice(1, -1).map((wp) => ({
                lat: wp.lat,
                lon: wp.lon,
                name: wp.name,
            }));
        }

        log.info(
            `[Import] Routing to Planner: ${routeData.routeName} — ` +
                `${routeData.origin.name} → ${routeData.destination.name}` +
                `${routeData.waypoints.length > 2 ? ` via ${routeData.waypoints.length - 2} waypoints` : ''}`,
        );

        // Navigate to map and dispatch passage event
        setPage('map');
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('thalassa:passage-mode', { detail }));
        }, 300);
    }, [routeData, setPage]);

    // ── DMS formatter ──
    const formatCoord = (value: number, posChar: string, negChar: string): string => {
        const absVal = Math.abs(value);
        const degrees = Math.floor(absVal);
        const minutes = ((absVal - degrees) * 60).toFixed(1);
        const dir = value >= 0 ? posChar : negChar;
        return `${degrees}°${minutes}'${dir}`;
    };

    return (
        <div className="relative flex-1 bg-slate-950 overflow-hidden flex flex-col">
            {/* ═══ HEADER ═══ */}
            <div className="shrink-0 px-4 pt-4 pb-3">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onBack}
                        aria-label="Go back"
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                    >
                        <svg
                            className="w-5 h-5 text-gray-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="flex-1">
                        <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Import GPX</h1>
                        <p className="text-[11px] text-gray-500 mt-0.5 tracking-wide">
                            OpenCPN • Navionics • iSailor • qtVLM
                        </p>
                    </div>
                    {/* GPX icon */}
                    <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                        <svg
                            className="w-5 h-5 text-emerald-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                            />
                        </svg>
                    </div>
                </div>
            </div>

            {/* ═══ CONTENT ═══ */}
            <div className="flex-1 overflow-y-auto px-4 pb-32">
                <div className="max-w-xl mx-auto space-y-4">
                    {/* ── IDLE: File picker ── */}
                    {(state === 'idle' || state === 'error') && (
                        <>
                            {/* Drop zone / file picker */}
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="w-full py-12 rounded-2xl border-2 border-dashed border-white/10 hover:border-emerald-500/40 bg-white/[0.02] hover:bg-emerald-500/[0.03] transition-all group"
                            >
                                <div className="flex flex-col items-center gap-3">
                                    <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                                        <svg
                                            className="w-8 h-8 text-emerald-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                            />
                                        </svg>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-sm font-bold text-white">Select GPX File</p>
                                        <p className="text-[11px] text-gray-500 mt-1">Supports .gpx and .xml formats</p>
                                    </div>
                                </div>
                            </button>

                            {/* Hidden file input */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".gpx,.xml,application/gpx+xml,text/xml"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) handleFileSelect(file);
                                }}
                            />

                            {/* Error display */}
                            {error && (
                                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3">
                                    <span className="text-red-400 text-lg">⚠️</span>
                                    <div className="flex-1">
                                        <p className="text-[13px] font-bold text-red-300">Import Failed</p>
                                        <p className="text-[11px] text-red-400/80 mt-1">{error}</p>
                                    </div>
                                    <button
                                        onClick={handleReset}
                                        className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                                    >
                                        <svg
                                            className="w-4 h-4 text-gray-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M6 18L18 6M6 6l12 12"
                                            />
                                        </svg>
                                    </button>
                                </div>
                            )}

                            {/* Compatibility info */}
                            <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-4">
                                <p className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-3">
                                    Compatible Software
                                </p>
                                <div className="grid grid-cols-2 gap-2">
                                    {[
                                        { name: 'OpenCPN', status: 'Full Support' },
                                        { name: 'Navionics', status: 'Routes & Tracks' },
                                        { name: 'iSailor', status: 'Routes & Tracks' },
                                        { name: 'qtVLM', status: 'Full Support' },
                                        { name: 'Expedition', status: 'Full Support' },
                                        { name: 'AvNav', status: 'Routes & Tracks' },
                                    ].map((app) => (
                                        <div
                                            key={app.name}
                                            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.02]"
                                        >
                                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[12px] font-bold text-white/80 truncate">
                                                    {app.name}
                                                </p>
                                                <p className="text-[10px] text-gray-500 truncate">{app.status}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Format info */}
                            <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-4 space-y-3">
                                <p className="text-[11px] font-bold text-white/60 uppercase tracking-widest">
                                    What Gets Imported
                                </p>
                                {[
                                    {
                                        icon: '📍',
                                        label: 'Route Waypoints',
                                        desc: 'Named waypoints with coordinates',
                                    },
                                    {
                                        icon: '🗺️',
                                        label: 'Track Points',
                                        desc: 'Position, speed, course, & timestamps',
                                    },
                                    {
                                        icon: '🌊',
                                        label: 'Weather Data',
                                        desc: 'Wind, waves, pressure (if available)',
                                    },
                                    {
                                        icon: '📏',
                                        label: 'Distance & Speed',
                                        desc: 'Calculated from track if not in file',
                                    },
                                ].map((item) => (
                                    <div key={item.label} className="flex items-start gap-3">
                                        <span className="text-base">{item.icon}</span>
                                        <div>
                                            <p className="text-[12px] font-bold text-white/80">{item.label}</p>
                                            <p className="text-[10px] text-gray-500">{item.desc}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}

                    {/* ── READING: Loading spinner ── */}
                    {state === 'reading' && (
                        <div className="py-20 flex flex-col items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center">
                                <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                            </div>
                            <p className="text-sm font-bold text-white/60">Parsing GPX file…</p>
                        </div>
                    )}

                    {/* ── PREVIEWING: Show parsed data ── */}
                    {state === 'previewing' && preview && (
                        <>
                            {/* File info card */}
                            <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-4">
                                <div className="flex items-start gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                                        <svg
                                            className="w-5 h-5 text-emerald-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={1.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                        </svg>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-[14px] font-black text-white truncate">
                                            {preview.metadata.name}
                                        </h3>
                                        {preview.metadata.description && (
                                            <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">
                                                {preview.metadata.description}
                                            </p>
                                        )}
                                        <p className="text-[10px] text-gray-500 mt-1 font-mono">
                                            {preview.filename}
                                            {preview.metadata.creator && ` • ${preview.metadata.creator}`}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* Stats grid */}
                            <div className="grid grid-cols-2 gap-2">
                                <StatCard
                                    label="Track Points"
                                    value={preview.stats.trackPoints.toLocaleString()}
                                    icon="📍"
                                    color="sky"
                                />
                                <StatCard
                                    label="Waypoints"
                                    value={preview.stats.waypoints.toString()}
                                    icon="🏁"
                                    color="purple"
                                />
                                <StatCard
                                    label="Distance"
                                    value={`${preview.stats.totalDistanceNM} NM`}
                                    icon="📏"
                                    color="emerald"
                                />
                                <StatCard label="Duration" value={preview.stats.duration} icon="⏱️" color="amber" />
                            </div>

                            {/* Bounds display */}
                            {preview.stats.bounds && (
                                <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-4">
                                    <p className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-2">
                                        Coverage Area
                                    </p>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 w-8">N:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.maxLat, 'N', 'S')}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 w-8">E:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.maxLon, 'E', 'W')}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 w-8">S:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.minLat, 'N', 'S')}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 w-8">W:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.minLon, 'E', 'W')}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Sample entries */}
                            <div className="rounded-2xl bg-white/[0.02] border border-white/5 p-4">
                                <p className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-3">
                                    Preview ({Math.min(5, preview.entries.length)} of {preview.entries.length} entries)
                                </p>
                                <div className="space-y-2">
                                    {preview.entries.slice(0, 5).map((entry, i) => (
                                        <div
                                            key={i}
                                            className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/[0.02]"
                                        >
                                            <div
                                                className={`w-2 h-2 rounded-full ${entry.entryType === 'waypoint' ? 'bg-purple-400' : 'bg-emerald-400'}`}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-[11px] font-mono text-white/70 truncate">
                                                    {entry.waypointName ||
                                                        entry.positionFormatted ||
                                                        `${entry.latitude?.toFixed(4)}°, ${entry.longitude?.toFixed(4)}°`}
                                                </p>
                                            </div>
                                            {entry.speedKts !== undefined && (
                                                <span className="text-[10px] font-mono text-sky-400">
                                                    {entry.speedKts.toFixed(1)} kts
                                                </span>
                                            )}
                                            {entry.distanceNM !== undefined && entry.distanceNM > 0 && (
                                                <span className="text-[10px] font-mono text-emerald-400">
                                                    {entry.distanceNM.toFixed(1)} NM
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    {/* ── IMPORTING: Progress ── */}
                    {state === 'importing' && (
                        <div className="py-20 flex flex-col items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                            </div>
                            <p className="text-sm font-bold text-white/60">Importing voyage…</p>
                            <p className="text-[11px] text-gray-500">{preview?.entries.length} entries</p>
                        </div>
                    )}

                    {/* ── SUCCESS: Import complete ── */}
                    {state === 'success' && importResult && (
                        <div className="py-12 flex flex-col items-center gap-6">
                            <div className="w-20 h-20 rounded-3xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <svg
                                    className="w-10 h-10 text-emerald-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            </div>
                            <div className="text-center">
                                <h2 className="text-xl font-extrabold text-white">Import Complete</h2>
                                <p className="text-[13px] text-emerald-400 font-bold mt-2">
                                    {importResult.savedCount} entries saved
                                </p>
                                <p className="text-[11px] text-gray-500 mt-1">{preview?.metadata.name}</p>
                            </div>

                            <div className="flex gap-3 w-full max-w-xs">
                                <button
                                    onClick={handleReset}
                                    className="flex-1 h-12 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm font-bold text-white transition-all"
                                >
                                    Import Another
                                </button>
                                <button
                                    onClick={onBack}
                                    className="flex-1 h-12 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/20 text-sm font-bold text-emerald-400 transition-all"
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ── BOTTOM CTA ── */}
            {state === 'previewing' && (
                <div
                    className="fixed bottom-0 left-0 right-0 px-4 z-10 pointer-events-none"
                    style={{
                        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                    }}
                >
                    <div className="max-w-xl mx-auto w-full pointer-events-auto space-y-2">
                        {/* Route to Planner CTA — only shows when navigable route detected */}
                        {routeData && (
                            <button
                                onClick={handleRouteToPlanner}
                                className="w-full h-14 rounded-2xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/30 text-white font-extrabold text-sm uppercase tracking-wider transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                            >
                                <svg
                                    className="w-5 h-5 text-sky-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
                                    />
                                </svg>
                                Route to Passage Planner
                                <span className="text-sky-400/60 text-[10px] font-mono ml-1">
                                    {routeData.waypoints.length} WP · {routeData.totalDistanceNM} NM
                                </span>
                            </button>
                        )}
                        <button
                            onClick={handleImport}
                            className="w-full h-14 rounded-2xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-white font-extrabold text-sm uppercase tracking-wider transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                        >
                            <svg
                                className="w-5 h-5 text-emerald-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                                />
                            </svg>
                            Import to Ship's Log
                        </button>
                        <button
                            onClick={handleReset}
                            className="w-full h-10 rounded-xl text-gray-500 hover:text-gray-300 text-[12px] font-bold uppercase tracking-wider transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

// ── Stat card sub-component ──
const StatCard: React.FC<{
    label: string;
    value: string;
    icon: string;
    color: 'sky' | 'emerald' | 'purple' | 'amber';
}> = ({ label, value, icon, color }) => {
    const colorMap = {
        sky: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
        emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
        purple: 'bg-purple-500/10 border-purple-500/20 text-purple-400',
        amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    };

    return (
        <div className={`rounded-xl border p-3 ${colorMap[color]}`}>
            <div className="flex items-center gap-2 mb-1">
                <span className="text-base">{icon}</span>
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">{label}</p>
            </div>
            <p className="text-lg font-extrabold">{value}</p>
        </div>
    );
};
