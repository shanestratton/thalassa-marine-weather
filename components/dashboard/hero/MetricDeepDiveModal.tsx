/**
 * MetricDeepDiveModal — tap a grid tile on the live NOW card (Glass page) to
 * open a deep-dive for that metric: current value + trend, an hourly chart for
 * the rest of today, and today-vs-tomorrow ranges, framed for weather-window
 * planning.
 *
 * v1 runs on the data already in the Dashboard (hourly + daily forecast). The
 * "yesterday" series and extended multi-day hourly come from a WeatherKit
 * historical fetch once the fetch-weatherkit edge function (which now forwards
 * hourlyStart/hourlyEnd) is deployed — see `historyHourly` prop.
 */
import React from 'react';
import { ModalSheet } from '../../ui/ModalSheet';
import type { HourlyForecast, ForecastDay, UnitPreferences } from '../../../types';
import { convertSpeed, convertLength, convertTemp, convertDistance } from '../../../utils/units';
import { degreesToCardinal } from '../../../utils/format';

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
    },
    period: {
        label: 'Swell period',
        accent: 'text-sky-300',
        pick: (h) => h.swellPeriod ?? null,
        fmt: (v) => `${Math.round(v)}`,
        unit: () => 's',
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
        fmt: (v, u) => `${convertDistance(v / 1000, u.visibility || 'nm')}`,
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
    /** Optional historical hourly (yesterday → now), once the WeatherKit edge fn is deployed. */
    historyHourly?: HourlyForecast[];
}

/** A point on the chart. */
interface Pt {
    t: number;
    v: number;
}

function buildSeries(samples: HourlyForecast[], pick: MetricConfig['pick']): Pt[] {
    const out: Pt[] = [];
    for (const h of samples || []) {
        const v = num(pick(h));
        const t = new Date(h.time).getTime();
        if (v !== null && !Number.isNaN(t)) out.push({ t, v });
    }
    return out.sort((a, b) => a.t - b.t);
}

/** Minimal, dependency-free area+line chart. */
const Sparkline: React.FC<{ pts: Pt[]; nowT: number; accent: string }> = ({ pts, nowT, accent }) => {
    const W = 320;
    const H = 120;
    const PAD = 6;
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
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const area = `${line} L${x(maxT).toFixed(1)},${H - PAD} L${x(minT).toFixed(1)},${H - PAD} Z`;
    const nowX = nowT >= minT && nowT <= maxT ? x(nowT) : null;
    const stroke = accent.includes('emerald') ? '#6ee7b7' : accent.includes('amber') ? '#fcd34d' : '#7dd3fc';
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[120px]" preserveAspectRatio="none">
            <defs>
                <linearGradient id="mdd-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={stroke} stopOpacity="0" />
                </linearGradient>
            </defs>
            <path d={area} fill="url(#mdd-fill)" />
            <path d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {nowX !== null && (
                <>
                    <line
                        x1={nowX}
                        y1={PAD}
                        x2={nowX}
                        y2={H - PAD}
                        stroke="#ffffff"
                        strokeOpacity="0.5"
                        strokeWidth={1}
                        strokeDasharray="3 3"
                    />
                    <circle cx={nowX} cy={y(pts.find((p) => p.t >= nowT)?.v ?? pts[0].v)} r={3.5} fill="#fff" />
                </>
            )}
        </svg>
    );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
        <span className="text-sm text-white/55">{label}</span>
        <span className="text-sm font-semibold text-white tabular-nums">{value}</span>
    </div>
);

export const MetricDeepDiveModal: React.FC<MetricDeepDiveModalProps> = ({
    metric,
    onClose,
    units,
    hourly,
    forecast,
    historyHourly,
}) => {
    const cfg = metric ? CONFIG[metric] : null;

    const { todaySeries, fullSeries, nowVal, todayMin, todayMax, trend, windowRead, tomorrowStr } =
        React.useMemo(() => {
            if (!cfg) {
                return {
                    todaySeries: [] as Pt[],
                    fullSeries: [] as Pt[],
                    nowVal: null as number | null,
                    todayMin: null as number | null,
                    todayMax: null as number | null,
                    trend: 'steady' as 'rising' | 'falling' | 'steady',
                    windowRead: '',
                    tomorrowStr: null as string | null,
                };
            }
            const today = buildSeries(hourly, cfg.pick);
            const hist = buildSeries(historyHourly || [], cfg.pick);
            const full = [...hist, ...today].sort((a, b) => a.t - b.t);
            const vs = today.map((p) => p.v);
            const tMin = vs.length ? Math.min(...vs) : null;
            const tMax = vs.length ? Math.max(...vs) : null;
            const now = today.length ? today[0].v : null;

            // Trend over the next ~6 hours of today.
            let tr: 'rising' | 'falling' | 'steady' = 'steady';
            if (today.length >= 2) {
                const ahead = today[Math.min(today.length - 1, 6)].v;
                const diff = ahead - today[0].v;
                const span = (tMax ?? 0) - (tMin ?? 0) || 1;
                if (diff > span * 0.12) tr = 'rising';
                else if (diff < -span * 0.12) tr = 'falling';
            }

            // Plain-English window read.
            let read = 'Holding fairly steady through today.';
            if (tr !== 'steady') {
                const dirWord = tr === 'rising' ? 'building' : 'easing';
                const good = cfg.lowerIsBetter ? tr === 'falling' : tr === 'rising';
                read = `${cfg.label} is ${dirWord} through the day — ${good ? 'conditions improving' : 'watch the window'}.`;
            }

            const tomorrow = forecast && forecast.length > 1 && cfg.daily ? cfg.daily(forecast[1], units) : null;

            return {
                todaySeries: today,
                fullSeries: full,
                nowVal: now,
                todayMin: tMin,
                todayMax: tMax,
                trend: tr,
                windowRead: read,
                tomorrowStr: tomorrow,
            };
        }, [cfg, hourly, historyHourly, forecast, units]);

    if (!metric || !cfg) return null;

    const unit = cfg.unit(units);
    const fmt = (v: number | null) => (v === null ? '--' : `${cfg.fmt(v, units)}${unit ? ' ' + unit : ''}`);
    const trendIcon = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→';
    const trendColor = trend === 'rising' ? 'text-amber-300' : trend === 'falling' ? 'text-sky-300' : 'text-white/50';
    const nowT = todaySeries.length ? todaySeries[0].t : Date.now();
    const chartPts = fullSeries.length >= 2 ? fullSeries : todaySeries;

    return (
        <ModalSheet isOpen={!!metric} onClose={onClose} title={cfg.label}>
            <div className="space-y-5">
                {/* Now + trend */}
                <div className="flex items-end justify-between">
                    <div>
                        <div className="text-[11px] uppercase tracking-wider text-white/40">Now</div>
                        <div className={`text-4xl font-black tabular-nums ${cfg.accent}`}>{fmt(nowVal)}</div>
                    </div>
                    <div className={`text-lg font-bold ${trendColor}`}>
                        {trendIcon} {trend}
                    </div>
                </div>

                {/* Chart */}
                <div className="rounded-xl bg-white/[0.03] border border-white/5 p-2">
                    <Sparkline pts={chartPts} nowT={nowT} accent={cfg.accent} />
                    <div className="flex justify-between text-[10px] text-white/35 px-1">
                        <span>{historyHourly && historyHourly.length ? 'Yesterday' : 'Now'}</span>
                        <span>Rest of today{forecast.length > 1 ? ' →' : ''}</span>
                    </div>
                </div>

                {/* Window read */}
                <p className="text-sm text-white/75 leading-relaxed">{windowRead}</p>

                {/* Rows */}
                <div className="rounded-xl bg-white/[0.03] border border-white/5 px-3">
                    <Row label="Today range" value={`${fmt(todayMin)} – ${fmt(todayMax)}`} />
                    <Row label="Tomorrow" value={tomorrowStr || '--'} />
                </div>

                {!historyHourly?.length && (
                    <p className="text-[11px] text-white/30 leading-relaxed">
                        Yesterday + multi-day history will appear here once the WeatherKit historical fetch is live.
                    </p>
                )}
            </div>
        </ModalSheet>
    );
};

MetricDeepDiveModal.displayName = 'MetricDeepDiveModal';
