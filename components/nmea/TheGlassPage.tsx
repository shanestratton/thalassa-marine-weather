/**
 * TheGlassPage — "Instrument Panel" fullscreen NMEA instrument dashboard.
 *
 * Premium multimeter view with:
 *   - SOG + AWS top row (2-col with sparklines)
 *   - TWS hero arc gauge (center, bezeled mechanical frame)
 *   - Depth Sounder + Heading compass (2-col)
 *   - Wind rose (true + apparent) + Voyage bottom row
 *
 * Rebuilt 2026-08-08. It previously carried a Heel Angle tile wired to a
 * literal 0 with no sensor behind it, and an NMEA Data tile whose three emoji
 * repeated the header's own LIVE/Stale verdict. Both are gone; the space went
 * to the wind, which had none — and the compass now shows HEADING rather than
 * COG, because COG below a knot is GPS noise.
 *
 * All data is live from the NmeaStore via useNmeaStore(), with dummy fallback
 * values when no live NMEA data is connected so the panel remains testable.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNmeaStore } from './useNmeaStore';
import { SereneWindRose } from './gauges/SereneWindRose';
import { SailPlanDiagram } from './gauges/SailPlanDiagram';
import { SailPartsDiagram } from './gauges/SailPartsDiagram';
import { useUnwrappedAngle } from './gauges/useUnwrappedAngle';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { ModalSheet } from '../ui/ModalSheet';
import { useDeviceClass, pickByDevice } from '../../utils/useDeviceClass';
import type { TimestampedMetric, DataFreshness } from '../../services/NmeaStore';
import { nmeaDepthReferenceLabel } from '../../services/nmea/nmeaSentence';
import { NmeaStore } from '../../services/NmeaStore';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { diagnosePanel, missingInstruments } from '../../utils/instrumentPanelStatus';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    COMFORT_M,
    DEPTH_FALLBACK_OFFSET,
    helmBalance,
    helmVerdict,
    kiteAdvice,
    reefDescribe,
    stabiliseSailPlan,
    type SailPlanHold,
    shoalRate,
    type SailingWind,
} from '../../services/sailing/sereneSailing';

interface TheGlassPageProps {
    onBack: () => void;
}

// ── Format helper — shows em-dash for null / non-finite values ──
// Used everywhere a numeric reading would otherwise render. Keeps
// the panel honest: if we don't have the data, we show "—" instead
// of fabricating a plausible-looking number.
function fmt(val: number | null | undefined, decimals: number = 1): string {
    return val !== null && val !== undefined && Number.isFinite(val) ? val.toFixed(decimals) : '—';
}

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

// (Synthetic-history dummy generator removed — sparklines now stay
//  empty when no real data has arrived. Sparkline component handles
//  the empty-history case by rendering a low-opacity placeholder.)

// ── HeroCompass — compact 360° compass card sized to its parent ──
const HeroCompass: React.FC<{ value: number | null; isLive: boolean; accentColor?: string }> = ({
    value,
    isLive,
    accentColor = '#22d3ee',
}) => {
    // Unwrapped, so the card takes the short way across north instead of
    // spinning 358 degrees backwards through south every time the bow wanders
    // over 000 — which is precisely where this boat sits at anchor.
    const rotation = useUnwrappedAngle(value === null ? null : -value);
    const opacity = value === null ? 0.25 : isLive ? 1 : 0.4;

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
            {/* CSS transitions animate the transform PROPERTY, not the SVG
                transform ATTRIBUTE — the old `transform={...}` plus a
                transition style was a no-op, and the card snapped. */}
            <g
                style={{
                    transform: `rotate(${rotation}deg)`,
                    transformOrigin: '60px 60px',
                    transition: 'transform 900ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
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
                {value === null ? '—' : `${Math.round(value).toString().padStart(3, '0')}°`}
            </text>
        </svg>
    );
};

/**
 * FlankMetric — one number in the column beside the dial.
 *
 * Narrow on purpose: these live in the dead space either side of a round
 * gauge, so they must never be wide enough to squeeze it. A missing value
 * shows an em dash rather than a zero — with the boat on the hard most of
 * these are legitimately absent, and a confident 0.0 for depth is the one
 * number on this page that could put her aground.
 */
/**
 * Position in degrees and decimal minutes — the form it is written in a log,
 * read off a chart and passed over the radio.
 *
 * Three decimals, not the one that services/shiplog/helpers.ts uses: that
 * formatter's output is STORED on log entries, so its precision is not mine
 * to change, and a tenth of a minute is 185 m — fine as a log stamp, far too
 * coarse for a live position readout.
 */
function formatFix(lat: number | null, lon: number | null): string | null {
    if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const dm = (v: number, pos: string, neg: string) => {
        const a = Math.abs(v);
        const d = Math.floor(a);
        return `${d}°${((a - d) * 60).toFixed(3)}′${v >= 0 ? pos : neg}`;
    };
    return `${dm(lat, 'N', 'S')}  ${dm(lon, 'E', 'W')}`;
}

const FlankMetric: React.FC<{
    label: string;
    value: number | null;
    unit: string;
    digits?: number;
    /** Bearings read as three padded digits, the way they are written and
     *  spoken — and so a heading can never be misread as an angle. */
    pad3?: boolean;
    tone?: string;
}> = ({ label, value, unit, digits = 1, pad3 = false, tone = 'text-white' }) => {
    const has = value !== null && Number.isFinite(value);
    const text = !has
        ? '—'
        : pad3
          ? Math.round(value as number)
                .toString()
                .padStart(3, '0')
          : (value as number).toFixed(digits);
    return (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-1 py-1.5 text-center">
            <p className="text-[8px] font-black uppercase tracking-[0.14em] text-gray-500">{label}</p>
            <p
                className={`font-mono text-[15px] font-black tabular-nums leading-tight ${has ? tone : 'text-gray-600'}`}
            >
                {text}
                {has && <span className="text-[8px] font-bold text-gray-500">{unit}</span>}
            </p>
        </div>
    );
};

// ── HeroArcGauge — compact 240° arc gauge with self-contained digital readout ──
interface HeroArcGaugeProps {
    value: number | null;
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
    const clamped = value === null ? min : Math.max(min, Math.min(max, value));
    const fraction = (clamped - min) / range;
    const needleAngle = HERO_START + fraction * HERO_SWEEP;
    const opacity = value === null ? 0.25 : isLive ? 1 : 0.4;

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
                {value === null ? '—' : value.toFixed(1)}
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

// ── Pass-through accessor — kept as a thin wrapper for symmetry
//    with the multi-source aggregation we used to do. Returns the
//    metric's actual value (which may be null if no data has arrived
//    yet) and its freshness. Callers render via fmt() for the "—"
//    fallback. ──
function resolveMetric(metric: TimestampedMetric): { value: number | null; freshness: DataFreshness } {
    return { value: metric.freshness === 'dead' ? null : metric.value, freshness: metric.freshness };
}

// ── Section faceplate — the etched title strip each instrument sits under ──
const SectionPlate: React.FC<{ title: string }> = ({ title }) => (
    <div className="flex items-center gap-3 py-1.5 shrink-0" aria-hidden="true">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/15" />
        <p className="text-[10px] font-black uppercase tracking-[0.35em] text-gray-400">{title}</p>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/15" />
    </div>
);

// ══════════════════════════════════════════════
// THE GLASS PAGE
// ══════════════════════════════════════════════

export const TheGlassPage: React.FC<TheGlassPageProps> = ({ onBack }) => {
    const state = useNmeaStore();
    const deviceClass = useDeviceClass();

    // The panel owns its own data source rather than trusting that some other
    // page started it. Every tile is gated on the store's connectionStatus, so
    // an unstarted store renders a completely blank panel while the gateway is
    // connected and streaming — which is exactly what happened on 2026-08-09.
    // start() is idempotent, and this page is never opened for any other
    // reason, so claiming the store here costs nothing and removes an ordering
    // dependency on which screen the skipper happened to visit first.
    useEffect(() => {
        if (NmeaListenerService.getSavedConfig()) NmeaStore.start();
    }, []);

    // How long the socket has been up, so "waiting" can become "no data" once
    // patience stops being the right answer.
    const [connectedAt, setConnectedAt] = useState<number | null>(null);
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        if (state.connectionStatus !== 'connected') {
            setConnectedAt(null);
            return;
        }
        setConnectedAt((prev) => prev ?? Date.now());
    }, [state.connectionStatus]);
    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    // Tablet-aware sizing — scales the instrument-panel chrome up so a
    // 12" iPad reads as a real bridge instrument, not a centred phone
    // layout floating in white space. Values picked to roughly preserve
    // the visual relationship between elements (gauge dominant, cards
    // secondary, sparklines tertiary) at the new scale.
    const containerPx = pickByDevice(deviceClass, 'px-3', 'px-6');
    const containerGap = pickByDevice(deviceClass, 'gap-2', 'gap-4');
    const containerMb = pickByDevice(deviceClass, 'mb-2', 'mb-4');
    /* Each snap section is exactly the scroller's height, and the scroller
       runs UNDER the translucent tab bar — so without this the bottom of
       every section sat behind the nav, which is what cut the wind roses off
       (Shane 2026-08-28: "the two bottom roses are not entirely on the
       screen"). Same 5.5rem clearance the rest of the app uses over that
       bar. */
    const sectionPb = 'pb-[calc(5.5rem+env(safe-area-inset-bottom))]';
    const cardPad = pickByDevice(deviceClass, 'p-3', 'p-5');
    const sogAwsValueClass = pickByDevice(deviceClass, 'text-3xl', 'text-5xl');
    const depthValueClass = pickByDevice(deviceClass, 'text-2xl', 'text-4xl');
    const tripValueClass = pickByDevice(deviceClass, 'text-3xl', 'text-5xl');
    const sparklineWidth = pickByDevice(deviceClass, 140, 200);
    const sparklineHeight = pickByDevice(deviceClass, 45, 60);
    const depthSparkWidth = pickByDevice(deviceClass, 100, 140);
    const depthSparkHeight = pickByDevice(deviceClass, 55, 75);
    const heroGaugeSize = pickByDevice(deviceClass, 180, 280);
    const compassMaxWidth = pickByDevice(deviceClass, 110, 160);

    // Resolve all metrics — values may be null when no NMEA data has
    // arrived yet. Render sites use fmt() to show "—" in that case.
    const sog = resolveMetric(state.sog);
    const tws = resolveMetric(state.tws);
    const depth = resolveMetric(state.depth);
    const cog = resolveMetric(state.cog);
    const voltage = resolveMetric(state.voltage);
    const heading = resolveMetric(state.heading);
    const heel = resolveMetric(state.heel);
    // Real now. The gateway has been broadcasting MWV,R and MWD all along —
    // the parser dropped both, so this used to be a hardcoded null (2026-08-08).
    const aws = resolveMetric(state.aws);
    const awa = resolveMetric(state.awa);
    const twd = resolveMetric(state.twd);
    const twaSigned = resolveMetric(state.twaSigned);
    const stw = resolveMetric(state.stw);
    const latitude = resolveMetric(state.latitude);
    const longitude = resolveMetric(state.longitude);
    const rudder = resolveMetric(state.rudder);
    // The 30-60s helm window the serene advice demands — null while it fills.
    const helmWindow = NmeaStore.helmWindow();

    // The serene sailing brain encodes Serene Summer specifically (Tayana 55,
    // Leisure Furl, runners). Her advice must never reach another hull, so
    // the sail-plan sections gate on the vessel profile.
    const vesselProfile = useSettingsStore((store) => store.settings.vessel);
    const isSereneSummer =
        /tayana\s*55/i.test(vesselProfile?.model ?? '') || /serene\s*summer/i.test(vesselProfile?.name ?? '');

    // Depth track with real timestamps for the shoaling trend — the sparkline
    // history has no clock, and shoalRate least-squares against minutes.
    const depthTrackRef = useRef<Array<{ t: number; d: number }>>([]);
    useEffect(() => {
        if (state.depth.value !== null && state.depth.freshness === 'live') {
            const now = Date.now() / 1000;
            depthTrackRef.current.push({ t: now, d: state.depth.value });
            while (depthTrackRef.current.length > 0 && now - depthTrackRef.current[0].t > 900)
                depthTrackRef.current.shift();
        }
    }, [state.depth.value, state.depth.freshness, state.depth.lastUpdated]);
    const depthTrend = shoalRate(depthTrackRef.current, DEPTH_FALLBACK_OFFSET);

    // Rolling 10-min TWS peak as the live gust proxy for the sail plan —
    // labelled as such; a forecast gust would claim knowledge we lack here.
    const gustRef = useRef<Array<{ t: number; v: number }>>([]);
    useEffect(() => {
        if (state.tws.value !== null && state.tws.freshness === 'live') {
            const now = Date.now();
            gustRef.current.push({ t: now, v: state.tws.value });
            while (gustRef.current.length > 0 && now - gustRef.current[0].t > 600_000) gustRef.current.shift();
        }
    }, [state.tws.value, state.tws.freshness, state.tws.lastUpdated]);
    const recentGust = gustRef.current.length > 0 ? Math.max(...gustRef.current.map((e) => e.v)) : null;

    const awaUnsigned = awa.value !== null ? ((awa.value % 360) + 360) % 360 : null;
    const twaUnsigned = twaSigned.value !== null ? ((twaSigned.value % 360) + 360) % 360 : null;
    const sailingWind: SailingWind = {
        awa: awaUnsigned,
        aws: aws.value,
        twa: twaUnsigned,
        tws: tws.value,
        sog: sog.value,
        stw: stw.value,
        hdg: heading.value,
        helm: helmWindow ? { mean: helmWindow.mean, max: helmWindow.max, activity: helmWindow.activity } : null,
    };
    const helm = helmBalance(sailingWind);
    const helmWords = helmWindow ? helmVerdict(helmWindow.mean) : null;
    /*
     * The sail plan is HELD, not recomputed from scratch every tick.
     *
     * sailPlanFor is pure and has hard edges, and she yaws several degrees on
     * every wave — so the recommendation flipped constantly while nothing
     * about the sailing had changed (Shane 2026-08-28: "we need to make it so
     * that we dont need to change the sail layout every 5 seconds"). The
     * stabiliser adds hysteresis at the edges and an asymmetric dwell: quick
     * to call for less sail, slow to call for more, slowest of all for a
     * change that moves no sail at all.
     *
     * Re-evaluated on every reading AND on a slow tick, because a dwell can
     * expire while the numbers sit perfectly still.
     */
    const [sailHold, setSailHold] = useState<SailPlanHold | null>(null);
    const [holdTick, setHoldTick] = useState(0);
    useEffect(() => {
        if (!isSereneSummer) return;
        const id = setInterval(() => setHoldTick((t) => t + 1), 5_000);
        return () => clearInterval(id);
    }, [isSereneSummer]);
    useEffect(() => {
        if (!isSereneSummer) return;
        setSailHold((prev) => stabiliseSailPlan(prev, recentGust, twaUnsigned, Date.now()));
        // holdTick is a deliberate dependency: it is what lets a dwell expire
        // on a boat holding a steady course in a steady breeze.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSereneSummer, recentGust, twaUnsigned, holdTick]);
    const plan = sailHold?.plan ?? null;
    const kite = isSereneSummer ? kiteAdvice(recentGust, twaUnsigned, false) : null;

    // Snap-section registry for the dot rail.
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const [activeSection, setActiveSection] = useState(0);
    const sectionNames = useMemo(() => {
        const base = ['Wind', 'Speed', 'Depth', 'Heading', 'Helm'];
        return isSereneSummer ? [...base, 'Sail Plan'] : base;
    }, [isSereneSummer]);
    const onPanelScroll = useCallback(() => {
        const el = scrollerRef.current;
        if (!el) return;
        const index = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
        setActiveSection((prev) => (prev === index ? prev : Math.max(0, Math.min(index, sectionNames.length - 1))));
    }, [sectionNames.length]);
    const jumpToSection = useCallback((index: number) => {
        const el = scrollerRef.current;
        if (!el) return;
        triggerHaptic('light');
        el.scrollTo({ top: index * el.clientHeight, behavior: 'smooth' });
    }, []);

    // COG is a GPS-derived course made good. Below a knot it is noise — a
    // moored boat's fixes wander, and the compass card was reporting 053 while
    // the bow sat on north (Shane 2026-08-08). Heading is what "which way am I
    // pointing" means, and HDG/HDT are on the wire; show that, and only add COG
    // once the boat is genuinely making way.
    const MAKING_WAY_KTS = 1;
    const makingWay = sog.value !== null && sog.value >= MAKING_WAY_KTS;

    // Real-data sparkline histories.
    const sogReal = useMetricHistory(state.sog);
    const depthReal = useMetricHistory(state.depth);

    // Chart configs — empty history when nothing's arrived yet, so
    // Sparkline renders its grey placeholder. No fabricated waveforms.
    const sogChart = useMemo(
        () =>
            sogReal.history.length > 5
                ? { history: sogReal.history, min: Math.max(0, sogReal.min - 2), max: sogReal.max + 2 }
                : { history: [] as number[], min: 0, max: 1 },
        [sogReal.history, sogReal.min, sogReal.max],
    );
    const awsChart = useMemo(() => ({ history: [] as number[], min: 0, max: 1 }), []);
    const depthChart = useMemo(
        () =>
            depthReal.history.length > 5
                ? { history: depthReal.history, min: 0, max: Math.max(20, depthReal.max + 5) }
                : { history: [] as number[], min: 0, max: 1 },
        [depthReal.history, depthReal.max],
    );

    // TWS max tracker
    const [twsMax, setTwsMax] = useState<number>(0);
    useEffect(() => {
        if (state.tws.value !== null && state.tws.value > twsMax) {
            setTwsMax(state.tws.value);
        }
    }, [state.tws.value, twsMax]);
    const twsMaxDisplay: number | null = twsMax > 0 ? twsMax : null;

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
    const tripDisplay: number | null = tripDist > 0 ? tripDist : null;

    const handleBack = useCallback(() => {
        triggerHaptic('light');
        onBack();
    }, [onBack]);

    const isConnected = state.connectionStatus === 'connected';
    const metricIsAvailable = (metric: TimestampedMetric): boolean =>
        isConnected && metric.value !== null && metric.freshness !== 'dead';
    // Wind liveness now spans the apparent and direction metrics too — the
    // rose is dimmed as a whole, so a boat sending only MWV,R must still count
    // as having wind.
    const heelAvailable = metricIsAvailable(state.heel);
    // Port red, starboard green — the same convention as the nav lights, so it
    // reads without thinking. Dead-band the needle: an XDR that idles at 0.2°
    // would otherwise flip PORT/STBD every second and look broken.
    const heelSide = (heel.value ?? 0) < -0.3 ? 'PORT' : (heel.value ?? 0) > 0.3 ? 'STBD' : 'LEVEL';
    /* The rose wants 0-360 with 0 at the bow; the bus carries signed angles,
       negative to port. Normalising with ((d % 360) + 360) % 360 turns -45
       into 315, which is what puts the needle — and the red/green decision
       that rides on angle > 180 — on the correct side.

       TRUE prefers the signed TWA when the gateway sends it, and falls back
       to TWD minus heading, which is the same number the long way round.
       Without either there is nothing honest to draw, so it stays null and
       the rose shows its no-data face rather than a needle at zero. */
    const normaliseBowAngle = (deg: number | null): number | null =>
        deg === null || !Number.isFinite(deg) ? null : ((deg % 360) + 360) % 360;
    const roseApparentAngle = normaliseBowAngle(awa.value);
    const roseTrueAngle =
        normaliseBowAngle(twaSigned.value) ??
        (twd.value !== null && heading.value !== null ? normaliseBowAngle(twd.value - heading.value) : null);

    const windMetrics = [state.tws, state.twa, state.aws, state.awa, state.twd];
    const windAvailable = windMetrics.some(metricIsAvailable);
    const windStale =
        windAvailable && windMetrics.filter(metricIsAvailable).every((metric) => metric.freshness === 'stale');

    // A connected socket is not itself evidence that the numbers are live.
    // If any retained (3–10s) reading is stale, label the whole panel Stale;
    // dead readings are masked. This conservative roll-up prevents a stale
    // numeric value from sitting beneath a green "Live" claim.
    const panelMetrics = [
        state.tws,
        state.twa,
        state.stw,
        state.heading,
        state.depth,
        state.sog,
        state.cog,
        state.waterTemp,
        state.rpm,
        state.voltage,
        state.latitude,
        state.longitude,
        state.hdop,
        state.satellites,
    ].filter((metric) => metric.value !== null && metric.freshness !== 'dead');
    // A blank panel had four causes and one appearance. The diagnosis names
    // which one, because "nothing is showing" is the least actionable thing an
    // instrument can tell a skipper.
    const diagnosis = diagnosePanel({
        gatewayConfigured: NmeaListenerService.getSavedConfig() !== null,
        connectionStatus: state.connectionStatus,
        metrics: panelMetrics,
        secondsSinceConnect: connectedAt === null ? null : (nowMs - connectedAt) / 1000,
    });
    const panelStatus = diagnosis.label;
    const panelStatusDot =
        diagnosis.state === 'live'
            ? 'bg-emerald-400 animate-pulse'
            : diagnosis.state === 'stale'
              ? 'bg-amber-400'
              : diagnosis.actionable
                ? 'bg-rose-400'
                : 'bg-slate-500';

    // Which transducer is quiet while the rest of the boat reports? Naming it
    // turns "why is the wind rose empty" into a job on the boat rather than a
    // suspicion about the app.
    const [showDiagnosis, setShowDiagnosis] = useState(false);

    const quietInstruments = missingInstruments([
        { name: 'Wind', metrics: [state.tws, state.twa, state.aws, state.awa, state.twd] },
        { name: 'Depth', metrics: [state.depth] },
        { name: 'Heading', metrics: [state.heading] },
        { name: 'GPS', metrics: [state.latitude, state.longitude, state.sog] },
        { name: 'Water temp', metrics: [state.waterTemp] },
    ]);

    /* Only worth a tap when there is something to read. With everything
       reporting the chip stays a plain label, so the underline is a promise
       that there is detail behind it rather than decoration. */
    const hasDiagnosisDetail = Boolean(diagnosis.detail) || quietInstruments.length > 0;

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Instrument Panel"
                    onBack={handleBack}
                    action={
                        hasDiagnosisDetail ? (
                            <button
                                type="button"
                                onClick={() => setShowDiagnosis(true)}
                                aria-label={`Instrument status: ${panelStatus}. Show details`}
                                className="flex min-h-[44px] items-center gap-1.5 px-1"
                            >
                                <div className={`w-2 h-2 rounded-full ${panelStatusDot}`} />
                                <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400 underline underline-offset-2">
                                    {panelStatus}
                                </span>
                            </button>
                        ) : (
                            <div className="flex items-center gap-1.5">
                                <div className={`w-2 h-2 rounded-full ${panelStatusDot}`} />
                                <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                                    {panelStatus}
                                </span>
                            </div>
                        )
                    }
                />

                <ModalSheet
                    isOpen={showDiagnosis}
                    onClose={() => setShowDiagnosis(false)}
                    title="Instrument status"
                    maxWidth="max-w-md"
                >
                    <div className="space-y-3 px-1 pb-2">
                        {diagnosis.detail && (
                            <p className="text-sm leading-relaxed text-gray-300">{diagnosis.detail}</p>
                        )}
                        {quietInstruments.length > 0 && (
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3">
                                <p className="text-sm leading-relaxed text-gray-300">
                                    Not reporting: {quietInstruments.join(', ')}. The rest of the backbone is fine, so
                                    check the transducer or the gateway&apos;s sentence output — or the boat is ashore,
                                    in which case this is exactly what it should say.
                                </p>
                            </div>
                        )}
                    </div>
                </ModalSheet>

                {/* ═══ INSTRUMENT PANEL — one instrument per screen, snap-scrolled ═══
                    Rebuilt 2026-08-26 (Shane: "make the instruments page really
                    pop… scrolls up and down, but snaps to each instrument…
                    sail plans etc go to the bottom"). Each section owns the
                    viewport; the dot rail jumps. Serene Summer's sail-plan
                    brain renders only for her hull. */}
                <div className="relative flex-1 min-h-0">
                    <div
                        ref={scrollerRef}
                        onScroll={onPanelScroll}
                        className="h-full overflow-y-auto snap-y snap-mandatory no-scrollbar"
                    >
                        {/* ── SECTION: WIND ── */}
                        <section
                            className={`w-full h-full snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1 ${sectionPb}`}
                        >
                            {/* The diagnosis and the "not reporting" list used
                                to sit here as two stacked banners. On a
                                full-height snap panel they cost the wind roses
                                their bottom third — and with the boat on the
                                hard the transducers are SUPPOSED to be silent,
                                so the steady state was a permanent banner explaining
                                an expected condition (Shane 2026-08-28: "it is
                                pushing your beautiful wind rose below the
                                bottom of the screen").

                                It lives behind the header's status chip now:
                                the coloured dot still reports the state at a
                                glance, and tapping it opens the detail. Zero
                                layout cost, and nothing is hidden. */}
                            <SectionPlate title="Wind" />
                            {/* justify-between, not evenly: now the section
                                reserves the tab bar there is less free space
                                to spread, and evenly banked what was left into
                                one gap above the dial ("there is ample space at
                                the top"). Between pins the three blocks to top,
                                middle and bottom. */}
                            <div className="flex-1 min-h-0 flex flex-col items-center justify-between py-1">
                                {/* Three metrics down each side of the dial.
                                    A round gauge in a rectangular panel leaves
                                    two columns of dead space beside it, and the
                                    numbers that were pushed off the bottom fit
                                    there for free — so this costs no height at
                                    all, which is the whole reason it works
                                    (Shane 2026-08-28). Depth first: it is the
                                    one that runs you aground. */}
                                <div className="flex w-full items-center justify-center gap-2">
                                    <div className="flex w-[68px] shrink-0 flex-col gap-1.5">
                                        <FlankMetric
                                            label="Depth"
                                            value={depth.value}
                                            unit="m"
                                            digits={1}
                                            tone="text-cyan-300"
                                        />
                                        <FlankMetric
                                            label="SOG"
                                            value={sog.value}
                                            unit="kn"
                                            digits={1}
                                            tone="text-white"
                                        />
                                        <FlankMetric
                                            label="COG"
                                            value={cog.value}
                                            unit="°"
                                            digits={0}
                                            pad3
                                            tone="text-white"
                                        />
                                    </div>
                                    <div
                                        className="rounded-full p-[3px]"
                                        style={{
                                            background:
                                                'conic-gradient(from 220deg, #71717a, #27272a, #52525b, #18181b, #71717a, #3f3f46, #71717a)',
                                            boxShadow:
                                                '0 0 30px rgba(0,0,0,0.9), 0 8px 24px rgba(0,0,0,0.6), inset 0 0 1px rgba(255,255,255,0.4)',
                                        }}
                                    >
                                        <div
                                            className="rounded-full p-[2px]"
                                            style={{
                                                background:
                                                    'linear-gradient(135deg, #3f3f46 0%, #18181b 50%, #3f3f46 100%)',
                                            }}
                                        >
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
                                                {/* Capped against viewport HEIGHT, not just a
                                                device bucket. The wind panel carries four
                                                stacked blocks now — plate, this gauge, the
                                                stat row and the two roses — and a fixed px
                                                gauge simply took its size and pushed the
                                                roses off the bottom of a snap panel that
                                                cannot scroll (Shane 2026-08-28). min() makes
                                                the biggest element the one that yields. */}
                                                <div
                                                    style={{
                                                        width: `min(${heroGaugeSize}px, 19vh)`,
                                                        height: `min(${heroGaugeSize}px, 19vh)`,
                                                    }}
                                                >
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
                                                        isLive={tws.value !== null && tws.freshness === 'live'}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex w-[68px] shrink-0 flex-col gap-1.5">
                                        <FlankMetric
                                            label="HDG"
                                            value={heading.value}
                                            unit="°"
                                            digits={0}
                                            pad3
                                            tone="text-white"
                                        />
                                        <FlankMetric
                                            label="Helm"
                                            value={rudder.value}
                                            unit="°"
                                            digits={1}
                                            tone="text-amber-300"
                                        />
                                        <FlankMetric
                                            label="Heel"
                                            value={heel.value}
                                            unit="°"
                                            digits={1}
                                            tone="text-violet-300"
                                        />
                                    </div>
                                </div>
                                {/* The fix, directly under the dial. Everything
                                    else on this screen is relative — angles off
                                    the bow, speed through water, depth under the
                                    keel — and this is the one line that says
                                    where she actually is. Monospaced and tabular
                                    so the digits do not dance as she moves. */}
                                <div className="w-full text-center">
                                    <p className="text-[8px] font-black uppercase tracking-[0.2em] text-gray-500">
                                        Position
                                    </p>
                                    <p
                                        className={`font-mono text-[13px] font-black tabular-nums ${
                                            formatFix(latitude.value, longitude.value)
                                                ? 'text-emerald-300'
                                                : 'text-gray-600'
                                        }`}
                                    >
                                        {formatFix(latitude.value, longitude.value) ?? '— no fix —'}
                                    </p>
                                </div>
                                <div className="w-full grid grid-cols-3 gap-2 items-center">
                                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2 text-center">
                                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            AWS
                                        </p>
                                        <p className="text-xl font-black tabular-nums font-mono text-sky-300">
                                            {fmt(aws.value)}
                                            <span className="text-[9px] font-bold text-gray-500"> kts</span>
                                        </p>
                                    </div>
                                    <div className="rounded-xl bg-white/[0.04] border border-white/[0.08] p-2 text-center">
                                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            Max
                                        </p>
                                        <p className="text-xl font-black tabular-nums font-mono text-amber-400">
                                            {fmt(twsMaxDisplay)}
                                            <span className="text-[9px] font-bold text-gray-500"> kts</span>
                                        </p>
                                    </div>
                                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2 text-center">
                                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            Gust 10m
                                        </p>
                                        <p className="text-xl font-black tabular-nums font-mono text-white">
                                            {fmt(recentGust)}
                                            <span className="text-[9px] font-bold text-gray-500"> kts</span>
                                        </p>
                                    </div>
                                </div>
                                {/* Both roses on the one page (Shane 2026-08-28).
                                    APPARENT is bow-relative — what the sails are
                                    trimmed to — so it carries no heading and the
                                    ring is labelled in degrees off the bow. TRUE
                                    is handed the heading, so it draws the compass
                                    and prints a real bearing. That is exactly the
                                    pairing the handoff's own demo shows, and it
                                    means neither rose has to answer two questions.

                                    Distinct keys are mandatory, not tidy: every
                                    gradient id is namespaced with them, url(#id)
                                    resolves document-wide, and a collision here
                                    would paint the second rose with the first
                                    one's needle — the WRONG SIDE on opposite
                                    tacks. */}
                                <div className="grid w-full grid-cols-2 gap-2">
                                    <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-1.5">
                                        <SereneWindRose
                                            gaugeKey="glass-awa"
                                            angle={roseApparentAngle}
                                            speed={aws.value}
                                            unit="kn"
                                            isLive={windAvailable && !windStale}
                                            className="mx-auto block h-auto w-full"
                                            style={{ maxHeight: '19vh' }}
                                        />
                                        <p className="mt-0.5 text-center text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            Apparent
                                        </p>
                                    </div>
                                    <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-1.5">
                                        <SereneWindRose
                                            gaugeKey="glass-twa"
                                            angle={roseTrueAngle}
                                            speed={tws.value}
                                            unit="kn"
                                            heading={heading.value}
                                            isLive={windAvailable && !windStale}
                                            className="mx-auto block h-auto w-full"
                                            style={{ maxHeight: '19vh' }}
                                        />
                                        <p className="mt-0.5 text-center text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            True
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* ── SECTION: SPEED ── */}
                        <section
                            className={`w-full h-full snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1 ${sectionPb}`}
                        >
                            <SectionPlate title="Speed" />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                <div className="text-center">
                                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-gray-400">
                                        SOG
                                    </p>
                                    <p className="text-7xl font-black tabular-nums font-mono text-white leading-none">
                                        {fmt(sog.value)}
                                    </p>
                                    <p className="text-xs font-bold text-gray-500 mt-1">knots over ground</p>
                                    <div className="mt-3 mx-auto max-w-xs h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 transition-all duration-500"
                                            style={{ width: `${Math.min(100, ((sog.value ?? 0) / 20) * 100)}%` }}
                                        />
                                    </div>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2 text-center">
                                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            STW
                                        </p>
                                        <p className="text-xl font-black tabular-nums font-mono text-cyan-300">
                                            {fmt(stw.value)}
                                            <span className="text-[9px] font-bold text-gray-500"> kt</span>
                                        </p>
                                    </div>
                                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2 text-center">
                                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            Best
                                        </p>
                                        <p className="text-xl font-black tabular-nums font-mono text-emerald-300">
                                            {sogReal.history.length > 0 ? sogReal.max.toFixed(1) : '--'}
                                            <span className="text-[9px] font-bold text-gray-500"> kt</span>
                                        </p>
                                    </div>
                                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2 text-center">
                                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                            Trip
                                        </p>
                                        <p className="text-xl font-black tabular-nums font-mono text-white">
                                            {fmt(tripDisplay)}
                                            <span className="text-[9px] font-bold text-gray-500"> NM</span>
                                        </p>
                                    </div>
                                </div>
                                <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-3">
                                    <Sparkline
                                        history={sogChart.history}
                                        min={sogChart.min}
                                        max={sogChart.max}
                                        color="#d946ef"
                                        width={sparklineWidth * 2}
                                        height={sparklineHeight + 20}
                                        showAxes
                                        label="sog"
                                    />
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 text-center mt-0.5">
                                        Rolling Chart
                                    </p>
                                    <div className="mt-2 flex items-center justify-center gap-1.5 border-t border-white/[0.06] pt-1.5">
                                        <span className="text-[10px]">🔋</span>
                                        <span className="font-mono text-xs font-black tabular-nums text-white">
                                            {fmt(voltage.value)}
                                        </span>
                                        <span className="text-[10px] font-bold text-gray-500">V</span>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* ── SECTION: DEPTH ── */}
                        <section
                            className={`w-full h-full snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1 ${sectionPb}`}
                        >
                            <SectionPlate title="Depth" />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                <div className="text-center">
                                    <p className="text-7xl font-black tabular-nums font-mono text-white leading-none">
                                        {fmt(depth.value)}
                                        <span className="text-2xl text-gray-500"> m</span>
                                    </p>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mt-1">
                                        {nmeaDepthReferenceLabel(state.depthReference)}
                                    </p>
                                </div>
                                {/* Shoaling trend — least-squares over the last 6 min, from the
                                    serene brain: one wild sounding cannot set the trend, and a
                                    shoaling rate is translated into the number that matters —
                                    minutes until the keel meets the bottom. */}
                                <div
                                    className={`rounded-2xl border p-3 text-center ${
                                        depthTrend.level === 'critical'
                                            ? 'border-rose-500/40 bg-rose-500/[0.10]'
                                            : depthTrend.level === 'serious'
                                              ? 'border-orange-500/30 bg-orange-500/[0.08]'
                                              : depthTrend.level === 'warning'
                                                ? 'border-amber-500/25 bg-amber-500/[0.06]'
                                                : 'border-white/[0.06] bg-white/[0.03]'
                                    }`}
                                >
                                    <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                        {depthTrend.label}
                                    </p>
                                    <p className="text-lg font-black text-white">{depthTrend.text}</p>
                                    {depthTrend.note && <p className="text-[11px] text-gray-400">{depthTrend.note}</p>}
                                    <p className="mt-1 text-[10px] text-gray-500">
                                        Comfort line {COMFORT_M.toFixed(1)} m under the keel
                                    </p>
                                </div>
                                <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] p-3">
                                    <Sparkline
                                        history={depthChart.history}
                                        min={depthChart.min}
                                        max={depthChart.max}
                                        color="#22d3ee"
                                        width={sparklineWidth * 2}
                                        height={sparklineHeight + 20}
                                        showAxes
                                        axisUnit="m"
                                        label="depth"
                                    />
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 text-center mt-0.5">
                                        15 min chart
                                    </p>
                                </div>
                            </div>
                        </section>

                        {/* ── SECTION: HEADING ── */}
                        <section
                            className={`w-full h-full snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1 ${sectionPb}`}
                        >
                            <SectionPlate title="Heading" />
                            <div className="flex-1 min-h-0 flex flex-col items-center justify-evenly">
                                <div style={{ width: '80vw', maxWidth: '300px', aspectRatio: '1' }}>
                                    <HeroCompass
                                        value={heading.value}
                                        isLive={heading.value !== null && heading.freshness === 'live'}
                                    />
                                </div>
                                <p className="font-mono text-sm font-bold tabular-nums text-gray-300">
                                    {makingWay && cog.value !== null
                                        ? `COG ${Math.round(cog.value)}°`
                                        : 'COG — not making way'}
                                </p>
                                {heelAvailable && (
                                    <div className="flex items-baseline gap-2" aria-label="Heel angle">
                                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                                            Heel
                                        </span>
                                        <span className="font-mono text-2xl font-black tabular-nums text-white">
                                            {Math.abs(heel.value as number).toFixed(1)}°
                                        </span>
                                        <span
                                            className={`text-[10px] font-black uppercase tracking-wider ${
                                                heelSide === 'PORT'
                                                    ? 'text-rose-400'
                                                    : heelSide === 'STBD'
                                                      ? 'text-emerald-400'
                                                      : 'text-gray-500'
                                            }`}
                                        >
                                            {heelSide}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </section>

                        {/* ── SECTION: HELM ── */}
                        <section
                            className={`w-full h-full snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1 ${sectionPb}`}
                        >
                            <SectionPlate title="Helm" />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                {rudder.value !== null ? (
                                    <>
                                        {/* Rudder bar — port red left, starboard green right,
                                            nav-light convention. */}
                                        <div className="text-center">
                                            <p className="text-6xl font-black tabular-nums font-mono text-white leading-none">
                                                {Math.abs(rudder.value).toFixed(1)}°
                                                <span
                                                    className={`text-xl ml-2 ${
                                                        rudder.value < -0.3
                                                            ? 'text-rose-400'
                                                            : rudder.value > 0.3
                                                              ? 'text-emerald-400'
                                                              : 'text-gray-500'
                                                    }`}
                                                >
                                                    {rudder.value < -0.3 ? 'PORT' : rudder.value > 0.3 ? 'STBD' : 'MID'}
                                                </span>
                                            </p>
                                            <div className="mt-3 mx-auto max-w-xs relative h-3 rounded-full bg-white/[0.06] overflow-hidden">
                                                <div className="absolute inset-y-0 left-1/2 w-px bg-white/30" />
                                                <div
                                                    className={`absolute inset-y-0 ${rudder.value >= 0 ? 'left-1/2 bg-emerald-400/70' : 'right-1/2 bg-rose-400/70'}`}
                                                    style={{
                                                        width: `${Math.min(50, (Math.abs(rudder.value) / 40) * 50)}%`,
                                                    }}
                                                />
                                            </div>
                                        </div>
                                        {helm && helm.ok ? (
                                            <div
                                                className={`rounded-2xl border p-4 ${
                                                    helm.level === 'serious'
                                                        ? 'border-orange-500/30 bg-orange-500/[0.08]'
                                                        : helm.level === 'warning'
                                                          ? 'border-amber-500/25 bg-amber-500/[0.06]'
                                                          : 'border-emerald-500/20 bg-emerald-500/[0.05]'
                                                }`}
                                            >
                                                <p className="text-2xl font-black text-white">{helm.word}</p>
                                                <p className="mt-1 text-[13px] leading-relaxed text-gray-300">
                                                    {helm.what}
                                                </p>
                                                <p className="mt-2 rounded-xl bg-white/[0.05] p-2.5 text-[13px] leading-relaxed text-white">
                                                    {helm.fix}
                                                </p>
                                                <p className="mt-1 text-[10px] text-gray-500">
                                                    {helm.deg.toFixed(1)}° weather helm · {helm.tack} tack
                                                </p>
                                            </div>
                                        ) : helm && !helm.ok ? (
                                            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
                                                <p className="text-sm font-bold text-gray-300">
                                                    {helm.downwind ? 'No verdict off the wind' : 'No verdict yet'}
                                                </p>
                                                <p className="mt-1 text-[12px] leading-relaxed text-gray-400">
                                                    {helm.why}
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
                                                <p className="text-sm font-bold text-gray-300">Averaging the helm…</p>
                                                <p className="mt-1 text-[12px] text-gray-400">
                                                    The balance verdict needs 30 seconds of rudder history — an
                                                    instantaneous angle flickers with every wave.
                                                </p>
                                            </div>
                                        )}
                                        {helmWords && (
                                            <p className="text-center text-[11px] text-gray-500">
                                                45 s mean {helmWindow!.mean.toFixed(1)}° · {helmWords.word} —{' '}
                                                {helmWords.note}
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 text-center">
                                        <p className="text-4xl font-black text-gray-600">—</p>
                                        <p className="mt-2 text-sm font-bold text-gray-300">No rudder sensor</p>
                                        <p className="mt-1 text-[12px] leading-relaxed text-gray-400">
                                            Helm balance needs a rudder-angle sentence ($--RSA) on the NMEA bus. Nothing
                                            is shown rather than something invented.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </section>

                        {/* ── SECTION: SAIL PLAN (Serene Summer only — her rig, her advice) ── */}
                        {isSereneSummer && (
                            <section
                                className={`w-full h-full snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1 ${sectionPb}`}
                            >
                                <SectionPlate title="Sail Plan" />
                                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar space-y-2 pb-2">
                                    {plan ? (
                                        <>
                                            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4">
                                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">
                                                    {plan.band.band} · {Math.round(plan.off)}° off ·{' '}
                                                    {fmt(recentGust, 0)} kn gusts (10 min)
                                                </p>
                                                <p className="mt-1 text-xl font-black text-white">
                                                    {reefDescribe(plan.row, plan.row.main === 'Down').m}
                                                </p>
                                                <p className="text-[13px] text-gray-300">
                                                    {reefDescribe(plan.row, plan.row.main === 'Down').rest}
                                                </p>
                                                {(plan.row.stay === true || plan.row.stay === 'storm') && (
                                                    <p className="mt-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] p-2.5 text-[12px] font-semibold text-amber-200">
                                                        Runners on BEFORE the staysail loads the inner forestay.
                                                    </p>
                                                )}
                                                {plan.row.prevent && (
                                                    <p className="mt-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] p-2.5 text-[12px] font-semibold text-amber-200">
                                                        Preventer on — led aft, releasable under load.
                                                    </p>
                                                )}
                                                <p className="mt-2 text-[12px] leading-relaxed text-gray-400">
                                                    {plan.row.note}
                                                </p>
                                            </div>
                                            {plan.trim && (
                                                <details className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3">
                                                    <summary className="cursor-pointer text-[11px] font-black uppercase tracking-[0.2em] text-gray-400 [&::-webkit-details-marker]:hidden">
                                                        Where everything goes
                                                    </summary>
                                                    {/* The picture first, the prose under it. A
                                                        position is read from a diagram in one
                                                        glance and rebuilt from a sentence only
                                                        with effort — but the words carry the
                                                        seamanship the drawing cannot (why the
                                                        traveller is the one you play in a gust),
                                                        so they stay. Every mark in the diagram
                                                        comes from this same plan; if the two ever
                                                        disagree, the diagram is the bug. */}
                                                    <SailPlanDiagram
                                                        band={plan.band.band}
                                                        windAngle={roseTrueAngle}
                                                        main={plan.row.main}
                                                        yankee={plan.row.yankee}
                                                        stay={plan.row.stay}
                                                        runners={plan.row.runners}
                                                        prevent={plan.row.prevent}
                                                        className="mx-auto mt-2 block h-auto w-full max-w-[260px]"
                                                    />
                                                    {/* A reference, deliberately static: it reads
                                                        nothing from the boat, so it cannot be wrong
                                                        about the boat. The trim prose below leans on
                                                        these words — leech telltale, luff breathing,
                                                        the clew rising — and they are only useful if
                                                        you can point at them. */}
                                                    <details className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
                                                        <summary className="cursor-pointer text-[10px] font-black uppercase tracking-[0.18em] text-gray-500 [&::-webkit-details-marker]:hidden">
                                                            Parts of a sail
                                                        </summary>
                                                        <SailPartsDiagram className="mx-auto mt-2 block h-auto w-full max-w-[260px]" />
                                                    </details>
                                                    <div className="mt-2 space-y-2 text-[12px] leading-relaxed text-gray-300">
                                                        <p>
                                                            <b className="text-white">Traveller.</b>{' '}
                                                            {plan.trim.traveller}
                                                        </p>
                                                        <p>
                                                            <b className="text-white">Mainsheet.</b>{' '}
                                                            {plan.trim.mainsheet}
                                                        </p>
                                                        <p>
                                                            <b className="text-white">Yankee.</b> {plan.trim.yankee}
                                                        </p>
                                                        <p>
                                                            <b className="text-white">Staysail.</b> {plan.trim.staysail}
                                                        </p>
                                                    </div>
                                                </details>
                                            )}
                                            {kite && (
                                                <div
                                                    className={`rounded-2xl border p-3 ${
                                                        kite.ok
                                                            ? 'border-emerald-500/20 bg-emerald-500/[0.05]'
                                                            : 'border-white/[0.06] bg-white/[0.03]'
                                                    }`}
                                                >
                                                    <p className="text-[11px] font-black uppercase tracking-[0.2em] text-gray-400">
                                                        Asymmetric
                                                    </p>
                                                    <p className="mt-1 text-[12px] leading-relaxed text-gray-300">
                                                        {kite.why}
                                                    </p>
                                                    {kite.down && (
                                                        <p className="mt-1.5 text-[12px] leading-relaxed font-semibold text-amber-200">
                                                            {kite.down}
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 text-center">
                                            <p className="text-sm font-bold text-gray-300">No wind data yet</p>
                                            <p className="mt-1 text-[12px] text-gray-400">
                                                The sail plan reads true wind and ten minutes of gusts from the
                                                backbone.
                                            </p>
                                        </div>
                                    )}
                                    <p className="text-center text-[10px] text-gray-600">
                                        Tuned for Serene Summer — Tayana 55, in-boom furling, runners.
                                    </p>
                                </div>
                            </section>
                        )}
                    </div>

                    {/* Dot rail — one per section, current one lit. */}
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col gap-2.5 pr-0.5">
                        {sectionNames.map((name, index) => (
                            <button
                                key={name}
                                type="button"
                                aria-label={`Jump to ${name}`}
                                onClick={() => jumpToSection(index)}
                                className={`w-2 h-2 rounded-full transition-all ${
                                    index === activeSection ? 'bg-sky-400 scale-125' : 'bg-white/20'
                                }`}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
