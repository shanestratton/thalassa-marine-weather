/** Exact SevenCs hazard locating only. Never maps a feature index onto a leg,
 * replaces a line/area by a pretend hazard point, or modifies route geometry. */
import {
    snapshotProviderHazardGeometry,
    type AutoroutingProviderFinding,
    type ProviderHazardGeometry,
    type ProviderHazardPosition,
} from '../supabase/functions/_shared/autorouting-provider-check';

const MAX_MERCATOR_LAT = 85.05112878;
export interface ProviderHazardViewport {
    /** Camera bounds only, not an inferred danger geometry or centre location. */
    bounds: [ProviderHazardPosition, ProviderHazardPosition];
}

function positions(geometry: ProviderHazardGeometry): ProviderHazardPosition[] {
    if (geometry.type === 'Point') return [geometry.coordinates];
    if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates;
    if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates.flat();
    return geometry.coordinates.flat(2);
}

function mapGeometry(finding: AutoroutingProviderFinding): {
    geometry: ProviderHazardGeometry;
    viewport: ProviderHazardViewport;
} | null {
    if (
        finding.featureType === 'track' ||
        !Number.isSafeInteger(finding.featureIndex) ||
        finding.featureIndex < 0 ||
        finding.featureIndex >= 10_000 ||
        !['danger', 'caution'].includes(finding.severity)
    )
        return null;
    const geometry = snapshotProviderHazardGeometry(finding.geometry);
    if (!geometry) return null;
    const points = positions(geometry);
    // Do not clamp polar coordinates or wrap a dateline-crossing line/area into
    // a different shape. Keep those exact source reports readable, unlocated.
    if (points.some(([, lat]) => Math.abs(lat) > MAX_MERCATOR_LAT)) return null;
    const longitudes = points.map(([lon]) => lon),
        latitudes = points.map(([, lat]) => lat);
    const west = Math.min(...longitudes),
        east = Math.max(...longitudes);
    if (east - west > 180) return null;
    return {
        geometry,
        viewport: {
            bounds: [
                [west, Math.min(...latitudes)],
                [east, Math.max(...latitudes)],
            ],
        },
    };
}

/** One exact source feature; map layers must support points, lines AND polygon
 * fills/outlines, including multipart geometry and all polygon rings/holes. */
export function providerHazardMapFeature(finding: AutoroutingProviderFinding): GeoJSON.Feature | null {
    const located = mapGeometry(finding);
    if (!located) return null;
    return {
        type: 'Feature',
        id: `provider-feature-${finding.featureIndex}`,
        properties: {
            source: 'SevenCs',
            sourceFeatureIndex: finding.featureIndex,
            severity: finding.severity,
            featureType: finding.featureType ?? null,
            providerSeverity: finding.providerSeverity ?? null,
        },
        geometry: located.geometry,
    };
}

export function providerHazardViewport(finding: AutoroutingProviderFinding): ProviderHazardViewport | null {
    return mapGeometry(finding)?.viewport ?? null;
}
