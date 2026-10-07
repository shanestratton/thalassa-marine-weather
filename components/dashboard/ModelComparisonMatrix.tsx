/**
 * ModelComparisonMatrix — NWP model convergence viewer.
 *
 * Opens from the Glass metrics grid: a tap anywhere on the grid when
 * offshore (legacy behaviour), or a LONG-PRESS on any individual metric
 * cell anywhere (inshore/coastal/offshore), which lands pre-tabbed on that
 * metric via `initialParam`.
 *
 * Renders a continuous hourly SVG line chart to ten days, one line per
 * model, so convergence and divergence read at a glance. One tab per grid
 * metric; every tab is served by the same two-request multi-model fetch
 * (ModelSpreadService), so switching tabs never refetches.
 *
 * Atmospheric tabs plot the seven models of COMPARE_MODELS (the picker's
 * five plus GFS and GEM, whose first two days can come from their regional
 * nests: see forecastModels); WAVE / PER. plot the four wave models (the
 * marine endpoint has its own model set). The user's pinned forecast model
 * gets a thicker line + glow and is drawn on top.
 *
 * Honest about coverage: an hour a model doesn't have is a gap in its line
 * (the app never fills one in; the smooth late hours of the 3- and 6-hourly
 * runs are Open-Meteo's own interpolation), and the member strip under the
 * chart counts the models with data each hour, so the drop after day 7
 * (ICON and UKMO end) shows. A day with only a few members left is drawn
 * thin, because fewer lines can look like more agreement. The headline
 * verdict covers the next three days only (on WIND and DIR, the worst day
 * bar among them, so it never reads better than a bar); one model alone is said in
 * words, never called agreement. Where no model publishes a variable an
 * honest empty state replaces the chart, and a leg the servers never
 * answered says so instead. No mock data. Days and times are the location's
 * own, not the phone's.
 *
 * One set of thresholds (services/weather/dayAgreement, W1-09): the WIND and
 * DIR day bars are the Glass day cards' own agreement verdicts, and the other
 * tabs read the same module. A day card's chip opens the sheet on its day
 * (`initialDay`): that day is banded and its verdict, in the chip's words,
 * replaces the three-day headline.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import type { WeatherModel } from '../../types';
import {
    queryModelSpread,
    type ModelSpreadResult,
    type AtmosVar,
    type MarineVar,
} from '../../services/weather/ModelSpreadService';
import { ECCC_LICENCE, ECCC_LICENCE_URL, forecastDataCredit } from '../../services/weather/forecastModels';
import {
    AGREEMENT_GLYPH,
    AGREEMENT_WORDS,
    THIN_BELOW,
    circularSpread,
    classifySpread,
    localDayStarts,
    median,
    windAgreementForDays,
    type AgreementLevel,
} from '../../services/weather/dayAgreement';
import { resolveTimeZone } from '../../utils/timezone';
import { useLocationCoords } from '../../stores/LocationStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// ── Parameter definitions ──
// Ids match the Glass grid's metric ids so a long-pressed cell maps 1:1.

export type MatrixParam =
    | 'wind'
    | 'dir'
    | 'gust'
    | 'wave'
    | 'period'
    | 'uv'
    | 'vis'
    | 'pressure'
    | 'humidity'
    | 'rain'
    | 'temp';

interface ParamSpec {
    id: MatrixParam;
    short: string;
    unit: string;
    block: 'atmos' | 'marine';
    variable: AtmosVar | MarineVar;
    /** Convert a raw API value to display units. */
    convert?: (v: number) => number;
    /** Fallback Y range when data is sparse. */
    padMin: number;
    padMax: number;
    tickStep: number;
    decimals: number;
    /** Degrees — plotted on a 360° window centred on the compass point
     *  nearest the models' mean bearing, the line lifted only where it
     *  crosses the window's edge (opposite the consensus); spread measured
     *  circularly. */
    circular?: boolean;
}

const PARAMS: ParamSpec[] = [
    {
        id: 'wind',
        short: 'WIND',
        unit: 'kts',
        block: 'atmos',
        variable: 'wind_speed_10m',
        padMin: 0,
        padMax: 30,
        tickStep: 10,
        decimals: 0,
    },
    {
        id: 'dir',
        short: 'DIR',
        unit: '°',
        block: 'atmos',
        variable: 'wind_direction_10m',
        padMin: 0,
        padMax: 360,
        tickStep: 90,
        decimals: 0,
        circular: true,
    },
    {
        id: 'gust',
        short: 'GUST',
        unit: 'kts',
        block: 'atmos',
        variable: 'wind_gusts_10m',
        padMin: 0,
        padMax: 40,
        tickStep: 10,
        decimals: 0,
    },
    {
        id: 'wave',
        short: 'WAVE',
        unit: 'm',
        block: 'marine',
        variable: 'wave_height',
        padMin: 0,
        padMax: 3,
        tickStep: 1,
        decimals: 1,
    },
    {
        id: 'period',
        short: 'PER.',
        unit: 's',
        block: 'marine',
        variable: 'wave_period',
        padMin: 0,
        padMax: 12,
        tickStep: 3,
        decimals: 1,
    },
    {
        id: 'pressure',
        short: 'BARO',
        unit: 'hPa',
        block: 'atmos',
        variable: 'pressure_msl',
        padMin: 1000,
        padMax: 1030,
        tickStep: 10,
        decimals: 0,
    },
    {
        id: 'temp',
        short: 'TEMP',
        unit: '°C',
        block: 'atmos',
        variable: 'temperature_2m',
        padMin: 10,
        padMax: 30,
        tickStep: 5,
        decimals: 1,
    },
    {
        id: 'humidity',
        short: 'HUM',
        unit: '%',
        block: 'atmos',
        variable: 'relative_humidity_2m',
        padMin: 0,
        padMax: 100,
        tickStep: 25,
        decimals: 0,
    },
    {
        id: 'rain',
        short: 'RAIN',
        unit: 'mm',
        block: 'atmos',
        variable: 'precipitation',
        padMin: 0,
        padMax: 2,
        tickStep: 1,
        decimals: 1,
    },
    {
        id: 'vis',
        short: 'VIS',
        unit: 'km',
        block: 'atmos',
        variable: 'visibility',
        convert: (v) => v / 1000,
        padMin: 0,
        padMax: 20,
        tickStep: 5,
        decimals: 0,
    },
    {
        id: 'uv',
        short: 'UV',
        unit: '',
        block: 'atmos',
        variable: 'uv_index',
        padMin: 0,
        padMax: 12,
        tickStep: 3,
        decimals: 1,
    },
];

const specFor = (param: MatrixParam) => PARAMS.find((p) => p.id === param)!;

// ── Series shape ──

export interface HourlySeries {
    id: string;
    label: string;
    provider: string;
    hex: string;
    /** One value per hour of the block, in display units; null where the
     *  model has no data that hour (a gap, never filled in). */
    values: (number | null)[];
}

interface Props {
    visible: boolean;
    onClose: () => void;
    /** The pinned Glass forecast model — gets the emphasised line. */
    selectedModel: WeatherModel;
    /** Open on this tab (a long-pressed grid metric id). */
    initialParam?: MatrixParam;
    /** Open on the local day holding this instant (a Glass day card's
     *  agreement chip, W1-09): that day is banded and its verdict heads the sheet. */
    initialDay?: number;
    /** The Glass report's own coordinates. Preferred over LocationStore,
     *  whose Brisbane default is never synced on a cold boot with no cached
     *  report — charting the wrong point while the grid shows the right one. */
    coordinates?: { lat: number; lon: number };
}

// ── Pure helpers (exported for tests) ──

/** Nearest-sample lookup by epoch ms. Returns null when the closest sample
 *  is more than 90 minutes away (off the end of a short series). */
export function sampleAt(times: number[], values: (number | null)[], targetMs: number): number | null {
    if (!times.length) return null;
    let best = 0;
    let bestDiff = Math.abs(times[0] - targetMs);
    for (let i = 1; i < times.length; i++) {
        const d = Math.abs(times[i] - targetMs);
        if (d < bestDiff) {
            best = i;
            bestDiff = d;
        }
    }
    if (bestDiff > 90 * 60 * 1000) return null;
    return values[best] ?? null;
}

// The day boundaries and the circular spread are the shared module's, so the
// Glass day chip and these day bars cut the same days and measure alike.
export { circularSpread, localDayStarts };

/** The models' mean bearing in degrees [0, 360), or 180 (a plain 0–360
 *  window) when there is none or the bearings cancel out. */
export function circularMean(vals: number[]): number {
    let sin = 0;
    let cos = 0;
    for (const v of vals) {
        sin += Math.sin((v * Math.PI) / 180);
        cos += Math.cos((v * Math.PI) / 180);
    }
    if (Math.hypot(sin, cos) < 1e-6 * Math.max(1, vals.length)) return 180;
    return ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
}

/** A bearing placed in the 360° window [lo, lo + 360). */
export function intoWindow(v: number, lo: number): number {
    return lo + ((((v - lo) % 360) + 360) % 360);
}

/** Every hour of every model that publishes this tab's metric, on the block's
 *  own clock. A model with no value at all for the metric is left out. */
export function seriesFor(
    spread: ModelSpreadResult | null,
    param: MatrixParam,
): { times: number[]; series: HourlySeries[] } {
    const spec = specFor(param);
    const block = spec.block === 'atmos' ? spread?.atmos : spread?.marine;
    if (!block) return { times: [], series: [] };
    const conv = spec.convert ?? ((v: number) => v);
    const series: HourlySeries[] = [];
    for (const m of block.models) {
        const raw = (m.values as Record<string, (number | null)[] | undefined>)[spec.variable];
        if (!raw?.some((v) => v != null)) continue;
        series.push({
            id: m.id,
            label: m.label,
            provider: m.provider,
            hex: m.hex,
            values: raw.map((v) => (v == null ? null : conv(v))),
        });
    }
    return { times: block.times, series };
}

/** Hours further apart than this are missing hours, not one step. */
const MAX_STEP_MS = 90 * 60 * 1000;

/**
 * SVG path through a model's hours. The pen lifts at every missing value and
 * every missing hour, so a gap is drawn as a gap: never interpolated. A
 * direction line (values already in its window) also lifts where it jumps
 * more than half the window, i.e. across the window's edge. A lone hour gets
 * a zero-length stroke, which the round cap draws as a dot.
 */
export function chartPath(
    times: number[],
    values: (number | null)[],
    x: (t: number) => number,
    y: (v: number) => number,
    circular = false,
): string {
    let out = '';
    let prevT = 0;
    let prevV: number | null = null;
    let runLen = 0;
    let lastPt = '';
    const lift = () => {
        if (runLen === 1) out += `L${lastPt}`;
        runLen = 0;
    };
    values.forEach((v, i) => {
        const t = times[i];
        if (v == null || t == null) {
            lift();
            prevV = null;
            return;
        }
        const breaks = prevV == null || t - prevT > MAX_STEP_MS || (circular && Math.abs(v - prevV) > 180);
        if (breaks) lift();
        lastPt = `${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
        out += (breaks ? 'M' : 'L') + lastPt;
        runLen = breaks ? 1 : runLen + 1;
        prevT = t;
        prevV = v;
    });
    lift();
    return out;
}

/** How many models have a value at each hour. */
export function memberCounts(series: HourlySeries[], length: number): number[] {
    return Array.from({ length }, (_, i) => series.reduce((n, s) => n + (s.values[i] != null ? 1 : 0), 0));
}

/** Runs of equal member count (end inclusive). */
export function countRuns(counts: number[]): { start: number; end: number; count: number }[] {
    const runs: { start: number; end: number; count: number }[] = [];
    counts.forEach((count, i) => {
        const last = runs[runs.length - 1];
        if (last && last.count === count) last.end = i;
        else runs.push({ start: i, end: i, count });
    });
    return runs;
}

/** A formatter on the location's clock; UTC if the zone is unknown here. */
function zoneFormat(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    try {
        return new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
    } catch {
        return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });
    }
}

const HOUR_MS = 60 * 60 * 1000;
/** The headline verdict covers this much from now; the day bars carry the rest. */
const NEAR_TERM_MS = 72 * HOUR_MS;

type Level = 'high' | 'moderate' | 'low';
/** The sheet's words for the shared verdicts (the thresholds are dayAgreement's). */
const LEVEL_OF: Record<AgreementLevel, Level> = { agree: 'high', some: 'moderate', split: 'low' };
const AGREEMENT_OF: Record<Level, AgreementLevel> = { high: 'agree', moderate: 'some', low: 'split' };

export interface DayAgreement {
    /** The day's spread: on WIND, of the models' strongest hours; on DIR,
     *  the mean over the breezy hours; elsewhere the mean over the hours with
     *  at least two members. */
    variance: number | null;
    level: Level | 'none';
    /** The models compared: on WIND and DIR those with every hour of the
     *  day; elsewhere the fewest in the hours compared. When none could be
     *  compared, the most the day had: 0 or 1. */
    members: number;
    /** Compared with fewer members than the tab can field (under five, or
     *  under its own peak when it has fewer models than that). */
    thin: boolean;
    /** The most members any day had (on a day that was compared). */
    peak?: number;
    /** WIND: the weakest and strongest of the models' daily maxima. */
    range?: [number, number] | null;
    /** DIR: two or more models, but the wind too light to judge direction. */
    calm?: boolean;
}

/** Spread among the models with a value at hour i, and their median; null
 *  under two members. */
function hourStats(series: HourlySeries[], i: number, spec: ParamSpec): { spread: number; median: number } | null {
    const vals = series.map((s) => s.values[i]).filter((v): v is number => v != null);
    if (vals.length < 2) return null;
    return {
        spread: spec.circular ? circularSpread(vals) : Math.max(...vals) - Math.min(...vals),
        median: median(vals),
    };
}

const levelOf = (spread: number, param: MatrixParam, reference: number): Level =>
    LEVEL_OF[classifySpread(param, spread, reference)];

/** Agreement per local day: [0, starts[0]), [starts[0], starts[1]), … to
 *  length. WIND and DIR are the Glass day chip's own verdicts (dayAgreement):
 *  pass the WIND series as `speeds` on DIR so direction is judged only where
 *  the breeze is up. */
export function agreementByDay(
    series: HourlySeries[],
    starts: number[],
    length: number,
    param: MatrixParam,
    speeds?: HourlySeries[],
): DayAgreement[] {
    if (param === 'wind' || param === 'dir') {
        const wind = param === 'wind';
        return windAgreementForDays(wind ? series : (speeds ?? []), wind ? [] : series, starts, length).map(
            (d): DayAgreement => {
                const level = wind ? d.speedLevel : d.dirLevel;
                if (!level)
                    return {
                        variance: null,
                        level: 'none',
                        members: d.members,
                        thin: false,
                        ...(!wind && d.members >= 2 ? { calm: true } : {}),
                    };
                return {
                    variance: wind ? d.speedSpread : d.dirSpread,
                    level: LEVEL_OF[level],
                    members: d.members,
                    thin: d.thin,
                    peak: d.peak,
                    ...(wind ? { range: d.speedRange } : {}),
                };
            },
        );
    }
    const spec = specFor(param);
    const counts = memberCounts(series, length);
    const peak = Math.max(0, ...counts);
    const bounds = [0, ...starts, length];
    return bounds.slice(1).map((end, d) => {
        let sum = 0;
        let ref = 0;
        let n = 0;
        let fewest = Infinity;
        let most = 0;
        for (let i = bounds[d]; i < end; i++) {
            most = Math.max(most, counts[i]);
            const stats = hourStats(series, i, spec);
            if (stats) {
                sum += stats.spread;
                ref += stats.median;
                n++;
                fewest = Math.min(fewest, counts[i]);
            }
        }
        if (!n) return { variance: null, level: 'none', members: most, thin: false };
        const variance = sum / n;
        return {
            variance,
            level: levelOf(variance, param, ref / n),
            members: fewest,
            thin: fewest < Math.min(THIN_BELOW, peak),
            peak,
        };
    });
}

/** The headline: mean spread over the hours from `fromMs` to 72 h on that
 *  have two or more members. Null when no hour can be compared (one model). */
export function nearTermAgreement(
    series: HourlySeries[],
    times: number[],
    fromMs: number,
    param: MatrixParam,
): { variance: number; level: Level } | null {
    const spec = specFor(param);
    let sum = 0;
    let ref = 0;
    let n = 0;
    times.forEach((t, i) => {
        if (t + HOUR_MS <= fromMs || t >= fromMs + NEAR_TERM_MS) return;
        const stats = hourStats(series, i, spec);
        if (stats) {
            sum += stats.spread;
            ref += stats.median;
            n++;
        }
    });
    return n ? { variance: sum / n, level: levelOf(sum / n, param, ref / n) } : null;
}

const LEVEL_RANK: Record<Level, number> = { high: 0, moderate: 1, low: 2 };

/**
 * WIND and DIR: the headline is the worst day bar among the local days the
 * next three days touch (from `fromMs`), so it can never read better than a
 * bar beneath it (an hourly average let a one-hour squall vanish, and called
 * light-air bearings a disagreement). `calm`: every such day with members
 * was too light to judge a direction. `bounds` is [0, ...dayStarts, length].
 */
export function nearTermDayVerdict(
    days: DayAgreement[],
    bounds: number[],
    times: number[],
    fromMs: number,
): { day: number; agreement: DayAgreement & { level: Level } } | { calm: true } | null {
    let worst: { day: number; agreement: DayAgreement & { level: Level } } | null = null;
    let calm = false;
    days.forEach((d, k) => {
        const start = times[bounds[k]];
        const end = bounds[k + 1] < times.length ? times[bounds[k + 1]] : times[times.length - 1] + HOUR_MS;
        if (end <= fromMs || start >= fromMs + NEAR_TERM_MS) return;
        if (d.level === 'none') {
            calm ||= !!d.calm;
            return;
        }
        const level = d.level;
        if (
            !worst ||
            LEVEL_RANK[level] > LEVEL_RANK[worst.agreement.level] ||
            (level === worst.agreement.level && (d.variance ?? 0) > (worst.agreement.variance ?? 0))
        )
            worst = { day: k, agreement: { ...d, level } };
    });
    return worst ?? (calm ? { calm: true } : null);
}

/** "1 model", "7 models". */
const models = (n: number) => `${n} model${n === 1 ? '' : 's'}`;

/** A day's members in words: "7 models", or "5 of 7 models" once runs have
 *  ended (agreement among fewer can only look tighter), "only" when thin. */
const memberWords = (c: DayAgreement) =>
    c.peak && c.members < c.peak ? `${c.thin ? 'only ' : ''}${c.members} of ${models(c.peak)}` : models(c.members);

// ── Chart geometry ──

const CHART_W = 320;
const CHART_H = 140;
const CHART_PAD_L = 38; // room for three-digit hPa ticks at the raised label size
const CHART_PAD_R = 12;
const CHART_PAD_T = 12;
const CHART_PAD_B = 20;
const PLOT_W = CHART_W - CHART_PAD_L - CHART_PAD_R;
const PLOT_H = CHART_H - CHART_PAD_T - CHART_PAD_B;
/** The agreement row: one coloured bar under each local day. */
const AGREE_H = 6;
/** The member strip: count numerals above bars whose height is the count. */
const STRIP_H = 24;
const STRIP_BAR_MAX = 12;
const COMPASS = ['N', 'E', 'S', 'W'];
const LEVEL_FILL: Record<DayAgreement['level'], string> = {
    none: 'fill-white/10',
    high: 'fill-emerald-400/60',
    moderate: 'fill-amber-400/60',
    low: 'fill-red-400/60',
};
/** The Glass day chip's glyphs: one picture per verdict on both surfaces. */
const LEVEL_ICON: Record<Level, string> = {
    high: AGREEMENT_GLYPH.agree,
    moderate: AGREEMENT_GLYPH.some,
    low: AGREEMENT_GLYPH.split,
};
const LEVEL_TEXT: Record<Level, string> = { high: 'text-emerald-400', moderate: 'text-amber-400', low: 'text-red-400' };
const LEVEL_DISC: Record<Level, string> = {
    high: 'bg-emerald-500/20',
    moderate: 'bg-amber-500/20',
    low: 'bg-red-500/20',
};

// ── Component ──

export const ModelComparisonMatrix: React.FC<Props> = React.memo(
    ({ visible, onClose, selectedModel, initialParam, initialDay, coordinates }) => {
        const portalTarget = usePanePortalTarget();
        const storeCoords = useLocationCoords();
        const lat = coordinates?.lat ?? storeCoords.lat;
        const lon = coordinates?.lon ?? storeCoords.lon;
        const [spread, setSpread] = useState<ModelSpreadResult | null>(null);
        const [isLoading, setIsLoading] = useState(false);
        const [failed, setFailed] = useState(false);
        const [param, setParam] = useState<MatrixParam>('wind');
        const closeButtonRef = useRef<HTMLButtonElement>(null);
        const dialogRef = useFocusTrap<HTMLDivElement>(visible, {
            initialFocusRef: closeButtonRef,
            onEscape: onClose,
        });
        // "Now" for the legend's values — fixed per open so tab switches agree.
        const [nowMs, setNowMs] = useState(() => Date.now());

        // Land on the long-pressed metric's tab each time the sheet opens.
        useEffect(() => {
            if (visible) {
                setParam(initialParam ?? 'wind');
                setNowMs(Date.now());
            }
        }, [visible, initialParam]);

        useEffect(() => {
            if (!visible) return;
            if (lat == null || lon == null) return;

            let cancelled = false;
            setIsLoading(true);
            setFailed(false);

            queryModelSpread(lat, lon)
                .then((result) => {
                    if (cancelled) return;
                    setSpread(result);
                    if (!result.atmos && !result.marine) setFailed(true);
                })
                .catch(() => {
                    if (!cancelled) setFailed(true);
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });

            return () => {
                cancelled = true;
            };
        }, [visible, lat, lon]);

        const spec = specFor(param);
        const timeZone = useMemo(() => (lat == null || lon == null ? 'UTC' : resolveTimeZone(lat, lon)), [lat, lon]);
        const { times, series } = useMemo(() => seriesFor(spread, param), [spread, param]);
        const dayStarts = useMemo(() => localDayStarts(times, timeZone), [times, timeZone]);
        // DIR is judged only where the breeze is up, so it needs the WIND series too.
        const speeds = useMemo(() => (param === 'dir' ? seriesFor(spread, 'wind').series : undefined), [spread, param]);
        const days = useMemo(
            () => agreementByDay(series, dayStarts, times.length, param, speeds),
            [series, dayStarts, times.length, param, speeds],
        );
        const runs = useMemo(() => countRuns(memberCounts(series, times.length)), [series, times.length]);

        // Y-axis range across every model's hours. Direction gets a 360° window
        // round the models' mean bearing, so lines that agree near north stay
        // whole in the middle instead of splitting across both edges.
        const { minY, maxY, ticks, plotted } = useMemo(() => {
            const flat = series.flatMap((s) => s.values).filter((v): v is number => v != null);
            if (spec.circular) {
                // Centred on the compass point nearest the mean: the seam stays at
                // least 135° from the consensus and the ticks are always five.
                const lo = Math.round(circularMean(flat) / 90) * 90 - 180;
                return {
                    minY: lo,
                    maxY: lo + 360,
                    ticks: [0, 1, 2, 3, 4].map((k) => lo + 90 * k),
                    plotted: series.map((s) => s.values.map((v) => (v == null ? null : intoWindow(v, lo)))),
                };
            }
            const rawMin = flat.length ? Math.min(...flat) : spec.padMin;
            const rawMax = flat.length ? Math.max(...flat) : spec.padMax;
            // Pad degenerate ranges so a flat consensus doesn't collapse the chart
            const mid = (rawMin + rawMax) / 2;
            const lo = Math.min(rawMin, mid - spec.tickStep / 2);
            const hiV = Math.max(rawMax, mid + spec.tickStep / 2);
            const min = Math.floor(lo / spec.tickStep) * spec.tickStep;
            const max = Math.ceil(hiV / spec.tickStep) * spec.tickStep;
            const tickCount = Math.min(5, Math.max(2, Math.round((max - min) / spec.tickStep) + 1));
            const step = (max - min) / (tickCount - 1);
            const tickArr = Array.from({ length: tickCount }, (_, i) => min + i * step);
            return { minY: min, maxY: max, ticks: tickArr, plotted: series.map((s) => s.values) };
        }, [series, spec]);

        if (!visible) return null;

        const isSelected = (s: HourlySeries) => s.id === selectedModel;
        const hasData = series.length > 0;
        // A leg the servers never answered is "unavailable", not "no model publishes".
        const blockFailed = failed || !!spread?.unreachable?.includes(spec.block);
        // The pinned model is drawn last, so it sits on top.
        const drawOrder = series
            .map((s, k) => ({ s, values: plotted[k] }))
            .sort((a, b) => Number(isSelected(a.s)) - Number(isSelected(b.s)));

        // Time → x across the block's hours; value → y.
        const t0 = times[0] ?? 0;
        const span = (times[times.length - 1] ?? 0) - t0 || 1;
        const xOf = (t: number) => CHART_PAD_L + ((t - t0) / span) * PLOT_W;
        const yOf = (v: number) => CHART_PAD_T + PLOT_H - ((v - minY) / (maxY - minY || 1)) * PLOT_H;
        const weekday = zoneFormat(timeZone, { weekday: 'short' });
        const atHour = zoneFormat(timeZone, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        // Local days as [start, end) hour ranges, for the axis and the day bars.
        const dayBounds = [0, ...dayStarts, times.length];
        const dayName = (d: number) => weekday.format(times[dayBounds[d]]);
        /** x of the k-th day boundary (the last is the chart's right edge). */
        const dayX = (k: number) => (dayBounds[k] < times.length ? xOf(times[dayBounds[k]]) : CHART_W - CHART_PAD_R);
        // The day a Glass card asked for (W1-09): the local day holding initialDay.
        const shownDay =
            initialDay == null || !times.length
                ? -1
                : dayBounds.slice(0, -1).findIndex((start, d) => {
                      const end = dayBounds[d + 1];
                      return (
                          initialDay >= times[start] &&
                          initialDay < (end < times.length ? times[end] : times[times.length - 1] + HOUR_MS)
                      );
                  });
        const dayLong = zoneFormat(timeZone, { weekday: 'short', day: 'numeric', month: 'short' });

        // Members per hour: the strip's bars, sized by count, on the hours' own scale.
        const maxCount = Math.max(1, ...runs.map((r) => r.count));
        const hourX = (i: number) => CHART_PAD_L + (i / Math.max(1, times.length)) * PLOT_W;
        const stripLabel = `Models with data: ${runs
            .map((r, k) => (k === 0 ? `${r.count} from the start` : `${r.count} from ${atHour.format(times[r.start])}`))
            .join(', ')}`;

        // Each provider on screen, credited under its own licence.
        const credit = forecastDataCredit(
            series.map((s) => s.provider),
            'Data via Open-Meteo',
        );

        // The headline covers the next three days; the day bars carry the rest.
        // WIND and DIR take their worst near bar (the chip's verdicts), the
        // other tabs the mean hourly spread.
        const windish = param === 'wind' || param === 'dir';
        const nearDay = windish ? nearTermDayVerdict(days, dayBounds, times, nowMs) : null;
        const worstDay = nearDay && 'day' in nearDay ? nearDay : null;
        const verdict = windish ? null : nearTermAgreement(series, times, nowMs, param);
        const overallLevel = windish ? worstDay?.agreement.level : verdict?.level;
        const overallColor = overallLevel ? LEVEL_TEXT[overallLevel] : 'text-red-400';
        const overallLabel = !overallLevel
            ? series.length === 1
                ? `Only ${series[0].label} publishes ${spec.short} here, so there is nothing to compare`
                : nearDay && 'calm' in nearDay
                  ? 'The wind is too light over the next 3 days for its direction to matter'
                  : 'Too few models overlap to compare'
            : overallLevel === 'high'
              ? 'Strong agreement'
              : overallLevel === 'moderate'
                ? 'Some divergence'
                : 'Models disagree';
        /** A day bar's words: its level, and its member count when thin or alone. */
        const dayWords = (c: DayAgreement, d: number, spreadText = false) =>
            `${dayName(d)}: ${
                c.level === 'none'
                    ? c.calm
                        ? 'light wind'
                        : c.members
                          ? models(c.members)
                          : 'no data'
                    : `${spreadText ? `±${c.variance!.toFixed(spec.decimals)}` : c.level}${c.thin ? `, only ${models(c.members)}` : ''}`
            }`;

        /** A day's spread in words: the strongest hours' range on WIND. */
        const spreadWords = (c: DayAgreement) =>
            c.variance == null
                ? ''
                : param === 'wind' && c.range
                  ? `strongest ${Math.round(c.range[0])}–${Math.round(c.range[1])} ${spec.unit}`
                  : `±${c.variance.toFixed(spec.decimals)} ${spec.unit || 'idx'}`;
        const overallDetail = worstDay
            ? `Worst of 3 days: ${[
                  dayName(worstDay.day),
                  spreadWords(worstDay.agreement),
                  memberWords(worstDay.agreement),
              ]
                  .filter(Boolean)
                  .join(' · ')}`
            : verdict
              ? `3-day avg spread ±${verdict.variance.toFixed(spec.decimals)} ${spec.unit || 'idx'}`
              : '';

        // The asked-for day's verdict, in the Glass chip's words, heads the
        // sheet in place of the three-day headline.
        const shown = shownDay >= 0 ? days[shownDay] : undefined;
        const shownName = shown ? dayLong.format(times[dayBounds[shownDay]]) : '';
        const shownSpread = shown ? spreadWords(shown) : '';
        const shownCount = shown ? memberWords(shown) : '';

        /** Tick label — compass points for direction. */
        const tickLabel = (t: number) => (spec.circular ? COMPASS[(((t / 90) % 4) + 4) % 4] : t.toFixed(spec.decimals));

        return createPortal(
            <div
                className="fixed inset-0 z-9999 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
                onClick={onClose}
                role="presentation"
            >
                {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal={portalTarget?.tagName === 'BODY' ? true : undefined}
                    aria-labelledby="model-comparison-title"
                    className="w-full max-w-lg bg-slate-900/95 border border-white/8 rounded-3xl shadow-2xl max-h-full overflow-y-auto animate-in fade-in zoom-in-95 duration-300"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Accent glow */}
                    <div className="h-[2px] bg-linear-to-r from-transparent via-sky-500/60 to-transparent" />

                    {/* Header */}
                    <div className="flex items-center justify-between px-5 pt-3 pb-2">
                        <div>
                            <h2
                                id="model-comparison-title"
                                className="text-sm font-black text-white uppercase tracking-wider flex items-center gap-2"
                            >
                                Model Convergence
                                {isLoading && (
                                    <span className="w-3 h-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
                                )}
                            </h2>
                            <p className="text-[11px] text-gray-400 mt-0.5">
                                10 days · {hasData ? `${series.length} ` : ''}
                                {spec.block === 'marine' ? 'wave ' : ''}
                                {series.length === 1 ? 'model' : 'models'}
                            </p>
                        </div>
                        <button
                            ref={closeButtonRef}
                            onClick={onClose}
                            aria-label="Close"
                            className="hit-target-44 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>

                    {/* Parameter tabs — one per grid metric, horizontally scrollable */}
                    <div className="px-5 pb-2">
                        <div className="flex items-center gap-1 bg-white/4 border border-white/6 rounded-xl p-1 overflow-x-auto no-scrollbar">
                            {PARAMS.map((p) => {
                                const active = p.id === param;
                                return (
                                    <button
                                        key={p.id}
                                        aria-pressed={active}
                                        onClick={() => setParam(p.id)}
                                        className={`px-2.5 py-1.5 min-h-[44px] rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${
                                            active
                                                ? 'bg-sky-500/20 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.2)]'
                                                : 'text-gray-500 hover:text-gray-300'
                                        }`}
                                    >
                                        {p.short}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Chart / empty states */}
                    <div className="px-5 pb-3">
                        {hasData ? (
                            <>
                                <svg
                                    viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                                    className="w-full h-auto overflow-visible"
                                    role="img"
                                    aria-label={`${spec.short} from ${models(series.length)}, hourly for ten days`}
                                >
                                    {/* Y-axis ticks + horizontal grid */}
                                    {ticks.map((t, i) => {
                                        const y = yOf(t);
                                        return (
                                            <g key={i}>
                                                <line
                                                    x1={CHART_PAD_L}
                                                    y1={y}
                                                    x2={CHART_W - CHART_PAD_R}
                                                    y2={y}
                                                    stroke="var(--day-ui-grid, rgba(255,255,255,0.06))"
                                                    strokeDasharray="2 3"
                                                />
                                                <text
                                                    x={CHART_PAD_L - 5}
                                                    y={y + 3}
                                                    textAnchor="end"
                                                    className="fill-gray-400"
                                                    style={{ fontSize: '11px', fontFamily: 'monospace' }}
                                                >
                                                    {tickLabel(t)}
                                                </text>
                                            </g>
                                        );
                                    })}

                                    {/* The unit, in the corner under the value axis */}
                                    <text
                                        x={CHART_PAD_L - 5}
                                        y={CHART_H - 4}
                                        textAnchor="end"
                                        className="fill-gray-500"
                                        style={{ fontSize: '11px', fontFamily: 'monospace' }}
                                    >
                                        {spec.circular ? '' : spec.unit}
                                    </text>

                                    {/* Local midnights, and each day's name centred in its span */}
                                    {dayBounds.slice(0, -1).map((start, d) => {
                                        const left = dayX(d);
                                        const right = dayX(d + 1);
                                        return (
                                            <g key={start}>
                                                {d > 0 && (
                                                    <line
                                                        x1={left}
                                                        y1={CHART_PAD_T}
                                                        x2={left}
                                                        y2={CHART_PAD_T + PLOT_H}
                                                        stroke="var(--day-ui-grid, rgba(255,255,255,0.06))"
                                                    />
                                                )}
                                                {right - left >= 22 && (
                                                    <text
                                                        x={(left + right) / 2}
                                                        y={CHART_H - 4}
                                                        textAnchor="middle"
                                                        className="fill-gray-400"
                                                        style={{
                                                            fontSize: '11px',
                                                            fontFamily: 'monospace',
                                                            fontWeight: 700,
                                                        }}
                                                    >
                                                        {dayName(d)}
                                                    </text>
                                                )}
                                            </g>
                                        );
                                    })}

                                    {/* The day a Glass card asked for, banded behind the lines */}
                                    {shownDay >= 0 && (
                                        <rect
                                            data-selected-day
                                            x={dayX(shownDay)}
                                            y={CHART_PAD_T}
                                            width={Math.max(0, dayX(shownDay + 1) - dayX(shownDay))}
                                            height={PLOT_H}
                                            className="fill-sky-400/10"
                                        />
                                    )}

                                    {/* Model lines — a missing hour is a gap, never joined */}
                                    {drawOrder.map(({ s, values }) => (
                                        <path
                                            key={s.id}
                                            data-model={s.id}
                                            d={chartPath(times, values, xOf, yOf, spec.circular)}
                                            stroke={s.hex}
                                            strokeWidth={isSelected(s) ? 2.5 : 1.25}
                                            strokeOpacity={isSelected(s) ? 1 : 0.6}
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            fill="none"
                                            style={
                                                isSelected(s) ? { filter: `drop-shadow(0 0 4px ${s.hex})` } : undefined
                                            }
                                        />
                                    ))}
                                </svg>

                                {/* Agreement by day, a bar under each day's name; a day left
                                    with few members is drawn thin. Nothing to agree with one model. */}
                                {series.length > 1 && (
                                    <svg
                                        viewBox={`0 0 ${CHART_W} ${AGREE_H}`}
                                        className="w-full h-auto"
                                        role="img"
                                        aria-label={`Agreement by day — ${days.map((c, d) => dayWords(c, d)).join(', ')}`}
                                    >
                                        {days.map((c, d) => (
                                            <rect
                                                key={d}
                                                data-thin={c.thin || undefined}
                                                data-selected={d === shownDay || undefined}
                                                stroke={d === shownDay ? 'rgb(125 211 252)' : undefined}
                                                strokeWidth={d === shownDay ? 0.75 : undefined}
                                                x={dayX(d) + 1}
                                                y={c.thin ? 2 : 1}
                                                width={Math.max(0, dayX(d + 1) - dayX(d) - 2)}
                                                height={c.thin ? 2 : AGREE_H - 2}
                                                rx={1}
                                                className={LEVEL_FILL[c.level]}
                                            >
                                                <title>{dayWords(c, d, true)}</title>
                                            </rect>
                                        ))}
                                    </svg>
                                )}

                                {/* Member strip — how many models have data, hour by hour */}
                                <svg
                                    viewBox={`0 0 ${CHART_W} ${STRIP_H}`}
                                    className="w-full h-auto"
                                    role="img"
                                    aria-label={stripLabel}
                                >
                                    {runs.map((r, k) => {
                                        const left = hourX(r.start);
                                        const width = hourX(r.end + 1) - left;
                                        const h = (STRIP_BAR_MAX * r.count) / maxCount;
                                        // The first run says what the numbers count.
                                        const label = k === 0 && width >= 56 ? models(r.count) : `${r.count}`;
                                        return (
                                            <g key={r.start}>
                                                <rect
                                                    data-count={r.count}
                                                    x={left}
                                                    y={STRIP_H - h}
                                                    width={Math.max(0.5, width - 0.5)}
                                                    height={h}
                                                    className="fill-sky-400/50"
                                                />
                                                {r.count > 0 && width >= 10 && (
                                                    <text
                                                        x={left + width / 2}
                                                        y={STRIP_H - STRIP_BAR_MAX - 3}
                                                        textAnchor="middle"
                                                        className="fill-gray-300"
                                                        style={{
                                                            fontSize: '11px',
                                                            fontFamily: 'monospace',
                                                            fontWeight: 700,
                                                        }}
                                                    >
                                                        {label}
                                                    </text>
                                                )}
                                            </g>
                                        );
                                    })}
                                </svg>
                            </>
                        ) : (
                            <div className="h-[120px] flex items-center justify-center text-center px-6">
                                <p className="text-[11px] text-gray-500 leading-relaxed">
                                    {isLoading
                                        ? 'Fetching model data…'
                                        : blockFailed
                                          ? 'Model data unavailable — offline or the forecast servers are unreachable.'
                                          : `No model publishes ${spec.short} here.`}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Legend: each model's value now (unit on the chart), four to a row
                        whatever the value's length, so seven models take two rows */}
                    {hasData && (
                        <div className="px-4 pb-2 grid grid-cols-4 gap-1 leading-tight">
                            {series.map((s) => {
                                const current = sampleAt(times, s.values, nowMs);
                                return (
                                    <div
                                        key={s.id}
                                        data-model-chip={s.id}
                                        className={`min-w-0 border-l-2 pl-1 pr-0.5 py-0.5 rounded-r-md ${
                                            isSelected(s) ? 'bg-white/8' : ''
                                        }`}
                                        style={{ borderColor: s.hex }}
                                    >
                                        <div
                                            className={`text-[11px] font-bold ${
                                                isSelected(s) ? 'text-white' : 'text-gray-400'
                                            }`}
                                        >
                                            {s.label}
                                        </div>
                                        <div className="text-[11px] font-mono text-gray-300 tabular-nums">
                                            {current == null ? '—' : current.toFixed(spec.decimals)}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* The asked-for day's verdict, or the summary of the next three days */}
                    {hasData && shown ? (
                        <div
                            data-testid="matrix-day-verdict"
                            className="mx-5 mb-2 px-3 py-0.5 rounded-xl bg-white/3 border border-sky-400/20 flex items-center gap-2"
                        >
                            {shown.level !== 'none' && (
                                <div
                                    className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${LEVEL_DISC[shown.level]}`}
                                >
                                    <svg
                                        className={`w-3 h-3 ${LEVEL_TEXT[shown.level]}`}
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={3}
                                        aria-hidden="true"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d={LEVEL_ICON[shown.level]}
                                        />
                                    </svg>
                                </div>
                            )}
                            {shown.level === 'none' ? (
                                <p className="flex-1 min-w-0 text-[11px] text-gray-400">
                                    {shownName}:{' '}
                                    {shown.calm
                                        ? 'the wind is too light for its direction to matter.'
                                        : shown.members
                                          ? `only ${models(shown.members)}, so there is nothing to compare.`
                                          : 'no model reaches this day.'}
                                </p>
                            ) : (
                                <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2">
                                    <span
                                        className={`text-[11px] font-black uppercase tracking-wider ${LEVEL_TEXT[shown.level]}`}
                                    >
                                        {AGREEMENT_WORDS[AGREEMENT_OF[shown.level]]}
                                    </span>
                                    <span className="text-[10px] text-gray-400">
                                        {[shownName, shownSpread, shownCount].filter(Boolean).join(' · ')}
                                    </span>
                                </div>
                            )}
                        </div>
                    ) : (
                        hasData &&
                        (overallLevel ? (
                            <div className="mx-5 mb-2 px-3 py-0.5 rounded-xl bg-white/3 border border-white/5 flex items-center gap-2">
                                <div
                                    className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${LEVEL_DISC[overallLevel]}`}
                                >
                                    <svg
                                        className={`w-3 h-3 ${overallColor}`}
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={3}
                                        aria-hidden="true"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d={LEVEL_ICON[overallLevel]}
                                        />
                                    </svg>
                                </div>
                                <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2">
                                    <span className={`text-[11px] font-black uppercase tracking-wider ${overallColor}`}>
                                        {overallLabel}
                                    </span>
                                    <span className="text-[10px] text-gray-500">{overallDetail}</span>
                                </div>
                            </div>
                        ) : (
                            <p className="mx-5 mb-2 px-3 py-0.5 text-[11px] text-gray-400 text-center">
                                {overallLabel}.
                            </p>
                        ))
                    )}

                    {/* Attribution — a licence condition, not a courtesy: the models on screen */}
                    {credit && (
                        <div className="px-5 pb-3">
                            <p data-testid="matrix-credit" className="text-[9px] text-gray-400 text-center">
                                {/* ECCC's licence asks for a link to it where possible. */}
                                {credit.split(ECCC_LICENCE).map((part, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && (
                                            <a
                                                href={ECCC_LICENCE_URL}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="underline underline-offset-2"
                                            >
                                                {ECCC_LICENCE}
                                            </a>
                                        )}
                                        {part}
                                    </React.Fragment>
                                ))}
                            </p>
                        </div>
                    )}
                </div>
            </div>,
            portalTarget!,
        );
    },
);

ModelComparisonMatrix.displayName = 'ModelComparisonMatrix';
