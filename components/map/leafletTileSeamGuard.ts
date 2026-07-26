import type { Point, TileEvent, TileLayer } from 'leaflet';

/**
 * WebKit can leave a one-device-pixel gap between adjacent raster tiles when
 * Leaflet is using a fractional transform. The gap exposes the map container
 * background as a ruler-straight line. Overscanning each opaque base tile by
 * one CSS pixel makes neighbours overlap instead.
 *
 * This must be installed before the layer is added to a map so its initial
 * tiles are protected too. Keep it off transparent symbol overlays: their
 * edge pixels could otherwise double-render.
 */
export const LEAFLET_TILE_SEAM_OVERSCAN_PX = 1;

export function overscanLeafletTile(tile: HTMLImageElement, tileSize: Point): void {
    tile.style.width = `${tileSize.x + LEAFLET_TILE_SEAM_OVERSCAN_PX}px`;
    tile.style.height = `${tileSize.y + LEAFLET_TILE_SEAM_OVERSCAN_PX}px`;
}

export function installLeafletTileSeamGuard(layer: TileLayer): () => void {
    const guardTile = ({ tile }: TileEvent) => overscanLeafletTile(tile, layer.getTileSize());
    layer.on('tileloadstart', guardTile);
    return () => layer.off('tileloadstart', guardTile);
}
