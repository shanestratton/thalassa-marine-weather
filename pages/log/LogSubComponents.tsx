/**
 * Log Page Sub-Components
 *
 * Extracted from LogPage.tsx — VoyageCard, FollowRouteButton, MenuBtn, StatBox.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CompassIcon, WindIcon } from '../../components/Icons';
import { ShipLogEntry, VoyagePlan } from '../../types';
import { useFollowRoute } from '../../context/FollowRouteContext';
import { DateGroupedTimeline } from '../../components/DateGroupedTimeline';
import { LiveMiniMap } from '../../components/LiveMiniMap';
import { groupEntriesByDate } from '../../utils/voyageData';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('LogPage');

export const StatBox: React.FC<{ label: string; value: string | number }> = React.memo(({ label, value }) => (
    <div className="bg-slate-800 rounded-lg p-3 text-center">
        <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">{label}</div>
        <div className="text-xl font-bold text-white">{value}</div>
    </div>
));

export const _LogEntryCard: React.FC<{ entry: ShipLogEntry }> = React.memo(({ entry }) => {
    const timestamp = new Date(entry.timestamp);
    const timeStr = timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const typeColors = {
        auto: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
        manual: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
        waypoint: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
    };

    // Land/water coloring: blue = water, green = land, white = unknown
    // Land = emerald (app-wide land color), Water = sky (app-wide water color)
    const envColor =
        entry.isOnWater === true ? 'text-sky-400' : entry.isOnWater === false ? 'text-emerald-400' : 'text-white';
    const envDot =
        entry.isOnWater === true ? 'bg-sky-400' : entry.isOnWater === false ? 'bg-emerald-400' : 'bg-slate-500';

    return (
        <div className="bg-slate-800/40 rounded-lg p-3 border border-white/5 mb-2">
            <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold border ${typeColors[entry.entryType]}`}>
                        {entry.entryType.toUpperCase()}
                    </span>
                    <div className={`w-1.5 h-1.5 rounded-full ${envDot}`}></div>
                    <span className={`text-sm ${envColor}`}>{timeStr}</span>
                    <span className="text-xs text-slate-500">{dateStr}</span>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
                <div className={`flex items-center gap-1 ${envColor} opacity-70`}>
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
                {entry.airTemp !== null && entry.airTemp !== undefined && (
                    <div className="flex items-center gap-1 text-slate-400">
                        <span className="text-[11px]">🌡</span>
                        {typeof entry.airTemp === 'number' ? entry.airTemp.toFixed(1) : entry.airTemp}°C
                    </div>
                )}
                {entry.notes && <div className="col-span-2 text-slate-300 italic">{entry.notes}</div>}
            </div>
        </div>
    );
});

// ── MenuBtn — overflow menu item ──

export const MenuBtn: React.FC<{
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
        className={`w-full px-4 py-3 text-left text-sm font-medium flex items-center gap-3 transition-colors ${
            disabled
                ? 'text-slate-500 cursor-not-allowed'
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

// ── FollowRouteButton — appears on planned route voyage cards ──

const FollowRouteButton: React.FC<{
    voyage: { voyageId: string; entries: ShipLogEntry[] };
    startLabel: string | null;
    endLabel: string | null;
}> = ({ voyage, startLabel, endLabel }) => {
    const { isFollowing, voyageId: followingVoyageId, startFollowing } = useFollowRoute();
    const isThisFollowed = isFollowing && followingVoyageId === voyage.voyageId;

    const handleFollow = useCallback(() => {
        if (isThisFollowed) return;

        const sorted = [...voyage.entries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];

        if (!first || !last) return;

        // Reconstruct VoyagePlan from log entries
        const waypoints = sorted.slice(1, -1).map((e) => ({
            coordinates: { lat: e.latitude, lon: e.longitude },
            name: e.waypointName || `WP`,
            windSpeed: e.windSpeed || undefined,
            windDirection: undefined,
            waveHeight: undefined,
            depth: undefined,
            bearing: e.courseDeg || undefined,
        }));

        const plan: VoyagePlan = {
            origin: startLabel || first.waypointName || `${first.latitude.toFixed(2)}, ${first.longitude.toFixed(2)}`,
            destination: endLabel || last.waypointName || `${last.latitude.toFixed(2)}, ${last.longitude.toFixed(2)}`,
            departureDate: first.timestamp,
            originCoordinates: { lat: first.latitude, lon: first.longitude },
            destinationCoordinates: { lat: last.latitude, lon: last.longitude },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            waypoints: waypoints as any,
            distanceApprox: `${Math.max(0, ...voyage.entries.map((e) => e.cumulativeDistanceNM || 0)).toFixed(1)} NM`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            durationApprox: '' as any,
            overview: `Planned route from ${startLabel || 'origin'} to ${endLabel || 'destination'}`,
        };

        startFollowing(plan, voyage.voyageId);
    }, [voyage, startLabel, endLabel, isThisFollowed, startFollowing]);

    return (
        <button
            onClick={handleFollow}
            disabled={isThisFollowed}
            className={`w-14 flex flex-col items-center justify-center py-2 border-t border-white/5 transition-colors ${
                isThisFollowed
                    ? 'text-emerald-400 bg-emerald-500/10'
                    : 'text-sky-400 hover:text-sky-300 hover:bg-white/5'
            }`}
            title={isThisFollowed ? 'Currently following this route' : 'Follow this route'}
        >
            {isThisFollowed ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                </svg>
            ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
                    />
                </svg>
            )}
            <span className="text-[8px] uppercase font-bold tracking-wider mt-0.5">
                {isThisFollowed ? 'Active' : 'Follow'}
            </span>
        </button>
    );
};

// ── VoyageCard — compact past voyage summary ──

export const VoyageCard: React.FC<{
    voyage: { voyageId: string; entries: ShipLogEntry[] };
    isSelected: boolean;
    isExpanded: boolean;
    onToggle: () => void;
    onSelect: () => void;
    onDelete: () => void;
    onArchive: () => void;
    onShowMap: () => void;
    filteredEntries: ShipLogEntry[];
    onDeleteEntry: (id: string) => void;
    onEditEntry: (entry: ShipLogEntry) => void;
}> = React.memo(
    ({
        voyage,
        isSelected,
        isExpanded,
        onToggle,
        onSelect,
        onDelete,
        onArchive,
        onShowMap,
        filteredEntries,
        onDeleteEntry,
        onEditEntry,
    }) => {
        // --- Swipe-to-reveal actions ---
        const [swipeOffset, setSwipeOffset] = useState(0);
        const touchStartX = useRef(0);
        const deleteThreshold = 160; // wide enough for both Archive + Delete buttons
        const handleSwipeStart = (e: React.TouchEvent) => {
            touchStartX.current = e.touches[0].clientX;
        };
        const handleSwipeMove = (e: React.TouchEvent) => {
            const diff = touchStartX.current - e.touches[0].clientX;
            setSwipeOffset(Math.max(0, Math.min(diff, deleteThreshold + 20)));
        };
        const handleSwipeEnd = () => {
            setSwipeOffset((s) => (s >= deleteThreshold ? deleteThreshold : 0));
        };

        const sorted = [...voyage.entries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const dist = Math.max(0, ...voyage.entries.map((e) => e.cumulativeDistanceNM || 0));
        const durationMs = first && last ? new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime() : 0;
        const durationHrs = Math.floor(durationMs / 3600000);
        const durationMins = Math.floor((durationMs % 3600000) / 60000);
        const durationLabel =
            durationHrs >= 24 ? `${Math.ceil(durationHrs / 24)}d` : `${durationHrs}h ${durationMins}m`;
        const dateLabel = first
            ? new Date(first.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
            : '';
        const hasManual = voyage.entries.some((e) => e.entryType === 'manual');
        const speedEntries = voyage.entries.filter((e) => e.speedKts);
        const avgSpeed =
            speedEntries.length > 0
                ? speedEntries.reduce((sum, e) => sum + (e.speedKts || 0), 0) / speedEntries.length
                : 0;

        // Detect imported/community tracks (not official device data)
        const isImported = voyage.entries.some(
            (e) => e.source && e.source !== 'device' && e.source !== 'planned_route',
        );
        const isPlannedRoute = voyage.entries.some((e) => e.source === 'planned_route');

        // Reverse-geocode start and end locations for card title
        const [startLocName, setStartLocName] = useState<string | null>(null);
        const [endLocName, setEndLocName] = useState<string | null>(null);

        useEffect(() => {
            const geocode = async (lat: number, lon: number): Promise<string | null> => {
                // 1. Try the app's own reverseGeocode (Mapbox-backed, more reliable for coastal areas)
                try {
                    const { reverseGeocode: appGeocode } = await import('../../services/weatherService');
                    const name = await appGeocode(lat, lon);
                    if (name) {
                        // Extract local part — take last meaningful segment
                        // e.g. "Newport, Redcliffe, QLD" → "Newport"
                        const parts = name
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean);
                        if (parts.length > 0) return parts[0];
                    }
                } catch (e) {
                    log.warn('fall through to Nominatim:', e);
                }

                // 2. Fallback: Nominatim with progressive zoom levels (coastal/offshore positions)
                const zoomLevels = [16, 14, 10, 8, 5];
                for (const zoom of zoomLevels) {
                    try {
                        const res = await fetch(
                            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=${zoom}&addressdetails=1`,
                        );
                        if (!res.ok) continue;
                        const data = await res.json();
                        const addr = data.address || {};
                        const local =
                            addr.neighbourhood ||
                            addr.suburb ||
                            addr.village ||
                            addr.town ||
                            addr.city_district ||
                            addr.city ||
                            addr.hamlet ||
                            addr.county ||
                            null;
                        if (local) return local;
                    } catch (e) {
                        log.warn('geocode skip:', e);
                        continue;
                    }
                }
                return null;
            };

            if (first?.latitude && first.latitude !== 0) {
                geocode(first.latitude, first.longitude ?? 0).then((name) => {
                    if (name) setStartLocName(name);
                });
            }
            if (last?.latitude && last.latitude !== 0) {
                // Always geocode end — even if same entry, so single-entry voyages show the place name
                geocode(last.latitude, last.longitude ?? 0).then((name) => {
                    if (name) setEndLocName(name);
                });
            }
        }, [first?.latitude, first?.longitude, last?.latitude, last?.longitude]);

        // Use geocoded names, fall back to waypoint names, then DMS coords
        const formatFallback = (e: ShipLogEntry | undefined) => {
            if (!e || !e.latitude) return null;
            return `${Math.abs(e.latitude).toFixed(1)}°${e.latitude >= 0 ? 'N' : 'S'}`;
        };
        const startLabel = startLocName || formatFallback(first);
        const endLabel = endLocName || formatFallback(last);

        const voyageFilteredEntries = voyage.entries.filter((e) => filteredEntries.some((f) => f.id === e.id));

        return (
            <div className="mb-3 relative overflow-hidden rounded-2xl snap-start">
                {/* Action buttons revealed on swipe-left */}
                <div
                    className={`absolute right-0 top-0 bottom-0 flex transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                >
                    {/* Archive — hidden for planned routes */}
                    {!isPlannedRoute && (
                        <button
                            onClick={() => {
                                setSwipeOffset(0);
                                onArchive();
                            }}
                            className="w-20 bg-amber-600 flex items-center justify-center"
                        >
                            <div className="flex flex-col items-center gap-1">
                                <svg
                                    className="w-5 h-5 text-white"
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
                                <span className="text-[11px] font-bold text-white uppercase">Archive</span>
                            </div>
                        </button>
                    )}
                    {/* Delete */}
                    <button
                        onClick={() => {
                            setSwipeOffset(0);
                            onDelete();
                        }}
                        className={`w-20 bg-red-600 flex items-center justify-center ${isPlannedRoute ? 'rounded-r-2xl rounded-l-2xl' : 'rounded-r-2xl'}`}
                    >
                        <div className="flex flex-col items-center gap-1">
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                            </svg>
                            <span className="text-[11px] font-bold text-white uppercase">Delete</span>
                        </div>
                    </button>
                </div>
                <div
                    className={`w-full rounded-2xl overflow-hidden transition-all flex relative backdrop-blur-md ${
                        isSelected
                            ? 'bg-sky-900/30 border-2 border-sky-400/50 shadow-[0_0_12px_rgba(56,189,248,0.15)]'
                            : isPlannedRoute
                              ? isExpanded
                                  ? 'bg-purple-900/30 border border-purple-500/30'
                                  : 'bg-purple-950/30 border border-purple-500/15 hover:border-purple-500/25'
                              : isImported
                                ? isExpanded
                                    ? 'bg-amber-900/30 border border-amber-500/30'
                                    : 'bg-amber-950/30 border border-amber-500/15 hover:border-amber-500/25'
                                : isExpanded
                                  ? 'bg-slate-800/50 border border-sky-500/30'
                                  : 'bg-slate-900/40 border border-white/5 hover:border-white/15'
                    }`}
                    style={{
                        transform: `translateX(-${swipeOffset}px)`,
                        transition:
                            swipeOffset === 0 || swipeOffset === deleteThreshold ? 'transform 0.2s ease-out' : 'none',
                    }}
                    onTouchStart={handleSwipeStart}
                    onTouchMove={handleSwipeMove}
                    onTouchEnd={handleSwipeEnd}
                >
                    {/* LEFT — route info, expands timeline */}
                    <button
                        onClick={(e) => {
                            if (swipeOffset !== 0) {
                                setSwipeOffset(0);
                                return;
                            }
                            // Left third → select + expand; rest → select only
                            const rect = e.currentTarget.getBoundingClientRect();
                            const clickX = e.clientX - rect.left;
                            onSelect();
                            if (clickX < rect.width / 3) {
                                onToggle();
                            }
                        }}
                        className="flex-1 p-4 text-left min-w-0"
                    >
                        <div className="flex items-start justify-between mb-1">
                            <div className="text-[11px] text-slate-500 uppercase tracking-wider font-medium">
                                {dateLabel}
                            </div>
                            <div className="flex items-center gap-1.5">
                                {isSelected && (
                                    <span className="px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-400/30 text-[11px] font-bold text-sky-300 uppercase mr-1">
                                        ● Selected
                                    </span>
                                )}
                                <span className="text-base font-extrabold text-white">
                                    {(dist ?? 0).toFixed(1)}{' '}
                                    <span className="text-[11px] text-slate-400 font-normal">NM</span>
                                </span>
                                <span className="text-[11px] text-slate-500">|</span>
                                <span className="text-xs font-bold text-slate-300">{durationLabel}</span>
                            </div>
                        </div>
                        {(startLabel || endLabel) && (
                            <div className="text-sm text-slate-300 mb-1 truncate">
                                {startLabel || '—'} → {endLabel || '…'}
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] text-slate-500">{voyage.entries.length} entries</span>
                            {avgSpeed > 0 && (
                                <span className="text-[11px] text-slate-500">
                                    · {(avgSpeed ?? 0).toFixed(1)} kts avg
                                </span>
                            )}
                            {hasManual && (
                                <span className="px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/20 text-[11px] font-bold text-purple-400 uppercase">
                                    Manual
                                </span>
                            )}
                            {isPlannedRoute && (
                                <span className="px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/20 text-[11px] font-bold text-purple-400 uppercase">
                                    Suggested
                                </span>
                            )}
                            {isImported && !isPlannedRoute && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/20 text-[11px] font-bold text-amber-400 uppercase">
                                    Imported
                                </span>
                            )}
                        </div>
                        {isPlannedRoute && (
                            <div className="text-[11px] text-purple-400/60 mt-1">
                                📐 Suggested route — not from onboard GPS
                            </div>
                        )}
                        {isImported && !isPlannedRoute && (
                            <div className="text-[11px] text-amber-400/60 mt-1">
                                ⚠ Unverified track — not from onboard GPS
                            </div>
                        )}
                    </button>

                    {/* RIGHT — action buttons */}
                    <div className="shrink-0 flex flex-col border-l border-white/5">
                        <button
                            onClick={() => {
                                if (swipeOffset === 0) onShowMap();
                                else setSwipeOffset(0);
                            }}
                            className="flex-1 w-14 flex flex-col items-center justify-center hover:bg-white/5 transition-colors text-slate-400 hover:text-sky-400"
                            title="View on map"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                                />
                            </svg>
                            <span className="text-[8px] uppercase font-bold tracking-wider mt-0.5">Map</span>
                        </button>
                        {isPlannedRoute && (
                            <button
                                onClick={async () => {
                                    if (swipeOffset !== 0) {
                                        setSwipeOffset(0);
                                        return;
                                    }
                                    try {
                                        const { exportVoyageAsGPX, shareGPXFile } =
                                            await import('../../services/gpxService');
                                        const gpxXml = exportVoyageAsGPX(
                                            voyage.entries,
                                            `Planned_${startLabel || 'Route'}_to_${endLabel || 'Destination'}`,
                                        );
                                        await shareGPXFile(gpxXml, `planned_route_${voyage.voyageId}.gpx`);
                                    } catch (err) {
                                        log.error('GPX Export failed:', err);
                                    }
                                }}
                                className="w-14 flex flex-col items-center justify-center py-2 border-t border-white/5 hover:bg-white/5 transition-colors text-purple-400 hover:text-purple-300"
                                title="Export as GPX"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={1.5}
                                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                    />
                                </svg>
                                <span className="text-[8px] uppercase font-bold tracking-wider mt-0.5">GPX</span>
                            </button>
                        )}
                        {isPlannedRoute && (
                            <FollowRouteButton voyage={voyage} startLabel={startLabel} endLabel={endLabel} />
                        )}
                    </div>
                </div>

                {/* Expanded: show full timeline */}
                {isExpanded && (
                    <>
                        {/* Inline map for planned routes */}
                        {isPlannedRoute && voyage.entries.length >= 2 && (
                            <div className="px-4 pt-3">
                                <LiveMiniMap entries={voyage.entries} height={140} />
                            </div>
                        )}
                        <div
                            className={`ml-2 border-l-2 ${isPlannedRoute ? 'border-purple-500/20' : 'border-sky-500/20'} pl-3 mt-1 mb-1`}
                        >
                            <DateGroupedTimeline
                                groupedEntries={groupEntriesByDate(voyageFilteredEntries)}
                                onDeleteEntry={onDeleteEntry}
                                onEditEntry={onEditEntry}
                                voyageFirstEntryId={voyage.entries[voyage.entries.length - 1]?.id}
                                voyageLastEntryId={voyage.entries[0]?.id}
                            />
                        </div>
                    </>
                )}
            </div>
        );
    },
);
