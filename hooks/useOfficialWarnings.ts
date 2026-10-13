/**
 * The official warnings at a position, for the Warnings page and the Glass
 * (129-06): null until official_alerts_at answers (services/officialWarnings.ts),
 * which keeps every official surface hidden, then the answer, asked again every
 * 5 minutes while mounted. A refresh that fails never takes an answer away:
 * the service gives the last one again, marked stale, and so does this hook
 * if the service has none (its cache was cleared). Only a new position starts
 * again from null.
 */
import { useEffect, useState } from 'react';
import { fetchOfficialWarnings, type OfficialAnswer } from '../services/officialWarnings';

const REFRESH_MS = 5 * 60_000;
/** While the answer is stale (a refresh failed), it is asked again this soon. */
const STALE_REFRESH_MS = 60_000;

export function useOfficialWarnings(coords: { lat: number; lon: number } | null | undefined): OfficialAnswer | null {
    const lat = coords?.lat;
    const lon = coords?.lon;
    const [answer, setAnswer] = useState<OfficialAnswer | null>(null);
    useEffect(() => {
        setAnswer(null);
        if (typeof lat !== 'number' || typeof lon !== 'number') return;
        let live = true;
        let retry: number | undefined;
        const ask = (): void =>
            void fetchOfficialWarnings(lat, lon).then((a) => {
                if (!live) return;
                setAnswer((prev) => a ?? (prev ? { ...prev, staleSince: prev.staleSince ?? prev.at } : null));
                window.clearTimeout(retry);
                if (a?.staleSince) retry = window.setTimeout(ask, STALE_REFRESH_MS);
            });
        ask();
        const id = window.setInterval(ask, REFRESH_MS);
        return () => {
            live = false;
            window.clearInterval(id);
            window.clearTimeout(retry);
        };
    }, [lat, lon]);
    return answer;
}
