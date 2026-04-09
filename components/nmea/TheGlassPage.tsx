/**
 * TheGlassPage — "Instrument Panel" fullscreen NMEA instrument dashboard.
 *
 * Premium multimeter view with:
 *   - SOG + AWS top row (2-col with sparklines)
 *   - TWS hero arc gauge (center, bezeled mechanical frame)
 *   - Depth Sounder + COG Compass + Heel Angle (3-col)
 *   - NMEA Data (sensor status + voltage) + Voyage (trip dist) bottom row
 *
 * All data is live from the NmeaStore via useNmeaStore(), with dummy fallback
 * values when no live NMEA data is connected so the panel remains testable.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNmeaStore } from './useNmeaStore';
import { triggerHaptic } from '../../utils/system';
import type { TimestampedMetric, DataFreshness } from '../../services/NmeaStore';

interface TheGlassPageProps {
    onBack: () => void;
}

// ── Dummy data fallbacks (used when no live NMEA data is connected) ──
const DUMMY = {
    sog: 14.2,
    aws: 22.0,
    tws: 38.1,
    twsMax: 42.5,
    depth: 12.8,
    cog: 2,
    heel: 8, // STBD positive
    voltage: 13.2,
    trip: 4.5,
};

// ── Sparkline component — rolling SVG polyline ──
const HISTORY_SIZE = 90;

interface SparklineProps {
    history: number[];
    min: number;
    max: number;
    color: string;
    width?: number;
    height?: number;
    showAxes?: boolean;
    axisUnit?: string;
    label?: string;
}

const Sparkline: React.FC<SparklineProps> = ({
    history,
    min,
    max,
    color,
    width = 120,
    height = 50,
    showAxes = false,
    axisUnit,
    label,
}) => {
    if (history.length < 2) return <div style={{ width, height }} className="opacity-20" />;

    const range = max - min || 1;
    const padX = showAxes ? 24 : 4;
    const padY = 4;
    const chartW = width - padX * 2;
    const chartH = height - padY * 2;

    const points = history
        .map((v, i) => {
            const x = padX + (i / (HISTORY_SIZE - 1)) * chartW;
            const y = padY + chartH - ((v - min) / range) * chartH;
            return `${x},${y}`;
        })
        .join(' ');

    const firstX = padX + (0 / (HISTORY_SIZE - 1)) * chartW;
    const lastX = padX + ((history.length - 1) / (HISTORY_SIZE - 1)) * chartW;
    const bottomY = padY + chartH;
    const fillPoints = `${firstX},${bottomY} ${points} ${lastX},${bottomY}`;

    return (
        <svg width={width} height={height} className="block">
            <defs>
                <linearGradient id={`spark-fill-${label}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
            </defs>
            <polygon points={fillPoints} fill={`url(#spark-fill-${label})`} />
            <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />

            {showAxes && (
                <>
                    <text x={2} y={padY + 4} fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="system-ui">
                        {Math.round(max)}
                        {axisUnit}
                    </text>
                    <text x={2} y={padY + chartH} fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="system-ui">
                        {Math.round(min)}
                        {axisUnit}
                    </text>
                </>
            )}
        </svg>
    );
};

// ── Synthesise a sparkline history for dummy data ──
function syntheticHistory(base: number, amplitude: number): number[] {
    return Array.from({ length: HISTORY_SIZE }, (_, i) => {
        const wave1 = Math.sin(i * 0.15) * amplitude * 0.5;
        const wave2 = Math.cos(i * 0.07) * amplitude * 0.3;
        const wave3 = Math.sin(i * 0.31) * amplitude * 0.2;
        return Math.max(0, base + wave1 + wave2 + wave3);
    });
}

// ── HeroCompass — compact 360° compass card sized to its parent ──
const HeroCompass: React.FC<{ value: number; isLive: boolean; accentColor?: string }> = ({
    value,
    isLive,
    accentColor = '#22d3ee',
}) => {
    const rotation = -value;
    const opacity = isLive ? 1 : 0.4;

    const ticks = useMemo(() => {
        const items: { deg: number; label?: string; isCardinal: boolean; isMajor: boolean }[] = [];
        const labels: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
        for (let d = 0; d < 360; d += 15) {
            const isCardinal = d % 90 === 0;
            const isMajor = d % 30 === 0;
            items.push({ deg: d, label: labels[d], isCardinal, isMajor });
        }
        return items;
    }, []);

    return (
        <svg viewBox="0 0 120 120" className="w-full h-full">
            <defs>
                <filter id="hero-compass-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="1.5" result="blur" />
                    <feFlood floodColor={accentColor} floodOpacity="0.6" />
                    <feComposite in2="blur" operator="in" />
                    <feMerge>
                        <feMergeNode />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>

            {/* Background ring */}
            <circle
                cx="60"
                cy="60"
                r="55"
                fill="rgba(15,23,42,0.4)"
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="0.8"
            />
            <circle cx="60" cy="60" r="48" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />

            {/* Rotating compass card */}
            <g
                transform={`rotate(${rotation} 60 60)`}
                style={{ transition: 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)' }}
                opacity={opacity}
            >
                {ticks.map(({ deg, label, isCardinal, isMajor }) => {
                    const rad = ((deg - 90) * Math.PI) / 180;
                    const innerR = isCardinal ? 38 : isMajor ? 42 : 44;
                    const outerR = 48;
                    const x1 = 60 + innerR * Math.cos(rad);
                    const y1 = 60 + innerR * Math.sin(rad);
                    const x2 = 60 + outerR * Math.cos(rad);
                    const y2 = 60 + outerR * Math.sin(rad);
                    const labelR = 32;
                    const lx = 60 + labelR * Math.cos(rad);
                    const ly = 60 + labelR * Math.sin(rad);
                    return (
                        <g key={deg}>
                            <line
                                x1={x1}
                                y1={y1}
                                x2={x2}
                                y2={y2}
                                stroke={isCardinal ? 'white' : 'rgba(255,255,255,0.4)'}
                                strokeWidth={isCardinal ? 1.2 : 0.6}
                                strokeLinecap="round"
                            />
                            {label && (
                                <text
                                    x={lx}
                                    y={ly}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fill={label === 'N' ? '#f87171' : 'white'}
                                    fontSize="9"
                                    fontWeight="900"
                                    fontFamily="system-ui, -apple-system, sans-serif"
                                    transform={`rotate(${-rotation} ${lx} ${ly})`}
                                >
                                    {label}
                                </text>
                            )}
                        </g>
                    );
                })}
            </g>

            {/* Lubber line (fixed indicator at top) */}
            <g filter="url(#hero-compass-glow)">
                <path d="M 60 4 L 56 12 L 64 12 Z" fill={accentColor} opacity={opacity} />
            </g>

            {/* Center digital readout */}
            <circle cx="60" cy="60" r="14" fill="rgba(2,6,23,0.85)" stroke="rgba(255,255,255,0.12)" strokeWidth="0.8" />
            <text
                x="60"
                y="61"
                textAnchor="middle"
                dominantBaseline="central"
                fill="white"
                fontSize="11"
                fontWeight="900"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
                opacity={opacity}
            >
                {Math.round(value).toString().padStart(3, '0')}°
            </text>
        </svg>
    );
};

// ── HeroArcGauge — compact 240° arc gauge with self-contained digital readout ──
interface HeroArcGaugeProps {
    value: number;
    min: number;
    max: number;
    unit: string;
    label: string;
    accentColor: string;
    zones: { from: number; to: number; color: string }[];
    majorTick: number;
    isLive: boolean;
}

const HERO_CX = 100;
const HERO_CY = 105;
const HERO_R = 78;
const HERO_START = 150;
const HERO_END = 390;
const HERO_SWEEP = HERO_END - HERO_START;

function heroPolarToCart(cx: number, cy: number, r: number, deg: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function heroDescribeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
    const s = heroPolarToCart(cx, cy, r, startDeg);
    const e = heroPolarToCart(cx, cy, r, endDeg);
    const largeArc = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
}

const HeroArcGauge: React.FC<HeroArcGaugeProps> = ({
    value,
    min,
    max,
    unit,
    label,
    accentColor,
    zones,
    majorTick,
    isLive,
}) => {
    const range = max - min;
    const clamped = Math.max(min, Math.min(max, value));
    const fraction = (clamped - min) / range;
    const needleAngle = HERO_START + fraction * HERO_SWEEP;
    const opacity = isLive ? 1 : 0.4;

    const ticks = useMemo(() => {
        const items: { val: number; isMajor: boolean }[] = [];
        const minorStep = majorTick / 5;
        for (let v = min; v <= max + 0.001; v += minorStep) {
            const rounded = Math.round(v * 100) / 100;
            items.push({ val: rounded, isMajor: Math.abs(rounded % majorTick) < 0.01 });
        }
        return items;
    }, [min, max, majorTick]);

    return (
        <svg viewBox="0 0 200 200" className="w-full h-full">
            <defs>
                <filter id={`hero-glow-${label}`} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feFlood floodColor={accentColor} floodOpacity="0.6" />
                    <feComposite in2="blur" operator="in" />
                    <feMerge>
                        <feMergeNode />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>

            {/* Background track arc */}
            <path
                d={heroDescribeArc(HERO_CX, HERO_CY, HERO_R, HERO_START, HERO_END)}
                fill="none"
                stroke="rgba(255,255,255,0.06)"
                strokeWidth="10"
                strokeLinecap="round"
                opacity={opacity}
            />

            {/* Zone arcs (faint background) */}
            {zones.map((zone, i) => {
                const zStart = HERO_START + ((zone.from - min) / range) * HERO_SWEEP;
                const zEnd = HERO_START + ((zone.to - min) / range) * HERO_SWEEP;
                return (
                    <path
                        key={i}
                        d={heroDescribeArc(HERO_CX, HERO_CY, HERO_R, zStart, zEnd)}
                        fill="none"
                        stroke={zone.color}
                        strokeWidth="10"
                        strokeLinecap="butt"
                        opacity={opacity * 0.18}
                    />
                );
            })}

            {/* Value fill arc */}
            {fraction > 0.005 && (
                <path
                    d={heroDescribeArc(HERO_CX, HERO_CY, HERO_R, HERO_START, needleAngle)}
                    fill="none"
                    stroke={accentColor}
                    strokeWidth="10"
                    strokeLinecap="round"
                    opacity={opacity * 0.85}
                    style={{ transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
                />
            )}

            {/* Tick marks */}
            <g opacity={opacity}>
                {ticks.map(({ val, isMajor }) => {
                    const frac = (val - min) / range;
                    const angle = HERO_START + frac * HERO_SWEEP;
                    const outerR = HERO_R + 8;
                    const innerR = isMajor ? HERO_R + 2 : HERO_R + 5;
                    const outer = heroPolarToCart(HERO_CX, HERO_CY, outerR, angle);
                    const inner = heroPolarToCart(HERO_CX, HERO_CY, innerR, angle);
                    return (
                        <g key={val}>
                            <line
                                x1={inner.x}
                                y1={inner.y}
                                x2={outer.x}
                                y2={outer.y}
                                stroke={isMajor ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.18)'}
                                strokeWidth={isMajor ? 1.5 : 0.6}
                                strokeLinecap="round"
                            />
                            {isMajor && (
                                <text
                                    x={heroPolarToCart(HERO_CX, HERO_CY, outerR + 9, angle).x}
                                    y={heroPolarToCart(HERO_CX, HERO_CY, outerR + 9, angle).y}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fill="rgba(148,163,184,0.7)"
                                    fontSize="8"
                                    fontWeight="600"
                                    fontFamily="system-ui, -apple-system, sans-serif"
                                >
                                    {val}
                                </text>
                            )}
                        </g>
                    );
                })}
            </g>

            {/* Needle */}
            <g
                style={{ transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
                transform={`rotate(${needleAngle} ${HERO_CX} ${HERO_CY})`}
                opacity={opacity}
            >
                <line
                    x1={HERO_CX}
                    y1={HERO_CY}
                    x2={HERO_CX}
                    y2={HERO_CY - HERO_R + 6}
                    stroke={accentColor}
                    strokeWidth="2"
                    strokeLinecap="round"
                    filter={`url(#hero-glow-${label})`}
                />
                <circle cx={HERO_CX} cy={HERO_CY - HERO_R + 6} r="3" fill={accentColor} opacity={0.95} />
            </g>

            {/* Center hub */}
            <circle
                cx={HERO_CX}
                cy={HERO_CY}
                r="6"
                fill="rgba(15,23,42,0.95)"
                stroke="rgba(255,255,255,0.18)"
                strokeWidth="1.2"
                opacity={opacity}
            />
            <circle cx={HERO_CX} cy={HERO_CY} r="2.2" fill={accentColor} opacity={opacity * 0.9} />

            {/* Digital readout (inside SVG, below center) */}
            <text
                x={HERO_CX}
                y={HERO_CY + 38}
                textAnchor="middle"
                fill="white"
                fontSize="34"
                fontWeight="900"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
                style={{ letterSpacing: '-1px' }}
            >
                {value.toFixed(1)}
            </text>
            <text
                x={HERO_CX}
                y={HERO_CY + 55}
                textAnchor="middle"
                fill="rgba(148,163,184,0.85)"
                fontSize="9"
                fontWeight="700"
                fontFamily="system-ui, -apple-system, sans-serif"
                style={{ letterSpacing: '2px' }}
            >
                {unit.toUpperCase()} · {label}
            </text>
        </svg>
    );
};

// ── Vertical heel capsule (artificial horizon style) ──
const HeelCapsule: React.FC<{ degrees: number; isLive: boolean }> = ({ degrees, isLive }) => {
    const side = degrees >= 0 ? 'STBD' : 'PORT';
    const absAngle = Math.abs(degrees);

    return (
        <div className="flex flex-col items-center gap-1.5">
            {/* Vertical capsule */}
            <div
                className="relative w-14 h-24 rounded-full overflow-hidden border border-white/10"
                style={{
                    background: 'radial-gradient(ellipse at 50% 30%, #1e293b 0%, #020617 80%)',
                    boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.6), 0 0 12px rgba(34,211,238,0.08)',
                }}
            >
                <svg viewBox="0 0 56 96" className="w-full h-full">
                    {/* Mast (vertical centerline) */}
                    <line
                        x1="28"
                        y1="10"
                        x2="28"
                        y2="86"
                        stroke="rgba(255,255,255,0.18)"
                        strokeWidth="1"
                        strokeDasharray="2 3"
                    />
                    {/* Horizon group — tilts opposite to heel */}
                    <g transform={`rotate(${-degrees} 28 48)`}>
                        {/* Water below horizon */}
                        <rect x="-30" y="48" width="116" height="80" fill="rgba(34,211,238,0.12)" />
                        {/* Horizon line */}
                        <line
                            x1="-30"
                            y1="48"
                            x2="86"
                            y2="48"
                            stroke={isLive ? '#22d3ee' : '#475569'}
                            strokeWidth="2.5"
                            strokeLinecap="round"
                        />
                    </g>
                    {/* Top centre tick */}
                    <line x1="28" y1="6" x2="28" y2="14" stroke="white" strokeWidth="2" strokeLinecap="round" />
                    {/* Side reference ticks */}
                    <line x1="6" y1="48" x2="12" y2="48" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
                    <line x1="44" y1="48" x2="50" y2="48" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
                </svg>
            </div>
            <div className="text-center">
                <div className="flex items-baseline justify-center gap-0.5">
                    <span className="text-2xl font-black text-white tabular-nums font-mono">{absAngle.toFixed(0)}</span>
                    <span className="text-sm font-bold text-gray-400">°</span>
                </div>
                <p className="text-[9px] font-bold uppercase tracking-widest text-cyan-400">{side}</p>
            </div>
        </div>
    );
};

// ── Sensor status icon ──
const SensorIcon: React.FC<{ icon: string; label: string; active: boolean }> = ({ icon, label, active }) => (
    <div className="flex flex-col items-center gap-0.5">
        <span className={`text-lg ${active ? 'opacity-100' : 'opacity-30'}`}>{icon}</span>
        <span className={`text-[9px] font-bold uppercase tracking-wider ${active ? 'text-cyan-400' : 'text-gray-600'}`}>
            {label}
        </span>
    </div>
);

// ── Helper: track real-data history per metric ──
function useMetricHistory(metric: TimestampedMetric): { history: number[]; max: number; min: number } {
    const [history, setHistory] = useState<number[]>([]);
    const lastRef = useRef<number>(0);
    const maxRef = useRef<number>(-Infinity);
    const minRef = useRef<number>(Infinity);

    useEffect(() => {
        if (metric.value !== null && metric.lastUpdated !== lastRef.current) {
            lastRef.current = metric.lastUpdated;
            const v = metric.value;
            if (v > maxRef.current) maxRef.current = v;
            if (v < minRef.current) minRef.current = v;
            setHistory((prev) => {
                const next = [...prev, v];
                return next.length > HISTORY_SIZE ? next.slice(-HISTORY_SIZE) : next;
            });
        }
    }, [metric.value, metric.lastUpdated]);

    return { history, max: maxRef.current, min: minRef.current };
}

// ── Resolve a metric value with dummy fallback ──
function resolveMetric(metric: TimestampedMetric, dummy: number): { value: number; freshness: DataFreshness } {
    if (metric.value !== null) return { value: metric.value, freshness: metric.freshness };
    return { value: dummy, freshness: 'live' };
}

// ══════════════════════════════════════════════
// THE GLASS PAGE
// ══════════════════════════════════════════════

export const TheGlassPage: React.FC<TheGlassPageProps> = ({ onBack }) => {
    const state = useNmeaStore();

    // Resolve all metrics with dummy fallbacks
    const sog = resolveMetric(state.sog, DUMMY.sog);
    const tws = resolveMetric(state.tws, DUMMY.tws);
    const depth = resolveMetric(state.depth, DUMMY.depth);
    const cog = resolveMetric(state.cog, DUMMY.cog);
    const voltage = resolveMetric(state.voltage, DUMMY.voltage);

    // AWS — no field in NmeaStore yet, always dummy until wired up
    const aws = useMemo<{ value: number; freshness: DataFreshness }>(
        () => ({ value: DUMMY.aws, freshness: 'live' }),
        [],
    );

    // Real-data sparkline histories
    const sogReal = useMetricHistory(state.sog);
    const twsReal = useMetricHistory(state.tws);
    const depthReal = useMetricHistory(state.depth);

    // Chart configs — fall back to synthetic dummy histories
    const sogChart = useMemo(
        () =>
            sogReal.history.length > 5
                ? { history: sogReal.history, min: Math.max(0, sogReal.min - 2), max: sogReal.max + 2 }
                : { history: syntheticHistory(DUMMY.sog, 3), min: 9, max: 18 },
        [sogReal.history, sogReal.min, sogReal.max],
    );
    const awsChart = useMemo(() => ({ history: syntheticHistory(DUMMY.aws, 4), min: 14, max: 28 }), []);
    const twsChart = useMemo(
        () =>
            twsReal.history.length > 5
                ? { history: twsReal.history, min: Math.max(0, twsReal.min - 5), max: twsReal.max + 5 }
                : { history: syntheticHistory(DUMMY.tws, 6), min: 28, max: 46 },
        [twsReal.history, twsReal.min, twsReal.max],
    );
    const depthChart = useMemo(
        () =>
            depthReal.history.length > 5
                ? { history: depthReal.history, min: 0, max: Math.max(20, depthReal.max + 5) }
                : { history: syntheticHistory(DUMMY.depth, 2.5), min: 0, max: 20 },
        [depthReal.history, depthReal.max],
    );

    // TWS max tracker
    const [twsMax, setTwsMax] = useState<number>(0);
    useEffect(() => {
        if (state.tws.value !== null && state.tws.value > twsMax) {
            setTwsMax(state.tws.value);
        }
    }, [state.tws.value, twsMax]);
    const twsMaxDisplay = twsMax > 0 ? twsMax : DUMMY.twsMax;

    // Trip distance accumulator (SOG × dt)
    const [tripDist, setTripDist] = useState<number>(0);
    const lastSogTime = useRef<number>(0);
    useEffect(() => {
        if (state.sog.value !== null && state.sog.freshness === 'live') {
            const now = Date.now();
            if (lastSogTime.current > 0) {
                const dtHours = (now - lastSogTime.current) / 3_600_000;
                setTripDist((prev) => prev + state.sog.value! * dtHours);
            }
            lastSogTime.current = now;
        }
    }, [state.sog.value, state.sog.freshness]);
    const tripDisplay = tripDist > 0 ? tripDist : DUMMY.trip;

    const handleBack = useCallback(() => {
        triggerHaptic('light');
        onBack();
    }, [onBack]);

    const isConnected = state.connectionStatus === 'connected';

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                {/* ═══ HEADER ═══ */}
                <div
                    className="shrink-0 px-4 pt-4 pb-3 flex items-center gap-3"
                    style={{ paddingTop: 'calc(env(safe-area-inset-top, 20px) + 8px)' }}
                >
                    <button
                        onClick={handleBack}
                        aria-label="Go back"
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center press"
                    >
                        <svg
                            className="w-5 h-5 text-gray-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="flex-1 flex items-center justify-center gap-2.5">
                        {/* Logo mark */}
                        <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
                            <defs>
                                <linearGradient id="logo-grad" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stopColor="#22d3ee" />
                                    <stop offset="100%" stopColor="#a78bfa" />
                                </linearGradient>
                            </defs>
                            <circle cx="16" cy="16" r="13" stroke="url(#logo-grad)" strokeWidth="2" fill="none" />
                            <path
                                d="M16 4 L16 28 M4 16 L28 16"
                                stroke="url(#logo-grad)"
                                strokeWidth="1"
                                opacity="0.5"
                            />
                            <path
                                d="M8 8 L24 24 M24 8 L8 24"
                                stroke="url(#logo-grad)"
                                strokeWidth="0.7"
                                opacity="0.3"
                            />
                            <circle cx="16" cy="16" r="3.5" fill="url(#logo-grad)" />
                        </svg>
                        <div className="text-left">
                            <h1 className="text-base font-black text-white uppercase tracking-[0.18em] leading-none">
                                Thalassa Skipper
                            </h1>
                            <p className="text-[8px] font-bold uppercase tracking-[0.3em] text-cyan-400/70 mt-1">
                                The Sailor&apos;s Assistant
                            </p>
                        </div>
                    </div>
                    {/* Connection status */}
                    <div className="flex items-center gap-1.5 min-w-[44px] justify-end">
                        <div
                            className={`w-2 h-2 rounded-full ${
                                isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                            }`}
                        />
                        <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                            {isConnected ? 'Live' : 'Demo'}
                        </span>
                    </div>
                </div>

                {/* ═══ INSTRUMENT PANEL ═══ */}
                <div
                    className="flex-1 min-h-0 overflow-y-auto px-3 pb-4"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
                >
                    {/* ── ROW 1: SOG (left) + TWS GAUGE (center overlap) + AWS (right) ── */}
                    <div className="relative mb-2">
                        <div className="grid grid-cols-2 gap-2">
                            {/* SOG Card */}
                            <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 mb-1">
                                    SOG
                                </p>
                                <div className="flex items-baseline gap-1">
                                    <span className="text-3xl font-black tabular-nums font-mono text-white">
                                        {sog.value.toFixed(1)}
                                    </span>
                                    <span className="text-xs font-bold text-gray-500">kts</span>
                                </div>
                                {/* Speed bar — purple → pink */}
                                <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                    <div
                                        className="h-full rounded-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 transition-all duration-500"
                                        style={{ width: `${Math.min(100, (sog.value / 20) * 100)}%` }}
                                    />
                                </div>
                                {/* Sparkline */}
                                <div className="mt-2">
                                    <Sparkline
                                        history={sogChart.history}
                                        min={sogChart.min}
                                        max={sogChart.max}
                                        color="#d946ef"
                                        width={140}
                                        height={45}
                                        showAxes
                                        label="sog"
                                    />
                                    <p className="text-[8px] font-bold uppercase tracking-widest text-gray-600 text-center mt-0.5">
                                        Rolling Chart
                                    </p>
                                </div>
                            </div>

                            {/* AWS Card */}
                            <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 mb-1">
                                    AWS
                                </p>
                                <div className="flex items-baseline gap-1">
                                    <span className="text-3xl font-black tabular-nums font-mono text-white">
                                        {aws.value.toFixed(1)}
                                    </span>
                                    <span className="text-xs font-bold text-gray-500">kts</span>
                                </div>
                                {/* Wind speed bar — blue gradient */}
                                <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                    <div
                                        className="h-full rounded-full bg-gradient-to-r from-sky-500 via-cyan-400 to-blue-500 transition-all duration-500"
                                        style={{ width: `${Math.min(100, (aws.value / 30) * 100)}%` }}
                                    />
                                </div>
                                {/* Apparent winds sparkline */}
                                <div className="mt-2">
                                    <Sparkline
                                        history={awsChart.history}
                                        min={awsChart.min}
                                        max={awsChart.max}
                                        color="#38bdf8"
                                        width={140}
                                        height={45}
                                        showAxes
                                        label="aws"
                                    />
                                    <p className="text-[8px] font-bold uppercase tracking-widest text-gray-600 text-center mt-0.5">
                                        Apparent Winds
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* ── TWS HERO GAUGE (overlapping center, bezeled metallic) ── */}
                        <div className="flex justify-center -mt-6 mb-1 relative z-10">
                            {/* Outer bezel ring — conic-gradient simulates brushed metal */}
                            <div
                                className="rounded-full p-[3px]"
                                style={{
                                    background:
                                        'conic-gradient(from 220deg, #71717a, #27272a, #52525b, #18181b, #71717a, #3f3f46, #71717a)',
                                    boxShadow:
                                        '0 0 30px rgba(0,0,0,0.9), 0 8px 24px rgba(0,0,0,0.6), inset 0 0 1px rgba(255,255,255,0.4)',
                                }}
                            >
                                {/* Inner brushed metal ring */}
                                <div
                                    className="rounded-full p-[2px]"
                                    style={{
                                        background: 'linear-gradient(135deg, #3f3f46 0%, #18181b 50%, #3f3f46 100%)',
                                    }}
                                >
                                    {/* Glass dial */}
                                    <div
                                        className="rounded-full p-2"
                                        style={{
                                            background:
                                                'radial-gradient(circle at 30% 25%, rgba(30,41,59,0.95) 0%, rgba(2,6,23,0.98) 70%)',
                                            boxShadow:
                                                'inset 0 4px 14px rgba(0,0,0,0.7), inset 0 0 30px rgba(0,0,0,0.5)',
                                            border: '1px solid rgba(255,255,255,0.06)',
                                        }}
                                    >
                                        <div style={{ width: '180px', height: '180px' }}>
                                            <HeroArcGauge
                                                value={tws.value}
                                                min={0}
                                                max={60}
                                                unit="kts"
                                                label="TWS"
                                                accentColor="#ec4899"
                                                zones={[
                                                    { from: 0, to: 15, color: '#22c55e' },
                                                    { from: 15, to: 25, color: '#eab308' },
                                                    { from: 25, to: 40, color: '#f97316' },
                                                    { from: 40, to: 60, color: '#ef4444' },
                                                ]}
                                                majorTick={10}
                                                isLive={tws.freshness !== 'dead'}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        {/* MAX wind readout */}
                        <div className="flex justify-center -mt-2 mb-2">
                            <div className="px-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-gray-500">
                                    MAX{' '}
                                </span>
                                <span className="text-xs font-black text-amber-400 tabular-nums font-mono">
                                    {twsMaxDisplay.toFixed(1)}
                                </span>
                                <span className="text-[9px] font-bold text-gray-500"> kts</span>
                            </div>
                        </div>
                    </div>

                    {/* ── ROW 2: DEPTH + COG COMPASS + HEEL ANGLE (3-col) ── */}
                    <div className="grid grid-cols-3 gap-2 mb-2">
                        {/* Depth Sounder */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-1">
                                Depth Sounder
                            </p>
                            <div className="flex items-baseline gap-0.5">
                                <span className="text-2xl font-black tabular-nums font-mono text-white">
                                    {depth.value.toFixed(1)}
                                </span>
                                <span className="text-xs font-bold text-gray-500">m</span>
                            </div>
                            <p className="text-[8px] font-bold uppercase tracking-widest text-gray-600 mt-0.5">W</p>
                            <div className="mt-1">
                                <Sparkline
                                    history={depthChart.history}
                                    min={depthChart.min}
                                    max={depthChart.max}
                                    color="#22d3ee"
                                    width={100}
                                    height={55}
                                    showAxes
                                    axisUnit="m"
                                    label="depth"
                                />
                                <p className="text-[7px] font-bold uppercase tracking-widest text-gray-600 text-center mt-0.5">
                                    15 min chart
                                </p>
                            </div>
                        </div>

                        {/* COG Compass */}
                        <div className="p-2 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex flex-col items-center">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-1">
                                COG Compass
                            </p>
                            <div style={{ width: '100%', maxWidth: '110px', aspectRatio: '1' }}>
                                <HeroCompass value={cog.value} isLive={cog.freshness !== 'dead'} />
                            </div>
                        </div>

                        {/* Heel Angle */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex flex-col items-center">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-2">
                                Heel Angle
                            </p>
                            <HeelCapsule degrees={DUMMY.heel} isLive />
                        </div>
                    </div>

                    {/* ── ROW 3: NMEA DATA + VOYAGE (2-col) ── */}
                    <div className="grid grid-cols-2 gap-2">
                        {/* NMEA Data */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-2">
                                NMEA Data
                            </p>
                            <div className="flex items-center justify-around mb-2">
                                <SensorIcon icon="📍" label="GPS" active />
                                <SensorIcon icon="💨" label="Wind" active />
                                <SensorIcon icon="🔵" label="Depth" active />
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-lg">🔋</span>
                                <span className="text-xl font-black tabular-nums font-mono text-white">
                                    {voltage.value.toFixed(1)}
                                </span>
                                <span className="text-xs font-bold text-gray-500">V</span>
                            </div>
                        </div>

                        {/* Voyage */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-2">
                                Voyage
                            </p>
                            <p className="text-[10px] font-bold text-gray-500 mb-0.5">Trip Dist:</p>
                            <div className="flex items-baseline gap-1">
                                <span className="text-3xl font-black tabular-nums font-mono text-white">
                                    {tripDisplay.toFixed(1)}
                                </span>
                                <span className="text-xs font-bold text-gray-500">NM</span>
                            </div>
                            <p className="text-[10px] font-bold text-gray-500 mt-2">Avg Speed:</p>
                            <div className="flex items-baseline gap-1">
                                <span className="text-lg font-black tabular-nums font-mono text-cyan-400">
                                    {sog.value.toFixed(1)}
                                </span>
                                <span className="text-xs font-bold text-gray-500">kts</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
