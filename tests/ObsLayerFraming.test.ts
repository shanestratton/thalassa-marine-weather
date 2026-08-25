/**
 * The Obs page's layer framing and the Sky section's independence
 * (Shane 2026-08-24).
 *
 * Four asks, one mechanism:
 *   · rain opens at z7 (was z5 — a cell you care about was a smudge)
 *   · wind opens at z7 (was z9 — a harbour frame for a synoptic read)
 *   · every Sky layer toggles independently (they were mutually exclusive,
 *     so wind + rain — the obvious squall read — was impossible)
 *   · more than one layer up takes ONE shared frame, z7
 *
 * The last one only became necessary because of the third: once the Sky
 * layers can stack, per-layer frames disagree (pressure z2, cloud z4), and
 * whichever was tapped last would otherwise dictate the camera for the whole
 * stack.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    LAYER_FRAME_ZOOM,
    LAYER_MIN_ZOOM,
    MULTI_LAYER_FRAME_ZOOM,
    frameZoomForSelection,
    getActiveLayerFrameZoom,
    type WeatherLayer,
} from '../components/map/mapConstants';

const set = (...layers: WeatherLayer[]): ReadonlySet<WeatherLayer> => new Set(layers);

describe('single-layer framing', () => {
    it('opens rain at z7 and wind at z9', () => {
        // Wind returned to its z9 harbour frame 2026-08-25 ("back to 9").
        expect(LAYER_FRAME_ZOOM.rain).toBe(7);
        expect(LAYER_FRAME_ZOOM.wind).toBe(9);
        // 'velocity' is the legacy alias for the same particle engine; a save
        // stored under the old key must frame identically or the layer opens
        // at a different zoom depending on when the user first enabled it.
        expect(LAYER_FRAME_ZOOM.velocity).toBe(LAYER_FRAME_ZOOM.wind);
    });

    it('leaves wind able to pinch out to the synoptic view', () => {
        // The frame and the floor are independent, and conflating them once
        // pinned wind at exactly z9 with no way out (Shane 2026-08-22: "now
        // it is stuck at zoom 9"). Moving the frame must not move the floor.
        expect(LAYER_MIN_ZOOM.wind).toBe(3);
        expect(LAYER_MIN_ZOOM.wind).toBeLessThan(LAYER_FRAME_ZOOM.wind!);
    });

    it('still uses each layer’s own frame when it is the only one up', () => {
        expect(frameZoomForSelection(set('rain'), 'rain')).toBe(7);
        expect(frameZoomForSelection(set('pressure'), 'pressure')).toBe(LAYER_FRAME_ZOOM.pressure);
        expect(frameZoomForSelection(set('clouds'), 'clouds')).toBe(LAYER_FRAME_ZOOM.clouds);
    });
});

describe('multi-layer framing', () => {
    it('takes one shared frame regardless of which layer was tapped', () => {
        // The point: the answer cannot depend on tap order, or adding cloud to
        // wind would throw away the frame the skipper was working in.
        expect(frameZoomForSelection(set('wind', 'clouds'), 'clouds')).toBe(MULTI_LAYER_FRAME_ZOOM);
        expect(frameZoomForSelection(set('wind', 'clouds'), 'wind')).toBe(MULTI_LAYER_FRAME_ZOOM);
        expect(MULTI_LAYER_FRAME_ZOOM).toBe(7);
    });

    it('no longer lets pressure drag a stack to its z2 synoptic frame', () => {
        // Isobars stack on any host. Before the shared frame, adding them
        // yanked the camera from a harbour view out to z2.
        expect(frameZoomForSelection(set('wind', 'pressure'), 'pressure')).toBe(7);
        expect(LAYER_FRAME_ZOOM.pressure).toBeLessThan(7); // ...which is what it would have been
    });

    it('frames combinations that have no single-layer answer', () => {
        // cloud + temperature both sit at z4 alone; together they are a stack
        // and take the stack frame.
        expect(frameZoomForSelection(set('clouds', 'temperature'), 'temperature')).toBe(7);
    });

    it('agrees with getActiveLayerFrameZoom, which the recentre path uses', () => {
        // Two callers, one answer — MapHub frames on the toggle edge and
        // re-frames when the location box resolves. They must not disagree.
        expect(getActiveLayerFrameZoom(set('wind', 'rain'))).toBe(MULTI_LAYER_FRAME_ZOOM);
        expect(getActiveLayerFrameZoom(set('wind'))).toBe(LAYER_FRAME_ZOOM.wind);
        expect(getActiveLayerFrameZoom(set())).toBeUndefined();
    });
});

describe('the Sky section stacks', () => {
    const menu = readFileSync('components/map/RadialHelmMenu.tsx', 'utf8');
    const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
    const layers = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
    const sky = menu.slice(menu.indexOf("id: 'atmosphere'"), menu.indexOf('// ── Routes / charts'));

    it('gives every Sky entry a plain toggle', () => {
        for (const id of ['wind', 'rain', 'pressure', 'clouds', 'temperature']) {
            expect(sky, `${id} missing from Sky`).toContain(`id: '${id}'`);
        }
        // Mutual exclusion is what made wind + rain impossible.
        expect(sky).not.toContain('groupExclusive');
        expect(sky).not.toContain('ATMOSPHERE_LAYERS');
    });

    it('raises the cap high enough for all five to be on at once', () => {
        // A cap of 4 makes "turn them all on" silently impossible — the fifth
        // tap evicts one of the others, which reads as a broken toggle.
        const cap = /const MAX_LAYERS = (\d+);/.exec(layers)?.[1];
        expect(Number(cap)).toBeGreaterThanOrEqual(5);
    });

    it('centres the framing snap on the location box, not on a stale pan', () => {
        const effect = hub.slice(hub.indexOf('const prevSnapLayersRef'), hub.indexOf('const helmToggleLayer'));
        expect(effect).toContain('frameZoomForSelection');
        expect(effect).toContain('weatherCoordsRef.current');
        // Read through a ref on purpose: the effect depends only on the layer
        // set, so a captured location would go stale the moment the box moved.
        // Prose mentions are fine; what must not appear is a direct READ of
        // the captured value.
        const code = effect.replace(/\/\/[^\n]*/g, '');
        expect(code).not.toContain('weatherCoords.lat');
        expect(code).not.toContain('weatherCoords.lon');
    });
});
