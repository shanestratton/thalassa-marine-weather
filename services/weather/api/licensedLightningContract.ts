/** Original licensed network pulses. Optical satellite flashes remain a separate product. */
export const LIGHTNING_RADIUS_NM = 20;
export const LIGHTNING_WINDOW_MS = 5 * 60_000;
export const LIGHTNING_CREDIT =
    'Lightning: Vaisala Xweather. Licensed network observations; coverage is not guaranteed.';
export interface LicensedPulse {
    id: string;
    lat: number;
    lon: number;
    time: number;
    type: 'cg' | 'ic';
    polarity: 'positive' | 'negative' | 'unknown';
}
export interface LicensedLightning {
    schema: 1;
    provider: 'xweather';
    latitude: number;
    longitude: number;
    radiusNm: 20;
    receivedAt: number;
    windowStart: number;
    truncated: boolean;
    pulses: LicensedPulse[];
}
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const lightningPosition = (lat: unknown, lon: unknown): lat is number =>
    finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
export function lightningDistanceNm(lat: number, lon: number, otherLat: number, otherLon: number): number {
    const rad = Math.PI / 180;
    const a =
        Math.sin(((otherLat - lat) * rad) / 2) ** 2 +
        Math.cos(lat * rad) * Math.cos(otherLat * rad) * Math.sin(((otherLon - lon) * rad) / 2) ** 2;
    return (6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(a)))) / 1.852;
}
/** No response age, receipt time, optical flash, or missing field substitutes for an original pulse. */
export function reduceXweatherLightning(value: unknown, lat: number, lon: number, now: number): LicensedLightning {
    const refuse = (): never => {
        throw new Error('Licensed lightning observations unavailable');
    };
    if (
        !lightningPosition(lat, lon) ||
        !Number.isSafeInteger(now) ||
        now <= 0 ||
        !record(value) ||
        value.success !== true ||
        value.error !== null ||
        !Array.isArray(value.response) ||
        value.response.length > 1000
    )
        return refuse();
    const pulses = new Map<string, LicensedPulse>();
    for (const row of value.response) {
        if (
            !record(row) ||
            typeof row.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) ||
            !record(row.loc) ||
            !lightningPosition(row.loc.lat, row.loc.long) ||
            !record(row.ob) ||
            !record(row.ob.pulse)
        )
            return refuse();
        const ob = row.ob,
            pulse = ob.pulse as Record<string, unknown>;
        const milliseconds = ob.timestampMS;
        const seconds = ob.timestamp;
        if (
            !Number.isSafeInteger(seconds) ||
            (seconds as number) <= 0 ||
            (milliseconds !== undefined &&
                (!Number.isSafeInteger(milliseconds) || Math.floor((milliseconds as number) / 1000) !== seconds))
        )
            return refuse();
        const time = milliseconds === undefined ? (seconds as number) * 1000 : (milliseconds as number);
        const type = typeof pulse.type === 'string' ? pulse.type.toLowerCase() : '';
        if (
            (type !== 'cg' && type !== 'ic') ||
            (pulse.peakamp !== null && (!finite(pulse.peakamp) || Math.abs(pulse.peakamp) > 1_000_000)) ||
            (ob.dateTimeISO !== undefined &&
                (typeof ob.dateTimeISO !== 'string' || Math.floor(Date.parse(ob.dateTimeISO) / 1000) !== seconds)) ||
            (ob.dateTimeISOMS !== undefined &&
                (typeof ob.dateTimeISOMS !== 'string' || Date.parse(ob.dateTimeISOMS) !== time))
        )
            return refuse();
        if (
            time > now ||
            time < now - LIGHTNING_WINDOW_MS ||
            lightningDistanceNm(lat, lon, row.loc.lat, row.loc.long as number) > LIGHTNING_RADIUS_NM
        )
            continue;
        const next: LicensedPulse = {
            id: row.id,
            lat: row.loc.lat,
            lon: row.loc.long as number,
            time,
            type,
            polarity:
                pulse.peakamp === null || pulse.peakamp === 0
                    ? 'unknown'
                    : (pulse.peakamp as number) > 0
                      ? 'positive'
                      : 'negative',
        };
        const prior = pulses.get(next.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(next)) return refuse();
        pulses.set(next.id, next);
    }
    return {
        schema: 1,
        provider: 'xweather',
        latitude: lat,
        longitude: lon,
        radiusNm: 20,
        receivedAt: now,
        windowStart: now - LIGHTNING_WINDOW_MS,
        truncated: value.response.length === 1000,
        pulses: [...pulses.values()].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id)),
    };
}

/** Revalidate the reduced authenticated response before any map or notification use. */
export function parseLicensedLightning(
    value: unknown,
    lat: number,
    lon: number,
    now: number,
): LicensedLightning | null {
    if (
        !record(value) ||
        value.schema !== 1 ||
        value.provider !== 'xweather' ||
        value.latitude !== lat ||
        value.longitude !== lon ||
        !lightningPosition(lat, lon) ||
        value.radiusNm !== 20 ||
        !Number.isSafeInteger(value.receivedAt) ||
        (value.receivedAt as number) > now ||
        now - (value.receivedAt as number) >= LIGHTNING_WINDOW_MS ||
        value.windowStart !== (value.receivedAt as number) - LIGHTNING_WINDOW_MS ||
        typeof value.truncated !== 'boolean' ||
        !Array.isArray(value.pulses) ||
        value.pulses.length > 1000
    )
        return null;
    const seen = new Set<string>();
    for (const p of value.pulses) {
        if (
            !record(p) ||
            typeof p.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(p.id) ||
            seen.has(p.id) ||
            !lightningPosition(p.lat, p.lon) ||
            !Number.isSafeInteger(p.time) ||
            (p.time as number) < (value.windowStart as number) ||
            (p.time as number) > (value.receivedAt as number) ||
            (p.type !== 'cg' && p.type !== 'ic') ||
            !['positive', 'negative', 'unknown'].includes(p.polarity as string) ||
            lightningDistanceNm(lat, lon, p.lat, p.lon as number) > 20
        )
            return null;
        seen.add(p.id);
    }
    return value as unknown as LicensedLightning;
}

export interface LightningNearPush {
    notification_type: 'lightning_nearby';
    title: 'Lightning within 20 NM';
    body: string;
    data: { type: 'lightning_nearby'; provider: 'xweather'; source_at: number; expires_at: number; pulse_id: string };
}
/** Pure decision only. The server must atomically claim and recheck owner/consent before queueing. */
export function lightningNearPush(
    snapshot: LicensedLightning,
    fix: {
        lat: number;
        lon: number;
        originalAt: number;
        consent: boolean;
    },
    now: number,
): LightningNearPush | null {
    if (
        fix.consent !== true ||
        !lightningPosition(fix.lat, fix.lon) ||
        !Number.isSafeInteger(fix.originalAt) ||
        fix.originalAt > now ||
        now - fix.originalAt > 120_000 ||
        snapshot.provider !== 'xweather' ||
        snapshot.schema !== 1 ||
        snapshot.radiusNm !== 20 ||
        snapshot.receivedAt > now ||
        now - snapshot.receivedAt > 60_000 ||
        snapshot.latitude !== fix.lat ||
        snapshot.longitude !== fix.lon
    )
        return null;
    const pulse = snapshot.pulses.find(
        (p) =>
            p.time <= now &&
            now - p.time <= LIGHTNING_WINDOW_MS &&
            lightningDistanceNm(fix.lat, fix.lon, p.lat, p.lon) <= 20,
    );
    if (!pulse) return null; // An empty/expired result never emits an "all clear".
    const age = Math.max(0, Math.floor((now - pulse.time) / 60_000));
    return {
        notification_type: 'lightning_nearby',
        title: 'Lightning within 20 NM',
        body: `Vaisala Xweather detected lightning ${age < 1 ? 'less than a minute' : `${age} min`} ago. Check current conditions.`,
        data: {
            type: 'lightning_nearby',
            provider: 'xweather',
            source_at: pulse.time,
            expires_at: Math.min(pulse.time + LIGHTNING_WINDOW_MS, now + 60_000),
            pulse_id: pulse.id,
        },
    };
}
