/**
 * WeatherInspectPopup — Glassmorphic weather info card shown on map tap.
 *
 * Renders a floating dark-glass card with current conditions at the
 * tapped coordinate. Shows atmospheric data always, marine data only
 * when over water.
 */

import React from 'react';
import type { PointWeatherData } from '../../services/weather/pointWeather';

interface Props {
    data: PointWeatherData | null;
    loading: boolean;
    onClose: () => void;
}

// ── Direction helpers ──

function degToCardinal(deg: number): string {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

function kmhToKnots(kmh: number): number {
    return Math.round(kmh / 1.852);
}

function metresToFeet(m: number): number {
    return Math.round(m * 3.281);
}

// ── Skeleton shimmer ──

const Shimmer: React.FC<{ w?: string }> = ({ w = 'w-12' }) => (
    <div className={`h-4 ${w} rounded bg-white/10 animate-pulse`} />
);

// ── Metric row ──

const Metric: React.FC<{
    icon: string;
    label: string;
    value: string;
    sub?: string;
    loading?: boolean;
}> = ({ icon, label, value, sub, loading }) => (
    <div className="flex items-center gap-2.5 py-1.5">
        <span className="text-base shrink-0 w-5 text-center">{icon}</span>
        <div className="flex-1 min-w-0">
            <p className="text-[10px] text-white/50 font-bold uppercase tracking-wider leading-none">{label}</p>
            {loading ? (
                <Shimmer />
            ) : (
                <p className="text-[13px] text-white font-bold leading-tight">
                    {value}
                    {sub && <span className="text-white/40 text-[11px] font-medium ml-1">{sub}</span>}
                </p>
            )}
        </div>
    </div>
);

// ── Wind direction arrow ──

const WindArrow: React.FC<{ deg: number }> = ({ deg }) => (
    <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        style={{ transform: `rotate(${deg + 180}deg)`, transition: 'transform 0.3s' }}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-sky-400 shrink-0"
    >
        <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
);

// ── Main component ──

export const WeatherInspectPopup: React.FC<Props> = ({ data, loading, onClose }) => {
    const hasMarine = data && data.waveHeightM != null && data.waveHeightM > 0;

    return (
        <div style={{ minWidth: 240, maxWidth: 280 }}>
            {/* Card */}
            <div
                style={{
                    background: 'linear-gradient(135deg, rgba(15,23,42,0.98), rgba(30,41,59,0.96))',
                    backdropFilter: 'blur(20px) saturate(1.4)',
                    WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 16,
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05) inset',
                }}
                className="p-3 relative"
            >
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors"
                    aria-label="Close"
                >
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        className="text-white/50"
                    >
                        <path d="M1 1l8 8M9 1l-8 8" />
                    </svg>
                </button>

                {/* Coordinate header */}
                <div className="flex items-center gap-1.5 mb-2 pr-6">
                    <span className="text-[10px] text-sky-400/70 font-mono font-bold">
                        {data
                            ? `${Math.abs(data.lat).toFixed(2)}°${data.lat >= 0 ? 'N' : 'S'} ${Math.abs(data.lon).toFixed(2)}°${data.lon >= 0 ? 'E' : 'W'}`
                            : '…'}
                    </span>
                </div>

                {/* Atmospheric section */}
                <div className="grid grid-cols-2 gap-x-3">
                    <Metric
                        icon="💨"
                        label="Wind"
                        value={data ? `${kmhToKnots(data.windSpeedKmh)} kts` : ''}
                        sub={data ? degToCardinal(data.windDirectionDeg) : ''}
                        loading={loading}
                    />
                    <Metric
                        icon="🌡"
                        label="Temp"
                        value={data ? `${Math.round(data.temperatureC)}°C` : ''}
                        loading={loading}
                    />
                    <Metric
                        icon="🔻"
                        label="Gusts"
                        value={data ? `${kmhToKnots(data.windGustsKmh)} kts` : ''}
                        loading={loading}
                    />
                    <Metric
                        icon="🔵"
                        label="Pressure"
                        value={data ? `${Math.round(data.pressureMsl)} hPa` : ''}
                        loading={loading}
                    />
                </div>

                {/* Wind direction arrow row */}
                {data && !loading && (
                    <div className="flex items-center gap-1.5 mt-1 mb-1 px-0.5">
                        <WindArrow deg={data.windDirectionDeg} />
                        <span className="text-[11px] text-white/50 font-medium">
                            From {degToCardinal(data.windDirectionDeg)} ({Math.round(data.windDirectionDeg)}°)
                        </span>
                    </div>
                )}

                {/* Marine section — only when over water */}
                {(loading || hasMarine) && (
                    <>
                        <div className="h-px bg-white/[0.06] my-1.5" />
                        <div className="grid grid-cols-2 gap-x-3">
                            <Metric
                                icon="🌊"
                                label="Waves"
                                value={
                                    data && data.waveHeightM != null
                                        ? `${data.waveHeightM.toFixed(1)}m / ${metresToFeet(data.waveHeightM)}ft`
                                        : ''
                                }
                                loading={loading}
                            />
                            <Metric
                                icon="⏱"
                                label="Period"
                                value={data && data.wavePeriodS != null ? `${data.wavePeriodS.toFixed(0)}s` : ''}
                                sub={data && data.waveDirectionDeg != null ? degToCardinal(data.waveDirectionDeg) : ''}
                                loading={loading}
                            />
                            {data && data.swellHeightM != null && data.swellHeightM > 0 && (
                                <>
                                    <Metric
                                        icon="〰️"
                                        label="Swell"
                                        value={`${data.swellHeightM.toFixed(1)}m / ${metresToFeet(data.swellHeightM)}ft`}
                                        loading={loading}
                                    />
                                    <Metric
                                        icon="🔄"
                                        label="Swell Period"
                                        value={data.swellPeriodS != null ? `${data.swellPeriodS.toFixed(0)}s` : '—'}
                                        sub={
                                            data.swellDirectionDeg != null ? degToCardinal(data.swellDirectionDeg) : ''
                                        }
                                        loading={loading}
                                    />
                                </>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
