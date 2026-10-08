/**
 * logMap — the Log page's maps on Relief + Sat, in Mapbox GL (125-13a: the
 * little live map, components/LiveMiniMapGL.tsx; 125-13b reuses this for the
 * big track map). Shane 2026-10-09: "on the log page, can we replace the
 * little and the big map with our relief + sat ?? remove the old satellite
 * map".
 *
 * WHAT IT DRAWS. Mapbox dark-v11 with reliefBase inside it, exactly as Obs
 * draws its 'reliefSat' base: our seafloor relief at sea, satellite imagery on
 * land only, under the opaque water fill, so photo seams at sea never show.
 * Nothing here forks the style: addReliefBase, seaBaseLayers and
 * setReliefPalette do it, and hideBaseClutter is the Ocean page's. The land
 * imagery is mapbox.satellite, the source Relief + Sat borrows on Obs. Relief
 * tiles that fail leave the vector sea showing, never a hole.
 *
 * CREDITS ARE A LICENCE CONDITION. Mapbox's own compact ⓘ control (never a
 * hand-rolled hide), and every source added here carries its credit: Mapbox
 * and Maxar for the imagery, reliefBase's GEBCO/Geoscience Australia line
 * with "Not for navigation", OpenSeaMap for the seamarks.
 *
 * AT SEA WITH NO INTERNET. Tiles follow Obs's Pi rule exactly (useMapInit:
 * canDisplayProxiedTiles, never for Mapbox's own hosts or the LAN). That rule
 * is DORMANT today: PiCacheService.PI_TILE_PROXY_USABLE is false, so no map
 * tile goes through the Pi yet, here or on Obs, and offline the map draws
 * only what Mapbox and WebKit already cached. If the style itself never
 * arrives (nothing cached, a stalled link) the map falls back once to a plain
 * sea, so the track still draws over it, as the Leaflet maps drew it over
 * their plain background.
 *
 * NO WEBGL, NO MAP, NEVER A BROKEN PAGE. Mapbox throws from its constructor
 * when the web view gives it no WebGL context (Lockdown Mode switches WebGL
 * off; the GPU process can refuse one under memory pressure). createLogMap
 * catches that and returns null, so a caller keeps its plain box and the Log
 * page around it stands. The Leaflet maps never needed WebGL; this is the one
 * new way for a Log map to fail.
 *
 * MEMORY (the iOS WebContent 2 GB cap): Obs keeps its own map alive hidden,
 * so every Log map is an extra WebGL context. Callers create one only while it
 * is on screen (useLogMapOnScreen) and remove() it when it leaves; this caps
 * the tile cache, never keeps the drawing buffer, and never registers as THE
 * chart (chartMapRegistry), so MapActionFabs and the split-view pin can't find
 * it. Mapbox bills a map load per construction: once per visit, never per
 * render.
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { piCache } from '../../services/PiCacheService';
import { createLogger } from '../../utils/createLogger';
import { isHttpUrlOnDomain, isLocalNetworkHostname, parseExternalHttpUrl } from '../../utils/safeUrl';
import { addReliefBase, hideBaseClutter, seaBaseLayers, setReliefPalette } from './reliefBase';

const log = createLogger('LogMap');

export type LonLat = [number, number];
export type LogMapBounds = [LonLat, LonLat];

export const LOG_MAP_STYLE = 'mapbox://styles/mapbox/dark-v11';
/** The Obs base the Log maps draw (types/settings.ts ObsChartBase). */
export const LOG_MAP_BASE = 'reliefSat' as const;
/** The imagery source Relief + Sat borrows for its land (reliefBase). */
export const LAND_IMAGERY_SOURCE = 'satellite-base';
export const LOG_SEAMARK_SOURCE = 'log-seamarks';
export const LOG_SEAMARK_LAYER = 'log-seamarks';
/**
 * Retained off-screen tiles per source. A card shows a handful of tiles and
 * never pans; the fullscreen map gets the phone chart's cap (useMapInit).
 */
export const LOG_MAP_TILE_CACHE = { card: 8, free: 20 } as const;
/** How long the style may take before the map gives up and draws a plain sea. */
export const LOG_MAP_STYLE_TIMEOUT_MS = 8_000;
/** The plain sea a map falls back to when dark-v11 can't be had. */
export const LOG_MAP_FALLBACK_STYLE = {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#1f5a85' } }],
} as const;
/** Nothing to show yet, and nowhere better to look: the whole world, not one harbour. */
export const LOG_MAP_WORLD_VIEW = { center: [0, 20] as LonLat, zoom: 1 };

const MAPBOX_SATELLITE_TILES = 'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90';
const OPENSEAMAP_SEAMARK_TILES = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';
const SATELLITE_CREDIT =
    '&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">Mapbox</a> &copy; Maxar';
const SEAMARK_CREDIT =
    'Map data: &copy; <a href="https://www.openseamap.org" target="_blank" rel="noopener noreferrer">OpenSeaMap contributors</a>';

/** The build's Mapbox token, the one the Log maps have always used. Empty means no map. */
export const logMapToken = (): string => String(import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? '').trim();

/**
 * Route a tile through the boat's Pi on useMapInit's rule. A map engine can't
 * present the Pi's pin, so this gates on canDisplayProxiedTiles(), not on
 * reachability (and that stays false while PI_TILE_PROXY_USABLE does, so
 * today every tile goes direct); Mapbox's own hosts and the LAN always do.
 */
export function logMapTransformRequest(url: string, resourceType?: string): { url: string } {
    const parsed = parseExternalHttpUrl(url);
    if (
        resourceType === 'Tile' &&
        piCache.canDisplayProxiedTiles() &&
        parsed !== null &&
        !isLocalNetworkHostname(parsed.hostname.toLowerCase()) &&
        !isHttpUrlOnDomain(url, 'mapbox.com')
    ) {
        const piUrl = piCache.passthroughTileUrl(url);
        if (piUrl) return { url: piUrl };
    }
    return { url };
}

/**
 * Relief + Sat inside whatever style just loaded: the land imagery source,
 * reliefBase's sea, the visibility seaBaseLayers('reliefSat') names, the day
 * palette, and the seamarks under the place names. Idempotent. On the
 * fallback style (no water layer) reliefBase adds nothing and the plain sea
 * stays.
 */
export function installLogMapBase(map: mapboxgl.Map, token: string, { seamarks = true } = {}): void {
    hideBaseClutter(map);
    if (!map.getSource(LAND_IMAGERY_SOURCE))
        map.addSource(LAND_IMAGERY_SOURCE, {
            type: 'raster',
            tiles: [`${MAPBOX_SATELLITE_TILES}?access_token=${token}`],
            tileSize: 512,
            maxzoom: 22,
            attribution: SATELLITE_CREDIT,
        });
    addReliefBase(map);
    for (const [id, visible] of seaBaseLayers(LOG_MAP_BASE)) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
    setReliefPalette(map, 'day');
    if (!seamarks) return;
    if (!map.getSource(LOG_SEAMARK_SOURCE))
        map.addSource(LOG_SEAMARK_SOURCE, {
            type: 'raster',
            tiles: [OPENSEAMAP_SEAMARK_TILES],
            tileSize: 256,
            maxzoom: 18,
            attribution: SEAMARK_CREDIT,
        });
    if (!map.getLayer(LOG_SEAMARK_LAYER)) {
        const firstSymbol = map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
        // From z9: below it a seamark tile is empty sea, and a card framing a
        // passage would fetch a screenful of them for nothing.
        map.addLayer(
            {
                id: LOG_SEAMARK_LAYER,
                type: 'raster',
                source: LOG_SEAMARK_SOURCE,
                minzoom: 9,
                paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 },
            },
            firstSymbol,
        );
    }
}

export interface LogMapView {
    /** Framed on these, if given; otherwise centred. */
    bounds?: LogMapBounds;
    padding?: number;
    maxZoom?: number;
    center?: LonLat;
    zoom?: number;
}

export interface LogMapOptions {
    /** An empty box of the caller's own, as Mapbox asks: it fills it, and empties it again if it cannot start. */
    container: HTMLElement;
    token: string;
    /** The FIRST frame: the tiles first fetched are the ones about to be looked at. */
    view: LogMapView;
    /** 'card': a picture to tap; 'free': pans and pinches (fullscreen), north-up. */
    gestures: 'card' | 'free';
    /** Where the wordmark and the ⓘ sit. A card's bottom corners carry its buttons. */
    credits?: 'top' | 'bottom';
    seamarks?: boolean;
    /** After the base is in, on every style load (the real one or the fallback). */
    onStyle?: (map: mapboxgl.Map) => void;
}

/**
 * The map, or null when this web view can give Mapbox no WebGL context: the
 * caller keeps its plain box (and should not ask again this visit), and
 * nothing is thrown into the page around it.
 */
export function createLogMap(options: LogMapOptions): mapboxgl.Map | null {
    const { container, token, view, gestures, seamarks = true, onStyle } = options;
    const free = gestures === 'free';
    const credits = options.credits ?? (free ? 'bottom' : 'top');
    // retainPadding: false, as every padded camera call in the app says
    // (tests/cameraPaddingGuard.test.ts): Mapbox GL 3 would otherwise keep
    // the frame's padding on the map for every later move.
    const camera = view.bounds
        ? {
              bounds: view.bounds,
              fitBoundsOptions: { padding: view.padding ?? 16, maxZoom: view.maxZoom ?? 14, retainPadding: false },
          }
        : { center: view.center ?? LOG_MAP_WORLD_VIEW.center, zoom: view.zoom ?? LOG_MAP_WORLD_VIEW.zoom };
    let map: mapboxgl.Map;
    try {
        map = new mapboxgl.Map({
            container,
            accessToken: token,
            style: LOG_MAP_STYLE,
            ...camera,
            projection: 'mercator',
            attributionControl: false,
            logoPosition: credits === 'top' ? 'top-left' : 'bottom-right',
            interactive: free,
            dragPan: free,
            scrollZoom: free,
            touchZoomRotate: free,
            dragRotate: false,
            touchPitch: false,
            pitchWithRotate: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            maxPitch: 0,
            maxTileCacheSize: LOG_MAP_TILE_CACHE[gestures],
            fadeDuration: 0,
            crossSourceCollisions: false,
            transformRequest: logMapTransformRequest,
        } as mapboxgl.MapboxOptions);
    } catch (error) {
        // Mapbox had already dressed the box (its class, an empty canvas, the
        // control corners); hand it back plain. The box is the caller's and
        // holds nothing else.
        container.classList.remove('mapboxgl-map');
        container.replaceChildren();
        log.warn('Log map not drawn: Mapbox could not start (no WebGL context in this web view?)', error);
        return null;
    }
    if (free) map.touchZoomRotate?.disableRotation();
    map.addControl(
        new mapboxgl.AttributionControl({ compact: true }),
        credits === 'top' ? 'top-right' : 'bottom-right',
    );

    let styleIn = false;
    let fellBack = false;
    const fallBack = () => {
        if (styleIn || fellBack) return;
        fellBack = true;
        window.clearTimeout(timer);
        // No diff: the style that failed never loaded, so there is nothing to diff against.
        map.setStyle(
            LOG_MAP_FALLBACK_STYLE as unknown as mapboxgl.Style,
            {
                diff: false,
            } as Parameters<mapboxgl.Map['setStyle']>[1],
        );
    };
    const timer = window.setTimeout(fallBack, LOG_MAP_STYLE_TIMEOUT_MS);
    map.on('error', (event) => {
        // A tile names its source and leaves the sea showing; only the style
        // failing before it ever loaded means there is nothing to draw on.
        if (!(event as { sourceId?: string }).sourceId) fallBack();
    });
    map.on('style.load', () => {
        styleIn = true;
        window.clearTimeout(timer);
        container.dataset.logMapStyle = fellBack ? 'fallback' : 'relief-sat';
        installLogMapBase(map, token, { seamarks });
        onStyle?.(map);
    });
    map.once('remove', () => window.clearTimeout(timer));
    return map;
}

/**
 * Keep a line continuous across the antimeridian: each longitude is moved by
 * whole turns to within 180° of the one before, so a passage past Fiji is one
 * short line rather than a stroke around the planet. Mapbox draws longitudes
 * past ±180 in place (world copies).
 */
export function unwrapLongitudes(coords: readonly LonLat[]): LonLat[] {
    const out: LonLat[] = [];
    let previous: number | undefined;
    for (const [lon, lat] of coords) {
        let next = lon;
        if (previous !== undefined) {
            while (next - previous > 180) next -= 360;
            while (next - previous < -180) next += 360;
        }
        out.push([next, lat]);
        previous = next;
    }
    return out;
}

export function logMapBounds(coords: readonly LonLat[]): LogMapBounds | null {
    if (coords.length === 0) return null;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [lon, lat] of coords) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
    }
    return [
        [west, south],
        [east, north],
    ];
}

/** Add a GeoJSON source the first time, set its data after. */
export function setLogMapData(map: mapboxgl.Map, id: string, data: GeoJSON.Feature | GeoJSON.FeatureCollection): void {
    const source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
    if (source) source.setData(data);
    else map.addSource(id, { type: 'geojson', data });
}

/**
 * Frame these points without animation (a lone point at `pointZoom`).
 * False when the map has no room to frame yet; its next resize can.
 */
export function fitLogMap(
    map: mapboxgl.Map,
    coords: readonly LonLat[],
    { padding = 16, maxZoom = 14, pointZoom = 13 } = {},
): boolean {
    const box = map.getContainer();
    if (box.clientWidth <= padding * 2 + 8 || box.clientHeight <= padding * 2 + 8) return false;
    const bounds = logMapBounds(unwrapLongitudes(coords));
    if (!bounds) return false;
    const [[west, south], [east, north]] = bounds;
    if (west === east && south === north) map.jumpTo({ center: [west, south], zoom: pointZoom });
    else map.fitBounds(bounds, { padding, maxZoom, animate: false, retainPadding: false });
    return true;
}
