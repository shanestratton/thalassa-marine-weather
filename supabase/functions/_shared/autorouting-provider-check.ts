/** Shared, pure provider-report classification. A lack of findings is NOT clearance. */
export type ProviderHazardPosition = [number, number];
export type ProviderHazardGeometry =
    | { type: 'Point'; coordinates: ProviderHazardPosition }
    | { type: 'MultiPoint'; coordinates: ProviderHazardPosition[] }
    | { type: 'LineString'; coordinates: ProviderHazardPosition[] }
    | { type: 'MultiLineString'; coordinates: ProviderHazardPosition[][] }
    | { type: 'Polygon'; coordinates: ProviderHazardPosition[][] }
    | { type: 'MultiPolygon'; coordinates: ProviderHazardPosition[][][] };

/** Over-budget source geometry remains in raw GeoJSON and its warning stays
 * readable; it is never truncated into a different, apparently exact hazard. */
export const PROVIDER_HAZARD_MAX_VERTICES = 2_048;
export const PROVIDER_HAZARD_MAX_TOTAL_VERTICES = 10_000;
export const PROVIDER_HAZARD_MAX_PROPERTIES = 32;
const MAX_PROPERTY_KEY_LENGTH = 80;
const MAX_PROPERTY_VALUE_LENGTH = 512;
type ProviderScalar = string | number | boolean | null;
export interface ProviderHazardProvenance {
    source: 'SevenCs GeoJSON';
    /** Exact primitive source properties, not guessed schema aliases. Render as text only. */
    properties: Record<string, ProviderScalar>;
    /** Keys that were oversized, non-scalar, unsafe or beyond the metadata budget. */
    omittedPropertyCount: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = (key: string) =>
    key.length > 0 && key.length <= MAX_PROPERTY_KEY_LENGTH &&
    !['__proto__', 'prototype', 'constructor'].includes(key);
const safeScalar = (value: unknown): value is ProviderScalar =>
    value === null || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= MAX_PROPERTY_VALUE_LENGTH);

function sourceProvenance(properties: Record<string, unknown>): ProviderHazardProvenance {
    const retained: Array<[string, ProviderScalar]> = [];
    let omittedPropertyCount = 0;
    for (const [key, value] of Object.entries(properties)) {
        if (retained.length < PROVIDER_HAZARD_MAX_PROPERTIES && safeKey(key) && safeScalar(value)) {
            retained.push([key, value]);
        } else omittedPropertyCount++;
    }
    return { source: 'SevenCs GeoJSON', properties: Object.fromEntries(retained), omittedPropertyCount };
}

/** Exact, independent GeoJSON type/coordinate copy. No interpolation, dropping
 * malformed vertices, ring closing, reordering or coordinate wrapping. */
export function snapshotProviderHazardGeometry(value: unknown): ProviderHazardGeometry | null {
    if (!record(value)) return null;
    const depths: Record<string, number> = {
        Point: 0,
        MultiPoint: 1,
        LineString: 1,
        MultiLineString: 2,
        Polygon: 2,
        MultiPolygon: 3,
    };
    if (typeof value.type !== 'string' || !Object.hasOwn(depths, value.type)) return null;
    let remaining = PROVIDER_HAZARD_MAX_VERTICES;
    const walk = (coordinates: unknown, depth: number): unknown => {
        if (!Array.isArray(coordinates) || !coordinates.length || coordinates.length > PROVIDER_HAZARD_MAX_VERTICES) {
            throw new Error('Invalid geometry');
        }
        if (depth === 0) {
            if (
                --remaining < 0 || coordinates.length !== 2 ||
                typeof coordinates[0] !== 'number' || !Number.isFinite(coordinates[0]) ||
                Math.abs(coordinates[0]) > 180 ||
                typeof coordinates[1] !== 'number' || !Number.isFinite(coordinates[1]) || Math.abs(coordinates[1]) > 90
            ) throw new Error('Invalid position');
            return [coordinates[0], coordinates[1]];
        }
        return Array.from(coordinates, (child) => walk(child, depth - 1));
    };
    try {
        const geometry = {
            type: value.type,
            coordinates: walk(value.coordinates, depths[value.type]),
        } as ProviderHazardGeometry;
        const validLine = (line: ProviderHazardPosition[], ring = false) =>
            line.length >= (ring ? 4 : 2) &&
            (!ring || (line[0][0] === line.at(-1)![0] && line[0][1] === line.at(-1)![1]));
        if (geometry.type === 'LineString' && !validLine(geometry.coordinates)) return null;
        if (geometry.type === 'MultiLineString' && !geometry.coordinates.every((line) => validLine(line))) return null;
        if (geometry.type === 'Polygon' && !geometry.coordinates.every((ring) => validLine(ring, true))) return null;
        if (
            geometry.type === 'MultiPolygon' &&
            !geometry.coordinates.every((polygon) => polygon.every((ring) => validLine(ring, true)))
        ) return null;
        return geometry;
    } catch {
        return null;
    }
}

/** Intended only for already bounded geometry snapshots. */
export function providerHazardVertexCount(geometry: ProviderHazardGeometry): number {
    if (geometry.type === 'Point') return 1;
    if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates.length;
    if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') {
        return geometry.coordinates.reduce((total, line) => total + line.length, 0);
    }
    return geometry.coordinates.reduce(
        (total, polygon) => total + polygon.reduce((sum, ring) => sum + ring.length, 0),
        0,
    );
}

export interface AutoroutingProviderFinding {
    /** Zero-based index in the original provider FeatureCollection, not a route leg. */
    featureIndex: number;
    featureType?: string;
    /** Preserve the provider's original severity, separate from conservative UI classification. */
    providerSeverity?: string;
    /** Exact original hazard geometry only. A route-level unsafe track is NOT a hazard locator. */
    geometry?: ProviderHazardGeometry;
    provenance?: ProviderHazardProvenance;
    severity: 'danger' | 'caution';
    message: string;
}

export interface AutoroutingProviderCheck {
    status: 'unsafe' | 'caution' | 'not-reported';
    findings: AutoroutingProviderFinding[];
}

export function providerCheckSummary(findings: AutoroutingProviderFinding[]): AutoroutingProviderCheck {
    let remaining = PROVIDER_HAZARD_MAX_TOTAL_VERTICES;
    const boundedFindings = findings.map((finding) => {
        if (!finding.geometry) return finding;
        const count = providerHazardVertexCount(finding.geometry);
        if (count <= remaining) {
            remaining -= count;
            return finding;
        }
        // Preserve the complete finding and original source; only decline a
        // locator beyond the aggregate drawing budget. Never thin its geometry.
        const { geometry: _geometry, ...unlocated } = finding;
        return unlocated;
    });
    return {
        status: findings.some((finding) => finding.severity === 'danger')
            ? 'unsafe'
            : findings.length
            ? 'caution'
            : 'not-reported',
        findings: boundedFindings,
    };
}

/** Validate optional normalized fields at the client boundary. Null means
 * malformed supplied metadata, not permission to manufacture a locator. */
export function snapshotProviderFindingDetails(
    value: unknown,
): Pick<AutoroutingProviderFinding, 'geometry' | 'provenance'> | null {
    if (!record(value)) return null;
    const result: Pick<AutoroutingProviderFinding, 'geometry' | 'provenance'> = {};
    if (value.geometry !== undefined) {
        if (value.featureType === 'track') return null;
        const geometry = snapshotProviderHazardGeometry(value.geometry);
        if (!geometry) return null;
        result.geometry = geometry;
    }
    if (value.provenance !== undefined) {
        const provenance = value.provenance;
        if (
            !record(provenance) || provenance.source !== 'SevenCs GeoJSON' || !record(provenance.properties) ||
            !Number.isSafeInteger(provenance.omittedPropertyCount) || (provenance.omittedPropertyCount as number) < 0
        ) return null;
        const properties = Object.entries(provenance.properties);
        if (
            properties.length > PROVIDER_HAZARD_MAX_PROPERTIES ||
            !properties.every(([key, item]) => safeKey(key) && safeScalar(item))
        ) return null;
        result.provenance = {
            source: 'SevenCs GeoJSON',
            properties: Object.fromEntries(properties) as Record<string, ProviderScalar>,
            omittedPropertyCount: provenance.omittedPropertyCount as number,
        };
    }
    return result;
}

/** Keep the exact checker message alongside its severity; never infer a leg
 * from a feature index (the collection also contains points and areas). */
export function providerFeatureFinding(
    properties: Record<string, unknown>,
    featureIndex: number,
    sourceGeometry?: unknown,
): AutoroutingProviderFinding | null {
    if (properties.safe !== undefined && typeof properties.safe !== 'boolean') {
        throw new Error('Invalid provider safety value');
    }
    const type = typeof properties.type === 'string' ? properties.type : '';
    const providerSeverity = typeof properties.severity === 'string' ? properties.severity : undefined;
    const knownSeverity = providerSeverity !== undefined && ['Info', 'Warning', 'Danger'].includes(providerSeverity);
    if (properties.safe !== false && !/danger|warning|restriction|obstruction|hazard/i.test(type) && !knownSeverity) {
        return null;
    }
    // SevenCs 'danger' is a feature kind; severity Info/Warning is NOT a danger.
    // Missing/unknown severity on a hazard remains unresolved, never silently clear.
    const danger = properties.safe === false ||
        (knownSeverity ? providerSeverity === 'Danger' : /danger|obstruction|hazard/i.test(type));
    const severityLabel = providerSeverity ? `severity ${providerSeverity}` : undefined;
    const uncertainty = danger && properties.safe !== false && !knownSeverity
        ? (properties.severity === undefined
            ? 'severity not supplied — unresolved hazard'
            : 'unrecognised severity — unresolved hazard')
        : undefined;
    const label = [
        properties.type,
        severityLabel,
        properties.name,
        properties.class,
        properties.description,
        properties.message,
        uncertainty,
    ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' · ');
    const geometry = type !== 'track' ? snapshotProviderHazardGeometry(sourceGeometry) : null;
    return {
        featureIndex,
        ...(type ? { featureType: type } : {}),
        ...(providerSeverity ? { providerSeverity } : {}),
        ...(geometry ? { geometry } : {}),
        provenance: sourceProvenance(properties),
        severity: danger ? 'danger' : 'caution',
        message: `Provider check feature ${featureIndex + 1}${properties.safe === false ? ' (unsafe)' : ''}: ${
            label || 'reported unsafe'
        }. Review the original checker output before use.`,
    };
}
