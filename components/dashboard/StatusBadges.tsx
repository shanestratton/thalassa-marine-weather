
import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../theme';
import { RadioTowerIcon } from '../Icons';
import { Countdown } from './Countdown';
import { useEnvironment } from '../../context/ThemeContext';
import { MetricSource } from '../../types';
import { useWeather } from '../../context/WeatherContext';

interface StatusBadgesProps {
    isLandlocked: boolean;
    locationName: string;
    displaySource: string;
    nextUpdate: number | null;
    fallbackInland?: boolean;
    stationId?: string;
    locationType?: 'coastal' | 'offshore' | 'inland';
    beaconName?: string;
    buoyName?: string;
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

// Source display config — abbreviation, color, label
const SOURCE_CONFIG: Record<string, { abbr: string; color: string; label: string }> = {
    buoy: { abbr: '', color: 'text-emerald-400', label: 'BUOY' },       // Name used instead of abbr
    beacon: { abbr: '', color: 'text-emerald-400', label: 'BEACON' },   // Name used instead of abbr
    stormglass: { abbr: 'SG', color: 'text-amber-400', label: 'StormGlass API' },
    openmeteo: { abbr: 'OM', color: 'text-blue-400', label: 'Open-Meteo' },
    tomorrow: { abbr: 'T.io', color: 'text-sky-400', label: 'Tomorrow.io' },
};

const SOURCE_DOT_COLORS: Record<string, string> = {
    buoy: 'bg-emerald-400',
    beacon: 'bg-emerald-400',
    stormglass: 'bg-amber-400',
    openmeteo: 'bg-blue-400',
    tomorrow: 'bg-sky-400',
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

export const StatusBadges: React.FC<StatusBadgesProps> = ({
    isLandlocked,
    locationName,
    displaySource,
    nextUpdate,
    fallbackInland,
    stationId,
    locationType,
    beaconName,
    buoyName,
    sources,
    activeData,
    isLive = true,
    modelUsed,
    generatedAt,
    coordinates
}) => {
    const [showInfoModal, setShowInfoModal] = useState(false);
    const env = useEnvironment();
    const { refreshData } = useWeather();
    const badgeTextSize = env === 'onshore' ? 'text-[10px]' : 'text-xs';

    const shortenSourceName = (name: string): string => {
        name = name.replace(/Brisbane/i, 'Bris');
        name = name.replace(/Moreton Bay/i, 'MB');
        name = name.replace(/Central/i, 'Ctr');
        name = name.replace(/Inner/i, 'In');
        name = name.replace(/Outer/i, 'Out');
        name = name.replace(/Beacon/i, 'Bcn');
        name = name.replace(/Point/i, 'Pt');
        name = name.replace(/ Bay/i, 'B');
        name = name.replace(/North/i, 'N');
        name = name.replace(/South/i, 'S');
        name = name.replace(/East/i, 'E');
        name = name.replace(/West/i, 'W');
        name = name.replace(/BUOY/i, 'BY');
        if (name.length > 12) {
            name = name.substring(0, 10) + '..';
        }
        return name;
    };

    // Derive unique active sources from the sources map
    const activeSources = useMemo(() => {
        const sourceSet = new Map<string, { source: string; sourceName: string; metrics: string[] }>();

        if (sources) {
            Object.entries(sources).forEach(([metricKey, ms]) => {
                if (!ms?.source) return;
                const key = ms.source;
                if (!sourceSet.has(key)) {
                    sourceSet.set(key, { source: key, sourceName: ms.sourceName || key, metrics: [] });
                }
                sourceSet.get(key)!.metrics.push(metricKey);
            });
        }

        // Always show Open-Meteo as base layer (provides hourly forecasts)
        if (!sourceSet.has('openmeteo')) {
            sourceSet.set('openmeteo', { source: 'openmeteo', sourceName: 'Open-Meteo', metrics: [] });
        }

        return Array.from(sourceSet.values());
    }, [sources]);

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
    let statusBadgeLabel = "OFFSHORE";
    let statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30";

    if (locationType === 'offshore') {
        statusBadgeLabel = "OFFSHORE";
        statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30";
    } else if (locationType === 'inland' || isLandlocked || fallbackInland) {
        statusBadgeLabel = "INLAND";
        statusBadgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30";
    } else {
        statusBadgeLabel = "COASTAL";
        statusBadgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    }

    const timerBadgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/30";

    // Format helpers for the info modal
    const fmt = (v: number | null | undefined, unit: string, decimals = 1) => {
        if (v == null) return '—';
        return `${v.toFixed(decimals)} ${unit}`;
    };
    const fmtDir = (deg: number | null | undefined) => {
        if (deg == null) return '';
        const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        return dirs[Math.round(deg / 22.5) % 16];
    };

    return (
        <>
            <div className="px-0 shrink-0 relative z-20">
                <div className="flex items-center justify-between gap-2 w-full mb-0">
                    {/* Coastal / Offshore Badge */}
                    <div className={`px-2 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider ${statusBadgeColor} bg-black/40 min-w-[78px] text-center`}>
                        {statusBadgeLabel}
                    </div>

                    {/* AI Blend Telemetry — read-only HUD status (tap for details) */}
                    <div
                        onClick={() => setShowInfoModal(true)}
                        role="status"
                        aria-label="AI data blend status"
                        className="flex-1 min-w-0 flex items-center justify-center gap-1.5 overflow-hidden cursor-pointer px-1"
                    >
                        {/* Pulsing live dot */}
                        <span className="relative shrink-0 flex items-center justify-center w-2 h-2">
                            <span className="absolute inset-0 rounded-full bg-teal-400/40 animate-ping" />
                            <span className="relative w-1.5 h-1.5 rounded-full bg-teal-400 shadow-[0_0_4px_rgba(94,234,212,0.6)]" />
                        </span>
                        {/* Telemetry string */}
                        <span className="text-[9px] font-mono tracking-wider text-slate-500 uppercase truncate">
                            <span className="text-teal-400/70 font-bold mr-1">AI BLEND:</span>
                            {beaconName && (
                                <><span className="text-slate-400">{shortenSourceName(beaconName)}</span><span className="text-slate-600 mx-0.5">•</span></>
                            )}
                            {buoyName && (
                                <><span className="text-slate-400">{shortenSourceName(buoyName)}</span><span className="text-slate-600 mx-0.5">•</span></>
                            )}
                            {activeSources
                                .filter(s => s.source !== 'buoy' && s.source !== 'beacon')
                                .map((s, i, arr) => {
                                    const cfg = SOURCE_CONFIG[s.source];
                                    if (!cfg) return null;
                                    return (
                                        <span key={s.source}>
                                            <span className="text-slate-400">{cfg.abbr}</span>
                                            {i < arr.length - 1 && <span className="text-slate-600 mx-0.5">•</span>}
                                        </span>
                                    );
                                })}
                        </span>
                    </div>

                    {/* Timer Badge — tappable to refresh when overdue/stale */}
                    <button
                        onClick={() => refreshData()}
                        aria-label="Refresh weather data"
                        className={`px-2 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider ${timerBadgeColor} bg-black/40 flex items-center gap-1 justify-center cursor-pointer active:scale-[0.95] transition-transform min-w-[78px]`}
                    >
                        {nextUpdate ? <Countdown targetTime={nextUpdate} /> : "LIVE"}
                    </button>
                </div>
            </div>

            {/* Data Source Info Modal — portalled to document root to escape z-index stacking */}
            {showInfoModal && createPortal(
                <div
                    className="fixed inset-0 z-[9999] flex items-end justify-center modal-backdrop-enter bg-black/60 backdrop-blur-md"
                    onClick={() => setShowInfoModal(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Data sources details"
                    style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 80px)', paddingTop: 'env(safe-area-inset-top)' }}
                >
                    <div
                        className="modal-panel-enter w-full max-w-md bg-slate-900/95 backdrop-blur-xl border border-white/15 rounded-2xl shadow-2xl max-h-[60dvh] overflow-y-auto mx-4"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 pt-5 pb-3 sticky top-0 bg-slate-900/95 backdrop-blur-xl z-10">
                            <div className="flex items-center gap-2">
                                <RadioTowerIcon className="w-5 h-5 text-emerald-400" />
                                <h2 className="text-base font-bold text-white tracking-tight">Data Sources</h2>
                                {!isLive && (
                                    <span className="text-[10px] font-bold text-amber-400 bg-amber-500/20 px-1.5 py-0.5 rounded-md uppercase">Forecast</span>
                                )}
                            </div>
                            <button
                                onClick={() => setShowInfoModal(false)}
                                aria-label="Close data sources"
                                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        {/* Content */}
                        <div className="px-5 pb-5 space-y-4">
                            {/* Active Sources — dynamically derived */}
                            <div className="space-y-2">
                                {activeSources.map(s => {
                                    const cfg = SOURCE_CONFIG[s.source] || { abbr: s.source, color: 'text-white', label: s.source };
                                    const dotColor = SOURCE_DOT_COLORS[s.source] || 'bg-white';
                                    const displayName = (s.source === 'buoy' || s.source === 'beacon')
                                        ? s.sourceName
                                        : cfg.label;
                                    const metricCount = s.metrics.length;

                                    return (
                                        <div key={s.source} className="flex items-center gap-2">
                                            <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />
                                            <span className={`${cfg.color} font-bold text-sm`}>{displayName}</span>
                                            {metricCount > 0 && (
                                                <span className="text-slate-600 text-[10px] font-medium ml-1">
                                                    {metricCount} metric{metricCount > 1 ? 's' : ''}
                                                </span>
                                            )}
                                            <span className="text-slate-500 text-sm ml-auto uppercase text-[10px] font-bold tracking-wider">{cfg.label === displayName ? '' : cfg.label}</span>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Divider */}
                            <div className="border-t border-white/5" />

                            {/* Per-Metric Provenance */}
                            {metricProvenance.length > 0 && (
                                <div>
                                    <p className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-2">
                                        Metric Sources {!isLive && <span className="text-amber-400 normal-case text-[10px]">(forecast hour)</span>}
                                    </p>
                                    <div className="space-y-1.5">
                                        {metricProvenance.map((mp, i) => (
                                            <div key={i} className="flex items-center gap-2 text-sm">
                                                <span className={`w-1.5 h-1.5 rounded-full ${mp.sourceColor} shrink-0`} />
                                                <span className="text-slate-400 flex-1">{mp.metric}</span>
                                                <span className="text-white/70 font-medium text-[11px]">{mp.sourceName}</span>
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
                                    <p className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-2">
                                        {isLive ? 'Current Conditions' : 'Forecast Conditions'}
                                    </p>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Wind</span>
                                            <span className="text-white font-bold">{fmt(activeData.windSpeed, 'kts')} {typeof activeData.windDirection === 'string' ? activeData.windDirection : fmtDir(activeData.windDirection)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Gust</span>
                                            <span className="text-white font-bold">{fmt(activeData.windGust, 'kts')}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Waves</span>
                                            <span className="text-white font-bold">{activeData.waveHeight != null ? `${(activeData.waveHeight / 3.28084).toFixed(1)} m` : '—'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Period</span>
                                            <span className="text-white font-bold">{fmt(activeData.wavePeriod, 's', 0)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Air Temp</span>
                                            <span className="text-white font-bold">{fmt(activeData.temperature ?? activeData.airTemperature, '°')}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Water</span>
                                            <span className="text-white font-bold">{fmt(activeData.waterTemperature, '°')}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Pressure</span>
                                            <span className="text-white font-bold">{fmt(activeData.pressure, 'hPa', 0)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Visibility</span>
                                            <span className="text-white font-bold">{fmt(activeData.visibility, 'nm', 0)}</span>
                                        </div>
                                        {activeData.humidity != null && (
                                            <div className="flex justify-between">
                                                <span className="text-slate-400">Humidity</span>
                                                <span className="text-white font-bold">{fmt(activeData.humidity, '%', 0)}</span>
                                            </div>
                                        )}
                                        {activeData.cloudCover != null && (
                                            <div className="flex justify-between">
                                                <span className="text-slate-400">Cloud</span>
                                                <span className="text-white font-bold">{fmt(activeData.cloudCover, '%', 0)}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Divider */}
                            <div className="border-t border-white/5" />

                            {/* API Details */}
                            <div>
                                <p className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-2">API Details</p>
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
                                            <span className="text-white font-bold">{new Date(generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        </div>
                                    )}
                                    {coordinates && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Coordinates</span>
                                            <span className="text-white font-bold">{coordinates.lat.toFixed(4)}°, {coordinates.lon.toFixed(4)}°</span>
                                        </div>
                                    )}
                                    {locationType && (
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Zone</span>
                                            <span className={`font-bold uppercase text-sm ${locationType === 'coastal' ? 'text-emerald-400' : locationType === 'offshore' ? 'text-sky-400' : 'text-amber-400'}`}>
                                                {locationType}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                , document.body)}
        </>
    );
};
