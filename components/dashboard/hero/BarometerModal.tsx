/** Full-size pressure history and tendency. The 163 px Glass cell is unchanged. */
import React from 'react';
import { ModalSheet } from '../../ui/ModalSheet';
import { GaugeIcon } from '../../Icons';
import type { HourlyForecast } from '../../../types';
import {
    marineTendency,
    timeUntilTendency,
    hpaToInHg,
    type PressureSample,
    type TendencyReading,
    type TendencySeverity,
} from '../../../utils/barometerTendency';
import * as barometer from '../../../services/native/barometer';
import { useBarometerSource } from '../../../hooks/useBarometerSource';
import { enablePressureNotifications } from '../../../services/PressureNotificationService';

/** Chart span: what the sensor measured, then what the model expects. */
const HISTORY_HOURS = [6, 12, 24, 48] as const;
const FWD_MS = 12 * 3_600_000;

const SEVERITY_UI: Record<TendencySeverity, { pill: string; dot: string; line: string }> = {
    calm: {
        pill: 'bg-emerald-400/15 text-emerald-300',
        dot: 'var(--day-ui-success, #6ee7b7)',
        line: 'text-emerald-300',
    },
    watch: { pill: 'bg-amber-400/15 text-amber-200', dot: 'var(--day-ui-amber, #fcd34d)', line: 'text-amber-200' },
    warn: { pill: 'bg-red-400/15 text-red-300', dot: 'var(--day-ui-danger, #fca5a5)', line: 'text-red-300' },
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
 * The instrument trace: measured behind, forecast MSL, one shared vertical
 * scale. Identical geometry to the old grid panel — the SVG scales to
 * whatever box it is given, and here it is given a real one.
 */
const Trace: React.FC<{
    measured: TracePoint[];
    forecast: TracePoint[];
    nowT: number;
    accent: string;
    pastHours: number;
}> = ({ measured, forecast, nowT, accent, pastHours }) => {
    const W = 240;
    const H = 74;
    const PAD_Y = 7;

    const all = [...measured, ...forecast];
    if (all.length < 2) {
        return (
            <div className="h-full flex items-center justify-center text-xs text-white/35 tracking-wide">
                No trace yet
            </div>
        );
    }

    const minT = nowT - pastHours * 3_600_000;
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
    const path = (pts: TracePoint[], maxGapMs = 45 * 60_000) =>
        pts
            .map(
                (p, i) => `${i && p.t - pts[i - 1].t <= maxGapMs ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`,
            )
            .join(' ');

    const nowX = x(nowT);
    const measuredPath = path(measured);
    const forecastPath = path(forecast, 3 * 3_600_000);
    const lastMeasured = measured[measured.length - 1];

    // Fill under the measured trace only — it's the part that happened.
    const fill =
        measured.length > 1 && !measured.some((p, i) => i > 0 && p.t - measured[i - 1].t > 45 * 60_000)
            ? `${measuredPath} L${x(lastMeasured.t).toFixed(1)},${H} L${x(measured[0].t).toFixed(1)},${H} Z`
            : '';

    return (
        <svg
            role="img"
            aria-label={`${pastHours} hours of pressure history and 12 hours of forecast MSL pressure`}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-full"
            preserveAspectRatio="none"
        >
            <defs>
                <linearGradient id="baro-modal-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accent} stopOpacity="0.34" />
                    <stop offset="100%" stopColor={accent} stopOpacity="0" />
                </linearGradient>
            </defs>

            {/* Hour gridlines every 3 h — the tendency window, drawn. */}
            {[-pastHours, -pastHours / 2, 3, 6, 9, 12].map((h) => (
                <line
                    key={h}
                    x1={x(nowT + h * 3_600_000)}
                    y1={0}
                    x2={x(nowT + h * 3_600_000)}
                    y2={H}
                    stroke="var(--day-ui-grid, #ffffff)"
                    strokeOpacity="var(--day-ui-line-opacity, 0.06)"
                    strokeWidth={1}
                />
            ))}

            {fill && <path d={fill} fill="url(#baro-modal-fill)" />}

            {forecast.length > 1 && (
                <path
                    data-testid="barometer-forecast-trace"
                    d={forecastPath}
                    fill="none"
                    stroke="var(--day-ui-guide, #ffffff)"
                    strokeOpacity="var(--day-ui-line-opacity, 0.35)"
                    strokeWidth={1.4}
                    strokeDasharray="3 3"
                    strokeLinecap="round"
                />
            )}

            {measured.length > 1 && (
                <path
                    data-testid="barometer-measured-trace"
                    d={measuredPath}
                    fill="none"
                    stroke={accent}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            )}

            <line
                x1={nowX}
                y1={0}
                x2={nowX}
                y2={H}
                stroke="var(--day-ui-guide, #ffffff)"
                strokeOpacity="var(--day-ui-line-opacity, 0.28)"
                strokeWidth={1}
            />
            {lastMeasured && (
                <>
                    <circle cx={x(lastMeasured.t)} cy={y(lastMeasured.v)} r={5} fill={accent} opacity={0.28} />
                    <circle cx={x(lastMeasured.t)} cy={y(lastMeasured.v)} r={2.4} fill="var(--day-ui-text, #fff)" />
                </>
            )}
        </svg>
    );
};

// ── Explainer ────────────────────────────────────────────────────────

const BAND_ROWS: [string, string][] = [
    ['under 0.1', 'Steady'],
    ['0.1 – 1.5', 'Rising or falling slowly'],
    ['1.6 – 3.5', 'Rising or falling'],
    ['3.6 – 6.0', 'Rising or falling quickly'],
    ['over 6.0', 'Rising or falling very rapidly'],
];

/** The full explainer, inline. In a real-sized screen it can simply be a
 *  section the skipper scrolls, instead of an overlay hiding the instrument. */
const Explainer: React.FC = () => (
    <div className="space-y-3 text-[13px] leading-relaxed text-white/75">
        <p>
            The tendency describes <strong className="text-white">change over three hours</strong>. These marine
            pressure bands do not predict a front, gale or arrival time on their own. Compare pressure with the wind,
            official warnings and the forecast.
        </p>
        <div className="rounded-xl border border-white/10 overflow-hidden">
            {BAND_ROWS.map(([range, meaning], i) => (
                <div
                    key={range}
                    className={`flex gap-3 px-3 py-2 ${i % 2 ? 'bg-white/3' : ''} ${i ? 'border-t border-white/5' : ''}`}
                >
                    <span className="w-[76px] shrink-0 tabular-nums text-white/90 font-semibold">{range}</span>
                    <span className="text-white/65">{meaning}</span>
                </div>
            ))}
        </div>
        <p>
            BOAT uses the Pi&apos;s BMP390, with fresh Signal K environment.outside.pressure as fallback. The Pi retains
            ten days across restarts. iPHONE uses this device&apos;s observed record; height changes and carrying it
            ashore can create false trends. A stale sensor cannot supply an alarm.
        </p>
        <p>
            STATION is pressure at the sensor. SET anchors only this phone&apos;s absolute value to forecast MSL
            pressure; it is a model reference, not an independently measured sea-level correction. It never calibrates
            the boat&apos;s sensor or changes its tendency.
        </p>
        <p>
            The tropical daily pressure tide can mimic a weather fall. Correction needs five agreeing prior days from a
            nearby sensor position. Until that record exists, or when it disagrees, raw change is shown with the reason.
            A very rapid raw fall still alerts. The alarm operates while this app is alive; it cannot provide an
            owner-away watch.
        </p>
        <p className="text-white/50">
            Solid line: observed pressure over your selected window. Dotted line: forecast MSL pressure, including the
            next 12 hours. An uncalibrated station trace may have an absolute offset from MSL. Neither line is moved to
            disguise that difference.
        </p>
    </div>
);

// ── Modal ────────────────────────────────────────────────────────────

interface BarometerModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Forecast hourly — supplies the forward trace and the calibration reference. */
    hourly?: HourlyForecast[];
    /** Current forecast MSLP (hPa), used when there is no sensor and as the calibration anchor. */
    forecastPressure?: number | null;
}

/** Big-target button shared by the control row. 48 px minimum — these were
 *  18 px in the grid panel, which on a moving boat is a coin toss. */
const ControlButton: React.FC<{
    onClick: () => void;
    label: string;
    sub?: string;
    active?: boolean;
    ariaLabel: string;
}> = ({ onClick, label, sub, active, ariaLabel }) => (
    <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={`flex-1 min-h-12 rounded-xl px-3 py-2 flex flex-col items-center justify-center gap-0.5 transition active:scale-[0.97] ${
            active ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/[0.07] text-white/80'
        }`}
    >
        <span className="text-sm font-black tracking-wide leading-none">{label}</span>
        {sub && <span className="text-[10px] uppercase tracking-wider opacity-60 leading-none">{sub}</span>}
    </button>
);

export const BarometerModal: React.FC<BarometerModalProps> = ({ isOpen, onClose, hourly, forecastPressure }) => {
    const [showInfo, setShowInfo] = React.useState(false);
    const [pastHours, setPastHours] = React.useState<number>(6);
    const [notificationStatus, setNotificationStatus] = React.useState('');
    const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
    const [availability, setAvailability] = React.useState<barometer.BarometerAvailability | null>(null);

    // Re-render on every new sample / calibration / unit change.
    React.useEffect(() => barometer.subscribe(forceRender), []);

    React.useEffect(() => {
        if (!isOpen) return;
        let alive = true;
        void barometer.checkAvailability().then((a) => {
            if (!alive) return;
            setAvailability(a);
            if (a.available) void barometer.startLogging();
        });
        return () => {
            alive = false;
        };
    }, [isOpen]);

    // Minute-coarse clock. The old grid panel recomputed its time-anchored
    // memos on every 15 s sample tick; dropping nowT from the deps here froze
    // them at open time instead — and this modal's whole use case is sitting
    // open as a cockpit instrument. Frozen, the forecast trace slid into the
    // measured half of the chart, SET could anchor calibration to an
    // hours-old MSLP, and a STALLED sensor kept its last "Falling quickly"
    // verdict forever instead of degrading to "No trend" (review,
    // 2026-08-21). One coarse tick refreshes them all without thrashing.
    const [clockMin, setClockMin] = React.useState(() => Math.floor(Date.now() / 60_000));
    React.useEffect(() => {
        if (!isOpen) return;
        const id = setInterval(() => setClockMin(Math.floor(Date.now() / 60_000)), 30_000);
        return () => clearInterval(id);
    }, [isOpen]);

    const unit = barometer.getUnit();
    const unitLabel = unit === 'inHg' ? 'inHg' : 'hPa';
    const nowT = Date.now();

    /* THE BOAT'S SENSOR OUTRANKS THE PHONE, here as well as on the Instrument
       Panel — the same hook, so the two barometer surfaces cannot show the
       skipper different pressures. The phone is NOT retired: it is the only
       barometer a punter without a Pi has, and the only one that still works
       ashore or while the Pi reboots. It is simply no longer preferred when
       something better is bolted to the vessel. */
    const boat = useBarometerSource(isOpen);
    const usingBoat = boat.source === 'boat';

    const phoneSamples: PressureSample[] = barometer.getStationSamples();
    const phoneLatest = barometer.getLatestSample();
    const { offsetHpa } = barometer.getOffset();

    const stationSamples: PressureSample[] = usingBoat ? boat.samples : phoneSamples;
    const latest = usingBoat ? boat.latest : phoneLatest;
    const hasSensor = usingBoat || (!!availability?.available && !!phoneLatest);

    // Forecast series for the forward trace, clipped to the chart window.
    const forecastPts: TracePoint[] = React.useMemo(() => {
        const out: TracePoint[] = [];
        for (const h of hourly || []) {
            const t = new Date(h.time).getTime();
            const v = h.pressure;
            if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue;
            if (t < nowT - pastHours * 3_600_000 || t > nowT + FWD_MS) continue;
            out.push({ t, v });
        }
        return out.sort((a, b) => a.t - b.t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hourly, clockMin, pastHours]);

    // The reference MSLP for calibration: the forecast value nearest now.
    const reference = React.useMemo(() => {
        if (typeof forecastPressure === 'number' && Number.isFinite(forecastPressure)) return forecastPressure;
        if (!forecastPts.length) return null;
        return forecastPts.reduce((a, b) => (Math.abs(b.t - nowT) < Math.abs(a.t - nowT) ? b : a)).v;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [forecastPressure, forecastPts, clockMin]);

    // Measured trace, offset-corrected so it sits on the same scale as the forecast.
    const measuredPts: TracePoint[] = React.useMemo(() => {
        const off = usingBoat ? 0 : (offsetHpa ?? 0);
        return stationSamples
            .filter((s) => s.t >= nowT - pastHours * 3_600_000 && s.t <= nowT && Number.isFinite(s.hpa))
            .map((s) => ({ t: s.t, v: s.hpa + off }));
        // stationSamples is derived from module state; forceRender drives updates.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [offsetHpa, usingBoat, stationSamples.length, latest?.t, clockMin, pastHours]);

    // Tendency comes off the RAW station record — the calibration offset is a
    // constant and cancels in a delta, so a re-calibration must never move it.
    const tendency: TendencyReading | null = React.useMemo(
        () => (hasSensor ? marineTendency(stationSamples, nowT) : null),
        // clockMin keeps a STALLED sensor honest: with no new samples,
        // latest?.t stops advancing and the verdict would otherwise freeze.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [hasSensor, stationSamples.length, latest?.t, clockMin],
    );
    const collecting = hasSensor && !tendency ? timeUntilTendency(stationSamples, nowT) : null;

    /* The offset corrects CMAltimeter's ±1 hPa unit-to-unit error. The BMP390
       measured 0.5 hPa from ECMWF on install, so applying the phone's
       correction to it would introduce the very error it exists to remove. */
    const displayValue = hasSensor && latest ? latest.hpa + (usingBoat ? 0 : (offsetHpa ?? 0)) : (reference ?? null);
    const calibrated = !usingBoat && offsetHpa != null;

    const sev = tendency ? SEVERITY_UI[tendency.severity] : SEVERITY_UI.calm;
    const accent = tendency ? sev.dot : 'var(--day-ui-success, #6ee7b7)';

    const sourceChip = usingBoat
        ? { text: 'BOAT', cls: 'bg-teal-400/15 text-teal-300' }
        : hasSensor
          ? { text: 'iPHONE', cls: 'bg-emerald-400/15 text-emerald-300' }
          : { text: 'FORECAST', cls: 'bg-sky-400/15 text-sky-300' };

    const subLabel = usingBoat
        ? 'BOAT SENSOR · continuous'
        : hasSensor
          ? calibrated
              ? 'MSL · calibrated'
              : 'STATION · uncalibrated'
          : 'Model MSL pressure';

    const statusRead = (() => {
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

    return (
        <ModalSheet isOpen={isOpen} onClose={onClose} title="Barometer" maxWidth="max-w-lg">
            <div className="space-y-5">
                {/* Source + calibration state */}
                <div className="-mt-2 flex items-center gap-2">
                    <GaugeIcon className="w-4 h-4 text-emerald-400" />
                    <span className={`px-2 py-0.5 rounded-sm text-[10px] font-black tracking-wider ${sourceChip.cls}`}>
                        {sourceChip.text}
                    </span>
                    <span className="text-[11px] uppercase tracking-wider text-white/40">{subLabel}</span>
                </div>

                {/* Hero reading + tendency */}
                <div className="flex items-end justify-between gap-3 flex-wrap">
                    <div className="flex items-baseline gap-2">
                        <span
                            className="text-6xl leading-none font-mono font-medium tracking-tight text-ivory"
                            style={{ fontFeatureSettings: '"tnum"' }}
                        >
                            {fmtPressure(displayValue, unit)}
                        </span>
                        <span className="text-sm text-white/45 font-medium">{unitLabel}</span>
                    </div>

                    {tendency ? (
                        <div
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-black ${sev.pill}`}
                        >
                            <span className="leading-none">
                                {tendency.direction === 'rising' ? '▲' : tendency.direction === 'falling' ? '▼' : '▬'}
                            </span>
                            <span>{tendency.label}</span>
                            <span className="tabular-nums opacity-80">{fmtDelta(tendency.delta3h, unit)}/3h</span>
                        </div>
                    ) : (
                        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-black bg-white/10 text-white/55">
                            <span className="leading-none">◴</span>
                            <span>{collecting != null ? 'Collecting' : 'No trend'}</span>
                        </div>
                    )}
                </div>

                {/* The read — full sentence, never clipped (the grid panel
                    line-clamped this to 2 lines of 9.5 px). */}
                <p className={`text-[13px] leading-relaxed ${tendency ? sev.line : 'text-white/55'}`}>{statusRead}</p>

                {tendency?.diurnal && (
                    <p className="text-xs text-white/55">
                        {tendency.diurnal.reason}
                        {tendency.diurnal.applied
                            ? ` Raw change ${(tendency.rawDelta3h ?? 0).toFixed(1)} hPa/3 h.`
                            : ''}
                    </p>
                )}

                {/* Trace */}
                <div>
                    <div className="flex gap-2 mb-2" role="group" aria-label="Pressure history window">
                        {HISTORY_HOURS.map((hours) => (
                            <button
                                key={hours}
                                type="button"
                                aria-pressed={pastHours === hours}
                                onClick={() => setPastHours(hours)}
                                className={`flex-1 min-h-12 rounded-xl text-sm font-semibold ${pastHours === hours ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/[0.07] text-white/80'}`}
                            >
                                {hours} h
                            </button>
                        ))}
                    </div>
                    <div className="h-44 rounded-xl bg-white/3 border border-white/6 p-2">
                        <Trace
                            measured={measuredPts}
                            forecast={forecastPts}
                            nowT={nowT}
                            accent={accent}
                            pastHours={pastHours}
                        />
                    </div>
                    <div className="mt-1.5 relative h-4 text-[11px] text-white/35 tracking-wide">
                        <span className="absolute left-0">−{pastHours} h</span>
                        <span
                            className="absolute -translate-x-1/2"
                            style={{ left: (pastHours / (pastHours + 12)) * 100 + '%' }}
                        >
                            now
                        </span>
                        <span className="absolute right-0">+12 h</span>
                    </div>
                    <div className="mt-1 text-[11px] text-white/40">
                        <span className="text-white/70">━</span> measured {usingBoat ? 'on the boat' : 'on this phone'}
                        &ensp;
                        <span className="text-white/50">┄</span> forecast ahead
                    </div>
                </div>

                {/* Controls — the easy-click row */}
                {notificationStatus && (
                    <p role="status" className="text-xs text-white/60">
                        {notificationStatus}
                    </p>
                )}
                <div className="flex gap-2">
                    <ControlButton
                        onClick={() => {
                            void enablePressureNotifications()
                                .then((ok) =>
                                    setNotificationStatus(
                                        ok
                                            ? 'Pressure notifications enabled while the app is alive.'
                                            : 'Notifications are off in device settings; in-app pressure warnings remain available.',
                                    ),
                                )
                                .catch(() => setNotificationStatus('Could not enable device notifications.'));
                        }}
                        label="ALERTS"
                        sub="while app alive"
                        ariaLabel="Enable pressure fall notifications"
                    />
                    {hasSensor && !usingBoat && reference != null && (
                        <ControlButton
                            onClick={() =>
                                calibrated ? barometer.clearCalibration() : barometer.calibrateTo(reference)
                            }
                            label={calibrated ? 'RESET' : 'SET'}
                            sub={calibrated ? 'to station' : 'anchor to MSL'}
                            active={calibrated}
                            ariaLabel={
                                calibrated ? 'Clear calibration' : 'Anchor reading to forecast sea-level pressure'
                            }
                        />
                    )}
                    <ControlButton
                        onClick={() => barometer.setUnit(unit === 'hPa' ? 'inHg' : 'hPa')}
                        label={unitLabel}
                        sub={unit === 'hPa' ? 'switch to inHg' : 'switch to hPa'}
                        ariaLabel={`Switch to ${unit === 'hPa' ? 'inches of mercury' : 'hectopascals'}`}
                    />
                    <ControlButton
                        onClick={() => setShowInfo((v) => !v)}
                        label="GUIDE"
                        sub="reading the tendency"
                        active={showInfo}
                        ariaLabel="What the tendency means"
                    />
                </div>

                {/* Explainer — inline section, scrolls with the sheet */}
                {showInfo && <Explainer />}
            </div>
        </ModalSheet>
    );
};

BarometerModal.displayName = 'BarometerModal';

export default BarometerModal;
