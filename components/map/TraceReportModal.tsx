/**
 * Route report (masterplan Phase 3) — the review step of the Guided Passage
 * Builder. Once the trace is built (hand + auto), this modal groups every
 * leg verdict by severity, headlines THE departure window ("leave 09:10–
 * 13:30 and every tide gate clears"), and offers per-issue action:
 *   • Fix — micro-A* detour on the already-built tracer grid, spliced back
 *     as pins (the app doesn't just say no, it shows the way through);
 *   • Acknowledge — for the unfixable (uncharted / conflicting data): the
 *     skipper owns the line, the ack is explicit. No fake fixes, ever.
 * Approve-all runs every fixable danger in one tap.
 */
import React from 'react';
import type { TraceLegVerdict, TracePoint } from '../../services/routeTracer';
import { traceHealth } from '../../services/routeTracer';
import { triggerHaptic } from '../../utils/system';
import { windCompass, type WaypointWeather } from '../../services/routeReportWeather';
// The PDF service pulls in jsPDF (~350 KB) — lazy-imported in the export
// handler so it never weighs down the chart's initial bundle.

/** "+3h20 · 14:30" arrival label; the start pin reads "now"/"dep". */
const fmtEta = (w: WaypointWeather, departingNow: boolean): string => {
    const clock = new Date(w.etaMs).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (w.hoursFromDep < 0.02) return `${departingNow ? 'now' : 'dep'} · ${clock}`;
    const h = Math.floor(w.hoursFromDep);
    const m = Math.round((w.hoursFromDep - h) * 60);
    const rel = h > 0 ? `+${h}h${m > 0 ? String(m).padStart(2, '0') : ''}` : `+${m}m`;
    return `${rel} · ${clock}`;
};

/** "Sat 19 Jul 09:00" for a chosen departure. */
const fmtDepart = (ms: number): string =>
    new Date(ms).toLocaleString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
/** "SW 14kt G22", or a beyond-forecast note. */
const fmtWind = (w: WaypointWeather): string => {
    if (w.beyondForecast) return 'beyond forecast';
    if (w.windKts == null || w.windDeg == null) return '';
    const gust = w.gustKts != null && w.gustKts - w.windKts >= 3 ? ` G${Math.round(w.gustKts)}` : '';
    return `${windCompass(w.windDeg)} ${Math.round(w.windKts)}kt${gust}`;
};

interface Props {
    open: boolean;
    onClose: () => void;
    pins: TracePoint[];
    /** The route heading shown in the report + PDF, e.g. "Bribie - Newport". */
    routeName: string;
    /** null slot = leg still grading in its build window. */
    verdicts: Array<TraceLegVerdict | null>;
    tideLabels: Record<number, string>;
    /** null while computing, '' when nothing tide-gated. */
    departureLabel: string | null;
    ackedLegs: ReadonlySet<number>;
    /** Leg index currently being fixed (spinner), or null. */
    fixBusy: number | null;
    onFlyTo: (p: TracePoint) => void;
    onFixLeg: (i: number) => void;
    onFixAll: () => void;
    onAckLeg: (i: number) => void;
    vesselName?: string;
    draftM?: number;
    /** Cruising speed (kts) for the per-waypoint ETA/weather. Defaults to 6. */
    cruisingSpeedKts?: number;
    /** Chosen departure (epoch ms), null/absent = leave now. Anchors the
     *  per-waypoint ETAs + weather (the tide labels are anchored upstream). */
    departureMs?: number | null;
}

/** Decimal degrees → degrees-decimal-minutes with hemisphere (the marine
 *  standard a skipper keys into a plotter): -27.1417 → 27°08.50'S. */
const ddToDMM = (v: number, isLat: boolean): string => {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = (a - deg) * 60;
    return `${deg}°${min.toFixed(2).padStart(5, '0')}'${hemi}`;
};
const fmtFix = (p: TracePoint): string => `${ddToDMM(p.lat, true)}  ${ddToDMM(p.lon, false)}`;

const sevRow = (
    v: TraceLegVerdict,
    i: number,
    pins: TracePoint[],
    tideLabels: Record<number, string>,
    acked: ReadonlySet<number>,
    fixBusy: number | null,
    onFlyTo: Props['onFlyTo'],
    onFixLeg: Props['onFixLeg'],
    onAckLeg: Props['onAckLeg'],
): React.ReactNode => {
    // 'info' issues are green confirmations, not problems — never headline a
    // danger/caution row with one (a thin-water leg can also carry a correct-
    // mark-pass note). Report only the real issues here.
    const problems = v.issues.filter((iss) => iss.severity !== 'info');
    const spot = problems[0]?.mark ?? problems[0]?.at ?? v.minAt ?? pins[i];
    const isAcked = acked.has(i);
    return (
        <div key={i} className={`rounded-xl border border-white/10 bg-white/5 p-2 ${isAcked ? 'opacity-50' : ''}`}>
            <button onClick={() => onFlyTo(spot)} className="w-full text-left">
                <div className="flex items-start gap-1.5 text-[12px] leading-tight text-gray-100">
                    <span className={v.grade === 'danger' ? 'text-red-400' : 'text-amber-300'}>
                        {v.grade === 'danger' ? '⛔' : '⚠'}
                    </span>
                    <span>
                        <span className="font-mono text-gray-400">
                            leg {i + 1}→{i + 2}
                        </span>{' '}
                        {problems[0]?.message ?? v.grade}
                    </span>
                </div>
                <div className="pl-5 text-[11px] leading-tight text-gray-400">
                    {problems.slice(1).map((iss, k) => (
                        <div key={k}>· {iss.message}</div>
                    ))}
                    {tideLabels[i] && <div>🌊 {tideLabels[i]}</div>}
                    {v.nudge && <div>💡 {v.nudge}</div>}
                    <div className="text-gray-500">tap to view on the chart</div>
                </div>
            </button>
            {v.grade === 'danger' && !isAcked && (
                <div className="mt-1.5 flex gap-1.5 pl-5">
                    <button
                        onClick={() => onFixLeg(i)}
                        disabled={fixBusy !== null}
                        className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-50"
                    >
                        {fixBusy === i ? 'Fixing…' : 'Fix it'}
                    </button>
                    <button
                        onClick={() => onAckLeg(i)}
                        className="rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                    >
                        Acknowledge
                    </button>
                </div>
            )}
        </div>
    );
};

export const TraceReportModal: React.FC<Props> = ({
    open,
    onClose,
    pins,
    routeName,
    verdicts,
    tideLabels,
    departureLabel,
    ackedLegs,
    fixBusy,
    onFlyTo,
    onFixLeg,
    onFixAll,
    onAckLeg,
    vesselName,
    draftM,
    cruisingSpeedKts,
    departureMs,
}) => {
    const [exporting, setExporting] = React.useState(false);
    const [exportMsg, setExportMsg] = React.useState<string | null>(null);
    // Per-waypoint weather at the ETA from the chosen departure (or NOW).
    // Fetched when the report opens; feeds the waypoint list and the PDF.
    const [weather, setWeather] = React.useState<WaypointWeather[] | null>(null);
    const [weatherLoading, setWeatherLoading] = React.useState(false);
    const spd = cruisingSpeedKts && cruisingSpeedKts > 0 ? cruisingSpeedKts : 6;
    const departingNow = departureMs == null;
    React.useEffect(() => {
        if (!open || pins.length < 2) {
            setWeather(null);
            return;
        }
        let live = true;
        setWeatherLoading(true);
        const departM = departureMs ?? Date.now();
        void (async () => {
            try {
                const { fetchRouteWaypointWeather } = await import('../../services/routeReportWeather');
                const rows = await fetchRouteWaypointWeather(pins, departM, spd);
                if (live) setWeather(rows);
            } catch {
                if (live) setWeather(null);
            } finally {
                if (live) setWeatherLoading(false);
            }
        })();
        return () => {
            live = false;
        };
        // Re-fetch when the report (re)opens or the route/speed/departure changes.
    }, [open, pins, spd, departureMs]);
    const onExportPdf = React.useCallback(async () => {
        if (pins.length < 2 || exporting) return;
        setExporting(true);
        setExportMsg(null);
        triggerHaptic('medium');
        try {
            // Yield so the spinner paints, and lazy-load jsPDF off the main bundle.
            const [{ generateRouteReportPdf, getRouteReportFileName }, { sharePdfBlob }] = await Promise.all([
                import('../../services/RouteReportPdfService'),
                import('../../utils/sharePdf'),
            ]);
            const blob = generateRouteReportPdf({
                routeName,
                pins,
                verdicts,
                tideLabels,
                departureLabel,
                vesselName,
                draftM,
                weather,
                cruisingSpeedKts: spd,
                departureMs,
                nowMs: Date.now(),
            });
            const outcome = await sharePdfBlob(blob, getRouteReportFileName(routeName), `Route report - ${routeName || 'route'}`);
            if (outcome === 'downloaded') setExportMsg('PDF downloaded');
        } catch (err) {
            setExportMsg(`Couldn’t make the PDF (${err instanceof Error ? err.message.slice(0, 40) : 'error'})`);
        } finally {
            setExporting(false);
        }
    }, [pins, routeName, verdicts, tideLabels, departureLabel, vesselName, draftM, weather, spd, departureMs, exporting]);

    // GPX export (Shane 2026-07-17: "export it in a gpx file for importing into
    // a chartplotter") — a plain <rte> of the pins, shared/downloaded like the
    // PDF. Route (not track): OpenCPN/Garmin/B&G import it as an activatable plan.
    const onExportGpx = React.useCallback(async () => {
        if (pins.length < 2 || exporting) return;
        setExporting(true);
        setExportMsg(null);
        triggerHaptic('medium');
        try {
            const [{ traceToGpx, traceGpxFileName }, { shareFileBlob }] = await Promise.all([
                import('../../services/routeTracer'),
                import('../../utils/sharePdf'),
            ]);
            const blob = new Blob([traceToGpx(routeName, pins)], { type: 'application/gpx+xml' });
            const outcome = await shareFileBlob(
                blob,
                traceGpxFileName(routeName),
                `${routeName || 'Route'} — GPX`,
                'application/gpx+xml',
            );
            if (outcome === 'downloaded') setExportMsg('GPX downloaded');
        } catch (err) {
            setExportMsg(`Couldn’t make the GPX (${err instanceof Error ? err.message.slice(0, 40) : 'error'})`);
        } finally {
            setExporting(false);
        }
    }, [pins, routeName, exporting]);

    if (!open) return null;
    const h = traceHealth(verdicts);
    const graded = verdicts.map((v, i) => ({ v, i })).filter((x): x is { v: TraceLegVerdict; i: number } => !!x.v);
    const dangers = graded.filter((x) => x.v.grade === 'danger');
    const cautions = graded.filter((x) => x.v.grade === 'caution');
    const fixable = dangers.filter((x) => !ackedLegs.has(x.i));
    return (
        // CENTRED, not bottom-pinned (Shane 2026-07-18: "the route report is not
        // sitting nicely on the phone screen, it is down the bottom"). It was an
        // items-end sheet, so a short report hugged the very bottom edge and the
        // "Fix all" footer button sat under the home indicator with only py-3
        // between them. The overlay now insets by the safe areas, so the card
        // can never reach an edge on any device.
        //
        // dvh, not vh: on iOS vh is the LARGEST viewport (toolbars retracted),
        // so a vh-capped sheet overflows whenever they're showing.
        <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/60 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
            {/* flex-col + a flexing body: header and footer keep their height and
                the leg list takes the rest. The old fixed max-h-[46vh] body could
                not compose with the 80vh cap once header, departure row and footer
                were stacked on it — the footer got pushed out of the card. */}
            <div className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                    <div className="min-w-0">
                        <div className="text-sm font-black uppercase tracking-widest text-amber-300">Route report</div>
                        {routeName.trim() !== '' && (
                            <div className="truncate text-[13px] font-bold text-gray-100">{routeName}</div>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                        <button
                            onClick={() => void onExportGpx()}
                            disabled={exporting || pins.length < 2}
                            title="Export as GPX for a chartplotter (OpenCPN, Garmin, B&G…)"
                            className="rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-40"
                        >
                            ⬇ GPX
                        </button>
                        <button
                            onClick={() => void onExportPdf()}
                            disabled={exporting || pins.length < 2}
                            className="rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wide text-sky-300 active:scale-95 disabled:opacity-40"
                        >
                            {exporting ? 'Making…' : '⬇ PDF'}
                        </button>
                        <button onClick={onClose} className="text-sm font-bold text-gray-400">
                            Close
                        </button>
                    </div>
                </div>
                {exportMsg && (
                    <div className="shrink-0 border-b border-white/10 bg-sky-500/10 px-4 py-1.5 text-[11px] font-bold text-sky-300">
                        {exportMsg}
                    </div>
                )}
                <div className="shrink-0 border-b border-white/10 px-4 py-2 text-[12px] font-bold">
                    <span className="text-emerald-300">{h.clear} clear</span>
                    <span className="text-gray-500"> · </span>
                    <span className="text-amber-300">{h.caution} caution</span>
                    <span className="text-gray-500"> · </span>
                    <span className="text-red-400">{h.danger} no-go</span>
                    {h.pending > 0 && (
                        <>
                            <span className="text-gray-500"> · </span>
                            <span className="text-gray-400">{h.pending} checking…</span>
                        </>
                    )}
                </div>
                {departureLabel === null ? (
                    <div className="shrink-0 border-b border-white/10 px-4 py-2 text-[11px] text-gray-400">
                        Checking tide gates…
                    </div>
                ) : departureLabel !== '' ? (
                    <div className="shrink-0 border-b border-white/10 bg-sky-500/10 px-4 py-2.5 text-[13px] font-black leading-snug text-sky-300">
                        🌊 {departureLabel}
                    </div>
                ) : null}
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
                    {verdicts.length === 0 && (
                        <div className="text-[12px] text-gray-400">No legs yet — trace a route first.</div>
                    )}
                    {dangers.map((x) =>
                        sevRow(x.v, x.i, pins, tideLabels, ackedLegs, fixBusy, onFlyTo, onFixLeg, onAckLeg),
                    )}
                    {cautions.map((x) =>
                        sevRow(x.v, x.i, pins, tideLabels, ackedLegs, fixBusy, onFlyTo, onFixLeg, onAckLeg),
                    )}
                    {h.danger === 0 && h.caution === 0 && h.pending === 0 && verdicts.length > 0 && (
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-[12px] font-bold text-emerald-300">
                            ✓ Every leg checks out for your keel. Good water the whole way.
                        </div>
                    )}
                    {h.danger === 0 && h.caution === 0 && h.pending > 0 && (
                        <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-[12px] font-bold text-gray-300">
                            Still checking {h.pending} leg{h.pending > 1 ? 's' : ''} — hold fast.
                        </div>
                    )}
                    {/* Every waypoint in order, degrees-decimal-minutes — read
                        straight into a plotter, or tap one to fly there. */}
                    {pins.length > 0 && (
                        <div className="rounded-xl border border-white/10 bg-white/5 p-2.5">
                            <div className="mb-1.5 flex items-baseline justify-between">
                                <span className="text-[11px] font-black uppercase tracking-widest text-gray-400">
                                    📍 Waypoints ({pins.length})
                                </span>
                                <span className="text-[10px] font-bold text-gray-500">
                                    {weatherLoading
                                        ? 'loading weather…'
                                        : weather
                                          ? `ETA + wind · leave ${departingNow ? 'now' : fmtDepart(departureMs!)} @ ${spd.toFixed(1)}kt`
                                          : ''}
                                </span>
                            </div>
                            <div className="space-y-0.5 font-mono text-[11px] text-gray-200">
                                {pins.map((p, i) => {
                                    const w = weather?.[i];
                                    const windStr = w ? fmtWind(w) : '';
                                    return (
                                        <button
                                            key={i}
                                            onClick={() => onFlyTo(p)}
                                            className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left active:bg-white/10"
                                        >
                                            <span className="w-6 shrink-0 text-right text-amber-300/80">{i + 1}</span>
                                            <span className="tabular-nums">{fmtFix(p)}</span>
                                            {w && (
                                                <span className="ml-auto shrink-0 text-right">
                                                    <span className="text-sky-300/90">{fmtEta(w, departingNow)}</span>
                                                    {windStr && (
                                                        <span
                                                            className={`ml-2 ${w.beyondForecast ? 'text-gray-500' : w.gustKts != null && w.gustKts >= 25 ? 'text-amber-300' : 'text-gray-300'}`}
                                                        >
                                                            {windStr}
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
                {fixable.length > 0 && (
                    <div className="shrink-0 border-t border-white/10 px-4 py-3">
                        <button
                            onClick={onFixAll}
                            disabled={fixBusy !== null}
                            className="w-full rounded-xl bg-emerald-500/20 py-2.5 text-[12px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-50"
                        >
                            {fixBusy !== null
                                ? 'Fixing…'
                                : `Fix all ${fixable.length} no-go leg${fixable.length > 1 ? 's' : ''}`}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
