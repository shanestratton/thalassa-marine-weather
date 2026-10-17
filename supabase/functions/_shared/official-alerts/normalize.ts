/**
 * One shape for every issuer's warnings (129-05), as official_alerts stores it.
 *
 * Each adapter (adapters.ts) turns its issuer's feed into NormalizedAlerts. The
 * ingest (ingest.ts) then writes only what changed: each alert carries a
 * content hash over everything stored, so an unchanged alert is never
 * rewritten.
 *
 * - The text is the issuer's own: event, headline, description, instruction,
 *   senderName, areaDesc and parameters are copied, never edited or translated.
 *   Every language block is kept (StoredInfo[]), in the issuer's order.
 * - Geometry is simplified to about 100 m (Douglas-Peucker on a local plane,
 *   tolerance 0.0009 degrees of latitude) and rounded to 1e-5 degrees before
 *   it is hashed or sent, so the hash does not move with a feed's float noise.
 * - A ring that crosses 180 degrees is kept continuous (its western longitudes
 *   shifted by +360). official_alerts_at() tests a point at lon and lon + 360.
 */
import type { CapAlert, CapArea, CapCircle, CapInfo, CapValue } from '../cap.ts';
import { toIso } from '../cap.ts';

export type Position = [number, number];
export type Ring = Position[];
/** GeoJSON MultiPolygon coordinates: polygons of rings ([outer, ...holes]). */
export type MultiPolygon = Ring[][];

export interface StoredInfo {
    language: string;
    category: string[];
    event: string;
    urgency: string;
    severity: string;
    certainty: string;
    effective: string | null;
    onset: string | null;
    expires: string | null;
    /** NWS's "ends" (the hazard's end, not the message's expiry), when an issuer gives one. */
    ends: string | null;
    senderName: string | null;
    headline: string | null;
    description: string | null;
    instruction: string | null;
    web: string | null;
    contact: string | null;
    responseType: string[];
    areaDesc: string[];
    parameters: CapValue[];
    eventCodes: CapValue[];
}

export interface NormalizedAlert {
    /** Unique within the provider: the CAP identifier, or the adapter's stable key (JMA). */
    identifier: string;
    sender: string | null;
    sentAt: string;
    msgType: 'Alert' | 'Update';
    status: string;
    scope: string | null;
    references: string[];
    infos: StoredInfo[];
    /** Provider zone keys ("nws:forecast:ANZ531", "EMMA_ID:GR014", "jma-sea:6030"). */
    zones: string[];
    geometry: MultiPolygon | null;
    effectiveAt: string | null;
    onsetAt: string | null;
    expiresAt: string | null;
    contentHash: string;
}

/** About 100 m of latitude, the simplification tolerance (decision B). */
export const SIMPLIFY_DEGREES = 0.0009;
/** A ceiling on the vertices one alert may store, after simplification. */
export const MAX_VERTICES = 20_000;
const ROUND = 1e5;

const round = (v: number): number => Math.round(v * ROUND) / ROUND;

function perpendicularSq(p: Position, a: Position, b: Position, kx: number): number {
    const ax = a[0] * kx;
    const ay = a[1];
    const dx = b[0] * kx - ax;
    const dy = b[1] - ay;
    const px = p[0] * kx - ax;
    const py = p[1] - ay;
    const len = dx * dx + dy * dy;
    if (len === 0) return px * px + py * py;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len));
    const ex = px - t * dx;
    const ey = py - t * dy;
    return ex * ex + ey * ey;
}

/** Douglas-Peucker on one ring, longitudes scaled by cos(latitude). The ring stays closed. */
export function simplifyRing(ring: Ring, tolerance = SIMPLIFY_DEGREES): Ring {
    if (ring.length <= 4) return ring.map(([x, y]) => [round(x), round(y)]);
    const meanLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const kx = Math.cos((meanLat * Math.PI) / 180);
    const tolSq = tolerance * tolerance;
    const keep = new Uint8Array(ring.length);
    keep[0] = 1;
    keep[ring.length - 1] = 1;
    // A closed ring's chord is zero; split it at the point farthest from its start.
    let far = 1;
    let farD = -1;
    for (let i = 1; i < ring.length - 1; i++) {
        const d = perpendicularSq(ring[i], ring[0], ring[0], kx);
        if (d > farD) {
            farD = d;
            far = i;
        }
    }
    keep[far] = 1;
    const stack: [number, number][] = [[0, far], [far, ring.length - 1]];
    while (stack.length > 0) {
        const [s, e] = stack.pop()!;
        let idx = -1;
        let max = tolSq;
        for (let i = s + 1; i < e; i++) {
            const d = perpendicularSq(ring[i], ring[s], ring[e], kx);
            if (d > max) {
                max = d;
                idx = i;
            }
        }
        if (idx >= 0) {
            keep[idx] = 1;
            stack.push([s, idx], [idx, e]);
        }
    }
    const out: Ring = [];
    for (let i = 0; i < ring.length; i++) {
        if (!keep[i]) continue;
        const p: Position = [round(ring[i][0]), round(ring[i][1])];
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    // A ring smaller than the tolerance (a reef, a harbour) keeps its own points.
    return out.length >= 4 ? out : ring.map(([x, y]) => [round(x), round(y)]);
}

/** A ring that spans more than 180 degrees of longitude is taken to cross the antimeridian. */
export function unwrapRing(ring: Ring): Ring {
    let min = Infinity;
    let max = -Infinity;
    for (const [x] of ring) {
        if (x < min) min = x;
        if (x > max) max = x;
    }
    return max - min > 180 ? ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]) : ring;
}

function validRing(ring: unknown): ring is Ring {
    return Array.isArray(ring) && ring.length >= 4 &&
        ring.every((p) =>
            Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
            Math.abs(p[1]) <= 90 && p[0] >= -180 && p[0] <= 360
        );
}

/** GeoJSON Polygon/MultiPolygon (or a GeometryCollection of them) as MultiPolygon coordinates, or null. */
export function geoJsonToMultiPolygon(geometry: unknown): MultiPolygon | null {
    const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown } | null;
    if (!g || typeof g !== 'object') return null;
    const polys: MultiPolygon = [];
    const addPolygon = (rings: unknown) => {
        if (!Array.isArray(rings)) return;
        const kept = rings
            .filter(validRing)
            .map((r) => r.map((p) => [Number(p[0]), Number(p[1])] as Position));
        if (kept.length > 0) polys.push(kept);
    };
    if (g.type === 'Polygon') addPolygon(g.coordinates);
    else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) g.coordinates.forEach(addPolygon);
    else if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
        for (const part of g.geometries) {
            const mp = geoJsonToMultiPolygon(part);
            if (mp) polys.push(...mp);
        }
    }
    return polys.length > 0 ? polys : null;
}

/** A CAP circle as a 32-sided polygon (GeoJSON order), on the sphere. */
export function circleRing(c: CapCircle, sides = 32): Ring {
    const R = 6371.0088;
    const lat1 = (c.lat * Math.PI) / 180;
    const lon1 = (c.lon * Math.PI) / 180;
    const d = c.radiusKm / R;
    const ring: Ring = [];
    for (let i = 0; i < sides; i++) {
        const brg = (2 * Math.PI * i) / sides;
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
        const lon2 = lon1 +
            Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
        let lon = (lon2 * 180) / Math.PI;
        if (lon > 180) lon -= 360;
        if (lon < -180) lon += 360;
        ring.push([lon, (lat2 * 180) / Math.PI]);
    }
    ring.push(ring[0]);
    return unwrapRing(ring);
}

/** Simplified (about 100 m), unwrapped and rounded, within MAX_VERTICES; null when nothing is left. */
export function prepareGeometry(mp: MultiPolygon | null): MultiPolygon | null {
    if (!mp) return null;
    const out: MultiPolygon = [];
    let vertices = 0;
    for (const polygon of mp) {
        const rings = polygon.map((r) => simplifyRing(unwrapRing(r))).filter((r) => r.length >= 4);
        if (rings.length === 0) continue;
        vertices += rings.reduce((s, r) => s + r.length, 0);
        if (vertices > MAX_VERTICES) break;
        out.push(rings);
    }
    return out.length > 0 ? out : null;
}

/** Every polygon and circle of the areas, as one MultiPolygon (unsimplified), or null. */
export function capAreasGeometry(areas: CapArea[]): MultiPolygon | null {
    const polys: MultiPolygon = [];
    for (const area of areas) {
        for (const ring of area.polygons) polys.push([unwrapRing(ring)]);
        for (const circle of area.circles) polys.push([circleRing(circle)]);
    }
    return polys.length > 0 ? polys : null;
}

/** A CAP info block as stored: the issuer's fields, verbatim. */
export function storedInfo(info: CapInfo, extra: { ends?: string | null } = {}): StoredInfo {
    return {
        language: info.language,
        category: info.category,
        event: info.event,
        urgency: info.urgency,
        severity: info.severity,
        certainty: info.certainty,
        effective: info.effective,
        onset: info.onset,
        expires: info.expires,
        ends: extra.ends ?? null,
        senderName: info.senderName,
        headline: info.headline,
        description: info.description,
        instruction: info.instruction,
        web: info.web,
        contact: info.contact,
        responseType: info.responseType,
        areaDesc: [...new Set(info.areas.map((a) => a.areaDesc).filter(Boolean))],
        parameters: info.parameters,
        eventCodes: info.eventCodes,
    };
}

/** JSON with object keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${
        Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
            .join(',')
    }}`;
}

export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type AlertDraft = Omit<NormalizedAlert, 'contentHash' | 'effectiveAt' | 'onsetAt' | 'expiresAt'> & {
    effectiveAt?: string | null;
    onsetAt?: string | null;
    expiresAt?: string | null;
};

const earliest = (times: (string | null)[]): string | null => {
    const ms = times.map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
    return ms.length ? new Date(Math.min(...ms)).toISOString() : null;
};
/** The latest of these times as ISO, or null when none parses. */
export const latestTime = (times: (string | null)[]): string | null => {
    const ms = times.map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
    return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
};

/**
 * The stored alert: times normalised (the earliest effective and onset, the
 * latest expiry over its language blocks; an info with no expiry keeps the
 * alert open), geometry prepared, zones sorted, and the content hash taken
 * over all of it.
 */
export async function finishAlert(draft: AlertDraft): Promise<NormalizedAlert> {
    const geometry = prepareGeometry(draft.geometry);
    const zones = [...new Set(draft.zones)].sort();
    const anyOpen = draft.infos.length === 0 || draft.infos.some((i) => !i.expires);
    const alert = {
        identifier: draft.identifier,
        sender: draft.sender,
        sentAt: toIso(draft.sentAt) ?? draft.sentAt,
        msgType: draft.msgType,
        status: draft.status,
        scope: draft.scope,
        references: [...new Set(draft.references)].sort(),
        infos: draft.infos,
        zones,
        geometry,
        effectiveAt: draft.effectiveAt !== undefined
            ? draft.effectiveAt
            : earliest(draft.infos.map((i) => i.effective)) ?? toIso(draft.sentAt),
        onsetAt: draft.onsetAt !== undefined ? draft.onsetAt : earliest(draft.infos.map((i) => i.onset)),
        expiresAt: draft.expiresAt !== undefined
            ? draft.expiresAt
            : anyOpen
            ? null
            : latestTime(draft.infos.map((i) => i.expires)),
    };
    return { ...alert, contentHash: await sha256Hex(canonicalJson(alert)) };
}

/** A CAP alert's zone keys: its geocodes, named "<valueName>:<value>" (EMMA_ID:GR014). */
export function capZones(alert: CapAlert, accept: (valueName: string) => boolean): string[] {
    const out: string[] = [];
    for (const info of alert.infos) {
        for (const area of info.areas) {
            for (const g of area.geocodes) if (accept(g.valueName) && g.value) out.push(`${g.valueName}:${g.value}`);
        }
    }
    return out;
}
