/**
 * Seabed mapping: reading one sounding off Signal K on this Pi.
 *
 * SELF-CONTAINED on purpose: its own discovery, its own envelope walkers and
 * its own GNSS lookup, never trackSignalk's internals, so the staged Pi
 * install can add seabed mapping without dragging in anything else from
 * master. Signal K speaks SI: m/s, radians.
 *
 * What is recorded is the depth BELOW THE TRANSDUCER, as captured (IHO B-12
 * prefers raw). environment.depth.belowTransducer (DBT) first. Without it:
 * belowKeel + transducerToKeel, or belowSurface - surfaceToTransducer, both
 * marked DEPTH_DERIVED. belowSurface on its own only when the bus shows no
 * keel setting at all (then it is the waterline depth, DEPTH_REF W): a
 * sounder set to show the keel fills DBS with the KEEL figure, and once DBT
 * and DPT go quiet there is no telling which it is (the readDepth trap,
 * 2026-09-29). Keel-referenced depth is never stored.
 *
 * Every time is the SENSOR's: the depth leaf's own timestamp, corrected to
 * GPS time by navigation.datetime (the Pi has no RTC battery). No GPS clock,
 * no row: better a gap than a lie, as the track recorder says.
 */
import type { SeabedDepthRef } from './seabedCore.js';

const MS_TO_KN = 1.94384;
const RAD_TO_DEG = 180 / Math.PI;
/** A depth or position older than this (by the Pi's clock) is not a live reading. */
export const LIVE_MS = 10_000;
const FUTURE_SKEW_MS = 5_000;
/** The offset only counts while navigation.datetime itself is this fresh. */
const GPS_CLOCK_MAX_AGE_MS = 10_000;
const GNSS_MAX_AGE_MS = 13_000;
const DISCOVERY_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 3_000;

export interface SeabedDepthReading {
    value: number;
    /** Pi-clock time of the measurement (the leaf's own timestamp). */
    atMs: number;
    ref: SeabedDepthRef;
    derived: boolean;
    source: string;
}

export interface Sounding {
    fix: { lat: number; lon: number } | null;
    posAtMs: number | null;
    positionSource: string | null;
    sogKn: number | null;
    cogDeg: number | null;
    hdgDeg: number | null;
    heelDeg: number | null;
    fixQ: number | null;
    hdop: number | null;
    sats: number | null;
    /** GPS time minus the Pi's clock, from a datetime received in the last 10 s. */
    gpsOffsetMs: number | null;
    depth: SeabedDepthReading | null;
    depthSourceLabel: string | null;
    transducerToKeelM: number | null;
    surfaceToTransducerM: number | null;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The leaf envelope at a dotted path, unwrapping `value` objects on the way (position is nested). */
function leaf(doc: unknown, path: string): Obj | null {
    let cur: unknown = doc;
    for (const key of path.split('.')) {
        if (!isObj(cur)) return null;
        let node = cur;
        if (!(key in node) && isObj(node.value)) node = node.value;
        if (!(key in node)) return null;
        cur = node[key];
    }
    return isObj(cur) ? cur : null;
}

function finite(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stamp(node: Obj | null): number | null {
    const t = typeof node?.timestamp === 'string' ? Date.parse(node.timestamp) : NaN;
    return Number.isFinite(t) ? t : null;
}

function reading(doc: unknown, path: string): { value: number; at: number | null; source: string | null } | null {
    const node = leaf(doc, path);
    const value = finite(node?.value);
    if (!node || value === null) return null;
    return { value, at: stamp(node), source: typeof node.$source === 'string' ? node.$source : null };
}

function degrees(rad: number | null): number | null {
    return rad === null ? null : (((rad * RAD_TO_DEG) % 360) + 360) % 360;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Signal K's standardised methodQuality strings, in GGA code order 0..8. */
const FIX_QUALITY = [
    'no GPS',
    'GNSS Fix',
    'DGNSS fix',
    'Precise GNSS',
    'RTK fixed integer',
    'RTK float',
    'Estimated (DR) mode',
    'Manual input',
    'Simulator mode',
];

/** GNSS figures for the receiver that gave the position, never another GPS that wrote last. */
function gnss(doc: unknown, source: string | null, nowMs: number): Pick<Sounding, 'fixQ' | 'hdop' | 'sats'> {
    const out: Pick<Sounding, 'fixQ' | 'hdop' | 'sats'> = { fixQ: null, hdop: null, sats: null };
    const tree = leaf(doc, 'navigation.gnss');
    if (!tree || !source) return out;
    for (const [name, key] of [
        ['methodQuality', 'fixQ'],
        ['horizontalDilution', 'hdop'],
        ['satellites', 'sats'],
    ] as const) {
        const env = tree[name];
        if (!isObj(env)) continue;
        // Source keys may contain dots: index values[] directly, never via the path walker.
        const per = isObj(env.values) ? env.values[source] : undefined;
        const node = isObj(per) ? per : env.$source === source ? env : null;
        const at = stamp(node);
        if (!node || at === null || at > nowMs + 1_000 || nowMs - at > GNSS_MAX_AGE_MS) continue;
        const value = name === 'methodQuality' ? FIX_QUALITY.indexOf(String(node.value)) : finite(node.value);
        if (value === null || value < 0) continue;
        if (name === 'satellites' && (!Number.isInteger(value) || value > 256)) continue;
        if (name === 'horizontalDilution' && value > 100) continue;
        out[key] = value;
    }
    return out;
}

function depthOf(doc: unknown, nowMs: number): SeabedDepthReading | null {
    const live = (at: number | null): at is number =>
        at !== null && at <= nowMs + FUTURE_SKEW_MS && nowMs - at <= LIVE_MS;
    const raw = reading(doc, 'environment.depth.belowTransducer');
    if (raw && raw.value >= 0 && live(raw.at)) {
        return { value: raw.value, atMs: raw.at, ref: 'T', derived: false, source: 'signalk:belowTransducer' };
    }
    const keel = reading(doc, 'environment.depth.belowKeel');
    const toKeel = reading(doc, 'environment.depth.transducerToKeel');
    if (keel && live(keel.at) && toKeel && toKeel.value > 0 && toKeel.value <= 5) {
        const offsetCurrent = toKeel.at === null || Math.abs(keel.at - toKeel.at) <= LIVE_MS;
        const value = round3(keel.value + toKeel.value);
        if (offsetCurrent && value >= 0) {
            return { value, atMs: keel.at, ref: 'T', derived: true, source: 'signalk:belowKeel+transducerToKeel' };
        }
    }
    // Any keel setting on the bus means DBS may be the keel figure: stop here.
    if (keel || toKeel) return null;
    const surface = reading(doc, 'environment.depth.belowSurface');
    if (!surface || !live(surface.at) || surface.value < 0) return null;
    const toSurface = reading(doc, 'environment.depth.surfaceToTransducer');
    if (toSurface && toSurface.value > 0 && toSurface.value <= 10) {
        const value = round3(surface.value - toSurface.value);
        if (value < 0) return null;
        return {
            value,
            atMs: surface.at,
            ref: 'T',
            derived: true,
            source: 'signalk:belowSurface-surfaceToTransducer',
        };
    }
    return { value: surface.value, atMs: surface.at, ref: 'W', derived: false, source: 'signalk:belowSurface' };
}

/** Everything one row needs, read off one self document. Never throws. */
export function readSounding(doc: unknown, nowMs: number): Sounding {
    const pos = leaf(doc, 'navigation.position');
    const posValue = isObj(pos?.value) ? pos.value : null;
    const lat = finite(posValue?.latitude);
    const lon = finite(posValue?.longitude);
    const posAtMs = stamp(pos);
    const valid =
        lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
    const fresh = posAtMs !== null && posAtMs <= nowMs + FUTURE_SKEW_MS && nowMs - posAtMs <= LIVE_MS;
    const positionSource = typeof pos?.$source === 'string' && pos.$source.length <= 120 ? pos.$source : null;

    const dt = leaf(doc, 'navigation.datetime');
    const gpsMs = typeof dt?.value === 'string' ? Date.parse(dt.value) : NaN;
    const dtAt = stamp(dt);
    const clockFresh = dtAt !== null && Math.abs(nowMs - dtAt) <= GPS_CLOCK_MAX_AGE_MS;
    const gpsOffsetMs = Number.isFinite(gpsMs) && clockFresh ? gpsMs - (dtAt as number) : null;

    const sog = finite(leaf(doc, 'navigation.speedOverGround')?.value);
    // Attitude nests roll inside its value object; only a current one counts.
    const attitude = leaf(doc, 'navigation.attitude');
    const attitudeAt = stamp(attitude);
    const attitudeFresh = attitudeAt !== null && Math.abs(nowMs - attitudeAt) <= 30_000;
    const roll = attitudeFresh && isObj(attitude?.value) ? finite(attitude.value.roll) : null;
    const depthLeaf = leaf(doc, 'environment.depth.belowTransducer');
    const toKeel = reading(doc, 'environment.depth.transducerToKeel');
    const toSurface = reading(doc, 'environment.depth.surfaceToTransducer');
    return {
        fix: valid && fresh ? { lat: lat as number, lon: lon as number } : null,
        posAtMs,
        positionSource,
        sogKn: sog === null ? null : sog * MS_TO_KN,
        cogDeg: degrees(finite(leaf(doc, 'navigation.courseOverGroundTrue')?.value)),
        hdgDeg: degrees(finite(leaf(doc, 'navigation.headingTrue')?.value)),
        heelDeg: roll === null ? null : roll * RAD_TO_DEG,
        ...gnss(doc, positionSource, nowMs),
        gpsOffsetMs,
        depth: depthOf(doc, nowMs),
        depthSourceLabel: typeof depthLeaf?.$source === 'string' ? depthLeaf.$source : null,
        transducerToKeelM: toKeel && toKeel.value > 0 && toKeel.value <= 10 ? toKeel.value : null,
        surfaceToTransducerM: toSurface && toSurface.value > 0 && toSurface.value <= 10 ? toSurface.value : null,
    };
}

/**
 * "Acme Marine DST-1" from Signal K's sources tree for an N2K depth source
 * ('can0.35' → sources.can0['35'].n2k). Manufacturer and model only: serial
 * numbers identify a boat and are never read. Null for NMEA 0183 sources.
 */
export function sounderProduct(sources: unknown, label: string | null): string | null {
    if (!label || !isObj(sources)) return null;
    const dot = label.indexOf('.');
    if (dot <= 0) return null;
    const provider = sources[label.slice(0, dot)];
    const device = isObj(provider) ? provider[label.slice(dot + 1)] : null;
    const n2k = isObj(device) && isObj(device.n2k) ? device.n2k : null;
    if (!n2k) return null;
    const clean = (v: unknown) => (typeof v === 'string' && /^[\w .,&()/+-]{1,60}$/.test(v) ? v.trim() : null);
    const parts = [clean(n2k.manufacturerName), clean(n2k.modelId)].filter((p): p is string => !!p);
    return parts.length ? parts.join(' ') : null;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Signal K's REST API with the discovery answer cached: one loopback request
 * per read while under way, instead of two (discovery, then the document).
 * Re-discovers every five minutes, or at once after any failure.
 */
export class SignalkSelfReader {
    private base: string | null = null;
    private baseAt = 0;

    constructor(
        private readonly fetchImpl: FetchLike,
        private readonly origin: string,
        private readonly now: () => number = Date.now,
    ) {}

    private async discover(): Promise<string | null> {
        try {
            const res = await this.fetchImpl(`${this.origin}/signalk`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!res.ok) return null;
            const body = (await res.json()) as Obj;
            const v1 = isObj(body?.endpoints) ? (body.endpoints as Obj).v1 : null;
            const http = isObj(v1) ? v1['signalk-http'] : null;
            if (typeof http !== 'string') return null;
            return http.endsWith('/') ? http : `${http}/`;
        } catch {
            return null;
        }
    }

    async read(path: 'vessels/self' | 'sources' = 'vessels/self'): Promise<unknown | null> {
        if (!this.base || this.now() - this.baseAt > DISCOVERY_TTL_MS) {
            this.base = await this.discover();
            this.baseAt = this.now();
        }
        if (!this.base) return null;
        try {
            const res = await this.fetchImpl(`${this.base}${path}`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!res.ok) {
                this.base = null;
                return null;
            }
            return await res.json();
        } catch {
            this.base = null;
            return null;
        }
    }
}
