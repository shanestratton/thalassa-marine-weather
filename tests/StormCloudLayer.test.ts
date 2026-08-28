/**
 * The storm view's cloud, and the stepper that sometimes wasn't there
 * (Shane 2026-08-24).
 *
 * 1. The satellite overlay is replaced by the SAME world cloud layer the Sky
 *    section serves. GIBS Himawari Band 13 is satellite IMAGERY being asked to
 *    behave like an overlay: measured 2026-08-23 it was RGBA with alpha 255 on
 *    100% of sampled pixels, so it could only be shown through a raster-color
 *    ramp that manufactured alpha from brightness. OpenWeatherMap clouds_new,
 *    measured 2026-08-24 on a z3 Coral Sea tile: colour type 6, 35% of sampled
 *    pixels at alpha 0 and NOT ONE at 255 — a real overlay, so the ramp goes.
 *
 * 2. The storm stepper returned null below two storms and was built when a
 *    storm was SELECTED, which on a cold open beats the cyclone list loading.
 *    Whether you got one came down to that race.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLOUD_DENSITY, CLOUD_OPACITY } from '../components/map/cloudOverlay';

const squall = readFileSync('components/map/useSquallMap.ts', 'utf8');
const overlay = readFileSync('components/map/cloudOverlay.ts', 'utf8');
const cyclone = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
/** The mount body, comments stripped — the squall precip layer has a ramp of
 *  its own that must not be mistaken for the cloud's paint. */
const cloudMount = overlay
    .slice(overlay.indexOf('export function mountCloudOverlay'), overlay.indexOf('Put the overlay back'))
    .replace(/\/\/[^\n]*/g, '');

describe('storm cloud layer', () => {
    it('serves the Sky section’s cloud tiles, not a satellite product', () => {
        expect(overlay).toContain("getTileUrl('clouds')");
        // The GIBS request builder and its date parameter are gone — the URL
        // used to go stale at UTC midnight.
        expect(overlay).not.toContain('Himawari_AHI_Band13_Clean_Infrared');
        expect(overlay).not.toContain('wmts.cgi');
        expect(overlay).not.toContain('todayDateStr');
    });

    it('drops the luminance ramp that only existed for an opaque tile', () => {
        expect(cloudMount).not.toContain('raster-color');
        expect(cloudMount).not.toContain('raster-color-mix');
        expect(cloudMount).toContain("'raster-opacity'");
    });

    it('reaches past the precip layer instead of stopping short of it', () => {
        // GIBS capped at z6 while precip runs to z8, so cloud was the half
        // that stopped sharpening first. Read from TILE_SOURCE_MAX_ZOOM rather
        // than restated, so the Sky layer and the storm page cannot drift.
        expect(overlay).toContain("tileSourceMaxZoom('clouds')");
        expect(overlay).not.toContain('GIBS_MAX_ZOOM');
    });

    it('keeps the OWM credential behind the shared server tile proxy', () => {
        const constants = readFileSync('components/map/mapConstants.ts', 'utf8');
        expect(constants).toContain('`${API_BASE}/owm-tile`');
        expect(constants).toContain('&z={z}&x={x}&y={y}');
        expect(constants).not.toContain('VITE_OWM_API_KEY');
        expect(constants).not.toContain('appid=');
    });
});

describe('storm switcher first-run race', () => {
    it('re-checks the stepper whenever fresh cyclone data lands', () => {
        // refreshStormCardInPlace rebuilds the BADGE wrapper only, and returns
        // early when the badge signature is unchanged — so a storm list
        // arriving late moved neither it nor the stepper beside it.
        expect(cyclone).toContain('export function ensureStormSwitcher');
        const refreshSite = cyclone.slice(cyclone.indexOf('refreshStormCardInPlace(map.getContainer()'));
        expect(refreshSite.slice(0, 500)).toContain('ensureStormSwitcher');
    });

    it('is idempotent, and rebuilds only on a real change', () => {
        const fn = cyclone.slice(
            cyclone.indexOf('export function ensureStormSwitcher'),
            cyclone.indexOf('export function createStormSwitcher'),
        );
        // A signature covering the storm set AND the selection: re-running on
        // every 10-minute refresh must not churn the DOM under the user's
        // finger, but stepping to another storm must update the bar.
        expect(fn).toContain('stormSwitcherSignature');
        expect(fn).toContain('existing.dataset.stormSwitcher ===');
        // Down to one storm, the bar is removed — a stepper with nowhere to
        // step is a dead control.
        expect(fn).toContain('existing?.remove()');
    });
});

/**
 * ONE cloud implementation, not two.
 *
 * The 2026-08-24 swap converted useSquallMap and missed useCycloneLayer
 * entirely, so the storm page kept showing satellite IR while the squall page
 * showed cloud — because "the storm page's cloud" was two subsystems wearing
 * one description. The duplication is now deleted rather than kept in step by
 * hand, and this is the tripwire.
 */
describe('one shared cloud overlay', () => {
    it('leaves the cyclone view with no satellite imagery at all', () => {
        expect(cyclone).toContain('mountCloudOverlay');
        expect(cyclone).not.toContain('addSatelliteLayer');
        expect(cyclone).not.toContain('bestProductForBasin');
        // The dynamic import is gone too, so nothing pulls the service in.
        expect(cyclone).not.toContain('SatelliteImageryService');
    });

    it('routes the squall page through the same helper', () => {
        expect(squall).toContain('mountCloudOverlay');
        // Its private copy of the ids and the URL builder are gone.
        expect(squall).not.toContain("'squall-ir-source'");
        expect(squall).not.toContain('buildCloudTileUrl');
    });

    it('doubles the cloud from ONE source, so it costs no extra tiles', () => {
        // Mapbox fetches per SOURCE, not per layer — the second pass is one
        // extra composite of tiles already in memory, which is what makes
        // "double it" free on a marine link.
        const mount = overlay.slice(overlay.indexOf('export function mountCloudOverlay'));
        const sources = [...mount.matchAll(/map\.addSource\(/g)];
        const layers = [...mount.matchAll(/map\.addLayer\(/g)];
        expect(sources).toHaveLength(1);
        expect(layers).toHaveLength(2);
        expect(mount).toContain('source: CLOUD_OVERLAY_SOURCE');
    });

    it('cannot fog the chart, however many passes it paints', () => {
        // 1-(1-a)^2 is still 0 at a=0. Clear sky stays clear no matter what
        // CLOUD_DENSITY is set to — which is the property that makes doubling
        // safe on an overlay at all.
        expect(CLOUD_DENSITY).toBeLessThanOrEqual(2);
        expect(CLOUD_OPACITY).toBeGreaterThan(0);
        expect(CLOUD_OPACITY).toBeLessThanOrEqual(1);
        // No ramp anywhere — the alpha is the tile's own. Prose mentions in
        // the header explain WHY there isn't one, so strip block comments too.
        const code = overlay.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(code).not.toContain('raster-color');
    });

    it('tears the second pass down before the source it shares', () => {
        // Mapbox refuses to remove a source that still has layers on it, so a
        // teardown that forgot the doubling pass would leak the source and
        // make the next mount throw.
        const rm = overlay.slice(
            overlay.indexOf('export function removeCloudOverlay'),
            overlay.indexOf('Mount the world cloud'),
        );
        expect(rm.indexOf('CLOUD_OVERLAY_LAYER_2')).toBeLessThan(rm.indexOf('removeSource'));
        expect(rm).toContain('removeSource');
    });
});
