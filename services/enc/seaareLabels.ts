/**
 * seaareLabels — reduce named-area polygons (SEAARE waterways, named LNDARE
 * islands) to ONE label point per name, for the chart's name ink.
 *
 * Lifted out of the buildMergedVectorData merge fold (mission audit: the
 * ~540-line god-function is the hardest-to-test surface). Pure — the caller
 * passes the accumulator map; nothing here touches merge/loop state — so the
 * label-anchor geometry and the SCAMIN-relaxing name ladder are unit-testable
 * away from the grounding-critical tagAndPush loop, which stays whole.
 */
import type { Feature, FeatureCollection } from 'geojson';

/**
 * Label anchor for a named area: the coordinate for a Point, else the
 * outer-ring vertex AVERAGE of the largest polygon (a curving river's true
 * centroid can drift off-axis; the vertex mean reads on the water). Returns
 * null for unusable geometry.
 */
export function labelAnchorFor(g: Feature['geometry']): [number, number] | null {
    if (!g) return null;
    if (g.type === 'Point') {
        const c = g.coordinates as number[];
        return Number.isFinite(c?.[0]) && Number.isFinite(c?.[1]) ? [c[0], c[1]] : null;
    }
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    let ring: number[][] | null = null;
    for (const poly of polys) {
        const outer = poly?.[0] as number[][] | undefined;
        if (outer && outer.length >= 4 && (!ring || outer.length > ring.length)) ring = outer;
    }
    if (!ring) return null;
    let sx = 0;
    let sy = 0;
    const n = ring.length - 1; // skip the closing duplicate vertex
    for (let i = 0; i < n; i++) {
        sx += ring[i][0];
        sy += ring[i][1];
    }
    return [sx / n, sy / n];
}

/**
 * Reduce a named-area collection to one label point per OBJNAM, accumulating
 * into `into` keyed `{kind}:{name}` (finest-cell-wins across the merge — a
 * later, finer cell overwrites a coarser one's label for the same name).
 *
 * SCAMIN gates the 1:90k channel/bank names to ~z12.6 ("need to be at zoom 13
 * to see any names… a bit high", Shane 2026-07-14). Same doctrine as the
 * sounding ladder: SCAMIN is paper declutter advice, not law. Keep the
 * hierarchy (bay names before bank names) but pull the whole ladder ~2.5
 * levels earlier; collision handles the density.
 */
export function reduceNamedAreas(
    fc: FeatureCollection | undefined,
    kind: 'water' | 'land',
    into: Map<string, Feature>,
): void {
    for (const feat of fc?.features ?? []) {
        const g = feat?.geometry;
        if (!g) continue;
        const props = (feat.properties ?? {}) as Record<string, unknown>;
        const rawName = props.OBJNAM ?? props.objnam;
        const name = typeof rawName === 'string' ? rawName.trim() : '';
        if (!name) continue;
        const anchor = labelAnchorFor(g);
        if (!anchor) continue;
        const labelProps: Record<string, unknown> = { _name: name, _kind: kind };
        if (typeof props._minZoom === 'number') {
            labelProps._minZoom = Math.max(7, props._minZoom - 2.5);
        }
        into.set(`${kind}:${name}`, {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: anchor },
            properties: labelProps,
        });
    }
}
