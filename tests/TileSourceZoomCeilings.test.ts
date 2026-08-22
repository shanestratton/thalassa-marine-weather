/**
 * "Check that both of those layers are optimised for speeeeeeeeeed" (Shane
 * 2026-08-23, temperature and clouds).
 *
 * They were not. Every raster tile source sat at maxzoom 18, so Mapbox kept
 * requesting NATIVE tiles past the point where the provider has any more data
 * — and tile count quadruples per zoom level, so a z12 view fetched 64 tiles
 * where one z9 tile stretched locally is visually identical. On cellular that
 * is 64 round trips against 1.
 *
 * Measured on OpenWeatherMap clouds_new, one location, 2026-08-23:
 *   z4 71 kB · z6 40 kB · z9 6.5 kB · z10 1.8 kB · z12 1.5 kB
 * The content collapses past z9, which is where OWM documents its weather
 * rasters ending.
 *
 * The codebase already knew this rule — RAINVIEWER_NATIVE_MAX_ZOOM exists for
 * exactly it — the OWM layers had simply never been given the same treatment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LAYER_FRAME_ZOOM, TILE_SOURCE_MAX_ZOOM, tileSourceMaxZoom } from '../components/map/mapConstants';

describe('raster tile source ceilings', () => {
    it('caps the OpenWeatherMap layers at their real data resolution', () => {
        expect(tileSourceMaxZoom('temperature')).toBe(9);
        expect(tileSourceMaxZoom('clouds')).toBe(9);
    });

    it('does NOT cap OpenSeaMap seamarks — that detail is real all the way in', () => {
        // The one layer here a skipper reads at berthing zoom. Capping it to
        // save requests would blur exactly the marks that matter most.
        expect(tileSourceMaxZoom('sea')).toBe(18);
    });

    it('defaults to full depth for anything unlisted', () => {
        // A new layer must not be silently throttled by omission; capping is
        // a decision made per provider, with evidence.
        expect(tileSourceMaxZoom('pressure')).toBe(18);
        expect(TILE_SOURCE_MAX_ZOOM.pressure).toBeUndefined();
    });

    it('is actually applied to the source, not just declared', () => {
        const src = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
        const addSource = src.slice(src.indexOf('map.addSource(tileId, {'), src.indexOf('map.addSource(tileId, {') + 500);
        expect(addSource).toContain('maxzoom: tileSourceMaxZoom(tl)');
        expect(addSource).not.toContain('maxzoom: 18');
    });

    it('keeps smooth resampling, which is what makes the cap invisible', () => {
        // The paint already asked for linear resampling "when Mapbox
        // overzooms past OWM's source maxzoom" — describing behaviour that
        // maxzoom:18 was preventing. With the cap in place that comment is
        // finally true, and it is what stops the saving looking like a loss.
        const src = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
        expect(src).toContain("'raster-resampling': 'linear'");
    });

    it('opens temperature and clouds at z4, inside native range', () => {
        expect(LAYER_FRAME_ZOOM.temperature).toBe(4);
        expect(LAYER_FRAME_ZOOM.clouds).toBe(4);
        // Framing a layer beyond its own source ceiling would open it on an
        // upscale — real data on arrival is the point.
        expect(LAYER_FRAME_ZOOM.temperature!).toBeLessThanOrEqual(tileSourceMaxZoom('temperature'));
        expect(LAYER_FRAME_ZOOM.clouds!).toBeLessThanOrEqual(tileSourceMaxZoom('clouds'));
    });
});
