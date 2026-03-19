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
            <p className="text-[11px] text-white/50 font-bold uppercase tracking-wider leading-none">{label}</p>
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
                    background: 'linear-gradient(135deg, rgb(15,23,42), rgb(20,30,50))',
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
                    className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
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

                {/* ── Loading skeleton ── */}
                {loading && !data && (
                    <div className="animate-pulse">
                        {/* Coord placeholder */}
                        <div className="h-3.5 w-28 rounded bg-sky-400/10 mb-3" />

                        {/* Atmospheric skeleton grid */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                            {[0, 1, 2, 3].map((i) => (
                                <div key={i} className="flex items-center gap-2.5 py-1.5">
                                    <div className="w-5 h-5 rounded bg-white/5 shrink-0" />
                                    <div className="flex-1 space-y-1.5">
                                        <div className="h-2.5 w-10 rounded bg-white/5" />
                                        <div className="h-3.5 w-14 rounded bg-white/10" />
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Divider */}
                        <div className="h-px bg-white/[0.06] my-2" />

                        {/* Marine skeleton grid */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                            {[0, 1].map((i) => (
                                <div key={i} className="flex items-center gap-2.5 py-1.5">
                                    <div className="w-5 h-5 rounded bg-white/5 shrink-0" />
                                    <div className="flex-1 space-y-1.5">
                                        <div className="h-2.5 w-10 rounded bg-white/5" />
                                        <div className="h-3.5 w-16 rounded bg-white/10" />
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Loading label */}
                        <div className="flex items-center justify-center gap-2 mt-2 pt-2 border-t border-white/[0.04]">
                            <div className="w-3 h-3 border-2 border-sky-400/30 border-t-sky-400 rounded-full animate-spin" />
                            <span className="text-[10px] text-sky-400/50 font-medium tracking-wider uppercase">
                                Loading weather…
                            </span>
                        </div>
                    </div>
                )}

                {/* ── Real content (shown when data arrives, or loading + data for updates) ── */}
                {(data || (loading && data)) && (
                    <div
                        style={{
                            animation: 'fadeInUp 0.3s ease-out',
                        }}
                    >
                        {/* Coordinate header */}
                        <div className="flex items-center gap-1.5 mb-2 pr-6">
                            <span className="text-[11px] text-sky-400/70 font-mono font-bold">
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
                                loading={loading && !data}
                            />
                            <Metric
                                icon="🌡"
                                label="Temp"
                                value={data ? `${Math.round(data.temperatureC)}°C` : ''}
                                loading={loading && !data}
                            />
                            <Metric
                                icon="🔻"
                                label="Gusts"
                                value={data ? `${kmhToKnots(data.windGustsKmh)} kts` : ''}
                                loading={loading && !data}
                            />
                            <Metric
                                icon="🔵"
                                label="Pressure"
                                value={data ? `${Math.round(data.pressureMsl)} hPa` : ''}
                                loading={loading && !data}
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
                        {hasMarine && (
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
                                        loading={loading && !data}
                                    />
                                    <Metric
                                        icon="⏱"
                                        label="Period"
                                        value={
                                            data && data.wavePeriodS != null ? `${data.wavePeriodS.toFixed(0)}s` : ''
                                        }
                                        sub={
                                            data && data.waveDirectionDeg != null
                                                ? degToCardinal(data.waveDirectionDeg)
                                                : ''
                                        }
                                        loading={loading && !data}
                                    />
                                    {data && data.swellHeightM != null && data.swellHeightM > 0 && (
                                        <>
                                            <Metric
                                                icon="〰️"
                                                label="Swell"
                                                value={`${data.swellHeightM.toFixed(1)}m / ${metresToFeet(data.swellHeightM)}ft`}
                                                loading={loading && !data}
                                            />
                                            <Metric
                                                icon="🔄"
                                                label="Swell Period"
                                                value={
                                                    data.swellPeriodS != null ? `${data.swellPeriodS.toFixed(0)}s` : '—'
                                                }
                                                sub={
                                                    data.swellDirectionDeg != null
                                                        ? degToCardinal(data.swellDirectionDeg)
                                                        : ''
                                                }
                                                loading={loading && !data}
                                            />
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
            {/* Inline keyframes for fade-in animation */}
            <style>{`
                @keyframes fadeInUp {
                    from { opacity: 0; transform: translateY(6px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );
};
