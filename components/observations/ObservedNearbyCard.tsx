import React, { useEffect, useRef, useState } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    loadNearbyObservations,
    loadObservationHistory,
    type ObservationFeedResult,
} from '../../services/weather/observations/feed';
import {
    observationEmptyMessage,
    observationUiRows,
    selectNearbyObservations,
} from '../../services/weather/observations/nearby';
import { HOUR_MS, type Observation } from '../../services/weather/observations/model';

export const observationUtc = (time: number) => `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
export default function ObservedNearbyCard({
    point,
    briefing = false,
}: {
    point: { lat: number; lon: number };
    briefing?: boolean;
}) {
    const [scope, setScope] = useState(getAuthIdentityScope);
    const [feed, setFeed] = useState<ObservationFeedResult | null>(null);
    const [error, setError] = useState(false);
    const [now, setNow] = useState(Date.now);
    const [refresh, setRefresh] = useState(0);
    const [history, setHistory] = useState<{
        key: string;
        rows: Observation[];
        partial: boolean;
        cachedOnly: boolean;
    } | null>(null);
    const [historyStatus, setHistoryStatus] = useState('');
    const [hours, setHours] = useState<12 | 24 | 48 | 72>(24);
    const historyRequest = useRef<AbortController | null>(null);
    const lifecycle = useRef<{ active: boolean } | null>(null);
    const { lat, lon } = point;
    useEffect(
        () =>
            subscribeAuthIdentityScope((next) => {
                setFeed(null);
                setHistory(null);
                setScope(next);
            }),
        [],
    );
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60000);
        const resume = () => setNow(Date.now());
        document.addEventListener('visibilitychange', resume);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', resume);
        };
    }, []);
    useEffect(() => {
        let current = true;
        const controller = new AbortController();
        const token = { active: true };
        lifecycle.current = token;
        setFeed(null);
        setError(false);
        setHistory(null);
        setHistoryStatus('');
        void loadNearbyObservations({ lat, lon }, controller.signal)
            .then((result) => {
                if (
                    current &&
                    isAuthIdentityScopeCurrent(scope) &&
                    result.point.lat === lat &&
                    result.point.lon === lon
                ) {
                    setFeed(result);
                    setNow(Date.now());
                }
            })
            .catch(() => {
                if (current && isAuthIdentityScopeCurrent(scope)) setError(true);
            });
        return () => {
            current = false;
            controller.abort();
            historyRequest.current?.abort();
            token.active = false;
        };
    }, [lat, lon, scope, refresh]);
    const selected = selectNearbyObservations(feed?.rows ?? [], point, now);
    const rows = observationUiRows(selected);
    async function readHistory(station: Observation) {
        const requestedScope = getAuthIdentityScope();
        const requestedLifecycle = lifecycle.current;
        historyRequest.current?.abort();
        const controller = new AbortController();
        historyRequest.current = controller;
        const key = `${station.provider}:${station.id}`;
        setHistoryStatus('Loading station history…');
        setHistory(null);
        try {
            const answer = await loadObservationHistory(station, hours, controller.signal);
            if (!isAuthIdentityScopeCurrent(requestedScope) || !requestedLifecycle?.active || controller.signal.aborted)
                return;
            setHistory({ key, ...answer });
            setHistoryStatus('');
        } catch {
            if (isAuthIdentityScopeCurrent(requestedScope) && requestedLifecycle?.active && !controller.signal.aborted)
                setHistoryStatus('Station history could not be reached.');
        }
    }
    return (
        <section
            aria-label="Observed nearby"
            className="min-w-0 mt-3 rounded-xl border border-sky-300/15 bg-sky-300/3 p-3 text-xs leading-relaxed text-white/75 break-words"
        >
            <h3 className="font-bold text-white">Observed {briefing ? 'near departure — now' : 'nearby'}</h3>
            {briefing && (
                <p className="text-white/55">Current station readings; not a forecast for your departure time.</p>
            )}
            <p className="text-white/55">
                Within 50 NM · separate from the forecast and your boat’s ambient barometer.
            </p>
            {!feed && <p role="status">{error ? 'Observations could not be checked.' : 'Checking public stations…'}</p>}
            {feed?.cachedOnly && <p>Cached readings only — Satellite Mode or offline. Age is the observation’s age.</p>}
            {feed &&
                ['ndbc', 'awc-metar'].map((provider) => {
                    const kind = provider as 'ndbc' | 'awc-metar';
                    const found = kind === 'ndbc' ? selected.marine : selected.airport;
                    return !found ? (
                        <p key={kind} role="status" className="mt-2">
                            {observationEmptyMessage(kind, feed.availability[kind])}
                        </p>
                    ) : null;
                })}
            {rows.map((row) => {
                const item = row.key.startsWith('ndbc:') ? selected.marine : selected.airport;
                return (
                    <div key={row.key} className="mt-3 border-t border-white/10 pt-2 min-w-0">
                        <p className="font-semibold">
                            {row.heading} · {item?.observation.id}
                        </p>
                        <p>{row.measurements}</p>
                        <p>
                            {row.age} · {observationUtc(row.observedAtMs)}
                        </p>
                        <p className="text-white/55">{row.exposure}</p>
                        <a
                            className="underline text-sky-200"
                            href={row.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            {row.source}
                        </a>
                        <p className="text-white/45">Retrieved {observationUtc(row.retrievedAtMs)}</p>
                        <button
                            className="mt-1 min-h-11 underline text-sky-200"
                            onClick={() => item && void readHistory(item.observation)}
                        >
                            Read {item?.observation.id} history
                        </button>
                    </div>
                );
            })}
            {feed?.partial && (
                <p role="status">
                    Only a bounded subset of station reports was checked; nearby coverage may be incomplete.
                </p>
            )}
            {!!rows.length && (
                <label className="flex flex-wrap items-center gap-2">
                    History window{' '}
                    <select
                        aria-label="History window"
                        className="min-h-11 rounded-lg bg-slate-900 px-2"
                        value={hours}
                        onChange={(e) => {
                            historyRequest.current?.abort();
                            setHistory(null);
                            setHistoryStatus('');
                            setHours(Number(e.target.value) as 12 | 24 | 48 | 72);
                        }}
                    >
                        {[12, 24, 48, 72].map((h) => (
                            <option key={h} value={h}>
                                {h} hours
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {historyStatus && <p role="status">{historyStatus}</p>}
            {history && (
                <div className="mt-2">
                    <p>
                        {history.key} · {history.rows.length} retained samples
                        {history.cachedOnly ? ' · cached this session' : ''}
                    </p>
                    {!!history.rows.length && (
                        <p>
                            {observationUtc(history.rows[0].observedAtMs)} to{' '}
                            {observationUtc(history.rows.at(-1)!.observedAtMs)}
                        </p>
                    )}
                    <p>
                        Missing times and values stay missing; this is not a complete {hours}-hour record.
                        {history.partial ? ' Provider or cache coverage is partial.' : ''}
                    </p>
                    {history.rows.length > 1 && (
                        <p>
                            Longest interval between retained readings:{' '}
                            {Math.round(
                                Math.max(
                                    ...history.rows
                                        .slice(1)
                                        .map((row, i) => row.observedAtMs - history.rows[i].observedAtMs),
                                ) / 60000,
                            )}{' '}
                            min.
                        </p>
                    )}
                    <div className="max-h-64 overflow-auto" tabIndex={0} aria-label="Observation history samples">
                        <table className="w-full table-fixed text-left">
                            <thead>
                                <tr>
                                    <th>Observed UTC</th>
                                    <th>Wind / gust kt</th>
                                    <th>Pressure hPa / air</th>
                                </tr>
                            </thead>
                            <tbody>
                                {history.rows.map((r, i) => (
                                    <React.Fragment key={r.observedAtMs}>
                                        {i > 0 && r.observedAtMs - history.rows[i - 1].observedAtMs > 2 * HOUR_MS && (
                                            <tr>
                                                <td colSpan={3}>Gap over 2 hours</td>
                                            </tr>
                                        )}
                                        <tr>
                                            <td>{observationUtc(r.observedAtMs)}</td>
                                            <td>
                                                {r.windSpeedKts?.toFixed(1) ?? '—'} / {r.gustKts?.toFixed(1) ?? '—'}
                                                <br />
                                                {r.variableWind
                                                    ? 'Variable'
                                                    : r.fromDeg !== null
                                                      ? `${Math.round(r.fromDeg)}° true`
                                                      : 'Direction —'}
                                            </td>
                                            <td>
                                                {r.seaLevelPressureHpa !== null && (
                                                    <span>
                                                        SLP {r.seaLevelPressureHpa.toFixed(1)}
                                                        <br />
                                                    </span>
                                                )}
                                                {r.altimeterHpa !== null && (
                                                    <span>
                                                        QNH {r.altimeterHpa.toFixed(1)}
                                                        <br />
                                                    </span>
                                                )}
                                                {r.airTempC !== null ? `${r.airTempC.toFixed(1)} °C` : 'Air —'}
                                            </td>
                                        </tr>
                                    </React.Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
            <button className="mt-2 min-h-11 underline text-sky-200" onClick={() => setRefresh((value) => value + 1)}>
                Check observations
            </button>
            <p className="text-white/45">
                NOAA-distributed data; originating stations retain their identity. No NOAA endorsement. Availability
                varies worldwide.
            </p>
        </section>
    );
}
