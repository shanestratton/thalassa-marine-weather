import { validateAnnotationLibrary, type AnnotationLibrary } from './model';
const xml = (s: string) =>
    s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
/** XSD decimal forbids exponent notation; expand round-trippable text without rounding. */
function decimal(value: number): string {
    const text = value.toString();
    if (!text.includes('e')) return text;
    const [coefficient, power] = text.split('e'),
        negative = coefficient.startsWith('-'),
        unsigned = negative ? coefficient.slice(1) : coefficient,
        digits = unsigned.replace('.', ''),
        point = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(power),
        sign = negative ? '-' : '';
    return point <= 0
        ? sign + '0.' + '0'.repeat(-point) + digits
        : point >= digits.length
          ? sign + digits + '0'.repeat(point - digits.length)
          : sign + digits.slice(0, point) + '.' + digits.slice(point);
}
function bounded(text: string) {
    if (new TextEncoder().encode(text).length > 1024 * 1024)
        throw Error('Export exceeds 1 MiB. Export a smaller drawing library.');
    return text;
}
/** Exact supported geometry; no simplified coordinates, fabricated depths, route or safety authority. */
export function annotationsGeoJSON(input: AnnotationLibrary): string {
    const library = validateAnnotationLibrary(input);
    return bounded(
        JSON.stringify(
            {
                type: 'FeatureCollection',
                features: library.annotations.map((r) => ({
                    type: 'Feature',
                    id: r.id,
                    properties: { name: r.label, annotationRevision: r.revision, source: 'user drawing' },
                    geometry: r.geometry,
                })),
            },
            null,
            2,
        ),
    );
}
/** GPX 1.1 has waypoints and tracks, not polygon semantics. Refuse the whole export instead of dropping areas. */
export function annotationsGPX(input: AnnotationLibrary): string {
    const library = validateAnnotationLibrary(input);
    if (library.annotations.some((r) => r.geometry.type === 'Polygon'))
        throw Error('GPX cannot preserve an area. Use GeoJSON for this library.');
    if (
        library.annotations.some((r) =>
            (r.geometry.type === 'Point'
                ? [r.geometry.coordinates]
                : r.geometry.type === 'LineString'
                  ? r.geometry.coordinates
                  : []
            ).some((p) => p[0] === 180),
        )
    )
        throw Error('GPX excludes longitude +180. Use GeoJSON to preserve this drawing exactly.');
    const points = library.annotations
        .filter((r) => r.geometry.type === 'Point')
        .map((r) => {
            if (r.geometry.type !== 'Point') return '';
            const [lon, lat] = r.geometry.coordinates;
            return `<wpt lat="${decimal(lat)}" lon="${decimal(lon)}"><name>${xml(r.label)}</name><type>user annotation</type></wpt>`;
        })
        .join('\n');
    const lines = library.annotations
        .filter((r) => r.geometry.type === 'LineString')
        .map((r) => {
            if (r.geometry.type !== 'LineString') return '';
            return `<trk><name>${xml(r.label)}</name><desc>User annotation; not a checked route.</desc><trkseg>${r.geometry.coordinates.map(([lon, lat]) => `<trkpt lat="${decimal(lat)}" lon="${decimal(lon)}"/>`).join('')}</trkseg></trk>`;
        })
        .join('\n');
    return bounded(
        `<?xml version="1.0" encoding="UTF-8"?>\n<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Thalassa"><metadata><name>Private chart annotations</name><desc>User-created reference geometry; not official charts or checked routes.</desc></metadata>${points}${lines}</gpx>`,
    );
}
