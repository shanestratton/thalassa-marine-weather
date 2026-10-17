export interface CabinSnapshot {
    schema: 1;
    servedAt: number;
    reportedAt: number | null;
    available: boolean;
    readings: {
        heading: number | null;
        pressure: number | null;
        depth: number | null;
        speed: number | null;
        wind: number | null;
    };
    /** Existing runner exposes no original sample clock; absence must not become a known-clear state. */
    anchor: null | { running: boolean; dragging: boolean; sampleAt: null };
    watch: null | {
        state: 'off' | 'armed' | 'blind' | 'no-fix';
        lastPassAt: number | null;
        servedAt: number;
        push: string | null;
        alarms: {
            kind: string;
            name: string;
            mmsi: number;
            raisedAt: number;
            acknowledgedAt: number | null;
            lost: boolean;
        }[];
    };
}
export const CABIN_STALE_MS = 20_000;
export function cabinRecent(at: number | null, now: number): boolean {
    return at !== null && Number.isSafeInteger(at) && at <= now + 5_000 && now - at < CABIN_STALE_MS;
}
export function parseCabinSnapshot(value: unknown): CabinSnapshot | null {
    const v = value as CabinSnapshot | null;
    if (
        !v ||
        v.schema !== 1 ||
        !Number.isSafeInteger(v.servedAt) ||
        typeof v.available !== 'boolean' ||
        !(v.reportedAt === null || Number.isSafeInteger(v.reportedAt)) ||
        !v.readings ||
        !Object.values(v.readings).every((item) => item === null || (typeof item === 'number' && Number.isFinite(item)))
    )
        return null;
    if (Object.keys(v.readings).sort().join(',') !== 'depth,heading,pressure,speed,wind') return null;
    const ranges: Record<string, readonly [number, number]> = {
        heading: [0, 360],
        pressure: [800, 1200],
        depth: [-20, 12000],
        speed: [0, 150],
        wind: [0, 150],
    };
    if (
        Object.entries(v.readings).some(
            ([key, value]) => value !== null && (value < ranges[key][0] || value > ranges[key][1]),
        )
    )
        return null;
    if (
        v.anchor !== null &&
        (!v.anchor ||
            typeof v.anchor.running !== 'boolean' ||
            typeof v.anchor.dragging !== 'boolean' ||
            v.anchor.sampleAt !== null)
    )
        return null;
    if (
        v.watch !== null &&
        (!v.watch ||
            !['off', 'armed', 'blind', 'no-fix'].includes(v.watch.state) ||
            !Number.isSafeInteger(v.watch.servedAt) ||
            !(v.watch.lastPassAt === null || Number.isSafeInteger(v.watch.lastPassAt)) ||
            !(v.watch.push === null || (typeof v.watch.push === 'string' && v.watch.push.length <= 32)) ||
            !Array.isArray(v.watch.alarms) ||
            v.watch.alarms.length > 20 ||
            v.watch.alarms.some(
                (a) =>
                    !a ||
                    !['collision', 'close-quarters', 'distress'].includes(a.kind) ||
                    typeof a.name !== 'string' ||
                    a.name.length > 80 ||
                    !Number.isSafeInteger(a.mmsi) ||
                    a.mmsi < 100_000_000 ||
                    a.mmsi > 999_999_999 ||
                    !Number.isSafeInteger(a.raisedAt) ||
                    !(a.acknowledgedAt === null || Number.isSafeInteger(a.acknowledgedAt)) ||
                    typeof a.lost !== 'boolean',
            ))
    )
        return null;
    return v;
}
