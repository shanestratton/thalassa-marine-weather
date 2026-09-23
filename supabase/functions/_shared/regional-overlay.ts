import { isOverlayPayload, OVERLAY_FIELDS } from './overpass-fetch.ts';

type Bbox = [number, number, number, number];
type Feature = {
    type: 'Feature';
    bbox: Bbox;
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
};
type Overlay = Record<(typeof OVERLAY_FIELDS)[number], { type: 'FeatureCollection'; features: Feature[] }>;
export const REGIONAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const NEWPORT_COVERAGE: Bbox = [153.075, -27.23, 153.13, -27.15];
export type RegionalOverlay = {
    schema: number;
    region: string;
    coverage: Bbox;
    sourceAsOf: string;
    generatedAt: string;
    sourceUrl: string;
    sourceSha256: string;
    attribution: string;
    licenseUrl: string;
    limitations: string;
    counts: Record<string, number>;
    payloadSha256: string;
    overlay: Overlay;
};
const contains = (a: Bbox, b: Bbox) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
const intersects = (a: Bbox, b: Bbox) => a[0] <= b[2] && a[1] <= b[3] && a[2] >= b[0] && a[3] >= b[1];
const validBbox = (v: unknown): v is Bbox =>
    Array.isArray(v) &&
    v.length === 4 &&
    v.every(Number.isFinite) &&
    v[0] >= -180 &&
    v[2] <= 180 &&
    v[1] >= -90 &&
    v[3] <= 90 &&
    v[0] <= v[2] &&
    v[1] <= v[3];

function validateFeature(f: Feature): void {
    if (f?.type !== 'Feature' || !f.properties || !validBbox(f.bbox)) throw new Error('Regional feature invalid');
    const bounds: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
    let points = 0;
    const point = (p: unknown) => {
        if (
            !Array.isArray(p) ||
            p.length !== 2 ||
            !p.every(Number.isFinite) ||
            Math.abs(p[0]) > 180 ||
            Math.abs(p[1]) > 90
        )
            throw new Error('Regional coordinates invalid');
        if (++points > 100_000) throw new Error('Regional geometry exceeds budget');
        bounds[0] = Math.min(bounds[0], p[0]);
        bounds[1] = Math.min(bounds[1], p[1]);
        bounds[2] = Math.max(bounds[2], p[0]);
        bounds[3] = Math.max(bounds[3], p[1]);
    };
    const line = (v: unknown, ring = false) => {
        if (!Array.isArray(v) || v.length < (ring ? 4 : 2)) throw new Error('Regional line invalid');
        v.forEach(point);
        if (ring && (v[0][0] !== v.at(-1)[0] || v[0][1] !== v.at(-1)[1])) throw new Error('Regional ring is open');
    };
    const polygon = (v: unknown) => {
        if (!Array.isArray(v) || !v.length) throw new Error('Regional polygon invalid');
        v.forEach((r) => line(r, true));
    };
    const { type, coordinates } = f.geometry ?? {};
    if (type === 'Point') point(coordinates);
    else if (type === 'LineString') line(coordinates);
    else if (type === 'Polygon') polygon(coordinates);
    else if (type === 'MultiPolygon' || type === 'MultiLineString') {
        if (!Array.isArray(coordinates) || !coordinates.length) throw new Error('Regional multi-geometry invalid');
        coordinates.forEach((v) => (type === 'MultiPolygon' ? polygon(v) : line(v)));
    } else throw new Error('Regional geometry type invalid');
    if (!bounds.every((v, i) => Math.abs(v - f.bbox[i]) < 1e-9)) throw new Error('Regional bounds mismatch');
}

/** Validate once per isolate, including the exact payload bytes. Freshness is
 * deliberately NOT cached here: every request rechecks the source age. */
export async function loadRegionalOverlay(raw: unknown): Promise<RegionalOverlay> {
    if (!raw || typeof raw !== 'object') throw new Error('Regional bundle missing');
    const b = raw as Record<string, unknown>;
    if (
        b.schema !== 1 ||
        b.region !== 'newport-v1' ||
        JSON.stringify(b.coverage) !== JSON.stringify(NEWPORT_COVERAGE) ||
        typeof b.overlayJson !== 'string' ||
        new TextEncoder().encode(b.overlayJson).length > 5_000_000 ||
        typeof b.sourceAsOf !== 'string' ||
        typeof b.generatedAt !== 'string' ||
        !Number.isFinite(Date.parse(b.sourceAsOf)) ||
        !Number.isFinite(Date.parse(b.generatedAt)) ||
        Date.parse(b.sourceAsOf) > Date.parse(b.generatedAt) ||
        typeof b.sourceUrl !== 'string' ||
        !/^https:\/\/download\.geofabrik\.de\/australia-oceania\/australia\/queensland-\d{6}\.osm\.pbf$/.test(
            b.sourceUrl,
        ) ||
        typeof b.sourceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(b.sourceSha256) ||
        typeof b.attribution !== 'string' ||
        !b.attribution.includes('OpenStreetMap') ||
        b.licenseUrl !== 'https://www.openstreetmap.org/copyright' ||
        typeof b.limitations !== 'string'
    )
        throw new Error('Regional manifest invalid');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b.overlayJson)))]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
    if (hash !== b.payloadSha256) throw new Error('Regional checksum mismatch');
    const overlay = JSON.parse(b.overlayJson) as Overlay;
    if (!isOverlayPayload(overlay)) throw new Error('Regional collections missing');
    const counts = b.counts as Record<string, number>;
    let total = 0;
    for (const k of OVERLAY_FIELDS) {
        if (!counts || counts[k] !== overlay[k].features.length || (total += counts[k]) > 10_000)
            throw new Error('Regional inventory mismatch');
        overlay[k].features.forEach(validateFeature);
    }
    if (counts.berths < 100 || counts.water < 5 || counts.canalLines < 5)
        throw new Error('Regional inventory incomplete');
    const { overlayJson: _json, ...manifest } = b;
    return { ...manifest, overlay } as RegionalOverlay;
}

/** null means outside regional coverage: use the existing independent lookup,
 * never a partial regional result. An expired/corrupt covered region must fail. */
export function selectRegionalOverlay(data: RegionalOverlay, bbox: Bbox, now = Date.now()) {
    if (!validBbox(bbox) || bbox[0] === bbox[2] || bbox[1] === bbox[3]) throw new Error('Invalid regional query');
    if (!contains(data.coverage, bbox)) return null;
    const age = now - Date.parse(data.sourceAsOf);
    if (age < 0 || age >= REGIONAL_MAX_AGE_MS || Date.parse(data.generatedAt) > now + 300_000)
        throw new Error('Newport regional obstacle data requires refresh');
    const result = Object.fromEntries(
        OVERLAY_FIELDS.map((k) => [
            k,
            {
                type: 'FeatureCollection',
                features: data.overlay[k].features.filter((f) => intersects(f.bbox, bbox)),
            },
        ]),
    ) as Overlay;
    return {
        ...result,
        provenance: {
            region: data.region,
            coverage: data.coverage,
            sourceAsOf: data.sourceAsOf,
            sourceUrl: data.sourceUrl,
            payloadSha256: data.payloadSha256,
            attribution: data.attribution,
            licenseUrl: data.licenseUrl,
            limitations: data.limitations,
        },
    };
}
