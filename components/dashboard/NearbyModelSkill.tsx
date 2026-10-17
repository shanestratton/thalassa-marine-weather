import React, { useEffect, useMemo, useState } from 'react';
import { openWeatherEvidenceSession, type WeatherEvidenceSession } from '../../services/weather/evidenceSession';
import type { StationSkillDetail } from '../../services/weather/evidenceContract';
import { SKILL_LEADS, type SkillLead, type SkillMetric } from '../../services/weather/modelSkill';
import {
    evidencePositionValid,
    issuedModelLabel,
    nearestEvidenceStation,
    type EvidencePosition,
} from '../../services/weather/nearbyEvidence';

/** Explicitly opened advice. No polling, model writes, location upload or account data. */
export default function NearbyModelSkill({ coordinates }: { coordinates?: EvidencePosition }) {
    const [expanded, setExpanded] = useState(false);
    const [session, setSession] = useState<WeatherEvidenceSession | null>(null);
    const [detail, setDetail] = useState<StationSkillDetail | null>(null);
    const [message, setMessage] = useState('');
    const [metric, setMetric] = useState<SkillMetric>('wind_speed_mps');
    const [lead, setLead] = useState<SkillLead>('0-6h');
    const [now, setNow] = useState(() => Date.now());
    const valid = evidencePositionValid(coordinates);
    const lat = coordinates?.lat;
    const lon = coordinates?.lon;
    useEffect(() => {
        if (!expanded || !valid) return;
        const abort = new AbortController();
        const openedAt = Date.now();
        let acquired: WeatherEvidenceSession | null = null;
        let expiry: ReturnType<typeof setTimeout> | undefined;
        const retire = () => {
            acquired?.close();
            setSession(null);
            setDetail(null);
            setMessage('Station skill has expired. Reopen to check again.');
        };
        setMessage('Checking published station skill…');
        setDetail(null);
        void openWeatherEvidenceSession('skill', abort.signal, () => !abort.signal.aborted)
            .then((value) => {
                acquired = value;
                if (abort.signal.aborted || !value.isCurrent()) {
                    value.close();
                    return;
                }
                setSession(value);
                setMessage('');
                setNow(Date.now());
                expiry = setTimeout(
                    retire,
                    Math.max(0, Math.min(value.index.expiresAt * 1000, openedAt + 15 * 60_000) - Date.now()),
                );
            })
            .catch(() => {
                if (!abort.signal.aborted)
                    setMessage('Station skill is unavailable or expired. Reopen to check again.');
            });
        const tick = setInterval(() => {
            setNow(Date.now());
            if (acquired && !acquired.isCurrent()) {
                retire();
            }
        }, 10_000);
        return () => {
            abort.abort();
            acquired?.close();
            clearInterval(tick);
            clearTimeout(expiry);
            setSession(null);
            setDetail(null);
        };
    }, [expanded, valid]);
    const nearest = useMemo(() => {
        const position = lat === undefined || lon === undefined ? null : { lat, lon };
        if (!session?.isCurrent() || !evidencePositionValid(position)) return null;
        return nearestEvidenceStation(session.index.stations, position, now / 1000);
    }, [session, lat, lon, now]);
    const nearestKey = nearest?.station.key;
    useEffect(() => {
        setDetail(null);
        if (!session) return;
        if (!nearestKey) {
            setMessage('');
            return;
        }
        const abort = new AbortController();
        const key = nearestKey;
        setMessage('Checking this station…');
        void session
            .readStation(key, abort.signal)
            .then((value) => {
                if (
                    abort.signal.aborted ||
                    !session.isCurrent() ||
                    !('metrics' in value) ||
                    value.station.key !== key ||
                    Date.now() >= value.station.expiresAt * 1000
                )
                    return;
                setDetail(value);
                setMessage('');
            })
            .catch(() => {
                if (!abort.signal.aborted) setMessage('This station’s skill is unavailable or expired.');
            });
        return () => abort.abort();
    }, [session, nearestKey]);
    const currentDetail =
        detail &&
        session?.isCurrent() &&
        nearest?.station.key === detail.station.key &&
        now < detail.station.expiresAt * 1000
            ? detail
            : null;
    const score = currentDetail?.metrics[metric][lead];
    const ready = score?.status === 'ready';
    return (
        <details
            className="mt-3 min-w-0 rounded-xl border border-white/10 bg-slate-950/40 text-xs text-slate-300"
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
            data-testid="nearby-model-skill"
        >
            <summary className="min-h-11 cursor-pointer px-3 py-3 font-semibold text-sky-200">
                Forecast skill nearby
            </summary>
            {expanded && (
                <div className="min-w-0 space-y-3 px-3 pb-3 break-words" aria-live="polite">
                    <p>
                        Own-server forecasts captured before the weather happened, compared with station measurements
                        over the last two weeks. Advice only; your model choice stays yours.
                    </p>
                    {!valid ? (
                        <p>No forecast position is available.</p>
                    ) : message ? (
                        <p role="status">{message}</p>
                    ) : !nearest ? (
                        <p>No current scored station within 50 nm in this published catalogue. Coverage is partial.</p>
                    ) : (
                        <>
                            <p className="font-semibold text-slate-100">
                                {nearest.station.label} · {nearest.distanceNm.toFixed(0)} nm
                            </p>
                            <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
                                <label className="min-w-0">
                                    Measure
                                    <select
                                        style={{ colorScheme: 'dark', backgroundColor: '#0f172a', color: '#e2e8f0' }}
                                        aria-label="Skill measure"
                                        value={metric}
                                        onChange={(e) => setMetric(e.target.value as SkillMetric)}
                                        className="mt-1 min-h-11 w-full rounded-lg border border-white/15 bg-slate-900 px-2 text-white"
                                    >
                                        <option value="wind_speed_mps">Wind speed</option>
                                        <option value="wave_hs_m">Wave height</option>
                                    </select>
                                </label>
                                <label className="min-w-0">
                                    Forecast lead
                                    <select
                                        style={{ colorScheme: 'dark', backgroundColor: '#0f172a', color: '#e2e8f0' }}
                                        aria-label="Skill forecast lead"
                                        value={lead}
                                        onChange={(e) => setLead(e.target.value as SkillLead)}
                                        className="mt-1 min-h-11 w-full rounded-lg border border-white/15 bg-slate-900 px-2 text-white"
                                    >
                                        {SKILL_LEADS.map((value) => (
                                            <option key={value} value={value}>
                                                {value.replace('h', ' h')}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            {ready ? (
                                <>
                                    <p className="font-semibold text-emerald-200">
                                        {score.closest
                                            ? `Closest here lately: ${issuedModelLabel(score.closest)}`
                                            : `Closest here lately: tied (${score.tiedModels.map(issuedModelLabel).join(', ')})`}
                                    </p>
                                    <ul className="space-y-2">
                                        {Object.entries(score.models)
                                            .filter(([, value]) => value.status === 'ready')
                                            .map(([model, value]) => (
                                                <li key={model} className="space-y-0.5">
                                                    <p>
                                                        {issuedModelLabel(model)} · MAE {value.mae!.toFixed(2)}{' '}
                                                        {metric === 'wind_speed_mps' ? 'm/s' : 'm'}
                                                    </p>
                                                    <p className="text-slate-400">
                                                        {value.pairs} paired hours · effective N{' '}
                                                        {Math.floor(value.effectiveN)} · median lead{' '}
                                                        {value.medianLeadHours!.toFixed(1)} h
                                                    </p>
                                                </li>
                                            ))}
                                    </ul>
                                </>
                            ) : (
                                currentDetail && (
                                    <p>
                                        Warming at this station for this measure and lead. No score or closest model
                                        yet: at least 30 effective paired hours across ten days and two comparable
                                        models are required.
                                    </p>
                                )
                            )}
                            <p className="text-slate-400">
                                NOAA NDBC preliminary realtime screening. Station exposure differs from your boat. Exact
                                own-server model domains only; IFS 0.25° scores do not score IFS 9 km.
                            </p>
                        </>
                    )}
                </div>
            )}
        </details>
    );
}
