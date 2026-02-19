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

// --- Award-Winning SVG Compass Widget ---
const CompassWidget: React.FC<{ degrees: number; direction: string }> = ({ degrees, direction }) => {
    // The needle points in the wind direction (where wind is coming FROM)
    const needleRotation = degrees;
    const size = 52;
    const cx = size / 2;
    const cy = size / 2;
    const outerR = 23;
    const innerR = 19;
    const tickR = 21;

    return (
        <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
                {/* Definitions */}
                <defs>
                    {/* Compass face gradient */}
                    <radialGradient id="compassFace" cx="50%" cy="40%" r="50%">
                        <stop offset="0%" stopColor="rgba(30,41,59,0.95)" />
                        <stop offset="100%" stopColor="rgba(15,23,42,0.98)" />
                    </radialGradient>

                    {/* Needle glow */}
                    <filter id="needleGlow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" />
                    </filter>

                    {/* Outer ring gradient */}
                    <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="rgba(94,234,212,0.4)" />
                        <stop offset="50%" stopColor="rgba(56,189,248,0.3)" />
                        <stop offset="100%" stopColor="rgba(94,234,212,0.4)" />
                    </linearGradient>
                </defs>

                {/* Outer bezel ring */}
                <circle cx={cx} cy={cy} r={outerR} fill="none"
                    stroke="url(#ringGrad)" strokeWidth="1.5" />

                {/* Face background */}
                <circle cx={cx} cy={cy} r={innerR} fill="url(#compassFace)"
                    stroke="rgba(94,234,212,0.12)" strokeWidth="0.5" />

                {/* Degree tick marks */}
                {Array.from({ length: 36 }).map((_, i) => {
                    const angle = i * 10;
                    const rad = (angle - 90) * Math.PI / 180;
                    const isCardinal = angle % 90 === 0;
                    const isMajor = angle % 30 === 0;
                    const r1 = isCardinal ? innerR - 5 : isMajor ? innerR - 3.5 : innerR - 2;
                    const r2 = innerR - 1;

                    return (
                        <line key={i}
                            x1={cx + r1 * Math.cos(rad)}
                            y1={cy + r1 * Math.sin(rad)}
                            x2={cx + r2 * Math.cos(rad)}
                            y2={cy + r2 * Math.sin(rad)}
                            stroke={isCardinal ? 'rgba(94,234,212,0.7)' : isMajor ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)'}
                            strokeWidth={isCardinal ? 1 : 0.5}
                        />
                    );
                })}

                {/* Cardinal labels */}
                {[{ l: 'N', a: 0, c: '#f87171' }, { l: 'E', a: 90, c: 'rgba(255,255,255,0.35)' }, { l: 'S', a: 180, c: 'rgba(255,255,255,0.35)' }, { l: 'W', a: 270, c: 'rgba(255,255,255,0.35)' }].map(({ l, a, c }) => {
                    const rad = (a - 90) * Math.PI / 180;
                    const r = innerR - 9;
                    return (
                        <text key={l} x={cx + r * Math.cos(rad)} y={cy + r * Math.sin(rad)}
                            textAnchor="middle" dominantBaseline="central"
                            fill={c} fontSize="6" fontWeight="700" fontFamily="system-ui"
                        >{l}</text>
                    );
                })}

                {/* Needle group — rotates to wind direction */}
                <g transform={`rotate(${needleRotation} ${cx} ${cy})`}
                    style={{ transition: 'transform 1.2s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                >
                    {/* Needle glow (behind) */}
                    <polygon
                        points={`${cx},${cy - 14} ${cx - 2.5},${cy} ${cx + 2.5},${cy}`}
                        fill="rgba(248,113,113,0.5)" filter="url(#needleGlow)"
                    />

                    {/* North needle (red/warm) */}
                    <polygon
                        points={`${cx},${cy - 14} ${cx - 2},${cy - 1} ${cx + 2},${cy - 1}`}
                        fill="url(#ringGrad)"
                        style={{ filter: 'drop-shadow(0 0 2px rgba(94,234,212,0.6))' }}
                    />

                    {/* South needle (subtle) */}
                    <polygon
                        points={`${cx},${cy + 12} ${cx - 1.5},${cy + 1} ${cx + 1.5},${cy + 1}`}
                        fill="rgba(148,163,184,0.25)"
                    />

                    {/* Center pivot */}
                    <circle cx={cx} cy={cy} r="2"
                        fill="rgba(94,234,212,0.9)"
                        stroke="rgba(255,255,255,0.3)" strokeWidth="0.5"
                        style={{ filter: 'drop-shadow(0 0 3px rgba(94,234,212,0.5))' }}
                    />
                </g>
            </svg>

            {/* Direction label — below compass */}
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2">
                <span className="text-[9px] font-bold text-white/80 tracking-widest">{direction}</span>
            </div>
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

    const uvVal = data.uvIndex !== null && data.uvIndex !== undefined ? Math.ceil(data.uvIndex) : '--';
    const visVal = data.visibility !== null && data.visibility !== undefined ? Math.round(data.visibility) : '--';
    const pressureVal = data.pressure !== null && data.pressure !== undefined ? Math.round(data.pressure) : '--';
    const seaTemp = data.waterTemperature !== null && data.waterTemperature !== undefined
        ? convertTemp(data.waterTemperature, units.temp) : '--';
    const rainVal = data.precipitation !== null && data.precipitation !== undefined ? Math.round(data.precipitation) : '--';

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

                {/* Sea Temp */}
                <InstrumentCell
                    label="SEAS"
                    icon={<ThermometerIcon className="w-3 h-3" />}
                    value={seaTemp !== '--' ? `${seaTemp}°` : '--'}
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
                        className="relative flex flex-col items-center gap-6 p-8 rounded-3xl bg-slate-900/95 border border-white/10 shadow-2xl max-w-xs w-full mx-4"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Close button */}
                        <button
                            onClick={() => setShowCompass(false)}
                            className="absolute top-3 right-3 p-2 rounded-full bg-white/10 text-white/80 hover:text-white hover:bg-white/20 transition-colors"
                            aria-label="Close compass"
                        >
                            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                        </button>

                        {/* Title */}
                        <div className="flex items-center gap-2">
                            <CompassIcon className="w-4 h-4 text-teal-400" rotation={0} />
                            <span className="text-sm font-bold text-teal-300 uppercase tracking-widest">Wind Direction</span>
                        </div>

                        {/* Large Compass */}
                        <div className="transform scale-[3] my-12">
                            <CompassWidget degrees={windDeg} direction={windDir} />
                        </div>

                        {/* Metadata */}
                        <div className="flex items-baseline gap-2">
                            <span className="text-3xl font-mono font-medium text-white" style={{ fontFeatureSettings: '"tnum"' }}>
                                {windDeg}°
                            </span>
                            <span className="text-lg font-mono text-slate-400">{windDir}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroWidgets = React.memo(HeroWidgetsComponent);
