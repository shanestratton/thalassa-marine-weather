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
import { requestPassageMode, stagePassageRequest, type PassageHandoffDetail } from '../../services/passageHandoff';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { AlertTriangleIcon, ClockIcon, FlagIcon, MapIcon, MapPinIcon, RouteIcon, WaveIcon } from '../Icons';
import { authScopedStorageKey, getAuthIdentityScope } from '../../services/authIdentityScope';

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

/** The page's two lists, as data. Support is spelled out: 'Full Support'
 *  next to 'Routes & Tracks' never said what 'full' added (waypoints). */
const FULL_SUPPORT = 'Routes, tracks and waypoints';
const ROUTES_AND_TRACKS = 'Routes and tracks';
const COMPATIBLE_APPS = [
    { name: 'OpenCPN', status: FULL_SUPPORT },
    { name: 'Navionics', status: ROUTES_AND_TRACKS },
    { name: 'iSailor', status: ROUTES_AND_TRACKS },
    { name: 'qtVLM', status: FULL_SUPPORT },
    { name: 'Expedition', status: FULL_SUPPORT },
    { name: 'AvNav', status: ROUTES_AND_TRACKS },
];

const IMPORTED_ITEMS: { Icon: React.FC<{ className?: string }>; label: string; desc: string }[] = [
    { Icon: MapPinIcon, label: 'Route waypoints', desc: 'Named waypoints with their positions' },
    { Icon: MapIcon, label: 'Track points', desc: 'Position, speed, course and time' },
    { Icon: WaveIcon, label: 'Weather data', desc: 'Wind, waves and pressure, when the file has them' },
    { Icon: RouteIcon, label: 'Distance and speed', desc: 'Worked out from the track when the file has none' },
];

/**
 * A failure in words a skipper can act on. The raw exception ('Invalid GPX
 * file: <parsererror dump>') went straight to the page (UX scorecard run 7);
 * it still goes to the log.
 */
function importErrorMessage(err: unknown, stage: 'read' | 'import'): string {
    const raw = err instanceof Error ? err.message : '';
    if (stage === 'import') return "The voyage couldn't be saved to the Ship's Log. Try again.";
    if (raw.startsWith('Invalid file type')) return "That isn't a GPX file. Choose a file ending in .gpx or .xml.";
    if (raw.startsWith('Invalid GPX file'))
        return "This file couldn't be read as GPX. It may be damaged, or saved in another format. Export it again as GPX and try once more.";
    if (raw.startsWith('No track points')) return 'This file has no track, route or waypoints to import.';
    if (raw === 'Failed to read file' || raw === 'Error reading file')
        return "The file couldn't be opened. Choose it again.";
    return "This file couldn't be read. Check it is a GPX file and try again.";
}

/** Back returns to the Boat Binder when the binder opened this page, else to Vessel. */
function readParentCrumb(): string {
    try {
        return sessionStorage.getItem(authScopedStorageKey('thalassa_boat_binder_return')) === '1'
            ? 'Boat Binder'
            : 'Vessel';
    } catch {
        return 'Vessel';
    }
}

/**
 * Height of the fixed preview CTA stack, from the page bottom: the 4rem +
 * safe-area + 8px pad under it, then Route (h-14) + gap, Import (h-14) + gap,
 * Cancel (h-11, floored to 44px in index.css). The scroller masks this band
 * so content never shows through the translucent buttons.
 */
const previewCtaFootprint = (hasRoute: boolean) =>
    `calc(4rem + env(safe-area-inset-bottom) + 8px + ${hasRoute ? '8rem' : '4rem'} + max(44px, 2.75rem))`;

export const GpxImportPage: React.FC<GpxImportPageProps> = ({ onBack }) => {
    const [state, setState] = useState<ImportState>('idle');
    const [preview, setPreview] = useState<GpxPreview | null>(null);
    const [routeData, setRouteData] = useState<GpxRouteData | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Every other Boat Binder page carries a crumb; this one had none (UX
    // scorecard run 7). It names where Back actually goes.
    const [parentCrumb] = useState(readParentCrumb);
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
            name: metaName || 'Unnamed route',
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

                // Extract the navigable route FIRST. A route-only file (<rte>/
                // <rtept>, the kind a chartplotter exports) has no track points
                // or waypoints, so the emptiness check below used to throw
                // before this ran — and "Route to Passage Planner" was
                // unreachable for exactly the files it exists for (audit
                // 2026-09-02). Non-critical if it fails: the log import still
                // proceeds.
                let route: ReturnType<typeof extractGPXRouteWaypoints> = null;
                try {
                    route = extractGPXRouteWaypoints(rawXml);
                } catch (routeErr) {
                    log.warn('[Import] Route extraction failed (non-critical):', routeErr);
                }

                if (entries.length === 0 && !route) {
                    throw new Error('No track points, waypoints or route found in this GPX file.');
                }

                const metadata = parseMetadata(rawXml);

                // Calculate stats — from TRACK points only. Waypoints sort by
                // position, so the last entry could be an untimed <wpt> and the
                // distance read "0 NM" with a duration of hours-since-recording.
                const track = entries.filter((e) => e.entryType === 'auto');
                const trackPoints = track.length;
                const waypoints = entries.filter((e) => e.entryType === 'waypoint' || e.entryType === 'manual').length;

                const lastEntry = track[track.length - 1];
                const totalDistanceNM = lastEntry?.cumulativeDistanceNM || 0;

                // Calculate duration
                const firstTime = track[0]?.timestamp ? new Date(track[0].timestamp).getTime() : 0;
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

                // Hand the route (extracted above) to the Passage Planner path.
                setRouteData(route);
                if (route) {
                    log.info(
                        `[Import] Route detected: ${route.routeName} — ${route.waypoints.length} waypoints, ${route.totalDistanceNM} NM`,
                    );
                }

                log.info(
                    `[Import] Parsed ${file.name}: ${trackPoints} track points, ${waypoints} waypoints, ${totalDistanceNM.toFixed(1)} NM`,
                );
            } catch (err) {
                setError(importErrorMessage(err, 'read'));
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
            setError(importErrorMessage(err, 'import'));
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
        const detail: PassageHandoffDetail = {
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

        // Stage before navigation so the destination MapHub suppresses chart
        // overlays on its very first frame. The delayed broadcast still wakes
        // an already-mounted destination and preserves the existing handoff.
        const operationScope = getAuthIdentityScope();
        stagePassageRequest(detail, operationScope);
        setPage('map');
        setTimeout(() => {
            requestPassageMode(detail, operationScope);
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
        // h-full: the page is exactly the view's height, so the list below is
        // the scroller (it used to grow the page and scroll the app's wrapper
        // under the tab bar, header and all). It is also the containing block
        // for the fixed CTA (slide-up-enter keeps a transform), which now sits
        // at the bottom of the screen instead of the bottom of the content.
        <div className="relative flex h-full flex-1 flex-col overflow-hidden bg-slate-950 slide-up-enter">
            {/* No brand names in the subtitle: PageHeader uppercases it (ISAILOR,
                QTVLM), and the app list below names them properly. */}
            <PageHeader
                title="Import GPX"
                subtitle="Routes and tracks from other apps"
                onBack={onBack}
                breadcrumbs={[parentCrumb, 'Import GPX']}
            />

            {/* ═══ CONTENT ═══ */}
            {/* The scroller runs to the bottom of the screen, under the tab bar.
                .thalassa-scroll-fade masks the band under the footer and fades the
                14px above it, so 'Weather Data' is never sliced at the bar's edge.
                The footer is the tab bar (--nav, pb-32 clears it + 16px), except
                while previewing: then it is the fixed CTA stack, so the mask and
                the padding follow the stack that is actually on screen. The CTA
                is a sibling of this scroller, never inside it, so the mask cannot
                fade the buttons. */}
            <div
                className={`thalassa-scroll-fade flex-1 overflow-y-auto px-4 ${
                    state === 'previewing' ? '' : 'thalassa-scroll-fade--nav pb-32'
                }`}
                style={
                    state === 'previewing'
                        ? ({
                              '--thalassa-scroll-fade-inset': previewCtaFootprint(!!routeData),
                              paddingBottom: 'calc(var(--thalassa-scroll-fade-inset) + 1rem)',
                          } as React.CSSProperties)
                        : undefined
                }
            >
                <div className="max-w-xl mx-auto space-y-4">
                    {/* ── IDLE: File picker ── */}
                    {(state === 'idle' || state === 'error') && (
                        <>
                            {/* Drop zone / file picker */}
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="w-full py-12 rounded-2xl border-2 border-dashed border-white/10 hover:border-emerald-500/40 bg-white/2 hover:bg-emerald-500/3 transition-all group"
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
                                        <p className="text-sm font-bold text-white">Select GPX file</p>
                                        <p className="text-[11px] text-gray-500 mt-1">Supports .gpx and .xml formats</p>
                                    </div>
                                </div>
                            </button>

                            {/* Where an import ends up — the page never said. */}
                            <p className="px-1 text-xs text-gray-400 leading-relaxed">
                                Tracks and waypoints import to the Ship&apos;s Log as a voyage. A file with a route can
                                also open in the passage planner.
                            </p>

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
                                    <AlertTriangleIcon className="w-5 h-5 mt-0.5 shrink-0 text-red-400" />
                                    <div className="flex-1">
                                        <p className="text-[13px] font-bold text-red-300">Import failed</p>
                                        <p className="text-xs text-red-300/90 mt-1">{error}</p>
                                    </div>
                                    <button
                                        aria-label="Dismiss import error"
                                        onClick={handleReset}
                                        className="-m-2.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/5 transition-colors"
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

                            {/* Compatibility info — a section heading and a plain list.
                                Rows, not tiles: the boxed tiles looked tappable and
                                did nothing (UX scorecard run 6). */}
                            <div className="rounded-2xl bg-white/2 border border-white/5 p-4">
                                <h2 className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-1">
                                    Compatible software
                                </h2>
                                {/* role="list": WebKit drops list semantics from a
                                    ul whose markers are reset, as Tailwind's are.
                                    The dividers take slate-200 by day: white/5 on
                                    the light card measured rgb 247 on 246 and
                                    vanished (UX scorecard run 9). */}
                                <ul role="list" className="divide-y divide-white/5 [.display-light_&]:divide-slate-200">
                                    {COMPATIBLE_APPS.map((app) => (
                                        <li key={app.name} className="flex items-baseline justify-between gap-3 py-2">
                                            <span className="text-[12px] font-bold text-white/80">{app.name}</span>
                                            <span className="text-right text-[11px] text-gray-400">{app.status}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            {/* Format info — line icons from the app's set in place of
                                emoji (VoiceOver read '📍' as 'round pushpin'). */}
                            <div className="rounded-2xl bg-white/2 border border-white/5 p-4">
                                <h2 className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-3">
                                    What gets imported
                                </h2>
                                <ul role="list" className="space-y-3">
                                    {IMPORTED_ITEMS.map(({ Icon, label, desc }) => (
                                        <li key={label} className="flex items-start gap-3">
                                            <Icon className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
                                            <div>
                                                <p className="text-[12px] font-bold text-white/80">{label}</p>
                                                <p className="text-[11px] text-gray-500">{desc}</p>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
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
                            <div className="rounded-2xl bg-white/3 border border-white/10 p-4">
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
                                        <h2 className="text-[14px] font-black text-white truncate">
                                            {preview.metadata.name}
                                        </h2>
                                        {preview.metadata.description && (
                                            <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">
                                                {preview.metadata.description}
                                            </p>
                                        )}
                                        <p className="text-[11px] text-gray-500 mt-1 font-mono">
                                            {preview.filename}
                                            {preview.metadata.creator && ` • ${preview.metadata.creator}`}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* Stats grid */}
                            <div className="grid grid-cols-2 gap-2">
                                <StatCard
                                    label="Track points"
                                    value={preview.stats.trackPoints.toLocaleString()}
                                    Icon={MapPinIcon}
                                    color="sky"
                                />
                                <StatCard
                                    label="Waypoints"
                                    value={preview.stats.waypoints.toString()}
                                    Icon={FlagIcon}
                                    color="purple"
                                />
                                <StatCard
                                    label="Distance"
                                    value={`${preview.stats.totalDistanceNM} NM`}
                                    Icon={RouteIcon}
                                    color="emerald"
                                />
                                <StatCard
                                    label="Duration"
                                    value={preview.stats.duration}
                                    Icon={ClockIcon}
                                    color="amber"
                                />
                            </div>

                            {/* Bounds display */}
                            {preview.stats.bounds && (
                                <div className="rounded-2xl bg-white/2 border border-white/5 p-4">
                                    <h2 className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-2">
                                        Coverage area
                                    </h2>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] text-gray-500 w-8">N:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.maxLat, 'N', 'S')}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] text-gray-500 w-8">E:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.maxLon, 'E', 'W')}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] text-gray-500 w-8">S:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.minLat, 'N', 'S')}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] text-gray-500 w-8">W:</span>
                                            <span className="text-[12px] font-mono text-white/80">
                                                {formatCoord(preview.stats.bounds.minLon, 'E', 'W')}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Sample entries */}
                            <div className="rounded-2xl bg-white/2 border border-white/5 p-4">
                                <h2 className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-3">
                                    Preview ({Math.min(5, preview.entries.length)} of {preview.entries.length} entries)
                                </h2>
                                <div className="space-y-2">
                                    {preview.entries.slice(0, 5).map((entry, i) => (
                                        <div
                                            key={i}
                                            className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/2"
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
                                                <span className="text-[11px] font-mono text-sky-400">
                                                    {entry.speedKts.toFixed(1)} kts
                                                </span>
                                            )}
                                            {entry.distanceNM !== undefined && entry.distanceNM > 0 && (
                                                <span className="text-[11px] font-mono text-emerald-400">
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
                                <h2 className="text-xl font-extrabold text-white">Import complete</h2>
                                <p className="text-[13px] text-emerald-400 font-bold mt-2">
                                    {importResult.savedCount} entries saved
                                </p>
                                <p className="text-[11px] text-gray-500 mt-1">{preview?.metadata.name}</p>
                            </div>

                            <div className="flex gap-3 w-full max-w-xs">
                                <Button variant="secondary" onClick={handleReset} className="flex-1 h-12 text-white">
                                    Import another
                                </Button>
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
                                className="w-full h-14 rounded-2xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/30 text-white font-extrabold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2"
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
                                Route to passage planner
                                <span className="text-sky-300/80 text-[11px] font-mono ml-1">
                                    {routeData.waypoints.length} WP · {routeData.totalDistanceNM} NM
                                </span>
                            </button>
                        )}
                        <button
                            onClick={handleImport}
                            className="w-full h-14 rounded-2xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-white font-extrabold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2"
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
                        {/* h-11: a 44 pt target (h-10 was 40px, 33px at the smallest
                            root size). previewCtaFootprint counts this height. */}
                        <button
                            onClick={handleReset}
                            className="w-full h-11 rounded-xl text-gray-400 hover:text-gray-200 text-sm font-bold transition-colors"
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
// A line icon (aria-hidden, currentColor) in place of the emoji, which
// VoiceOver read before every label ('stopwatch Duration').
const StatCard: React.FC<{
    label: string;
    value: string;
    Icon: React.FC<{ className?: string }>;
    color: 'sky' | 'emerald' | 'purple' | 'amber';
}> = ({ label, value, Icon, color }) => {
    const colorMap = {
        sky: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
        emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
        purple: 'bg-purple-500/10 border-purple-500/20 text-purple-400',
        amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    };

    return (
        <div className={`rounded-xl border p-3 ${colorMap[color]}`}>
            <div className="flex items-center gap-2 mb-1">
                <Icon className="w-4 h-4 shrink-0" />
                <p className="text-[11px] font-bold uppercase tracking-widest opacity-60">{label}</p>
            </div>
            <p className="text-lg font-extrabold">{value}</p>
        </div>
    );
};
