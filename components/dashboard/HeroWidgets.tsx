import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { WindIcon, WaveIcon, GaugeIcon, EyeIcon, SunIcon, CompassIcon, DropletIcon, ThermometerIcon } from '../Icons';
import { AnimatedRainIcon } from '../ui/AnimatedIcons';
import { GustIcon, WavePeriodIcon } from '../icons/GlassGlyphs';
import type { MatrixParam } from './ModelComparisonMatrix';
import { WeatherMetrics, UnitPreferences, HourlyForecast, ForecastDay } from '../../types';
import { resolveForecastModel } from '../../services/weather/forecastModels';
import type { MetricKey } from './hero/MetricDeepDiveModal';
import {
    convertTemp,
    convertSpeed,
    convertLength,
    convertDistance,
    convertPrecip,
    cardinalToDegrees,
    expandCompassDirection,
} from '../../utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { useDraggable } from '@dnd-kit/core';
import { lazyRetry } from '../../utils/lazyRetry';
import { MODEL_COMPARE_EVENT, type ModelCompareRequest } from './hero/heroSlideHelpers';

const ModelComparisonMatrix = lazyRetry(
    () => import('./ModelComparisonMatrix').then((module) => ({ default: module.ModelComparisonMatrix })),
    'ModelComparisonMatrix',
);
const MetricDeepDiveModal = lazyRetry(
    () => import('./hero/MetricDeepDiveModal').then((module) => ({ default: module.MetricDeepDiveModal })),
    'MetricDeepDiveModal',
);
// Pressure gets its own screen rather than the shared deep-dive modal: it is
// the one metric the phone can MEASURE, and the sensor plumbing that makes
// that possible has no business loading for anyone who never taps HPA.
const BarometerModal = lazyRetry(
    () => import('./hero/BarometerModal').then((module) => ({ default: module.BarometerModal })),
    'BarometerModal',
);

/**
 * DraggableMetricCell — thin wrapper that makes a grid cell long-pressable
 * as a DnD source and animates its contents on metric swap.
 *
 * DnD: Uses the @dnd-kit useDraggable hook; activation is governed by the
 * sensors configured at the DndContext level in Dashboard.tsx (250ms
 * delay + 8px tolerance), so tap events still pass through to the
 * existing offshore grid-wide onClick (model comparison matrix).
 *
 * The `id` prop is the "effective metric" — whatever is VISIBLY displayed
 * in the cell right now. When heroMetric === 'wind' and the wind cell is
 * rendering temperature instead, the effective id is 'temp'. Dropping
 * temp on the hero = reset, consistent with the single-string state
 * model. It also doubles as the keyed wrapper, so every display change
 * triggers the lightweight CSS transition.
 */
/** Provided by HeroWidgets when the metric deep-dive is available (live NOW card).
 *  Fires with the cell's metric id on a tap. Null = taps do nothing. */
const MetricTapContext = React.createContext<((id: string) => void) | null>(null);

const DraggableMetricCell: React.FC<{
    id: string;
    children: React.ReactNode;
    /** What the metric means, read after the cell's name as its description:
     *  in the name, swiping the grid read ten definitions (UX scorecard run 8). */
    description?: string;
}> = ({ id, children, description }) => {
    const { attributes, listeners, setNodeRef, isDragging, transform } = useDraggable({ id });
    const onMetricTap = React.useContext(MetricTapContext);
    const descriptionId = React.useId();
    const style: React.CSSProperties = {
        opacity: isDragging ? 0.35 : 1,
        touchAction: 'none',
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition: isDragging ? 'none' : 'opacity 150ms ease-out',
        position: 'relative',
        zIndex: isDragging ? 100 : 'auto',
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            // dnd-kit's own drag instructions stay, after the glossary.
            aria-describedby={
                [description ? descriptionId : null, attributes['aria-describedby']].filter(Boolean).join(' ') ||
                undefined
            }
            // stopPropagation is load-bearing. The grid itself carries an
            // onClick that opens the model-comparison matrix when offshore,
            // and a metric tap used to bubble straight into it — so ONE tap
            // opened the deep-dive AND slammed the full-screen matrix
            // (z-[9999]) over it. The context handler is now always provided
            // and routes per-cell (HPA -> barometer modal on any card, deep
            // dives live-only, offshore non-live -> matrix); the grid's own
            // onClick still catches taps on the padding.
            onClick={
                onMetricTap
                    ? (e) => {
                          if (isDragging) return;
                          e.stopPropagation();
                          onMetricTap(id);
                      }
                    : undefined
            }
        >
            <div key={id} className="metric-swap-enter w-full h-full">
                {children}
            </div>
            {description && (
                <span id={descriptionId} hidden>
                    {description}
                </span>
            )}
        </div>
    );
};

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
    /** Metrics whose trend crosses a threshold worth a red arrow (Dashboard
     *  decides). Every other arrow is drawn neutral: red on a 3 kt breeze
     *  was an alarm with nothing behind it (UX scorecard run 9). */
    trendAlarms?: Record<string, boolean>;
    isLive?: boolean;
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    hourly?: HourlyForecast[];
    /** Daily forecast — feeds the metric deep-dive modal's "tomorrow" row. */
    forecast?: ForecastDay[];
    /** Location — for the modal's WeatherKit historical (yesterday) fetch. */
    coordinates?: { lat: number; lon: number };
    /** A grid metric the user long-pressed (detected at the DndContext level
     *  in Dashboard — a hold that ends without displacement). Opens the model
     *  convergence chart pre-tabbed to that metric. */
    spreadMetric?: string | null;
    /** Ack once the long-press request has been consumed. */
    onSpreadHandled?: () => void;
    /** Why every cell is empty (a day past the pinned model's range). Joined
     *  to the grid's name, so it is heard before ten 'no reading' cells. */
    emptyDayNote?: string | null;
}

/* ── Spoken names ──
   The cells are named for the ear, not the eye: 'DIR: ESE' was spelled out
   letter by letter and 'VIS: 13 nm' read as 'vis 13 N M' (UX scorecard run 7). */
const SPOKEN_UNITS: Record<string, [one: string, many: string]> = {
    kts: ['knot', 'knots'],
    kt: ['knot', 'knots'],
    mph: ['mile per hour', 'miles per hour'],
    kmh: ['kilometre per hour', 'kilometres per hour'],
    'km/h': ['kilometre per hour', 'kilometres per hour'],
    mps: ['metre per second', 'metres per second'],
    'm/s': ['metre per second', 'metres per second'],
    nm: ['nautical mile', 'nautical miles'],
    km: ['kilometre', 'kilometres'],
    mi: ['mile', 'miles'],
    m: ['metre', 'metres'],
    ft: ['foot', 'feet'],
    s: ['second', 'seconds'],
    '%': ['percent', 'percent'],
    mm: ['millimetre', 'millimetres'],
    in: ['inch', 'inches'],
    hPa: ['hectopascal', 'hectopascals'],
    '°C': ['degree Celsius', 'degrees Celsius'],
    '°F': ['degree Fahrenheit', 'degrees Fahrenheit'],
};

/** "8 knots", "20 or more nautical miles", "no reading". */
const spokenReading = (value: string | number, unit?: string): string => {
    if (value === '--') return 'no reading';
    // '20+' is capped visibility; imperial rain arrives pre-formatted ('0.39"').
    const shown = String(value).replace(/\+$/, ' or more').replace(/"$/, ' inches');
    if (!unit) return shown;
    const words = SPOKEN_UNITS[unit];
    if (!words) return `${shown} ${unit}`;
    return `${shown} ${Number(value) === 1 ? words[0] : words[1]}`;
};

const spokenTrend = (value: string | number, trend?: 'up' | 'down' | 'stable', alarm?: boolean): string =>
    value === '--' || !trend
        ? ''
        : trend === 'stable'
          ? ', steady'
          : `${trend === 'up' ? ', rising' : ', falling'}${alarm ? ', worsening' : ''}`;

/** Any dash-only value ('---', '—') is the one placeholder, '--': while
 *  loading DIR drew a bright '---' that VoiceOver read as 'dash dash dash'
 *  (UX scorecard run 8). */
const asReading = (value: string | number): string | number =>
    typeof value === 'string' && /^[\s\-\u2012-\u2015]+$/.test(value) ? '--' : value;

/* What each metric means. Read as the cell's description, after its name
   (value and trend), and shown as the hover title. */
const GLOSSARY = {
    pinnedTemp: 'Shown here while another metric is pinned to the top',
    wind: 'Sustained wind speed — average over 10 minutes',
    gust: 'Peak gust speed — sudden short bursts above sustained wind',
    wave: 'Significant wave height — average of tallest third of waves',
    uv: 'UV Index — 0-2 Low, 3-5 Moderate, 6-7 High, 8-10 Very High, 11+ Extreme',
    vis: 'Visibility — horizontal distance at which objects can be clearly seen',
    baro: 'Opens the barometer',
    humidity: 'Relative humidity — 60%+ feels muggy on a boat, <30% is very dry',
    // The day's total from the forecast model, not the minute-by-minute
    // nowcast in the rain strip below it (UX scorecard run 8).
    rainToday: 'Total rain for today, from the hourly forecast',
    chance: 'Chance of rain during this hour',
};

// --- Trend Arrow Component ---
// Stroke arrows, not filled triangles: a ▲/▼ beside a label read as a
// dropdown caret, and the flat bar for 'steady' read as the '--' of a missing
// value (UX scorecard run 6). Steady is a level arrow, so all three are arrows.
// A direction is drawn neutral; red is kept for a threshold crossing (run 9:
// WIND, GUST and BARO all red on a calm clear night). 8 px wide, flush to the
// label, so a four-letter label and its arrow keep 4 pt off the dividers.
const TrendArrow: React.FC<{ trend?: 'up' | 'down' | 'stable'; alarm?: boolean }> = ({ trend, alarm }) => {
    if (!trend) return null;

    const isUp = trend === 'up';
    const isStable = trend === 'stable';

    const color = !isStable && alarm ? 'text-red-400' : 'text-white/60';

    return (
        <span className={`inline-flex items-center ${color}`}>
            <svg
                width="8"
                height="10"
                viewBox="1 0 8 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                {isStable ? (
                    <>
                        <path d="M2 5h6" />
                        <path d="M5.2 2.2l2.8 2.8-2.8 2.8" />
                    </>
                ) : isUp ? (
                    <>
                        <path d="M5 8.5v-7" />
                        <path d="M2 4.5l3-3 3 3" />
                    </>
                ) : (
                    <>
                        <path d="M5 1.5v7" />
                        <path d="M2 5.5l3 3 3-3" />
                    </>
                )}
            </svg>
            {/* The red says worsening; say it too, and only then. */}
            <span className="sr-only">
                {isStable ? 'steady' : `${isUp ? 'rising' : 'falling'}${alarm ? ', worsening' : ''}`}
            </span>
        </span>
    );
};

// --- Small directional arrow (for the WAVE and PERIOD cells) ---
const DirectionArrow: React.FC<{ degrees: number | null; size?: number }> = ({ degrees, size = 14 }) => {
    if (degrees === null) return null;
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            className="shrink-0 opacity-70"
            style={{ transform: `rotate(${degrees}deg)`, transition: 'transform 1s ease' }}
            aria-hidden="true"
        >
            <path d="M12 2L8 14h8L12 2Z" fill="var(--day-ui-accent, rgba(94,234,212,0.7))" />
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
    /** The trend crosses a threshold: red arrow, and 'worsening' in the name. */
    alarm?: boolean;
    tealHeading?: boolean;
    dirDeg?: number | null; // Optional directional arrow
    onClick?: () => void;
    tooltip?: string; // Long-press / hover explanation
    /** Six-letter labels (PERIOD) drop the tracking altogether, so they keep
     *  4 pt off the cell dividers on a 375 pt phone. */
    compactLabel?: boolean;
    /** The metric in full words for the cell's name, starting with the word
     *  its label shortens ("Direction of the wind" for DIR). */
    spokenLabel: string;
    /** The value in words where the shown one is an abbreviation ("east-southeast"). */
    spokenValue?: string;
    /** Words for what only a glyph shows, e.g. the wave arrow's bearing. */
    spokenExtra?: string;
    /** A muted word under the value naming what the number covers ('today'),
     *  where the cell's label alone left it ambiguous. Seen, not read: the
     *  cell's name already says it. */
    caption?: string;
}> = ({
    label,
    icon,
    value,
    unit,
    trend,
    alarm,
    tealHeading = true,
    dirDeg,
    onClick,
    tooltip,
    compactLabel,
    spokenLabel,
    spokenValue,
    spokenExtra,
    caption,
}) => {
    value = asReading(value);
    const reading = value === '--' ? ', no reading' : ` ${spokenValue ?? spokenReading(value, unit)}`;
    return (
        <div
            className={`flex flex-col items-center justify-between h-full py-2 px-1 relative ${onClick ? 'cursor-pointer active:bg-white/5 transition-colors' : ''}`}
            onClick={onClick}
            title={tooltip}
            // Value and trend only: the glossary is the description
            // (DraggableMetricCell), not ten definitions in the names.
            aria-label={`${spokenLabel}${reading}${spokenTrend(value, trend, alarm)}${value !== '--' && spokenExtra ? `, ${spokenExtra}` : ''}`}
        >
            {/* Header: icon + label + trend — locked to a single 12px line.
                Tracking-wide and 2 px gaps: at tracking-widest the WIND icon
                and the GUST/BARO arrows sat on the cell dividers at 393 and
                375 pt (UX scorecard run 9). */}
            <div className="glass-metric-heading-row flex items-center gap-0.5 opacity-90 h-3">
                <span
                    className={`w-3 h-3 shrink-0 inline-flex items-center justify-center overflow-hidden ${tealHeading ? 'text-emerald-400' : 'text-amber-400'}`}
                    aria-hidden="true"
                >
                    {icon}
                </span>
                <span
                    className={`glass-metric-heading text-[11px] font-sans font-bold ${compactLabel ? 'tracking-normal' : 'tracking-wide'} uppercase leading-none whitespace-nowrap ${tealHeading ? 'text-emerald-300' : 'text-amber-300'}`}
                >
                    {label}
                </span>
                {/* No arrow beside a missing value: compare() reports 'stable' for null. */}
                <TrendArrow trend={value === '--' ? undefined : trend} alarm={alarm} />
            </div>

            {/* Value */}
            <div className="flex items-baseline mt-auto mb-1 gap-0.5">
                {dirDeg !== undefined && dirDeg !== null && <DirectionArrow degrees={dirDeg} size={12} />}
                <span
                    // Five or more characters ('Trace', an inch figure such as
                    // '<0.01"') do not fit a fifth of the row at 26 px: they
                    // ran over the divider. Step them down rather than clip.
                    className={`${String(value).length >= 5 ? 'text-[20px]' : 'text-[26px]'} font-mono font-medium tracking-tight whitespace-nowrap drop-shadow-md ${
                        value === '--' ? 'text-slate-500' : 'text-ivory'
                    }`}
                    style={{ fontFeatureSettings: '"tnum"' }}
                >
                    {value}
                </span>
                {unit && value !== '--' && (
                    <span className="text-[11px] font-sans text-slate-400 font-medium ml-1 self-end mb-1.5">
                        {unit}
                    </span>
                )}
            </div>
            {/* In the cell's bottom padding, so the value keeps the row's
                baseline. */}
            {caption && (
                <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0.5 text-center text-[11px] leading-none font-sans font-medium text-slate-400 pointer-events-none"
                >
                    {caption}
                </span>
            )}
        </div>
    );
};

// --- Barometer Cell (BARO — consistent with InstrumentCell) ---
// Named BARO, not HPA: hPa is the unit, not the instrument (UX scorecard run 6).
const BarometerCell: React.FC<{
    pressure: string | number;
    trend?: 'up' | 'down' | 'stable';
    /** A fall of 3 hPa or more over three hours: the one BARO arrow drawn red. */
    alarm?: boolean;
}> = ({ pressure: rawPressure, trend, alarm }) => {
    const pressure = asReading(rawPressure);

    return (
        <div
            className="flex flex-col items-center justify-between h-full py-2 px-1 relative"
            aria-label={`Barometer${pressure === '--' ? ', no reading' : ` ${spokenReading(pressure, 'hPa')}`}${spokenTrend(pressure, trend, alarm)}`}
        >
            {/* Header: icon + label + trend — locked to 12px line, spaced as InstrumentCell. */}
            <div className="glass-metric-heading-row flex items-center gap-0.5 opacity-90 h-3">
                <span
                    className="w-3 h-3 shrink-0 inline-flex items-center justify-center overflow-hidden text-emerald-400"
                    aria-hidden="true"
                >
                    <GaugeIcon className="w-3 h-3 metric-anim-gauge" />
                </span>
                <span className="glass-metric-heading text-[11px] font-sans font-bold tracking-wide uppercase leading-none whitespace-nowrap text-emerald-300">
                    BARO
                </span>
                <TrendArrow trend={pressure === '--' ? undefined : trend} alarm={alarm} />
            </div>

            {/* Value */}
            <div className="flex items-baseline mt-auto mb-1 gap-0.5">
                {/* The muted placeholder InstrumentCell uses: BARO's '--' was
                    the one bright ivory dash on the grid (UX scorecard run 8). */}
                <span
                    className={`text-[26px] font-mono font-medium tracking-tight drop-shadow-md ${
                        pressure === '--' ? 'text-slate-500' : 'text-ivory'
                    }`}
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
    trends,
    trendAlarms,
    isLive = true,
    locationType,
    hourly,
    forecast,
    coordinates,
    spreadMetric,
    onSpreadHandled,
    emptyDayNote,
}) => {
    // Metric deep-dive modal — only armed on the live NOW card.
    const [deepDive, setDeepDive] = useState<MetricKey | null>(null);
    // Barometer screen — takes over the grid box in place, rather than
    // opening a sheet over it.
    const [showBarometer, setShowBarometer] = useState(false);
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
    const windDir = asReading(topRowData.windDirection || '--');
    const windDirSpoken = windDir === '--' ? undefined : expandCompassDirection(String(windDir)).toLowerCase();
    // swellDirection and swellPeriod are the TOTAL sea's (wind sea and every
    // swell), whatever their names say, so this cell is WAVE at every
    // location type, offshore too (W1-07). SWELL 2 is the only swell shown.
    const waveDirDeg = cardinalToDegrees(topRowData.swellDirection) ?? null;
    const wavesFromSpoken =
        waveDirDeg !== null && topRowData.swellDirection
            ? `waves from the ${expandCompassDirection(String(topRowData.swellDirection)).toLowerCase()}`
            : undefined;

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
    const humidityVal = safeRound(data.humidity);

    // Rain: live = daily mm total, forecast = precipChance %
    const rainValue = useMemo(() => {
        if (isLive && hourly?.length) {
            // Sum today's hourly precipitation amounts for daily total (mm)
            // Numeric device-local day bounds — same set of hours as the old
            // toLocaleDateString('en-CA') string compare, without building an
            // Intl formatter for every hourly entry.
            const dayStart = new Date();
            dayStart.setHours(0, 0, 0, 0);
            const start = dayStart.getTime();
            const end = start + 86_400_000;
            // Sum only the hours that REPORTED a value; a day whose every hour
            // carried null is '--', not a confident '0 mm' (review of 5b098bd8).
            let reportedHours = 0;
            const todayTotal = hourly.reduce((sum, h) => {
                const t = new Date(h.time).getTime();
                if (t < start || t >= end || h.precipitation == null) return sum;
                reportedHours++;
                return sum + h.precipitation;
            }, 0);
            if (reportedHours === 0) return '--';
            if (units.temp === 'F') {
                // Imperial: convert mm → inches. convertPrecip returns a fully
                // formatted string ('0.39"', '<0.01"', 'TRACE') with the inch
                // mark embedded, so rainUnit is blank for this path.
                // A trace is a word, not a measurement (it overran the cell as TRACE).
                const inches = convertPrecip(todayTotal, 'F') ?? 0;
                return inches === 'TRACE' ? 'Trace' : inches;
            }
            return todayTotal > 0 ? Math.round(todayTotal) : 0;
        }
        if (!isLive && hourly?.length) {
            // BUG FIX: Use cardTime (the hour the user scrolled to), NOT Date.now()
            // Previously this always matched "right now", so every future hour showed the same rain %.
            const targetTime = cardTime ?? Date.now();
            const currentHour = hourly.find((h) => Math.abs(new Date(h.time).getTime() - targetTime) < 90 * 60_000);
            // A chance or '--', never the hour's millimetres: this cell's unit
            // is %, so a 5 mm hour used to read 'CHANCE 5 %' (UX scorecard run 7).
            if (currentHour) {
                return typeof currentHour.precipChance === 'number' && Number.isFinite(currentHour.precipChance)
                    ? Math.round(currentHour.precipChance)
                    : '--';
            }
        }
        // Fallback: the active data's own chance, not the live observation.
        return typeof data.precipChance === 'number' && Number.isFinite(data.precipChance)
            ? Math.round(data.precipChance)
            : '--';
    }, [isLive, hourly, data.precipChance, cardTime, units.temp]);
    const rainUnit = isLive ? (units.temp === 'F' ? '' : 'mm') : '%';

    const isOffshore = locationType === 'offshore';

    const speedUnit = units.speed || 'kts';
    const waveUnit = units.waveHeight || 'm';
    const distUnit = units.visibility || 'nm';

    // Red only where Dashboard found a threshold crossed (wind rising to 15 kt,
    // pressure falling 3 hPa in 3 h, ...); every other arrow is a direction.
    const alarmFor = (key: string): boolean => trendAlarms?.[key] === true;

    // PERF: useState kept to maintain hook order (React rules-of-hooks).
    // Compass overlay has been removed, but deleting this useState would crash
    // when switching between wx full/essential modes.
    const [_showCompass] = useState(false);

    // Model comparison matrix — offshore grid-tap opens it on WIND; a
    // long-press on any cell (relayed via spreadMetric) opens it anywhere,
    // pre-tabbed to that metric.
    const [showMatrix, setShowMatrix] = useState(false);
    const [matrixParam, setMatrixParam] = useState<MatrixParam | undefined>(undefined);
    // The day a Glass day card's agreement chip asked for (W1-09); unset otherwise.
    const [matrixDay, setMatrixDay] = useState<number | undefined>(undefined);
    const glassModel = resolveForecastModel(useSettingsStore((s) => s.settings.forecastModel));

    // A long-press release can be followed by a browser-synthesised click on
    // the same cell (iOS especially) — swallow taps briefly so the deep-dive
    // modal / offshore grid-tap don't stack on top of the chart it opened.
    const suppressTapUntilRef = useRef(0);

    // The barometer has to be LOGGING long before anyone taps HPA: a
    // three-hour tendency needs three hours of record, and a sensor that only
    // wakes when the panel opens would show "collecting" forever. Started
    // here, with the Glass page, via a dynamic import so the sensor plumbing
    // still isn't in the initial chunk. No-ops on anything without a barometer.
    useEffect(() => {
        let cancelled = false;
        void import('../../services/native/barometer').then(async (m) => {
            if (cancelled) return;
            void m.startLogging();
            // Hand the module to the offline helm voice so "what's the
            // barometer" can be answered with no network. helmVoice does not
            // import it itself — asking the depth must not be the thing that
            // starts pressure logging.
            const helm = await import('../../services/voice/helmVoice');
            if (!cancelled) helm.registerBarometerModule(m);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!spreadMetric) return;
        suppressTapUntilRef.current = Date.now() + 600;
        setMatrixParam(spreadMetric as MatrixParam);
        setMatrixDay(undefined);
        setShowMatrix(true);
        onSpreadHandled?.();
    }, [spreadMetric, onSpreadHandled]);

    // A day card's agreement chip opens this same comparison on its day, on the
    // tab that decided its verdict: one sheet, not one per day row (W1-09).
    useEffect(() => {
        const onCompare = (event: Event) => {
            const request = (event as CustomEvent<ModelCompareRequest>).detail;
            if (!request) return;
            suppressTapUntilRef.current = Date.now() + 600;
            setMatrixParam(request.param);
            setMatrixDay(request.dayMs);
            setShowMatrix(true);
        };
        window.addEventListener(MODEL_COMPARE_EVENT, onCompare);
        return () => window.removeEventListener(MODEL_COMPARE_EVENT, onCompare);
    }, []);

    // ── Pin-to-hero: pinned metric ID + temp display value ──
    // When the user pins a metric to the hero slot, THAT cell in the grid
    // needs to render temperature instead (the swap rule). Read the
    // current pinned metric and precompute the temperature display so the
    // conditional cell renderers below stay clean.
    const heroMetric = useSettingsStore((s) => s.settings.heroMetric) || 'temp';
    const tempValue =
        data.airTemperature !== null && data.airTemperature !== undefined
            ? convertTemp(data.airTemperature, units.temp)
            : '--';
    const tempUnit = `°${units.temp || 'C'}`;

    // Offshore → entire grid is tappable to open the model matrix.
    // Previously only the Wind cell was — user had to hunt for it.
    const gridOnClick = isOffshore
        ? () => {
              if (Date.now() < suppressTapUntilRef.current) return;
              setMatrixParam(undefined);
              setMatrixDay(undefined);
              setShowMatrix(true);
          }
        : undefined;

    return (
        <MetricTapContext.Provider
            value={(id) => {
                if (Date.now() < suppressTapUntilRef.current) return;
                // HPA opens the barometer breakout from ANY card, live or
                // not — the instrument always reads "now", and offshore is
                // where the phone's own sensor matters most (Shane,
                // 2026-08-21: it must not be swallowed by the matrix).
                if (id === 'pressure') {
                    setShowBarometer(true);
                    return;
                }
                // Deep dives stay live-only: they anchor to the NOW card's
                // data and would mislead under a forecast card.
                if (isLive) {
                    setDeepDive(id as MetricKey);
                    return;
                }
                // Non-live cards keep their card-level behaviour: offshore,
                // any cell still reaches the model matrix (cells always
                // stopPropagation now, so re-dispatch it here); elsewhere the
                // tap is deliberately inert.
                if (isOffshore) {
                    setMatrixParam(undefined);
                    setMatrixDay(undefined);
                    setShowMatrix(true);
                }
            }}
        >
            <div
                className={`relative w-full rounded-xl overflow-hidden bg-white/8 border border-white/15 shadow-2xl ${isOffshore ? 'cursor-pointer active:scale-[0.995] transition-transform' : ''}`}
                role="region"
                aria-label={`${
                    isOffshore ? 'Offshore weather metrics — tap to compare models' : 'Weather metrics dashboard'
                }${emptyDayNote ? `. ${emptyDayNote}` : ''}`}
                onClick={gridOnClick}
            >
                {/* TOP ROW: Wind, Dir, Gust, Wave, Per
                Icons carry a `metric-anim-*` class that plays a CSS
                animation for ~60 seconds after the card mounts, then
                stops cold. Previously we had infinite wiggles which
                overheated phones on long voyages; the iteration-count
                cap is the fix. See index.css → "METRIC GRID ICON
                ANIMATIONS" for the full keyframe details. */}
                <div
                    className={`w-full grid grid-cols-5 divide-x divide-white/12 h-[80px] ${emptyDayNote ? 'opacity-40' : ''}`}
                >
                    {/* Wind Speed — or TEMP if wind is pinned to hero */}
                    <DraggableMetricCell
                        id={heroMetric === 'wind' ? 'temp' : 'wind'}
                        description={heroMetric === 'wind' ? GLOSSARY.pinnedTemp : GLOSSARY.wind}
                    >
                        {heroMetric === 'wind' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                                tooltip={GLOSSARY.pinnedTemp}
                            />
                        ) : (
                            <InstrumentCell
                                label="WIND"
                                spokenLabel="Wind speed"
                                icon={<WindIcon className="w-3 h-3 metric-anim-wind" />}
                                value={windSpeed}
                                unit={speedUnit}
                                trend={trends?.windSpeed}
                                alarm={alarmFor('windSpeed')}
                                tooltip={GLOSSARY.wind}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Direction — or TEMP if pinned */}
                    <DraggableMetricCell id={heroMetric === 'dir' ? 'temp' : 'dir'}>
                        {heroMetric === 'dir' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                label="DIR"
                                spokenLabel="Direction of the wind"
                                icon={<CompassIcon className="w-3 h-3 metric-anim-compass" rotation={0} />}
                                value={windDir}
                                // 'Direction of the wind from the south', not '… wind
                                // south'. The name still starts with the word DIR
                                // shortens, so a voice 'tap DIR' finds the cell.
                                spokenValue={windDirSpoken ? `from the ${windDirSpoken}` : undefined}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Gusts — or TEMP if pinned */}
                    <DraggableMetricCell
                        id={heroMetric === 'gust' ? 'temp' : 'gust'}
                        description={heroMetric === 'gust' ? undefined : GLOSSARY.gust}
                    >
                        {heroMetric === 'gust' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                label="GUST"
                                spokenLabel="Gusts"
                                icon={<GustIcon className="w-3 h-3 metric-anim-wind" />}
                                value={gustVal}
                                unit={speedUnit}
                                trend={trends?.windGust}
                                alarm={alarmFor('windGust')}
                                tooltip={GLOSSARY.gust}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Wave Height — or TEMP if pinned */}
                    <DraggableMetricCell
                        id={heroMetric === 'wave' ? 'temp' : 'wave'}
                        description={heroMetric === 'wave' ? undefined : GLOSSARY.wave}
                    >
                        {heroMetric === 'wave' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                label="WAVE"
                                spokenLabel="Wave height"
                                spokenExtra={wavesFromSpoken}
                                icon={<WaveIcon className="w-3 h-3 metric-anim-wave" />}
                                value={waveHeight ?? '--'}
                                unit={waveUnit}
                                trend={trends?.waveHeight}
                                alarm={alarmFor('waveHeight')}
                                dirDeg={waveDirDeg}
                                tooltip={GLOSSARY.wave}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Period — or TEMP if pinned */}
                    <DraggableMetricCell id={heroMetric === 'period' ? 'temp' : 'period'}>
                        {heroMetric === 'period' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                label="PERIOD"
                                spokenLabel="Period of the waves"
                                // Six letters overflow a 375 pt phone's fifth column at
                                // any tracking; untracked, it keeps 4 pt clear.
                                compactLabel
                                icon={<WavePeriodIcon className="w-3 h-3 metric-anim-gauge" />}
                                value={wavePeriod}
                                unit="s"
                                dirDeg={waveDirDeg}
                            />
                        )}
                    </DraggableMetricCell>
                </div>

                {/* Horizontal divider between rows */}
                <div className="w-full h-px bg-white/12" />

                {/* BOTTOM ROW: UV, Vis, Baro, Hum, Rain. Both rows step back to
                    40 % on a day past the model's range: ten '--' cells at full
                    strength spent 160 pt saying nothing (UX scorecard run 10). */}
                <div
                    className={`w-full grid grid-cols-5 divide-x divide-white/12 h-[80px] ${emptyDayNote ? 'opacity-40' : ''}`}
                >
                    {/* UV — or TEMP if pinned */}
                    <DraggableMetricCell
                        id={heroMetric === 'uv' ? 'temp' : 'uv'}
                        description={heroMetric === 'uv' ? undefined : GLOSSARY.uv}
                    >
                        {heroMetric === 'uv' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                label="UV"
                                spokenLabel="UV index"
                                icon={<SunIcon className="w-3 h-3 metric-anim-sun" />}
                                value={uvVal}
                                tooltip={GLOSSARY.uv}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Visibility — or TEMP if pinned */}
                    <DraggableMetricCell
                        id={heroMetric === 'vis' ? 'temp' : 'vis'}
                        description={heroMetric === 'vis' ? undefined : GLOSSARY.vis}
                    >
                        {heroMetric === 'vis' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                label="VIS"
                                spokenLabel="Visibility"
                                icon={<EyeIcon className="w-3 h-3 metric-anim-eye" />}
                                value={visVal}
                                unit={distUnit}
                                trend={trends?.visibility}
                                alarm={alarmFor('visibility')}
                                tooltip={GLOSSARY.vis}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Pressure — or TEMP if pinned */}
                    <DraggableMetricCell
                        id={heroMetric === 'pressure' ? 'temp' : 'pressure'}
                        description={heroMetric === 'pressure' ? undefined : GLOSSARY.baro}
                    >
                        {heroMetric === 'pressure' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <BarometerCell
                                pressure={pressureVal}
                                trend={trends?.pressure}
                                alarm={alarmFor('pressure')}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Humidity — or TEMP if pinned */}
                    <DraggableMetricCell
                        id={heroMetric === 'humidity' ? 'temp' : 'humidity'}
                        description={heroMetric === 'humidity' ? undefined : GLOSSARY.humidity}
                    >
                        {heroMetric === 'humidity' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                label="HUM"
                                spokenLabel="Humidity"
                                icon={<DropletIcon className="w-3 h-3 metric-anim-droplet" />}
                                value={humidityVal}
                                unit="%"
                                trend={trends?.humidity}
                                alarm={alarmFor('humidity')}
                                tooltip={GLOSSARY.humidity}
                            />
                        )}
                    </DraggableMetricCell>

                    {/* Rain — or TEMP if pinned */}
                    <DraggableMetricCell
                        id={heroMetric === 'rain' ? 'temp' : 'rain'}
                        description={heroMetric === 'rain' ? undefined : isLive ? GLOSSARY.rainToday : GLOSSARY.chance}
                    >
                        {heroMetric === 'rain' ? (
                            <InstrumentCell
                                label="TEMP"
                                spokenLabel="Temperature"
                                icon={<ThermometerIcon className="w-3 h-3" />}
                                value={tempValue}
                                unit={tempUnit}
                            />
                        ) : (
                            <InstrumentCell
                                // 'RAIN %', not CHANCE: six wide capitals ran divider to
                                // divider (UX scorecard run 9). The name says it in full,
                                // starting with the visible word.
                                label={isLive ? 'RAIN' : 'RAIN %'}
                                spokenLabel={isLive ? 'Rain today' : 'Rain chance'}
                                // No visible 'today' caption (Shane, 2026-10-02: remove the
                                // word from the rain metric). It was added in UX scorecard
                                // run 10 to separate the day's total from the rain strip's
                                // nowcast; the spoken name ('Rain today …') and the tooltip
                                // still say it is today's total.
                                icon={<AnimatedRainIcon className="w-3 h-3 text-emerald-400" />}
                                value={rainValue}
                                unit={rainUnit}
                                tooltip={isLive ? GLOSSARY.rainToday : GLOSSARY.chance}
                            />
                        )}
                    </DraggableMetricCell>
                </div>

                {/* Model Comparison Matrix — offshore grid-tap or any-cell long-press */}
                {showMatrix && (
                    <Suspense fallback={null}>
                        <ModelComparisonMatrix
                            visible
                            onClose={() => setShowMatrix(false)}
                            selectedModel={glassModel}
                            initialParam={matrixParam}
                            initialDay={matrixDay}
                            coordinates={coordinates}
                        />
                    </Suspense>
                )}
            </div>
            {/* Barometer breakout — the HPA tap used to flip the 163 px grid
                box into a miniature instrument; it now opens a full modal
                (Shane, 2026-08-21: "way too small to be of use"). */}
            {showBarometer && (
                <Suspense fallback={null}>
                    <BarometerModal
                        isOpen
                        onClose={() => setShowBarometer(false)}
                        hourly={hourly}
                        forecastPressure={data.pressure}
                    />
                </Suspense>
            )}
            {deepDive && (
                <Suspense fallback={null}>
                    <MetricDeepDiveModal
                        metric={deepDive}
                        onClose={() => setDeepDive(null)}
                        units={units}
                        hourly={hourly || []}
                        forecast={forecast || []}
                        coordinates={coordinates}
                    />
                </Suspense>
            )}
        </MetricTapContext.Provider>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroWidgets = React.memo(HeroWidgetsComponent);
