import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { clearAlongRouteReport, useAlongRouteReport } from '../../stores/alongRouteReportStore';
import { loadAlongRouteReport } from '../../services/routing/loadAlongRouteReport';
import type { AlongRouteReport as Report } from '../../services/routing/alongRouteReportTypes';

const utc = (ms: number | null) =>
    ms === null ? 'ETA unknown' : `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')} UTC`;
const number = (value: number | null, unit: string) => (value === null ? '—' : `${Math.round(value)} ${unit}`);
export function AlongRouteReportView({ report }: { report: Report }) {
    return (
        <div className="min-w-0 space-y-3 text-xs leading-5 text-slate-300" data-testid="along-route-results">
            <p>
                Within 5 NM of the line · {report.rows.length} references{report.limited ? ' · first 128 only' : ''}.
                Approaches, access, fuel stock and bridge permission are unverified.
            </p>
            {report.sources.map((source) => (
                <p key={source.name} className="break-words rounded-lg border border-white/10 p-2">
                    <strong>
                        {source.name}: {source.partial ? 'partial / unknown' : 'mapped source coverage only'}
                    </strong>
                    <br />
                    {source.coverage}
                    <br />
                    Source: {source.sourceAt ?? 'source time unknown; individual chart issue shown per bridge'}
                </p>
            ))}
            {!report.rows.length && (
                <p>No references found in the readable sources. This does not prove there are none along the route.</p>
            )}
            <ol className="space-y-2">
                {report.rows.map((row) => (
                    <li
                        key={row.id}
                        className="min-w-0 break-words rounded-lg border border-white/10 bg-slate-950/50 p-2"
                    >
                        <p className="font-bold text-sky-100">
                            {row.name} · {row.kind}
                        </p>
                        <p>
                            {row.alongNm.toFixed(1)} NM along · {row.offRouteNm.toFixed(1)} NM off line ·{' '}
                            {utc(row.etaMs)}
                        </p>
                        {row.ambiguousVisit && <p>Repeated route passes: visit and ETA are ambiguous.</p>}
                        <p>
                            At ETA: wind {number(row.weather.windKts, 'kt')}, gust {number(row.weather.gustKts, 'kt')},
                            pressure {number(row.weather.pressureHpa, 'hPa')}.
                        </p>
                        <p>{row.note}</p>
                        <p className="text-[11px] text-slate-400">
                            {row.aboardOnly ? 'Chart summary · aboard RAM only · ' : ''}
                            {row.source} · {row.sourceAt ?? 'issue time unknown'}
                            {row.sourceUrl && (
                                <>
                                    {' '}
                                    ·{' '}
                                    <a
                                        className="underline"
                                        href={row.sourceUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        Source
                                    </a>
                                </>
                            )}
                        </p>
                    </li>
                ))}
            </ol>
            <p>
                Weather: {report.weatherSource}.{' '}
                {report.weatherRun ? `Run ${report.weatherRun}.` : 'Model run time unknown.'} {report.weatherNote}
            </p>
            {report.weatherCredit && <p className="text-[11px] text-slate-400">{report.weatherCredit}</p>}
            <p className="text-[11px] text-slate-400">
                Loaded {utc(report.loadedAtMs)} ·{' '}
                {report.cachedOnly ? 'references aboard only' : 'public catalogue download requested'}. This report
                stays in memory and is excluded from exports.
            </p>
        </div>
    );
}

export default function AlongRouteReport({
    pins,
    identity,
    departureMs,
    cruisingSpeedKts,
}: {
    pins: readonly { lat: number; lon: number }[];
    identity: string;
    departureMs: number | null;
    cruisingSpeedKts?: number;
}) {
    const satellite = useSettingsStore((state) => state.settings.satelliteMode);
    const [speed, setSpeed] = React.useState(cruisingSpeedKts && cruisingSpeedKts > 0 ? String(cruisingSpeedKts) : '');
    const [busy, setBusy] = React.useState(false),
        [message, setMessage] = React.useState('');
    const report = useAlongRouteReport();
    const key = JSON.stringify([identity, departureMs, speed]);
    const currentKey = React.useRef(key);
    currentKey.current = key;
    const turn = React.useRef(0),
        request = React.useRef<AbortController | null>(null);
    const cancel = React.useCallback(() => {
        turn.current++;
        request.current?.abort();
    }, []);
    React.useEffect(() => {
        cancel();
        setBusy(false);
        setMessage('');
        return cancel;
    }, [key, cancel]);
    const load = async (downloadPublic: boolean) => {
        cancel();
        clearAlongRouteReport();
        setMessage('');
        const generation = turn.current,
            mine = key,
            controller = new AbortController();
        request.current = controller;
        const current = () => turn.current === generation && currentKey.current === mine && !controller.signal.aborted;
        setBusy(true);
        try {
            await loadAlongRouteReport(
                {
                    points: pins,
                    identity: mine,
                    departureMs,
                    speedKts: speed.trim() ? Number(speed) : null,
                    downloadPublic,
                },
                { signal: controller.signal, isCurrent: current },
            );
        } catch (error) {
            if (current()) setMessage(error instanceof Error ? error.message : 'References unavailable.');
        } finally {
            if (turn.current === generation) setBusy(false);
        }
    };
    return (
        <section
            aria-label="Along the route"
            className="min-w-0 space-y-2 rounded-xl border border-sky-400/20 p-2.5 text-xs text-slate-300"
        >
            <h3 className="font-black uppercase tracking-wide text-sky-200">Along the route</h3>
            <p>
                Anchorages, marinas, marine fuel and installed-chart bridges. Planned constant-speed ETAs; weather uses
                only data already aboard.
            </p>
            <label className="block">
                Planned reference speed (kt)
                <input
                    aria-label="Planned reference speed in knots"
                    type="number"
                    inputMode="decimal"
                    min="0.1"
                    max="100"
                    step="0.1"
                    value={speed}
                    onChange={(event) => setSpeed(event.target.value)}
                    className="mt-1 block min-h-11 w-full rounded-lg border border-white/20 bg-slate-950 px-2 text-base"
                />
            </label>
            <button
                type="button"
                disabled={busy}
                onClick={() => void load(false)}
                className="min-h-11 w-full rounded-lg border border-sky-400/25 px-2 font-bold disabled:opacity-50"
            >
                Use references aboard
            </button>
            <p>
                Optional download: public catalogue cells only, up to 16 per source. Charts and weather are never
                downloaded by this action.
            </p>
            <button
                type="button"
                disabled={busy || satellite}
                onClick={() => void load(true)}
                className="min-h-11 w-full rounded-lg border border-sky-400/25 px-2 font-bold disabled:opacity-50"
            >
                Download public references
            </button>
            {satellite && <p>Satellite Mode: public downloads paused. Use references already aboard.</p>}
            {busy && (
                <button
                    type="button"
                    className="min-h-11 w-full rounded-lg border border-white/20 px-2"
                    onClick={() => {
                        cancel();
                        setBusy(false);
                        setMessage('Reference loading stopped.');
                    }}
                >
                    Cancel references
                </button>
            )}
            {message && <p role="status">{message}</p>}
            {report?.identity === key && <AlongRouteReportView report={report} />}
        </section>
    );
}
