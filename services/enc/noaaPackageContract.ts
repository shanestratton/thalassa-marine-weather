/** Public NOAA only. Parts contain complete original features, never clipped
 * geometry. This is a storage format, not a second chart or coverage claim. */
import type { EncConversionResult } from './types';

export const NOAA_PART_BYTES = 4 * 1024 * 1024;
export const NOAA_PACKAGE_BYTES = 128 * 1024 * 1024;
export const NOAA_PACKAGE_PARTS = 32;
/** Lead channel inference needs complete numbered-mark groups. This fixed
 * public-only dependency list is never supplied by a file or generic caller. */
export const noaaLeadDependency = (layer: string): boolean => layer === 'BOYLAT' || layer === 'BCNLAT';
export interface NoaaPartSpan {
    layer: string;
    first: number;
    count: number;
}
export interface NoaaPartObject {
    key: string;
    sha256: string;
    bytes: number;
    sequence: number;
    bbox: [number, number, number, number];
    spans: NoaaPartSpan[];
}
export interface NoaaPackage {
    kind: 'noaa-record-package';
    schema: 1;
    zipSha256: string;
    sourceSha256: string;
    metadata: Omit<EncConversionResult, 'layers'>;
    layers: Array<{ name: string; count: number; collection: Record<string, unknown> }>;
    parts: NoaaPartObject[];
    bytes: number;
    features: number;
}
export interface NoaaPart {
    kind: 'noaa-record-part';
    schema: 1;
    cellId: string;
    sequence: number;
    records: Array<NoaaPartSpan & { features: GeoJSON.Feature[] }>;
}
const SHA = /^[a-f0-9]{64}$/;
const LAYER = /^[A-Z][A-Z0-9_]{2,7}$/;
const fail = (): never => {
    throw Error('Invalid or incomplete NOAA record package.');
};
const obj = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
    return v as Record<string, unknown>;
};
const int = (v: unknown, max: number): v is number =>
    Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
export function noaaPartBounds(v: unknown): v is [number, number, number, number] {
    return (
        Array.isArray(v) &&
        v.length === 4 &&
        v.every(Number.isFinite) &&
        v[0] >= -180 &&
        v[2] <= 180 &&
        v[1] >= -90 &&
        v[3] <= 90 &&
        v[0] <= v[2] &&
        v[1] <= v[3]
    );
}
/** Inclusive: point/line records on a viewport edge must not disappear. */
export function noaaPartIntersects(a: readonly number[], b: readonly number[]): boolean {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
/** GeometryCollection/null geometry is retained conservatively. The bounded
 * input size limits traversal; no feature/property/bbox from the source is edited. */
export function noaaFeatureBounds(feature: unknown): [number, number, number, number] {
    const f = obj(feature);
    if (f.type !== 'Feature' || !('geometry' in f)) return fail();
    let x0 = 180,
        y0 = 90,
        x1 = -180,
        y1 = -90,
        positions = 0;
    const visit = (v: unknown, depth: number): void => {
        if (depth > 12 || !Array.isArray(v)) return fail();
        if (typeof v[0] === 'number') {
            if (v.length < 2 || !v.every(Number.isFinite) || v[0] < -180 || v[0] > 180 || v[1] < -90 || v[1] > 90)
                return fail();
            x0 = Math.min(x0, v[0]);
            x1 = Math.max(x1, v[0]);
            y0 = Math.min(y0, v[1]);
            y1 = Math.max(y1, v[1]);
            positions++;
        } else for (const c of v) visit(c, depth + 1);
    };
    const geometry = (v: unknown, depth: number): void => {
        if (depth > 8) return fail();
        if (v === null) return;
        const g = obj(v);
        if (g.type === 'GeometryCollection') {
            if (!Array.isArray(g.geometries)) return fail();
            for (const c of g.geometries) geometry(c, depth + 1);
        } else {
            if (
                !['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(
                    String(g.type),
                )
            )
                return fail();
            visit(g.coordinates, 0);
        }
    };
    geometry(f.geometry, 0);
    return positions ? [x0, y0, x1, y1] : [-180, -90, 180, 90];
}
export function parseNoaaPackage(value: unknown): NoaaPackage {
    const p = obj(value),
        m = obj(p.metadata);
    if (
        p.kind !== 'noaa-record-package' ||
        p.schema !== 1 ||
        typeof p.zipSha256 !== 'string' ||
        !SHA.test(p.zipSha256) ||
        typeof p.sourceSha256 !== 'string' ||
        !SHA.test(p.sourceSha256) ||
        typeof m.cellId !== 'string' ||
        !/^US[1-6][A-Z0-9]{5}$/.test(m.cellId) ||
        m.sourceHO !== 'US' ||
        !int(m.edition, 9999) ||
        m.edition === 0 ||
        !int(m.updateNumber, 9999) ||
        typeof m.issued !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(m.issued) ||
        !Number.isFinite(Date.parse(m.issued)) ||
        new Date(m.issued).toISOString().slice(0, 10) !== m.issued ||
        !noaaPartBounds(m.bbox) ||
        m.bbox[0] === m.bbox[2] ||
        m.bbox[1] === m.bbox[3] ||
        'layers' in m ||
        !Array.isArray(p.layers) ||
        p.layers.length === 0 ||
        p.layers.length > 96 ||
        !Array.isArray(p.parts) ||
        !p.parts.length ||
        p.parts.length > NOAA_PACKAGE_PARTS ||
        !int(p.bytes, NOAA_PACKAGE_BYTES) ||
        !int(p.features, 250000)
    )
        return fail();
    const counts = new Map<string, number>(),
        next = new Map<string, number>();
    for (const raw of p.layers) {
        const l = obj(raw),
            c = obj(l.collection);
        if (
            typeof l.name !== 'string' ||
            !LAYER.test(l.name) ||
            counts.has(l.name) ||
            !int(l.count, 250000) ||
            c.type !== 'FeatureCollection' ||
            'features' in c
        )
            return fail();
        counts.set(l.name, l.count);
        next.set(l.name, 0);
    }
    let bytes = 0,
        features = 0;
    const hashes = new Set<string>();
    for (let i = 0; i < p.parts.length; i++) {
        const part = obj(p.parts[i]);
        if (
            part.sequence !== i ||
            typeof part.sha256 !== 'string' ||
            !SHA.test(part.sha256) ||
            hashes.has(part.sha256) ||
            part.key !== `objects/${part.sha256}.json` ||
            !int(part.bytes, NOAA_PART_BYTES) ||
            part.bytes === 0 ||
            !noaaPartBounds(part.bbox) ||
            !Array.isArray(part.spans) ||
            !part.spans.length ||
            part.spans.length > 96
        )
            return fail();
        hashes.add(part.sha256);
        bytes += part.bytes;
        const layersInPart = new Set<string>();
        for (const raw of part.spans) {
            const s = obj(raw);
            if (
                typeof s.layer !== 'string' ||
                layersInPart.has(s.layer) ||
                !counts.has(s.layer) ||
                s.first !== next.get(s.layer) ||
                !int(s.count, 250000) ||
                s.count === 0
            )
                return fail();
            const end = (s.first as number) + s.count;
            if (end > counts.get(s.layer)!) return fail();
            layersInPart.add(s.layer);
            next.set(s.layer, end);
            features += s.count;
        }
    }
    if (bytes !== p.bytes || features !== p.features || [...counts].some(([l, n]) => next.get(l) !== n)) return fail();
    return p as unknown as NoaaPackage;
}
export function parseNoaaPart(value: unknown, manifest: NoaaPackage, descriptor: NoaaPartObject): NoaaPart {
    const p = obj(value);
    if (
        p.kind !== 'noaa-record-part' ||
        p.schema !== 1 ||
        p.cellId !== manifest.metadata.cellId ||
        p.sequence !== descriptor.sequence ||
        !Array.isArray(p.records) ||
        p.records.length !== descriptor.spans.length
    )
        return fail();
    for (let i = 0; i < p.records.length; i++) {
        const r = obj(p.records[i]),
            s = descriptor.spans[i];
        if (
            r.layer !== s.layer ||
            r.first !== s.first ||
            r.count !== s.count ||
            !Array.isArray(r.features) ||
            r.features.length !== s.count
        )
            return fail();
        for (const feature of r.features) {
            const b = noaaFeatureBounds(feature);
            if (
                b[0] < descriptor.bbox[0] ||
                b[1] < descriptor.bbox[1] ||
                b[2] > descriptor.bbox[2] ||
                b[3] > descriptor.bbox[3]
            )
                return fail();
        }
    }
    return p as unknown as NoaaPart;
}
