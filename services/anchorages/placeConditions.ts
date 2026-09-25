import { worstFetchAround } from './anchorageVerdict';

export type TrafficLight = 'green' | 'amber' | 'red' | 'unknown';
export const CONDITION_COLOURS: Record<TrafficLight, string> = {
    green: '#22c55e',
    amber: '#fbbf24',
    red: '#f87171',
    unknown: '#94a3b8',
};
export const CONDITION_LABELS: Record<TrafficLight, string> = {
    green: 'Favourable forecast',
    amber: 'Caution',
    red: 'Adverse / restricted',
    unknown: 'Not assessed',
};
export interface ConditionsPlace {
    id: string;
    lat: number;
    lon: number;
    kind: string;
    fetchLandNM?: readonly number[];
    noAnchoring?: boolean;
    approximate?: boolean;
    source?: string;
    mooringClass?: string | null;
    /** Metres, converted from the vessel profile by the caller. */
    vessel?: { lengthM: number; hullType?: string };
}
export interface ConditionsHour {
    t: number;
    wind?: number;
    gust?: number;
    direction?: number;
    weatherCode?: number;
    waveM?: number;
    waveDirection?: number;
    wavePeriod?: number;
}
export interface ConditionsForecast {
    fetchedAt: number;
    lat: number;
    lon: number;
    hours: ConditionsHour[];
}
export interface PlaceConditions {
    light: TrafficLight;
    reasons: string[];
    fromMs: number;
    toMs: number;
    fetchedAt?: number;
    worstAt?: number;
}
export const CONDITIONS_WINDOW_MS = 12 * 3_600_000;
export const CONDITIONS_MAX_AGE_MS = 15 * 60_000;
export const validFetchTable = (table: unknown): table is number[] =>
    Array.isArray(table) && table.length === 36 && table.every((v) => Number.isFinite(v) && v >= 0 && v <= 15);
const valid = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
export const distanceNM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
    Math.hypot((a.lat - b.lat) * 60, (((a.lon - b.lon + 540) % 360) - 180) * 60 * Math.cos((a.lat * Math.PI) / 180));

/** Weather/shelter screening, NOT approval to anchor or use a buoy. Worst hour
 * wins. Thresholds below are conservative product heuristics, not official
 * "safe anchorage" limits. Reefs are not assumed to block waves at every tide.
 * QPWS class limits: qld.gov.au/.../public-moorings-reef-protection-areas.
 * Class C uses the lower 24 kn limit, including the Moreton Bay exception. */
export function assessPlaceConditions(
    place: ConditionsPlace,
    forecast?: ConditionsForecast | null,
    now = Date.now(),
): PlaceConditions {
    const base = { fromMs: now, toMs: now + CONDITIONS_WINDOW_MS, fetchedAt: forecast?.fetchedAt };
    const result = (light: TrafficLight, reasons: string[], worstAt?: number): PlaceConditions => ({
        ...base,
        light,
        reasons,
        worstAt,
    });
    if (place.noAnchoring && place.kind !== 'mooring') return result('red', ['Mapped no-anchoring restriction.']);
    const mooring = place.kind === 'mooring';
    const cls = place.source === 'QPWS' ? place.mooringClass : null;
    const limits: Record<string, [number, number, number]> = {
        T: [6, 6, 24],
        A: [10, 9, 24],
        B: [20, 18, 34],
        C: [25, 22, 24],
        D: [35, 30, 34],
    };
    const limit = cls ? limits[cls] : undefined;
    const hull = place.vessel?.hullType;
    const length = place.vessel?.lengthM;
    const vesselKnown = valid(length, 1, 150) && (hull === 'monohull' || hull === 'catamaran');
    if (mooring && limit && vesselKnown && length! > limit[hull === 'catamaran' ? 1 : 0])
        return result('red', [`Vessel length exceeds the published QPWS class ${cls} limit.`]);
    if (
        !forecast ||
        !valid(forecast.fetchedAt, now - CONDITIONS_MAX_AGE_MS, now + 60_000) ||
        !Number.isFinite(distanceNM(place, forecast)) ||
        distanceNM(place, forecast) > 5
    )
        return result('unknown', ['Fresh local forecast unavailable.']);
    const start = Math.floor(now / 3_600_000) * 3_600_000;
    const end = Math.ceil(base.toMs / 3_600_000) * 3_600_000;
    const hours = forecast.hours.filter((h) => h.t >= start && h.t <= end).sort((a, b) => a.t - b.t);
    let incomplete = hours.length !== (end - start) / 3_600_000 + 1;
    const cautions = new Set<string>();
    const hazards = new Set<string>();
    let worstAt: number | undefined;
    const shelterKnown = validFetchTable(place.fetchLandNM) && !place.approximate && place.kind !== 'marina';
    for (let i = 0; i < hours.length; i++) {
        const h = hours[i];
        if (h.t !== start + i * 3_600_000) incomplete = true;
        const before = hazards.size;
        if (valid(h.wind, 0, 180) && h.wind >= 26) hazards.add('Strong forecast wind, even inside a sheltered cove.');
        if (valid(h.gust, 0, 220) && h.gust >= 34) hazards.add('Strong forecast gusts.');
        if (h.weatherCode === 95 || h.weatherCode === 96 || h.weatherCode === 99)
            hazards.add('Thunderstorms forecast; squalls may exceed modelled gusts.');
        if (mooring && limit && ((h.wind ?? 0) >= limit[2] || (h.gust ?? 0) >= limit[2]))
            hazards.add(
                `Forecast wind/gust reaches the conservative ${limit[2]} kn class ${cls} screening limit. Read the buoy tag.`,
            );
        const windOK = valid(h.wind, 0, 180) && valid(h.gust, 0, 220) && h.gust >= h.wind && valid(h.direction, 0, 360);
        const waveOK = valid(h.waveM, 0, 30) && valid(h.waveDirection, 0, 360) && valid(h.wavePeriod, 0, 40);
        const codeOK = valid(h.weatherCode, 0, 99);
        if (!windOK || !waveOK || !codeOK) incomplete = true;
        if (windOK && (h.wind! >= 20 || h.gust! >= 25))
            cautions.add('Fresh wind or gusts; shelter does not remove wind loading.');
        if (shelterKnown && windOK) {
            const fetch = worstFetchAround(place.fetchLandNM!, h.direction!, 30);
            if (fetch >= 3 && h.wind! >= 20) hazards.add('Exposed to strengthening wind and locally generated chop.');
            else if (fetch >= 1 && h.wind! >= 12)
                cautions.add('Open fetch in a forecast wind direction; chop may build.');
        }
        if (shelterKnown && waveOK) {
            // Land only: a reef's protection varies with tide, depth and waves.
            const fetch = worstFetchAround(place.fetchLandNM!, h.waveDirection!, 40);
            if (fetch >= 2 && h.waveM! >= 1.5) hazards.add('Exposed to significant forecast waves / swell.');
            else if ((fetch >= 1 && h.waveM! >= 0.5) || (h.wavePeriod! >= 10 && h.waveM! >= 0.5))
                cautions.add('Wave exposure or long-period swell may cause rolling.');
        }
        if (hazards.size > before && worstAt === undefined) worstAt = h.t;
    }
    if (hazards.size)
        return result(
            'red',
            [...hazards, ...(incomplete ? ['Some forecast fields or hours are missing.'] : [])],
            worstAt,
        );
    const missing: string[] = [];
    if (incomplete) missing.push('Incomplete wind, gust, weather or wave coverage for the next 12 hours.');
    if (!shelterKnown) missing.push('No usable shelter geometry for this exact position.');
    if (mooring && (!limit || !vesselKnown))
        missing.push('Mooring limits or vessel length / hull type are not verified.');
    if (missing.length) return result(cautions.size ? 'amber' : 'unknown', [...cautions, ...missing]);
    if (cautions.size) return result('amber', [...cautions]);
    return result('green', ['Wind, gusts and wave exposure look favourable across the next 12 hours.']);
}
