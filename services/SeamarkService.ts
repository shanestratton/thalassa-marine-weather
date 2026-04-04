/**
 * SeamarkService — Queries OpenSeaMap data via the Overpass API.
 *
 * Loads buoys, beacons, lights, anchorages, and other navigation aids
 * as GeoJSON for rendering as an interactive vector layer on the map.
 *
 * Features:
 *   - Viewport-based lazy loading (queries on map moveend)
 *   - z8 tile-grid caching to avoid redundant Overpass fetches
 *   - Offline persistence via Capacitor Preferences
 *   - Max feature cap to protect performance
 */
import { createLogger } from '../utils/createLogger';
import { Preferences } from '@capacitor/preferences';

const log = createLogger('Seamark');

// ── Types ────────────────────────────────────────────────────────────────────

export interface SeamarkFeature {
    type: 'Feature';
    geometry: {
        type: 'Point';
        coordinates: [number, number]; // [lon, lat]
    };
    properties: {
        id: string;
        /** Primary seamark type (e.g. buoy_lateral, light_major) */
        seamarkType: string;
        /** Human-readable name */
        name: string;
        /** All seamark:* tags from OSM, flattened */
        tags: Record<string, string>;
    };
}

export interface SeamarkCollection {
    type: 'FeatureCollection';
    features: SeamarkFeature[];
}

// ── Constants ────────────────────────────────────────────────────────────────

// Multiple Overpass API endpoints for global reliability
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
let _endpointIdx = 0;
function nextEndpoint(): string {
    const url = OVERPASS_ENDPOINTS[_endpointIdx % OVERPASS_ENDPOINTS.length];
    _endpointIdx++;
    return url;
}

const CACHE_KEY = 'seamark_cache_v2';
const TILE_ZOOM = 7; // z7 tiles = wider coverage per query, fewer requests globally
const MIN_QUERY_ZOOM = 10; // Don't query below this zoom
const MAX_FEATURES = 3000;
const QUERY_TIMEOUT = 30; // seconds

// Seamark types we care about (comprehensive)
const SEAMARK_TYPES = [
    'buoy_lateral',
    'buoy_cardinal',
    'buoy_isolated_danger',
    'buoy_safe_water',
    'buoy_special_purpose',
    'buoy_installation',
    'beacon_lateral',
    'beacon_cardinal',
    'beacon_isolated_danger',
    'beacon_safe_water',
    'beacon_special_purpose',
    'light',
    'light_major',
    'light_minor',
    'light_vessel',
    'light_float',
    'anchorage',
    'anchor_berth',
    'harbour',
    'mooring',
    'restricted_area',
    'cable_submarine',
    'pipeline_submarine',
    'separation_zone',
    'fairway',
    'recommended_track',
    'pilot_boarding',
    'signal_station_traffic',
    'signal_station_warning',
    'coastguard_station',
    'rescue_station',
].join('|');

// ── Tile helpers ─────────────────────────────────────────────────────────────

function tileKey(lat: number, lon: number, zoom: number): string {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(
        ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
    );
    return `${zoom}/${x}/${y}`;
}

function tileBounds(tileX: number, tileY: number, zoom: number): [number, number, number, number] {
    const n = Math.pow(2, zoom);
    const lonW = (tileX / n) * 360 - 180;
    const lonE = ((tileX + 1) / n) * 360 - 180;
    const latN = (Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n))) * 180) / Math.PI;
    const latS = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + 1)) / n))) * 180) / Math.PI;
    return [latS, lonW, latN, lonE]; // [south, west, north, east]
}

// ── Service ──────────────────────────────────────────────────────────────────

type Listener = (data: SeamarkCollection) => void;

class SeamarkServiceClass {
    private cache = new Map<string, SeamarkFeature[]>();
    private pendingTiles = new Set<string>();
    private listeners = new Set<Listener>();
    private currentCollection: SeamarkCollection = { type: 'FeatureCollection', features: [] };
    private _initialized = false;

    // ── Public API ───────────────────────────────────────────────────────

    /** Subscribe to seamark data updates */
    onUpdate(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** Get current cached features */
    getFeatures(): SeamarkCollection {
        return this.currentCollection;
    }

    /** Load seamarks for the given viewport. Call on map moveend. */
    async loadViewport(
        bounds: { north: number; south: number; east: number; west: number },
        zoom: number,
    ): Promise<void> {
        if (zoom < MIN_QUERY_ZOOM) return;

        if (!this._initialized) {
            await this.restoreCache();
            this._initialized = true;
        }

        // Calculate which z8 tiles cover this viewport
        const tiles = this.getTilesForBounds(bounds);

        // Filter to tiles we haven't fetched yet
        const needed = tiles.filter((t) => !this.cache.has(t.key) && !this.pendingTiles.has(t.key));

        if (needed.length === 0) {
            // All tiles cached — just rebuild the collection for current viewport
            this.rebuildCollection(bounds);
            return;
        }

        // Fetch missing tiles (batch into a single Overpass query if possible)
        await this.fetchTiles(needed);

        // Rebuild visible features
        this.rebuildCollection(bounds);

        // Persist cache
        this.persistCache();
    }

    /** Clear all cached data */
    async clearCache(): Promise<void> {
        this.cache.clear();
        this.currentCollection = { type: 'FeatureCollection', features: [] };
        this.notify();
        await Preferences.remove({ key: CACHE_KEY });
        log.info('Cache cleared');
    }

    /** Number of cached tiles */
    get cachedTileCount(): number {
        return this.cache.size;
    }

    // ── Internal ─────────────────────────────────────────────────────────

    private getTilesForBounds(bounds: { north: number; south: number; east: number; west: number }) {
        const n = Math.pow(2, TILE_ZOOM);
        const xMin = Math.floor(((bounds.west + 180) / 360) * n);
        const xMax = Math.floor(((bounds.east + 180) / 360) * n);
        const yMin = Math.floor(
            ((1 -
                Math.log(Math.tan((bounds.north * Math.PI) / 180) + 1 / Math.cos((bounds.north * Math.PI) / 180)) /
                    Math.PI) /
                2) *
                n,
        );
        const yMax = Math.floor(
            ((1 -
                Math.log(Math.tan((bounds.south * Math.PI) / 180) + 1 / Math.cos((bounds.south * Math.PI) / 180)) /
                    Math.PI) /
                2) *
                n,
        );

        const tiles: { key: string; x: number; y: number }[] = [];
        for (let x = xMin; x <= xMax; x++) {
            for (let y = yMin; y <= yMax; y++) {
                tiles.push({ key: `${TILE_ZOOM}/${x}/${y}`, x, y });
            }
        }
        return tiles;
    }

    private async fetchTiles(tiles: { key: string; x: number; y: number }[]): Promise<void> {
        // Mark as pending
        for (const t of tiles) this.pendingTiles.add(t.key);

        // Build a union bbox for all tiles
        const allBounds = tiles.map((t) => tileBounds(t.x, t.y, TILE_ZOOM));
        const south = Math.min(...allBounds.map((b) => b[0]));
        const west = Math.min(...allBounds.map((b) => b[1]));
        const north = Math.max(...allBounds.map((b) => b[2]));
        const east = Math.max(...allBounds.map((b) => b[3]));

        const query = `
[out:json][timeout:${QUERY_TIMEOUT}];
(
  nwr["seamark:type"~"${SEAMARK_TYPES}"](${south},${west},${north},${east});
);
out center ${MAX_FEATURES};
`;

        try {
            log.info(
                `Fetching seamarks: ${tiles.length} tiles, bbox [${south.toFixed(2)},${west.toFixed(2)},${north.toFixed(2)},${east.toFixed(2)}]`,
            );

            const resp = await this.fetchWithFailover(query);

            if (!resp) {
                log.warn('All Overpass endpoints failed');
                for (const t of tiles) this.pendingTiles.delete(t.key);
                return;
            }

            const data = await resp.json();
            const elements = data.elements || [];

            log.info(`Received ${elements.length} seamark features`);

            // Convert to our Feature format and bin into tiles
            const features: SeamarkFeature[] = [];
            for (const el of elements) {
                const lat = el.lat ?? el.center?.lat;
                const lon = el.lon ?? el.center?.lon;
                if (lat == null || lon == null) continue;

                const tags: Record<string, string> = {};
                for (const [k, v] of Object.entries(el.tags || {})) {
                    if (k.startsWith('seamark:')) {
                        tags[k.replace('seamark:', '')] = v as string;
                    }
                }

                const seamarkType = tags['type'] || 'unknown';
                const name = tags['name'] || tags[`${seamarkType}:name`] || el.tags?.name || '';

                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [lon, lat] },
                    properties: {
                        id: `osm-${el.id}`,
                        seamarkType,
                        name,
                        tags,
                    },
                });
            }

            // Bin features into their z8 tiles
            for (const feature of features) {
                const [lon, lat] = feature.geometry.coordinates;
                const tk = tileKey(lat, lon, TILE_ZOOM);
                if (!this.cache.has(tk)) {
                    this.cache.set(tk, []);
                }
                // Dedup by ID
                const existing = this.cache.get(tk)!;
                if (!existing.some((f) => f.properties.id === feature.properties.id)) {
                    existing.push(feature);
                }
            }

            // Mark empty tiles so we don't re-fetch them
            for (const t of tiles) {
                if (!this.cache.has(t.key)) {
                    this.cache.set(t.key, []);
                }
                this.pendingTiles.delete(t.key);
            }
        } catch (err) {
            log.warn('Overpass fetch failed:', err);
            for (const t of tiles) this.pendingTiles.delete(t.key);
        }
    }

    private rebuildCollection(bounds: { north: number; south: number; east: number; west: number }): void {
        // Gather features from all cached tiles that intersect the viewport
        const tiles = this.getTilesForBounds(bounds);
        const features: SeamarkFeature[] = [];

        for (const t of tiles) {
            const cached = this.cache.get(t.key);
            if (cached) features.push(...cached);
        }

        this.currentCollection = { type: 'FeatureCollection', features };
        this.notify();
    }

    private notify(): void {
        const snapshot = this.currentCollection;
        this.listeners.forEach((fn) => fn(snapshot));
    }

    // ── Failover ──────────────────────────────────────────────────────────

    /** Try each Overpass endpoint with round-robin failover */
    private async fetchWithFailover(query: string): Promise<Response | null> {
        for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
            const url = nextEndpoint();
            try {
                log.info(`Trying endpoint: ${url.split('/')[2]}`);
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `data=${encodeURIComponent(query)}`,
                    signal: AbortSignal.timeout(QUERY_TIMEOUT * 1000),
                });
                if (resp.ok) return resp;
                log.warn(`Endpoint ${url.split('/')[2]} returned ${resp.status}, trying next...`);
            } catch (err) {
                log.warn(`Endpoint ${url.split('/')[2]} failed:`, err);
            }
        }
        return null;
    }

    // ── Persistence ──────────────────────────────────────────────────────

    private async persistCache(): Promise<void> {
        try {
            // Serialize as { tileKey: features[] } — only save non-empty tiles to reduce size
            const serializable: Record<string, SeamarkFeature[]> = {};
            for (const [key, features] of this.cache.entries()) {
                if (features.length > 0) {
                    serializable[key] = features;
                }
            }
            const json = JSON.stringify(serializable);
            await Preferences.set({ key: CACHE_KEY, value: json });
            log.info(
                `Cache persisted: ${Object.keys(serializable).length} tiles, ${(json.length / 1024).toFixed(0)}KB`,
            );
        } catch (err) {
            log.warn('Failed to persist seamark cache:', err);
        }
    }

    private async restoreCache(): Promise<void> {
        try {
            const { value } = await Preferences.get({ key: CACHE_KEY });
            if (!value) return;

            const data = JSON.parse(value) as Record<string, SeamarkFeature[]>;
            let featureCount = 0;
            for (const [key, features] of Object.entries(data)) {
                this.cache.set(key, features);
                featureCount += features.length;
            }
            log.info(`Cache restored: ${this.cache.size} tiles, ${featureCount} features`);
        } catch (err) {
            log.warn('Failed to restore seamark cache:', err);
        }
    }
}

export const SeamarkService = new SeamarkServiceClass();
