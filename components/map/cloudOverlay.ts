/**
 * cloudOverlay — ONE cloud layer, shared by every page that shows cloud.
 *
 * WHY THIS FILE EXISTS. There were two independent cloud implementations and
 * they went out of sync the moment either changed:
 *
 *   · useSquallMap mounted NASA GIBS Himawari Band 13 as `squall-ir-layer`
 *   · useCycloneLayer mounted SatelliteImageryService's IEM/RealEarth IR,
 *     picking a product per storm basin
 *
 * On 2026-08-24 Shane asked for the storm page's satellite to become the Sky
 * menu's cloud layer. The squall half was converted and the cyclone half was
 * missed entirely — the storm page still showed satellite IR, because "the
 * storm page's cloud" was two different subsystems wearing the same
 * description. StormCloudAndSwitcher.test.ts had already flagged the risk in
 * so many words ("two subsystems that anchor differently is how one of them
 * ended up under an opaque satellite tile"); the second implementation is now
 * deleted rather than kept in step by hand.
 *
 * WHAT IT SERVES. OpenWeatherMap `clouds_new` — the same tiles the Sky
 * section's `clouds` WeatherLayer uses, read through getTileUrl so the URL and
 * the key live in exactly one place. That matters beyond tidiness: it is a
 * true overlay, and the products it replaced were not.
 *
 *   GIBS Himawari Band 13, measured 2026-08-23 (z3 Coral Sea, 76 080 B):
 *     RGBA, alpha 255 on 100% of sampled pixels. Clear sky is mid-grey, not
 *     transparent — so it could only be shown by ramping alpha out of
 *     luminance, and three separate "the satellite still isn't showing"
 *     reports came from trying to fix it by re-anchoring instead.
 *   OWM clouds_new, measured 2026-08-24 (z3 Coral Sea, 90 810 B):
 *     RGBA, 35% of sampled pixels at alpha 0 and NOT ONE at 255.
 *
 * So this needs no raster-color ramp, no date parameter to go stale at UTC
 * midnight, and no per-basin product selection.
 *
 * ONE ID ON PURPOSE. Squall and cyclone are mutually exclusive in the radial
 * menu, but they have overlapped in practice before — tapping a storm spinner
 * while a squall mount was armed produced two IR layers, "one of them nobody
 * asked for". Sharing an id makes that impossible by construction: mounting is
 * idempotent, so the second caller replaces rather than stacks.
 */
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { getTileUrl, tileSourceMaxZoom } from './mapConstants';

const log = createLogger('CloudOverlay');

export const CLOUD_OVERLAY_SOURCE = 'world-cloud-source';
export const CLOUD_OVERLAY_LAYER = 'world-cloud-layer';
/** The doubling pass. Same source, so it costs no tiles — see CLOUD_DENSITY. */
export const CLOUD_OVERLAY_LAYER_2 = 'world-cloud-layer-2';

/**
 * HOW DENSE THE CLOUD READS (Shane 2026-08-24: "can we have a double layer of
 * the clouds… it looks awesome and very defined").
 *
 * Two passes of the SAME source. This is free in the only way that matters on
 * a marine link: Mapbox fetches tiles per SOURCE, not per layer, so the second
 * pass adds no requests, no bytes and no latency — it is one extra composite
 * of tiles already in memory.
 *
 * What it actually does. Painting alpha `a` over itself resolves to
 * 1 − (1 − a)², which stretches the middle of the range far more than the
 * ends:
 *
 *     thin  a 0.15 → 0.28      mid   a 0.50 → 0.75
 *     light a 0.30 → 0.51      thick a 0.90 → 0.99
 *
 * So wispy cloud gains a lot, solid tops gain almost nothing, and the STRUCTURE
 * between them separates — which is what reads as "defined". Crucially clear
 * sky is a 0, and 1 − (1 − 0)² is still 0, so doubling cannot fog the chart:
 * the transparency that makes this a usable overlay survives untouched.
 *
 * Tuning, in order of what to reach for first:
 *   · CLOUD_DENSITY 1 → back to a single pass.
 *   · CLOUD_OPACITY down (0.6-0.7) → lighter overall, structure preserved.
 *   · CLOUD_OPACITY up (1.0) → as heavy as this tile can paint.
 * Opacity scales the whole curve; density changes its SHAPE. For "darker but
 * still readable" reach for opacity; for "more defined" reach for density.
 */
export const CLOUD_DENSITY: 1 | 2 = 2;
/** Per-pass opacity. Two passes at 0.85 sit a little under one at 1.0 for
 *  solid tops, while pulling thin cloud up hard — the point of the exercise. */
export const CLOUD_OPACITY = 0.85;

/** Remove the overlay if present. Safe to call when it never mounted. */
export function removeCloudOverlay(map: mapboxgl.Map): void {
    try {
        // Layers before the source they share, or Mapbox refuses the removal.
        if (map.getLayer(CLOUD_OVERLAY_LAYER_2)) map.removeLayer(CLOUD_OVERLAY_LAYER_2);
        if (map.getLayer(CLOUD_OVERLAY_LAYER)) map.removeLayer(CLOUD_OVERLAY_LAYER);
        if (map.getSource(CLOUD_OVERLAY_SOURCE)) map.removeSource(CLOUD_OVERLAY_SOURCE);
    } catch (err) {
        // Mid-teardown the style can already be gone; that is not a fault.
        log.debug('cloud overlay removal skipped', err);
    }
}

/**
 * Mount the world cloud overlay, replacing any existing copy.
 *
 * `beforeId` should come from cloudOverlayBeforeId() so the cloud sits above
 * the base imagery and below the chart. Anchoring below the chart is
 * deliberate: if anything about the raster is ever wrong, the chart still
 * paints over it and the failure is cosmetic rather than a blanked map.
 *
 * Returns false when the build has no OpenWeatherMap key — the same dark state
 * the Sky menu's cloud layer has, and a configuration fact rather than a fault.
 */
export function mountCloudOverlay(map: mapboxgl.Map, beforeId?: string): boolean {
    const tiles = getTileUrl('clouds');
    if (!tiles) {
        log.warn('Cloud overlay unavailable — no OpenWeatherMap key in this build');
        return false;
    }
    removeCloudOverlay(map);
    try {
        map.addSource(CLOUD_OVERLAY_SOURCE, {
            type: 'raster',
            tiles: [tiles],
            tileSize: 256,
            // z9 is OWM's documented ceiling for its weather rasters, and it
            // clears the squall precip layer's own z8 — so cloud is never the
            // half that stops sharpening first, which GIBS was at z6.
            maxzoom: tileSourceMaxZoom('clouds'),
        });
        const paint = {
            // No raster-color ramp: the tile carries real alpha, and ramping it
            // would fight transparency that is already correct. See the
            // measurements in this file's header.
            'raster-opacity': CLOUD_OPACITY,
            // Zero, and it matters more with two passes: a cross-fade would run
            // the two layers out of step during a zoom and briefly show one
            // pass over the other, which flickers.
            'raster-fade-duration': 0,
            // A smooth field that is now overzoomed past native rather than
            // hard-capped, so linear is the honest resampling.
            'raster-resampling': 'linear',
        } as const;
        map.addLayer({ id: CLOUD_OVERLAY_LAYER, type: 'raster', source: CLOUD_OVERLAY_SOURCE, paint }, beforeId);
        if (CLOUD_DENSITY === 2) {
            // Same source — no extra tiles. Anchored to the same beforeId so
            // both passes stay above the imagery and below the chart.
            map.addLayer({ id: CLOUD_OVERLAY_LAYER_2, type: 'raster', source: CLOUD_OVERLAY_SOURCE, paint }, beforeId);
        }
        return true;
    } catch (err) {
        log.warn('Cloud overlay mount failed', err);
        return false;
    }
}

/**
 * Put the overlay back above the imagery if something buried it.
 *
 * A cloud layer under an opaque satellite base is invisible, which reads to
 * the user as "not there" — and MapHub's ordering pass relocates layers when
 * imagery is lit, so this is a real state rather than a theoretical one.
 */
export function liftCloudOverlay(map: mapboxgl.Map, beforeId?: string): void {
    try {
        // Order matters: move the base pass first, then the doubling pass, so
        // they end up adjacent rather than with chart layers sandwiched between.
        if (map.getLayer(CLOUD_OVERLAY_LAYER)) map.moveLayer(CLOUD_OVERLAY_LAYER, beforeId);
        if (map.getLayer(CLOUD_OVERLAY_LAYER_2)) map.moveLayer(CLOUD_OVERLAY_LAYER_2, beforeId);
    } catch (err) {
        log.debug('cloud overlay lift skipped', err);
    }
}
