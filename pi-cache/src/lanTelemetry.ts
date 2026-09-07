/**
 * lanTelemetry — the boat for a phone on the boat LAN.
 *
 * Shane 2026-09-07: "no more signal k or ydwg-02 on the actual phone unless
 * there is no pi available." The YDWG-02 has three TCP client slots and this
 * Pi already holds two of them (its own telemetry and Signal K), so every
 * phone that opened its own socket was one crew member away from exhausting
 * the gateway. Phones read the Pi instead. Over the boat LAN that is this
 * payload: the same instrument snapshot the TelemetryPublisher posts to the
 * cloud, plus every AIS target Signal K has decoded — the two things the
 * phone used to take straight off the gateway.
 *
 * Nothing here opens a socket to the gateway. Signal K on this Pi is the
 * only source, read over its local REST API exactly as the track recorder
 * and the anchor watch already do.
 */
import { fetchSignalkDocument, type BroadcastDeps } from './anchorBroadcaster.js';
import { readTelemetrySnapshot, valueAt, num, knots, degrees } from './trackSignalk.js';
import { buildTelemetryBody } from './telemetryPublisher.js';

/** A target whose position is older than this is history, not traffic. */
export const AIS_TARGET_MAX_AGE_MS = 10 * 60_000;
/** Busy ports decode hundreds; the phone's own store caps at 500 and sweeps at 10 min. */
export const AIS_TARGET_CAP = 300;
/** ITU-R M.1371: 511 means "heading not available". */
export const AIS_HEADING_UNAVAILABLE = 511;

/** The shape the phone's AisStore keeps (types/navigation.ts AisTarget), epoch ms. */
export interface AisTargetWire {
    mmsi: number;
    name: string;
    lat: number;
    lon: number;
    cog: number;
    sog: number;
    heading: number;
    navStatus: number;
    shipType: number;
    callSign: string;
    destination: string;
    lastUpdated: number;
}

export interface LanTelemetryPayload {
    available: boolean;
    /** The publisher's wire shape (snake_case), or null when the bus is quiet. */
    telemetry: Record<string, unknown> | null;
    ais: AisTargetWire[];
    served_at: string;
    reason?: string;
}

/** Signal K's navigation.state strings → the AIS navigational-status codes the phone already draws. */
const NAV_STATUS_CODES: Record<string, number> = {
    motoring: 0,
    anchored: 1,
    'not under command': 2,
    'restricted manouverability': 3,
    'restricted manoeuverability': 3,
    'constrained by draft': 4,
    moored: 5,
    aground: 6,
    fishing: 7,
    sailing: 8,
    'hazardous material high speed': 9,
    'hazardous material wing in ground': 10,
    'ais-sart': 14,
};
const NAV_STATUS_UNDEFINED = 15;

const MMSI_IN_URN = /^(?:vessels\.)?urn:mrn:imo:mmsi:(\d{7,9})$/;

/** Signal K's `/self` answers "vessels.urn:mrn:imo:mmsi:503101240" — the key the boat lives under. */
export function readSelfUrn(selfAnswer: unknown): string | null {
    if (typeof selfAnswer !== 'string') return null;
    const trimmed = selfAnswer.trim();
    if (!trimmed) return null;
    return trimmed.startsWith('vessels.') ? trimmed.slice('vessels.'.length) : trimmed;
}

function mmsiOf(key: string, doc: unknown): number | null {
    const fromKey = MMSI_IN_URN.exec(key)?.[1];
    if (fromKey) return Number(fromKey);
    const raw = (doc as Record<string, unknown> | null)?.mmsi;
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isInteger(n) && n >= 1_000_000 && n <= 999_999_999 ? n : null;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function shipTypeOf(doc: unknown): number {
    const v = valueAt(doc, 'design.aisShipType');
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'object' && v !== null) {
        const id = (v as Record<string, unknown>).id;
        if (typeof id === 'number' && Number.isInteger(id)) return id;
    }
    return 0;
}

function positionStamp(doc: unknown, now: number): number | null {
    const iso = valueAt(doc, 'navigation.position.timestamp');
    const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
    if (!Number.isFinite(ms)) return null;
    // A clock a little ahead of the Pi's is still "now"; far ahead is garbage.
    return ms - now > 60_000 ? null : ms;
}

/**
 * Every AIS target in Signal K's `vessels` collection with a usable, recent
 * position — the boat herself excluded. Freshest first, capped.
 */
export function readAisTargets(
    vesselsDocument: unknown,
    selfUrn: string | null,
    now: () => number = Date.now,
): AisTargetWire[] {
    if (typeof vesselsDocument !== 'object' || vesselsDocument === null) return [];
    const at = now();
    const out: AisTargetWire[] = [];
    for (const [key, doc] of Object.entries(vesselsDocument as Record<string, unknown>)) {
        if (key === 'self' || (selfUrn !== null && key === selfUrn)) continue;
        const mmsi = mmsiOf(key, doc);
        if (mmsi === null) continue;
        const lat = num(doc, 'navigation.position.latitude');
        const lon = num(doc, 'navigation.position.longitude');
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0))
            continue;
        const lastUpdated = positionStamp(doc, at);
        if (lastUpdated === null || at - lastUpdated > AIS_TARGET_MAX_AGE_MS) continue;
        const state = valueAt(doc, 'navigation.state');
        out.push({
            mmsi,
            name: text((doc as Record<string, unknown>).name),
            lat,
            lon,
            cog: degrees(num(doc, 'navigation.courseOverGroundTrue')) ?? 0,
            sog: knots(num(doc, 'navigation.speedOverGround')) ?? 0,
            heading: degrees(num(doc, 'navigation.headingTrue')) ?? AIS_HEADING_UNAVAILABLE,
            navStatus:
                typeof state === 'string'
                    ? (NAV_STATUS_CODES[state.toLowerCase()] ?? NAV_STATUS_UNDEFINED)
                    : NAV_STATUS_UNDEFINED,
            shipType: shipTypeOf(doc),
            callSign: text(valueAt(doc, 'communication.callsignVhf')),
            destination: text(valueAt(doc, 'navigation.destination.commonName')),
            lastUpdated,
        });
    }
    out.sort((a, b) => b.lastUpdated - a.lastUpdated);
    return out.slice(0, AIS_TARGET_CAP);
}

export interface LanTelemetryDeps extends BroadcastDeps {
    deviceLabel: string;
}

/** One answer for `GET /api/telemetry`: the bus and the traffic, as of now. */
export async function readLanTelemetry(deps: LanTelemetryDeps): Promise<LanTelemetryPayload> {
    const now = deps.now ?? Date.now;
    const [selfDoc, vesselsDoc, selfAnswer] = await Promise.all([
        fetchSignalkDocument(deps, 'vessels/self'),
        fetchSignalkDocument(deps, 'vessels'),
        fetchSignalkDocument(deps, 'self'),
    ]);
    const snapshot = selfDoc === null ? null : readTelemetrySnapshot(selfDoc, now);
    const telemetry = snapshot ? buildTelemetryBody(snapshot, deps.deviceLabel) : null;
    const ais = vesselsDoc === null ? [] : readAisTargets(vesselsDoc, readSelfUrn(selfAnswer), now);
    return {
        available: telemetry !== null,
        telemetry,
        ais,
        served_at: new Date(now()).toISOString(),
        ...(telemetry === null
            ? { reason: selfDoc === null ? 'Signal K has no vessel document' : 'nothing on the bus' }
            : {}),
    };
}
