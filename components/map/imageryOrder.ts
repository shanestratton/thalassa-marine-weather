/**
 * imageryOrder — where the opaque base imagery sits in the style.
 *
 * Pure, React-free and mapbox-free on purpose: TWO subsystems mount an
 * infrared cloud raster over this map — useSquallMap's NASA GIBS layer and
 * SatelliteImageryService's RealEarth layer, driven by useCycloneLayer — and
 * both must anchor against the SAME reference or one of them ends up under an
 * opaque satellite tile, painting perfectly and visible to nobody.
 *
 * Why not 'the first symbol layer', which is what both used to do: that is not
 * a stable landmark in this style. The imagery raster is added with
 * `beforeId = encBottom` (useMapInit), which APPENDS TO THE TOP whenever no
 * `enc-vec-*` layer exists yet — open ocean at low zoom, exactly where the
 * storm view lives. MapHub's ordering pass then demotes it, but only once
 * encBottom is defined. So "above the first symbol layer" means above the
 * imagery on one open and below it on the next, which is precisely the
 * intermittency Shane reported on 2026-08-23.
 */

/** The opaque bases a cloud overlay must sit above to be seen at all. */
export const IMAGERY_LAYER_IDS = ['satellite-base-layer', 'hybrid-base-layer', 'maptiler-ocean-layer'] as const;

/** Highest index among the opaque base-imagery layers, or -1 if none are up. */
export function imageryTopIndex(layers: readonly { id: string }[]): number {
    return IMAGERY_LAYER_IDS.map((id) => layers.findIndex((l) => l.id === id)).reduce((hi, i) => Math.max(hi, i), -1);
}

/**
 * The `beforeId` that puts a cloud overlay immediately ABOVE the imagery and
 * below the chart.
 *
 * Falls back to the ENC stack, then the first symbol layer, when no imagery is
 * lit — identical to the old behaviour in that case, so a plain chart view is
 * unchanged. Deliberately NOT the top of the stack: if a layer's own paint
 * fails to make clear sky transparent, the chart still draws over it and the
 * failure is cosmetic rather than a blanked map.
 */
export function cloudOverlayBeforeId(layers: readonly { id: string; type?: string }[]): string | undefined {
    const idx = imageryTopIndex(layers);
    if (idx >= 0 && idx + 1 < layers.length) return layers[idx + 1].id;
    return (layers.find((l) => l.id.startsWith('enc-vec-')) ?? layers.find((l) => l.type === 'symbol'))?.id;
}
