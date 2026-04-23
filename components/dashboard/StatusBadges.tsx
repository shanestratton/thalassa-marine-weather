import React, { useState, useMemo, useEffect } from 'react';
import { Countdown } from './Countdown';
import { useEnvironment } from '../../context/ThemeContext';
import { MetricSource } from '../../types';
import { useWeather } from '../../context/WeatherContext';
import { piCache, type PiFetchStats } from '../../services/PiCacheService';

interface StatusBadgesProps {
    isLandlocked: boolean;
    locationName: string;
    displaySource: string;
    nextUpdate: number | null;
    fallbackInland?: boolean;
    stationId?: string;
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    beaconName?: string;
    buoyName?: string;
    /** When offshore, show the user's selected model in the badge */
    offshoreModelLabel?: string;
    /** Pulsing indicator when offshore */
    isOffshore?: boolean;
    // Dynamic source data
    sources?: Record<string, MetricSource>;
    // Data source modal props
    activeData?: {
        windSpeed?: number | null;
        windGust?: number | null;
        windDirection?: string | number | null;
        waveHeight?: number | null;
        wavePeriod?: number | null;
        swellHeight?: number | null;
        swellPeriod?: number | null;
        waterTemperature?: number | null;
        airTemperature?: number | null;
        pressure?: number | null;
        visibility?: number | null;
        humidity?: number | null;
        cloudCover?: number | null;
        temperature?: number | null;
    };
    isLive?: boolean;
    modelUsed?: string;
    generatedAt?: string;
    coordinates?: { lat: number; lon: number };
}

/** Format cache age as human-readable relative time */
function formatCacheAge(timestamp: number): string {
    const ageMs = Date.now() - timestamp;
    if (ageMs < 60_000) return 'just now';
    if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
    if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
    return `${Math.round(ageMs / 86_400_000)}d ago`;
}

// Source display config — abbreviation, color, label
const SOURCE_CONFIG: Record<string, { abbr: string; color: string; label: string }> = {
    buoy: { abbr: '', color: 'text-emerald-400', label: 'BUOY' }, // Name used instead of abbr
    beacon: { abbr: '', color: 'text-emerald-400', label: 'BEACON' }, // Name used instead of abbr
    stormglass: { abbr: 'SG', color: 'text-amber-400', label: 'StormGlass API' },
    openmeteo: { abbr: 'OM', color: 'text-sky-400', label: 'Open-Meteo' },
    weatherkit: { abbr: 'WK', color: 'text-emerald-400', label: 'Apple Weather' },
};

// NOTE: the Data Sources modal was removed on 2026-04-23 — the per-metric
// provenance shown there was frequently wrong (sources attribution isn't
// reliably propagated by the API pipeline). Kept SOURCE_CONFIG /
// SOURCE_DOT_COLORS above because they're still referenced by the pill
// styling even with the modal gone.
const SOURCE_DOT_COLORS: Record<string, string> = {
    buoy: 'bg-emerald-400',
    beacon: 'bg-emerald-400',
    stormglass: 'bg-amber-400',
    openmeteo: 'bg-sky-400',
    weatherkit: 'bg-emerald-400',
};

export const StatusBadges: React.FC<StatusBadgesProps> = React.memo(
    ({
        isLandlocked,
        // Modal-only props below — kept in the interface so Dashboard's call
        // site doesn't need to change, but unused since the Data Sources
        // modal was removed (attribution was frequently wrong).
        locationName: _locationName,
        displaySource: _displaySource,
        nextUpdate,
        fallbackInland,
        stationId: _stationId,
        locationType,
        beaconName: _beaconName,
        buoyName: _buoyName,
        sources: _sources,
        activeData: _activeData,
        isLive: _isLive = true,
        modelUsed: _modelUsed,
        generatedAt,
        coordinates: _coordinates,
        offshoreModelLabel,
        isOffshore: isOffshoreProp,
    }) => {
        const env = useEnvironment();
        const { refreshData, loading, backgroundUpdating } = useWeather();
        const isSyncing = loading || backgroundUpdating;
        const badgeTextSize = env === 'onshore' ? 'text-[11px]' : 'text-xs';

        // Pi Cache fetch stats — poll on mount and after syncs. Not shown to
        // the user anymore (modal is gone), but cheap to compute and still
        // useful for any future per-badge annotation.
        const [piFetchStats, setPiFetchStats] = useState<PiFetchStats | null>(null);
        useEffect(() => {
            if (!piCache.isAvailable()) {
                setPiFetchStats(null);
                return;
            }
            setPiFetchStats(piCache.getFetchStats());
            // Re-check after each sync completes
        }, [isSyncing]);
        void piFetchStats; // Reserved — keeps the polling hook alive.

        // BADGES Logic — each variant carries a label, tailwind color
        // classes (bg + text + border), an SVG glyph, and the breathing
        // glow class name that matches its colour.
        const offshore = isOffshoreProp ?? locationType === 'offshore';
        let statusBadgeLabel: string;
        let statusBadgeColor: string;
        let statusBadgeGlow: string;
        let statusBadgeIcon: React.ReactNode;
        let statusBadgePulse = false;

        // Shared tiny-icon style — matches the 12px label height
        const iconCls = 'w-3 h-3 shrink-0 opacity-90';

        if (offshore) {
            statusBadgeLabel = offshoreModelLabel ? `OFFSHORE (${offshoreModelLabel})` : 'OFFSHORE';
            // Gradient gives the pill depth vs a flat wash
            statusBadgeColor =
                'bg-gradient-to-r from-sky-500/25 via-sky-500/20 to-sky-500/25 text-sky-200 border-sky-400/40';
            statusBadgeGlow = 'status-badge-glow-sky';
            // Compass rose — offshore = open water navigation
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="9" strokeLinecap="round" />
                    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeLinecap="round" />
                    <path d="M15 9l-3 6-3-6 6 0z" fill="currentColor" stroke="none" opacity="0.9" />
                </svg>
            );
            statusBadgePulse = true;
        } else if (locationType === 'inland' || isLandlocked || fallbackInland) {
            statusBadgeLabel = 'INLAND';
            statusBadgeColor =
                'bg-gradient-to-r from-amber-500/25 via-amber-500/20 to-amber-500/25 text-amber-200 border-amber-400/40';
            statusBadgeGlow = 'status-badge-glow-amber';
            // Little mountain silhouette
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M3 19l6-10 4 6 3-4 5 8H3z" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
            );
        } else if (locationType === 'inshore') {
            statusBadgeLabel = 'INSHORE';
            statusBadgeColor =
                'bg-gradient-to-r from-teal-500/25 via-teal-500/20 to-teal-500/25 text-teal-200 border-teal-400/40';
            statusBadgeGlow = 'status-badge-glow-teal';
            // Anchor — tight-to-shore waters
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="5" r="2" strokeLinecap="round" />
                    <path d="M12 7v13" strokeLinecap="round" />
                    <path d="M8 11h8" strokeLinecap="round" />
                    <path d="M5 15a7 7 0 0014 0" strokeLinecap="round" />
                </svg>
            );
        } else {
            statusBadgeLabel = 'COASTAL';
            statusBadgeColor =
                'bg-gradient-to-r from-emerald-500/25 via-emerald-500/20 to-emerald-500/25 text-emerald-200 border-emerald-400/40';
            statusBadgeGlow = 'status-badge-glow-emerald';
            // Stylized wave
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path
                        d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            );
        }

        // Timer badge goes amber/red when the underlying data is past its
        // refresh window so a tappable "retry" is visually obvious.
        const dataAgeMin = useMemo(() => {
            if (!generatedAt) return 0;
            const ts = new Date(generatedAt).getTime();
            if (Number.isNaN(ts)) return 0;
            return Math.max(0, (Date.now() - ts) / 60_000);
        }, [generatedAt]);
        const isOffshoreForTimer = offshore;
        const veryOldThresh = isOffshoreForTimer ? 240 : 120;
        const oldThresh = isOffshoreForTimer ? 120 : 60;
        let timerBadgeColor: string;
        let staleLabel: string | null = null;
        if (dataAgeMin >= veryOldThresh) {
            timerBadgeColor = 'bg-red-500/20 text-red-300 border-red-500/30';
            staleLabel = `${Math.round(dataAgeMin / 60)}H OLD`;
        } else if (dataAgeMin >= oldThresh) {
            timerBadgeColor = 'bg-amber-500/20 text-amber-300 border-amber-500/30';
            staleLabel = `${Math.round(dataAgeMin)}M OLD`;
        } else {
            timerBadgeColor = 'bg-sky-500/20 text-sky-300 border-sky-500/30';
        }

        return (
            <>
                <div className="px-0 shrink-0 relative z-20">
                    <div className="flex items-center justify-between gap-2 w-full mb-0">
                        {/* Location-type Badge — informational only (no longer
                            tappable; the Data Sources modal was removed because
                            per-metric attribution wasn't reliable). Keeps the
                            breathing glow and type-specific glyph so the pill
                            still reads at a glance. */}
                        <div
                            role="status"
                            aria-label={`Location type: ${statusBadgeLabel}`}
                            className={`px-2.5 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider ${statusBadgeColor} ${statusBadgeGlow} min-w-[82px] text-center flex items-center justify-center gap-1.5`}
                        >
                            {statusBadgeIcon}
                            {statusBadgePulse && (
                                <span className="relative flex w-1.5 h-1.5 shrink-0">
                                    <span className="animate-ping absolute inset-0 rounded-full bg-sky-400 opacity-60" />
                                    <span className="relative w-1.5 h-1.5 rounded-full bg-sky-400" />
                                </span>
                            )}
                            {statusBadgeLabel}
                        </div>

                        {/* Timer Badge — tappable to force refresh, shows live
                            sync state. Syncing now uses a sweeping highlight
                            (status-badge-sweep) instead of the old
                            animate-pulse fade — reads as an active 'loading
                            bar' rather than a tired blinker. */}
                        <button
                            onClick={() => refreshData()}
                            aria-label="Refresh weather data"
                            className={`px-2.5 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider flex items-center gap-1.5 justify-center cursor-pointer active:scale-[0.95] transition-transform min-w-[82px] ${
                                isSyncing
                                    ? 'bg-sky-500/25 text-sky-100 border-sky-400/50 status-badge-sweep shadow-[0_0_12px_-2px_rgba(56,189,248,0.5)]'
                                    : `${timerBadgeColor} ${staleLabel ? '' : 'status-badge-glow-sky'}`
                            }`}
                        >
                            {isSyncing ? (
                                <>
                                    {/* Triple-dot pulse — more energetic than a spinner */}
                                    <span className="flex items-center gap-0.5 shrink-0">
                                        <span
                                            className="w-1 h-1 rounded-full bg-sky-200"
                                            style={{ animation: 'hh-pulse 1.2s ease-in-out 0s infinite' }}
                                        />
                                        <span
                                            className="w-1 h-1 rounded-full bg-sky-200"
                                            style={{ animation: 'hh-pulse 1.2s ease-in-out 0.2s infinite' }}
                                        />
                                        <span
                                            className="w-1 h-1 rounded-full bg-sky-200"
                                            style={{ animation: 'hh-pulse 1.2s ease-in-out 0.4s infinite' }}
                                        />
                                    </span>
                                    <span>Syncing</span>
                                </>
                            ) : (
                                <>
                                    <svg
                                        className="w-3 h-3 opacity-60 shrink-0"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
                                        />
                                    </svg>
                                    {staleLabel ? (
                                        staleLabel
                                    ) : nextUpdate ? (
                                        <Countdown targetTime={nextUpdate} />
                                    ) : (
                                        'LIVE'
                                    )}
                                </>
                            )}
                        </button>
                    </div>
                </div>

                {/* ── Removed 2026-04-23: Data Sources modal ───────────────
                    The portal-rendered modal that opened on tap of the
                    location-type pill was deleted because the per-metric
                    provenance it displayed was frequently incorrect — the
                    API pipeline didn't reliably propagate source attribution
                    for every metric, so users saw mismatched sources
                    (e.g. "Wind Speed: Apple Weather" when the actual value
                    came from Open-Meteo). Better to show nothing than to
                    mislead. The pill remains as a visual status indicator
                    only (no longer tappable).
                    Related props (sources, activeData, modelUsed, coordinates,
                    isLive) are still in StatusBadgesProps so Dashboard's call
                    site doesn't need to change — they're underscore-prefixed
                    in the destructure to signal intentional non-use. */}
            </>
        );
    },
);
