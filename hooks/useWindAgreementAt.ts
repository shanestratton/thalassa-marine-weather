/**
 * The models' wind verdict for the local day holding `ms` at a place: the
 * Glass day card's agreement chip (W1-09) and, since 127-DESKMAP-b, the desk
 * planner's wind panel. One chain for both, moved here from HeroSlide, so the
 * two can never contradict each other.
 *
 * Read from the ten-day comparison's own memoised answer (queryModelSpread:
 * one per 0.1° cell for 30 minutes, shared with the sheet), so a reader adds
 * no request of its own and cannot disagree with the sheet. Asked only while
 * wanted and online, and as a passive reader: an answer with a leg missing is
 * reused for five minutes, so day swipes never become proxy traffic.
 * undefined: not known yet, so the reader's line is held; null: none to show
 * (offline, unplaced, outside the answer, or the servers never answered), so
 * no verdict rather than a stale one. Days are cut in the place's own zone.
 */
import { useEffect, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { queryModelSpread } from '../services/weather/ModelSpreadService';
import { verdictAt, windAgreementByDay, type WindDayVerdict } from '../services/weather/dayAgreement';
import { resolveTimeZone } from '../utils/timezone';

/** A day's verdict, with every provider whose wind it compared (for the reader's credit). */
export type WindVerdictAt = WindDayVerdict & { providers: string[] };

/** One verdict list per spread answer, however many readers read it. */
const verdictsBySpread = new WeakMap<object, WindVerdictAt[]>();

export function useWindAgreementAt(
    coordinates: { lat: number; lon: number } | null | undefined,
    ms: number | null,
    wanted: boolean,
    /** The Glass report's own refresh: asks again then, so the chip is never
     *  older than the report under it (the spread memo keeps it to one
     *  request per cell per half hour). */
    refreshedAt?: string,
    /** The desk's panel (127-DESKMAP-b): once the servers refuse (a 429 among
     *  them), ask nothing more for as long as this reader is mounted, so the
     *  comparison can never starve the wind field's own requests. */
    haltOnRefusal = false,
): WindVerdictAt | null | undefined {
    const isOffline = useUIStore((s) => s.isOffline);
    const lat = coordinates?.lat;
    const lon = coordinates?.lon;
    // 0°, 0° is the optimistic stub of a location still being geocoded.
    const key =
        lat != null &&
        lon != null &&
        ms != null &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        (lat !== 0 || lon !== 0)
            ? `${lat},${lon}@${ms}`
            : null;
    const [answer, setAnswer] = useState<{ key: string; verdict: WindVerdictAt | null } | null>(null);
    const [halted, setHalted] = useState(false);
    useEffect(() => {
        if (!wanted || halted || isOffline || !key || lat == null || lon == null || ms == null) return;
        let cancelled = false;
        // Passive: a leg that keeps failing is asked again every few minutes,
        // not on every day swipe; the sheet itself still retries when opened.
        queryModelSpread(lat, lon, { passive: true })
            .then((spread) => {
                if (cancelled) return;
                const refused = spread.unreachable?.includes('atmos');
                if (refused && haltOnRefusal) setHalted(true);
                const atmos = refused ? null : spread.atmos;
                let verdicts = atmos ? verdictsBySpread.get(atmos) : undefined;
                if (atmos && !verdicts) {
                    const providers = atmos.models
                        .filter((m) => m.values.wind_speed_10m.some((v) => v != null))
                        .map((m) => m.provider);
                    verdicts = windAgreementByDay(atmos, resolveTimeZone(lat, lon)).map((v) => ({ ...v, providers }));
                    verdictsBySpread.set(atmos, verdicts);
                }
                setAnswer({ key, verdict: verdicts ? (verdictAt(verdicts, ms) as WindVerdictAt | null) : null });
            })
            .catch(() => {
                if (!cancelled) setAnswer({ key, verdict: null });
            });
        return () => {
            cancelled = true;
        };
    }, [wanted, halted, haltOnRefusal, isOffline, key, lat, lon, ms, refreshedAt]);
    if (!key || isOffline) return null;
    return answer?.key === key ? answer.verdict : halted ? null : undefined;
}
