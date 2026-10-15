/**
 * GpxImportPage — Import GPX files from OpenCPN, Navionics, and other navigation software.
 *
 * Supports:
 *   - File picker (native + web fallback)
 *   - GPX 1.1 routes (<rte>), tracks (<trk>), and waypoints (<wpt>)
 *   - Preview before import (map + summary stats)
 *   - Import into Ship's Log as a new voyage, with progress, Cancel and Retry
 *   - Re-export as Thalassa GPX with weather extensions
 */

import React, { useState, useRef, useCallback } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('GpxImport');
import {
    readGPXFile,
    parseGPXTrack,
    extractGPXRouteWaypoints,
    GPX_IMPORT_MAX_TRACK_POINTS,
    type GpxBounds,
    type GpxRouteData,
} from '../../services/gpxService';
import { ShipLogService } from '../../services/ShipLogService';
import type { ShipLogEntry } from '../../types';
import { triggerHaptic } from '../../utils/system';
import { useUI } from '../../context/UIContext';
import { requestPassageMode, stagePassageRequest, type PassageHandoffDetail } from '../../services/passageHandoff';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { AlertTriangleIcon, ClockIcon, FlagIcon, InfoIcon, MapIcon, MapPinIcon, RouteIcon, WaveIcon } from '../Icons';
import { getAuthIdentityScope } from '../../services/authIdentityScope';
import { openedFromBinder } from '../vesselHub/binderReturn';
import {
    classifyImportSaveFailure,
    formatCoord,
    formatImportDuration,
    gpxImportNotes,
    importSaveFailureMessage,
    spokenCoord,
} from './gpxImportPreview';

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
        bounds: GpxBounds | null;
    };
    /** What the import decided that the file didn't say: thinning, untimed points, segments (132-B21). */
    notes: string[];
    /** One voyage id per preview, so Retry saves into the same voyage and never doubles it. */
    voyageId?: string;
    rawXml: string;
}

/** A fresh voyage id for a preview, when this WebView can make one; else the import makes its own. */
function newImportVoyageId(): string | undefined {
    try {
        return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : undefined;
    } catch {
        return undefined;
    }
}

/** The phone's own online flag; assume online where there is none. */
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

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
function readErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : '';
    if (raw.startsWith('Invalid file type')) return "That isn't a GPX file. Choose a file ending in .gpx or .xml.";
    if (raw.startsWith('Invalid GPX file'))
        return "This file couldn't be read as GPX. It may be damaged, or saved in another format. Export it again as GPX and try once more.";
    if (raw.startsWith('No track points')) return 'This file has no track, route or waypoints to import.';
    if (raw === 'Failed to read file' || raw === 'Error reading file')
        return "The file couldn't be opened. Choose it again.";
    return "This file couldn't be read. Check it is a GPX file and try again.";
}

/**
 * Back returns to the Boat Binder when the binder opened this page just now,
 * else to Vessel. Opened from Plan, a mark left from an earlier binder visit
 * no longer sends Back to the binder (131-B12, BH-10).
 */
function readParentCrumb(arrivedFrom: string | undefined): string {
    return openedFromBinder('gpx-import', arrivedFrom) ? 'Boat Binder' : 'Vessel';
}

/**
 * Height of the fixed preview CTA stack, from the page bottom: the 4rem +
 * safe-area + 8px pad under it, then Route (h-14) + gap, Import (h-14) + gap,
 * Cancel (h-11, floored to 44px in index.css). The scroller masks this band
 * so content never shows through the translucent buttons. A route-only file
 * has nothing for the log, so it has no Import button (132-B21).
 */
const previewCtaFootprint = (hasRoute: boolean, hasEntries: boolean) =>
    `calc(4rem + env(safe-area-inset-bottom) + 8px + ${(hasRoute ? 4 : 0) + (hasEntries ? 4 : 0)}rem + max(44px, 2.75rem))`;

export const GpxImportPage: React.FC<GpxImportPageProps> = ({ onBack }) => {
    const [state, setState] = useState<ImportState>('idle');
    const [preview, setPreview] = useState<GpxPreview | null>(null);
    const [routeData, setRouteData] = useState<GpxRouteData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { setPage, previousView } = useUI();
    // Every other Boat Binder page carries a crumb; this one had none (UX
    // scorecard run 7). It names where Back actually goes.
    const [parentCrumb] = useState(() => readParentCrumb(previousView));
    const [importResult, setImportResult] = useState<{ voyageId: string; savedCount: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // A failed or cancelled save keeps the preview, with the reason and a
    // Retry (132-B21). Read errors still use `error`: there is no preview.
    const [saveError, setSaveError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ saved: number; total: number }>({ saved: 0, total: 0 });
    const [cancelling, setCancelling] = useState(false);
    const importAbortRef = useRef<AbortController | null>(null);
    // What VoiceOver hears at each step. Failures are role="alert" banners
    // instead, so they are not said twice.
    const [announcement, setAnnouncement] = useState('');
    const announcedQuarterRef = useRef(0);

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
                setSaveError(null);
                setNotice(null);
                setAnnouncement(`Reading ${file.name}.`);
                triggerHaptic('light');

                const rawXml = await readGPXFile(file);
                // True times, segment-by-segment distance through the voyage
                // gate, and a long track thinned after its distance is known
                // (132-B21).
                const parsed = parseGPXTrack(rawXml, { maxTrackPoints: GPX_IMPORT_MAX_TRACK_POINTS });
                const entries = parsed.entries;

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

                // Stats come from the TRACK, as the parser measured it over
                // every point before thinning: distance through the voyage
                // gate, duration between the file's own first and last times
                // (never a waypoint's, never the import time), and bounds by
                // a loop that handles the 180° line.
                const trackPoints = parsed.trackPoints;
                const waypoints = entries.filter((e) => e.entryType === 'waypoint' || e.entryType === 'manual').length;
                const totalDistanceNM = Math.round(parsed.totalDistanceNM * 10) / 10;
                const notes = gpxImportNotes(parsed);

                setPreview({
                    filename: file.name,
                    entries,
                    metadata,
                    stats: {
                        trackPoints,
                        waypoints,
                        totalDistanceNM,
                        duration: formatImportDuration(parsed.firstTimeMs, parsed.lastTimeMs),
                        bounds: parsed.bounds,
                    },
                    notes,
                    voyageId: newImportVoyageId(),
                    rawXml,
                });

                setState('previewing');
                setAnnouncement(
                    `Preview ready. ${metadata.name}: ${trackPoints.toLocaleString()} track points, ` +
                        `${totalDistanceNM} nautical miles.` +
                        (notes.length > 0 ? ` ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} below.` : ''),
                );
                triggerHaptic('light');

                // Hand the route (extracted above) to the Passage Planner path.
                setRouteData(route);
                if (route) {
                    log.info(
                        `[Import] Route detected: ${route.routeName} — ${route.waypoints.length} waypoints, ${route.totalDistanceNM} NM`,
                    );
                }

                log.info(
                    `[Import] Parsed ${file.name}: ${trackPoints} track points (${parsed.savedTrackPoints} kept), ${waypoints} waypoints, ${totalDistanceNM.toFixed(1)} NM`,
                );
            } catch (err) {
                setError(readErrorMessage(err));
                setState('error');
                setAnnouncement('');
                triggerHaptic('heavy');
                log.error('[Import] Parse error:', err);
            }
        },
        [parseMetadata],
    );

    // ── Import into Ship's Log ──
    // Progress after every chunk, a Cancel that stops it, and a failure that
    // keeps the preview with the reason and a Retry (132-B21). The same
    // voyage id every attempt, so a retry never doubles the voyage.
    const handleImport = useCallback(async () => {
        if (!preview || preview.entries.length === 0) return;
        const controller = new AbortController();
        importAbortRef.current = controller;
        announcedQuarterRef.current = 0;
        const total = preview.entries.length;

        setSaveError(null);
        setNotice(null);
        setCancelling(false);
        setProgress({ saved: 0, total });
        setState('importing');
        setAnnouncement(`Saving ${total.toLocaleString()} entries to the Ship's Log.`);
        triggerHaptic('medium');

        try {
            const result = await ShipLogService.importGPXVoyage(preview.entries, {
                voyageId: preview.voyageId,
                signal: controller.signal,
                onProgress: (saved, of) => {
                    setProgress({ saved, total: of });
                    // A quarter at a time, so VoiceOver isn't talking over every chunk.
                    const quarter = Math.floor((saved / of) * 4);
                    if (saved < of && quarter > announcedQuarterRef.current) {
                        announcedQuarterRef.current = quarter;
                        setAnnouncement(`Saved ${saved.toLocaleString()} of ${of.toLocaleString()} entries.`);
                    }
                },
            });
            setImportResult(result);
            setState('success');
            setAnnouncement(`Import complete. ${result.savedCount.toLocaleString()} entries saved.`);
            triggerHaptic('light');
            log.info(`[Import] ✓ Imported ${result.savedCount} entries as voyage ${result.voyageId}`);
        } catch (err) {
            if (controller.signal.aborted) {
                const message = "Import cancelled. Nothing was added to the Ship's Log.";
                setNotice(message);
                setState('previewing');
                setAnnouncement(message);
                log.info('[Import] Cancelled by the skipper');
                return;
            }
            setSaveError(importSaveFailureMessage(classifyImportSaveFailure(err, isOnline())));
            setState('previewing');
            setAnnouncement('');
            triggerHaptic('heavy');
            log.error('[Import] Import error:', err);
        } finally {
            if (importAbortRef.current === controller) importAbortRef.current = null;
            setCancelling(false);
        }
    }, [preview]);

    // ── Cancel a save in progress ──
    // The import stops between chunks; what it saved is removed by the voyage
    // fence before the promise settles, so "Cancelling…" holds until then.
    const handleCancelImport = useCallback(() => {
        if (!importAbortRef.current) return;
        setCancelling(true);
        setAnnouncement('Cancelling.');
        triggerHaptic('light');
        importAbortRef.current.abort();
    }, []);

    // ── Reset state ──
    const handleReset = useCallback(() => {
        setState('idle');
        setPreview(null);
        setRouteData(null);
        setError(null);
        setSaveError(null);
        setNotice(null);
        setImportResult(null);
        setAnnouncement('');
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

    const hasEntries = (preview?.entries.length ?? 0) > 0;
    const progressPct = progress.total > 0 ? Math.round((progress.saved / progress.total) * 100) : 0;

    return (
        // h-full: the page is exactly the view's height, so the list below is
        // the scroller (it used to grow the page and scroll the app's wrapper
        // under the tab bar, header and all). It is also the containing block
        // for the fixed CTA (slide-up-enter keeps a transform), which now sits
        // at the bottom of the screen instead of the bottom of the content.
        <div className="relative flex h-full flex-1 flex-col overflow-hidden bg-slate-950 slide-up-enter">
            {/* Each step, said once: reading, preview ready, saving by the
                quarter, done or cancelled (132-B21). Always mounted, so
                VoiceOver hears the text change. */}
            <p className="sr-only" role="status" aria-live="polite">
                {announcement}
            </p>
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
                              '--thalassa-scroll-fade-inset': previewCtaFootprint(!!routeData, hasEntries),
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
                                <div
                                    role="alert"
                                    className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3"
                                >
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
                            {/* A failed save says why, and the preview stays for
                                Retry (the Import button below) (132-B21). */}
                            {saveError && (
                                <div
                                    role="alert"
                                    className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3"
                                >
                                    <AlertTriangleIcon className="w-5 h-5 mt-0.5 shrink-0 text-red-400" />
                                    <div className="flex-1">
                                        <p className="text-[13px] font-bold text-red-300">Not saved</p>
                                        <p className="text-xs text-red-300/90 mt-1">{saveError}</p>
                                    </div>
                                </div>
                            )}
                            {notice && (
                                <div className="bg-sky-500/10 border border-sky-500/20 rounded-xl p-4 flex items-start gap-3">
                                    <InfoIcon className="w-5 h-5 mt-0.5 shrink-0 text-sky-400" />
                                    <p className="flex-1 text-xs text-sky-200">{notice}</p>
                                </div>
                            )}

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

                            {/* What the import decided that the file didn't say:
                                thinning, untimed points, segments (132-B21). */}
                            {preview.notes.length > 0 && (
                                <div className="rounded-2xl bg-white/2 border border-white/5 p-4">
                                    <h2 className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-2">
                                        Before you import
                                    </h2>
                                    <ul role="list" className="space-y-2">
                                        {preview.notes.map((note) => (
                                            <li key={note} className="flex items-start gap-2">
                                                <InfoIcon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sky-400" />
                                                <p className="text-[12px] leading-relaxed text-white/75">{note}</p>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Bounds display. The edges come from the parser, which
                                handles the 180° line: across it, W reads an east
                                longitude and E a west one, as on the chart. Each
                                edge is spoken in words, not ° and ' (132-B21). */}
                            {preview.stats.bounds && (
                                <div className="rounded-2xl bg-white/2 border border-white/5 p-4">
                                    <h2 className="text-[11px] font-bold text-white/60 uppercase tracking-widest mb-2">
                                        Coverage area
                                    </h2>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                        {(
                                            [
                                                ['N', 'North', preview.stats.bounds.maxLat, 'N', 'S'],
                                                ['E', 'East', preview.stats.bounds.maxLon, 'E', 'W'],
                                                ['S', 'South', preview.stats.bounds.minLat, 'N', 'S'],
                                                ['W', 'West', preview.stats.bounds.minLon, 'E', 'W'],
                                            ] as const
                                        ).map(([edge, edgeWord, value, pos, neg]) => (
                                            <div key={edge} className="flex items-center gap-2">
                                                <span className="sr-only">
                                                    {`${edgeWord} edge: ${spokenCoord(value, pos, neg)}`}
                                                </span>
                                                <span aria-hidden="true" className="text-[11px] text-gray-500 w-8">
                                                    {edge}:
                                                </span>
                                                <span
                                                    aria-hidden="true"
                                                    className="text-[12px] font-mono text-white/80"
                                                >
                                                    {formatCoord(value, pos, neg)}
                                                </span>
                                            </div>
                                        ))}
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

                    {/* ── IMPORTING: Progress ──
                        Entries saved so far, and a Cancel. A long track used
                        to sit on a spinner with no way out (132-B21). */}
                    {state === 'importing' && (
                        <div className="py-20 flex flex-col items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                            </div>
                            <p className="text-sm font-bold text-white/60">
                                {cancelling ? 'Cancelling…' : "Saving to the Ship's Log…"}
                            </p>
                            <div
                                role="progressbar"
                                aria-label="Saving voyage"
                                aria-valuemin={0}
                                aria-valuemax={progress.total}
                                aria-valuenow={progress.saved}
                                aria-valuetext={`${progress.saved.toLocaleString()} of ${progress.total.toLocaleString()} entries saved`}
                                className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-white/10"
                            >
                                <div
                                    className="h-full rounded-full bg-emerald-400 transition-[width] duration-300"
                                    style={{ width: `${progressPct}%` }}
                                />
                            </div>
                            <p className="text-[11px] text-gray-500" aria-hidden="true">
                                {progress.saved.toLocaleString()} of {progress.total.toLocaleString()} entries
                            </p>
                            {/* h-11: a 44 pt target, like the preview's Cancel. */}
                            <button
                                onClick={handleCancelImport}
                                disabled={cancelling}
                                className="h-11 px-6 rounded-xl text-gray-400 hover:text-gray-200 text-sm font-bold transition-colors disabled:opacity-50"
                            >
                                {cancelling ? 'Cancelling…' : 'Cancel import'}
                            </button>
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
                        {/* A route-only file has nothing for the log: no button
                            that can only fail. After a failed save it reads
                            Retry; the banner above says why (132-B21). */}
                        {hasEntries && (
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
                                {saveError ? 'Retry import' : "Import to Ship's Log"}
                            </button>
                        )}
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
// VoiceOver read before every label ('stopwatch Duration'). The label is in
// the card's full colour (132-B20): at 60% the 11 px words measured 3.2 to
// 4.5:1 on their tinted cards, under the 4.5:1 floor; now 6.7 to 10.5:1.
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
                <p className="text-[11px] font-bold uppercase tracking-widest">{label}</p>
            </div>
            <p className="text-lg font-extrabold">{value}</p>
        </div>
    );
};
