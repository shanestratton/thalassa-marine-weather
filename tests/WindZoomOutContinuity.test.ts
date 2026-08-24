/**
 * Zooming out must flow, not blink (Shane 2026-08-22: "when i zoom out, it is
 * a little jerky, can we make it so that it flows nicely and does not show any
 * blank areas?").
 *
 * Two separate causes, both fixed here:
 *
 *  1. BLANK. keepRenderedGrid demanded boundsCover(), so zooming out past the
 *     current grid cleared the field to black for the whole wide fetch — 3140
 *     ms of it on Shane's device, because the wide grid is the slowest fetch
 *     there is. That rule was written when a clear lasted one quick fetch.
 *
 *  2. JERK. Every setGrid called respawnAllParticles(), teleporting all 9000
 *     particles — and a zoom-out publishes two or three times in a row
 *     (cached synoptic, then the refined fetch), so the reset was visible
 *     several times per gesture.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { boundsOverlap } from '../services/weather/WindDataController';

const ctrl = readFileSync('services/weather/WindDataController.ts', 'utf8');
const layer = readFileSync('components/map/WindParticleLayer.ts', 'utf8');

describe('zoom-out continuity', () => {
    it('keeps a partial field rendered rather than clearing to black', () => {
        const decl = ctrl.slice(ctrl.indexOf('const keepRenderedGrid'), ctrl.indexOf('if (!beginWindGridLoad'));
        expect(decl).toContain('!isCacheStale(lastFetchedBounds)');
        // Full COVERAGE is no longer required — that requirement was the blank.
        expect(decl).not.toContain('boundsCover(');
    });

    it('still clears when the view moves somewhere the old field does not belong', () => {
        // The safety half. Zooming out retains a field that is merely
        // incomplete; panning CLEAN AWAY would paint Brisbane's wind over
        // Indonesia, which is wrong rather than partial — and wrong wind on a
        // chart is a hazard, not a rough edge.
        const decl = ctrl.slice(ctrl.indexOf('const keepRenderedGrid'), ctrl.indexOf('if (!beginWindGridLoad'));
        expect(decl).toContain('boundsOverlap(lastFetchedBounds, visibleBounds)');
    });

    it('still refuses STALE wind — incomplete is tolerable, out-of-date is not', () => {
        const decl = ctrl.slice(ctrl.indexOf('const keepRenderedGrid'), ctrl.indexOf('if (!beginWindGridLoad'));
        expect(decl).toContain('isCacheStale');
        expect(decl).toContain('WindStore.getState().grid');
    });

    it('leaves boundsCover doing its real job in the cache lookup', () => {
        // Relaxing the RENDER rule must not relax which cached grid may be
        // published as covering the viewport.
        const lookup = ctrl.slice(
            ctrl.indexOf('function bestCoveringGrid'),
            ctrl.indexOf('function bestCoveringGrid') + 600,
        );
        expect(lookup).toContain('boundsCover(entry.bounds, viewport)');
    });

    it('carries particles across a bounds change instead of respawning them all', () => {
        expect(layer).toContain('remapParticlesAcrossBounds(prevBounds)');
        const fn = layer.slice(
            layer.indexOf('private remapParticlesAcrossBounds'),
            layer.indexOf('private advectParticles'),
        );
        // Normalised coords mean the same 0..1 pair is a different PLACE on a
        // different grid — the conversion through lon/lat is the whole point.
        expect(fn).toContain('prev.west + data[off] * prevLon');
        expect(fn).toContain('(lon - gb.west) / newLon');
        // The whole trail, not just the head, or trails stretch between two
        // coordinate systems and streak across the screen for a frame.
        expect(fn).toContain('for (let t = 0; t < TRAIL_LENGTH; t++)');
    });

    it('falls back to a clean respawn when there is no previous grid to map from', () => {
        const fn = layer.slice(
            layer.indexOf('private remapParticlesAcrossBounds'),
            layer.indexOf('private advectParticles'),
        );
        expect(fn).toContain('if (!prev || prevLon <= 0 || prevLat <= 0 || newLon <= 0 || newLat <= 0)');
        expect(fn).toContain('this.respawnAllParticles();');
    });

    it('surfaces the synoptic warm at a level prod can actually see', () => {
        // It is the thing that prevents the zoom-out gap; logging it at info
        // meant no device log could ever confirm it had run.
        const warm = ctrl.slice(ctrl.indexOf('async function prefetchSynopticGrid'), ctrl.indexOf('Monotonic fence'));
        expect(warm).toContain('log.warn');
        expect(warm).toContain('[perf] wind synoptic warm ready');
    });

    it('boundsOverlap: overlapping keeps, disjoint clears, Date Line handled', () => {
        const bris = { north: -26, south: -28, west: 152, east: 154 };
        // Zoomed out around the same water — overlaps, so the field is kept.
        expect(boundsOverlap(bris, { north: -20, south: -34, west: 146, east: 160 })).toBe(true);
        // Panned clean away to Indonesia — disjoint, so it must clear.
        expect(boundsOverlap(bris, { north: 0, south: -10, west: 100, east: 110 })).toBe(false);
        // Touching edge counts as overlap; a shared boundary is still shared water.
        expect(boundsOverlap(bris, { north: -28, south: -30, west: 152, east: 154 })).toBe(true);
        // Same camera spelled either side of the Date Line must not read as a
        // world-wide pan (the 179…-179 trap boundsCover already guards).
        const fiji = { north: -16, south: -18, west: 178, east: 180.5 };
        expect(boundsOverlap(fiji, { north: -16, south: -18, west: 179, east: -179 })).toBe(true);
    });
});
