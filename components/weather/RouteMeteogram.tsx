import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWindStore } from '../../stores/WindStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { resolveRoutingPolar } from '../../services/routingPolar';
import { selectableForecastModels, isConcreteModel } from '../../services/weather/forecastModels';
import { buildRouteClock, type RouteWeatherReport, type RouteWeatherRow } from '../../services/routeMeteogram';
import { loadRouteMeteogram } from '../../services/routeMeteogramWeather';
import { windCompass } from '../../services/routeReportWeather';
import type { WeatherModel } from '../../types';
import { withDeadline } from '../../utils/deadline';

export const routeWeatherUTC = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
const number = (v: number | null, unit = '') => (v === null ? 'Unknown' : `${v.toFixed(1)}${unit}`);
const wind = (row: RouteWeatherRow) =>
    row.windKts === 0
        ? 'Calm'
        : row.windKts === null
          ? 'Unknown'
          : `${number(row.windKts, ' kt')} ${row.windDeg === null ? '(direction unknown)' : windCompass(row.windDeg)}`;

/** Shared view: no requests, and every blank line in the plot is a real coverage gap. */
export function RouteWeatherView({ report }: { report: RouteWeatherReport }) {
    const [index, setIndex] = React.useState(0);
    const row = report.rows[Math.min(index, report.rows.length - 1)];
    if (!row) return null;
    const maximum = Math.max(10, ...report.rows.map((r) => r.windKts ?? 0));
    const x = (r: RouteWeatherRow) =>
        8 + (284 * (r.atMs - report.departureMs)) / Math.max(1, report.arrivalMs - report.departureMs);
    const y = (r: RouteWeatherRow) => 75 - ((r.windKts ?? 0) * 65) / maximum;
    const paths: string[] = [];
    let drawing = false;
    for (const r of report.rows) {
        if (r.windKts === null) {
            drawing = false;
            continue;
        }
        if (!drawing || r.gapBeforeHours > 0) paths.push(`M${x(r)},${y(r)}`);
        else paths[paths.length - 1] += `L${x(r)},${y(r)}`;
        drawing = true;
    }
    return (
        <div className="min-w-0 space-y-2 text-xs leading-4 text-slate-300" data-testid="route-meteogram">
            <p className="break-words font-bold text-sky-200">{report.source}</p>
            <p>
                {routeWeatherUTC(report.departureMs)} → {routeWeatherUTC(report.arrivalMs)}. Planned constant{' '}
                {report.speedKts.toFixed(1)} kt over {report.totalDistanceNM.toFixed(1)} NM.
            </p>
            <p>Polar speed is a sailing model figure; it does not set these arrival times or imply motoring.</p>
            <p>Wind angle uses the route course, without a current or leeway correction.</p>
            {report.polarLabel && <p className="break-words">Polar: {report.polarLabel}</p>}
            <p>
                {report.sourceRun
                    ? `Source run ${routeWeatherUTC(Date.parse(report.sourceRun))}`
                    : 'Source run unknown'}{' '}
                · received {routeWeatherUTC(report.loadedAtMs)}
            </p>
            {report.note && <p>{report.note}</p>}
            {report.limited && (
                <p className="text-amber-200">
                    Hourly preview is limited to 16 days. The actual arrival is retained; the skipped middle is not
                    sampled.
                </p>
            )}
            <svg
                viewBox="0 0 300 88"
                className="block w-full"
                role="img"
                aria-label="Sustained wind along the planned route; gaps mean unknown"
            >
                <path d="M8 10V75H292" stroke="#64748b" fill="none" />
                {paths.map((d, i) => (
                    <path key={i} d={d} stroke="#38bdf8" strokeWidth="2" fill="none" />
                ))}
                <line x1={x(row)} x2={x(row)} y1="10" y2="75" stroke="#e2e8f0" strokeDasharray="3 3" />
            </svg>
            <p className="flex flex-wrap justify-between gap-x-2">
                <span>Wind 0–{Math.ceil(maximum)} kt</span>
                <span>Departure → arrival</span>
            </p>
            <label className="block">
                Route weather hour
                <input
                    aria-label="Route weather hour"
                    className="block min-h-11 w-full"
                    type="range"
                    min={0}
                    max={report.rows.length - 1}
                    value={Math.min(index, report.rows.length - 1)}
                    onChange={(event) => setIndex(Number(event.target.value))}
                />
            </label>
            <div aria-live="polite" className="space-y-1 rounded-lg border border-white/10 p-2">
                <p className="font-bold text-white">{routeWeatherUTC(row.atMs)}</p>
                <p className="break-words">
                    {row.lat.toFixed(4)}°, {row.lon.toFixed(4)}° · {row.distanceNM.toFixed(1)} NM
                </p>
                {row.gapBeforeHours > 0 && (
                    <p className="text-amber-200">
                        {row.gapBeforeHours.toFixed(1)} hours before this arrival were skipped.
                    </p>
                )}
                <p>
                    Wind: {wind(row)} · Gust: {number(row.gustKts, ' kt')}
                </p>
                <p>
                    TWA: {row.twaDeg === null ? 'Unknown' : `${Math.round(row.twaDeg)}°`} ·{' '}
                    {row.pointOfSail ?? 'Point of sail unknown'}
                </p>
                <p>
                    Polar: {number(row.polarSpeedKts, ' kt')} · Pressure: {number(row.pressureHpa, ' hPa')}
                </p>
            </div>
            <details>
                <summary className="flex min-h-11 cursor-pointer items-center font-bold text-sky-200">
                    Hourly weather table ({report.rows.length} positions)
                </summary>
                <table
                    className="w-full table-fixed border-collapse text-left text-xs leading-4"
                    aria-label="Route weather in UTC"
                >
                    <thead>
                        <tr>
                            {['UTC', 'Wind', 'TWA / sail', 'Polar kt'].map((title) => (
                                <th className="break-words border-b border-white/20 py-2 pr-1" key={title}>
                                    {title}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {report.rows.map((r) => (
                            <tr key={r.atMs}>
                                <td className="break-words border-b border-white/10 py-2 pr-1">
                                    {new Date(r.atMs).toISOString().slice(5, 10)}
                                    <br />
                                    {new Date(r.atMs).toISOString().slice(11, 19)}
                                    {r.gapBeforeHours > 0 && <span className="block text-amber-200">After gap</span>}
                                </td>
                                <td className="break-words border-b border-white/10 py-2 pr-1">
                                    {wind(r)}
                                    {r.gustKts !== null && <span className="block">G {number(r.gustKts)}</span>}
                                </td>
                                <td className="break-words border-b border-white/10 py-2 pr-1">
                                    {r.twaDeg === null ? 'Unknown' : `${Math.round(r.twaDeg)}°`}
                                    <br />
                                    {r.pointOfSail ?? 'Unknown'}
                                </td>
                                <td className="break-words border-b border-white/10 py-2">{number(r.polarSpeedKts)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>
            {report.credit && (
                <p className="break-words text-slate-400" data-testid="route-weather-credit">
                    {report.credit}
                </p>
            )}
        </div>
    );
}

/** Loaded only from the report's explicit Route meteogram action. */
export default function RouteMeteogram({
    pins,
    departureMs,
    cruisingSpeedKts,
    identity,
    onReport,
}: {
    pins: readonly { lat: number; lon: number }[];
    departureMs?: number | null;
    cruisingSpeedKts?: number;
    identity: string;
    onReport: (report: RouteWeatherReport | null) => void;
}) {
    const settings = useSettingsStore((state) => state.settings);
    const windState = useWindStore();
    const [speed, setSpeed] = React.useState(cruisingSpeedKts && cruisingSpeedKts > 0 ? String(cruisingSpeedKts) : '');
    const [model, setModel] = React.useState<WeatherModel>(
        isConcreteModel(settings.forecastModel) ? settings.forecastModel : 'dwd_icon',
    );
    const [report, setReport] = React.useState<RouteWeatherReport | null>(null);
    const [busy, setBusy] = React.useState(false),
        [message, setMessage] = React.useState('');
    const request = React.useRef<AbortController | null>(null),
        generation = React.useRef(0);
    const cancel = React.useCallback(() => {
        generation.current++;
        request.current?.abort();
    }, []);
    const reset = React.useCallback(() => {
        cancel();
        setReport(null);
        onReport(null);
        setBusy(false);
    }, [onReport, cancel]);
    React.useEffect(() => {
        reset();
        return cancel;
    }, [identity, reset, cancel]);
    React.useEffect(() => subscribeAuthIdentityScope(reset), [reset]);
    React.useEffect(() => {
        if (settings.satelliteMode) request.current?.abort();
    }, [settings.satelliteMode]);
    React.useEffect(() => {
        reset();
    }, [windState.grid, windState.field, windState.model, windState.localGribPath, windState.isGlobalMode, reset]);
    const sample = async (download: boolean) => {
        reset();
        setMessage('');
        const token = generation.current,
            scope = getAuthIdentityScope(),
            controller = new AbortController();
        request.current = controller;
        const live = () =>
            token === generation.current && !controller.signal.aborted && isAuthIdentityScopeCurrent(scope);
        setBusy(true);
        try {
            const clock = buildRouteClock(pins, departureMs ?? Date.now(), Number(speed));
            const polar =
                settings.vessel?.type === 'sail'
                    ? await withDeadline(
                          resolveRoutingPolar({ settings, vessel: settings.vessel }),
                          10_000,
                          'Polar data',
                      )
                    : null;
            if (!live()) return;
            const next = await loadRouteMeteogram(
                {
                    clock,
                    identity,
                    performance: polar && settings.vessel ? { vessel: settings.vessel, polar } : null,
                    ...(download ? { downloadModel: model } : {}),
                },
                { signal: controller.signal, isCurrent: live },
            );
            if (live() && next) {
                setReport(next);
                onReport(next);
            }
        } catch (error) {
            if (live()) setMessage(error instanceof Error ? error.message : 'Route weather unavailable.');
        } finally {
            if (token === generation.current) {
                setBusy(false);
                if (controller.signal.aborted) setMessage('Route weather stopped.');
            }
        }
    };
    return (
        <section
            aria-label="Route meteogram"
            className="min-w-0 space-y-2 rounded-xl border border-sky-400/20 p-2.5 text-xs text-slate-300"
        >
            <h3 className="font-black uppercase tracking-wide text-sky-200">Route meteogram</h3>
            <p>Each hour follows the whole route at your planned constant speed. Weather gaps stay unknown.</p>
            <label className="block">
                Planned route speed (kt)
                <input
                    aria-label="Planned route speed in knots"
                    type="number"
                    inputMode="decimal"
                    min="0.1"
                    max="100"
                    step="0.1"
                    value={speed}
                    onChange={(event) => {
                        reset();
                        setSpeed(event.target.value);
                    }}
                    className="mt-1 block min-h-11 w-full rounded-lg border border-white/20 bg-slate-950 px-2 text-base"
                />
            </label>
            <button
                type="button"
                disabled={busy}
                className="min-h-11 w-full rounded-lg border border-sky-400/25 bg-sky-500/10 px-2 font-bold disabled:opacity-50"
                onClick={() => void sample(false)}
            >
                Use weather aboard
            </button>
            <label className="block">
                Download source
                <select
                    aria-label="Route forecast model"
                    value={model}
                    onChange={(event) => {
                        reset();
                        setModel(event.target.value as WeatherModel);
                    }}
                    className="mt-1 block min-h-11 w-full rounded-lg border border-white/20 bg-slate-950 px-2 text-sm"
                >
                    {selectableForecastModels().map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.label} · {m.provider}
                        </option>
                    ))}
                </select>
            </label>
            <p>Download: at most 48 public 0.25° cells, up to 16 days. Precise route positions stay aboard.</p>
            <button
                type="button"
                disabled={busy || settings.satelliteMode}
                className="min-h-11 w-full rounded-lg border border-sky-400/25 bg-sky-500/10 px-2 font-bold disabled:opacity-50"
                onClick={() => void sample(true)}
            >
                Download selected forecast
            </button>
            {settings.satelliteMode && <p>Satellite Mode: use weather already aboard; route downloads are paused.</p>}
            {busy && (
                <button
                    type="button"
                    className="min-h-11 w-full rounded-lg border border-white/20 px-2 font-bold"
                    onClick={() => {
                        reset();
                        setMessage('Route weather stopped.');
                    }}
                >
                    Cancel route weather
                </button>
            )}
            {message && <p role="status">{message}</p>}
            {report?.identity === identity && isAuthIdentityScopeCurrent(report.ownerScope) && (
                <RouteWeatherView report={report} />
            )}
        </section>
    );
}
