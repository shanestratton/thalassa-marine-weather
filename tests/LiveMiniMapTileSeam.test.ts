import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TileEvent, TileLayer } from 'leaflet';
import { describe, expect, it, vi } from 'vitest';
import { LEAFLET_TILE_SEAM_OVERSCAN_PX, installLeafletTileSeamGuard } from '../components/map/leafletTileSeamGuard';

const liveMiniMapSource = readFileSync(resolve(process.cwd(), 'components/LiveMiniMap.tsx'), 'utf8');
const trackMapViewerSource = readFileSync(resolve(process.cwd(), 'components/TrackMapViewer.tsx'), 'utf8');
const sightingsMapSource = readFileSync(resolve(process.cwd(), 'components/sightings/SightingsMap.tsx'), 'utf8');
const globalStyles = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');

describe('Log map tile compositing', () => {
    it('keeps the Leaflet seam guard on the Sightings map; both Log maps left Leaflet for Mapbox', () => {
        // 125-13a and 125-13b: the little and the big Log maps are Mapbox GL on
        // Relief + Sat. Their seamless sea is drawn under the opaque water
        // fill, so they have no tile seams to guard and no Leaflet left to
        // guard them with.
        for (const source of [liveMiniMapSource, trackMapViewerSource])
            expect(source).not.toMatch(
                /from 'leaflet'|leaflet\/dist|thalassa-log-leaflet-map|installLeafletTileSeamGuard/,
            );
        expect(liveMiniMapSource).toContain("import('./LiveMiniMapGL')");
        expect(trackMapViewerSource).toContain("import('./TrackMapViewerGL')");
        // The Sightings map is still Leaflet on the Log page's own tiles, and
        // keeps the guard on its one opaque base layer.
        expect(sightingsMapSource).toContain('thalassa-log-leaflet-map absolute inset-0');
        expect(globalStyles).toMatch(
            /\.thalassa-log-leaflet-map\.leaflet-container img\.leaflet-tile\s*\{\s*image-rendering: auto;\s*mix-blend-mode: normal;/,
        );
        expect(sightingsMapSource.match(/installLeafletTileSeamGuard\(base\);/g)).toHaveLength(1);
    });

    it('overscans each opaque base tile by one pixel before it can expose the container background', () => {
        let tileLoadStart: ((event: TileEvent) => void) | undefined;
        const layer = {
            getTileSize: () => ({ x: 256, y: 256 }),
            on: vi.fn((_event: string, handler: (event: TileEvent) => void) => {
                tileLoadStart = handler;
            }),
            off: vi.fn(),
        } as unknown as TileLayer;

        const detach = installLeafletTileSeamGuard(layer);
        expect(layer.on).toHaveBeenCalledWith('tileloadstart', expect.any(Function));

        const tile = document.createElement('img');
        if (!tileLoadStart) throw new Error('Expected tile seam guard to subscribe before tiles load.');
        tileLoadStart({ tile } as TileEvent);

        expect(tile.style.width).toBe(`${256 + LEAFLET_TILE_SEAM_OVERSCAN_PX}px`);
        expect(tile.style.height).toBe(`${256 + LEAFLET_TILE_SEAM_OVERSCAN_PX}px`);

        detach();
        expect(layer.off).toHaveBeenCalledWith('tileloadstart', expect.any(Function));
    });
});
