import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TileEvent, TileLayer } from 'leaflet';
import { describe, expect, it, vi } from 'vitest';
import { LEAFLET_TILE_SEAM_OVERSCAN_PX, installLeafletTileSeamGuard } from '../components/map/leafletTileSeamGuard';

const liveMiniMapSource = readFileSync(resolve(process.cwd(), 'components/LiveMiniMap.tsx'), 'utf8');
const trackMapViewerSource = readFileSync(resolve(process.cwd(), 'components/TrackMapViewer.tsx'), 'utf8');
const globalStyles = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');

describe('LiveMiniMap tile compositing', () => {
    it('scopes normal tile compositing and an overlap guard to both Log maps', () => {
        expect(liveMiniMapSource).toContain('thalassa-log-leaflet-map live-mini-map w-full');
        expect(trackMapViewerSource).toContain('thalassa-log-leaflet-map absolute inset-0');
        expect(globalStyles).toMatch(
            /\.thalassa-log-leaflet-map\.leaflet-container img\.leaflet-tile\s*\{\s*image-rendering: auto;\s*mix-blend-mode: normal;/,
        );
        expect(liveMiniMapSource).toContain('installLeafletTileSeamGuard(satelliteBase);');
        expect(liveMiniMapSource).not.toContain('installLeafletTileSeamGuard(seamark');
        expect(trackMapViewerSource.match(/installLeafletTileSeamGuard\(base\);/g)).toHaveLength(2);
        expect(trackMapViewerSource).not.toContain('installLeafletTileSeamGuard(seamark');
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
