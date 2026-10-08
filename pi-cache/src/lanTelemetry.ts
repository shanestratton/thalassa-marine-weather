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
import { readTelemetrySnapshot, valueAt, num, knots, degrees, timestampAt } from './trackSignalk.js';
import { buildTelemetryBody } from './telemetryPublisher.js';
import type { TelemetrySnapshot } from './trackSignalk.js';

/** A target whose position is older than this is history, not traffic. */
export const AIS_TARGET_MAX_AGE_MS = 10 * 60_000;
/** Busy ports decode hundreds; the phone's own store caps at 500 and sweeps at 10 min. */
export const AIS_TARGET_CAP = 300;
/** ITU-R M.1371: 511 means "heading not available". */
export const AIS_HEADING_UNAVAILABLE = 511;
/**
 * How far a course, speed, heading or nav status may sit behind the report it
 * goes out with. Signal K 2.32.0's AIS readers write a report's position,
 * course, speed, heading and status in one delta (VDM.js: one sentence;
 * n2k-signalk: one PGN), so their times match. An older leaf is a value
 * Signal K kept from an earlier report: the newest said 'not available', or
 * carried a status Signal K has no string for (VDM.js 11-13; n2k-signalk also
 * 15). It goes out as unknown, never as current (125-10b).
 */
export const AIS_REPORT_SKEW_MS = 5_000;

/**
 * The shape the phone's AisStore keeps (types/navigation.ts AisTarget), epoch
 * ms. What Signal K does not have is null, never a made-up value (build 125,
 * 125-10b): Signal K never files AIS 'not available' (no leaf for SOG 102.3,
 * COG 360 or lat 91 / lon 181, and the value it held before stays), and a 0
 * would be a stopped boat pointing due north. So a course, speed, heading or
 * status is sent only when its own leaf came with the report sent
 * (AIS_REPORT_SKEW_MS). A build 124 or older phone reads these nulls as the
 * 0s and 15 it used to be sent, so nothing changes for it.
 */
export interface AisTargetWire {
    mmsi: number;
    name: string;
    /** Null only for a distress beacon (or a safety text) heard before any position. */
    lat: number | null;
    lon: number | null;
    cog: number | null;
    sog: number | null;
    heading: number;
    /**
     * ITU nav status, or null when the report sent carried none Signal K
     * filed (a Class B, a status with no Signal K string, or none heard yet).
     */
    navStatus: number | null;
    shipType: number;
    callSign: string;
    destination: string;
    /**
     * When the report sent was heard: its position's time; for a target with
     * none, its status's (when recent), else its text's. The phone dates
     * navStatus by it.
     */
    lastUpdated: number;
    /** A message 14 text (PGN 129802 on an N2K-fed Signal K) and when it was heard; absent when none. */
    safetyText?: string;
    safetyTextAt?: number;
}

export interface LanTelemetryPayload {
    available: boolean;
    /** The publisher's wire shape (snake_case), or null when the bus is quiet. */
    telemetry: Record<string, unknown> | null;
    ais: AisTargetWire[];
    served_at: string;
    reason?: string;
}

/**
 * Signal K's navigation.state strings → the ITU-R M.1371 nav status codes, as
 * Signal K 2.32.0 writes them for AIS targets: @signalk/nmea0183-signalk
 * 3.20.1 hooks/VDM.js (codes 0-10, 14 'ais-sart', 15 'default'; 11-13 write
 * no state) and @signalk/n2k-signalk 4.7.0 pgns/129038.js (the same strings,
 * no 'default'). Read off the boat's Pi 2026-10-09; the second spelling of 3
 * is kept from before. Anything else, or no state at all, is null: an unknown
 * status, never 15.
 */
const NAV_STATUS_CODES: ReadonlyMap<string, number> = new Map([
    ['motoring', 0],
    ['anchored', 1],
    ['not under command', 2],
    ['restricted manouverability', 3],
    ['restricted manoeuverability', 3],
    ['constrained by draft', 4],
    ['moored', 5],
    ['aground', 6],
    ['fishing', 7],
    ['sailing', 8],
    ['hazardous material high speed', 9],
    ['hazardous material wing in ground', 10],
    ['ais-sart', 14],
    ['default', 15],
]);
/** ITU nav status 14: 'AIS-SART (active), MOB-AIS, EPIRB-AIS'. */
const NAV_STATUS_DISTRESS = 14;

/** The ITU code for a Signal K navigation.state, or null (missing, or no exact code). */
export function navStatusOfState(state: unknown): number | null {
    return typeof state === 'string' ? (NAV_STATUS_CODES.get(state.trim().toLowerCase()) ?? null) : null;
}

/** AIS-SART, MOB-AIS and EPIRB-AIS MMSIs: 970, 972 and 974 and six more digits (ITU-R M.585). */
function isBeaconMmsi(mmsi: number): boolean {
    const prefix = Math.floor(mmsi / 1_000_000);
    return mmsi <= 999_999_999 && (prefix === 970 || prefix === 972 || prefix === 974);
}

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

/** A Signal K leaf's time, or null when it has none or it is too far ahead of the Pi's clock. */
function heardAt(doc: unknown, path: string, now: number): number | null {
    const ms = timestampAt(doc, path, false);
    // A clock a little ahead of the Pi's is still "now"; far ahead is garbage.
    return ms === null || ms - now > 60_000 ? null : ms;
}

/** The latest message 14 text Signal K holds for this MMSI (n2k-signalk's PGN 129802 path), with its time. */
function safetyTextOf(doc: unknown, now: number): { text: string; at: number } | null {
    const path = 'communication.ais.safetyRelatedBroadcast';
    const raw = valueAt(doc, path);
    const at = heardAt(doc, path, now);
    return typeof raw === 'string' && raw.trim() && at !== null ? { text: raw.trim(), at } : null;
}

/**
 * Every AIS target in Signal K's `vessels` collection with a usable, recent
 * position — the boat herself excluded — and every distress beacon (a 97x
 * MMSI or status 14) or safety text heard recently with none: a SART bursts
 * status 14 before its GNSS fix, and Signal K files that report with no
 * position at all. Each target's course, speed, heading and status are those
 * of the report sent, or unknown (AIS_REPORT_SKEW_MS). Beacons first, then
 * freshest first, capped. Signal K 2.32.0 files 97x beacons under `vessels`
 * like any target (VDM.js by message type, n2k-signalk by MMSI), so no other
 * collection is read.
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
        const safety = safetyTextOf(doc, at);
        const textAt = safety?.at ?? null;
        const recent = (t: number | null): t is number => t !== null && at - t <= AIS_TARGET_MAX_AGE_MS;
        const lat = num(doc, 'navigation.position.latitude');
        const lon = num(doc, 'navigation.position.longitude');
        const positionAt = heardAt(doc, 'navigation.position', at);
        const stateAt = heardAt(doc, 'navigation.state', at);
        const positioned =
            lat !== null &&
            lon !== null &&
            Math.abs(lat) <= 90 &&
            Math.abs(lon) <= 180 &&
            !(lat === 0 && lon === 0) &&
            recent(positionAt);
        // The report sent: the position's; with no usable position, a recent
        // status's (a beacon before its fix), else a recent text's.
        let reportAt: number;
        if (positioned) reportAt = positionAt;
        else if (recent(stateAt)) reportAt = stateAt;
        else if (recent(textAt)) reportAt = textAt;
        else continue;
        // A leaf that came with that report (or after it). An older one is a
        // value Signal K kept when a newer report said 'not available'.
        const current = (leafAt: number | null) => leafAt !== null && reportAt - leafAt <= AIS_REPORT_SKEW_MS;
        const reading = (path: string) => (current(heardAt(doc, path, at)) ? num(doc, path) : null);
        const navStatus = current(stateAt) ? navStatusOfState(valueAt(doc, 'navigation.state')) : null;
        // No usable position: only a beacon or a recent safety text is worth sending.
        if (!positioned && !isBeaconMmsi(mmsi) && navStatus !== NAV_STATUS_DISTRESS && !recent(textAt)) continue;
        out.push({
            mmsi,
            name: text((doc as Record<string, unknown>).name),
            lat: positioned ? lat : null,
            lon: positioned ? lon : null,
            cog: degrees(reading('navigation.courseOverGroundTrue')),
            sog: knots(reading('navigation.speedOverGround')),
            heading: degrees(reading('navigation.headingTrue')) ?? AIS_HEADING_UNAVAILABLE,
            navStatus,
            shipType: shipTypeOf(doc),
            callSign: text(valueAt(doc, 'communication.callsignVhf')),
            destination: text(valueAt(doc, 'navigation.destination.commonName')),
            lastUpdated: reportAt,
            ...(safety ? { safetyText: safety.text, safetyTextAt: safety.at } : {}),
        });
    }
    // Beacons first, so the cap never cuts one (a busy port decodes hundreds);
    // then freshest first.
    const rank = (t: AisTargetWire) => (isBeaconMmsi(t.mmsi) || t.navStatus === NAV_STATUS_DISTRESS ? 0 : 1);
    out.sort((a, b) => rank(a) - rank(b) || b.lastUpdated - a.lastUpdated);
    return out.slice(0, AIS_TARGET_CAP);
}

export interface LanTelemetryDeps extends BroadcastDeps {
    deviceLabel: string;
    supplement?: (snapshot: TelemetrySnapshot | null) => Promise<TelemetrySnapshot | null>;
}

/** One answer for `GET /api/telemetry`: the bus and the traffic, as of now. */
export async function readLanTelemetry(deps: LanTelemetryDeps): Promise<LanTelemetryPayload> {
    const now = deps.now ?? Date.now;
    const [selfDoc, vesselsDoc, selfAnswer] = await Promise.all([
        fetchSignalkDocument(deps, 'vessels/self'),
        fetchSignalkDocument(deps, 'vessels'),
        fetchSignalkDocument(deps, 'self'),
    ]);
    const bus = selfDoc === null ? null : readTelemetrySnapshot(selfDoc, now);
    const snapshot = deps.supplement ? await deps.supplement(bus) : bus;
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
