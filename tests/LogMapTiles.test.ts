import { describe, expect, it } from 'vitest';
import { logBaseTiles } from '../components/map/logMapTiles';

/**
 * The Log page's Leaflet maps were on Esri World Imagery while the rest of the
 * app rendered Mapbox satellite-streets — older imagery, non-retina, and no
 * place labels. They now follow the same tiles as the OBS chart.
 *
 * The assertions that matter are the licence one and the fallback: attribution
 * must track whichever source actually drew the tiles (crediting Esri on a
 * Mapbox tile is a licence breach in both directions), and a build with no
 * token must still draw a map rather than a grey void.
 */
describe('log map base tiles', () => {
    it('uses retina satellite-streets when a Mapbox token is present', () => {
        const tiles = logBaseTiles('pk.test-token');
        expect(tiles.isMapbox).toBe(true);
        expect(tiles.url).toContain('satellite-streets-v12');
        // @2x on 512px tiles is the whole point — this is what makes it sharp
        // on a phone rather than the soft upscale Esri gave.
        expect(tiles.url).toContain('/512/{z}/{x}/{y}@2x');
        expect(tiles.url).toContain('access_token=pk.test-token');
        expect(tiles.maxZoom).toBeGreaterThan(19);
    });

    it('falls back to Esri when no token is configured', () => {
        for (const token of [undefined, '', '   ']) {
            const tiles = logBaseTiles(token);
            expect(tiles.isMapbox).toBe(false);
            expect(tiles.url).toContain('arcgisonline.com');
            expect(tiles.url).not.toContain('access_token');
        }
    });

    it('credits the source that actually drew the tiles', () => {
        const mapbox = logBaseTiles('pk.test-token');
        expect(mapbox.attribution).toMatch(/Mapbox/);
        expect(mapbox.attribution).toMatch(/OpenStreetMap/);
        expect(mapbox.attribution).not.toMatch(/Esri/);

        const esri = logBaseTiles(undefined);
        expect(esri.attribution).toMatch(/Esri/);
        expect(esri.attribution).not.toMatch(/Mapbox/);
    });

    it('never leaks a token into the attribution string', () => {
        expect(logBaseTiles('pk.super-secret').attribution).not.toContain('pk.super-secret');
    });
});
