/**
 * An offline MBTiles chart drawn under the app's own Content Security Policy
 * (W1-FX item 1). The spec (browser-tests/mbtiles-csp.spec.ts) serves this
 * page with the policy copied out of index.html (the native shell) or
 * vercel.json (the web app), and answers the chart read with a tiny
 * FICTIONAL .mbtiles it builds itself: one solid-colour tile in open ocean.
 *
 * The path is the app's: MBTilesService.open() (sql.js WASM + the file read),
 * a raster source on the fake mbtiles.local host exactly as useLocalCharts
 * adds it, and useMapInit's mbtiles.local branch of transformRequest, which
 * hands Mapbox a blob: URL from MBTilesService.getTileBlobUrl(). Mapbox GL 3
 * loads raster tiles with fetch(), so the blob: URL is a connect-src load.
 *
 * window.__mbtilesCsp reports each step, every CSP violation the page saw,
 * the tile states Mapbox ended with, and probe() reads the drawn pixel
 * (Mapbox only paints for an authenticated map: the dev server's own token).
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MBTilesService, TRANSPARENT_TILE_DATA_URL } from '../../services/MBTilesService';

const FILE = 'fictional-ocean-test.mbtiles';
const SOURCE = `local-mbtiles-${FILE}`;

type Violation = { directive: string; blockedURI: string };
const state = {
    ready: false,
    open: 'pending' as string,
    blobUrlsHanded: 0,
    violations: [] as Violation[],
    mapErrors: [] as string[],
    tileStates: [] as string[],
    probe(lon: number, lat: number): number[] {
        const p = map.project([lon, lat]);
        const dpr = window.devicePixelRatio || 1;
        const src = map.getCanvas();
        const c = document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(src, 0, 0);
        const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
    },
};
(window as unknown as { __mbtilesCsp: typeof state }).__mbtilesCsp = state;

document.addEventListener('securitypolicyviolation', (e) => {
    state.violations.push({ directive: e.effectiveDirective || e.violatedDirective, blockedURI: e.blockedURI });
});

const token = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MAPBOX_ACCESS_TOKEN;
if (token) mapboxgl.accessToken = token;

const map = new mapboxgl.Map({
    container: document.getElementById('map')!,
    style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#08243b' } }],
    },
    // The one tile (z4 x6 y8) sits in the open Atlantic; at zoom 3 a 256 px
    // source asks for z4 tiles, so the map centre lands inside it.
    center: [-33.75, -11],
    zoom: 3,
    attributionControl: false,
    preserveDrawingBuffer: true,
    testMode: true,
    // useMapInit's mbtiles.local branch, verbatim in effect.
    transformRequest: (url: string, resourceType?: string) => {
        if (resourceType === 'Tile' && /^https?:\/\/mbtiles\.local\//i.test(url)) {
            const match = url.match(/mbtiles\.local\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
            if (match) {
                const blobUrl = MBTilesService.getTileBlobUrl(
                    decodeURIComponent(match[1]),
                    Number(match[2]),
                    Number(match[3]),
                    Number(match[4]),
                );
                if (blobUrl) {
                    state.blobUrlsHanded += 1;
                    return { url: blobUrl };
                }
                return { url: TRANSPARENT_TILE_DATA_URL };
            }
        }
        return { url };
    },
} as mapboxgl.MapOptions);

map.on('error', (e) => {
    const err = (e as unknown as { error?: { message?: string } }).error;
    state.mapErrors.push(String(err?.message ?? e.type));
});

map.on('load', async () => {
    try {
        const chart = await MBTilesService.open(FILE);
        state.open = `ok ${chart.metadata.format} z${chart.metadata.minzoom}-${chart.metadata.maxzoom}`;
        // As useLocalCharts adds it.
        map.addSource(SOURCE, {
            type: 'raster',
            tiles: [`http://mbtiles.local/${encodeURIComponent(FILE)}/{z}/{x}/{y}`],
            tileSize: 256,
            minzoom: chart.metadata.minzoom ?? 0,
            maxzoom: chart.metadata.maxzoom ?? 18,
        });
        map.addLayer({
            id: `local-mbtiles-layer-${FILE}`,
            type: 'raster',
            source: SOURCE,
            paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
        });
    } catch (err) {
        state.open = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const finish = () => {
        const cache = (
            map as unknown as {
                style: { getOwnSourceCache(id: string): { _tiles: Record<string, { state: string }> } | undefined };
            }
        ).style.getOwnSourceCache(SOURCE);
        state.tileStates = Object.values(cache?._tiles ?? {}).map((t) => t.state);
        state.ready = true;
    };
    // Let the tile requests run and fail or land, then settle.
    setTimeout(() => {
        map.once('idle', finish);
        map.triggerRepaint();
    }, 1500);
});
