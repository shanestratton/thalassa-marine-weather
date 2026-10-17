import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { cachedBriefing } from '../../services/briefing/cachedBriefing';
import { getWeatherBriefingPin, subscribeWeatherBriefingPin } from '../../services/briefing/briefingPin';
import { fetchWeatherWatchStatus } from '../../services/weatherWatchClient';
import type { Briefing } from '../../services/briefing/composeBriefing';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { resolveTimeZone } from '../../utils/timezone';
import { WEATHER_POSITION_HOLD_MS } from '../../utils/weatherPosition';
const subscribe = (notify: () => void) => subscribeAuthIdentityScope(() => notify());
export default function BriefingCard({
    point,
    place,
    acceptPush = false,
}: {
    point?: { lat: number; lon: number };
    place?: string;
    acceptPush?: boolean;
}) {
    const scope = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope);
    const lat = point?.lat,
        lon = point?.lon;
    const [answer, setAnswer] = useState<{ key: string; briefing: Briefing | null; positionAt?: number } | null>(null);
    const [message, setMessage] = useState('');
    const pin = useSyncExternalStore(subscribeWeatherBriefingPin, getWeatherBriefingPin, () => null);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);
    const key = `${scope.key}:${scope.generation}:${point?.lat}:${point?.lon}:${acceptPush ? `${pin?.boatId}:${pin?.revision}:${pin?.positionRevision}` : ''}`;
    useEffect(() => {
        let active = true;
        setAnswer(null);
        setMessage('');
        void (async () => {
            let at = lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
                label = place ?? 'This place',
                zone = at ? resolveTimeZone(at.lat, at.lon) : 'UTC',
                positionAt: number | undefined;
            if (acceptPush && pin) {
                const status = await fetchWeatherWatchStatus(pin.boatId, pin.scope);
                // A new profile must not be presented as the old push's decision.
                if (!status?.profile || status.profile.revision !== pin.revision) {
                    if (active && isAuthIdentityScopeCurrent(scope))
                        setMessage('This briefing registration changed. Open the current vessel’s forecast watch.');
                    return;
                }
                const boat = status.position?.position;
                if (!boat || boat.revision !== pin.positionRevision) {
                    if (active && isAuthIdentityScopeCurrent(scope))
                        setMessage('The registered boat position is unavailable.');
                    return;
                }
                at = { lat: boat.lat, lon: boat.lon };
                label = 'Your registered vessel';
                zone = boat.zone;
                positionAt = boat.at;
            }
            if (!at || !scope.userId) {
                if (active) setAnswer({ key, briefing: null });
                return;
            }
            const briefing = await cachedBriefing(at, label, zone, Date.now());
            if (active && isAuthIdentityScopeCurrent(scope)) setAnswer({ key, briefing, positionAt });
        })().catch(() => {
            if (active && isAuthIdentityScopeCurrent(scope)) setAnswer({ key, briefing: null });
        });
        return () => {
            active = false;
        };
    }, [key, scope, lat, lon, place, acceptPush, pin]);
    const briefing = answer?.key === key ? answer.briefing : null;
    const positionExpired =
        answer?.key === key && answer.positionAt !== undefined && now - answer.positionAt > WEATHER_POSITION_HOLD_MS;
    if (!scope.userId) return null;
    return (
        <section
            aria-label="Weather briefing"
            className="space-y-2 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm"
        >
            <h2 className="font-bold">Weather briefing{briefing ? ` · ${briefing.place}` : ''}</h2>
            {message ? (
                <p role="status">{message}</p>
            ) : positionExpired ? (
                <p role="status">
                    The registered boat position expired. Refresh the vessel’s forecast watch; no phone position is
                    substituted.
                </p>
            ) : briefing ? (
                <>
                    <p>{briefing.lines[0]}</p>
                    <p>
                        {briefing.forecastAt === null || now - briefing.forecastAt > 24 * 3_600_000
                            ? 'Fresh forecast unavailable; day verdict unknown.'
                            : briefing.lines[1]}
                    </p>
                    <p className="text-xs text-slate-400">
                        Latest cached forecast run{' '}
                        {briefing.forecastAt === null
                            ? 'unknown'
                            : new Date(briefing.forecastAt).toISOString().slice(0, 16) + ' UTC'}{' '}
                        · sampled 0.25° sea cell · {briefing.zone}
                    </p>
                    {answer?.positionAt !== undefined && (
                        <p className="text-xs text-slate-400">
                            Registered position clock {new Date(answer.positionAt).toISOString().slice(0, 16)} UTC; this
                            is not a new boat fix.
                        </p>
                    )}
                    <details>
                        <summary>Source and missing data</summary>
                        {briefing.detail.map((line) => (
                            <p key={line} className="text-xs text-slate-300">
                                {line}
                            </p>
                        ))}
                    </details>
                    {typeof navigator.share === 'function' && (
                        <button
                            type="button"
                            onClick={() =>
                                void navigator
                                    .share({
                                        title: `Weather briefing · ${briefing.place}`,
                                        text: [...briefing.lines, ...briefing.detail].join('\n'),
                                    })
                                    .catch(() => undefined)
                            }
                            className="min-h-11 px-3"
                        >
                            Share briefing
                        </button>
                    )}
                </>
            ) : (
                <p className="text-xs text-slate-400">
                    {answer
                        ? 'Cached briefing unavailable; no extra provider request was made.'
                        : 'Reading cached forecast…'}
                </p>
            )}
        </section>
    );
}
