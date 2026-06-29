/**
 * MetricDeepDiveModal — tap a grid tile on the live NOW card (Glass page) to
 * open a deep-dive for that metric: current value + trend, an hourly outlook
 * chart spanning ~1 day back → 5 days forward, and 5-day-range / tomorrow
 * stats, framed for weather-window planning.
 *
 * Atmospheric metrics fetch a WeatherKit historical window (yesterday → +5 days)
 * via fetchWeatherKitHistory when `coordinates` is provided, so the chart spans
 * yesterday → now → +5 days. Marine metrics (wave/period) have no WeatherKit
 * history, so they use the passed (marine) `hourly` forecast window instead
 * (which carries up to 16 days); both are clipped to the same outlook window.
 */
import React from 'react';
import { ModalSheet } from '../../ui/ModalSheet';
import type { HourlyForecast, ForecastDay, UnitPreferences } from '../../../types';
import { convertSpeed, convertLength, convertTemp, convertDistance } from '../../../utils/units';
import { degreesToCardinal } from '../../../utils/format';
import { circularMean, directionShift, type DirectionShift } from '../../../utils/circularStats';
import { fetchWeatherKitHistory } from '../../../services/weather/api/weatherkit';

export type MetricKey =
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

interface MetricConfig {
    label: string;
    accent: string; // tailwind text/stroke colour
    /** Pull the numeric value for this metric out of an hourly sample (raw units). */
    pick: (h: HourlyForecast) => number | null | undefined;
    /** Format a raw value for display. */
    fmt: (v: number, u: UnitPreferences) => string;
    unit: (u: UnitPreferences) => string;
    /** Tomorrow's representative value(s) from the daily forecast. */
    daily?: (d: ForecastDay, u: UnitPreferences) => string | null;
    /** Lower is better for window planning (e.g. wind, wave, rain). */
    lowerIsBetter?: boolean;
    /** Marine metric — WeatherKit has no waves, so always use the passed (marine) hourly. */
    marine?: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && !Number.isNaN(v) ? v : null);

const CONFIG: Record<MetricKey, MetricConfig> = {
    wind: {
        label: 'Wind',
        accent: 'text-emerald-300',
        pick: (h) => h.windSpeed,
        fmt: (v, u) => `${convertSpeed(v, u.speed)}`,
        unit: (u) => u.speed,
        daily: (d, u) => (num(d.windSpeed) !== null ? `${convertSpeed(d.windSpeed, u.speed)} ${u.speed}` : null),
        lowerIsBetter: true,
    },
    dir: {
        label: 'Direction',
        accent: 'text-emerald-300',
        pick: (h) => h.windDegree ?? null,
        fmt: (v) => `${Math.round(v)}° ${degreesToCardinal(v)}`,
        unit: () => '',
    },
    gust: {
        label: 'Gust',
        accent: 'text-emerald-300',
        pick: (h) => h.windGust ?? null,
        fmt: (v, u) => `${convertSpeed(v, u.speed)}`,
        unit: (u) => u.speed,
        daily: (d, u) => (num(d.windGust) !== null ? `${convertSpeed(d.windGust!, u.speed)} ${u.speed}` : null),
        lowerIsBetter: true,
    },
    wave: {
        label: 'Wave height',
        accent: 'text-sky-300',
        pick: (h) => h.waveHeight,
        fmt: (v, u) => `${convertLength(v, u.waveHeight)}`,
        unit: (u) => u.waveHeight,
        daily: (d, u) =>
            num(d.waveHeight) !== null ? `${convertLength(d.waveHeight, u.waveHeight)} ${u.waveHeight}` : null,
        lowerIsBetter: true,
        marine: true,
    },
    period: {
        label: 'Swell period',
        accent: 'text-sky-300',
        pick: (h) => h.swellPeriod ?? null,
        fmt: (v) => `${Math.round(v)}`,
        unit: () => 's',
        marine: true,
    },
    uv: {
        label: 'UV index',
        accent: 'text-amber-300',
        pick: (h) => h.uvIndex ?? null,
        fmt: (v) => `${Math.round(v)}`,
        unit: () => '',
        lowerIsBetter: true,
    },
    vis: {
        label: 'Visibility',
        accent: 'text-sky-300',
        pick: (h) => h.visibility ?? null,
        // HourlyForecast.visibility is already in km (app convention).
        fmt: (v, u) => `${convertDistance(v, u.visibility || 'nm')}`,
        unit: (u) => u.visibility || 'nm',
    },
    pressure: {
        label: 'Pressure',
        accent: 'text-sky-300',
        pick: (h) => h.pressure ?? null,
        fmt: (v) => `${Math.round(v)}`,
        unit: () => 'hPa',
    },
    humidity: {
        label: 'Humidity',
        accent: 'text-sky-300',
        pick: (h) => h.humidity ?? null,
        fmt: (v) => `${Math.round(v)}`,
        unit: () => '%',
    },
    rain: {
        label: 'Rain chance',
        accent: 'text-sky-300',
        pick: (h) => h.precipChance ?? null,
        fmt: (v) => `${Math.round(v)}`,
        unit: () => '%',
        daily: (d) => (num(d.precipChance) !== null ? `${Math.round(d.precipChance!)}%` : null),
        lowerIsBetter: true,
    },
    temp: {
        label: 'Temperature',
        accent: 'text-amber-300',
        pick: (h) => h.temperature,
        fmt: (v, u) => `${convertTemp(v, u.temp)}`,
        unit: (u) => (u.temp === 'F' ? '°F' : '°C'),
        daily: (d, u) =>
            `${convertTemp(d.highTemp, u.temp)} / ${convertTemp(d.lowTemp, u.temp)} ${u.temp === 'F' ? '°F' : '°C'}`,
    },
};

interface MetricDeepDiveModalProps {
    metric: MetricKey | null;
    onClose: () => void;
    units: UnitPreferences;
    /** Today's hourly samples (forward from now). */
    hourly: HourlyForecast[];
    /** Daily forecast — index 1 is tomorrow. */
    forecast: ForecastDay[];
    /** Location for the WeatherKit historical fetch (yesterday → +48h). */
    coordinates?: { lat: number; lon: number };
}

/** A point on the chart. */
interface Pt {
    t: number;
    v: number;
}

/** Deep-dive outlook window: ~1 day back, 5 days forward. */
const PAST_WINDOW_MS = 30 * 3_600_000;
const FWD_WINDOW_MS = 120 * 3_600_000;

function buildSeries(samples: HourlyForecast[], pick: MetricConfig['pick']): Pt[] {
    const out: Pt[] = [];
    for (const h of samples || []) {
        const v = num(pick(h));
        const t = new Date(h.time).getTime();
        if (v !== null && !Number.isNaN(t)) out.push({ t, v });
    }
    return out.sort((a, b) => a.t - b.t);
}

const accentHex = (accent: string): string =>
    accent.includes('emerald') ? '#6ee7b7' : accent.includes('amber') ? '#fcd34d' : '#7dd3fc';

/** Smooth, glowing area+line chart (dependency-free, Catmull-Rom curve). */
const Sparkline: React.FC<{ pts: Pt[]; nowT: number; accent: string }> = ({ pts, nowT, accent }) => {
    const W = 320;
    const H = 120;
    const PAD = 8;
    if (pts.length < 2) {
        return (
            <div className="h-[120px] flex items-center justify-center text-white/40 text-sm">
                Not enough data to chart
            </div>
        );
    }
    const minT = pts[0].t;
    const maxT = pts[pts.length - 1].t;
    const vs = pts.map((p) => p.v);
    let minV = Math.min(...vs);
    let maxV = Math.max(...vs);
    if (minV === maxV) {
        minV -= 1;
        maxV += 1;
    }
    const x = (t: number) => PAD + ((t - minT) / (maxT - minT || 1)) * (W - 2 * PAD);
    const y = (v: number) => PAD + (1 - (v - minV) / (maxV - minV || 1)) * (H - 2 * PAD);
    const sp = pts.map((p) => ({ x: x(p.t), y: y(p.v) }));

    // Catmull-Rom → cubic-bezier for a smooth, premium curve.
    let line = `M${sp[0].x.toFixed(1)},${sp[0].y.toFixed(1)}`;
    for (let i = 0; i < sp.length - 1; i++) {
        const p0 = sp[i - 1] || sp[i];
        const p1 = sp[i];
        const p2 = sp[i + 1];
        const p3 = sp[i + 2] || p2;
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        line += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    const area = `${line} L${sp[sp.length - 1].x.toFixed(1)},${H - PAD} L${sp[0].x.toFixed(1)},${H - PAD} Z`;
    const nowX = nowT >= minT && nowT <= maxT ? x(nowT) : null;
    const nowV = pts.find((p) => p.t >= nowT)?.v ?? pts[pts.length - 1].v;
    const nowY = y(nowV);
    const stroke = accentHex(accent);
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[120px]" preserveAspectRatio="none">
            <defs>
                <linearGradient id="mdd-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={stroke} stopOpacity="0.42" />
                    <stop offset="100%" stopColor={stroke} stopOpacity="0" />
                </linearGradient>
                <filter id="mdd-glow" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="2.4" />
                </filter>
            </defs>
            <path d={area} fill="url(#mdd-fill)" />
            {/* soft glow underlay */}
            <path
                d={line}
                fill="none"
                stroke={stroke}
                strokeWidth={4}
                strokeOpacity={0.35}
                strokeLinejoin="round"
                strokeLinecap="round"
                filter="url(#mdd-glow)"
            />
            <path d={line} fill="none" stroke={stroke} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
            {nowX !== null && (
                <>
                    <line
                        x1={nowX}
                        y1={PAD - 2}
                        x2={nowX}
                        y2={H - PAD}
                        stroke="#ffffff"
                        strokeOpacity="0.4"
                        strokeWidth={1}
                        strokeDasharray="2 3"
                    />
                    <circle cx={nowX} cy={nowY} r={6} fill={stroke} opacity={0.3} />
                    <circle cx={nowX} cy={nowY} r={2.8} fill="#fff" />
                </>
            )}
        </svg>
    );
};

/** A compass arrow whose tip points toward the bearing the wind blows FROM. */
const DirArrow: React.FC<{ deg: number | null; size?: number }> = ({ deg, size = 24 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className="shrink-0"
        style={{
            transform: deg == null ? undefined : `rotate(${deg}deg)`,
            transition: 'transform 1s ease',
            opacity: deg == null ? 0.25 : 1,
        }}
    >
        <path d="M12 3L8 14h8L12 3Z" fill="rgba(110,231,183,0.92)" />
        <path d="M12 21L8 14h8L12 21Z" fill="rgba(148,163,184,0.3)" />
    </svg>
);

/** One Yesterday / Today / Tomorrow heading cell. */
const DirCell: React.FC<{ label: string; deg: number | null; highlight?: boolean }> = ({ label, deg, highlight }) => (
    <div
        className={`flex-1 rounded-xl border px-2 py-3 flex flex-col items-center gap-1.5 ${
            highlight ? 'bg-emerald-400/10 border-emerald-400/25' : 'bg-white/[0.04] border-white/[0.06]'
        }`}
    >
        <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
        <DirArrow deg={deg} />
        <div className="text-base font-bold text-emerald-300 leading-none">
            {deg == null ? '—' : degreesToCardinal(deg)}
        </div>
        <div className="text-[10px] text-white/45 tabular-nums leading-none">
            {deg == null ? '' : `${Math.round(deg)}°`}
        </div>
    </div>
);

export const MetricDeepDiveModal: React.FC<MetricDeepDiveModalProps> = ({
    metric,
    onClose,
    units,
    hourly,
    forecast,
    coordinates,
}) => {
    const cfg = metric ? CONFIG[metric] : null;

    // WeatherKit historical hourly (yesterday → +48h), fetched when the modal opens.
    const [history, setHistory] = React.useState<HourlyForecast[]>([]);
    React.useEffect(() => {
        if (!metric || !coordinates) {
            setHistory([]);
            return;
        }
        let alive = true;
        fetchWeatherKitHistory(coordinates.lat, coordinates.lon)
            .then((h) => alive && setHistory(h))
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [metric, coordinates]);

    const { series, nowVal, todayMin, todayMax, trend, windowRead, tomorrowStr, hasHistory } = React.useMemo(() => {
        const base = {
            series: [] as Pt[],
            nowVal: null as number | null,
            todayMin: null as number | null,
            todayMax: null as number | null,
            trend: 'steady' as 'rising' | 'falling' | 'steady',
            windowRead: '',
            tomorrowStr: null as string | null,
            hasHistory: false,
        };
        if (!cfg) return base;

        // WeatherKit has no waves, so marine metrics always use the passed (marine) source.
        const useHist = !cfg.marine && history.length > 0;
        const allRaw = buildSeries(useHist ? history : hourly, cfg.pick);
        if (!allRaw.length) return { ...base, windowRead: 'No data available for this metric right now.' };

        const nowMs = Date.now();
        // Clip to the −1 day → +5 day outlook window. Keeps atmospheric (WeatherKit
        // history) and marine (forecast carries up to 16 days) on the same span.
        const all = allRaw.filter((p) => p.t >= nowMs - PAST_WINDOW_MS && p.t <= nowMs + FWD_WINDOW_MS);
        if (!all.length) return { ...base, windowRead: 'No data available for this metric right now.' };

        const fwd = all.filter((p) => p.t >= nowMs - 3_600_000);
        const fwdVs = fwd.map((p) => p.v);
        const tMin = fwdVs.length ? Math.min(...fwdVs) : null;
        const tMax = fwdVs.length ? Math.max(...fwdVs) : null;
        const now = fwd.length ? fwd[0].v : all[all.length - 1].v;

        // Trend across the whole forward 5-day window (smoothed start vs end), with
        // the peak / calmest day called out for weather-window planning.
        const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
        const dayWord = (t: number) => {
            const d = Math.round((t - nowMs) / 86_400_000);
            return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
        };
        let tr: 'rising' | 'falling' | 'steady' = 'steady';
        let read = `${cfg.label} holds fairly steady over the next 5 days.`;
        if (fwd.length >= 4) {
            const headMean = mean(fwd.slice(0, Math.min(6, fwd.length)).map((p) => p.v));
            const tailMean = mean(fwd.slice(-Math.min(24, fwd.length)).map((p) => p.v));
            const span = (tMax ?? 0) - (tMin ?? 0) || 1;
            const diff = tailMean - headMean;
            if (diff > span * 0.12) tr = 'rising';
            else if (diff < -span * 0.12) tr = 'falling';

            const peak = fwd.reduce((a, b) => (b.v > a.v ? b : a));
            const trough = fwd.reduce((a, b) => (b.v < a.v ? b : a));
            if (tr !== 'steady') {
                if (cfg.lowerIsBetter) {
                    read =
                        tr === 'falling'
                            ? `${cfg.label} eases over the next 5 days — calmest ${dayWord(trough.t)}.`
                            : `${cfg.label} builds over the next 5 days — watch ${dayWord(peak.t)}.`;
                } else {
                    const dirWord = tr === 'rising' ? 'building' : 'easing';
                    read = `${cfg.label} is ${dirWord} over the next 5 days — ${tr === 'rising' ? `peaks ${dayWord(peak.t)}` : `lowest ${dayWord(trough.t)}`}.`;
                }
            }
        }

        const tomorrow = forecast && forecast.length > 1 && cfg.daily ? cfg.daily(forecast[1], units) : null;

        return {
            series: all,
            nowVal: now,
            todayMin: tMin,
            todayMax: tMax,
            trend: tr,
            windowRead: read,
            tomorrowStr: tomorrow,
            hasHistory: useHist && all.some((p) => p.t < nowMs - 3_600_000),
        };
    }, [cfg, hourly, history, forecast, units]);

    // Direction is circular — "rising/falling" and min–max ranges are meaningless
    // on a wrapped axis. Instead read the heading yesterday / today / tomorrow
    // (vector means) and whether the wind is veering (clockwise) or backing.
    const isDir = metric === 'dir';
    const dirInfo = React.useMemo(() => {
        if (!isDir) return null;
        const H = 3_600_000;
        const nowMs = Date.now();
        const pickDeg = (h: HourlyForecast) => h.windDegree ?? null;
        const hist = buildSeries(history, pickDeg);
        const fwd = buildSeries(hourly, pickDeg);
        const all = hist.length ? hist : fwd;
        const win = (s: Pt[], lo: number, hi: number) => s.filter((p) => p.t >= lo && p.t <= hi).map((p) => p.v);
        const yesterdayDeg = circularMean(win(hist, nowMs - 30 * H, nowMs - 12 * H));
        const todayDeg = circularMean(win(all, nowMs - 3 * H, nowMs + 3 * H)) ?? nowVal;
        const tomorrowDeg = circularMean(win(fwd.length ? fwd : all, nowMs + 18 * H, nowMs + 30 * H));
        const shift: DirectionShift | null = directionShift(yesterdayDeg ?? todayDeg, tomorrowDeg ?? todayDeg);
        return { yesterdayDeg, todayDeg, tomorrowDeg, shift };
    }, [isDir, history, hourly, nowVal]);

    if (!metric || !cfg) return null;

    const unit = cfg.unit(units);
    const fmt = (v: number | null) => (v === null ? '--' : `${cfg.fmt(v, units)}${unit ? ' ' + unit : ''}`);
    const trendIcon = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→';
    const trendPill =
        trend === 'rising'
            ? 'bg-amber-400/15 text-amber-300'
            : trend === 'falling'
              ? 'bg-sky-400/15 text-sky-300'
              : 'bg-white/10 text-white/55';
    const nowT = Date.now();
    const chartPts = series;

    // Direction-specific header pill + read (veering / backing, not rising / falling).
    const shift = dirInfo?.shift ?? null;
    const shiftIcon = shift === 'veering' ? '↻' : shift === 'backing' ? '↺' : '→';
    const shiftPill =
        shift === 'veering'
            ? 'bg-emerald-400/15 text-emerald-300'
            : shift === 'backing'
              ? 'bg-sky-400/15 text-sky-300'
              : 'bg-white/10 text-white/55';
    const cardOf = (d: number | null | undefined) => (d == null ? null : degreesToCardinal(d));
    const dirRead = (() => {
        if (!dirInfo) return '';
        const today = cardOf(dirInfo.todayDeg);
        if (!dirInfo.shift) return today ? `Wind sitting in the ${today}.` : 'Direction data unavailable right now.';
        if (dirInfo.shift === 'steady')
            return `Wind holding ${today ? `from the ${today}` : 'steady'} — little change over the next day.`;
        const from = cardOf(dirInfo.yesterdayDeg) ?? today;
        const to = cardOf(dirInfo.tomorrowDeg) ?? today;
        return `Wind ${dirInfo.shift} from the ${from} toward the ${to} over the next day or so.`;
    })();

    return (
        <ModalSheet isOpen={!!metric} onClose={onClose} title={cfg.label}>
            <div className="space-y-5">
                {/* Now + trend/shift */}
                <div className="flex items-end justify-between">
                    <div>
                        <div className="text-[11px] uppercase tracking-wider text-white/40">Now</div>
                        <div
                            className={`text-5xl font-black tabular-nums ${cfg.accent} drop-shadow-[0_2px_14px_rgba(255,255,255,0.12)]`}
                        >
                            {fmt(nowVal)}
                        </div>
                    </div>
                    {isDir ? (
                        <div
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-bold ${shiftPill}`}
                        >
                            <span className="text-base leading-none">{shiftIcon}</span>
                            <span className="capitalize">{shift ?? 'steady'}</span>
                        </div>
                    ) : (
                        <div
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-bold ${trendPill}`}
                        >
                            <span className="text-base leading-none">{trendIcon}</span>
                            <span className="capitalize">{trend}</span>
                        </div>
                    )}
                </div>

                {isDir ? (
                    <>
                        {/* Heading: yesterday / today / tomorrow */}
                        <div className="flex items-stretch gap-2.5">
                            <DirCell label="Yesterday" deg={dirInfo?.yesterdayDeg ?? null} />
                            <DirCell label="Today" deg={dirInfo?.todayDeg ?? null} highlight />
                            <DirCell label="Tomorrow" deg={dirInfo?.tomorrowDeg ?? null} />
                        </div>

                        {/* Shift read — accent callout */}
                        <div className="flex items-start gap-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-3">
                            <span className="mt-0.5 text-base leading-none text-emerald-300">{shiftIcon}</span>
                            <p className="text-sm text-white/80 leading-relaxed">{dirRead}</p>
                        </div>

                        <p className="text-[11px] text-white/30 leading-relaxed">
                            Wind direction is the compass bearing the wind blows <em>from</em>. Yesterday needs
                            WeatherKit history; today and tomorrow come from the forecast.
                        </p>
                    </>
                ) : (
                    <>
                        {/* Chart */}
                        <div className="rounded-xl bg-gradient-to-b from-white/[0.05] to-white/[0.015] border border-white/[0.07] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                            <Sparkline pts={chartPts} nowT={nowT} accent={cfg.accent} />
                            <div className="flex justify-between text-[10px] text-white/35 px-1 mt-1">
                                <span>{hasHistory ? 'Yesterday' : 'Now'}</span>
                                {hasHistory ? <span className="text-white/45">Now</span> : null}
                                <span>+5 days →</span>
                            </div>
                        </div>

                        {/* Window read — accent callout */}
                        <div className="flex items-start gap-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-3">
                            <span className={`mt-0.5 text-base leading-none ${cfg.accent}`}>{trendIcon}</span>
                            <p className="text-sm text-white/80 leading-relaxed">{windowRead}</p>
                        </div>

                        {/* Stat cards */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-2.5">
                                <div className="text-[10px] uppercase tracking-wider text-white/40">5-day range</div>
                                <div className="mt-0.5 text-sm font-bold text-white tabular-nums">
                                    {fmt(todayMin)} – {fmt(todayMax)}
                                </div>
                            </div>
                            <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] px-3.5 py-2.5">
                                <div className="text-[10px] uppercase tracking-wider text-white/40">Tomorrow</div>
                                <div className="mt-0.5 text-sm font-bold text-white tabular-nums">
                                    {tomorrowStr || '--'}
                                </div>
                            </div>
                        </div>

                        {cfg.marine && (
                            <p className="text-[11px] text-white/30 leading-relaxed">
                                Marine metrics show the forecast window — yesterday history isn’t available for waves.
                            </p>
                        )}
                    </>
                )}
            </div>
        </ModalSheet>
    );
};

MetricDeepDiveModal.displayName = 'MetricDeepDiveModal';
