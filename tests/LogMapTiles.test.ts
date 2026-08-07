import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('Pi tile passthrough wrapping', () => {
    /**
     * The wrapped template goes into Leaflet, and the Pi reads `url` off its
     * OWN query string. A raw upstream template that carries `?access_token=`
     * therefore truncates at the '?', the Pi fetches a tokenless Mapbox URL,
     * gets 401, and every tile returns empty — a white map with perfectly good
     * attribution printed underneath it. Esri has no query string, which is
     * why this only surfaced when the Log maps moved to Mapbox.
     */
    const wrap = (template: string, contentType = 'image/png'): string => {
        const encoded = encodeURIComponent(template).replace(/%7B([zxy])%7D/gi, (_m, axis) => `{${axis}}`);
        return `https://pi.local:3001/api/passthrough-tile?url=${encoded}&ttl=1800000&ct=${encodeURIComponent(contentType)}`;
    };

    it('keeps an upstream query string inside the url parameter', () => {
        const wrapped = wrap('https://api.mapbox.com/styles/v1/a/b/tiles/512/{z}/{x}/{y}@2x?access_token=pk.SECRET');
        const params = new URL(wrapped).searchParams;
        expect(params.get('url')).toContain('access_token=pk.SECRET');
        // The token must NOT have become a parameter of the passthrough itself.
        expect(params.get('access_token')).toBeNull();
    });

    it('leaves the Leaflet placeholders substitutable', () => {
        // Encoded as %7Bz%7D they would be sent to Mapbox literally.
        const wrapped = wrap('https://api.mapbox.com/x/{z}/{x}/{y}@2x?access_token=pk.SECRET');
        expect(wrapped).toContain('{z}');
        expect(wrapped).toContain('{x}');
        expect(wrapped).toContain('{y}');
        expect(wrapped).not.toContain('%7B');
    });

    it('carries the real content type — satellite tiles are JPEG', () => {
        // The Pi stamps the cached response with this; image/png on a JPEG
        // tile caches and serves a lie.
        expect(new URL(wrap('https://x/{z}/{x}/{y}', 'image/jpeg')).searchParams.get('ct')).toBe('image/jpeg');
    });

    it('matches what PiCacheService actually builds', () => {
        // Pin the real implementation against the shape asserted above.
        const source = readFileSync(join(process.cwd(), 'services/PiCacheService.ts'), 'utf8');
        const fn = source.slice(source.indexOf('leafletTileTemplate('));
        const body = fn.slice(0, fn.indexOf('\n    }'));
        expect(body).toContain('encodeURIComponent(originalTemplate)');
        expect(body).toMatch(/%7B\(\[zxy\]\)%7D/);
        expect(body).not.toMatch(/url=\$\{originalTemplate\}/);
    });
});
