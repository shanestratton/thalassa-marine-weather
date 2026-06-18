/**
 * mapboxWater — pull Mapbox's vector `water` layer as GeoJSON polygons, so the
 * router can route through canals, marinas, and creeks the ENC omits.
 *
 * The problem (Newport, 2026-06-18): the ENC charts marina lots as land (LNDARE)
 * and never charts the navigable channels between them — so the router had no
 * water to follow and clipped the lots. But that water is plainly visible in the
 * Mapbox satellite/vector tiles we already render on every frame. Mapbox's
 * `water` source-layer (OSM-derived, in mapbox-streets-v8) carries those channels
 * in full — verified 59% water coverage with the canal network intact over the
 * Newport marina. This is the data Navionics sells; we already load it.
 *
 * Feed these polygons into the router's authoritative-water path (the same
 * DEPARE-injection OSM water already uses) and the boat routes the real channels.
 *
 * The decode (decodeWaterFromTile) is PURE and offline-tested against a canned
 * tile; only fetchMapboxWater touches the network.
 */
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { withTimeout } from '../utils/deadline';

/** mapbox-streets-v8 serves the FINEST `water` geometry at z16; lower zooms are
 *  generalised and the narrow canal channels vanish (z15 over Newport collapsed
 *  the whole marina to 3 blobs / 32 vertices). Always fetch the canal at z16. */
export const MAPBOX_WATER_ZOOM = 16;

const STREETS_V8 = 'mapbox.mapbox-streets-v8';
const WATER_LAYER = 'water';

export interface TileId {
    z: number;
    x: number;
    y: number;
}

/** Slippy-map (XYZ) tile containing a lon/lat at zoom z. */
export function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
    const n = 2 ** z;
    const latRad = (lat * Math.PI) / 180;
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    const clamp = (v: number): number => Math.max(0, Math.min(n - 1, v));
    return { x: clamp(x), y: clamp(y) };
}

/** Every XYZ tile covering [minLon,minLat,maxLon,maxLat] at zoom z. */
export function tilesForBbox(bbox: readonly [number, number, number, number], z: number): TileId[] {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const nw = lonLatToTileXY(minLon, maxLat, z); // top-left
    const se = lonLatToTileXY(maxLon, minLat, z); // bottom-right
    const tiles: TileId[] = [];
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) tiles.push({ z, x, y });
    return tiles;
}

/**
 * Decode the `water` layer of one MVT buffer into lon/lat GeoJSON polygons.
 * PURE — the unit-testable core. Non-polygon features are ignored; the decoder's
 * own toGeoJSON(x,y,z) handles the tile→lon/lat transform.
 */
export function decodeWaterFromTile(
    buffer: Uint8Array,
    z: number,
    x: number,
    y: number,
): Feature<Polygon | MultiPolygon>[] {
    const layer = new VectorTile(new Pbf(buffer)).layers[WATER_LAYER];
    if (!layer) return [];
    const out: Feature<Polygon | MultiPolygon>[] = [];
    for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.type !== 3) continue; // 3 = Polygon / MultiPolygon
        const gj = f.toGeoJSON(x, y, z) as Feature<Polygon | MultiPolygon>;
        if (gj.geometry && (gj.geometry.type === 'Polygon' || gj.geometry.type === 'MultiPolygon')) {
            out.push(gj);
        }
    }
    return out;
}

const tileUrl = (t: TileId, token: string): string =>
    `https://api.mapbox.com/v4/${STREETS_V8}/${t.z}/${t.x}/${t.y}.mvt?access_token=${token}`;

export interface FetchMapboxWaterOpts {
    /** Override the water zoom (default MAPBOX_WATER_ZOOM = 16). */
    zoom?: number;
    /** Per-tile JS deadline in ms (CapacitorHttp ignores AbortSignal on-device,
     *  so we bound with utils/deadline, never an abort signal). */
    timeoutMs?: number;
    /** Injectable tile fetcher (tests + a worker path). Returns null on failure. */
    fetchTile?: (url: string) => Promise<Uint8Array | null>;
}

/**
 * Fetch + decode the Mapbox `water` polygons covering a bbox. Tiles are fetched
 * concurrently; any failed/slow tile is skipped (a JS deadline bounds each, since
 * CapacitorHttp ignores AbortSignal). Returns an empty FeatureCollection on total
 * failure — the caller treats absence of Mapbox water as "no extra water", never
 * an error, so routing degrades gracefully to the ENC alone.
 */
export async function fetchMapboxWater(
    bbox: readonly [number, number, number, number],
    token: string,
    opts: FetchMapboxWaterOpts = {},
): Promise<FeatureCollection<Polygon | MultiPolygon>> {
    if (!token) return { type: 'FeatureCollection', features: [] };
    const z = opts.zoom ?? MAPBOX_WATER_ZOOM;
    const tiles = tilesForBbox(bbox, z);
    const fetchTile = opts.fetchTile ?? defaultFetchTile(opts.timeoutMs ?? 8000);
    const features: Feature<Polygon | MultiPolygon>[] = [];
    await Promise.all(
        tiles.map(async (t) => {
            try {
                const buf = await fetchTile(tileUrl(t, token));
                if (buf && buf.length > 0) features.push(...decodeWaterFromTile(buf, t.z, t.x, t.y));
            } catch {
                /* skip this tile — partial water still helps */
            }
        }),
    );
    return { type: 'FeatureCollection', features };
}

function defaultFetchTile(timeoutMs: number): (url: string) => Promise<Uint8Array | null> {
    return (url) =>
        withTimeout(
            fetch(url).then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : null)),
            null,
            timeoutMs,
        );
}
