import {
    currentObservation,
    withinHistory,
    validPosition,
    HOUR_MS,
    type Observation,
    type ObservationProvider,
    type Exposure,
} from './model.js';
export function distanceNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const rad = Math.PI / 180;
    const dl = (((b.lon - a.lon + 540) % 360) - 180) * rad,
        da = (b.lat - a.lat) * rad;
    const h = Math.sin(da / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dl / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
export interface NearbyReading {
    observation: Observation;
    distanceNm: number;
    ageMinutes: number;
    exposureLabel: string;
}
const EXPOSURE: Record<Exposure, string> = {
    unknown: 'Station exposure unknown',
    buoy: 'Buoy; local wind exposure may differ',
    platform: 'Offshore platform; sensor height/exposure may differ',
    'coastal-land': 'Coastal land station; shelter may differ',
    'airport-land': 'Airport on land; exposure to this water unknown',
    'metar-station': 'Airport / METAR station; exposure to this water unknown',
};
export interface NearbyObservations {
    marine: NearbyReading | null;
    airport: NearbyReading | null;
}
/** Selection is local: the inspected point is never incorporated into a provider request. */
export function selectNearbyObservations(
    rows: readonly Observation[],
    point: { lat: number; lon: number },
    now: number,
    radiusNm = 50,
): NearbyObservations {
    const answer: NearbyObservations = { marine: null, airport: null };
    if (
        ![point.lat, point.lon].every(Number.isFinite) ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lon) > 180 ||
        !Number.isFinite(radiusNm) ||
        radiusNm <= 0 ||
        radiusNm > 100
    )
        return answer;
    const latest = new Map<string, Observation>();
    for (const row of rows) {
        if (!validPosition(row.lat, row.lon) || !currentObservation(row, now)) continue;
        const key = `${row.provider}:${row.id}`,
            old = latest.get(key);
        if (
            !old ||
            row.observedAtMs > old.observedAtMs ||
            (row.observedAtMs === old.observedAtMs && (row.receivedAtMs ?? 0) > (old.receivedAtMs ?? 0))
        )
            latest.set(key, row);
    }
    for (const row of latest.values()) {
        const distance = distanceNm(point, row);
        if (distance > radiusNm) continue;
        const slot = row.provider === 'awc-metar' ? 'airport' : 'marine',
            old = answer[slot];
        if (
            !old ||
            distance < old.distanceNm ||
            (distance === old.distanceNm && row.observedAtMs > old.observation.observedAtMs)
        )
            answer[slot] = {
                observation: { ...row },
                distanceNm: distance,
                ageMinutes: Math.floor((now - row.observedAtMs) / 60000),
                exposureLabel: EXPOSURE[row.exposure],
            };
    }
    return answer;
}
export type ProviderAvailability = 'available' | 'failed' | 'native-required' | 'not-loaded';
export interface ObservationUiRow {
    key: string;
    heading: string;
    measurements: string;
    source: string;
    sourceUrl: string;
    observedAtMs: number;
    retrievedAtMs: number;
    age: string;
    exposure: string;
}
/** Plain strings for React text nodes, never HTML and never a forecast replacement. */
export function observationUiRows(nearby: NearbyObservations): ObservationUiRow[] {
    return [nearby.marine, nearby.airport].flatMap((item) => {
        if (!item) return [];
        const o = item.observation,
            metrics: string[] = [];
        if (o.windSpeedKts !== null)
            metrics.push(
                o.windSpeedKts === 0
                    ? 'Wind calm'
                    : `Wind ${o.windSpeedKts.toFixed(1)} kt${o.variableWind ? ' variable' : o.fromDeg === null ? ' (direction unavailable)' : ` from ${Math.round(o.fromDeg)}° true`}`,
            );
        if (o.gustKts !== null) metrics.push(`gust ${o.gustKts.toFixed(1)} kt`);
        if (o.seaLevelPressureHpa !== null) metrics.push(`Sea-level pressure ${o.seaLevelPressureHpa.toFixed(1)} hPa`);
        if (o.altimeterHpa !== null) metrics.push(`Altimeter/QNH ${o.altimeterHpa.toFixed(1)} hPa`);
        if (o.airTempC !== null) metrics.push(`Air ${o.airTempC.toFixed(1)} °C`);
        return [
            {
                key: `${o.provider}:${o.id}`,
                heading: `${o.name} · ${item.distanceNm.toFixed(1)} NM`,
                measurements: metrics.join(' · '),
                source: o.attribution,
                sourceUrl: o.sourceUrl,
                observedAtMs: o.observedAtMs,
                retrievedAtMs: o.retrievedAtMs,
                age: item.ageMinutes < 0 ? `timestamp ${-item.ageMinutes} min ahead` : `${item.ageMinutes} min ago`,
                exposure: item.exposureLabel,
            },
        ];
    });
}
export function observationEmptyMessage(provider: ObservationProvider, state: ProviderAvailability): string {
    const name = provider === 'ndbc' ? 'NDBC' : 'Airport METAR';
    return state === 'native-required'
        ? `${name} observations load in the app; this source does not allow browser access.`
        : state === 'failed'
          ? `Could not reach ${name} observations.`
          : state === 'not-loaded'
            ? `${name} observations have not been checked.`
            : `No recent ${name} observation within the search radius; this does not establish local conditions.`;
}
/** Bounded public-record history. No map position, account ID or track is retained. */
export class ObservationHistory {
    private readonly stations = new Map<string, { used: number; rows: Observation[]; bytes: number }>();
    static readonly MAX_STATIONS = 32;
    static readonly MAX_ROWS = 512;
    static readonly MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;
    put(rows: readonly Observation[], now: number): void {
        if (rows.length > 8000 || !Number.isFinite(now)) return;
        const incoming = new Map<string, Observation[]>();
        for (const row of rows) {
            if (!withinHistory(row.observedAtMs, now)) continue;
            const key = `${row.provider}:${row.id}`,
                group = incoming.get(key) ?? [];
            group.push(row);
            incoming.set(key, group);
        }
        for (const [key, group] of incoming) {
            const samples = new Map(
                (this.stations.get(key)?.rows ?? [])
                    .filter((row) => withinHistory(row.observedAtMs, now))
                    .map((row) => [row.observedAtMs, row]),
            );
            for (const row of group) {
                const old = samples.get(row.observedAtMs);
                if (!old || (row.receivedAtMs ?? 0) > (old.receivedAtMs ?? 0))
                    samples.set(row.observedAtMs, { ...row });
            }
            const publicRows = [...samples.values()]
                .sort((a, b) => a.observedAtMs - b.observedAtMs)
                .slice(-ObservationHistory.MAX_ROWS);
            const held = {
                used: now,
                rows: publicRows,
                bytes: new TextEncoder().encode(JSON.stringify([key, publicRows])).length,
            };
            this.stations.set(key, held);
            while (
                this.stations.size > ObservationHistory.MAX_STATIONS ||
                this.bytes() > ObservationHistory.MAX_SERIALIZED_BYTES
            ) {
                const oldest = [...this.stations].sort((a, b) => a[1].used - b[1].used)[0];
                if (!oldest) break;
                this.stations.delete(oldest[0]);
            }
        }
        for (const [key, held] of this.stations)
            if (!held.rows.some((r) => withinHistory(r.observedAtMs, now))) this.stations.delete(key);
    }
    get(provider: ObservationProvider, id: string, now: number, hours = 72): Observation[] {
        if (!Number.isFinite(now) || !Number.isFinite(hours) || hours < 12 || hours > 72) return [];
        const held = this.stations.get(`${provider}:${id}`);
        if (!held) return [];
        held.used = now;
        return held.rows
            .filter((r) => withinHistory(r.observedAtMs, now) && r.observedAtMs >= now - hours * HOUR_MS)
            .map((r) => ({ ...r }));
    }
    size(): number {
        return this.stations.size;
    }
    latest(now: number): Observation[] {
        return [...this.stations.values()].flatMap((held) => {
            const row = held.rows.filter((r) => withinHistory(r.observedAtMs, now)).at(-1);
            return row ? [{ ...row }] : [];
        });
    }
    bytes(): number {
        return (
            2 +
            [...this.stations.values()].reduce((sum, station) => sum + station.bytes, 0) +
            Math.max(0, this.stations.size - 1)
        );
    }
}
