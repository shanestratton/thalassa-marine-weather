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

const squall = readFileSync('components/map/useSquallMap.ts', 'utf8');
/** mountSatelliteLayerNow's body, comments stripped — the precip layer later
 *  in the file has a ramp of its own that must not be mistaken for this one. */
const cloudMount = squall
    .slice(squall.indexOf('function mountSatelliteLayerNow'), squall.indexOf('/**', squall.indexOf('function mountSatelliteLayerNow')))
    .replace(/\/\/[^\n]*/g, '');
const cyclone = readFileSync('components/map/useCycloneLayer.ts', 'utf8');

describe('storm cloud layer', () => {
    it('serves the Sky section’s cloud tiles, not a satellite product', () => {
        expect(squall).toContain("getTileUrl('clouds')");
        // The GIBS request builder and its date parameter are gone — the URL
        // used to go stale at UTC midnight.
        expect(squall).not.toContain('Himawari_AHI_Band13_Clean_Infrared');
        expect(squall).not.toContain('wmts.cgi');
        expect(squall).not.toContain('todayDateStr');
    });

    it('drops the luminance ramp that only existed for an opaque tile', () => {
        expect(cloudMount).not.toContain('raster-color');
        expect(cloudMount).not.toContain('raster-color-mix');
        expect(cloudMount).toContain("'raster-opacity'");
    });

    it('reaches past the precip layer instead of stopping short of it', () => {
        // GIBS capped at z6 while precip runs to z8, so cloud stopped
        // sharpening halfway up the usable range.
        expect(squall).toContain("tileSourceMaxZoom('clouds')");
        expect(squall).not.toContain('GIBS_MAX_ZOOM');
    });

    it('says so and bails when the build has no OWM key', () => {
        // Same dark state as the Sky layer — a configuration fact, not a
        // fault, and better than mounting a source that can never paint.
        expect(cloudMount).toContain('buildCloudTileUrl()');
        expect(cloudMount).toMatch(/if \(!tiles\)/);
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
