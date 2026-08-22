/**
 * "it says they are there, but i cannot see them" (Shane 2026-08-23).
 *
 * TWO independent reasons, either of which alone made the strikes invisible.
 *
 * 1. THE ANCHOR — the third layer in this app caught guessing "the style's
 *    first symbol layer". useMapInit adds the opaque satellite raster with
 *    beforeId = encBottom, and an undefined encBottom APPENDS IT TO THE TOP,
 *    so with satellite lit all four lightning layers could sit underneath it.
 *    Same root cause as both cloud layers, found the same week.
 *
 * 2. THE GLYPH — the bolt was the ⚡ character in a `text-field`. Mapbox does
 *    not rasterise text with device fonts: it fetches SDF glyph ranges from
 *    the style's `glyphs` endpoint, and emoji are not in the standard Mapbox
 *    font stacks. A missing glyph draws nothing, silently. The comment in the
 *    file asserted the opposite ("iOS's built-in emoji fonts handle the
 *    rasterising") for four months.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { alertOverlayBeforeId, cloudOverlayBeforeId } from '../components/map/imageryOrder';

const src = readFileSync('components/map/useLightningLayer.ts', 'utf8');
const L = (...ids: string[]) => ids.map((id) => ({ id, type: /label|^place-/.test(id) ? 'symbol' : 'raster' }));

describe('alertOverlayBeforeId', () => {
    it('clears the ENC chart as well as the imagery', () => {
        // A cloud belongs UNDER the chart; a strike does not. It is a
        // ten-minute event and it is worthless with a depth fill over it.
        const layers = L('background', 'satellite-base-layer', 'enc-vec-depare', 'enc-vec-soundg', 'place-city');
        expect(alertOverlayBeforeId(layers)).toBe('place-city');
        // …which is deliberately HIGHER than where a cloud goes.
        expect(cloudOverlayBeforeId(layers)).toBe('enc-vec-depare');
    });

    it('goes to the top when the chart is the topmost thing', () => {
        // undefined => append. Correct for a handful of small transient marks.
        expect(alertOverlayBeforeId(L('background', 'satellite-base-layer', 'enc-vec-depare'))).toBeUndefined();
    });

    it('still clears imagery when no ENC is loaded', () => {
        // Open ocean, chart not yet merged — the case that hid them.
        expect(alertOverlayBeforeId(L('background', 'satellite-base-layer', 'place-city'))).toBe('place-city');
    });

    it('is a no-op ladder on a bare style', () => {
        expect(alertOverlayBeforeId(L('background', 'water'))).toBeUndefined();
    });
});

describe('the lightning layer uses it', () => {
    it('no longer guesses the first symbol layer', () => {
        expect(src).toContain('alertOverlayBeforeId(styleLayers)');
        const mount = src.slice(src.indexOf('const styleLayers ='), src.indexOf('LIGHTNING_LAYER_SHOCKWAVE,'));
        expect(mount).not.toContain("find((l) => l.type === 'symbol')");
    });
});

describe('the bolt is drawn, not typed', () => {
    it('renders a registered icon rather than a text glyph', () => {
        const bolt = src.slice(src.indexOf('id: LIGHTNING_LAYER_BOLT'), src.indexOf('beforeId,', src.indexOf('id: LIGHTNING_LAYER_BOLT')));
        expect(bolt).toContain("'icon-image': BOLT_ICON");
        expect(bolt).toContain("'icon-opacity': ['get', 'alpha']");
        // The glyph path must be gone entirely — a stray text-field would
        // re-introduce the font dependency.
        expect(bolt).not.toContain('text-field');
        expect(src).not.toContain("'text-field': '⚡'");
    });

    it('registers the icon SYNCHRONOUSLY, before the layer that references it', () => {
        // An <img>/SVG round trip is async, and a symbol layer pointing at an
        // image that has not landed renders nothing while Mapbox logs
        // "could not be loaded" per tile — the exact state the chart's
        // seamark icons are in. Canvas paths avoid the race by construction.
        const fn = src.slice(src.indexOf('function registerBoltIcon'), src.indexOf('/** Compute alpha for a strike'));
        expect(fn).toContain('getContext');
        expect(fn).toContain('map.addImage(BOLT_ICON');
        expect(fn).not.toContain('await');
        expect(fn).not.toContain('new Image');
        // Called before the bolt layer is added.
        expect(src.indexOf('registerBoltIcon(map)')).toBeLessThan(src.indexOf('id: LIGHTNING_LAYER_BOLT'));
        // Idempotent, and a style reload clears images so the mount re-runs.
        expect(fn).toContain('map.hasImage(BOLT_ICON)');
    });

    it('degrades to the circle layers if the icon cannot be made', () => {
        // A missing icon should cost the bolt, not the strike.
        const fn = src.slice(src.indexOf('function registerBoltIcon'), src.indexOf('/** Compute alpha for a strike'));
        expect(fn).toContain('catch');
        expect(fn).toContain('strikes still paint');
    });
});

describe('the crater', () => {
    it('scorches the ground and leaves an ember rim', () => {
        expect(src).toContain('LIGHTNING_LAYER_CRATER');
        expect(src).toContain('LIGHTNING_LAYER_RIM');
        const crater = src.slice(src.indexOf('id: LIGHTNING_LAYER_CRATER'), src.indexOf('id: LIGHTNING_LAYER_RIM'));
        expect(crater).toContain('#1a1005');
        // Never fully opaque — a strike is information, not an occlusion.
        expect(crater).toContain("['*', 0.7, ['get', 'alpha']]");
        const rim = src.slice(src.indexOf('id: LIGHTNING_LAYER_RIM'), src.indexOf('id: LIGHTNING_LAYER_HIT'));
        expect(rim).toContain("'circle-color': 'rgba(0,0,0,0)'");
        expect(rim).toContain('circle-stroke-color');
    });

    it('fades with the strike and is torn down with it', () => {
        // Every lightning layer keys opacity off `alpha`, so the whole mark
        // ages as one thing rather than leaving a scar behind.
        const crater = src.slice(src.indexOf('id: LIGHTNING_LAYER_CRATER'), src.indexOf('id: LIGHTNING_LAYER_HIT'));
        expect(crater).toContain("['get', 'alpha']");
        const teardown = src.slice(src.indexOf('strikesRef.current.clear();'));
        expect(teardown).toContain('removeLayer(LIGHTNING_LAYER_CRATER)');
        expect(teardown).toContain('removeLayer(LIGHTNING_LAYER_RIM)');
    });

    it('sits under the bolt and over the halo', () => {
        // Later addLayer with the same beforeId lands on top, so source order
        // IS paint order here: halo → crater → rim → core → bolt.
        const order = ['LIGHTNING_LAYER_HALO', 'LIGHTNING_LAYER_CRATER', 'LIGHTNING_LAYER_RIM', 'LIGHTNING_LAYER_HIT', 'LIGHTNING_LAYER_BOLT'].map(
            (id) => src.indexOf(`id: ${id},`),
        );
        expect(order.every((n) => n > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
});
