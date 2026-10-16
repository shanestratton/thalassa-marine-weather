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
import {
    traceGpxFileName,
    traceHealth,
    traceToGpx,
    type TraceLegVerdict,
    type TracePoint,
} from '../../services/routeTracer';
import { triggerHaptic } from '../../utils/system';
import type { RouteWeatherReport } from '../../services/routeMeteogram';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { traceVerificationSummary, type TraceReleaseGate } from '../../services/traceVerification';
import { useSettingsStore } from '../../stores/settingsStore';
import { haversineNm } from '../../services/isochrone/geodesy';
import { estimateRouteFuel } from '../../services/isochrone/routeStats';
import { vesselIsochroneConfig } from '../../services/routing/isochronePolicy';
import { RouteEstimateSummary } from '../passage/RouteEstimateSummary';
// The PDF service pulls in jsPDF (~350 KB) — lazy-imported in the export
// handler so it never weighs down the chart's initial bundle.

const RouteMeteogram = React.lazy(() => import('../weather/RouteMeteogram'));
const AlongRouteReport = React.lazy(() => import('./AlongRouteReport'));

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
    /** Single geometry-bound release verdict shared with Save and Sail. */
    releaseGate: TraceReleaseGate;
    /** Leg index currently being fixed (spinner), or null. */
    fixBusy: number | null;
    /**
     * Chart controls, OPTIONAL so this report can be shown where there is no
     * route editor — the Log page opens it at cast-off purely so the skipper
     * can acknowledge no-go legs without a trip to Route Tracer. Acknowledging
     * is a decision and can happen anywhere; fixing is an EDIT and belongs in
     * the editor, so when these are absent their buttons are not rendered
     * rather than rendered dead.
     */
    onFlyTo?: (p: TracePoint) => void;
    onFixLeg?: (i: number) => void;
    onFixAll?: () => void;
    onAckLeg: (i: number) => void;
    vesselName?: string;
    draftM?: number;
    /** Stated planned speed, editable in route weather. Missing never implies 6 kt. */
    cruisingSpeedKts?: number;
    /** Chosen departure (epoch ms), null/absent = leave now. Anchors the
     *  per-waypoint ETAs + weather (the tide labels are anchored upstream). */
    departureMs?: number | null;
}

/** Decimal degrees → degrees-decimal-minutes with hemisphere (the marine
 *  standard a skipper keys into a plotter): -27.1417 → 27°08.50'S. */
const ddToDMM = (v: number, isLat: boolean): string => {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : v >= 0 ? 'E' : 'W';
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = (a - deg) * 60;
    return `${deg}°${min.toFixed(2).padStart(5, '0')}'${hemi}`;
};
const fmtFix = (p: TracePoint): string => `${ddToDMM(p.lat, true)}  ${ddToDMM(p.lon, false)}`;

export function formatWaypointEtaUTC(w: { etaMs: number; hoursFromDep: number }): string {
    if (
        !Number.isFinite(w.etaMs) ||
        Math.abs(w.etaMs) > 8.64e15 ||
        !Number.isFinite(w.hoursFromDep) ||
        w.hoursFromDep < 0
    )
        return 'Unknown';
    const clock = new Date(w.etaMs).toISOString().slice(11, 16);
    // Round the whole interval first: a remainder must never become "+2h60".
    const totalMin = Math.round(w.hoursFromDep * 60);
    const h = Math.floor(totalMin / 60),
        m = totalMin % 60;
    return `${totalMin === 0 ? 'dep' : h ? `+${h}h${m ? String(m).padStart(2, '0') : ''}` : `+${m}m`} · ${clock} UTC`;
}

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
            <button onClick={() => onFlyTo?.(spot)} className="min-h-[44px] w-full text-left" disabled={!onFlyTo}>
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
                    {onFlyTo && <div className="text-gray-500">tap to view on the chart</div>}
                </div>
            </button>
            {v.grade === 'danger' && !isAcked && (
                <div className="mt-1.5 flex gap-1.5 pl-5">
                    {onFixLeg && (
                        <button
                            onClick={() => onFixLeg(i)}
                            disabled={fixBusy !== null}
                            className="min-h-[44px] rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-50"
                        >
                            {fixBusy === i ? 'Fixing…' : 'Fix it'}
                        </button>
                    )}
                    <button
                        onClick={() => onAckLeg(i)}
                        className="min-h-[44px] rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
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
    releaseGate,
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
    const closeButtonRef = React.useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(open, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });
    const [showRouteWeather, setShowRouteWeather] = React.useState(false);
    const [showAlongRoute, setShowAlongRoute] = React.useState(false);
    const [sampledWeather, setSampledWeather] = React.useState<RouteWeatherReport | null>(null);
    const vessel = useSettingsStore((state) => state.settings.vessel);
    const settings = useSettingsStore((state) => state.settings);
    // Full geometry and actual performance inputs fence stale screen/PDF rows.
    // This in-memory key is never a provider parameter or a saved chart fact.
    const weatherIdentity = JSON.stringify([
        routeName,
        pins,
        departureMs,
        cruisingSpeedKts,
        vesselName,
        vessel,
        settings.polarData,
        settings.polarSource,
        settings.polarSource_type,
        settings.polarBoatModel,
        settings.smartPolarsEnabled,
        settings.routingPolarScale,
    ]);
    const routeWeather =
        sampledWeather?.identity === weatherIdentity && isAuthIdentityScopeCurrent(sampledWeather.ownerScope)
            ? sampledWeather
            : null;
    const timingRef = React.useRef({ identity: '', open: false, departure: Date.now() });
    if (timingRef.current.identity !== weatherIdentity || (open && !timingRef.current.open))
        timingRef.current = { identity: weatherIdentity, open, departure: departureMs ?? Date.now() };
    else timingRef.current.open = open;
    const etaDeparture = routeWeather?.departureMs ?? timingRef.current.departure;
    const etaSpeed = routeWeather?.speedKts ?? cruisingSpeedKts;
    const waypointEtas = React.useMemo(() => {
        if (!Number.isFinite(etaSpeed) || !etaSpeed || etaSpeed <= 0 || etaSpeed > 100 || pins.length > 10000)
            return null;
        let distance = 0;
        return pins.map((p, i) => {
            if (i) distance += haversineNm(pins[i - 1].lat, pins[i - 1].lon, p.lat, p.lon);
            const hoursFromDep = distance / etaSpeed;
            return formatWaypointEtaUTC({ etaMs: etaDeparture + hoursFromDep * 3600000, hoursFromDep });
        });
    }, [pins, etaDeparture, etaSpeed]);
    const exportState = React.useRef({ open, identity: weatherIdentity, routeWeather, releaseGate });
    exportState.current = { open, identity: weatherIdentity, routeWeather, releaseGate };
    React.useEffect(
        () => () => {
            exportState.current.open = false;
        },
        [],
    );
    React.useEffect(() => {
        if (!open) {
            setShowRouteWeather(false);
            setShowAlongRoute(false);
            setSampledWeather(null);
        }
    }, [open]);
    const routeFuel = React.useMemo(() => {
        if (pins.length < 2 || (vesselName && vessel?.name !== vesselName)) return null;
        const distance = pins
            .slice(1)
            .reduce((sum, p, i) => sum + haversineNm(pins[i].lat, pins[i].lon, p.lat, p.lon), 0);
        const motorSpeed = vesselIsochroneConfig(vessel, distance).motoringSpeed;
        return estimateRouteFuel(null, distance / motorSpeed, vessel);
    }, [pins, vessel, vesselName]);
    const onExportPdf = React.useCallback(async () => {
        if (pins.length < 2 || exporting) return;
        if (!releaseGate.allowed || !releaseGate.verification) {
            setExportMsg(releaseGate.reason || 'Check the route again before exporting');
            return;
        }
        setExporting(true);
        const scope = getAuthIdentityScope();
        setExportMsg(null);
        triggerHaptic('medium');
        try {
            // Yield so the spinner paints, and lazy-load jsPDF off the main bundle.
            const [{ generateRouteReportPdf, getRouteReportFileName }, { sharePdfBlob }] = await Promise.all([
                import('../../services/RouteReportPdfService'),
                import('../../utils/sharePdf'),
            ]);
            const latest = exportState.current;
            if (
                !isAuthIdentityScopeCurrent(scope) ||
                (routeWeather && !isAuthIdentityScopeCurrent(routeWeather.ownerScope)) ||
                !latest.open ||
                latest.identity !== weatherIdentity ||
                latest.routeWeather !== routeWeather ||
                latest.releaseGate !== releaseGate
            )
                return;
            const blob = generateRouteReportPdf({
                routeName,
                pins,
                verdicts,
                tideLabels,
                departureLabel,
                vesselName,
                draftM,
                routeWeather,
                cruisingSpeedKts: routeWeather?.speedKts ?? cruisingSpeedKts,
                routeFuel,
                departureMs: routeWeather?.departureMs ?? departureMs,
                nowMs: Date.now(),
                verification: releaseGate.verification,
            });
            const outcome = await sharePdfBlob(
                blob,
                getRouteReportFileName(routeName),
                `Route report - ${routeName || 'route'}`,
            );
            if (outcome === 'downloaded') setExportMsg('PDF downloaded');
        } catch (err) {
            setExportMsg(`Couldn’t make the PDF (${err instanceof Error ? err.message.slice(0, 40) : 'error'})`);
        } finally {
            setExporting(false);
        }
    }, [
        pins,
        routeName,
        verdicts,
        tideLabels,
        departureLabel,
        vesselName,
        draftM,
        routeWeather,
        weatherIdentity,
        routeFuel,
        cruisingSpeedKts,
        departureMs,
        exporting,
        releaseGate,
    ]);

    // GPX export (Shane 2026-07-17: "export it in a gpx file for importing into
    // a chartplotter") — a plain <rte> of the pins, shared/downloaded like the
    // PDF. Route (not track): OpenCPN/Garmin/B&G import it as an activatable plan.
    const onExportGpx = React.useCallback(async () => {
        if (pins.length < 2 || exporting) return;
        if (!releaseGate.allowed || !releaseGate.verification) {
            setExportMsg(releaseGate.reason || 'Check the route again before exporting');
            return;
        }
        setExporting(true);
        const scope = getAuthIdentityScope();
        setExportMsg(null);
        triggerHaptic('medium');
        try {
            const { shareFileBlob } = await import('../../utils/sharePdf');
            const latest = exportState.current;
            if (
                !isAuthIdentityScopeCurrent(scope) ||
                !latest.open ||
                latest.identity !== weatherIdentity ||
                latest.releaseGate !== releaseGate
            )
                return;
            const blob = new Blob([traceToGpx(routeName, pins, new Date().toISOString(), releaseGate.verification)], {
                type: 'application/gpx+xml',
            });
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
    }, [pins, routeName, exporting, releaseGate, weatherIdentity]);

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
        <div className="fixed inset-0 z-10050 flex items-center justify-center bg-black/60 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
            {/* flex-col + a flexing body: header and footer keep their height and
                the leg list takes the rest. The old fixed max-h-[46vh] body could
                not compose with the 80vh cap once header, departure row and footer
                were stacked on it — the footer got pushed out of the card. */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="trace-report-title"
                tabIndex={-1}
                className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl"
            >
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                    <div className="min-w-0 grow basis-40">
                        <h2
                            id="trace-report-title"
                            className="text-sm font-black uppercase tracking-widest text-amber-300"
                        >
                            Route report
                        </h2>
                        {routeName.trim() !== '' && (
                            <div className="truncate text-[13px] font-bold text-gray-100">{routeName}</div>
                        )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <button
                            onClick={() => void onExportGpx()}
                            disabled={exporting || pins.length < 2 || !releaseGate.allowed}
                            title="Export as GPX for a chartplotter (OpenCPN, Garmin, B&G…)"
                            className="hit-target-44 rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-40"
                        >
                            ⬇ GPX
                        </button>
                        <button
                            onClick={() => void onExportPdf()}
                            disabled={exporting || pins.length < 2 || !releaseGate.allowed}
                            className="hit-target-44 rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wide text-sky-300 active:scale-95 disabled:opacity-40"
                        >
                            {exporting ? 'Making…' : '⬇ PDF'}
                        </button>
                        <button
                            ref={closeButtonRef}
                            onClick={onClose}
                            className="hit-target-44 text-sm font-bold text-gray-400"
                        >
                            Close
                        </button>
                    </div>
                </div>
                {exportMsg && (
                    <div className="shrink-0 border-b border-white/10 bg-sky-500/10 px-4 py-1.5 text-[11px] font-bold text-sky-300">
                        {exportMsg}
                    </div>
                )}
                {!releaseGate.allowed && pins.length >= 2 && (
                    <div
                        role="status"
                        className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-[11px] font-bold leading-snug text-amber-200"
                    >
                        Export locked: {releaseGate.reason}
                    </div>
                )}
                {releaseGate.verification && (
                    <div
                        className={`shrink-0 border-b px-4 py-2 text-[11px] font-black ${
                            releaseGate.verification.result === 'danger-acknowledged'
                                ? 'border-red-500/20 bg-red-500/10 text-red-200'
                                : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                        }`}
                    >
                        {traceVerificationSummary(releaseGate.verification)}
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
                    <RouteEstimateSummary fuel={routeFuel} />
                    {pins.length >= 2 &&
                        (showAlongRoute ? (
                            <React.Suspense
                                fallback={<p className="text-xs text-slate-400">Opening route references…</p>}
                            >
                                <AlongRouteReport
                                    pins={pins}
                                    identity={weatherIdentity}
                                    departureMs={etaDeparture}
                                    cruisingSpeedKts={cruisingSpeedKts}
                                />
                            </React.Suspense>
                        ) : (
                            <button
                                type="button"
                                className="min-h-11 w-full rounded-xl border border-sky-400/20 bg-sky-500/10 px-3 text-xs font-bold text-sky-200"
                                onClick={() => setShowAlongRoute(true)}
                            >
                                Along the route
                            </button>
                        ))}
                    {pins.length >= 2 &&
                        (showRouteWeather ? (
                            <React.Suspense fallback={<p className="text-xs text-slate-400">Opening route weather…</p>}>
                                <RouteMeteogram
                                    pins={pins}
                                    departureMs={departureMs}
                                    cruisingSpeedKts={cruisingSpeedKts}
                                    identity={weatherIdentity}
                                    onReport={setSampledWeather}
                                />
                            </React.Suspense>
                        ) : (
                            <button
                                type="button"
                                className="min-h-11 w-full rounded-xl border border-sky-400/20 bg-sky-500/10 px-3 text-xs font-bold text-sky-200"
                                onClick={() => setShowRouteWeather(true)}
                            >
                                Route meteogram
                            </button>
                        ))}
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
                            <div className="mb-1.5">
                                <span className="text-[11px] font-black uppercase tracking-widest text-gray-400">
                                    📍 Waypoints ({pins.length})
                                </span>
                            </div>
                            <div className="space-y-0.5 font-mono text-[11px] text-gray-200">
                                {pins.map((p, i) => (
                                    <button
                                        key={i}
                                        onClick={() => onFlyTo?.(p)}
                                        className="flex min-h-[44px] w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-sm px-1 py-0.5 text-left active:bg-white/10"
                                    >
                                        <span className="w-6 shrink-0 text-right text-amber-300/80">{i + 1}</span>
                                        <span className="min-w-0 break-words tabular-nums">{fmtFix(p)}</span>
                                        {waypointEtas && (
                                            <span className="ml-auto shrink-0 text-[10px] text-slate-400">
                                                {waypointEtas[i]}
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                {onFixAll && fixable.length > 0 && (
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
