/**
 * satelliteWater — classify the navigable water of a canal/marina from Mapbox
 * SATELLITE RASTER tiles, so the tier-3 fine canal pass routes the REAL channel
 * shape instead of the coarse OSM `water` polygons.
 *
 * Why (2026-06-19): the ENC omits canal water entirely; we had been filling it
 * with Mapbox's VECTOR `water` layer (services/mapboxWater.ts) — but that is
 * OSM-derived and coarsely simplified, so the canal outline it gives is wrong,
 * and routeMarina's medial axis of a wrong outline is off-centre/wobbly. The
 * satellite imagery we already render shows the canal water plainly; classifying
 * its PIXELS yields the true channel shape, and the medial axis of true water is
 * the true centreline.
 *
 * Scope: tier-3 ONLY (canal/marina endpoint crops). Tier-2 open water is left to
 * the ENC, unchanged. This is a drop-in for fetchMapboxWater at the injection
 * seam in InshoreRouter — it returns the same `water polygons` FeatureCollection.
 *
 * Split: the classifier (classifyWaterMask) and the mask→polygons step
 * (maskToWaterPolygons) are PURE and unit-tested on synthetic pixels. Since
 * 131-05 they live with the route worker (routing/satelliteWaterJob.ts), which
 * decodes, classifies and outlines each crop off the main thread; only the
 * fetch is here (the route job's graph holds no network).
 */
import type { FeatureCollection } from 'geojson';
import { withTimeout } from '../utils/deadline';
import { sniffImageMime } from '../utils/imageBytes';
import { createLogger } from '../utils/createLogger';
import { tilesForBbox, type TileId } from './mapboxWater';
import { ROUTE_ENGINE } from './routing/routeJob';
import { runWaterJobHosted } from './routing/routeWorkerHost';
import {
    DEFAULT_CLASSIFY,
    type ClassifyParams,
    type SatelliteCrop,
    type SatelliteTile,
} from './routing/satelliteWaterJob';

// The classifier moved to the route worker's graph (131-05): every import of
// it from here still works.
export {
    classifyWaterMask,
    DEFAULT_CLASSIFY,
    maskToWaterPolygons,
    type ClassifyParams,
    type PxToLonLat,
} from './routing/satelliteWaterJob';

const log = createLogger('satelliteWater');

/** Zoom for the satellite raster. z14 (≈4 m/px @2x at this latitude) is the sweet
 *  spot: a 50 m canal is ~12 px (ample for the 12 m fine grid), the canal SURFACE
 *  averages smooth so the texture gate keeps it WHOLE, and a ~6 km crop is only
 *  ~9 tiles. z15 looked tempting for detail but its finer pixels surface
 *  boat/jetty/ripple texture that shatters the canal into specks the size filter
 *  deletes — verified on real Newport: z15 → 5% sparse/broken water, z14 → 12%
 *  connected. Detail beyond the routing grid is worse than useless here. */
export const SAT_WATER_ZOOM = 14;

/** Synthetic depth (m) stamped on satellite water — matches MAPBOX_WATER_DEPTH_M
 *  so the downstream injectedCanal/fine-pass behaviour is identical. */
export const SAT_WATER_DEPTH_M = 5;

const rasterTileUrl = (t: TileId, token: string): string =>
    `https://api.mapbox.com/v4/mapbox.satellite/${t.z}/${t.x}/${t.y}@2x.png?access_token=${token}`;

const EMPTY = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });

/**
 * A fetched crop's pictures read in the route worker (131-05), so the chart
 * keeps moving while they are decoded and classified. Where no worker can take
 * it (no Worker, a worker that will not start, crashes, is ended under it, or
 * has no picture decoder of its own), the main thread reads it through the same
 * function, with a warn line, as the route worker's own fallback does. A stopped
 * route's crop answers nothing (128-ROUTE-P): the worker's answer is dropped; a
 * crop stopped before the main thread takes it is not read there, and one
 * stopped while the main thread decodes its tiles is dropped before the
 * classify (satelliteCropWater's stillWanted), as it was before 131-05.
 */
async function readCrop(crop: SatelliteCrop, signal?: AbortSignal): Promise<FeatureCollection> {
    const hosted = runWaterJobHosted(crop);
    if (hosted) {
        try {
            const water = await hosted;
            return signal?.aborted ? EMPTY() : water;
        } catch (err) {
            if (signal?.aborted) return EMPTY();
            log.warn(`${err instanceof Error ? err.message : String(err)} — satellite crop read on the main thread`);
        }
    }
    const water = await ROUTE_ENGINE.water(crop, () => !signal?.aborted);
    return signal?.aborted ? EMPTY() : water;
}

/**
 * Fetch + classify satellite water over `bbox`, returning water polygons in the
 * same shape fetchMapboxWater does (so it's a drop-in at the injection seam).
 * The tiles are fetched here; their pictures are read in the route worker
 * (readCrop). Returns an empty FeatureCollection on any failure (the caller
 * then falls back to chart-only, never throwing).
 *
 * @param signal  a stopped route's crop classifies nothing on the main thread
 *                (128-ROUTE-P): its tiles in flight are dropped, the worker's
 *                answer is dropped, and where the main thread reads it, a stop
 *                during its decodes drops it before the classify (the decodes
 *                already started finish).
 */
export async function fetchSatelliteWater(
    bbox: readonly [number, number, number, number],
    token: string,
    zoom: number = SAT_WATER_ZOOM,
    classify: ClassifyParams = DEFAULT_CLASSIFY,
    signal?: AbortSignal,
): Promise<FeatureCollection> {
    if (!token) return EMPTY();
    const tiles = tilesForBbox(bbox, zoom);
    if (tiles.length === 0 || tiles.length > 64) return EMPTY(); // bound on-device cost
    // In the crop's own tile order, whichever lands first.
    const fetched: (SatelliteTile | null)[] = tiles.map(() => null);
    await Promise.all(
        tiles.map(async (t, i) => {
            try {
                const buf = await withTimeout(
                    fetch(rasterTileUrl(t, token)).then((r) => (r.ok ? r.arrayBuffer() : null)),
                    null as ArrayBuffer | null,
                    8000,
                );
                if (!buf || signal?.aborted) return;
                // Only proven image bytes are ever decoded — a 200-status
                // non-image (captive portal) force-typed as PNG faults the
                // native decoder.
                const mime = sniffImageMime(new Uint8Array(buf.slice(0, 16)), buf.byteLength);
                if (mime) fetched[i] = { x: t.x, y: t.y, bytes: buf, mime };
            } catch {
                /* tile dropped — fall through */
            }
        }),
    );
    // Require the crop to be fully fetched: a partial mosaic leaves the canal
    // disconnected at the holes AND risks a false-water blob where a tile is
    // missing, so fall back to the vector water instead (caller's behaviour today).
    const all = fetched.filter((t): t is SatelliteTile => t !== null);
    if (all.length < tiles.length || signal?.aborted) return EMPTY();
    return readCrop({ bbox: [bbox[0], bbox[1], bbox[2], bbox[3]], zoom, tiles: all, classify }, signal);
}
