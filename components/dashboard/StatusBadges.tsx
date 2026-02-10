
import { useState } from 'react';
import { t } from '../../theme';
import { RadioTowerIcon } from '../Icons';
import { Countdown } from './Countdown';

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
    // Data source modal props
    current?: {
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
    };
    modelUsed?: string;
    generatedAt?: string;
    coordinates?: { lat: number; lon: number };
}

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
    current,
    modelUsed,
    generatedAt,
    coordinates
}) => {
    const [showInfoModal, setShowInfoModal] = useState(false);

    const shortenSourceName = (name: string): string => {
        // Abbreviate common words

        // Abbreviate common words
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

        // Replace full 'BUOY' with abbreviation
        name = name.replace(/BUOY/i, 'BY');

        // If still too long (>12 chars), truncate more aggressively
        if (name.length > 12) {
            name = name.substring(0, 10) + '..';
        }

        return name;
    };

    // BADGES Logic
    let statusBadgeLabel = "OFFSHORE";
    let statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30";

    // Priority: Explicit Location Type
    if (locationType === 'offshore') {
        statusBadgeLabel = "OFFSHORE";
        statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30";
    } else if (locationType === 'inland' || isLandlocked || fallbackInland) {
        statusBadgeLabel = "INLAND";
        statusBadgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30";
    } else {
        // Default / Coastal
        statusBadgeLabel = "COASTAL";
        statusBadgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    }

    let timerBadgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/30";

    const hasStormGlass = true; // Always present as fallback

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
                    <div className={`px-2 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider ${statusBadgeColor} bg-black/40`}>
                        {statusBadgeLabel}
                    </div>

                    {/* Multi-Source Badge — tappable */}
                    <button
                        onClick={() => setShowInfoModal(true)}
                        aria-label="View data sources"
                        className="px-2 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider bg-black/40 border-white/20 flex-1 min-w-0 flex items-center justify-center gap-1.5 overflow-hidden cursor-pointer active:scale-[0.97] transition-transform"
                    >
                        <RadioTowerIcon className="w-2.5 h-2.5 shrink-0 text-white/70" />
                        <div className="flex items-center gap-1.5 truncate">
                            {beaconName && (
                                <>
                                    <span className="text-emerald-400 font-bold">{shortenSourceName(beaconName)}</span>
                                    {(buoyName || hasStormGlass) && <span className="text-white/30">•</span>}
                                </>
                            )}
                            {buoyName && (
                                <>
                                    <span className="text-emerald-400 font-bold">{shortenSourceName(buoyName)}</span>
                                    {hasStormGlass && <span className="text-white/30">•</span>}
                                </>
                            )}
                            {hasStormGlass && (
                                <span className="text-amber-400 font-bold">SG</span>
                            )}
                        </div>
                    </button>

                    {/* Timer Badge */}
                    <div className={`px-1.5 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider ${timerBadgeColor} bg-black/40 flex items-center gap-1 min-w-[60px] justify-center`}>
                        {nextUpdate ? <Countdown targetTime={nextUpdate} /> : "LIVE"}
                    </div>
                </div>
            </div>

            {/* Data Source Info Modal */}
            {showInfoModal && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center modal-backdrop-enter bg-black/60 backdrop-blur-md p-4"
                    onClick={() => setShowInfoModal(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Data sources details"
                >
                    <div
                        className="modal-panel-enter w-full max-w-md bg-slate-900/95 backdrop-blur-xl border border-white/15 rounded-2xl shadow-2xl overflow-hidden"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 pt-5 pb-3">
                            <div className="flex items-center gap-2">
                                <RadioTowerIcon className="w-5 h-5 text-emerald-400" />
                                <h2 className="text-base font-black text-white tracking-tight">Data Sources</h2>
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
                            {/* Active Sources */}
                            <div className="space-y-2">
                                {beaconName && (
                                    <div className="flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                                        <span className="text-emerald-400 font-bold text-sm">{beaconName}</span>
                                        <span className="text-slate-500 text-sm ml-auto">BEACON</span>
                                    </div>
                                )}
                                {buoyName && (
                                    <div className="flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                                        <span className="text-emerald-400 font-bold text-sm">{buoyName}</span>
                                        <span className="text-slate-500 text-sm ml-auto">BUOY</span>
                                    </div>
                                )}
                                <div className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                                    <span className="text-amber-400 font-bold text-sm">StormGlass API</span>
                                    <span className="text-slate-500 text-sm ml-auto">MODEL</span>
                                </div>
                            </div>

                            {/* Divider */}
                            <div className="border-t border-white/5" />

                            {/* Now Totals */}
                            {current && (
                                <div>
                                    <p className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-2">Current Conditions</p>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Wind</span>
                                            <span className="text-white font-bold">{fmt(current.windSpeed, 'kts')} {typeof current.windDirection === 'string' ? current.windDirection : fmtDir(current.windDirection)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Gust</span>
                                            <span className="text-white font-bold">{fmt(current.windGust, 'kts')}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Waves</span>
                                            <span className="text-white font-bold">{current.waveHeight != null ? `${(current.waveHeight / 3.28084).toFixed(1)} m` : '—'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Period</span>
                                            <span className="text-white font-bold">{fmt(current.wavePeriod, 's', 0)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Swell</span>
                                            <span className="text-white font-bold">{current.swellHeight != null ? `${(current.swellHeight / 3.28084).toFixed(1)} m` : '—'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Swell Pd</span>
                                            <span className="text-white font-bold">{fmt(current.swellPeriod, 's', 0)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Air Temp</span>
                                            <span className="text-white font-bold">{fmt(current.airTemperature, '°')}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Water</span>
                                            <span className="text-white font-bold">{fmt(current.waterTemperature, '°')}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Pressure</span>
                                            <span className="text-white font-bold">{fmt(current.pressure, 'hPa', 0)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Visibility</span>
                                            <span className="text-white font-bold">{fmt(current.visibility, 'km', 0)}</span>
                                        </div>
                                        {current.humidity != null && (
                                            <div className="flex justify-between">
                                                <span className="text-slate-400">Humidity</span>
                                                <span className="text-white font-bold">{fmt(current.humidity, '%', 0)}</span>
                                            </div>
                                        )}
                                        {current.cloudCover != null && (
                                            <div className="flex justify-between">
                                                <span className="text-slate-400">Cloud</span>
                                                <span className="text-white font-bold">{fmt(current.cloudCover, '%', 0)}</span>
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
            )}
        </>
    );
};
