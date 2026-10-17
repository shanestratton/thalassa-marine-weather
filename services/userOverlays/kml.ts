/** KML's fixed WGS84 geometry only. No NetworkLink, external resources or XML entities. */
export function kmlToGeoJSON(text: string): unknown {
    if (new TextEncoder().encode(text).length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text))
        throw Error('KML must be at most 1 MiB without XML declarations/entities.');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName !== 'kml')
        throw Error('Invalid KML document.');
    if (
        [...doc.getElementsByTagName('*')].some((n) =>
            ['NetworkLink', 'Link', 'Url', 'GroundOverlay', 'PhotoOverlay', 'Model', 'Track', 'MultiTrack'].includes(
                n.localName,
            ),
        )
    )
        throw Error('Linked, image, model and track KML resources are unsupported; export geometry only.');
    const children = (n: Element, tag: string) => [...n.children].filter((c) => c.localName === tag);
    const coordinates = (n: Element) => {
        const raw = children(n, 'coordinates')[0]?.textContent?.trim();
        if (!raw) throw Error('KML geometry has no coordinates.');
        return raw.split(/\s+/).map((p) => {
            const parts = p.split(',');
            if (
                parts.length < 2 ||
                parts.length > 3 ||
                parts.some((x) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(x))
            )
                throw Error('Invalid KML coordinate.');
            return parts.map(Number);
        });
    };
    const shape = (n: Element, depth = 0): unknown => {
        if (depth > 4) throw Error('KML geometry nesting is too deep.');
        if (n.localName === 'Point') {
            const c = coordinates(n);
            if (c.length !== 1) throw Error('Invalid KML Point.');
            return { type: 'Point', coordinates: c[0] };
        }
        if (n.localName === 'LineString') return { type: 'LineString', coordinates: coordinates(n) };
        if (n.localName === 'Polygon') {
            const outer = children(n, 'outerBoundaryIs');
            if (outer.length !== 1) throw Error('KML Polygon needs one outer ring.');
            return {
                type: 'Polygon',
                coordinates: [...outer, ...children(n, 'innerBoundaryIs')].map((b) => {
                    const rings = children(b, 'LinearRing');
                    if (rings.length !== 1) throw Error('Invalid KML boundary.');
                    return coordinates(rings[0]);
                }),
            };
        }
        if (n.localName === 'MultiGeometry')
            return { type: 'GeometryCollection', geometries: [...n.children].map((c) => shape(c, depth + 1)) };
        throw Error('Unsupported KML geometry.');
    };
    const features = [...doc.getElementsByTagName('*')]
        .filter((n) => n.localName === 'Placemark')
        .map((n) => {
            const shapes = [...n.children].filter((c) =>
                ['Point', 'LineString', 'Polygon', 'MultiGeometry'].includes(c.localName),
            );
            if (shapes.length !== 1) throw Error('Each KML placemark needs one supported geometry.');
            return {
                type: 'Feature',
                properties: { name: children(n, 'name')[0]?.textContent ?? '' },
                geometry: shape(shapes[0]),
            };
        });
    return { type: 'FeatureCollection', features };
}
