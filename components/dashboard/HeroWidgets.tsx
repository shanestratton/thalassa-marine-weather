import React, { useMemo, useCallback, useState } from 'react';
import { t } from '../../theme';
import { useEnvironment } from '../../context/ThemeContext';
import {
    WindIcon,
    WaveIcon,
    GaugeIcon,
    EyeIcon,
    SunIcon,
    SunriseIcon,
    SunsetIcon,
    ThermometerIcon,
    ArrowUpIcon,
    ArrowDownIcon,
    MinusIcon,
    CompassIcon,
    DropletIcon
} from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import {
    convertTemp,
    convertSpeed,
    convertLength,
    convertDistance
} from '../../utils';
import { getMoonPhase } from './WeatherHelpers';

interface HeroWidgetsProps {
    data: WeatherMetrics;  // Both rows — updates with scroll
    units: UnitPreferences;
    cardTime?: number | null;
    sources?: Record<string, { source: string; sourceColor?: 'emerald' | 'amber' | 'sky' | 'white'; sourceName?: string }>;
    trends?: Record<string, 'up' | 'down' | 'stable'>;
    isLive?: boolean;
}

// --- Trend Arrow Component ---
const TrendArrow: React.FC<{ trend?: 'up' | 'down' | 'stable'; improving?: boolean }> = ({ trend, improving }) => {
    if (!trend) return null;

    const isUp = trend === 'up';
    const isStable = trend === 'stable';

    // Green = improving, red = worsening, dim white = stable
    const color = isStable
        ? 'text-white/30'
        : improving
            ? 'text-emerald-400'
            : 'text-red-400';

    return (
        <span className={`inline-flex ml-1 ${color}`}>
            {isStable ? (
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <line x1="1" y1="4" x2="7" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            ) : isUp ? (
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <path d="M4 1L7 5H1L4 1Z" fill="currentColor" />
                </svg>
            ) : (
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <path d="M4 7L1 3H7L4 7Z" fill="currentColor" />
                </svg>
            )}
        </span>
    );
};

// --- Premium SVG Compass Widget ---
const CompassWidget: React.FC<{ degrees: number; size?: number }> = ({ degrees, size = 200 }) => {
    const needleRotation = degrees;
    const cx = size / 2;
    const cy = size / 2;
    const outerR = size * 0.45;
    const innerR = size * 0.39;
    const cardinalR = size * 0.28;
    const labelR = size * 0.19;

    return (
        <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
                <defs>
                    {/* Compass face gradient — deep, rich dark */}
                    <radialGradient id="compassFaceLg" cx="50%" cy="35%" r="55%">
                        <stop offset="0%" stopColor="rgba(30,41,59,0.98)" />
                        <stop offset="70%" stopColor="rgba(15,23,42,0.99)" />
                        <stop offset="100%" stopColor="rgba(8,12,21,1)" />
                    </radialGradient>

                    {/* Bezel gradient — metallic silver ring */}
                    <linearGradient id="bezelGradLg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(148,163,184,0.45)" />
                        <stop offset="50%" stopColor="rgba(71,85,105,0.25)" />
                        <stop offset="100%" stopColor="rgba(148,163,184,0.45)" />
                    </linearGradient>

                    {/* Needle glow */}
                    <filter id="needleGlowLg" x="-100%" y="-100%" width="300%" height="300%">
                        <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
                    </filter>

                    {/* Outer ring glow */}
                    <filter id="outerGlowLg" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
                    </filter>

                    {/* Needle gradient */}
                    <linearGradient id="needleGradLg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f87171" />
                        <stop offset="100%" stopColor="#ef4444" />
                    </linearGradient>

                    {/* Teal accent gradient */}
                    <linearGradient id="tealAccentLg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(94,234,212,0.9)" />
                        <stop offset="100%" stopColor="rgba(45,212,191,0.7)" />
                    </linearGradient>
                </defs>

                {/* Outer glow ring */}
                <circle cx={cx} cy={cy} r={outerR + 2} fill="none"
                    stroke="rgba(94,234,212,0.15)" strokeWidth="6"
                    filter="url(#outerGlowLg)" />

                {/* Outer bezel ring — metallic */}
                <circle cx={cx} cy={cy} r={outerR} fill="none"
                    stroke="url(#bezelGradLg)" strokeWidth="2" />

                {/* Inner bezel ring */}
                <circle cx={cx} cy={cy} r={outerR - 3} fill="none"
                    stroke="rgba(148,163,184,0.08)" strokeWidth="0.5" />

                {/* Face background */}
                <circle cx={cx} cy={cy} r={innerR} fill="url(#compassFaceLg)"
                    stroke="rgba(94,234,212,0.1)" strokeWidth="0.5" />

                {/* Degree tick marks */}
                {Array.from({ length: 72 }).map((_, i) => {
                    const angle = i * 5;
                    const rad = (angle - 90) * Math.PI / 180;
                    const isCardinal = angle % 90 === 0;
                    const isIntercardinal = angle % 45 === 0 && !isCardinal;
                    const isMajor = angle % 30 === 0;
                    const isMinor10 = angle % 10 === 0;
                    const len = isCardinal ? 12 : isIntercardinal ? 9 : isMajor ? 7 : isMinor10 ? 5 : 3;
                    const r1 = innerR - len;
                    const r2 = innerR - 1;
                    const color = isCardinal ? 'rgba(94,234,212,0.8)'
                        : isIntercardinal ? 'rgba(94,234,212,0.4)'
                            : isMajor ? 'rgba(255,255,255,0.3)'
                                : isMinor10 ? 'rgba(255,255,255,0.18)'
                                    : 'rgba(255,255,255,0.08)';
                    const width = isCardinal ? 1.5 : isIntercardinal ? 1 : 0.5;

                    return (
                        <line key={i}
                            x1={cx + r1 * Math.cos(rad)}
                            y1={cy + r1 * Math.sin(rad)}
                            x2={cx + r2 * Math.cos(rad)}
                            y2={cy + r2 * Math.sin(rad)}
                            stroke={color}
                            strokeWidth={width}
                        />
                    );
                })}

                {/* Cardinal labels */}
                {[
                    { l: 'N', a: 0, c: '#f87171', s: 16, w: '800' },
                    { l: 'E', a: 90, c: 'rgba(255,255,255,0.5)', s: 13, w: '600' },
                    { l: 'S', a: 180, c: 'rgba(255,255,255,0.5)', s: 13, w: '600' },
                    { l: 'W', a: 270, c: 'rgba(255,255,255,0.5)', s: 13, w: '600' },
                ].map(({ l, a, c, s, w }) => {
                    const rad = (a - 90) * Math.PI / 180;
                    return (
                        <text key={l} x={cx + cardinalR * Math.cos(rad)} y={cy + cardinalR * Math.sin(rad)}
                            textAnchor="middle" dominantBaseline="central"
                            fill={c} fontSize={s} fontWeight={w} fontFamily="system-ui"
                        >{l}</text>
                    );
                })}

                {/* Intercardinal labels */}
                {[
                    { l: 'NE', a: 45 }, { l: 'SE', a: 135 },
                    { l: 'SW', a: 225 }, { l: 'NW', a: 315 },
                ].map(({ l, a }) => {
                    const rad = (a - 90) * Math.PI / 180;
                    return (
                        <text key={l} x={cx + labelR * Math.cos(rad)} y={cy + labelR * Math.sin(rad)}
                            textAnchor="middle" dominantBaseline="central"
                            fill="rgba(255,255,255,0.2)" fontSize={9} fontWeight="500" fontFamily="system-ui"
                        >{l}</text>
                    );
                })}

                {/* Needle group — rotates to wind direction */}
                <g transform={`rotate(${needleRotation} ${cx} ${cy})`}
                    style={{ transition: 'transform 1.2s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                >
                    {/* Needle glow (behind) */}
                    <polygon
                        points={`${cx},${cy - innerR + 8} ${cx - 5},${cy} ${cx + 5},${cy}`}
                        fill="rgba(248,113,113,0.35)" filter="url(#needleGlowLg)"
                    />

                    {/* North needle (red) */}
                    <polygon
                        points={`${cx},${cy - innerR + 8} ${cx - 4},${cy - 2} ${cx},${cy - 6} ${cx + 4},${cy - 2}`}
                        fill="url(#needleGradLg)"
                        style={{ filter: 'drop-shadow(0 0 4px rgba(248,113,113,0.5))' }}
                    />

                    {/* South needle (subtle) */}
                    <polygon
                        points={`${cx},${cy + innerR - 12} ${cx - 3},${cy + 2} ${cx},${cy + 6} ${cx + 3},${cy + 2}`}
                        fill="rgba(148,163,184,0.15)"
                    />

                    {/* Center pivot — outer ring */}
                    <circle cx={cx} cy={cy} r="5"
                        fill="rgba(15,23,42,0.9)"
                        stroke="rgba(94,234,212,0.5)" strokeWidth="1"
                    />
                    {/* Center pivot — inner dot */}
                    <circle cx={cx} cy={cy} r="2.5"
                        fill="rgba(94,234,212,0.9)"
                        style={{ filter: 'drop-shadow(0 0 4px rgba(94,234,212,0.6))' }}
                    />
                </g>
            </svg>
        </div>
    );
};

// --- Cardinal → Degrees helper ---
const cardinalToDeg = (dir?: string): number | null => {
    if (!dir) return null;
    const map: Record<string, number> = {
        N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
        S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5
    };
    return map[dir.toUpperCase()] ?? null;
};

// --- Small directional arrow (for WAVE/SWELL cells) ---
const DirectionArrow: React.FC<{ degrees: number | null; size?: number }> = ({ degrees, size = 14 }) => {
    if (degrees === null) return null;
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0 opacity-70"
            style={{ transform: `rotate(${degrees}deg)`, transition: 'transform 1s ease' }}>
            <path d="M12 2L8 14h8L12 2Z" fill="rgba(94,234,212,0.7)" />
            <path d="M12 22L8 14h8L12 22Z" fill="rgba(148,163,184,0.25)" />
        </svg>
    );
};

// --- Instrument Cell (reusable for both rows) ---
const InstrumentCell: React.FC<{
    label: string;
    icon: React.ReactNode;
    value: string | number;
    unit?: string;
    trend?: 'up' | 'down' | 'stable';
    improving?: boolean;
    tealHeading?: boolean;
    dirDeg?: number | null; // Optional directional arrow
    onClick?: () => void;
}> = ({ label, icon, value, unit, trend, improving, tealHeading = true, dirDeg, onClick }) => {
    return (
        <div className={`flex flex-col items-center justify-between h-full py-2 px-1 relative ${onClick ? 'cursor-pointer active:bg-white/5 transition-colors' : ''}`} onClick={onClick}>
            {/* Label with icon */}
            <div className="flex items-center gap-1.5 opacity-90">
                <span className={`w-3 h-3 ${tealHeading ? 'text-teal-400' : 'text-amber-400'}`}>{icon}</span>
                <span className={`text-[10px] font-sans font-bold tracking-widest uppercase ${tealHeading ? 'text-teal-300' : 'text-amber-300'}`}>
                    {label}
                </span>
                <TrendArrow trend={trend} improving={improving} />
            </div>

            {/* Value - Mono, Ivory, Precise */}
            <div className="flex items-baseline mt-auto mb-1 gap-0.5">
                {dirDeg !== undefined && dirDeg !== null && <DirectionArrow degrees={dirDeg} size={12} />}
                <span className="text-[26px] font-mono font-medium tracking-tight text-ivory drop-shadow-md" style={{ fontFeatureSettings: '"tnum"' }}>
                    {value}
                </span>
                {unit && <span className="text-[10px] font-sans text-slate-400 font-medium ml-1 self-end mb-1.5">{unit}</span>}
            </div>
        </div>
    );
};

// --- Barometer Cell (HPA — trend inline with value) ---
const BarometerCell: React.FC<{
    pressure: string | number;
    trend?: 'up' | 'down' | 'stable';
}> = ({ pressure, trend }) => {
    const isRising = trend === 'up';
    const isFalling = trend === 'down';
    const isStable = trend === 'stable';

    // Semantic coloring: rising pressure = improving (green), falling = worsening (red)
    const arrowColor = isStable ? 'text-white/30' : isRising ? 'text-emerald-400' : 'text-red-400';

    return (
        <div className="flex flex-col items-center justify-between h-full py-2 px-1 relative">
            {/* Label — no trend arrow here (moved to value line) */}
            <div className="flex items-center gap-1.5 opacity-90">
                <span className="w-3 h-3 text-teal-400"><GaugeIcon className="w-3 h-3" /></span>
                <span className="text-[10px] font-sans font-bold tracking-widest uppercase text-teal-300">HPA</span>
            </div>

            {/* Value with inline trend arrow */}
            <div className="flex items-baseline mt-auto mb-1 gap-0.5">
                <span className="text-[26px] font-mono font-medium tracking-tight text-ivory drop-shadow-md" style={{ fontFeatureSettings: '"tnum"' }}>
                    {pressure}
                </span>
                {trend && (
                    <span className={`inline-flex items-center ml-0.5 ${arrowColor}`}>
                        {isStable ? (
                            <svg width="10" height="10" viewBox="0 0 8 8" fill="none">
                                <line x1="1" y1="4" x2="7" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                        ) : isRising ? (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <path d="M6 2L9 7H3L6 2Z" fill="currentColor" />
                            </svg>
                        ) : (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <path d="M6 10L3 5H9L6 10Z" fill="currentColor" />
                            </svg>
                        )}
                    </span>
                )}
            </div>
        </div>
    );
};

const HeroWidgetsComponent: React.FC<HeroWidgetsProps> = ({
    data,
    units,
    cardTime,
    sources,
    trends,
    isLive = true
}) => {
    // Both rows now use the same data (activeDayData — updates on scroll)
    const topRowData = data;

    // Computed values
    const windSpeed = topRowData.windSpeed !== null && topRowData.windSpeed !== undefined
        ? Math.round(convertSpeed(topRowData.windSpeed, units.speed)!) : '--';
    const gustVal = (() => {
        const gust = topRowData.windGust !== null && topRowData.windGust !== undefined
            ? convertSpeed(topRowData.windGust, units.speed) : null;
        return gust !== null ? Math.round(gust) : '--';
    })();
    const waveHeight = topRowData.waveHeight !== null && topRowData.waveHeight !== undefined
        ? convertLength(topRowData.waveHeight, units.waveHeight) : '--';
    const wavePeriod = topRowData.swellPeriod !== null && topRowData.swellPeriod !== undefined
        ? Math.round(topRowData.swellPeriod) : '--';
    const windDir = topRowData.windDirection || '--';
    const windDeg = topRowData.windDegree || 0;
    const swellDirDeg = cardinalToDeg(topRowData.swellDirection || undefined);

    const safeRound = (v: number | null | undefined): number | string => (v !== null && v !== undefined && !isNaN(v)) ? Math.round(v) : '--';
    const uvVal = (data.uvIndex !== null && data.uvIndex !== undefined && !isNaN(data.uvIndex)) ? Math.ceil(data.uvIndex) : '--';
    const visVal = safeRound(data.visibility);
    const pressureVal = safeRound(data.pressure);
    const seaTemp = (data.waterTemperature !== null && data.waterTemperature !== undefined && !isNaN(data.waterTemperature))
        ? convertTemp(data.waterTemperature, units.temp) : '--';
    const humidityVal = safeRound(data.humidity);
    const rainVal = safeRound(data.precipitation);

    const speedUnit = units.speed || 'kts';
    const waveUnit = units.waveHeight || 'm';
    const distUnit = units.visibility || 'nm';

    // Determine trend improving/worsening context
    // Wind up = bad, gust up = bad, wave up = bad
    // Visibility up = good, pressure up = good (generally)
    const isWindImproving = trends?.windSpeed === 'down'; // Less wind = better for most
    const isGustImproving = trends?.windGust === 'down';
    const isWaveImproving = trends?.waveHeight === 'down';
    const isVisImproving = trends?.visibility === 'up';
    const isPressureImproving = trends?.pressure === 'up'; // Rising pressure = improving weather
    const isHumidityImproving = trends?.humidity === 'down'; // Lower humidity = more comfortable

    const [showCompass, setShowCompass] = useState(false);

    return (
        <div
            className="w-full rounded-xl overflow-hidden backdrop-blur-md bg-white/[0.08] border border-white/[0.15] shadow-2xl"
            role="region"
            aria-label="Weather metrics dashboard"
        >
            {/* TOP ROW: Wind, Dir, Gust, Wave, Per */}
            <div className="w-full grid grid-cols-5 divide-x divide-white/[0.12] h-[80px]">

                {/* Wind Speed */}
                <InstrumentCell
                    label="WIND"
                    icon={<WindIcon className="w-3 h-3" />}
                    value={windSpeed}
                    unit={speedUnit}
                    trend={trends?.windSpeed}
                    improving={isWindImproving}
                />

                {/* Direction — standard cell, tap for compass overlay */}
                <InstrumentCell
                    label="DIR"
                    icon={<CompassIcon className="w-3 h-3" rotation={0} />}
                    value={windDir}
                    onClick={() => setShowCompass(true)}
                />

                {/* Gusts */}
                <InstrumentCell
                    label="GUST"
                    icon={<WindIcon className="w-3 h-3" />}
                    value={gustVal}
                    unit={speedUnit}
                    trend={trends?.windGust}
                    improving={isGustImproving}
                />

                {/* Wave Height — with directional arrow */}
                <InstrumentCell
                    label="WAVE"
                    icon={<WaveIcon className="w-3 h-3" />}
                    value={waveHeight ?? '--'}
                    unit={waveUnit}
                    trend={trends?.waveHeight}
                    improving={isWaveImproving}
                    dirDeg={swellDirDeg}
                />

                {/* Swell Period — with directional arrow */}
                <InstrumentCell
                    label="SWELL"
                    icon={<WaveIcon className="w-3 h-3" />}
                    value={wavePeriod}
                    unit="s"
                    dirDeg={swellDirDeg}
                />
            </div>

            {/* Horizontal divider between rows */}
            <div className="w-full h-px bg-white/[0.12]" />

            {/* BOTTOM ROW: UV, Vis, HPA, Seas, Rain */}
            <div className="w-full grid grid-cols-5 divide-x divide-white/[0.12] h-[80px]">

                {/* UV */}
                <InstrumentCell
                    label="UV"
                    icon={<SunIcon className="w-3 h-3" />}
                    value={uvVal}
                />

                {/* Visibility */}
                <InstrumentCell
                    label="VIS"
                    icon={<EyeIcon className="w-3 h-3" />}
                    value={visVal}
                    unit={distUnit}
                    trend={trends?.visibility}
                    improving={isVisImproving}
                />

                {/* Pressure — custom barometer cell with inline trend */}
                <BarometerCell
                    pressure={pressureVal}
                    trend={trends?.pressure}
                />

                {/* Humidity */}
                <InstrumentCell
                    label="HUM"
                    icon={<DropletIcon className="w-3 h-3" />}
                    value={humidityVal}
                    unit="%"
                    trend={trends?.humidity}
                    improving={isHumidityImproving}
                />

                {/* Rain */}
                <InstrumentCell
                    label="RAIN"
                    icon={<DropletIcon className="w-3 h-3" />}
                    value={rainVal}
                    unit="%"
                />
            </div>

            {/* Compass Overlay Modal */}
            {showCompass && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
                    onClick={() => setShowCompass(false)}
                >
                    <div
                        className="relative flex flex-col items-center gap-3 p-4 pt-8 rounded-2xl bg-gradient-to-b from-slate-800/95 to-slate-900/98 border border-white/10 shadow-2xl"
                        style={{ boxShadow: '0 0 60px rgba(94,234,212,0.08), 0 25px 50px rgba(0,0,0,0.5)', maxWidth: '260px', width: '90%' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Close button — prominent X */}
                        <button
                            onClick={() => setShowCompass(false)}
                            className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-full bg-white/10 text-white/70 hover:text-white hover:bg-white/20 transition-all active:scale-95"
                            aria-label="Close compass"
                        >
                            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                                <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                            </svg>
                        </button>

                        {/* Title */}
                        <div className="flex items-center gap-1.5">
                            <CompassIcon className="w-3.5 h-3.5 text-teal-400" rotation={0} />
                            <span className="text-[10px] font-bold text-teal-300/80 uppercase tracking-[0.2em]">Wind Direction</span>
                        </div>

                        {/* Compass — compact size */}
                        <CompassWidget degrees={windDeg} size={160} />

                        {/* Degrees + Cardinal readout */}
                        <div className="flex items-baseline gap-2 pb-1">
                            <span className="text-3xl font-light text-white tracking-tight" style={{ fontFeatureSettings: '"tnum"' }}>
                                {windDeg}°
                            </span>
                            <span className="text-base font-semibold text-teal-400/80 tracking-wider">{windDir}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroWidgets = React.memo(HeroWidgetsComponent);
