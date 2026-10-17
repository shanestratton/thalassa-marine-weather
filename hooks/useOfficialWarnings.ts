/**
 * The official warnings at a position, for the Warnings page and the Glass
 * (129-06): null until official_alerts_at answers (services/officialWarnings.ts),
 * which keeps every official surface hidden, then the answer, asked again
 * while mounted when it is due (officialRefreshMs): every 5 minutes, and
 * every minute while it holds MeteoAlarm (its terms' real time, 129-05b; the
 * service keeps such an answer only 30 seconds) or could not be refreshed. It
 * is also asked as soon as the app comes back to the foreground, if due. A
 * refresh that fails never takes an answer away: the service gives the last
 * one again, marked stale, and so does this hook if the service has none (its
 * cache was cleared). Only a new position starts again from null.
 */
import { useEffect, useState } from 'react';
import { fetchOfficialWarnings, type OfficialAnswer, officialRefreshMs } from '../services/officialWarnings';

/** How often the hook looks whether a refresh is due. */
const TICK_MS = 60_000;
/** A tick a little early still asks (timers are not exact). */
const TICK_SLACK_MS = 5_000;

export function useOfficialWarnings(coords: { lat: number; lon: number } | null | undefined): OfficialAnswer | null {
    const lat = coords?.lat;
    const lon = coords?.lon;
    const [answer, setAnswer] = useState<OfficialAnswer | null>(null);
    useEffect(() => {
        setAnswer(null);
        if (typeof lat !== 'number' || typeof lon !== 'number') return;
        let live = true;
        let askedAt = 0;
        let dueMs = TICK_MS;
        const ask = (): void => {
            askedAt = Date.now();
            void fetchOfficialWarnings(lat, lon).then((a) => {
                if (!live) return;
                setAnswer((prev) => a ?? (prev ? { ...prev, staleSince: prev.staleSince ?? prev.at } : null));
                dueMs = officialRefreshMs(a);
            });
        };
        const tick = (): void => {
            if (Date.now() - askedAt >= dueMs - TICK_SLACK_MS) ask();
        };
        const onVisible = (): void => {
            if (document.visibilityState === 'visible') tick();
        };
        ask();
        const id = window.setInterval(tick, TICK_MS);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            live = false;
            window.clearInterval(id);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [lat, lon]);
    return answer;
}
