/**
 * Tile Routes — Proxies satellite, chart, and overlay tiles through the Pi cache.
 *
 * Tile sources:
 *   - NASA GIBS (satellite imagery — IR, visible, true color)
 *   - SSEC RealEarth (animated satellite composites)
 *   - nowCOAST (NOAA weather radar, forecasts overlaid on maps)
 *   - OpenSeaMap (sea marks, lights, buoys)
 *   - GEBCO (bathymetry)
 *   - Rain viewer (precipitation radar)
 *
 * Tiles are binary (PNG/JPEG) and stored in the tile_cache table.
 * TTL varies by source — satellite tiles expire faster than bathymetry.
 */

import { Router, Request, Response } from 'express';
import { Cache } from '../cache.js';
import { ProxyConfig, cachedTileFetch } from '../proxy.js';
import { TTL } from '../scheduler.js';

export function createTileRoutes(cache: Cache, config: ProxyConfig): Router {
    const router = Router();

    /**
     * GET /api/tiles/gibs/:layer/:z/:x/:y
     * NASA GIBS satellite tiles.
     * Layers: MODIS_Terra_CorrectedReflectance_TrueColor, VIIRS_SNPP_*, etc.
     */
    router.get('/gibs/:layer/:z/:x/:y', async (req: Request, res: Response) => {
        try {
            const { layer, z, x, y } = req.params;
            const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
            const format = (req.query.format as string) || 'jpg';

            const key = `tile:gibs:${layer}:${date}:${z}/${x}/${y}`;
            const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.${format}`;

            const result = await cachedTileFetch(cache, {
                cacheKey: key,
                url,
                contentType: format === 'png' ? 'image/png' : 'image/jpeg',
                ttlMs: TTL.SATELLITE,
            });

            res.set('Content-Type', result.contentType);
            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.send(result.data);
        } catch (err) {
            res.status(502).json({ error: 'GIBS tile failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tiles/realearth/:product/:z/:x/:y
     * SSEC RealEarth satellite composites.
     */
    router.get('/realearth/:product/:z/:x/:y', async (req: Request, res: Response) => {
        try {
            const { product, z, x, y } = req.params;
            const time = (req.query.time as string) || '';

            const key = `tile:realearth:${product}:${time || 'latest'}:${z}/${x}/${y}`;
            const timeParam = time ? `&time=${time}` : '';
            const url = `https://realearth.ssec.wisc.edu/api/image?products=${product}&x=${x}&y=${y}&z=${z}${timeParam}`;

            const result = await cachedTileFetch(cache, {
                cacheKey: key,
                url,
                contentType: 'image/png',
                ttlMs: TTL.SATELLITE,
            });

            res.set('Content-Type', result.contentType);
            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.send(result.data);
        } catch (err) {
            res.status(502).json({ error: 'RealEarth tile failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tiles/nowcoast/:layer/:z/:x/:y
     * NOAA nowCOAST — radar, watches/warnings, surface obs overlays.
     */
    router.get('/nowcoast/:layer/:z/:x/:y', async (req: Request, res: Response) => {
        try {
            const { layer, z, x, y } = req.params;

            const key = `tile:nowcoast:${layer}:${z}/${x}/${y}`;
            const url = `https://nowcoast.noaa.gov/arcgis/rest/services/${layer}/MapServer/tile/${z}/${y}/${x}`;

            const result = await cachedTileFetch(cache, {
                cacheKey: key,
                url,
                contentType: 'image/png',
                ttlMs: TTL.WEATHER_CURRENT,
            });

            res.set('Content-Type', result.contentType);
            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.send(result.data);
        } catch (err) {
            res.status(502).json({ error: 'nowCOAST tile failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tiles/openseamap/:z/:x/:y
     * OpenSeaMap sea mark tiles (lights, buoys, anchorages).
     */
    router.get('/openseamap/:z/:x/:y', async (req: Request, res: Response) => {
        try {
            const { z, x, y } = req.params;

            const key = `tile:openseamap:${z}/${x}/${y}`;
            const url = `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`;

            const result = await cachedTileFetch(cache, {
                cacheKey: key,
                url,
                contentType: 'image/png',
                ttlMs: TTL.SEAMARK,
            });

            res.set('Content-Type', result.contentType);
            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.send(result.data);
        } catch (err) {
            res.status(502).json({ error: 'OpenSeaMap tile failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tiles/gebco/:z/:x/:y
     * GEBCO bathymetry tiles.
     */
    router.get('/gebco/:z/:x/:y', async (req: Request, res: Response) => {
        try {
            const { z, x, y } = req.params;

            const key = `tile:gebco:${z}/${x}/${y}`;
            const url = `https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/${z}/${y}/${x}`;

            const result = await cachedTileFetch(cache, {
                cacheKey: key,
                url,
                contentType: 'image/png',
                ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days — bathymetry doesn't change
            });

            res.set('Content-Type', result.contentType);
            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.send(result.data);
        } catch (err) {
            res.status(502).json({ error: 'GEBCO tile failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/tiles/rainviewer/:z/:x/:y?path=XXXX
     * RainViewer precipitation radar tiles.
     */
    router.get('/rainviewer/:z/:x/:y', async (req: Request, res: Response) => {
        try {
            const { z, x, y } = req.params;
            const tilePath = (req.query.path as string) || '';

            const key = `tile:rainviewer:${tilePath}:${z}/${x}/${y}`;
            const url = `https://tilecache.rainviewer.com${tilePath}/256/${z}/${x}/${y}/2/1_1.png`;

            const result = await cachedTileFetch(cache, {
                cacheKey: key,
                url,
                contentType: 'image/png',
                ttlMs: 10 * 60 * 1000, // 10 min — radar updates frequently
            });

            res.set('Content-Type', result.contentType);
            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.send(result.data);
        } catch (err) {
            res.status(502).json({ error: 'RainViewer tile failed', message: (err as Error).message });
        }
    });

    return router;
}
