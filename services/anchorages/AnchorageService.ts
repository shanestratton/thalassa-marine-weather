/**
 * AnchorageService — loads the tiled anchorage reference around a centre.
 *
 * v1 (2026-08-25): QLD coast in 2°×2° tiles, built by
 * `scripts/anchorages/build-qld.mjs` into `public/anchorages/qld/` — an
 * index.json naming every tile with content, plus three files per tile
 * (points with baked 36-sector fetch tables, no-anchoring polygons,
 * marine-park zoning). Served from the app origin so the service worker's
 * data cache keeps visited tiles offline — the whole point for cruisers out
 * of signal. Sources: OpenStreetMap (ODbL), GBRMPA (CC BY). It is an
 * open-data planning reference, NOT a navigational chart.
 *
 * The caller asks for everything within a radius of a centre (the location
 * box / the boat); tiles are fetched once and memoised for the session.
 * Zoning and no-anchoring features can appear in several tiles (ArcGIS bbox
 * queries return whole intersecting features), so merges dedupe by id.
 */
import { createLogger } from '../../utils/createLogger';

const log = createLogger('AnchorageService');

export type AnchorageKind = 'anchorage' | 'designated_anchorage' | 'marina';

export interface AnchorageProps {
    id: string;
    name: string;
    kind: AnchorageKind;
    source: 'OpenStreetMap' | 'GBRMPA';
    sourceRef?: string;
    likelyAnchorage?: boolean;
    noAnchoring?: boolean;
    noAnchoringName?: string | null;
    notes?: string | null;
    /** 36 sectors × 10°, NM to first coastline crossing (wind shelter). */
    fetchLandNM?: number[];
    /** 36 sectors, NM to first coastline OR reef crossing (sea shelter). */
    fetchReefNM?: number[];
}

export interface AnchorageData {
    points: GeoJSON.FeatureCollection<GeoJSON.Point, AnchorageProps>;
    noAnchor: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    zoning: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    /** Tile ids that fed this merge — for logs and change detection. */
    tiles: string[];
}

export interface AnchorageTileMeta {
    id: string;
    /** [w, s, e, n] degrees. */
    bbox: [number, number, number, number];
    points: number;
    noAnchor: number;
    zoning: number;
}

export interface AnchorageIndex {
    built: string;
    tileDeg: number;
    fetchCapNM: number;
    sectors: number;
    tiles: AnchorageTileMeta[];
}

const BASE = '/anchorages/qld';

interface TileData {
    points: AnchorageData['points'];
    noAnchor: AnchorageData['noAnchor'];
    zoning: AnchorageData['zoning'];
}

let indexCache: Promise<AnchorageIndex> | null = null;
const tileCache = new Map<string, Promise<TileData>>();

async function fetchFC<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`anchorage data fetch failed: ${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
}

function loadIndex(): Promise<AnchorageIndex> {
    if (!indexCache) {
        indexCache = fetchFC<AnchorageIndex>(`${BASE}/index.json`).catch((err) => {
            indexCache = null; // first launch may race the SW — retryable
            throw err;
        });
    }
    return indexCache;
}

function loadTile(id: string): Promise<TileData> {
    let p = tileCache.get(id);
    if (!p) {
        p = (async () => {
            const [points, noAnchor, zoning] = await Promise.all([
                fetchFC<TileData['points']>(`${BASE}/${id}.geojson`),
                fetchFC<TileData['noAnchor']>(`${BASE}/${id}-noanchor.geojson`),
                fetchFC<TileData['zoning']>(`${BASE}/${id}-zoning.geojson`),
            ]);
            return { points, noAnchor, zoning };
        })().catch((err) => {
            tileCache.delete(id); // retryable, same reasoning as the index
            throw err;
        });
        tileCache.set(id, p);
    }
    return p;
}

/** Does the tile bbox intersect a radius (NM) around the centre? Uses the
 *  flat-earth degree expansion that is honest at ≤100 NM. */
export function tileWithinRadius(
    bbox: [number, number, number, number],
    lat: number,
    lon: number,
    radiusNM: number,
): boolean {
    const dLat = radiusNM / 60;
    const cos = Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
    const dLon = radiusNM / (60 * cos);
    const [w, s, e, n] = bbox;
    return lon + dLon >= w && lon - dLon <= e && lat + dLat >= s && lat - dLat <= n;
}

function dedupeById<G extends GeoJSON.Geometry, P>(
    collections: GeoJSON.FeatureCollection<G, P>[],
): GeoJSON.Feature<G, P>[] {
    const seen = new Set<string>();
    const out: GeoJSON.Feature<G, P>[] = [];
    for (const fc of collections) {
        for (const f of fc.features) {
            const id = (f.properties as { id?: string } | null)?.id;
            if (id) {
                if (seen.has(id)) continue;
                seen.add(id);
            }
            out.push(f);
        }
    }
    return out;
}

export const AnchorageService = {
    /** The tile directory (memoised). */
    index: loadIndex,

    /**
     * Everything within `radiusNM` of the centre, merged across tiles.
     * Tiles already fetched this session come from memory; new ones hit the
     * network once (and the SW data cache thereafter).
     */
    async loadNear(lat: number, lon: number, radiusNM = 50): Promise<AnchorageData> {
        const index = await loadIndex();
        const wanted = index.tiles.filter((t) => tileWithinRadius(t.bbox, lat, lon, radiusNM));
        const tiles = await Promise.all(wanted.map((t) => loadTile(t.id)));
        const merged: AnchorageData = {
            points: { type: 'FeatureCollection', features: dedupeById(tiles.map((t) => t.points)) },
            noAnchor: { type: 'FeatureCollection', features: dedupeById(tiles.map((t) => t.noAnchor)) },
            zoning: { type: 'FeatureCollection', features: dedupeById(tiles.map((t) => t.zoning)) },
            tiles: wanted.map((t) => t.id),
        };
        log.info(
            `loaded ${merged.points.features.length} anchorages from ${wanted.length} tile(s) within ${radiusNM} NM of ${lat.toFixed(2)},${lon.toFixed(2)}`,
        );
        return merged;
    },
};
