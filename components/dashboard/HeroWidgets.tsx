import React, { useMemo, useCallback } from 'react';
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

// --- Instrument Cell (reusable for both rows) ---
const InstrumentCell: React.FC<{
    label: string;
    icon: React.ReactNode;
    value: string | number;
    unit?: string;
    trend?: 'up' | 'down' | 'stable';
    improving?: boolean; // Whether "up" is good (e.g., visibility up = good) or bad (e.g., wind up = bad)
    tealHeading?: boolean;
}> = ({ label, icon, value, unit, trend, improving, tealHeading = true }) => {
    return (
        <div className="flex flex-col items-center justify-between h-full py-2 px-1 relative">
            {/* Label with icon - Technical Look */}
            <div className="flex items-center gap-1.5 opacity-90">
                <span className={`w-3 h-3 ${tealHeading ? 'text-teal-400' : 'text-amber-400'}`}>{icon}</span>
                <span className={`text-[10px] font-sans font-bold tracking-widest uppercase ${tealHeading ? 'text-teal-300' : 'text-amber-300'}`}>
                    {label}
                </span>
                <TrendArrow trend={trend} improving={improving} />
            </div>

            {/* Value - Mono, Ivory, Precise */}
            <div className="flex items-baseline mt-auto mb-1">
                <span className="text-3xl font-mono font-medium tracking-tight text-ivory drop-shadow-md">
                    {value}
                </span>
                {unit && <span className="text-[10px] font-sans text-slate-400 font-medium ml-1 self-end mb-1.5">{unit}</span>}
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

                {/* Direction — 16-point cardinal */}
                <InstrumentCell
                    label="DIR"
                    icon={<CompassIcon className="w-3 h-3" rotation={0} />}
                    value={windDir}
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

                {/* Wave Height */}
                <InstrumentCell
                    label="WAVE"
                    icon={<WaveIcon className="w-3 h-3" />}
                    value={waveHeight ?? '--'}
                    unit={waveUnit}
                    trend={trends?.waveHeight}
                    improving={isWaveImproving}
                />

                {/* Swell Period */}
                <InstrumentCell
                    label="SWELL"
                    icon={<WaveIcon className="w-3 h-3" />}
                    value={wavePeriod}
                    unit="s"
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

                {/* Pressure */}
                <InstrumentCell
                    label="HPA"
                    icon={<GaugeIcon className="w-3 h-3" />}
                    value={pressureVal}
                    trend={trends?.pressure}
                    improving={isPressureImproving}
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
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroWidgets = React.memo(HeroWidgetsComponent);
