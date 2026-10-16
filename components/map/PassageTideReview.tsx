import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { loadPassageTideReview, type PassageTideReviewSession } from '../../services/routing/passageTideReview';
import type { PassageTideSourceMode } from '../../services/tides/passageTideSources';
import type { TideWaitAssessment } from '../../services/routing/tideWaitReview';
import type { PointOnlyWaitIntent } from '../../services/routing/passageTideWaitAcceptance';
import type { TraceRoutePoint } from '../../services/routing/traceRoutePoint';
const utc = (ms: number | null) =>
    ms === null || !Number.isFinite(ms)
        ? 'unknown'
        : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const metres = (m: number | null) => (m === null ? 'unknown' : `${m.toFixed(2)} m`);
export default function PassageTideReview({
    pins,
    identity,
    departureMs,
    cruisingSpeedKts,
    editEpoch,
    onCommitWait,
}: {
    pins: TraceRoutePoint[];
    identity: string;
    departureMs: number;
    cruisingSpeedKts?: number;
    editEpoch?: number;
    onCommitWait?: (intent: PointOnlyWaitIntent) => boolean;
}) {
    const vessel = useSettingsStore((s) => s.settings.vessel),
        satellite = useSettingsStore((s) => s.settings.satelliteMode);
    const [pointIndex, setPointIndex] = React.useState(Math.min(1, pins.length - 1));
    const [speed, setSpeed] = React.useState(cruisingSpeedKts && cruisingSpeedKts > 0 ? String(cruisingSpeedKts) : '');
    const [departureAt, setDepartureAt] = React.useState(departureMs);
    const [departure, setDeparture] = React.useState(
        Number.isFinite(departureMs) ? new Date(departureMs).toISOString().slice(0, 16) : '',
    );
    const [holdingIndex, setHoldingIndex] = React.useState(0),
        [minutes, setMinutes] = React.useState('60'),
        [radius, setRadius] = React.useState('100');
    const [ukc, setUkc] = React.useState('0.5'),
        [wind, setWind] = React.useState('15'),
        [gust, setGust] = React.useState('20'),
        [wave, setWave] = React.useState('1'),
        [currentLimit, setCurrentLimit] = React.useState('1');
    const [session, setSession] = React.useState<PassageTideReviewSession | null>(null),
        [busy, setBusy] = React.useState(false),
        [message, setMessage] = React.useState('');
    const [wait, setWait] = React.useState<TideWaitAssessment | null>(null);
    const live = React.useRef<PassageTideReviewSession | null>(null),
        request = React.useRef<AbortController | null>(null),
        turn = React.useRef(0);
    const key = JSON.stringify([identity, pins, pointIndex, speed, departureAt, editEpoch]);
    const waitKey = JSON.stringify([key, holdingIndex, minutes, radius, ukc, wind, gust, wave, currentLimit]);
    const waitKeyRef = React.useRef(waitKey);
    waitKeyRef.current = waitKey;
    const keyRef = React.useRef(key);
    keyRef.current = key;
    const cancel = React.useCallback(() => {
        turn.current++;
        request.current?.abort();
        live.current?.dispose();
        live.current = null;
    }, []);
    React.useEffect(() => {
        cancel();
        setSession(null);
        setWait(null);
        setBusy(false);
        setMessage('');
        return cancel;
    }, [key, cancel]);
    React.useEffect(() => {
        setWait(null);
    }, [waitKey]);
    const load = async (mode: PassageTideSourceMode) => {
        cancel();
        setSession(null);
        setWait(null);
        setMessage('');
        setBusy(true);
        const mine = turn.current,
            mineKey = key,
            controller = new AbortController();
        request.current = controller;
        const current = () => turn.current === mine && keyRef.current === mineKey && !controller.signal.aborted;
        try {
            const result = await loadPassageTideReview(
                {
                    points: pins,
                    pointIndex,
                    identity: mineKey,
                    departureMs: departureAt,
                    speedKts: Number(speed),
                    mode,
                },
                {
                    signal: controller.signal,
                    isCurrent: current,
                    onRetire: () => {
                        if (current()) {
                            setSession(null);
                            setWait(null);
                            setMessage('Review changed or expired. Read it again for this route and boat.');
                        }
                    },
                },
            );
            if (!current()) {
                result.dispose();
                return;
            }
            live.current = result;
            setSession(result);
        } catch (error) {
            if (current()) setMessage(error instanceof Error ? error.message : 'Tide review unavailable.');
        } finally {
            if (turn.current === mine) setBusy(false);
        }
    };
    const reviewWait = async () => {
        if (!session?.isCurrent()) return;
        const mineWait = waitKey;
        setBusy(true);
        setWait(null);
        setMessage('');
        try {
            const result = await session.reviewWait(holdingIndex, Number(minutes), Number(radius), {
                draftM: typeof vessel?.draft === 'number' ? vessel.draft : NaN,
                ukcM: Number(ukc),
                maxWindKts: Number(wind),
                maxGustKts: Number(gust),
                maxWaveM: Number(wave),
                maxCurrentKts: Number(currentLimit),
            });
            if (session.isCurrent() && waitKeyRef.current === mineWait) setWait(result);
        } catch (error) {
            if (session.isCurrent()) setMessage(error instanceof Error ? error.message : 'Wait review unavailable.');
        } finally {
            setBusy(false);
        }
    };
    const accept = async () => {
        if (!session?.isCurrent() || wait?.kind !== 'proposed-wait' || !onCommitWait || editEpoch === undefined) return;
        setBusy(true);
        try {
            const intent = await session.acceptWait(wait, {
                points: pins,
                editEpoch,
                beforeIndex: pointIndex,
                holdingIndex,
                isCurrent: () => session.isCurrent() && keyRef.current === key && waitKeyRef.current === waitKey,
            });
            if (!intent || !onCommitWait(intent)) setMessage('The route or evidence changed. Review the wait again.');
            else setMessage('Review the updated route checks before saving or sailing.');
        } catch (error) {
            if (session.isCurrent())
                setMessage(error instanceof Error ? error.message : 'Wait acceptance unavailable.');
        } finally {
            setBusy(false);
        }
    };
    const report = session?.isCurrent() ? session.report : null;
    const indices = Array.from({ length: Math.min(pins.length, 128) }, (_, i) =>
        i === 127 && pins.length > 128 ? pins.length - 1 : i,
    );
    const field =
        'min-h-11 min-w-0 w-full max-w-full rounded-lg border border-white/15 bg-slate-950 px-2 text-xs text-slate-100';
    return (
        <section
            aria-label="Tides, bridges and waiting"
            className="min-w-0 space-y-3 rounded-xl border border-sky-400/20 p-2.5 text-xs leading-5 text-slate-300"
        >
            <h3 className="font-bold text-sky-100">Tides, bridges and waiting</h3>
            <p>
                Station predictions and installed-chart references at a planned constant-speed ETA. Navigation tide
                credit and a checked holding area need separate evidence.
            </p>
            <div className="grid min-w-0 grid-cols-2 gap-2">
                <label className="min-w-0">
                    Route point
                    <select
                        aria-label="Tide review route point"
                        className={field}
                        value={pointIndex}
                        onChange={(e) => setPointIndex(Number(e.target.value))}
                    >
                        {indices.map((i) => (
                            <option key={i} value={i}>
                                Point {i + 1}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="min-w-0">
                    Planned speed (kt)
                    <input
                        aria-label="Tide review speed"
                        className={field}
                        type="number"
                        min="0.1"
                        max="100"
                        step="0.1"
                        value={speed}
                        onChange={(e) => setSpeed(e.target.value)}
                    />
                </label>
                <label className="col-span-2 min-w-0">
                    Departure (UTC)
                    <input
                        aria-label="Tide review departure UTC"
                        className={field}
                        type="datetime-local"
                        value={departure}
                        onChange={(e) => {
                            setDeparture(e.target.value);
                            setDepartureAt(Date.parse(`${e.target.value}Z`));
                        }}
                    />
                </label>
            </div>
            {pins.length > 128 && (
                <p>
                    Point picker shows the first 127 points and the destination. Review an individual leg for other
                    points.
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={busy}
                    className={field + ' basis-36 flex-1'}
                    onClick={() => void load('aboard')}
                >
                    {busy ? 'Reading…' : 'Read aboard'}
                </button>
                <button
                    type="button"
                    disabled={busy || satellite}
                    className={field + ' basis-36 flex-1 disabled:opacity-40'}
                    onClick={() => void load('official')}
                >
                    Load official table
                </button>
                <button
                    type="button"
                    disabled={busy || satellite}
                    className={field + ' basis-36 flex-1 disabled:opacity-40'}
                    onClick={() => void load('nearby')}
                >
                    Load up to 3 nearby stations
                </button>
            </div>
            <p className="text-[11px] text-slate-400">
                Read aboard makes no network request. Other buttons request tide data through existing services; nearby
                predictions use WorldTides. Satellite Mode permits aboard references only.
            </p>
            {message && (
                <p role="status" className="break-words text-amber-200">
                    {message}
                </p>
            )}
            {report && (
                <div className="min-w-0 space-y-3" data-testid="passage-tide-review-results">
                    <p className="font-semibold text-sky-100">
                        Point {report.pointIndex + 1} · {utc(report.atMs)}
                    </p>
                    <p>
                        Tide-adjusted depth / bridge clearance: unknown. Station-to-current-chart datum and epoch
                        transfer is unverified.
                    </p>
                    {report.stations.map((s) => (
                        <article
                            key={`${s.kind}:${s.id}`}
                            className="min-w-0 break-words rounded-lg border border-white/10 p-2"
                        >
                            <p className="font-semibold text-slate-100">
                                {s.name} · {s.provider}
                            </p>
                            <p>
                                {s.distanceKm.toFixed(1)} km from the selected point · {s.kind.replaceAll('-', ' ')}.
                            </p>
                            <p>
                                Height at this station/model at ETA: {metres(s.heightAtEtaM)} · datum{' '}
                                {s.datum ?? 'unknown'} · epoch {s.datumEpoch ?? 'unknown'}.
                            </p>
                            <p>{s.note}</p>
                            {s.events.length > 0 && (
                                <details>
                                    <summary className="min-h-11 cursor-pointer py-2 text-sky-200">
                                        High / low events near ETA
                                    </summary>
                                    <ul>
                                        {s.events.map((e) => (
                                            <li key={`${e.timeMs}:${e.type}`}>
                                                {e.type} {utc(e.timeMs)} · {metres(e.heightM)}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                            <details>
                                <summary className="min-h-11 cursor-pointer py-2 text-sky-200">
                                    Source, clock and rights
                                </summary>
                                <p>
                                    Original prediction issue: {utc(s.originalIssueMs)}. Retrieved:{' '}
                                    {utc(s.receivedAtMs)}. Publication: {utc(s.publicationAtMs)}.
                                </p>
                                <p>{s.credit}</p>
                            </details>
                        </article>
                    ))}
                    {report.notes.map((note) => (
                        <p key={note}>{note}</p>
                    ))}
                    <details>
                        <summary className="min-h-11 cursor-pointer py-2 font-semibold text-sky-100">
                            Installed chart and holding references
                        </summary>
                        <p>
                            {report.chart.completeInventory
                                ? 'Complete readable installed cohort'
                                : 'Partial / unavailable installed cohort'}{' '}
                            · {report.chart.aboardOnly ? 'aboard RAM only' : 'public chart references'}.
                        </p>
                        <p>
                            Sounding datum {report.chart.soundingDatum ?? 'unknown'}; epoch{' '}
                            {report.chart.soundingDatumEpoch ?? 'unknown'}. Point depth{' '}
                            {metres(report.chart.pointDepthM)}.
                        </p>
                        <p>{report.chart.holdingText}</p>
                        {report.chart.notes.map((n) => (
                            <p key={n}>{n}</p>
                        ))}
                        {report.chart.bridges.map((b) => (
                            <article key={b.featureKey} className="my-2 rounded-lg border border-white/10 p-2">
                                <p>
                                    {b.name}: charted closed/fixed clearance {metres(b.closedClearanceM)}; open{' '}
                                    {metres(b.openClearanceM)}.
                                </p>
                                <p>
                                    Height plane {b.heightDatum ?? 'unknown'}, epoch unknown
                                    {b.estimated ? '; estimated reference' : ''}. No tide adjustment applied.
                                </p>
                                <p>
                                    {b.opening
                                        ? 'Opening required if closed clearance is insufficient; verified UTC operating slots, closure/deviation status and operator notice are unavailable.'
                                        : 'Operating permission and full crossing clearance remain unverified.'}
                                </p>
                            </article>
                        ))}
                        {!report.chart.bridges.length && (
                            <p>
                                No local bridge reference found in this readable window. This does not prove the route
                                has no bridges.
                            </p>
                        )}
                    </details>
                    <details>
                        <summary className="min-h-11 cursor-pointer py-2 font-semibold text-sky-100">
                            Review a holding wait before this point
                        </summary>
                        <p>
                            A proposal needs the complete circle and approach, anchoring permission, full tide interval
                            and interval exposure/weather. A charted anchorage or bottom point alone cannot qualify.
                        </p>
                        <div className="grid min-w-0 grid-cols-2 gap-2">
                            <label className="min-w-0">
                                Earlier point
                                <select
                                    aria-label="Wait holding point"
                                    className={field}
                                    value={holdingIndex}
                                    onChange={(e) => setHoldingIndex(Number(e.target.value))}
                                >
                                    {indices
                                        .filter((i) => i < pointIndex)
                                        .map((i) => (
                                            <option key={i} value={i}>
                                                Point {i + 1}
                                            </option>
                                        ))}
                                </select>
                            </label>
                            {[
                                ['Wait (min)', minutes, setMinutes],
                                ['Radius (m)', radius, setRadius],
                                ['UKC (m)', ukc, setUkc],
                                ['Wind limit (kt)', wind, setWind],
                                ['Gust limit (kt)', gust, setGust],
                                ['Wave limit (m)', wave, setWave],
                                ['Current limit (kt)', currentLimit, setCurrentLimit],
                            ].map(([label, value, setter]) => (
                                <label key={String(label)} className="min-w-0">
                                    {String(label)}
                                    <input
                                        aria-label={String(label)}
                                        className={field}
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={String(value)}
                                        onChange={(e) =>
                                            (setter as React.Dispatch<React.SetStateAction<string>>)(e.target.value)
                                        }
                                    />
                                </label>
                            ))}
                        </div>
                        <p>
                            Vessel draft:{' '}
                            {typeof vessel?.draft === 'number'
                                ? metres(vessel.draft)
                                : 'unknown; set it in Vessel before a checked wait can qualify'}
                            .
                        </p>
                        <button
                            type="button"
                            disabled={busy || pointIndex < 1}
                            className={field + ' mt-2 disabled:opacity-40'}
                            onClick={() => void reviewWait()}
                        >
                            Review wait evidence
                        </button>
                        {wait?.kind === 'unavailable' && (
                            <p role="status" className="break-words text-amber-200">
                                {wait.reason}
                            </p>
                        )}
                        {wait?.kind === 'unavailable' && wait.evidence && (
                            <details data-testid="holding-evidence" className="min-w-0 break-words">
                                <summary className="min-h-11 cursor-pointer py-2 text-sky-200">
                                    Aboard holding evidence and missing coverage
                                </summary>
                                <p>
                                    Whole circle / incoming approach:{' '}
                                    {wait.evidence.chart.completeCircleAndApproach
                                        ? 'charted coverage read'
                                        : 'incomplete'}
                                    . Minimum charted depth {metres(wait.evidence.chart.minimumChartedDepthM)}. Bottom{' '}
                                    {wait.evidence.chart.bottom}; hazards {wait.evidence.chart.hazards}; current
                                    anchoring permission {wait.evidence.chart.permission}. Sounding datum{' '}
                                    {wait.evidence.chart.datumId || 'unknown'}; epoch{' '}
                                    {wait.evidence.chart.datumEpoch || 'unknown'}.
                                </p>
                                {wait.evidence.chart.notes.map((n) => (
                                    <p key={n}>{n}</p>
                                ))}
                                {(['wind', 'gust', 'waves', 'currents'] as const).map((label) => {
                                    const f = wait.evidence!.environment[label];
                                    return (
                                        <div key={label} className="my-2 rounded-lg border border-white/10 p-2">
                                            <p>
                                                {label}:{' '}
                                                {f.maximum === null ? 'unknown' : `${f.maximum.toFixed(2)} ${f.unit}`}.
                                                Whole area / interval{' '}
                                                {f.completeAreaAndInterval ? 'bounded in this grid' : 'unproved'}.
                                            </p>
                                            <p>
                                                {f.source}. Original issue {utc(f.originalIssueMs)}; verified{' '}
                                                {utc(f.verifiedAtMs)}. Valid {utc(f.validFromMs)} to{' '}
                                                {utc(f.validUntilMs)}.
                                            </p>
                                        </div>
                                    );
                                })}
                                {wait.evidence.environment.notes.map((n) => (
                                    <p key={n}>{n}</p>
                                ))}
                            </details>
                        )}
                        {wait?.kind === 'proposed-wait' && (
                            <>
                                <p>
                                    Proposed wait only. Actual holding remains for the skipper to verify. Acceptance
                                    rereads the complete evidence and labels the selected route point Wait; it does not
                                    set a departure time or change the watch.
                                </p>
                                {onCommitWait && editEpoch !== undefined ? (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        className={field}
                                        onClick={() => void accept()}
                                    >
                                        Accept Wait point and recheck route
                                    </button>
                                ) : (
                                    <p>Open the route editor to accept a Wait point.</p>
                                )}
                            </>
                        )}
                    </details>
                    <p className="text-[11px] text-slate-400">
                        Loaded {utc(report.loadedAtMs)}. This review expires within five minutes and stays in memory; it
                        is excluded from PDF, GPX and saved route facts.
                    </p>
                </div>
            )}
        </section>
    );
}
