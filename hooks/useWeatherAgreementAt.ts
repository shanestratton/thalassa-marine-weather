/** Glass's wind/precipitation/wave chip; the desk's wind-only hook is separate.
 * Uses the existing shared passive two-request spread, never a skill ranking.
 * No provider request is added for a separate chip component or day swipe. */
import { useEffect, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { queryModelSpread, type ModelSpreadResult } from '../services/weather/ModelSpreadService';
import { verdictAt, weatherAgreementByDay, type WeatherDayVerdict } from '../services/weather/dayAgreement';
import { resolveTimeZone } from '../utils/timezone';

const memo = new WeakMap<ModelSpreadResult, Map<string, WeatherDayVerdict[]>>();

export function useWeatherAgreementAt(
    coordinates: { lat: number; lon: number } | null | undefined,
    ms: number | null,
    wanted: boolean,
    refreshedAt?: string,
): WeatherDayVerdict | null | undefined {
    const offline = useUIStore((state) => state.isOffline);
    const lat = coordinates?.lat;
    const lon = coordinates?.lon;
    const key =
        lat != null &&
        lon != null &&
        ms != null &&
        Number.isFinite(ms) &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        (lat !== 0 || lon !== 0)
            ? `${lat},${lon}@${ms}`
            : null;
    const [answer, setAnswer] = useState<{ key: string; verdict: WeatherDayVerdict | null } | null>(null);
    useEffect(() => {
        if (!wanted || offline || !key || lat == null || lon == null || ms == null) return;
        let cancelled = false;
        queryModelSpread(lat, lon, { passive: true })
            .then((spread) => {
                if (cancelled) return;
                const zone = resolveTimeZone(lat, lon);
                let zones = memo.get(spread);
                if (!zones) {
                    zones = new Map();
                    memo.set(spread, zones);
                }
                let verdicts = zones.get(zone);
                if (!verdicts) {
                    verdicts = weatherAgreementByDay(spread, zone);
                    zones.set(zone, verdicts);
                }
                setAnswer({ key, verdict: verdictAt(verdicts, ms) });
            })
            .catch(() => {
                if (!cancelled) setAnswer({ key, verdict: null });
            });
        return () => {
            cancelled = true;
        };
    }, [wanted, offline, key, lat, lon, ms, refreshedAt]);
    if (!key || offline) return null;
    return answer?.key === key ? answer.verdict : undefined;
}
