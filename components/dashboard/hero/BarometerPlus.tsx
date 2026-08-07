/**
 * BarometerPlus — the barometer screen that takes over the 5×2 metric grid.
 *
 * Tapping HPA on the Glass grid doesn't open a modal over the card; it turns
 * the grid itself into a barometer. That constraint is the whole design: the
 * panel must fit EXACTLY the grid's box, because
 * GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX (163) is a hard geometry constant that
 * every card below the hero is positioned from. Grow this panel and the
 * whole Glass stack overlaps. 161px of usable height, no scrolling, no
 * exceptions — the "i" screen scrolls inside the same box.
 *
 * Where the number comes from
 * ───────────────────────────
 * The iPhone's own barometer (CMAltimeter, via services/native/barometer.ts)
 * when there is one, the forecast when there isn't, and the source chip
 * always says which. That distinction matters more here than anywhere else
 * on the Glass: a forecast pressure is a model's opinion about a grid cell,
 * while the phone's reading is the actual air in the actual cockpit, and it
 * is the only observation on this page that isn't someone else's.
 *
 * The honest bit
 * ──────────────
 * The sensor's absolute value is worth about ±1 hPa and its 3-hour delta is
 * worth about 0.05, so the panel leads with the TENDENCY and treats the
 * absolute reading as the secondary number — tagged STATION until the user
 * anchors it to the forecast MSLP, never silently corrected. And when the
 * record is too short to support a tendency it says "collecting" with a
 * countdown rather than banding sensor noise into a gale warning.
 */
import React from 'react';
import { GaugeIcon } from '../../Icons';
import type { HourlyForecast } from '../../../types';
import {
    observedTendency,
    timeUntilTendency,
    hpaToInHg,
    type PressureSample,
    type TendencyReading,
    type TendencySeverity,
} from '../../../utils/barometerTendency';
import * as barometer from '../../../services/native/barometer';

/** Chart span: what the sensor measured, then what the model expects. */
const PAST_MS = 6 * 3_600_000;
const FWD_MS = 12 * 3_600_000;

const SEVERITY_UI: Record<TendencySeverity, { pill: string; dot: string; line: string }> = {
    calm: { pill: 'bg-emerald-400/15 text-emerald-300', dot: '#6ee7b7', line: 'text-emerald-300' },
    watch: { pill: 'bg-amber-400/15 text-amber-200', dot: '#fcd34d', line: 'text-amber-200' },
    warn: { pill: 'bg-red-400/15 text-red-300', dot: '#fca5a5', line: 'text-red-300' },
};

const fmtPressure = (hpa: number | null, unit: barometer.PressureUnit): string => {
    if (hpa == null || !Number.isFinite(hpa)) return '--';
    return unit === 'inHg' ? hpaToInHg(hpa).toFixed(2) : hpa.toFixed(1);
};

const fmtDelta = (hpa: number, unit: barometer.PressureUnit): string => {
    const v = unit === 'inHg' ? hpaToInHg(hpa) : hpa;
    const digits = unit === 'inHg' ? 3 : 1;
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
};

const fmtCountdown = (ms: number): string => {
    const mins = Math.max(1, Math.round(ms / 60_000));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
};

// ── Trace ────────────────────────────────────────────────────────────

interface TracePoint {
    t: number;
    v: number;
}

/**
 * The instrument trace: measured behind, forecast ahead, one shared vertical
 * scale so the seam at "now" is readable as a continuation rather than two
 * unrelated lines. Both are drawn even when the two disagree — especially
 * when they disagree, because a sensor falling while the model holds steady
 * is the single most useful thing this panel can show a skipper.
 */
const Trace: React.FC<{
    measured: TracePoint[];
    forecast: TracePoint[];
    nowT: number;
    accent: string;
}> = ({ measured, forecast, nowT, accent }) => {
    const W = 240;
    const H = 74;
    const PAD_Y = 7;

    const all = [...measured, ...forecast];
    if (all.length < 2) {
        return (
            <div className="h-full flex items-center justify-center text-[10px] text-white/35 tracking-wide">
                No trace yet
            </div>
        );
    }

    const minT = nowT - PAST_MS;
    const maxT = nowT + FWD_MS;
    const vs = all.map((p) => p.v);
    let minV = Math.min(...vs);
    let maxV = Math.max(...vs);
    // A flat barometer is normal; without a floor on the range a 0.2 hPa
    // wobble would be drawn as a mountain range.
    const MIN_RANGE = 4;
    if (maxV - minV < MIN_RANGE) {
        const mid = (maxV + minV) / 2;
        minV = mid - MIN_RANGE / 2;
        maxV = mid + MIN_RANGE / 2;
    }

    const x = (t: number) => ((t - minT) / (maxT - minT)) * W;
    const y = (v: number) => PAD_Y + (1 - (v - minV) / (maxV - minV)) * (H - 2 * PAD_Y);
    const path = (pts: TracePoint[]) =>
        pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');

    const nowX = x(nowT);
    const measuredPath = path(measured);
    const forecastPath = path(forecast);
    const lastMeasured = measured[measured.length - 1];

    // Fill under the measured trace only — it's the part that happened.
    const fill =
        measured.length > 1
            ? `${measuredPath} L${x(lastMeasured.t).toFixed(1)},${H} L${x(measured[0].t).toFixed(1)},${H} Z`
            : '';

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
            <defs>
                <linearGradient id="baro-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accent} stopOpacity="0.34" />
                    <stop offset="100%" stopColor={accent} stopOpacity="0" />
                </linearGradient>
            </defs>

            {/* Hour gridlines every 3 h — the tendency window, drawn. */}
            {[-6, -3, 3, 6, 9, 12].map((h) => (
                <line
                    key={h}
                    x1={x(nowT + h * 3_600_000)}
                    y1={0}
                    x2={x(nowT + h * 3_600_000)}
                    y2={H}
                    stroke="#ffffff"
                    strokeOpacity={0.06}
                    strokeWidth={1}
                />
            ))}

            {fill && <path d={fill} fill="url(#baro-fill)" />}

            {forecast.length > 1 && (
                <path
                    d={forecastPath}
                    fill="none"
                    stroke="#ffffff"
                    strokeOpacity={0.35}
                    strokeWidth={1.4}
                    strokeDasharray="3 3"
                    strokeLinecap="round"
                />
            )}

            {measured.length > 1 && (
                <path
                    d={measuredPath}
                    fill="none"
                    stroke={accent}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            )}

            <line x1={nowX} y1={0} x2={nowX} y2={H} stroke="#ffffff" strokeOpacity={0.28} strokeWidth={1} />
            {lastMeasured && (
                <>
                    <circle cx={x(lastMeasured.t)} cy={y(lastMeasured.v)} r={5} fill={accent} opacity={0.28} />
                    <circle cx={x(lastMeasured.t)} cy={y(lastMeasured.v)} r={2.4} fill="#fff" />
                </>
            )}
        </svg>
    );
};

// ── Explainer ────────────────────────────────────────────────────────

const BAND_ROWS: [string, string][] = [
    ['under 0.1', 'Steady — nothing signalled'],
    ['0.1 – 1.5', 'Slowly — a change is possible, not imminent'],
    ['1.6 – 3.5', 'Moving — a front within the day'],
    ['3.6 – 6.0', 'Quickly — gale signature on a fall'],
    ['over 6.0', 'Very rapidly — serious weather, now'],
];

const Explainer: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <div className="absolute inset-0 z-20 bg-slate-950/95 backdrop-blur-sm flex flex-col">
        <div className="flex items-center justify-between px-3 pt-1.5 pb-1 shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300">
                Reading the tendency
            </span>
            <button
                type="button"
                onClick={onClose}
                aria-label="Close explainer"
                className="w-5 h-5 rounded-full bg-white/10 text-white/70 text-[11px] leading-none flex items-center justify-center active:scale-90 transition"
            >
                ✕
            </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-2 space-y-2 text-[10.5px] leading-[1.45] text-white/75">
            <p>
                A barometer forecasts through <strong className="text-white">change over three hours</strong>, not
                through its absolute reading. 1013 hPa tells you almost nothing; 1013 after 1019 three hours ago tells
                you a lot.
            </p>
            <div className="rounded-lg border border-white/10 overflow-hidden">
                {BAND_ROWS.map(([range, meaning], i) => (
                    <div
                        key={range}
                        className={`flex gap-2 px-2 py-1 ${i % 2 ? 'bg-white/[0.03]' : ''} ${i ? 'border-t border-white/5' : ''}`}
                    >
                        <span className="w-[62px] shrink-0 tabular-nums text-white/90 font-semibold">{range}</span>
                        <span className="text-white/65">{meaning}</span>
                    </div>
                ))}
            </div>
            <p>
                Falls matter more than rises. A fast fall is a low deepening onto you and the wind arrives with it; a
                fast rise is usually a cold front already gone through — squally, clearing, less dangerous.
            </p>
            <p>
                <strong className="text-white">Where the low is:</strong> in the Southern Hemisphere, stand with the
                wind at your back and the low pressure is on your <em>right</em>. (Buys Ballot&apos;s law — reverse it
                north of the equator.)
            </p>
            <p>
                <strong className="text-white">Why STATION and not MSL:</strong> your iPhone&apos;s barometer measures
                the air where it is sitting, and its absolute calibration is only good to about a hPa. Its
                <em> movement</em> is good to a hundredth of one. Tap <span className="text-emerald-300">SET</span> to
                anchor the reading to the current forecast MSL pressure — after that the sensor carries the trend and
                the number is comparable to a chart.
            </p>
            <p className="text-white/50">
                Solid line: measured by this phone, last 6 hours. Dotted: forecast, next 12. When they diverge, believe
                the solid one about now and the dotted one about later.
            </p>
        </div>
    </div>
);

// ── Panel ────────────────────────────────────────────────────────────

interface BarometerPlusProps {
    onClose: () => void;
    /** Forecast hourly — supplies the forward trace and the calibration reference. */
    hourly?: HourlyForecast[];
    /** Current forecast MSLP (hPa), used when there is no sensor and as the calibration anchor. */
    forecastPressure?: number | null;
}

export const BarometerPlus: React.FC<BarometerPlusProps> = ({ onClose, hourly, forecastPressure }) => {
    const [showInfo, setShowInfo] = React.useState(false);
    const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
    const [availability, setAvailability] = React.useState<barometer.BarometerAvailability | null>(null);

    // Re-render on every new sample / calibration / unit change.
    React.useEffect(() => barometer.subscribe(forceRender), []);

    React.useEffect(() => {
        let alive = true;
        void barometer.checkAvailability().then((a) => {
            if (!alive) return;
            setAvailability(a);
            if (a.available) void barometer.startLogging();
        });
        return () => {
            alive = false;
        };
    }, []);

    const unit = barometer.getUnit();
    const unitLabel = unit === 'inHg' ? 'inHg' : 'hPa';
    const nowT = Date.now();

    const stationSamples: PressureSample[] = barometer.getStationSamples();
    const latest = barometer.getLatestSample();
    const { offsetHpa } = barometer.getOffset();
    const hasSensor = !!availability?.available && !!latest;

    // Forecast series for the forward trace, clipped to the chart window.
    const forecastPts: TracePoint[] = React.useMemo(() => {
        const out: TracePoint[] = [];
        for (const h of hourly || []) {
            const t = new Date(h.time).getTime();
            const v = h.pressure;
            if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue;
            if (t < nowT - 3_600_000 || t > nowT + FWD_MS) continue;
            out.push({ t, v });
        }
        return out.sort((a, b) => a.t - b.t);
    }, [hourly, nowT]);

    // The reference MSLP for calibration: the forecast value nearest now.
    const reference = React.useMemo(() => {
        if (typeof forecastPressure === 'number' && Number.isFinite(forecastPressure)) return forecastPressure;
        if (!forecastPts.length) return null;
        return forecastPts.reduce((a, b) => (Math.abs(b.t - nowT) < Math.abs(a.t - nowT) ? b : a)).v;
    }, [forecastPressure, forecastPts, nowT]);

    // Measured trace, offset-corrected so it sits on the same scale as the forecast.
    const measuredPts: TracePoint[] = React.useMemo(() => {
        const off = offsetHpa ?? 0;
        return stationSamples.filter((s) => s.t >= nowT - PAST_MS).map((s) => ({ t: s.t, v: s.hpa + off }));
        // stationSamples is derived from module state; forceRender drives updates.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [offsetHpa, nowT, stationSamples.length, latest?.t]);

    // Tendency comes off the RAW station record — the calibration offset is a
    // constant and cancels in a delta, so a re-calibration must never move it.
    const tendency: TendencyReading | null = React.useMemo(
        () => (hasSensor ? observedTendency(stationSamples, nowT) : null),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [hasSensor, nowT, stationSamples.length, latest?.t],
    );
    const collecting = hasSensor && !tendency ? timeUntilTendency(stationSamples, nowT) : null;

    const displayValue = hasSensor && latest ? latest.hpa + (offsetHpa ?? 0) : (reference ?? null);
    const calibrated = offsetHpa != null;

    const sev = tendency ? SEVERITY_UI[tendency.severity] : SEVERITY_UI.calm;
    const accent = tendency ? sev.dot : '#6ee7b7';

    const sourceChip = hasSensor
        ? { text: 'iPHONE', cls: 'bg-emerald-400/15 text-emerald-300' }
        : { text: 'FORECAST', cls: 'bg-sky-400/15 text-sky-300' };

    const subLabel = hasSensor ? (calibrated ? 'MSL · calibrated' : 'STATION · uncalibrated') : 'Model MSL pressure';

    const footer = (() => {
        if (tendency) return tendency.read;
        if (collecting != null)
            return `Collecting — a three-hour trend needs about ${fmtCountdown(collecting)} more of record.`;
        if (!availability) return 'Checking for a barometer…';
        if (availability.reason === 'denied')
            return 'Motion & Fitness access is off, so the phone barometer can’t be read. Forecast pressure shown.';
        if (availability.reason === 'no-hardware')
            return 'This device has no barometer. Showing the forecast’s sea-level pressure instead.';
        return 'No phone barometer here — showing the forecast’s sea-level pressure.';
    })();

    const stop = (e: React.SyntheticEvent) => e.stopPropagation();

    // Opaque, not glassy. The panel sits directly on ten metric cells full of
    // glowing numbers; at 92% (which silently compiled to nothing — /92 is
    // not a Tailwind opacity step) the grid read straight through, and even
    // at a genuine 97% the bright values behind stayed legible enough to turn
    // the barometer's own figures into soup. An instrument face is opaque.
    return (
        <div
            className="absolute inset-0 z-10 flex flex-col bg-slate-950 select-none"
            style={{ touchAction: 'auto' }}
            onClick={stop}
            onPointerDown={stop}
            role="region"
            aria-label="Barometer"
        >
            {/* Header — 24px */}
            <div className="h-6 shrink-0 flex items-center gap-1.5 px-2.5">
                <GaugeIcon className="w-3 h-3 text-emerald-400" />
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300">Barometer</span>
                <span className={`px-1.5 py-[1px] rounded text-[8.5px] font-black tracking-wider ${sourceChip.cls}`}>
                    {sourceChip.text}
                </span>

                <div className="ml-auto flex items-center gap-1">
                    {hasSensor && reference != null && (
                        <button
                            type="button"
                            onClick={() =>
                                calibrated ? barometer.clearCalibration() : barometer.calibrateTo(reference)
                            }
                            className="px-1.5 h-[18px] rounded bg-white/10 text-[8.5px] font-black tracking-wider text-white/70 active:scale-90 transition"
                            aria-label={
                                calibrated ? 'Clear calibration' : 'Anchor reading to forecast sea-level pressure'
                            }
                        >
                            {calibrated ? 'RESET' : 'SET'}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => barometer.setUnit(unit === 'hPa' ? 'inHg' : 'hPa')}
                        className="px-1.5 h-[18px] rounded bg-white/10 text-[8.5px] font-black tracking-wider text-white/70 active:scale-90 transition"
                        aria-label={`Switch to ${unit === 'hPa' ? 'inches of mercury' : 'hectopascals'}`}
                    >
                        {unitLabel}
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowInfo(true)}
                        aria-label="What the tendency means"
                        className="w-[18px] h-[18px] rounded-full bg-white/10 text-white/70 text-[10px] font-serif italic leading-none flex items-center justify-center active:scale-90 transition"
                    >
                        i
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close barometer"
                        className="w-[18px] h-[18px] rounded-full bg-white/10 text-white/70 text-[10px] leading-none flex items-center justify-center active:scale-90 transition"
                    >
                        ✕
                    </button>
                </div>
            </div>

            {/* Body — value block + trace */}
            <div className="flex-1 min-h-0 flex items-stretch gap-2 px-2.5">
                <div className="w-[122px] shrink-0 flex flex-col justify-center">
                    <div className="flex items-baseline gap-1">
                        <span
                            className="text-[30px] leading-none font-mono font-medium tracking-tight text-ivory"
                            style={{ fontFeatureSettings: '"tnum"' }}
                        >
                            {fmtPressure(displayValue, unit)}
                        </span>
                        <span className="text-[9px] text-white/45 font-medium">{unitLabel}</span>
                    </div>
                    <div className="mt-0.5 text-[8.5px] uppercase tracking-wider text-white/40">{subLabel}</div>

                    <div className="mt-1.5">
                        {tendency ? (
                            <div
                                className={`inline-flex items-center gap-1 px-1.5 py-[2px] rounded-full text-[9.5px] font-black ${sev.pill}`}
                            >
                                <span className="leading-none">
                                    {tendency.direction === 'rising'
                                        ? '▲'
                                        : tendency.direction === 'falling'
                                          ? '▼'
                                          : '▬'}
                                </span>
                                <span>{tendency.label}</span>
                                <span className="tabular-nums opacity-80">{fmtDelta(tendency.delta3h, unit)}/3h</span>
                            </div>
                        ) : (
                            <div className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded-full text-[9.5px] font-black bg-white/10 text-white/55">
                                <span className="leading-none">◴</span>
                                <span>{collecting != null ? 'Collecting' : 'No trend'}</span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex-1 min-w-0 flex flex-col">
                    <div className="flex-1 min-h-0">
                        <Trace measured={measuredPts} forecast={forecastPts} nowT={nowT} accent={accent} />
                    </div>
                    <div className="h-3 shrink-0 flex justify-between text-[8px] text-white/35 tracking-wide">
                        <span>−6 h</span>
                        <span>now</span>
                        <span>+12 h</span>
                    </div>
                </div>
            </div>

            {/* Footer read — 28px */}
            <div className="h-7 shrink-0 flex items-center px-2.5">
                <p className={`text-[9.5px] leading-tight line-clamp-2 ${tendency ? sev.line : 'text-white/55'}`}>
                    {footer}
                </p>
            </div>

            {showInfo && <Explainer onClose={() => setShowInfo(false)} />}
        </div>
    );
};

BarometerPlus.displayName = 'BarometerPlus';

export default BarometerPlus;
