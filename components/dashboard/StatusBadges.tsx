import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { RadioTowerIcon } from '../Icons';
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

const SOURCE_DOT_COLORS: Record<string, string> = {
    buoy: 'bg-emerald-400',
    beacon: 'bg-emerald-400',
    stormglass: 'bg-amber-400',
    openmeteo: 'bg-sky-400',
    weatherkit: 'bg-emerald-400',
};

// Metric display names for the provenance table
const METRIC_LABELS: Record<string, string> = {
    windSpeed: 'Wind Speed',
    windGust: 'Wind Gust',
    windDirection: 'Wind Dir',
    windDegree: 'Wind Deg',
    waveHeight: 'Wave Height',
    swellPeriod: 'Swell Period',
    swellHeight: 'Swell Height',
    temperature: 'Air Temp',
    waterTemperature: 'Sea Temp',
    pressure: 'Pressure',
    visibility: 'Visibility',
    humidity: 'Humidity',
    cloudCover: 'Cloud Cover',
    uvIndex: 'UV Index',
    precipitation: 'Rain %',
    dewPoint: 'Dew Point',
    feelsLike: 'Feels Like',
    condition: 'Conditions',
    sunrise: 'Sunrise',
    sunset: 'Sunset',
};

export const StatusBadges: React.FC<StatusBadgesProps> = React.memo(
    ({
        isLandlocked,
        locationName: _locationName,
        displaySource: _displaySource,
        nextUpdate,
        fallbackInland,
        stationId: _stationId,
        locationType,
        beaconName: _beaconName,
        buoyName: _buoyName,
        sources,
        activeData,
        isLive = true,
        modelUsed,
        generatedAt,
        coordinates,
        offshoreModelLabel,
        isOffshore: isOffshoreProp,
    }) => {
        const [showInfoModal, setShowInfoModal] = useState(false);
        const env = useEnvironment();
        const { refreshData, loading, backgroundUpdating } = useWeather();
        const isSyncing = loading || backgroundUpdating;
        const badgeTextSize = env === 'onshore' ? 'text-[11px]' : 'text-xs';

        // Pi Cache fetch stats — poll on mount and after syncs
        const [piFetchStats, setPiFetchStats] = useState<PiFetchStats | null>(null);
        useEffect(() => {
            if (!piCache.isAvailable()) {
                setPiFetchStats(null);
                return;
            }
            setPiFetchStats(piCache.getFetchStats());
            // Re-check after each sync completes
        }, [isSyncing]);
        const piIsServing = piFetchStats?.lastSource === 'pi-cache' || piFetchStats?.lastSource === 'pi-stale';

        // Derive unique active sources from the sources map
        const activeSources = useMemo(() => {
            const sourceSet = new Map<string, { source: string; sourceName: string; metrics: string[] }>();

            if (sources && Object.keys(sources).length > 0) {
                Object.entries(sources).forEach(([metricKey, ms]) => {
                    if (!ms?.source) return;
                    const key = ms.source;
                    if (!sourceSet.has(key)) {
                        sourceSet.set(key, { source: key, sourceName: ms.sourceName || key, metrics: [] });
                    }
                    sourceSet.get(key)!.metrics.push(metricKey);
                });
                // Always show Open-Meteo as base layer when we have per-metric sources
                if (!sourceSet.has('openmeteo')) {
                    sourceSet.set('openmeteo', { source: 'openmeteo', sourceName: 'Open-Meteo', metrics: [] });
                }
            } else if (modelUsed) {
                // Forecast/hourly data has no per-metric sources — derive from modelUsed tag
                // e.g. 'wk+sg+om' → WeatherKit, StormGlass, Open-Meteo
                const MODEL_MAP: Record<string, { source: string; sourceName: string }> = {
                    wk: { source: 'weatherkit', sourceName: 'Apple Weather' },
                    sg: { source: 'stormglass', sourceName: 'StormGlass' },
                    om: { source: 'openmeteo', sourceName: 'Open-Meteo' },
                };
                modelUsed.split('+').forEach((code) => {
                    const mapped = MODEL_MAP[code.trim()];
                    if (mapped && !sourceSet.has(mapped.source)) {
                        sourceSet.set(mapped.source, { ...mapped, metrics: [] });
                    }
                });
            } else {
                // Ultimate fallback
                sourceSet.set('openmeteo', { source: 'openmeteo', sourceName: 'Open-Meteo', metrics: [] });
            }

            return Array.from(sourceSet.values());
        }, [sources, modelUsed]);

        // Per-metric provenance list for the modal
        const metricProvenance = useMemo(() => {
            if (!sources) return [];
            return Object.entries(sources)
                .filter(([_, ms]) => ms?.source)
                .map(([metricKey, ms]) => ({
                    metric: METRIC_LABELS[metricKey] || metricKey,
                    source: ms.source,
                    sourceName: ms.sourceName,
                    sourceColor: SOURCE_DOT_COLORS[ms.source] || 'bg-white',
                }))
                .sort((a, b) => a.metric.localeCompare(b.metric));
        }, [sources]);

        // BADGES Logic
        const offshore = isOffshoreProp ?? locationType === 'offshore';
        let statusBadgeLabel: string;
        let statusBadgeColor: string;
        let statusBadgePulse = false;

        if (offshore) {
            statusBadgeLabel = offshoreModelLabel ? `OFFSHORE (${offshoreModelLabel})` : 'OFFSHORE';
            statusBadgeColor = 'bg-sky-500/20 text-sky-300 border-sky-500/30';
            statusBadgePulse = true;
        } else if (locationType === 'inland' || isLandlocked || fallbackInland) {
            statusBadgeLabel = 'INLAND';
            statusBadgeColor = 'bg-amber-500/20 text-amber-300 border-amber-500/30';
        } else if (locationType === 'inshore') {
            statusBadgeLabel = 'INSHORE';
            statusBadgeColor = 'bg-teal-500/20 text-teal-300 border-teal-500/30';
        } else {
            statusBadgeLabel = 'COASTAL';
            statusBadgeColor = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
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

        // Format helpers for the info modal
        const fmt = (v: number | null | undefined, unit: string, decimals = 1) => {
            if (v == null) return '—';
            return `${v.toFixed(decimals)} ${unit}`;
        };
        const fmtDir = (deg: number | null | undefined) => {
            if (deg == null) return '';
            const dirs = [
                'N',
                'NNE',
                'NE',
                'ENE',
                'E',
                'ESE',
                'SE',
                'SSE',
                'S',
                'SSW',
                'SW',
                'WSW',
                'W',
                'WNW',
                'NW',
                'NNW',
            ];
            return dirs[Math.round(deg / 22.5) % 16];
        };

        return (
            <>
                <div className="px-0 shrink-0 relative z-20">
                    <div className="flex items-center justify-between gap-2 w-full mb-0">
                        {/* Coastal / Offshore Badge — tap to see data sources */}
                        <button
                            onClick={() => setShowInfoModal(true)}
                            aria-label="View data sources"
                            className={`px-2 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider ${statusBadgeColor} bg-black/40 min-w-[78px] text-center transition-all duration-500 flex items-center justify-center gap-1.5 cursor-pointer active:scale-[0.95]`}
                        >
                            {statusBadgePulse && (
                                <span className="relative flex w-1.5 h-1.5 shrink-0">
                                    <span className="animate-ping absolute inset-0 rounded-full bg-sky-400 opacity-60" />
                                    <span className="relative w-1.5 h-1.5 rounded-full bg-sky-400" />
                                </span>
                            )}
                            {statusBadgeLabel}
                        </button>

                        {/* Timer Badge — tappable to force refresh, shows live sync state */}
                        <button
                            onClick={() => refreshData()}
                            aria-label="Refresh weather data"
                            className={`px-2 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider bg-black/40 flex items-center gap-1 justify-center cursor-pointer active:scale-[0.95] transition-all min-w-[78px] ${
                                isSyncing
                                    ? 'bg-sky-500/30 text-sky-200 border-sky-400/40 animate-pulse'
                                    : timerBadgeColor
                            }`}
                        >
                            {isSyncing ? (
                                <>
                                    <svg className="w-3 h-3 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                                        <circle
                                            className="opacity-25"
                                            cx="12"
                                            cy="12"
                                            r="10"
                                            stroke="currentColor"
                                            strokeWidth="3"
                                        />
                                        <path
                                            className="opacity-75"
                                            fill="currentColor"
                                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                        />
                                    </svg>
                                    <span>Syncing</span>
                                </>
                            ) : (
                                <>
                                    <svg
                                        className="w-3 h-3 opacity-50 shrink-0"
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

                {/* Data Source Info Modal — portalled to document root to escape z-index stacking */}
                {showInfoModal &&
                    createPortal(
                        <div
                            className="fixed inset-0 z-[9999] flex items-start justify-center modal-backdrop-enter bg-black/60"
                            onClick={() => setShowInfoModal(false)}
                            role="dialog"
                            aria-modal="true"
                            aria-label="Data sources details"
                            style={{
                                paddingBottom: 'calc(env(safe-area-inset-bottom) + 80px)',
                                paddingTop: 'calc(env(safe-area-inset-top) + 60px)',
                            }}
                        >
                            <div
                                className="modal-panel-enter w-full max-w-md bg-slate-900/95 border border-white/15 rounded-2xl shadow-2xl max-h-[85dvh] overflow-y-auto mx-4"
                                onClick={(e) => e.stopPropagation()}
                            >
                                {/* Header */}
                                <div className="flex items-center justify-between px-5 pt-5 pb-3 sticky top-0 bg-slate-900/95 z-10">
                                    <div className="flex items-center gap-2">
                                        <RadioTowerIcon className="w-5 h-5 text-emerald-400" />
                                        <h2 className="text-base font-bold text-white tracking-tight">Data Sources</h2>
                                        {!isLive && (
                                            <span className="text-[11px] font-bold text-amber-400 bg-amber-500/20 px-1.5 py-0.5 rounded-lg uppercase">
                                                Forecast
                                            </span>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => setShowInfoModal(false)}
                                        aria-label="Close data sources"
                                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M6 18L18 6M6 6l12 12"
                                            />
                                        </svg>
                                    </button>
                                </div>

                                {/* Content */}
                                <div className="px-5 pb-5 space-y-4">
                                    {/* Active Sources — dynamically derived */}
                                    <div className="space-y-2">
                                        {activeSources.map((s) => {
                                            const cfg = SOURCE_CONFIG[s.source] || {
                                                abbr: s.source,
                                                color: 'text-white',
                                                label: s.source,
                                            };
                                            const dotColor = SOURCE_DOT_COLORS[s.source] || 'bg-white';
                                            const displayName =
                                                s.source === 'buoy' || s.source === 'beacon' ? s.sourceName : cfg.label;
                                            const metricCount = s.metrics.length;

                                            return (
                                                <div key={s.source} className="flex items-center gap-2">
                                                    <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />
                                                    <span className={`${cfg.color} font-bold text-sm`}>
                                                        {displayName}
                                                    </span>
                                                    {metricCount > 0 && (
                                                        <span className="text-slate-400 text-[11px] font-medium ml-1">
                                                            {metricCount} metric{metricCount > 1 ? 's' : ''}
                                                        </span>
                                                    )}
                                                    <span className="text-slate-400 text-sm ml-auto uppercase text-[11px] font-bold tracking-wider">
                                                        {cfg.label === displayName ? '' : cfg.label}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {/* Divider */}
                                    <div className="border-t border-white/5" />

                                    {/* Per-Metric Provenance */}
                                    {metricProvenance.length > 0 && (
                                        <div>
                                            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">
                                                Metric Sources{' '}
                                                {!isLive && (
                                                    <span className="text-amber-400 normal-case text-[11px]">
                                                        (forecast hour)
                                                    </span>
                                                )}
                                            </p>
                                            <div className="space-y-1.5">
                                                {metricProvenance.map((mp, i) => (
                                                    <div key={i} className="flex items-center gap-2 text-sm">
                                                        <span
                                                            className={`w-1.5 h-1.5 rounded-full ${mp.sourceColor} shrink-0`}
                                                        />
                                                        <span className="text-slate-400 flex-1">{mp.metric}</span>
                                                        <span className="text-white/70 font-medium text-[11px]">
                                                            {mp.sourceName}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Divider */}
                                    <div className="border-t border-white/5" />

                                    {/* Conditions at a glance */}
                                    {activeData && (
                                        <div>
                                            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">
                                                {isLive ? 'Current Conditions' : 'Forecast Conditions'}
                                            </p>
                                            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Wind</span>
                                                    <span className="text-white font-bold">
                                                        {fmt(activeData.windSpeed, 'kts')}{' '}
                                                        {typeof activeData.windDirection === 'string'
                                                            ? activeData.windDirection
                                                            : fmtDir(activeData.windDirection)}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Gust</span>
                                                    <span className="text-white font-bold">
                                                        {fmt(activeData.windGust, 'kts')}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Waves</span>
                                                    <span className="text-white font-bold">
                                                        {activeData.waveHeight != null
                                                            ? `${(activeData.waveHeight / 3.28084).toFixed(1)} m`
                                                            : '—'}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Period</span>
                                                    <span className="text-white font-bold">
                                                        {fmt(activeData.wavePeriod, 's', 0)}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Air Temp</span>
                                                    <span className="text-white font-bold">
                                                        {fmt(activeData.temperature ?? activeData.airTemperature, '°')}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Water</span>
                                                    <span className="text-white font-bold">
                                                        {fmt(activeData.waterTemperature, '°')}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Pressure</span>
                                                    <span className="text-white font-bold">
                                                        {fmt(activeData.pressure, 'hPa', 0)}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Visibility</span>
                                                    <span className="text-white font-bold">
                                                        {fmt(activeData.visibility, 'nm', 0)}
                                                    </span>
                                                </div>
                                                {activeData.humidity != null && (
                                                    <div className="flex justify-between">
                                                        <span className="text-slate-400">Humidity</span>
                                                        <span className="text-white font-bold">
                                                            {fmt(activeData.humidity, '%', 0)}
                                                        </span>
                                                    </div>
                                                )}
                                                {activeData.cloudCover != null && (
                                                    <div className="flex justify-between">
                                                        <span className="text-slate-400">Cloud</span>
                                                        <span className="text-white font-bold">
                                                            {fmt(activeData.cloudCover, '%', 0)}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Divider */}
                                    <div className="border-t border-white/5" />

                                    {/* API Details */}
                                    <div>
                                        <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">
                                            API Details
                                        </p>
                                        <div className="space-y-1.5 text-sm">
                                            {modelUsed && (
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Model</span>
                                                    <span className="text-white font-bold">{modelUsed}</span>
                                                </div>
                                            )}
                                            {generatedAt && (
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Last Updated</span>
                                                    <span className="text-white font-bold">
                                                        {new Date(generatedAt).toLocaleTimeString([], {
                                                            hour: '2-digit',
                                                            minute: '2-digit',
                                                        })}
                                                    </span>
                                                </div>
                                            )}
                                            {coordinates && (
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Coordinates</span>
                                                    <span className="text-white font-bold">
                                                        {coordinates.lat.toFixed(4)}°, {coordinates.lon.toFixed(4)}°
                                                    </span>
                                                </div>
                                            )}
                                            {locationType && (
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Zone</span>
                                                    <span
                                                        className={`font-bold uppercase text-sm ${locationType === 'inshore' ? 'text-teal-400' : locationType === 'coastal' ? 'text-emerald-400' : locationType === 'offshore' ? 'text-sky-400' : 'text-amber-400'}`}
                                                    >
                                                        {locationType}
                                                    </span>
                                                </div>
                                            )}
                                            {piIsServing && piFetchStats && (
                                                <div className="flex justify-between">
                                                    <span className="text-slate-400">Data via</span>
                                                    <span className="text-emerald-400 font-bold">
                                                        Pi Cache
                                                        {piFetchStats.lastSource === 'pi-stale' && (
                                                            <span className="text-amber-400 font-normal ml-1">
                                                                (stale)
                                                            </span>
                                                        )}
                                                        {piFetchStats.lastPiServedAt > 0 && (
                                                            <span className="text-slate-500 font-normal ml-1">
                                                                {formatCacheAge(piFetchStats.lastPiServedAt)}
                                                            </span>
                                                        )}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>,
                        document.body,
                    )}
            </>
        );
    },
);
