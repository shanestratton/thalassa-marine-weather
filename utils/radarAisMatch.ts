/** Conservative presentation grouping only. Neither sensor's alarm/ack is removed or transferred. */
import { rangeBearing, deadReckonAis, distressKindOfMmsi } from './collisionRule';
import { ageRadarContact } from './radarFeed.js';
import type { RadarContact } from './radarTarget.js';
export interface RadarAisMatchEvidence {
    mmsi: number;
    lat: number;
    lon: number;
    sogKn: number | null;
    cogDeg: number | null;
    at: number;
    source: 'local' | 'cloud';
}
const MAX_SEPARATION_NM = 0.05,
    MAX_VECTOR_ERROR_KN = 1,
    MAX_TIME_SKEW_MS = 6000;
const recent = (at: number, now: number) => Number.isSafeInteger(at) && at > 0 && at <= now + 1000 && now - at <= 15000;
const vector = (speed: number | null, course: number | null): [number, number] | null =>
    speed !== null && Number.isFinite(speed) && speed >= 0 && speed < 102.2
        ? speed === 0
            ? [0, 0]
            : course !== null && Number.isFinite(course) && course >= 0 && course < 360
              ? [speed * Math.sin((course * Math.PI) / 180), speed * Math.cos((course * Math.PI) / 180)]
              : null
        : null;
function matches(radar: RadarContact, ais: RadarAisMatchEvidence, now: number): boolean {
    const r = ageRadarContact(radar, now),
        m = r.motion;
    if (
        !r.fresh ||
        !r.position ||
        !m ||
        r.status !== 'tracking' ||
        r.referenceTarget ||
        !recent(m.at, now) ||
        !recent(ais.at, now) ||
        Math.abs(r.at - ais.at) > MAX_TIME_SKEW_MS ||
        Math.abs(m.at - ais.at) > MAX_TIME_SKEW_MS ||
        (ais.source !== 'local' && ais.source !== 'cloud') ||
        !Number.isInteger(ais.mmsi) ||
        ais.mmsi < 100000000 ||
        ais.mmsi > 999999999 ||
        distressKindOfMmsi(ais.mmsi) !== null ||
        !Number.isFinite(ais.lat) ||
        Math.abs(ais.lat) > 90 ||
        !Number.isFinite(ais.lon) ||
        Math.abs(ais.lon) > 180
    )
        return false;
    const rv = vector(m.sogKn, m.cogTrueDeg),
        av = vector(ais.sogKn, ais.cogDeg);
    if (!rv || !av || Math.hypot(rv[0] - av[0], rv[1] - av[1]) > MAX_VECTOR_ERROR_KN) return false;
    const at = Math.max(r.at, ais.at);
    const rp =
        r.at < at && m.sogKn > 0
            ? deadReckonAis(r.position.lat, r.position.lon, m.sogKn, m.cogTrueDeg, (at - r.at) / 1000)
            : r.position;
    const ap =
        ais.at < at && (ais.sogKn ?? 0) > 0
            ? deadReckonAis(ais.lat, ais.lon, ais.sogKn, ais.cogDeg, (at - ais.at) / 1000)
            : ais;
    return !!rp && !!ap && rangeBearing(rp.lat, rp.lon, ap.lat, ap.lon).rangeNm <= MAX_SEPARATION_NM;
}
/** Bipartite uniqueness: ambiguous radar↔AIS associations leave every identity separate. */
export function matchRadarToAis(
    contacts: readonly RadarContact[],
    ais: readonly RadarAisMatchEvidence[],
    now: number,
): ReadonlyMap<string, number> {
    const grouped = new Map<string, RadarContact[]>();
    for (const c of contacts) {
        const list = grouped.get(c.contactKey) ?? [];
        list.push(c);
        grouped.set(c.contactKey, list);
    }
    const candidates = new Map<string, Set<number>>(),
        reverse = new Map<number, Set<string>>();
    for (const [key, observations] of grouped) {
        const qualified = observations.filter((c) => c.fresh && c.motion && c.position);
        if (!qualified.length) continue;
        // Conflicting independently plotted positions are not a proven association.
        if (
            observations.some(
                (c) =>
                    c.fresh &&
                    c.position &&
                    qualified.some(
                        (q) =>
                            Math.abs(c.at - q.at) <= MAX_TIME_SKEW_MS &&
                            rangeBearing(c.position!.lat, c.position!.lon, q.position!.lat, q.position!.lon).rangeNm >
                                MAX_SEPARATION_NM,
                    ),
            )
        )
            continue;
        for (const a of ais)
            if (qualified.every((c) => matches(c, a, now))) {
                const set = candidates.get(key) ?? new Set<number>();
                set.add(a.mmsi);
                candidates.set(key, set);
                const back = reverse.get(a.mmsi) ?? new Set<string>();
                back.add(key);
                reverse.set(a.mmsi, back);
            }
    }
    const result = new Map<string, number>();
    for (const [key, choices] of candidates)
        if (choices.size === 1) {
            const mmsi = [...choices][0];
            if (reverse.get(mmsi)?.size === 1) result.set(key, mmsi);
        }
    return result;
}
