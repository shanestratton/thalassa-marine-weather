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
import './instrumentDaylight.css';
import { CLOCK_MAX_WIDTH, POSITION_FONT_SIZE, WIND_CELL_STYLE, windHeroStyle } from './instrumentLayout';
import { useCrewInstrumentShare } from '../../hooks/useCrewInstrumentShare';
import { BarometerGauge } from './gauges/BarometerGauge';
import { ShipsBellClock } from './gauges/ShipsBellClock';
import { ShipsBellChime } from '../../services/ShipsBellChime';
import { myWatches, type MyWatch } from '../../services/myWatches';
import { MyWatchCard, type WatchLeadOption } from './gauges/MyWatchCard';
import { ShipsBellAlarmService, type BellAlarm } from '../../services/ShipsBellAlarmService';
import { clockInZone, deviceTimeZone } from '../../utils/timeZones';
import { SHIP_CLOCK_PREFS_EVENT, readShipClockPrefs } from '../../services/shipClockPrefs';
import { formatSeaTemp, formatSeaTempDelta, seaTempTrend } from './seaTemp';
import { bellsAt } from '../../utils/shipsBells';
import { HeadingGauge } from './gauges/HeadingGauge';
import { RudderGauge } from './gauges/RudderGauge';
import { useBarometerSource } from '../../hooks/useBarometerSource';
import { hpaToInHg, observedTendency, type TendencySeverity } from '../../utils/barometerTendency';
import * as barometerService from '../../services/native/barometer';
import { useNmeaStore } from './useNmeaStore';
import { SereneWindRose } from './gauges/SereneWindRose';
import { sideColour } from './sideColour';
import {
    isWindHeroId,
    TWS_ZONES,
    WIND_CAPTIONS,
    WIND_HERO_STORAGE_KEY,
    windBottomFor,
    zoneColorFor,
    type WindHeroId,
} from './windHeroSlots';
import { useUnwrappedAngle } from './gauges/useUnwrappedAngle';
import { describeArc, polarToCart } from './gauges/gaugeGeometry';
import { LightningBoltIcon } from '../Icons';
import { triggerHaptic } from '../../utils/system';
import { toast } from '../Toast';
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
    shoalRate,
    type SailingWind,
} from '../../services/sailing/sereneSailing';
import { useWeatherOptional } from '../../context/WeatherContext';
import { CloudTelemetryService } from '../../services/CloudTelemetryService';
import { WindHistoryStats } from './WindHistoryStats';
import { useViewportHeight } from '../../hooks/useViewportHeight';

/** Picker value meaning “wherever the boat is”. */
const SHIP_ZONE_AUTO = 'auto';

/**
 * The shortest viewport that keeps the header crumb. Every snap page is sized
 * from what the header leaves, and at 667 pt (iPhone SE / 8) the crumb's 28 pt
 * clipped the Wind page's APPARENT / TRUE rose labels and the Barometer's
 * 3 h / rate / record tiles. At 812 pt and up every page still fits with it.
 * The chevron keeps its name ('Back to NMEA Gateway') at every height.
 */
const CRUMB_MIN_VIEWPORT_PX = 740;

interface TheGlassPageProps {
    onBack: () => void;
    /** Where Back goes, in words ('Back to NMEA Gateway'); from the registry. */
    backLabel?: string;
    /** The crumb over the title, naming the same page Back goes to. */
    breadcrumbs?: string[];
}

// ── Format helper — shows "--" for null / non-finite values ──
// Used everywhere a numeric reading would otherwise render. Keeps
// the panel honest: if we don't have the data, we show "--" instead
// of fabricating a plausible-looking number. "--" is the panel's ONE
// no-data glyph (the min/max cells and formatSeaTemp use it too) —
// don't reintroduce "—" beside it (UX run 5 saw "— kts" next to "-- kts").
function fmt(val: number | null | undefined, decimals: number = 1): string {
    return val !== null && val !== undefined && Number.isFinite(val) ? val.toFixed(decimals) : '--';
}

/**
 * One readout as one spoken phrase — "Depth, no data", "Speed through water,
 * 6.2 knots". The visible label/value pair is aria-hidden beside it: read as
 * loose paragraphs it came out as "Depth" … "dash dash" with nothing tying
 * them together (UX scorecard run 6).
 */
function spokenReading(label: string, shown: string, unit: string): string {
    return shown === '--' || shown.trim() === '' ? `${label}, no data` : `${label}, ${shown} ${unit}`.trim();
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

const SparklineComponent: React.FC<SparklineProps> = ({
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
    const padX = showAxes ? 30 : 4;
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
        <svg width={width} height={height} className="nmea-instrument block">
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
                    <text x={2} y={padY + 10} fill="#94a3b8" fontSize="12" fontFamily="system-ui">
                        {Math.round(max)}
                        {axisUnit}
                    </text>
                    <text x={2} y={padY + chartH} fill="#94a3b8" fontSize="12" fontFamily="system-ui">
                        {Math.round(min)}
                        {axisUnit}
                    </text>
                </>
            )}
        </svg>
    );
};
const Sparkline = React.memo(SparklineComponent);

// (Synthetic-history dummy generator removed — sparklines now stay
//  empty when no real data has arrived. Sparkline component handles
//  the empty-history case by rendering a low-opacity placeholder.)

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
function formatCoord(v: number | null, pos: string, neg: string): string | null {
    if (v === null || !Number.isFinite(v)) return null;
    const a = Math.abs(v);
    const d = Math.floor(a);
    return `${d}°${((a - d) * 60).toFixed(3)}′${v >= 0 ? pos : neg}`;
}

/** The two halves, for the Position page that shows them on separate lines.
 *  Split out rather than reimplemented so one format serves both readouts —
 *  two formatters would eventually disagree by a decimal place, and a position
 *  that reads differently on two screens of the same app is a position you
 *  cannot trust. */
export const formatLatitude = (lat: number | null): string | null => formatCoord(lat, 'N', 'S');
export const formatLongitude = (lon: number | null): string | null => formatCoord(lon, 'E', 'W');

function formatFix(lat: number | null, lon: number | null): string | null {
    const a = formatLatitude(lat);
    const b = formatLongitude(lon);
    return a === null || b === null ? null : `${a}  ${b}`;
}

/** What the flank abbreviations are called out loud. */
const FLANK_SPOKEN: Record<string, string> = {
    SOG: 'Speed over ground',
    COG: 'Course over ground',
    HDG: 'Heading',
};
const FLANK_UNIT_SPOKEN: Record<string, string> = { m: 'metres', kts: 'knots', '°': 'degrees' };

const FlankMetricComponent: React.FC<{
    label: string;
    value: number | null;
    unit: string;
    digits?: number;
    /** Bearings read as three padded digits, the way they are written and
     *  spoken — and so a heading can never be misread as an angle. */
    pad3?: boolean;
    tone?: string;
    /**
     * Colour the reading by which SIDE it is on: red to port, green to
     * starboard, the same convention the wind rose uses (Shane 2026-08-30,
     * watching the helm sit at -30.2 while the yard antifouled around a rudder
     * hard over to port).
     *
     * The sign is taken from the DISPLAYED text, not the raw value, so the
     * colour can never contradict the number printed beside it — a rudder
     * reading 0.0 from a raw -0.04 is amidships on screen and must not be
     * painted red. Exactly zero is neither side, so it stays neutral.
     */
    sideColoured?: boolean;
}> = ({ label, value, unit, digits = 1, pad3 = false, tone = 'text-white', sideColoured = false }) => {
    const has = value !== null && Number.isFinite(value);
    const text = !has
        ? '--'
        : pad3
          ? Math.round(value as number)
                .toString()
                .padStart(3, '0')
          : (value as number).toFixed(digits);
    const shown = has ? Number(text) : null;
    const sideTone = sideColoured ? sideColour(shown) : null;
    /* The sign is redundant once the colour carries the side, and it costs a
       character of width in a 68px tile (Shane 2026-08-30: "now that we have
       red for port and green for starboard, could we remove the negative
       sign?"). Stripped only for a side-coloured tile, and only AFTER the
       colour has been decided from the signed value — otherwise every reading
       would be starboard green. */
    const display = sideColoured && shown !== null ? Math.abs(shown).toFixed(digits) : text;
    // The colour carries the side on screen; the reader has to hear it.
    const side = sideColoured && shown !== null && shown !== 0 ? (shown < 0 ? ' to port' : ' to starboard') : '';
    const spoken = spokenReading(
        FLANK_SPOKEN[label] ?? label,
        has ? `${display}${side}` : '--',
        has ? (FLANK_UNIT_SPOKEN[unit] ?? unit) : '',
    );
    return (
        <div className="rounded-lg border border-white/6 bg-white/3 px-1 py-1.5 text-center">
            <span className="sr-only">{spoken}</span>
            <p aria-hidden="true" className="text-[8px] font-black uppercase tracking-[0.14em] text-gray-500">
                {label}
            </p>
            <p
                aria-hidden="true"
                data-testid={`flank-${label.toLowerCase()}`}
                style={sideTone ? { color: `var(--nmea-${shown! < 0 ? 'port' : 'stbd'}, ${sideTone})` } : undefined}
                className={`font-mono text-[15px] font-black tabular-nums leading-tight ${has ? tone : 'text-gray-400'}`}
            >
                {display}
                {has && <span className="text-[8px] font-bold text-gray-500">{unit}</span>}
            </p>
        </div>
    );
};
const FlankMetric = React.memo(FlankMetricComponent);

/** One of the three small readouts under a page's hero number, spoken as one
 *  phrase ("Speed through water, no data"). */
const StatCell: React.FC<{
    label: string;
    spoken: string;
    value: string;
    unit: string;
    unitSpoken: string;
    tone: string;
}> = ({ label, spoken, value, unit, unitSpoken, tone }) => (
    <div className="rounded-xl bg-white/3 border border-white/6 p-2 text-center">
        <span className="sr-only">{spokenReading(spoken, value, unitSpoken)}</span>
        <p aria-hidden="true" className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
            {label}
        </p>
        <p aria-hidden="true" className={`text-xl font-black tabular-nums font-mono ${tone}`}>
            {value}
            <span className="text-[9px] font-bold text-gray-400"> {unit}</span>
        </p>
    </div>
);

// ── Wind panel: which instrument owns the hero bezel ──────────────────────────
/**
 * A long press on either bottom rose swaps it into the hero bezel and sends
 * the TWS dial down to the slot it vacated; the choice sticks across launches.
 * The slot arithmetic and the TWS bands live in ./windHeroSlots so they can be
 * tested without mounting the panel — this file owns only the gesture, the
 * storage and the rendering.
 */
const WIND_LONG_PRESS_MS = 500;

const WindSwapSlot: React.FC<{
    caption: string;
    onPromote: () => void;
    children: React.ReactNode;
}> = ({ caption, onPromote, children }) => {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [pressing, setPressing] = useState(false);

    const cancel = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        setPressing(false);
    }, []);

    const start = useCallback(() => {
        cancel();
        setPressing(true);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            setPressing(false);
            onPromote();
        }, WIND_LONG_PRESS_MS);
    }, [cancel, onPromote]);

    // A pending timer outliving the panel would fire into an unmounted tree.
    useEffect(() => cancel, [cancel]);

    return (
        <button
            type="button"
            onTouchStart={start}
            onTouchEnd={cancel}
            onTouchMove={cancel}
            onTouchCancel={cancel}
            onMouseDown={start}
            onMouseUp={cancel}
            onMouseLeave={cancel}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPromote();
                }
            }}
            onContextMenu={(e) => e.preventDefault()}
            aria-label={`${caption} — press and hold to move it to the main dial`}
            className={`w-full rounded-2xl border border-white/6 bg-white/3 p-1.5 transition-transform ${
                pressing ? 'scale-[0.97]' : ''
            }`}
        >
            {children}
            <p className="mt-0.5 text-center text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                {caption}
            </p>
        </button>
    );
};

// ── HeroArcGauge — compact 240° arc gauge with self-contained digital readout ──
interface HeroArcGaugeProps {
    value: number | null;
    min: number;
    max: number;
    unit: string;
    label: string;
    /** What a screen reader calls the dial ("True wind speed"); the drawn
     *  label is the abbreviation. */
    spokenName: string;
    /** The unit said aloud ("knots"). */
    spokenUnit: string;
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

/* Geometry comes from gaugeGeometry — the same helpers the barometer, the
   compass and the rudder draw from. This face used to carry its own
   byte-identical copy, which is how two dials end up disagreeing about where
   "up" is after one of them is tweaked. */

const HeroArcGaugeComponent: React.FC<HeroArcGaugeProps> = ({
    value,
    min,
    max,
    unit,
    label,
    spokenName,
    spokenUnit,
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

    // One sentence for the dial ("True wind speed, no data"); its tick labels
    // and drawn readout are hidden, or they read out as "0 10 20 30…" noise
    // (UX scorecard run 7).
    return (
        <svg
            viewBox="0 0 200 200"
            className="nmea-instrument w-full h-full"
            role="img"
            aria-label={spokenReading(spokenName, value === null ? '--' : value.toFixed(1), spokenUnit)}
        >
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
                d={describeArc(HERO_CX, HERO_CY, HERO_R, HERO_START, HERO_END)}
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
                        d={describeArc(HERO_CX, HERO_CY, HERO_R, zStart, zEnd)}
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
                    d={describeArc(HERO_CX, HERO_CY, HERO_R, HERO_START, needleAngle)}
                    fill="none"
                    stroke={accentColor}
                    strokeWidth="10"
                    strokeLinecap="round"
                    opacity={opacity * 0.85}
                    style={{ transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
                />
            )}

            {/* Tick marks */}
            <g opacity={opacity} aria-hidden="true">
                {ticks.map(({ val, isMajor }) => {
                    const frac = (val - min) / range;
                    const angle = HERO_START + frac * HERO_SWEEP;
                    const outerR = HERO_R + 8;
                    const innerR = isMajor ? HERO_R + 2 : HERO_R + 5;
                    const outer = polarToCart(HERO_CX, HERO_CY, outerR, angle);
                    const inner = polarToCart(HERO_CX, HERO_CY, innerR, angle);
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
                                    x={polarToCart(HERO_CX, HERO_CY, outerR + 6, angle).x}
                                    y={polarToCart(HERO_CX, HERO_CY, outerR + 6, angle).y}
                                    textAnchor="middle"
                                    dominantBaseline="central"
                                    fill="#94a3b8"
                                    fontSize="12"
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
                aria-hidden="true"
                x={HERO_CX}
                y={HERO_CY + 38}
                textAnchor="middle"
                fill="white"
                fontSize="34"
                fontWeight="900"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
                style={{ letterSpacing: '-1px' }}
            >
                {value === null ? '--' : value.toFixed(1)}
            </text>
            <text
                aria-hidden="true"
                x={HERO_CX}
                y={HERO_CY + 55}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize="12"
                fontWeight="700"
                fontFamily="system-ui, -apple-system, sans-serif"
                style={{ letterSpacing: '2px' }}
            >
                {unit.toUpperCase()} · {label}
            </text>
        </svg>
    );
};
const HeroArcGauge = React.memo(HeroArcGaugeComponent);

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
//    yet) and its freshness. Callers render via fmt() for the "--"
//    fallback. ──
function resolveMetric(metric: TimestampedMetric): { value: number | null; freshness: DataFreshness } {
    return { value: metric.freshness === 'dead' ? null : metric.value, freshness: metric.freshness };
}

// ── Section faceplate — the etched title strip each instrument sits under ──
/** Severity colours, shared by the pill and the 3-hour figure so a warning
 *  cannot appear in one and not the other. */
const BARO_SEVERITY: Record<TendencySeverity, { pill: string; text: string }> = {
    calm: { pill: 'border-white/12 bg-white/5 text-gray-200', text: 'text-white' },
    watch: { pill: 'border-amber-400/30 bg-amber-500/10 text-amber-300', text: 'text-amber-300' },
    warn: { pill: 'border-red-400/35 bg-red-500/12 text-red-300', text: 'text-red-300' },
};

/* Hoisted so the cell-sized instruments are handed the SAME style object on
   every tick — a fresh literal here defeats any memo below it. */
const ROSE_CELL_STYLE = WIND_CELL_STYLE;

/* `place` says where this page sits among the snap pages — "Clock · 1 of 9".
   Nothing on the opening Clock page said eight more lay below it, and the
   owner ruled out a swipe chevron (UX scorecard run 6). */
const SectionPlateComponent: React.FC<{ title: string; place?: string }> = ({ title, place }) => (
    <div className="flex items-center gap-3 py-1.5 shrink-0">
        <div aria-hidden="true" className="h-px flex-1 bg-linear-to-r from-transparent to-white/15" />
        {/* The app's eyebrow tracking (tracking-widest). At 0.35em the words
            read as spaced letters, 'C L O C K' (UX scorecard run 10); the
            hairlines either side keep the instrument feel. */}
        <h2 className="whitespace-nowrap text-xs font-black uppercase tracking-widest text-gray-400">
            {title}
            {place && <span className="font-bold"> · {place}</span>}
        </h2>
        <div aria-hidden="true" className="h-px flex-1 bg-linear-to-l from-transparent to-white/15" />
    </div>
);
/* The panel ticks once a second for the clock. Everything below re-renders
   identically on that tick unless it is told not to — memo keeps the second
   hand from redrawing every dial on the page. */
const SectionPlate = React.memo(SectionPlateComponent);

// ══════════════════════════════════════════════
// THE GLASS PAGE
// ══════════════════════════════════════════════

export const TheGlassPage: React.FC<TheGlassPageProps> = ({ onBack, backLabel, breadcrumbs }) => {
    const state = useNmeaStore();
    // Crew only: whether the skipper has shared the panel (invite-only, 2026-09-07).
    const crewShare = useCrewInstrumentShare();
    const deviceClass = useDeviceClass();
    // 0 (no DOM) reads as a tall phone, as the hook documents.
    const viewportHeight = useViewportHeight();
    const headerCrumbs = !viewportHeight || viewportHeight >= CRUMB_MIN_VIEWPORT_PX ? breadcrumbs : undefined;

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
    // (b) in Shane's order — a: the gateway socket, b: the cloud row the Pi
    // keeps, c: honestly nothing. The service feeds the same store and only
    // while this page is open.
    useEffect(() => {
        CloudTelemetryService.retain();
        return () => CloudTelemetryService.release();
    }, []);

    // How long the socket has been up, so "waiting" can become "no data" once
    // patience stops being the right answer.
    const [connectedAt, setConnectedAt] = useState<number | null>(null);
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        if (state.connectionStatus !== 'connected' && state.connectionStatus !== 'remote') {
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
    /* THE BAROMETER. Source is chosen for us (boat sensor beats phone — see
       hooks/useBarometerSource); the maths is the shared WMO banding the
       Glass barometer panel already uses, so the two can never disagree. */
    const baro = useBarometerSource(true);
    const baroUnit = barometerService.getUnit();
    const baroTendency = React.useMemo(
        () => observedTendency(baro.samples, Date.now()),
        // Recomputed when the record changes; the panel re-renders on the
        // store's own tick, so a clock dependency would only add churn.
        [baro.samples],
    );
    /* The SET HAND: what the glass read three hours ago. Taken from the same
       endpoint the tendency uses (current minus its own delta) rather than
       hunting the sample list again, so the hands and the number can never
       tell different stories. */
    const baroSetHand = React.useMemo(
        () => (baroTendency && baro.latest ? baro.latest.hpa - baroTendency.deltaHpa : null),
        [baroTendency, baro.latest],
    );

    /* Each snap section is exactly the scroller's height, and the scroller
       runs UNDER the translucent tab bar — so without this the bottom of
       every section sat behind the nav, which is what cut the wind roses off
       (Shane 2026-08-28: "the two bottom roses are not entirely on the
       screen"). Same 5.5rem clearance the rest of the app uses over that
       bar. */
    const sectionPb = 'pb-[calc(5.5rem+env(safe-area-inset-bottom))]';
    /* Every page but the last stops 24px above the tab bar, so the next
       plate's heading ("Wind · 2 of 9") peeks at the bottom edge: "1 of 9" was
       the only cue that more lay below, and the owner vetoed a chevron (UX
       scorecard run 7). The last page (Helm) stays full height with
       sectionPb, or snap could not bring its top to the top. The others end
       above the bar themselves and need no foot: the peeking plate's own top
       padding is the gap, so a page keeps within 1px of the height it had. */
    const sectionHeight = 'h-[calc(100%_-_var(--thalassa-tabbar-height)_-_24px)]';
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
    // arrived yet. Render sites use fmt() to show "--" in that case.
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
    const waterTemp = resolveMetric(state.waterTemp);
    // The 30-60s helm window the serene advice demands — null while it fills.
    const helmWindow = NmeaStore.helmWindow();

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

    // Recorded by the feed/Pi, not by this page. The Pi's preceding hour can
    // arrive on first open; direct gateways keep a bounded app-wide record.
    // Recompute on the clock too, so an old peak expires even during silence.
    const windHistory = NmeaStore.getWindHistory(nowMs);

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

    // ── This device's own watches, or none ──
    //
    // Empty for anyone not on the bill, and the section below is then not
    // mounted at all: "if there is no watch for this user, then nothing shows
    // and that page does not exist" (Shane 2026-09-04). Refreshed on a slow
    // timer because the skipper can reassign the bill mid-passage.
    const [myWatchList, setMyWatchList] = useState<MyWatch[]>([]);
    useEffect(() => {
        let alive = true;
        const load = async () => {
            const found = await myWatches();
            if (alive) setMyWatchList(found);
        };
        void load();
        const id = setInterval(() => void load(), 120_000);
        return () => {
            alive = false;
            clearInterval(id);
        };
    }, []);
    const hasMyWatch = myWatchList.length > 0;
    // The snap pages in render order, for each plate's "n of N". Watch mounts
    // only for a crew member on the bill, so the count follows it.
    const panelPages = [
        'Clock',
        ...(hasMyWatch ? ['Watch'] : []),
        'Wind',
        'Barometer',
        'Position',
        'Speed',
        'Depth',
        'Sea temp',
        'Heading',
        'Helm',
    ];
    const placeOf = (title: string) => `${panelPages.indexOf(title) + 1} of ${panelPages.length}`;

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
    const waterTempReal = useMetricHistory(state.waterTemp);
    const tempUnit = useSettingsStore((store) => (store.settings.units?.temp === 'F' ? 'F' : 'C'));
    const seaTrend = useMemo(() => seaTempTrend(waterTempReal.history, tempUnit), [waterTempReal.history, tempUnit]);

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

    // Trip distance accumulator (SOG × dt).
    //
    // Depends on lastUpdated, like the depth and gust trackers above, so EVERY
    // fix integrates — not just the ones where the speed happened to change.
    // With only `value` in the deps a boat holding a steady 6.0 kt accumulated
    // nothing for as long as it held it, and then, when the speed finally
    // moved, the whole silent stretch was integrated at the NEW speed. The
    // trapezoid (mean of previous and current speed) is what makes the sum
    // honest across a change (audit 2026-09-02).
    // ── The bulkhead clock ──
    // A second-by-second tick, because the sweep hand is half the point of a
    // clock like this. Cheap: one setState a second, and only this section
    // reads it.
    const [clockNow, setClockNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setClockNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);
    // Ship's time is the time where the BOAT is, not where the phone is
    // (Shane 2026-09-06: "that should work on the vessels location time rather
    // than the punters iphone time. unless of course, it cant be seen"). The
    // weather already resolves the boat's position (bus, Pi, her held fix) and
    // carries that place's zone, so 'auto' follows it and falls back to the
    // phone only while no position has been seen. A picked zone still wins.
    const [clockZone, setClockZone] = useState<string>(() => {
        try {
            return localStorage.getItem('thalassa_clock_zone') || SHIP_ZONE_AUTO;
        } catch {
            return SHIP_ZONE_AUTO;
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem('thalassa_clock_zone', clockZone);
        } catch {
            /* a clock that cannot remember its zone still keeps time */
        }
    }, [clockZone]);
    const shipZone = useWeatherOptional()?.weatherData?.timeZone ?? null;
    const effectiveZone = clockZone === SHIP_ZONE_AUTO ? (shipZone ?? deviceTimeZone()) : clockZone;
    const zoneClock = clockInZone(clockNow, effectiveZone);

    // ── The clock's voice ──
    //
    // Off by default, and remembered. A bulkhead clock that starts striking at
    // 0230 on the night someone installs it is a clock that gets turned off
    // for good, so this is opt-in.
    const [bellsOn, setBellsOn] = useState<boolean>(() => {
        try {
            return localStorage.getItem('thalassa_clock_bells') === 'on';
        } catch {
            return false;
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem('thalassa_clock_bells', bellsOn ? 'on' : 'off');
        } catch {
            /* private mode — the toggle still works for this session */
        }
    }, [bellsOn]);
    // The switches live in Settings → Preferences → Ship's clock since the
    // Bells page went (Shane 2026-09-09). Follow them while the panel is open.
    useEffect(() => {
        const onPrefs = () => {
            const prefs = readShipClockPrefs();
            setClockZone(prefs.zone);
            setBellsOn(prefs.bellsOn);
        };
        window.addEventListener(SHIP_CLOCK_PREFS_EVENT, onPrefs);
        return () => window.removeEventListener(SHIP_CLOCK_PREFS_EVENT, onPrefs);
    }, []);

    const lastStruckRef = useRef<string | null>(null);
    useEffect(() => {
        const slot = `${zoneClock.hour}:${zoneClock.minute < 30 ? '00' : '30'}`;
        const onTheHalfHour = zoneClock.minute % 30 === 0;
        if (!onTheHalfHour) return;
        if (lastStruckRef.current === slot) return;
        // Claimed even when silent, so turning the bells on mid-half-hour does
        // not immediately strike the one that has already passed.
        lastStruckRef.current = slot;
        if (!bellsOn) return;
        ShipsBellChime.strike(bellsAt(zoneClock.hour, zoneClock.minute));
    }, [zoneClock.hour, zoneClock.minute, bellsOn]);
    const [bellAlarms, setBellAlarms] = useState<BellAlarm[]>([]);

    const armedLeads = useMemo(
        () => new Set(bellAlarms.filter((a) => a.label.startsWith('Watch:')).map((a) => Number(a.label.split('·')[1]))),
        [bellAlarms],
    );
    const handleWakeForWatch = useCallback(async (lead: WatchLeadOption, watch: MyWatch) => {
        const at = new Date(watch.startsAt.getTime() - lead.minutes * 60_000);
        if (at.getTime() <= Date.now()) {
            toast.error('That moment has already passed — try a shorter lead time.');
            return;
        }
        const set = await ShipsBellAlarmService.schedule(at, `Watch: ${watch.label} ·${lead.minutes}`);
        if (!set) {
            toast.error('Could not set that alarm — check notifications are allowed.');
            return;
        }
        setBellAlarms(await ShipsBellAlarmService.list());
        toast.success(
            `${watch.label} — you will be woken ${lead.minutes === 0 ? 'on watch' : `${lead.minutes} min before`}.`,
        );
    }, []);

    useEffect(() => {
        void ShipsBellAlarmService.list().then(setBellAlarms);
    }, []);

    /**
     * The times a skipper actually asks for: the next bell, and the next two
     * watch changes. Computed in the DEVICE's clock, not the displayed zone —
     * the phone's alarm fires on the phone's own time, and an alarm that fires
     * an hour out because the face was showing UTC would be the worst bug this
     * page could have.
     */
    const handleCancelBellAlarm = useCallback(async (id: number) => {
        await ShipsBellAlarmService.cancel(id);
        setBellAlarms(await ShipsBellAlarmService.list());
    }, []);

    const [tripDist, setTripDist] = useState<number>(0);
    const lastSogTime = useRef<number>(0);
    const lastSogValue = useRef<number | null>(null);
    useEffect(() => {
        if (state.sog.value !== null && state.sog.freshness === 'live') {
            const now = Date.now();
            const sog = state.sog.value;
            if (lastSogTime.current > 0 && lastSogValue.current !== null) {
                const dtHours = (now - lastSogTime.current) / 3_600_000;
                const meanSog = (lastSogValue.current + sog) / 2;
                setTripDist((prev) => prev + meanSog * dtHours);
            }
            lastSogTime.current = now;
            lastSogValue.current = sog;
        }
    }, [state.sog.value, state.sog.freshness, state.sog.lastUpdated]);
    const tripDisplay: number | null = tripDist > 0 ? tripDist : null;

    const handleBack = useCallback(() => {
        triggerHaptic('light');
        onBack();
    }, [onBack]);

    const isConnected = state.connectionStatus === 'connected' || state.connectionStatus === 'remote';
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

    /* Which instrument owns the hero bezel on the Wind panel. Read once from
       storage so the panel opens the way it was left; a private-mode throw
       just means the swap lasts the session. */
    const [windHero, setWindHero] = useState<WindHeroId>(() => {
        try {
            const saved = localStorage.getItem(WIND_HERO_STORAGE_KEY);
            return isWindHeroId(saved) ? saved : 'tws';
        } catch {
            return 'tws';
        }
    });

    const promoteWindHero = useCallback((id: WindHeroId) => {
        setWindHero(id);
        try {
            localStorage.setItem(WIND_HERO_STORAGE_KEY, id);
        } catch {
            /* private mode — the swap still holds for this session */
        }
    }, []);

    /* Derived, never stored: whichever rose went up, the dial drops into the
       slot it left. Deriving is what guarantees all three instruments appear
       exactly once. */
    const windBottom = useMemo<WindHeroId[]>(() => windBottomFor(windHero), [windHero]);

    /* One renderer for both slots so an instrument carries identical data
       wherever it sits — only its sizing changes.

       gaugeKey stays bound to the INSTRUMENT, never to the slot. Every
       gradient id inside the rose is namespaced with it and url(#id) resolves
       document-wide, so a key that moved with the slot would let the two roses
       collide on a swap and paint one with the other's needle — the wrong side
       on opposite tacks. That is the exact failure the rose's own header
       warns about. */
    const renderWindInstrument = (id: WindHeroId, variant: 'hero' | 'cell') => {
        const roseClass = variant === 'hero' ? 'block h-full w-full' : 'mx-auto block h-auto w-full';
        const roseStyle = variant === 'hero' ? undefined : ROSE_CELL_STYLE;

        if (id === 'awa') {
            return (
                <SereneWindRose
                    gaugeKey="glass-awa"
                    angle={roseApparentAngle}
                    speed={aws.value}
                    unit="kts"
                    isLive={windAvailable && !windStale}
                    className={roseClass}
                    style={roseStyle}
                />
            );
        }
        if (id === 'twa') {
            return (
                <SereneWindRose
                    gaugeKey="glass-twa"
                    angle={roseTrueAngle}
                    speed={tws.value}
                    unit="kts"
                    heading={heading.value}
                    isLive={windAvailable && !windStale}
                    className={roseClass}
                    style={roseStyle}
                />
            );
        }
        /* The dial is square by construction (a 200x200 viewBox), so in a
           bottom cell it needs a square box to sit in — the roses get their
           height from their own aspect ratio, the dial does not. */
        const dial = (
            <HeroArcGauge
                value={tws.value}
                min={0}
                max={60}
                unit="kts"
                label="TWS"
                spokenName="True wind speed"
                spokenUnit="knots"
                accentColor={zoneColorFor(tws.value, TWS_ZONES, '#22c55e')}
                zones={TWS_ZONES}
                majorTick={10}
                isLive={tws.value !== null && tws.freshness === 'live'}
            />
        );
        return variant === 'hero' ? (
            dial
        ) : (
            <div className="mx-auto aspect-square w-full" style={ROSE_CELL_STYLE}>
                {dial}
            </div>
        );
    };

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
        crewShare,
        remote: state.remote
            ? {
                  source: state.remote.source,
                  deviceLabel: state.remote.deviceLabel,
                  via: state.remote.via,
                  ageSeconds: (nowMs - state.remote.reportedAt) / 1000,
              }
            : null,
    });
    const panelStatus = diagnosis.label;
    // No gateway ever set up is how a phone-only skipper uses the app, not a
    // fault: neutral grey, the same 'No gateway' the NMEA Gateway page shows.
    // Red stays for a configured gateway that has dropped (UX scorecard run 7).
    const panelAlarm = diagnosis.actionable && diagnosis.state !== 'no-gateway';
    const panelStatusDot =
        diagnosis.state === 'live'
            ? 'bg-emerald-400 animate-pulse'
            : diagnosis.state === 'remote'
              ? 'bg-sky-400 animate-pulse'
              : diagnosis.state === 'stale'
                ? 'bg-amber-400'
                : panelAlarm
                  ? 'bg-rose-400'
                  : 'bg-slate-500';
    // The same bordered pill Radio Console and Anchor Watch use for their fix
    // state (UX run 5: this was the one page showing it as underlined text).
    // The red pill by day: opaque red-50 with red-800 text, not red-700 on a
    // tint that measured 4.55:1 (UX scorecard run 7).
    const panelStatusPill =
        diagnosis.state === 'live'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : diagnosis.state === 'remote'
              ? 'bg-sky-500/10 border-sky-500/30 text-sky-400'
              : diagnosis.state === 'stale'
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                : panelAlarm
                  ? 'bg-red-500/10 border-red-500/30 text-red-400 [.display-light_&]:bg-red-50! [.display-light_&]:text-red-800!'
                  : 'bg-white/5 border-white/15 text-gray-400';

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
       reporting the chip stays a plain pill, so the chevron is a promise
       that there is detail behind it rather than decoration. */
    const hasDiagnosisDetail = Boolean(diagnosis.detail) || quietInstruments.length > 0;

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                <PageHeader
                    title="Instrument Panel"
                    onBack={handleBack}
                    // The crumb and the chevron's name, like every sibling
                    // sub-page: it was the one bare 'Go back' (UX scorecard run
                    // 10). The crumb yields on short screens (CRUMB_MIN_VIEWPORT_PX).
                    backLabel={backLabel}
                    breadcrumbs={headerCrumbs}
                    // Status lives on PageHeader's row under the title, like
                    // Anchor Watch and Radio: in the action slot the pill
                    // squeezed INSTRUMENT PANEL onto two lines at 375-393 pt.
                    status={
                        hasDiagnosisDetail ? (
                            // A 44 pt tall button around the pill; the negative
                            // margin keeps the row pill-height so the header does
                            // not grow. The chevron, not an underline, says there
                            // is detail behind it.
                            <button
                                type="button"
                                onClick={() => setShowDiagnosis(true)}
                                aria-label={`Instrument status: ${panelStatus}. Show details`}
                                className="-my-[9px] flex min-h-[44px] items-center"
                            >
                                <span
                                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-extrabold uppercase tracking-widest ${panelStatusPill}`}
                                >
                                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${panelStatusDot}`} />
                                    {panelStatus}
                                    <svg
                                        aria-hidden="true"
                                        className="h-3 w-3 shrink-0"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M8.25 4.5l7.5 7.5-7.5 7.5"
                                        />
                                    </svg>
                                </span>
                            </button>
                        ) : (
                            <span
                                role="status"
                                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-extrabold uppercase tracking-widest ${panelStatusPill}`}
                            >
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${panelStatusDot}`} />
                                {panelStatus}
                            </span>
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
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/6 p-3">
                                <p className="text-sm leading-relaxed text-gray-300">
                                    Not reporting: {quietInstruments.join(', ')}. The rest of the backbone is fine, so
                                    check the transducer or the gateway&apos;s sentence output — or the boat is ashore,
                                    in which case this is exactly what it should say.
                                </p>
                            </div>
                        )}
                        <div className="rounded-xl border border-white/10 bg-white/4 p-3">
                            <p className="text-sm font-bold text-white">Recorded wind</p>
                            <p className="mt-1 text-sm leading-relaxed text-gray-300">
                                Max is the highest recorded true wind in the preceding hour. Gust is the highest sampled
                                true wind in the preceding ten minutes, not a separate gust sensor. Recording does not
                                depend on leaving this screen open.
                            </p>
                            <p className="mt-2 text-sm leading-relaxed text-gray-300">
                                {windHistory
                                    ? `${windHistory.sampleCount} readings in the available record, spanning ${Math.max(0, Math.floor((windHistory.latestAt - windHistory.since) / 60_000))} minutes. Gaps or a newly started recorder mean the record may cover less than a full hour.`
                                    : 'No recent wind history is available yet. Missing readings are not treated as calm wind.'}
                            </p>
                        </div>
                    </div>
                </ModalSheet>

                {/* ═══ INSTRUMENT PANEL — one instrument per screen, snap-scrolled ═══
                    Rebuilt 2026-08-26 (Shane: "make the instruments page really
                    pop… scrolls up and down, but snaps to each instrument"). Each section owns the
                    viewport; the punter scrolls. The dot rail down the right
                    went on 2026-09-09 (Shane: "not necessary as a punter will
                    keep scrolling until he gets to the end"). */}
                <div className="relative flex-1 min-h-0">
                    <div className="h-full overflow-y-auto snap-y snap-mandatory no-scrollbar">
                        {/* ── SECTION: CLOCK ──
                            FIRST in the panel, and the face has this page to
                            itself (Shane 2026-09-04: "we need the watches, and
                            bells underneath to be all on one page… i am
                            thinking the former and make the clock so that it
                            fits the entire width of the screen… then all of
                            this needs to be first in the instrument panel").

                            The bulkhead clock, and the only thing on this page
                            that is not an instrument reading the boat. It reads
                            the PHONE, which is the one clock aboard that is
                            never wrong, and it says which zone it is keeping —
                            a boat crosses them, and ship's time is a choice
                            somebody made rather than a fact.

                            Shane 2026-09-03: "build a beautiful chelsea ships
                            bell clock… the whole works." */}
                        <section
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                        >
                            <SectionPlate title="Clock" place={placeOf('Clock')} />
                            {/* Centred in whatever is left after the plate, so
                                the face is as big as the screen allows and no
                                bigger. Nothing else on this page competes. */}
                            <div className="flex-1 min-h-0 flex items-center justify-center pb-2 [container-type:size]">
                                <ShipsBellClock
                                    hour={zoneClock.hour}
                                    minute={zoneClock.minute}
                                    second={zoneClock.second}
                                    zoneLabel={zoneClock.label}
                                    // The bells and watch now sit under the face,
                                    // so the face yields their height (~3.5rem).
                                    faceMaxWidth={`min(${CLOCK_MAX_WIDTH}, calc(100cqh - 3.5rem))`}
                                />
                            </div>
                        </section>

                        {/* ── SECTION: WATCH ──
                            EXISTS ONLY IF THE PUNTER HAS A WATCH. Not an empty
                            state, not a "no watches assigned" card — the
                            section is not mounted and nothing points at it
                            (Shane 2026-09-04: "if there is no watch
                            for this user, then nothing shows and that page does
                            not exist").

                            The watch itself comes from the passage planner's
                            watch bill — the same watch_assignments rows the
                            skipper filled in and the same email match
                            WatchAlarmService uses, so the page and the alarm
                            can never disagree about whose watch it is. */}
                        {hasMyWatch && (
                            <section
                                className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                            >
                                <SectionPlate title="Watch" place={placeOf('Watch')} />
                                <div className="flex-1 min-h-0 overflow-y-auto pb-2">
                                    <MyWatchCard
                                        watches={myWatchList}
                                        now={clockNow}
                                        armedLeads={armedLeads}
                                        onWake={(lead, watch) => void handleWakeForWatch(lead, watch)}
                                    />
                                    {bellAlarms.length > 0 && (
                                        <ul className="mt-3 space-y-1.5">
                                            {bellAlarms.map((a) => (
                                                <li
                                                    key={a.id}
                                                    className="flex items-center justify-between gap-2 rounded-xl bg-white/4 px-3 py-2"
                                                >
                                                    <span className="truncate text-sm text-white">
                                                        {a.label.split(' ·')[0]} ·{' '}
                                                        {new Date(a.at).toLocaleTimeString([], {
                                                            hour: '2-digit',
                                                            minute: '2-digit',
                                                        })}
                                                    </span>
                                                    <button
                                                        onClick={() => void handleCancelBellAlarm(a.id)}
                                                        aria-label={`Cancel the ${a.label} alarm`}
                                                        className="min-h-[44px] shrink-0 px-3 text-sm font-bold text-rose-300"
                                                    >
                                                        Cancel
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </section>
                        )}

                        {/* ── SECTION: WIND ── */}
                        <section
                            // Short screens: the three gauges take 16% of the
                            // height, not 19%, or the rose captions ran off the
                            // foot at 375×667 (UX scorecard run 7).
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1 [@media(max-height:700px)]:[--wind-gauge-share:0.16]`}
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
                            <SectionPlate title="Wind" place={placeOf('Wind')} />
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
                                            unit="kts"
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
                                        className="nmea-wind-bezel rounded-full p-[3px]"
                                        style={{
                                            background:
                                                'conic-gradient(from 220deg, #71717a, #27272a, #52525b, #18181b, #71717a, #3f3f46, #71717a)',
                                            boxShadow:
                                                '0 0 30px rgba(0,0,0,0.9), 0 8px 24px rgba(0,0,0,0.6), inset 0 0 1px rgba(255,255,255,0.4)',
                                        }}
                                    >
                                        <div
                                            className="nmea-wind-rim rounded-full p-[2px]"
                                            style={{
                                                background:
                                                    'linear-gradient(135deg, #3f3f46 0%, #18181b 50%, #3f3f46 100%)',
                                            }}
                                        >
                                            <div
                                                className="nmea-wind-face rounded-full p-2"
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
                                                <div className="relative" style={windHeroStyle(heroGaugeSize)}>
                                                    {renderWindInstrument(windHero, 'hero')}
                                                    {/* Only a promoted ROSE needs naming — the dial
                                                        prints its own "TWS" inside its SVG. Absolutely
                                                        positioned so it costs no layout height: this
                                                        panel cannot scroll, and anything that adds
                                                        height here pushes the bottom roses off the
                                                        screen (Shane 2026-08-28). */}
                                                    {windHero !== 'tws' && (
                                                        <p className="pointer-events-none absolute inset-x-0 bottom-0 text-center text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                                            {WIND_CAPTIONS[windHero]}
                                                        </p>
                                                    )}
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
                                            sideColoured
                                        />
                                        <FlankMetric label="Heel" value={heel.value} unit="°" digits={1} sideColoured />
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
                                                : 'text-gray-400'
                                        }`}
                                    >
                                        {formatFix(latitude.value, longitude.value) ?? '— no fix —'}
                                    </p>
                                </div>
                                <WindHistoryStats
                                    apparentWind={aws.value}
                                    history={windHistory}
                                    onShowDetails={() => setShowDiagnosis(true)}
                                />
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
                                    {windBottom.map((id) => (
                                        <WindSwapSlot
                                            key={id}
                                            caption={WIND_CAPTIONS[id]}
                                            onPromote={() => promoteWindHero(id)}
                                        >
                                            {renderWindInstrument(id, 'cell')}
                                        </WindSwapSlot>
                                    ))}
                                </div>
                            </div>
                        </section>

                        {/* ── SECTION: BAROMETER ──
                            Sits after the instruments and before the advice,
                            because that is the order a skipper reads them in:
                            what the boat is doing, what the sky is doing, then
                            what to do about it.

                            The number is the least of it. A barometer forecasts
                            through its TENDENCY, so the three-hour trend, its
                            rate band and the plain sentence under it are the
                            content — and the source line is not decoration
                            either: a phone that has been up and down the
                            companionway has invented most of its own trend. */}
                        <section
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                        >
                            <SectionPlate title="Barometer" place={placeOf('Barometer')} />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                <div className="text-center">
                                    <BarometerGauge
                                        hpa={baro.latest?.hpa ?? null}
                                        setHandHpa={baroSetHand}
                                        severity={baroTendency?.severity ?? 'calm'}
                                        readout={
                                            baro.latest
                                                ? baroUnit === 'inHg'
                                                    ? hpaToInHg(baro.latest.hpa).toFixed(2)
                                                    : baro.latest.hpa.toFixed(1)
                                                : '--'
                                        }
                                        readoutUnit={baroUnit === 'inHg' ? 'inHg' : 'hPa'}
                                    />
                                    {/* Not rendered empty: with no source and no set hand
                                        it was a blank paragraph under the dial for
                                        VoiceOver to stop on (UX scorecard run 9). */}
                                    {(baro.source === 'boat' || baro.source === 'phone' || baroSetHand !== null) && (
                                        <p className="text-[10px] font-bold text-gray-500">
                                            {baro.source === 'boat' && 'Boat sensor'}
                                            {baro.source === 'phone' && 'This device'}
                                            {baroSetHand !== null && ' · pale hand = 3 h ago'}
                                        </p>
                                    )}
                                    {baroTendency && (
                                        <div
                                            className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 ${BARO_SEVERITY[baroTendency.severity].pill}`}
                                        >
                                            <span aria-hidden="true" className="text-sm leading-none">
                                                {baroTendency.direction === 'rising'
                                                    ? '▲'
                                                    : baroTendency.direction === 'falling'
                                                      ? '▼'
                                                      : '▬'}
                                            </span>
                                            <span className="text-xs font-black uppercase tracking-wider">
                                                {baroTendency.label}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {/* The sentence a skipper can act on, straight from
                                    the shared tendency brain — never re-worded here,
                                    so the Glass panel and this page cannot drift. */}
                                <p className="px-2 text-center text-xs font-medium leading-relaxed text-gray-300">
                                    {baroTendency
                                        ? baroTendency.read
                                        : (baro.reason ??
                                          'Building a record — a barometer needs three hours before it can say anything.')}
                                </p>

                                <div className="grid grid-cols-3 gap-2">
                                    <StatCell
                                        label="3 h"
                                        spoken="Three-hour change"
                                        value={
                                            baroTendency
                                                ? `${baroTendency.deltaHpa >= 0 ? '+' : ''}${baroTendency.deltaHpa.toFixed(1)}`
                                                : '--'
                                        }
                                        unit="hPa"
                                        unitSpoken="hectopascals"
                                        tone={baroTendency ? BARO_SEVERITY[baroTendency.severity].text : 'text-white'}
                                    />
                                    <StatCell
                                        label="Rate"
                                        spoken="Rate"
                                        value={baroTendency ? baroTendency.perHour.toFixed(1) : '--'}
                                        unit="/h"
                                        unitSpoken="hectopascals per hour"
                                        tone="text-cyan-300"
                                    />
                                    <StatCell
                                        label="Record"
                                        spoken="Record length"
                                        value={
                                            baro.samples.length > 1
                                                ? (
                                                      (baro.samples[baro.samples.length - 1].t - baro.samples[0].t) /
                                                      3_600_000
                                                  ).toFixed(1)
                                                : '--'
                                        }
                                        unit="h"
                                        unitSpoken="hours"
                                        tone="text-white"
                                    />
                                </div>

                                {baro.source === 'phone' && (
                                    <p className="px-3 text-center text-[10px] font-medium leading-snug text-amber-300/80">
                                        This device&apos;s barometer. Carrying it up or down changes the reading — the
                                        boat&apos;s sensor is steadier.
                                    </p>
                                )}
                            </div>
                        </section>

                        {/* ── SECTION: POSITION ── */}
                        {/* A page that does one thing (Shane 2026-08-30). The fix
                            already appears under the wind dial, but small, beside
                            four other numbers — and where she actually is deserves
                            a screen of its own, big enough to read across a cockpit
                            and to copy onto a chart or read over the radio without
                            squinting. Second panel so it is one swipe from Wind.

                            Degrees and decimal minutes to three places, from the
                            same formatter the small readout uses — a position that
                            reads differently on two screens of one app is a
                            position you cannot trust.

                            The no-fix state is a dash, never zeros. 0°0.000′N is a
                            real place in the Gulf of Guinea, and a confident green
                            reading of it is the worst thing this page could do. */}
                        <section
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                        >
                            <SectionPlate title="Position" place={placeOf('Position')} />
                            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-7">
                                {formatFix(latitude.value, longitude.value) ? (
                                    <>
                                        {(
                                            [
                                                ['Latitude', formatLatitude(latitude.value)],
                                                ['Longitude', formatLongitude(longitude.value)],
                                            ] as const
                                        ).map(([label, text]) => (
                                            <div key={label} className="w-full text-center">
                                                <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-gray-500">
                                                    {label}
                                                </p>
                                                <p
                                                    data-testid={`position-${label.toLowerCase()}`}
                                                    className="font-mono font-black tabular-nums leading-none text-emerald-400"
                                                    style={{
                                                        /* Scales with the screen but capped, because the
                                                           longest string here is 11 monospace characters
                                                           and this section cannot scroll — an overflowing
                                                           longitude would simply be cut off. */
                                                        fontSize: POSITION_FONT_SIZE,
                                                        textShadow:
                                                            'var(--nmea-position-shadow, 0 0 30px rgba(52, 211, 153, 0.35))',
                                                    }}
                                                >
                                                    {text}
                                                </p>
                                            </div>
                                        ))}
                                        {latitude.freshness !== 'live' && (
                                            <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">
                                                Last known — not live
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <p className="font-mono text-2xl font-black tabular-nums text-gray-400">
                                        — no fix —
                                    </p>
                                )}
                            </div>
                        </section>

                        {/* ── SECTION: SPEED ── */}
                        <section
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                        >
                            <SectionPlate title="Speed" place={placeOf('Speed')} />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                <div className="text-center">
                                    <span className="sr-only">
                                        {spokenReading('Speed over ground', fmt(sog.value), 'knots')}
                                    </span>
                                    <p
                                        aria-hidden="true"
                                        className="text-[10px] font-black uppercase tracking-widest text-gray-400"
                                    >
                                        SOG
                                    </p>
                                    <p
                                        aria-hidden="true"
                                        className="text-7xl font-black tabular-nums font-mono text-white leading-none"
                                    >
                                        {fmt(sog.value)}
                                    </p>
                                    <p aria-hidden="true" className="text-xs font-bold text-gray-400 mt-1">
                                        knots over ground
                                    </p>
                                    <div className="mt-3 mx-auto max-w-xs h-1.5 rounded-full bg-white/6 overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-linear-to-r from-purple-500 via-fuchsia-500 to-pink-500 transition-all duration-500"
                                            style={{ width: `${Math.min(100, ((sog.value ?? 0) / 20) * 100)}%` }}
                                        />
                                    </div>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <StatCell
                                        label="STW"
                                        spoken="Speed through water"
                                        value={fmt(stw.value)}
                                        unit="kts"
                                        unitSpoken="knots"
                                        tone="text-cyan-300"
                                    />
                                    <StatCell
                                        label="Best"
                                        spoken="Best speed"
                                        value={sogReal.history.length > 0 ? sogReal.max.toFixed(1) : '--'}
                                        unit="kts"
                                        unitSpoken="knots"
                                        tone="text-emerald-300"
                                    />
                                    <StatCell
                                        label="Trip"
                                        spoken="Trip"
                                        value={fmt(tripDisplay)}
                                        unit="NM"
                                        unitSpoken="nautical miles"
                                        tone="text-white"
                                    />
                                </div>
                                <div className="rounded-2xl bg-white/3 border border-white/6 p-3">
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
                                    <div className="mt-2 flex items-center justify-center gap-1.5 border-t border-white/6 pt-1.5">
                                        {/* Named in words: VoiceOver read a bare '-- V'
                                            with nothing to say what it was (UX scorecard run 9). */}
                                        <span className="sr-only">
                                            {spokenReading('Battery voltage', fmt(voltage.value), 'volts')}
                                        </span>
                                        <LightningBoltIcon className="h-3.5 w-3.5 text-gray-400" />
                                        <span
                                            aria-hidden="true"
                                            className="font-mono text-xs font-black tabular-nums text-white"
                                        >
                                            {fmt(voltage.value)}
                                        </span>
                                        <span aria-hidden="true" className="text-[10px] font-bold text-gray-500">
                                            V
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* ── SECTION: DEPTH ── */}
                        <section
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                        >
                            <SectionPlate title="Depth" place={placeOf('Depth')} />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                <div className="text-center">
                                    <span className="sr-only">
                                        {spokenReading('Depth', fmt(depth.value), 'metres')}
                                    </span>
                                    <p
                                        aria-hidden="true"
                                        className="text-7xl font-black tabular-nums font-mono text-white leading-none"
                                    >
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
                                            ? 'border-rose-500/40 bg-rose-500/10'
                                            : depthTrend.level === 'serious'
                                              ? 'border-orange-500/30 bg-orange-500/8'
                                              : depthTrend.level === 'warning'
                                                ? 'border-amber-500/25 bg-amber-500/6'
                                                : 'border-white/6 bg-white/3'
                                    }`}
                                >
                                    <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-400">
                                        {depthTrend.label}
                                    </p>
                                    {/* The brain's no-data glyph is an em dash; the panel's
                                        one no-data glyph is '--'. */}
                                    <p className="text-lg font-black text-white">
                                        {depthTrend.text === '—' ? (
                                            <>
                                                <span aria-hidden="true">--</span>
                                                <span className="sr-only">no data</span>
                                            </>
                                        ) : (
                                            depthTrend.text
                                        )}
                                    </p>
                                    {depthTrend.note && <p className="text-[11px] text-gray-400">{depthTrend.note}</p>}
                                    <p className="mt-1 text-[10px] text-gray-500">
                                        Comfort line {COMFORT_M.toFixed(1)} m under the keel
                                    </p>
                                </div>
                                <div className="rounded-2xl bg-white/3 border border-white/6 p-3">
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

                        {/* ── SECTION: SEA TEMP ──
                            Water temperature from the hull sensor ($--MTW on the
                            bus, or the Pi's environment.water.temperature). Shane
                            2026-09-09: "add a sea water temp page, with all of the
                            beautiful trimmings as the other pages have." Same shape
                            as Depth: the number, what it is doing, the 15-min chart —
                            and an honest card when the bus carries no such sentence. */}
                        <section
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                        >
                            <SectionPlate title="Sea temp" place={placeOf('Sea temp')} />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                <div className="text-center">
                                    <span className="sr-only">
                                        {spokenReading(
                                            'Sea temperature',
                                            formatSeaTemp(waterTemp.value, tempUnit),
                                            tempUnit === 'F' ? 'degrees Fahrenheit' : 'degrees Celsius',
                                        )}
                                    </span>
                                    <p
                                        aria-hidden="true"
                                        className="text-7xl font-black tabular-nums font-mono text-white leading-none"
                                    >
                                        {formatSeaTemp(waterTemp.value, tempUnit)}
                                        <span className="text-2xl text-gray-500"> °{tempUnit}</span>
                                    </p>
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mt-1">
                                        {waterTemp.value === null
                                            ? 'No water temperature on the bus'
                                            : waterTemp.freshness === 'stale'
                                              ? 'Hull sensor · last reading is getting old'
                                              : 'Hull sensor · live'}
                                    </p>
                                    {seaTrend && (
                                        <div
                                            className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 ${
                                                seaTrend.direction === 'warming'
                                                    ? 'border-orange-400/30 bg-orange-500/10 text-orange-200'
                                                    : seaTrend.direction === 'cooling'
                                                      ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
                                                      : 'border-white/12 bg-white/5 text-gray-200'
                                            }`}
                                        >
                                            <span aria-hidden="true" className="text-sm leading-none">
                                                {seaTrend.direction === 'warming'
                                                    ? '▲'
                                                    : seaTrend.direction === 'cooling'
                                                      ? '▼'
                                                      : '▬'}
                                            </span>
                                            <span className="text-xs font-black uppercase tracking-wider">
                                                {seaTrend.label}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                <p className="px-2 text-center text-xs font-medium leading-relaxed text-gray-300">
                                    {waterTemp.value === null
                                        ? 'Your instruments are not sending a sea temperature, so none is shown. It appears here once a hull sensor reports through the gateway or the Pi.'
                                        : (seaTrend?.read ??
                                          'Building a record — give it a few minutes before it can say what the water is doing.')}
                                </p>

                                <div className="grid grid-cols-3 gap-2">
                                    <StatCell
                                        label="Low"
                                        spoken="Low"
                                        value={
                                            waterTempReal.history.length > 0
                                                ? formatSeaTemp(waterTempReal.min, tempUnit)
                                                : '--'
                                        }
                                        unit={`°${tempUnit}`}
                                        unitSpoken={tempUnit === 'F' ? 'degrees Fahrenheit' : 'degrees Celsius'}
                                        tone="text-cyan-300"
                                    />
                                    <StatCell
                                        label="High"
                                        spoken="High"
                                        value={
                                            waterTempReal.history.length > 0
                                                ? formatSeaTemp(waterTempReal.max, tempUnit)
                                                : '--'
                                        }
                                        unit={`°${tempUnit}`}
                                        unitSpoken={tempUnit === 'F' ? 'degrees Fahrenheit' : 'degrees Celsius'}
                                        tone="text-orange-300"
                                    />
                                    <StatCell
                                        label="Change"
                                        spoken="Change"
                                        value={seaTrend ? formatSeaTempDelta(seaTrend.deltaC, tempUnit) : '--'}
                                        unit="°"
                                        unitSpoken="degrees"
                                        tone="text-white"
                                    />
                                </div>

                                <div className="rounded-2xl bg-white/3 border border-white/6 p-3">
                                    <Sparkline
                                        history={waterTempReal.history}
                                        min={waterTempReal.min}
                                        max={waterTempReal.max}
                                        color="#fb923c"
                                        width={sparklineWidth * 2}
                                        height={sparklineHeight + 20}
                                        showAxes
                                        axisUnit="°"
                                        label="sea temp"
                                    />
                                    <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 text-center mt-0.5">
                                        15 min chart
                                    </p>
                                </div>
                            </div>
                        </section>

                        {/* ── SECTION: HEADING ── */}
                        <section
                            className={`w-full ${sectionHeight} snap-start snap-always shrink-0 overflow-hidden flex flex-col ${containerPx} pt-1`}
                        >
                            <SectionPlate title="Heading" place={placeOf('Heading')} />
                            <div className="flex-1 min-h-0 flex flex-col items-center justify-evenly">
                                <HeadingGauge
                                    value={heading.value}
                                    isLive={heading.value !== null && heading.freshness === 'live'}
                                />
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
                            <SectionPlate title="Helm" place={placeOf('Helm')} />
                            <div className="flex-1 min-h-0 flex flex-col justify-evenly">
                                {rudder.value !== null ? (
                                    <>
                                        {/* The rudder as a DIAL rather than a bar (Shane
                                            2026-09-02: "a round guage that literally shows
                                            you where the rudder is like 0 is middle"). This
                                            is the one instrument whose reading is a physical
                                            position, so a needle sitting where the blade sits
                                            beats a length you have to convert. Colours and
                                            the amidships dead-band are unchanged from the
                                            bar, so only the shape is new. */}
                                        <RudderGauge angle={rudder.value} freshness={rudder.freshness} />
                                        {helm && helm.ok ? (
                                            <div
                                                className={`rounded-2xl border p-4 ${
                                                    helm.level === 'serious'
                                                        ? 'border-orange-500/30 bg-orange-500/8'
                                                        : helm.level === 'warning'
                                                          ? 'border-amber-500/25 bg-amber-500/6'
                                                          : 'border-emerald-500/20 bg-emerald-500/5'
                                                }`}
                                            >
                                                <p className="text-2xl font-black text-white">{helm.word}</p>
                                                <p className="mt-1 text-[13px] leading-relaxed text-gray-300">
                                                    {helm.what}
                                                </p>
                                                <p className="mt-2 rounded-xl bg-white/5 p-2.5 text-[13px] leading-relaxed text-white">
                                                    {helm.fix}
                                                </p>
                                                <p className="mt-1 text-[10px] text-gray-500">
                                                    {helm.deg.toFixed(1)}° weather helm · {helm.tack} tack
                                                </p>
                                            </div>
                                        ) : helm && !helm.ok ? (
                                            <div className="rounded-2xl border border-white/6 bg-white/3 p-4">
                                                <p className="text-sm font-bold text-gray-300">
                                                    {helm.downwind ? 'No verdict off the wind' : 'No verdict yet'}
                                                </p>
                                                <p className="mt-1 text-[12px] leading-relaxed text-gray-400">
                                                    {helm.why}
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="rounded-2xl border border-white/6 bg-white/3 p-4">
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
                                    <div className="rounded-2xl border border-white/6 bg-white/3 p-4 text-center">
                                        <p aria-hidden="true" className="text-4xl font-black text-gray-400">
                                            --
                                        </p>
                                        <p className="mt-2 text-sm font-bold text-gray-300">No rudder sensor</p>
                                        <p className="mt-1 text-[12px] leading-relaxed text-gray-400">
                                            Helm balance needs a rudder-angle sensor reporting on your instruments.
                                            Until one does, this stays blank rather than guessing.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
};
