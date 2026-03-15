import React, { useMemo, useState } from 'react';
import { WindIcon, WaveIcon, GaugeIcon, EyeIcon, SunIcon, CompassIcon, DropletIcon } from '../Icons';
import { AnimatedRainIcon } from '../ui/AnimatedIcons';
import { WeatherMetrics, UnitPreferences, HourlyForecast } from '../../types';
import { convertTemp, convertSpeed, convertLength, convertDistance } from '../../utils';

/* ── Micro-animation keyframes for metric icons ── */
/* ── Micro-animation keyframes moved to index.css ── */

interface HeroWidgetsProps {
    data: WeatherMetrics; // Both rows — updates with scroll
    units: UnitPreferences;
    cardTime?: number | null;
    sources?: Record<
        string,
        { source: string; sourceColor?: 'emerald' | 'amber' | 'sky' | 'white'; sourceName?: string }
    >;
    trends?: Record<string, 'up' | 'down' | 'stable'>;
    isLive?: boolean;
    locationType?: 'coastal' | 'offshore' | 'inland';
    hourly?: HourlyForecast[];
}

// --- Trend Arrow Component ---
const TrendArrow: React.FC<{ trend?: 'up' | 'down' | 'stable'; improving?: boolean }> = ({ trend, improving }) => {
    if (!trend) return null;

    const isUp = trend === 'up';
    const isStable = trend === 'stable';

    // Green = improving, red = worsening, dim white = stable
    const color = isStable ? 'text-white/60' : improving ? 'text-emerald-400' : 'text-red-400';

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

                {/* Outer glow ring (Filter Removed to Save GPU) */}
                <circle cx={cx} cy={cy} r={outerR + 2} fill="none" stroke="rgba(94,234,212,0.15)" strokeWidth="6" />

                {/* Outer bezel ring — metallic */}
                <circle cx={cx} cy={cy} r={outerR} fill="none" stroke="url(#bezelGradLg)" strokeWidth="2" />

                {/* Inner bezel ring */}
                <circle cx={cx} cy={cy} r={outerR - 3} fill="none" stroke="rgba(148,163,184,0.08)" strokeWidth="0.5" />

                {/* Face background */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={innerR}
                    fill="url(#compassFaceLg)"
                    stroke="rgba(94,234,212,0.1)"
                    strokeWidth="0.5"
                />

                {/* Degree tick marks */}
                {Array.from({ length: 72 }).map((_, i) => {
                    const angle = i * 5;
                    const rad = ((angle - 90) * Math.PI) / 180;
                    const isCardinal = angle % 90 === 0;
                    const isIntercardinal = angle % 45 === 0 && !isCardinal;
                    const isMajor = angle % 30 === 0;
                    const isMinor10 = angle % 10 === 0;
                    const len = isCardinal ? 12 : isIntercardinal ? 9 : isMajor ? 7 : isMinor10 ? 5 : 3;
                    const r1 = innerR - len;
                    const r2 = innerR - 1;
                    const color = isCardinal
                        ? 'rgba(94,234,212,0.8)'
                        : isIntercardinal
                          ? 'rgba(94,234,212,0.4)'
                          : isMajor
                            ? 'rgba(255,255,255,0.3)'
                            : isMinor10
                              ? 'rgba(255,255,255,0.18)'
                              : 'rgba(255,255,255,0.08)';
                    const width = isCardinal ? 1.5 : isIntercardinal ? 1 : 0.5;

                    return (
                        <line
                            key={i}
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
                    const rad = ((a - 90) * Math.PI) / 180;
                    return (
                        <text
                            key={l}
                            x={cx + cardinalR * Math.cos(rad)}
                            y={cy + cardinalR * Math.sin(rad)}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill={c}
                            fontSize={s}
                            fontWeight={w}
                            fontFamily="system-ui"
                        >
                            {l}
                        </text>
                    );
                })}

                {/* Intercardinal labels */}
                {[
                    { l: 'NE', a: 45 },
                    { l: 'SE', a: 135 },
                    { l: 'SW', a: 225 },
                    { l: 'NW', a: 315 },
                ].map(({ l, a }) => {
                    const rad = ((a - 90) * Math.PI) / 180;
                    return (
                        <text
                            key={l}
                            x={cx + labelR * Math.cos(rad)}
                            y={cy + labelR * Math.sin(rad)}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="rgba(255,255,255,0.2)"
                            fontSize={9}
                            fontWeight="500"
                            fontFamily="system-ui"
                        >
                            {l}
                        </text>
                    );
                })}

                {/* Needle group — rotates to wind direction */}
                <g
                    transform={`rotate(${needleRotation} ${cx} ${cy})`}
                    style={{ transition: 'transform 1.2s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                >
                    {/* Needle glow (behind) (Filter removed) */}
                    <polygon
                        points={`${cx},${cy - innerR + 8} ${cx - 5},${cy} ${cx + 5},${cy}`}
                        fill="rgba(248,113,113,0.35)"
                    />

                    {/* North needle (red) */}
                    <polygon
                        points={`${cx},${cy - innerR + 8} ${cx - 4},${cy - 2} ${cx},${cy - 6} ${cx + 4},${cy - 2}`}
                        fill="url(#needleGradLg)"
                    />

                    {/* South needle (subtle) */}
                    <polygon
                        points={`${cx},${cy + innerR - 12} ${cx - 3},${cy + 2} ${cx},${cy + 6} ${cx + 3},${cy + 2}`}
                        fill="rgba(148,163,184,0.15)"
                    />

                    {/* Center pivot — outer ring */}
                    <circle
                        cx={cx}
                        cy={cy}
                        r="5"
                        fill="rgba(15,23,42,0.9)"
                        stroke="rgba(94,234,212,0.5)"
                        strokeWidth="1"
                    />
                    {/* Center pivot — inner dot */}
                    <circle cx={cx} cy={cy} r="2.5" fill="rgba(94,234,212,0.9)" />
                </g>
            </svg>
        </div>
    );
};

// --- Cardinal → Degrees helper ---
const cardinalToDeg = (dir?: string): number | null => {
    if (!dir) return null;
    const map: Record<string, number> = {
        N: 0,
        NNE: 22.5,
        NE: 45,
        ENE: 67.5,
        E: 90,
        ESE: 112.5,
        SE: 135,
        SSE: 157.5,
        S: 180,
        SSW: 202.5,
        SW: 225,
        WSW: 247.5,
        W: 270,
        WNW: 292.5,
        NW: 315,
        NNW: 337.5,
    };
    return map[dir.toUpperCase()] ?? null;
};

// --- Small directional arrow (for WAVE/SWELL cells) ---
const DirectionArrow: React.FC<{ degrees: number | null; size?: number }> = ({ degrees, size = 14 }) => {
    if (degrees === null) return null;
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            className="shrink-0 opacity-70"
            style={{ transform: `rotate(${degrees}deg)`, transition: 'transform 1s ease' }}
        >
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
    tooltip?: string; // Long-press / hover explanation
}> = ({ label, icon, value, unit, trend, improving, tealHeading = true, dirDeg, onClick, tooltip }) => {
    return (
        <div
            className={`flex flex-col items-center justify-between h-full py-2 px-1 relative ${onClick ? 'cursor-pointer active:bg-white/5 transition-colors' : ''}`}
            onClick={onClick}
            title={tooltip}
            aria-label={tooltip ? `${label}: ${value}${unit ? ' ' + unit : ''}. ${tooltip}` : undefined}
        >
            {/* Header: icon + label + trend — locked to a single 12px line */}
            <div className="flex items-center gap-1 opacity-90 h-3">
                <span
                    className={`w-3 h-3 shrink-0 inline-flex items-center justify-center overflow-hidden ${tealHeading ? 'text-emerald-400' : 'text-amber-400'}`}
                >
                    {icon}
                </span>
                <span
                    className={`text-[11px] font-sans font-bold tracking-widest uppercase leading-none ${tealHeading ? 'text-emerald-300' : 'text-amber-300'}`}
                >
                    {label}
                </span>
                <TrendArrow trend={trend} improving={improving} />
            </div>

            {/* Value */}
            <div className="flex items-baseline mt-auto mb-1 gap-0.5">
                {dirDeg !== undefined && dirDeg !== null && <DirectionArrow degrees={dirDeg} size={12} />}
                <span
                    className="text-[26px] font-mono font-medium tracking-tight text-ivory drop-shadow-md"
                    style={{ fontFeatureSettings: '"tnum"' }}
                >
                    {value}
                </span>
                {unit && (
                    <span className="text-[11px] font-sans text-slate-400 font-medium ml-1 self-end mb-1.5">
                        {unit}
                    </span>
                )}
            </div>
        </div>
    );
};

// --- Barometer Cell (HPA — consistent with InstrumentCell) ---
const BarometerCell: React.FC<{
    pressure: string | number;
    trend?: 'up' | 'down' | 'stable';
}> = ({ pressure, trend }) => {
    // Semantic coloring: rising pressure = improving (green), falling = worsening (red)
    const isRising = trend === 'up';

    return (
        <div className="flex flex-col items-center justify-between h-full py-2 px-1 relative">
            {/* Header: icon + label + trend — locked to 12px line */}
            <div className="flex items-center gap-1 opacity-90 h-3">
                <span className="w-3 h-3 shrink-0 inline-flex items-center justify-center overflow-hidden text-emerald-400">
                    <GaugeIcon className="w-3 h-3" />
                </span>
                <span className="text-[11px] font-sans font-bold tracking-widest uppercase leading-none text-emerald-300">
                    HPA
                </span>
                <TrendArrow trend={trend} improving={isRising} />
            </div>

            {/* Value */}
            <div className="flex items-baseline mt-auto mb-1 gap-0.5">
                <span
                    className="text-[26px] font-mono font-medium tracking-tight text-ivory drop-shadow-md"
                    style={{ fontFeatureSettings: '"tnum"' }}
                >
                    {pressure}
                </span>
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
    isLive = true,
    locationType,
    hourly,
}) => {
    // Both rows now use the same data (activeDayData — updates on scroll)
    const topRowData = data;

    // Computed values
    const windSpeed =
        topRowData.windSpeed !== null && topRowData.windSpeed !== undefined
            ? Math.round(convertSpeed(topRowData.windSpeed, units.speed)!)
            : '--';
    const gustVal = (() => {
        const gust =
            topRowData.windGust !== null && topRowData.windGust !== undefined
                ? convertSpeed(topRowData.windGust, units.speed)
                : null;
        return gust !== null ? Math.round(gust) : '--';
    })();
    const waveHeight =
        topRowData.waveHeight !== null && topRowData.waveHeight !== undefined
            ? convertLength(topRowData.waveHeight, units.waveHeight)
            : '--';
    const wavePeriod =
        topRowData.swellPeriod !== null && topRowData.swellPeriod !== undefined
            ? Math.round(topRowData.swellPeriod)
            : '--';
    const windDir = topRowData.windDirection || '--';
    const windDeg = topRowData.windDegree || 0;
    const swellDirDeg = cardinalToDeg(topRowData.swellDirection || undefined);

    const safeRound = (v: number | null | undefined): number | string =>
        v !== null && v !== undefined && !isNaN(v) ? Math.round(v) : '--';
    const uvVal =
        data.uvIndex !== null && data.uvIndex !== undefined && !isNaN(data.uvIndex) ? Math.ceil(data.uvIndex) : '--';
    const visVal = (() => {
        if (data.visibility === null || data.visibility === undefined || isNaN(data.visibility)) return '--';
        const converted = convertDistance(data.visibility, units.visibility || 'nm');
        if (typeof converted === 'string' && converted.includes('+')) return converted; // '20+' etc
        const num = parseFloat(String(converted));
        return isNaN(num) ? converted : Math.round(num);
    })();
    const pressureVal = safeRound(data.pressure);
    const seaTemp =
        data.waterTemperature !== null && data.waterTemperature !== undefined && !isNaN(data.waterTemperature)
            ? convertTemp(data.waterTemperature, units.temp)
            : '--';
    const humidityVal = safeRound(data.humidity);

    // Rain: live = daily mm total, forecast = precipChance %
    const rainValue = useMemo(() => {
        if (isLive && hourly?.length) {
            // Sum today's hourly precipitation amounts for daily total (mm)
            const todayStr = new Date().toLocaleDateString('en-CA');
            const todayTotal = hourly
                .filter((h) => new Date(h.time).toLocaleDateString('en-CA') === todayStr)
                .reduce((sum, h) => sum + (h.precipitation ?? 0), 0);
            return todayTotal > 0 ? Math.round(todayTotal) : 0;
        }
        if (!isLive && hourly?.length) {
            // BUG FIX: Use cardTime (the hour the user scrolled to), NOT Date.now()
            // Previously this always matched "right now", so every future hour showed the same rain %.
            const targetTime = cardTime ?? Date.now();
            const currentHour = hourly.find((h) => Math.abs(new Date(h.time).getTime() - targetTime) < 90 * 60_000);
            if (currentHour?.precipChance !== undefined) return currentHour.precipChance;
            // If no precipChance, fall back to that hour's precipitation amount
            if (currentHour?.precipitation !== undefined) return safeRound(currentHour.precipitation);
        }
        // Fallback: use the active data's own precipChance or precipitation, not the live observation
        if ((data as any).precipChance !== undefined) return (data as any).precipChance;
        return safeRound(data.precipitation);
    }, [isLive, hourly, data.precipitation, (data as any).precipChance, cardTime]);
    const rainUnit = isLive ? (units.temp === 'F' ? 'in' : 'mm') : '%';

    const isOffshore = locationType === 'offshore';

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

    // PERF: useState kept to maintain hook order (React rules-of-hooks).
    // Compass overlay has been removed, but deleting this useState would crash
    // when switching between wx full/essential modes.
    const [_showCompass] = useState(false);
    return (
        <div
            className="w-full rounded-xl overflow-hidden bg-white/[0.08] border border-white/[0.15] shadow-2xl"
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
                    tooltip="Sustained wind speed — average over 10 minutes"
                />

                {/* Direction — standard cell, tap for compass overlay */}
                <InstrumentCell label="DIR" icon={<CompassIcon className="w-3 h-3" rotation={0} />} value={windDir} />

                {/* Gusts */}
                <InstrumentCell
                    label="GUST"
                    icon={<WindIcon className="w-3 h-3" />}
                    value={gustVal}
                    unit={speedUnit}
                    trend={trends?.windGust}
                    improving={isGustImproving}
                    tooltip="Peak gust speed — sudden short bursts above sustained wind"
                />

                {/* Wave/Swell Height — adapts to location type */}
                <InstrumentCell
                    label={isOffshore ? 'SWELL' : 'WAVE'}
                    icon={<WaveIcon className="w-3 h-3" />}
                    value={waveHeight ?? '--'}
                    unit={waveUnit}
                    trend={trends?.waveHeight}
                    improving={isWaveImproving}
                    dirDeg={swellDirDeg}
                    tooltip={
                        isOffshore
                            ? 'Open-ocean swell height — long-period waves from distant storms'
                            : 'Significant wave height — average of tallest third of waves'
                    }
                />

                {/* Period — wave or swell period */}
                <InstrumentCell
                    label="PER."
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
                    tooltip="UV Index — 0-2 Low, 3-5 Moderate, 6-7 High, 8-10 Very High, 11+ Extreme"
                />

                {/* Visibility */}
                <InstrumentCell
                    label="VIS"
                    icon={<EyeIcon className="w-3 h-3" />}
                    value={visVal}
                    unit={distUnit}
                    trend={trends?.visibility}
                    improving={isVisImproving}
                    tooltip="Visibility — horizontal distance at which objects can be clearly seen"
                />

                {/* Pressure — custom barometer cell with inline trend */}
                <BarometerCell pressure={pressureVal} trend={trends?.pressure} />

                {/* Humidity */}
                <InstrumentCell
                    label="HUM"
                    icon={<DropletIcon className="w-3 h-3" />}
                    value={humidityVal}
                    unit="%"
                    trend={trends?.humidity}
                    improving={isHumidityImproving}
                    tooltip="Relative humidity — 60%+ feels muggy on a boat, <30% is very dry"
                />

                {/* Rain */}
                <InstrumentCell
                    label="RAIN"
                    icon={<AnimatedRainIcon className="w-3 h-3 text-emerald-400" />}
                    value={rainValue}
                    unit={rainUnit}
                    tooltip={
                        isLive
                            ? 'Total rainfall today — accumulated precipitation in 24 hours'
                            : 'Chance of precipitation during this hour'
                    }
                />
            </div>
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroWidgets = React.memo(HeroWidgetsComponent);
