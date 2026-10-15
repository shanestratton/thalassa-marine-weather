/**
 * Meteogram — the point meteogram (131-02). 'All metrics' in a metric
 * deep-dive opens one stacked seven-day picture of the spot:
 *   - wind and gusts against the boat's limits, with the models' spread;
 *   - waves and their period;
 *   - rain;
 *   - pressure, red where it falls 3 hPa or more in 3 hours.
 * Nights are shaded, times are on the place's own clock (the phone's on the
 * toggle), and the model is named and credited the way the model picker
 * credits it.
 *
 * Hand-drawn SVG, no chart library, and lazy: nothing here loads until it
 * opens. The numbers are the Glass report's own hours and the comparison's
 * memoised spread for the cell (queryModelSpread, asked passively like the
 * day cards' chip), so it adds no provider and usually no request. The
 * hour-by-hour work is meteogramModel's.
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HourlyForecast, UnitPreferences } from '../../types';
import type { VesselWindowThresholds } from '../../services/vesselWindowThresholds';
import { queryModelSpread } from '../../services/weather/ModelSpreadService';
import {
    ECCC_LICENCE,
    ECCC_LICENCE_URL,
    MODEL_ATTRIBUTION_LINE,
    forecastDataCredit,
    isSpitfire,
    resolveForecastModel,
    resolveOffshoreModel,
} from '../../services/weather/forecastModels';
import { forecastCreditLine } from '../dashboard/ModelPickerSheet';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { resolveTimeZone } from '../../utils/timezone';
import { convertLength, convertSpeed } from '../../utils/units';
import { OverlayPortal } from '../ui/OverlayPortal';
import { Button } from '../ui/Button';
import { XIcon } from '../Icons';
import {
    HOUR_MS,
    METEOGRAM_HOURS as HOURS,
    FAST_FALL_HPA,
    alignHourly,
    bandPath,
    bareClock,
    barsPath,
    dayMarks,
    epochHour,
    fastFallPath,
    firstAtOrOver,
    fitDayLabels,
    forecastEnd,
    formatHour,
    linePath,
    niceTop,
    nightSpans,
    spreadBand,
    steepestFall,
    tendencyNow,
    threeHourChange,
    yScale,
    zoneName,
    zoneOffsetSeconds,
    type HourValues,
    type PlacedDay,
    type SpreadBand,
} from './meteogramModel';

export interface MeteogramProps {
    onClose: () => void;
    /** The Glass report's hours, in the app's raw units (knots, feet, mm, hPa). */
    hourly: HourlyForecast[];
    units: UnitPreferences;
    /** The boat's limits, raw units: the deep-dive's own vessel-aware thresholds. */
    limits: VesselWindowThresholds;
    coordinates?: { lat: number; lon: number };
    /** The report's zone and UTC offset: the place's clock, and how its bare stamps read. */
    timeZone?: string;
    utcOffset?: number;
    /** The Glass is on an offshore (StormGlass) source: credited as the picker credits it. */
    offshore?: boolean;
}

type Tone = 'warn' | 'ok' | 'muted';
const TONE: Record<Tone, string> = { warn: 'text-red-300', ok: 'text-emerald-300', muted: 'text-white/60' };
const read = (text: string, tone: Tone = 'muted') => ({ text, tone });

const WIND = 'var(--day-ui-success, #6ee7b7)';
const AMBER = 'var(--day-ui-amber, #fcd34d)';
const RED = '#f87171';
/** The scrub's keys: an hour a press, a day a page. */
const STEP: Record<string, number> = {
    ArrowRight: 1,
    ArrowUp: 1,
    ArrowLeft: -1,
    ArrowDown: -1,
    PageUp: 24,
    PageDown: -24,
};
/** A scale label in a plot's corner, legible over the lines. */
const TAG = 'absolute text-[10px] leading-3 text-white/60 bg-slate-900/70 rounded px-0.5';
/** A day's name over the panels; also the probe the row measures names in. */
const DAY_NAME = 'absolute text-[11px] font-bold text-white/70 whitespace-nowrap leading-4';
/** A touch reads an hour once it is plainly a sideways drag, or held this
 *  long: the start of a scroll is neither (131-02 review). */
const HOLD_MS = 250;
const SIDEWAYS_PX = 6;

/** A finger on the panels: where it went down and is now, and whether it reads yet. */
interface Press {
    id: number;
    x: number;
    x0: number;
    y0: number;
    reading: boolean;
    /** The hold timer. */
    hold: number;
}

const f1 = (n: number) => Math.round(n * 10) / 10;
const maxOf = (...series: (HourValues | undefined)[]) =>
    Math.max(0, ...series.flatMap((s) => (s ?? []).filter((v): v is number => v !== null)));

interface PlotLine {
    d: string;
    stroke: string;
    width?: number;
    dash?: string;
    opacity?: number;
    /** Plot y of a limit: the line is drawn again in red above it. */
    overY?: number;
}

interface Panel {
    key: string;
    title: string;
    /** The panel's word for its forecast when there is none ('No wave forecast'). */
    what: string;
    read: { text: string; tone: Tone };
    /** The reading at an hour, for the scrub. */
    at: (i: number) => string;
    end: number | null;
    top: string;
    bottom: string;
    topRight?: string;
    band?: string;
    bars?: string;
    lines: PlotLine[];
    limits: { y: number; stroke: string; dash: string }[];
}

/** One panel's plot, from now (its left edge) on: nights, midnights, the
 *  beyond-forecast stretch, then the data. */
const Plot: React.FC<{ panel: Panel; uid: string; nights: string; midnights: string }> = React.memo(
    ({ panel, uid, nights, midnights }) => {
        const clip = (i: number) => `${uid}-${panel.key}-${i}`;
        const stroke = { fill: 'none', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' } as const;
        return (
            <svg
                viewBox={`0 0 ${HOURS} 100`}
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full"
                aria-hidden="true"
            >
                <defs>
                    {panel.lines.map((l, i) =>
                        l.overY === undefined ? null : (
                            <clipPath key={i} id={clip(i)}>
                                <rect width={HOURS} height={Math.max(0, l.overY)} />
                            </clipPath>
                        ),
                    )}
                </defs>
                <path d={nights} fill="#000" opacity={0.3} data-night="" />
                <path d={midnights} {...stroke} stroke="var(--day-ui-grid, #fff)" strokeOpacity={0.12} />
                {panel.end !== null && (
                    <rect x={panel.end} width={HOURS - panel.end} height={100} fill="#94a3b8" opacity={0.14} />
                )}
                {panel.band && <path d={panel.band} fill={WIND} opacity={0.2} />}
                {panel.bars && <path d={panel.bars} fill="#38bdf8" opacity={0.85} />}
                {panel.limits.map((l, i) => (
                    <path key={i} d={`M0 ${l.y}H${HOURS}`} {...stroke} stroke={l.stroke} strokeDasharray={l.dash} />
                ))}
                {panel.lines.map((l, i) => (
                    <React.Fragment key={i}>
                        <path
                            d={l.d}
                            {...stroke}
                            stroke={l.stroke}
                            strokeWidth={l.width ?? 1.5}
                            strokeDasharray={l.dash}
                            strokeOpacity={l.opacity}
                        />
                        {l.overY !== undefined && (
                            <path
                                d={l.d}
                                {...stroke}
                                stroke={RED}
                                strokeWidth={l.width ?? 1.5}
                                strokeDasharray={l.dash}
                                clipPath={`url(#${clip(i)})`}
                            />
                        )}
                    </React.Fragment>
                ))}
            </svg>
        );
    },
);
Plot.displayName = 'MeteogramPlot';

export const Meteogram: React.FC<MeteogramProps> = ({
    onClose,
    hourly,
    units,
    limits,
    coordinates,
    timeZone,
    utcOffset,
    offshore,
}) => {
    const closeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: closeRef, onEscape: onClose });
    const titleId = useId();
    const uid = `mg${useId().replace(/[^\w-]/g, '')}`;
    const scrubRef = useRef<HTMLDivElement>(null);
    const [nowMs] = useState(() => Date.now());
    const startMs = epochHour(nowMs) * HOUR_MS;

    const lat = coordinates?.lat;
    const lon = coordinates?.lon;
    // 0°, 0° is the optimistic stub of a location still being geocoded.
    const placed =
        lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
    const placeZone = useMemo(
        () => (placed ? resolveTimeZone(lat!, lon!, timeZone) : timeZone || undefined),
        [placed, lat, lon, timeZone],
    );
    const [phoneClock, setPhoneClock] = useState(false);
    // undefined is the phone's own clock throughout meteogramModel.
    const clock = phoneClock ? undefined : placeZone;

    const grid = useMemo(() => alignHourly(hourly, startMs, HOURS, bareClock(utcOffset)), [hourly, startMs, utcOffset]);
    const nights = useMemo(
        () =>
            (placed ? nightSpans(startMs, HOURS, lat!, lon!) : [])
                .map((n) => `M${f1(n.from)} 0H${f1(n.to)}V100H${f1(n.from)}Z`)
                .join(''),
        [placed, startMs, lat, lon],
    );
    const days = useMemo(() => dayMarks(startMs, HOURS, clock), [startMs, clock]);
    const midnights = useMemo(() => days.midnights.map((m) => `M${m} 0V100`).join(''), [days]);

    // The day names the row has room for, measured in the face it draws them
    // in: a narrow phone or a wide font gets the weekdays alone, and a part
    // day gives way, rather than two names overlapping (131-02 review).
    // Unmeasured (no layout yet), every name is drawn centred on its day.
    const daysRef = useRef<HTMLDivElement>(null);
    const [dayFit, setDayFit] = useState<PlacedDay[] | null>(null);
    useLayoutEffect(() => {
        const row = daysRef.current;
        if (!row) return;
        let live = true;
        const measure = () => {
            const width = live ? row.getBoundingClientRect().width : 0;
            if (!(width > 0)) return setDayFit(null);
            const probe = document.createElement('span');
            probe.className = DAY_NAME;
            probe.style.visibility = 'hidden';
            row.append(probe);
            const widths = new Map<string, number>();
            const widthOf = (text: string) => {
                if (!widths.has(text)) {
                    probe.textContent = text;
                    widths.set(text, probe.getBoundingClientRect().width);
                }
                return widths.get(text)!;
            };
            const fit = fitDayLabels(days.labels, HOURS, width, widthOf);
            probe.remove();
            setDayFit(fit);
        };
        measure();
        // Measured again once the face has loaded, and whenever the row resizes.
        document.fonts?.ready.then(() => live && measure()).catch(() => {});
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => live && measure());
        observer?.observe(row);
        return () => {
            live = false;
            observer?.disconnect();
        };
    }, [days]);

    // The models' wind spread, from the comparison's memoised answer for the
    // cell. Passive, as the day cards ask: never a retry storm, nothing offline.
    const isOffline = useUIStore((s) => s.isOffline);
    const [spread, setSpread] = useState<SpreadBand | null>(null);
    useEffect(() => {
        if (!placed || isOffline) return;
        let live = true;
        queryModelSpread(lat!, lon!, { passive: true })
            .then((answer) => {
                if (live) setSpread(spreadBand(answer.atmos, startMs, HOURS));
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [placed, isOffline, lat, lon, startMs]);

    // The model, named and credited the way the model picker does it. Auto
    // and Spitfire have no single grid to name, so the choice is named above
    // the full attribution line.
    const forecastModel = resolveForecastModel(useSettingsStore((s) => s.settings.forecastModel));
    const offshoreModel = resolveOffshoreModel(useSettingsStore((s) => s.settings.offshoreModel));
    const credit = forecastCreditLine(forecastModel, offshore ? offshoreModel : undefined);
    const blendName =
        credit !== MODEL_ATTRIBUTION_LINE
            ? null
            : isSpitfire(forecastModel)
              ? 'Forecast: Spitfire, a weighted blend of models'
              : 'Forecast: Auto, a blend of sources';
    const spreadCredit = spread ? forecastDataCredit(spread.providers, 'Model spread via Open-Meteo') : null;

    const panels = useMemo((): Panel[] => {
        const s = grid.series;
        const at = (i: number) => formatHour(startMs + i * HOUR_MS, clock);
        // The window opens on the hour now is in: a limit reached there is reached now.
        const when = (i: number) => (i === 0 ? 'now' : at(i));
        const show = (v: number | null, f: (n: number) => string) => (v === null ? '--' : f(v));
        const speedUnit = units.speed || 'kts';
        const seaUnit = units.waveHeight || 'm';
        const inches = units.temp === 'F';
        const rainUnit = inches ? 'in' : 'mm';
        const speedFactor = (convertSpeed(100, speedUnit) ?? 100) / 100;
        const seaFactor = (convertLength(100, seaUnit) ?? 100) / 100;
        const rainFactor = inches ? 0.0393701 : 1;
        const speed = (kt: number) => `${Math.round(kt * speedFactor)}`;
        const sea = (ft: number) => `${f1(ft * seaFactor)}`;
        const rain = (mm: number) => (inches ? (mm * rainFactor).toFixed(2) : `${mm < 10 ? f1(mm) : Math.round(mm)}`);
        /** An hour with nothing: past the forecast's end, or a gap in it. */
        const none = (end: number | null, i: number) => (end !== null && i >= end ? 'No forecast' : '--');
        const nothing = (what: string) => read(`No ${what} forecast for this spot`);
        const reaches = (who: string, limit: string, i: number) =>
            read(`${who} your ${limit} limit ${when(i)}`, 'warn');

        // ── Wind and gusts, against the boat's limits, with the models' spread ──
        const { wind, gust } = s;
        const windEnd = forecastEnd(HOURS, wind, gust);
        const windTop = niceTop(maxOf(wind, gust, spread?.hi, [limits.wind.poor, limits.gust.poor]), speedFactor, 5);
        const yw = yScale(0, windTop);
        const windOver = firstAtOrOver(wind, limits.wind.poor);
        const gustOver = firstAtOrOver(gust, limits.gust.poor);
        const windLimit = `${speed(limits.wind.poor)} ${speedUnit}`;
        // Whichever limit the week reaches FIRST: gusts at your limit on
        // Saturday are not hidden behind the wind reaching its own on Monday
        // (131-02 review). Both in the same hour reads as the wind's.
        const gustsFirst = gustOver !== null && (windOver === null || gustOver < windOver);
        const windRead =
            windEnd === 0
                ? nothing('wind')
                : gustsFirst
                  ? reaches('Gusts reach', `${speed(limits.gust.poor)} ${speedUnit}`, gustOver)
                  : windOver !== null
                    ? reaches('Reaches', windLimit, windOver)
                    : read(`Within your limits (${windLimit}, gusts ${speed(limits.gust.poor)})`, 'ok');

        // ── Waves and period ──
        const { wave, period } = s;
        const seaEnd = forecastEnd(HOURS, wave, period);
        const seaTop = niceTop(maxOf(wave, [limits.wave.poor]), seaFactor, seaUnit === 'ft' ? 2 : 0.5);
        const periodTop = niceTop(maxOf(period), 1, 5);
        const ys = yScale(0, seaTop);
        const waveOver = firstAtOrOver(wave, limits.wave.poor);
        const waveLimit = `${sea(limits.wave.poor)} ${seaUnit}`;
        const seaRead =
            seaEnd === 0
                ? nothing('wave')
                : waveOver !== null
                  ? reaches('Reaches', waveLimit, waveOver)
                  : read(`Within your ${waveLimit} limit`, 'ok');

        // ── Rain: the hour's amount as bars, its chance as a line ──
        const { rain: mm, rainChance } = s;
        const rainEnd = forecastEnd(HOURS, mm, rainChance);
        const rainTop = niceTop(Math.max(1, maxOf(mm)), rainFactor, inches ? 0.05 : 1);
        const wettest = mm.reduce<number>((best, v, i) => (v !== null && v > (mm[best] ?? 0) ? i : best), 0);
        const rainRead =
            rainEnd === 0
                ? nothing('rain')
                : (mm[wettest] ?? 0) > 0
                  ? read(`Wettest hour ${at(wettest)}, ${rain(mm[wettest]!)} ${rainUnit}`)
                  : read('No rain in the forecast');

        // ── Pressure and its trend ──
        const { pressure } = s;
        const pEnd = forecastEnd(HOURS, pressure);
        const ps = pressure.filter((v): v is number => v !== null);
        const pLo = ps.length ? Math.floor((Math.min(...ps) - 1) / 5) * 5 : 1000;
        const pHi = Math.max(pLo + 10, ps.length ? Math.ceil((Math.max(...ps) + 1) / 5) * 5 : 1020);
        const yp = yScale(pLo, pHi);
        const change = threeHourChange(pressure);
        const fall = steepestFall(pressure);
        const trend = tendencyNow(pressure);
        const pressureRead =
            pEnd === 0
                ? nothing('pressure')
                : fall && fall.hpa <= -FAST_FALL_HPA
                  ? read(`Falls ${f1(-fall.hpa)} hPa in 3 h to ${at(fall.hour)}`, 'warn')
                  : read(
                        `${pressure[0] !== null ? `${Math.round(pressure[0])} hPa now` : 'No reading for this hour'}${trend ? `, ${trend.toLowerCase()}` : ''}`,
                    );

        return [
            {
                key: 'wind',
                title: 'Wind and gusts',
                what: 'wind',
                read: windRead,
                end: windEnd,
                at: (i) =>
                    wind[i] === null && gust[i] === null
                        ? none(windEnd, i)
                        : `${show(wind[i], speed)} ${speedUnit}${gust[i] !== null ? `, gust ${speed(gust[i]!)}` : ''}`,
                top: `${speed(windTop)} ${speedUnit}`,
                bottom: '0',
                band: spread ? bandPath(spread.lo, spread.hi, yw) : undefined,
                limits: [
                    { y: yw(limits.wind.poor), stroke: AMBER, dash: '4 3' },
                    { y: yw(limits.gust.poor), stroke: RED, dash: '1 3' },
                ],
                lines: [
                    { d: linePath(gust, yw), stroke: WIND, dash: '3 2', opacity: 0.75, overY: yw(limits.gust.poor) },
                    { d: linePath(wind, yw), stroke: WIND, width: 2, overY: yw(limits.wind.poor) },
                ],
            },
            {
                key: 'sea',
                title: 'Waves and period',
                what: 'wave',
                read: seaRead,
                end: seaEnd,
                at: (i) =>
                    wave[i] === null && period[i] === null
                        ? none(seaEnd, i)
                        : `${show(wave[i], sea)} ${seaUnit}${period[i] !== null ? `, ${Math.round(period[i]!)} s` : ''}`,
                top: `${sea(seaTop)} ${seaUnit}`,
                bottom: '0',
                topRight: `${Math.round(periodTop)} s`,
                limits: [{ y: ys(limits.wave.poor), stroke: AMBER, dash: '4 3' }],
                lines: [
                    { d: linePath(period, yScale(0, periodTop)), stroke: '#c4b5fd', dash: '1 2' },
                    {
                        d: linePath(wave, ys),
                        stroke: 'var(--day-ui-accent, #7dd3fc)',
                        width: 2,
                        overY: ys(limits.wave.poor),
                    },
                ],
            },
            {
                key: 'rain',
                title: 'Rain',
                what: 'rain',
                read: rainRead,
                end: rainEnd,
                at: (i) =>
                    mm[i] === null && rainChance[i] === null
                        ? none(rainEnd, i)
                        : `${show(mm[i], (v) => `${rain(v)} ${rainUnit}`)}${rainChance[i] !== null ? `, ${Math.round(rainChance[i]!)}% chance` : ''}`,
                top: `${rain(rainTop)} ${rainUnit}`,
                bottom: '0',
                topRight: '100%',
                bars: barsPath(mm, yScale(0, rainTop)),
                limits: [],
                lines: [{ d: linePath(rainChance, yScale(0, 100)), stroke: '#e2e8f0', opacity: 0.55, width: 1 }],
            },
            {
                key: 'pressure',
                title: 'Pressure',
                what: 'pressure',
                read: pressureRead,
                end: pEnd,
                at: (i) =>
                    pressure[i] === null
                        ? none(pEnd, i)
                        : `${Math.round(pressure[i]!)} hPa${change[i] !== null ? `, ${change[i]! > 0 ? '+' : ''}${f1(change[i]!)} in 3 h` : ''}`,
                top: `${pHi} hPa`,
                bottom: `${pLo}`,
                limits: [],
                lines: [
                    { d: linePath(pressure, yp), stroke: 'var(--day-ui-text, #e2e8f0)', width: 1.8 },
                    { d: fastFallPath(pressure, yp), stroke: RED, width: 2.2 },
                ],
            },
        ];
    }, [grid, spread, limits, units, startMs, clock]);

    // ── The scrub: touch and drag (or arrow keys) to read any hour ──
    // A read lasts while the finger is down, the mouse is over the panels or
    // the slider has focus; then the week's summaries come back. A touch
    // reads only once it is a sideways drag or a hold, so scrolling the sheet
    // over the panels never swaps them out (131-02 review).
    const [cursor, setCursor] = useState<number | null>(null);
    const press = useRef<Press | null>(null);
    const to = (h: number) => setCursor(Math.max(0, Math.min(HOURS - 1, h)));
    const scrubTo = (clientX: number) => {
        const box = scrubRef.current?.getBoundingClientRect();
        if (box && box.width > 0) to(Math.round(((clientX - box.left) / box.width) * HOURS));
    };
    const endRead = () => {
        if (press.current) window.clearTimeout(press.current.hold);
        press.current = null;
        setCursor(null);
    };
    useEffect(
        () => () => {
            if (press.current) window.clearTimeout(press.current.hold);
        },
        [],
    );
    const onPointerDown = (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse') return scrubTo(e.clientX);
        if (press.current) window.clearTimeout(press.current.hold);
        const p: Press = { id: e.pointerId, x: e.clientX, x0: e.clientX, y0: e.clientY, reading: false, hold: 0 };
        p.hold = window.setTimeout(() => {
            if (press.current !== p) return;
            p.reading = true;
            scrubTo(p.x);
        }, HOLD_MS);
        press.current = p;
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse') return scrubTo(e.clientX);
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        p.x = e.clientX;
        const sideways = Math.abs(e.clientX - p.x0);
        if (!p.reading && sideways >= SIDEWAYS_PX && sideways > Math.abs(e.clientY - p.y0)) {
            p.reading = true;
            window.clearTimeout(p.hold);
        }
        if (p.reading) scrubTo(e.clientX);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const next =
            e.key in STEP ? (cursor ?? 0) + STEP[e.key] : e.key === 'Home' ? 0 : e.key === 'End' ? HOURS - 1 : null;
        if (next === null) return;
        e.preventDefault();
        to(next);
    };
    const cursorTime = cursor === null ? null : formatHour(startMs + cursor * HOUR_MS, clock);
    const cursorText =
        cursor === null
            ? ''
            : `${cursorTime}: ${panels.map((p) => `${p.title.toLowerCase()} ${p.at(cursor)}`).join('; ')}`;

    // Without the place's zone there is only the phone's clock to offer.
    const named = (zone: string) => (zone ? ` (${zone})` : '');
    const sameClock =
        !placeZone ||
        [startMs, startMs + HOURS * HOUR_MS].every((t) => zoneOffsetSeconds(t, placeZone) === zoneOffsetSeconds(t));
    const clockCaption =
        !placeZone || phoneClock
            ? `Your phone's clock${named(zoneName(nowMs))}`
            : `The place's own clock${named(zoneName(nowMs, placeZone))}${sameClock ? ', the same as your phone here' : ''}`;

    return (
        // Centred and clear of the tab bar, as the rain detail is; the body
        // scrolls inside when a short phone or large text cannot fit it.
        <OverlayPortal
            layer="nested"
            className="flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
            role="presentation"
            data-meteogram-overlay=""
        >
            <div className="absolute inset-0 bg-black/70" />
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="relative w-full max-w-lg max-h-full flex flex-col bg-slate-900 border border-white/10 rounded-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="shrink-0 flex items-center justify-between gap-2 px-4 pt-4 pb-2">
                    <h2 id={titleId} className="ui-dialog-title text-base font-bold text-white">
                        All metrics, next 7 days
                    </h2>
                    <button
                        ref={closeRef}
                        onClick={onClose}
                        className="hit-target-44 shrink-0 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                        aria-label="Close all metrics"
                    >
                        <XIcon className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3">
                    {/* Whose clock the times are on. */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {placeZone && (
                            <div role="group" aria-label="Times" className="inline-flex rounded-lg bg-white/5 p-0.5">
                                {[false, true].map((phone) => (
                                    <button
                                        key={String(phone)}
                                        type="button"
                                        aria-pressed={phoneClock === phone}
                                        onClick={() => setPhoneClock(phone)}
                                        className={`hit-target-44 px-2.5 py-1 rounded-md text-xs font-bold ${
                                            phoneClock === phone ? 'bg-sky-500/20 text-sky-200' : 'text-white/60'
                                        }`}
                                    >
                                        {phone ? 'Phone time' : 'Place time'}
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className="text-[11px] text-white/60 leading-snug">{clockCaption}</p>
                    </div>

                    <p className="mt-2 min-h-4 text-[11px] font-bold text-white/80 leading-4" aria-hidden="true">
                        {cursorTime ?? (
                            <span className="font-normal text-white/50">
                                Touch and drag across the panels to read an hour
                            </span>
                        )}
                    </p>

                    {/* Day names on the chosen clock, as many as fit. */}
                    <div ref={daysRef} className="relative h-4 mt-1" aria-hidden="true" data-testid="meteogram-days">
                        {dayFit
                            ? dayFit.map((d) => (
                                  <span
                                      key={d.left}
                                      className={DAY_NAME}
                                      style={{ left: `${d.left * 100}%` }}
                                      data-day-name=""
                                  >
                                      {d.text}
                                  </span>
                              ))
                            : days.labels.map((l) => (
                                  <span
                                      key={l.at}
                                      className={`${DAY_NAME} -translate-x-1/2`}
                                      style={{ left: `${(l.at / HOURS) * 100}%` }}
                                      data-day-name=""
                                  >
                                      {l.text}
                                  </span>
                              ))}
                    </div>

                    <div className="relative mt-1">
                        <div className="space-y-2">
                            {panels.map((p) => (
                                <section key={p.key} data-testid={`meteogram-${p.key}`}>
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                                        <h3 className="text-xs font-bold text-white">{p.title}</h3>
                                        <p
                                            className={`text-[11px] leading-snug ${cursor === null ? TONE[p.read.tone] : 'text-white/85'}`}
                                        >
                                            {cursor === null ? p.read.text : p.at(cursor)}
                                        </p>
                                    </div>
                                    <div className="relative h-14 mt-0.5 rounded-md bg-white/[0.03] overflow-hidden">
                                        <Plot panel={p} uid={uid} nights={nights} midnights={midnights} />
                                        <span className={`${TAG} left-0.5 top-0`}>{p.top}</span>
                                        <span className={`${TAG} left-0.5 bottom-0`}>{p.bottom}</span>
                                        {p.topRight && <span className={`${TAG} right-0.5 top-0`}>{p.topRight}</span>}
                                        {p.end !== null && HOURS - p.end >= 18 && (
                                            <span
                                                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 text-[10px] font-bold text-white/60 whitespace-nowrap"
                                                style={{ left: `${((p.end + HOURS) / 2 / HOURS) * 100}%` }}
                                            >
                                                {p.end === 0 ? `No ${p.what} forecast` : 'No forecast'}
                                            </span>
                                        )}
                                        {cursor !== null && (
                                            <span
                                                className="absolute inset-y-0 w-px bg-white/80 pointer-events-none"
                                                style={{ left: `${(cursor / HOURS) * 100}%` }}
                                            />
                                        )}
                                    </div>
                                </section>
                            ))}
                        </div>
                        {/* The scrub: one layer over the panels, so a drag anywhere
                            across them reads that hour in every panel's header. */}
                        <div
                            ref={scrubRef}
                            role="slider"
                            tabIndex={0}
                            aria-label="Hour to read"
                            aria-valuemin={0}
                            aria-valuemax={HOURS - 1}
                            aria-valuenow={cursor ?? 0}
                            aria-valuetext={cursorText || 'None chosen. Use the arrow keys to step through the hours.'}
                            className="absolute inset-0 rounded-md"
                            style={{ touchAction: 'pan-y' }}
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerUp={(e) => {
                                // A mouse still over the panels keeps reading where it is.
                                if (e.pointerType !== 'mouse') endRead();
                            }}
                            onPointerCancel={endRead}
                            onPointerLeave={endRead}
                            onKeyDown={onKeyDown}
                            onBlur={endRead}
                        />
                    </div>

                    <p className="mt-2 text-[11px] text-white/60 leading-snug" data-testid="meteogram-key">
                        Shaded columns are night, grey is beyond the forecast. Wind is the solid line, gusts dashed
                        {spread ? `, the green band the range of ${spread.models.length} models` : ''}. Amber dashes are
                        your wind and wave limits, red dots your gust limit; a line turns red where it reaches one.
                        Period is dotted, on the right scale; rain chance is the line over the bars. Pressure turns red
                        where it falls {FAST_FALL_HPA} hPa or more in 3 hours.
                    </p>

                    {/* The credit: a licence condition, not a courtesy. */}
                    <div
                        className="mt-2 space-y-0.5 text-[11px] leading-snug text-slate-400"
                        data-testid="meteogram-credit"
                    >
                        {blendName && <p className="font-semibold text-slate-300">{blendName}</p>}
                        <p className={blendName ? undefined : 'font-semibold text-slate-300'}>{credit}</p>
                        {spreadCredit && (
                            <p>
                                {/* ECCC's licence asks for a link to it where possible. */}
                                {spreadCredit.split(ECCC_LICENCE).map((part, i) => (
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
                        )}
                    </div>
                </div>

                <div className="shrink-0 px-4 py-3 border-t border-white/6">
                    <Button onClick={onClose} className="w-full text-slate-300">
                        Close
                    </Button>
                </div>
            </div>
        </OverlayPortal>
    );
};

Meteogram.displayName = 'Meteogram';
