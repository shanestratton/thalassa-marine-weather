/**
 * RainViewer's public Weather Maps contract.
 *
 * Keep these values centralised: the chart, embedded map, and dashboard used
 * to drift onto different zoom ceilings and retired colour palettes.
 */
export const RAINVIEWER_TILE_HOST = 'https://tilecache.rainviewer.com';
export const RAINVIEWER_NATIVE_MAX_ZOOM = 7;
export const RAINVIEWER_COLOR_SCHEME = 2;
export const RAINVIEWER_MAP_TILE_SIZE = 512;

type TileCoordinate = number | string;

export interface RainViewerTileOptions {
    host?: string;
    size?: 256 | 512;
    zoom: TileCoordinate;
    x: TileCoordinate;
    y: TileCoordinate;
}

/**
 * Accept only RainViewer-owned HTTPS hosts from the provider index response.
 * A malformed or unexpectedly redirected index falls back to the documented
 * tile host instead of turning image loads into an arbitrary URL fetch.
 */
export function normalizeRainViewerHost(host?: string): string {
    if (!host) return RAINVIEWER_TILE_HOST;
    try {
        const parsed = new URL(host);
        const hostname = parsed.hostname.toLowerCase();
        if (parsed.protocol === 'https:' && (hostname === 'rainviewer.com' || hostname.endsWith('.rainviewer.com'))) {
            return parsed.origin;
        }
    } catch {
        // Fall through to the documented host.
    }
    return RAINVIEWER_TILE_HOST;
}

/** Build one current-contract RainViewer radar tile URL. */
export function buildRainViewerTileUrl(framePath: string, options: RainViewerTileOptions): string {
    const host = normalizeRainViewerHost(options.host);
    const size = options.size ?? RAINVIEWER_MAP_TILE_SIZE;
    return `${host}${framePath}/${size}/${options.zoom}/${options.x}/${options.y}/${RAINVIEWER_COLOR_SCHEME}/1_1.png`;
}
