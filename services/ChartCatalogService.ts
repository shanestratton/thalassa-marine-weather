/**
 * ChartCatalogService — Free nautical chart source management.
 *
 * Manages a catalog of free, publicly-available nautical chart tile sources
 * that can be overlaid on the Thalassa map without any external server.
 *
 * Supported sources:
 *   - NOAA NCDS: US waters, WMTS tiles (zero config)
 *   - NOAA ECDIS: US waters, IHO S-52 symbology (zero config)
 *   - LINZ: New Zealand waters, WMTS tiles (requires free API key)
 *   - OpenSeaMap: Global seamark overlay (already in base map)
 *
 * Future:
 *   - MBTiles import (offline chart packages from NOAA/Chart Locker)
 */

import { createLogger } from '../utils/createLogger';

const log = createLogger('ChartCatalog');

// ── Types ──

export type ChartSourceId = 'noaa-ncds' | 'noaa-ecdis' | 'linz-charts' | 'openseamap';

export interface ChartSource {
    id: ChartSourceId;
    name: string;
    description: string;
    /** Region covered */
    region: string;
    /** Flag emoji */
    flag: string;
    /** Tile URL template with {z}/{y}/{x} placeholders */
    tileUrl: string | null; // null if API key required but missing
    /** Does this source require an API key? */
    requiresKey: boolean;
    /** Tile format */
    format: 'png' | 'jpg' | 'pbf';
    /** Min/max zoom */
    minZoom: number;
    maxZoom: number;
    /** Approximate bounding box [west, south, east, north] */
    bounds: [number, number, number, number];
    /** Attribution text required by data license */
    attribution: string;
    /** Is this source currently enabled? */
    enabled: boolean;
    /** Opacity (0-1) */
    opacity: number;
}

// ── Constants ──

const STORAGE_KEY = 'thalassa_chart_catalog';
const LINZ_KEY_STORAGE = 'thalassa_linz_api_key';

// NOAA Chart Display Service — ENC rendered to paper chart style
// The /exts/MaritimeChartService/MapServer/export path is REQUIRED (standard
// MapServer/export returns grey tiles). Mapbox replaces {bbox-epsg-3857}.
const NOAA_NCDS_TILE_URL =
    'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=EPSG%3A3857&imageSR=EPSG%3A3857&size=256,256&format=png&transparent=true&f=image&display_params=%7B%22ECDISParameters%22%3A%7B%22version%22%3A%2210.2.1%22%2C%22DynamicParameters%22%3A%7B%22Parameter%22%3A%5B%7B%22name%22%3A%22DisplayDepthUnits%22%2C%22value%22%3A1%7D%5D%7D%7D%7D';

// NOAA ENC Online Display — IHO S-52 symbology (electronic chart look)
// Same service endpoint, different display parameters (S-52 default)
const NOAA_ECDIS_TILE_URL =
    'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=EPSG%3A3857&imageSR=EPSG%3A3857&size=256,256&format=png&transparent=true&f=image';

// LINZ Data Service — New Zealand hydrographic charts
// Requires free API key from data.linz.govt.nz
// Using the official "NZ Regional Nautical Charts" tile set (set=4758)
// which aggregates all NZ nautical chart layers into a single tile stream.
const LINZ_TILE_URL_TEMPLATE = `https://tiles-cdn.koordinates.com/services;key={LINZ_KEY}/tiles/v4/set=4758/EPSG:3857/{z}/{x}/{y}.png`;

// ── Default catalog ──

function buildCatalog(linzKey: string | null): ChartSource[] {
    return [
        {
            id: 'noaa-ncds',
            name: 'NOAA Charts',
            description: 'US nautical charts — traditional paper chart style',
            region: 'United States',
            flag: '🇺🇸',
            tileUrl: NOAA_NCDS_TILE_URL,
            requiresKey: false,
            format: 'png',
            minZoom: 3,
            maxZoom: 18,
            bounds: [-180, 17, -65, 72], // US waters including Alaska/Hawaii
            attribution: '© NOAA Office of Coast Survey',
            enabled: false,
            opacity: 0.85,
        },
        {
            id: 'noaa-ecdis',
            name: 'NOAA ECDIS',
            description: 'US charts — IHO S-52 electronic chart symbology',
            region: 'United States',
            flag: '🇺🇸',
            tileUrl: NOAA_ECDIS_TILE_URL,
            requiresKey: false,
            format: 'png',
            minZoom: 3,
            maxZoom: 18,
            bounds: [-180, 17, -65, 72],
            attribution: '© NOAA Office of Coast Survey',
            enabled: false,
            opacity: 0.85,
        },
        {
            id: 'linz-charts',
            name: 'LINZ Charts',
            description: linzKey ? 'New Zealand hydrographic charts' : 'NZ charts — requires free API key',
            region: 'New Zealand',
            flag: '🇳🇿',
            tileUrl: linzKey ? LINZ_TILE_URL_TEMPLATE.replace('{LINZ_KEY}', linzKey) : null,
            requiresKey: true,
            format: 'png',
            minZoom: 3,
            maxZoom: 18,
            bounds: [165, -48, 180, -34], // NZ waters
            attribution: '© Land Information NZ (CC-BY 4.0)',
            enabled: false,
            opacity: 0.85,
        },
    ];
}

// ── Persistence ──

interface StoredState {
    enabledSources: ChartSourceId[];
    opacities: Partial<Record<ChartSourceId, number>>;
}

function loadState(): StoredState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch {
        /* ignore */
    }
    return { enabledSources: [], opacities: {} };
}

function saveState(state: StoredState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        /* ignore */
    }
}

// ── LINZ Key Management ──
// LINZ keys are free access tokens for CC-BY 4.0 government data.
// Not a paid secret — safe to ship as a default for zero-config NZ charts.
const LINZ_DEFAULT_KEY = '2fe89f4752854178887ab9864765404d';

export function getLinzApiKey(): string | null {
    try {
        // User override → env var → built-in default
        const stored = localStorage.getItem(LINZ_KEY_STORAGE);
        if (stored) return stored;
        if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LINZ_API_KEY) {
            return import.meta.env.VITE_LINZ_API_KEY;
        }
        return LINZ_DEFAULT_KEY;
    } catch {
        return LINZ_DEFAULT_KEY;
    }
}

export function setLinzApiKey(key: string): void {
    try {
        localStorage.setItem(LINZ_KEY_STORAGE, key.trim());
        log.info(`LINZ API key saved (${key.trim().slice(0, 8)}…)`);
    } catch {
        /* ignore */
    }
}

// ── Service API ──

type CatalogChangeCallback = (sources: ChartSource[]) => void;

class ChartCatalogServiceClass {
    private sources: ChartSource[] = [];
    private listeners = new Set<CatalogChangeCallback>();
    private initialized = false;

    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;

        const linzKey = getLinzApiKey();
        this.sources = buildCatalog(linzKey);

        // Apply saved state
        const state = loadState();
        for (const src of this.sources) {
            src.enabled = state.enabledSources.includes(src.id);
            if (state.opacities[src.id] !== undefined) {
                src.opacity = state.opacities[src.id]!;
            }
        }

        log.info(`Chart catalog initialized: ${this.sources.length} sources, ${state.enabledSources.length} enabled`);
    }

    getSources(): ChartSource[] {
        if (!this.initialized) this.initialize();
        return [...this.sources];
    }

    getEnabledSources(): ChartSource[] {
        return this.getSources().filter((s) => s.enabled && s.tileUrl);
    }

    toggleSource(id: ChartSourceId): void {
        const src = this.sources.find((s) => s.id === id);
        if (!src) return;

        // Can't enable if no tile URL (missing API key)
        if (!src.enabled && !src.tileUrl) {
            log.warn(`Cannot enable ${id}: no tile URL (API key required)`);
            return;
        }

        // NOAA NCDS and ECDIS are mutually exclusive
        if (!src.enabled && (id === 'noaa-ncds' || id === 'noaa-ecdis')) {
            const otherId = id === 'noaa-ncds' ? 'noaa-ecdis' : 'noaa-ncds';
            const other = this.sources.find((s) => s.id === otherId);
            if (other) other.enabled = false;
        }

        src.enabled = !src.enabled;
        this.persist();
        this.emit();
    }

    /** Disable every source in one pass. Used by the single-select chart picker. */
    disableAll(): void {
        let changed = false;
        for (const s of this.sources) {
            if (s.enabled) {
                s.enabled = false;
                changed = true;
            }
        }
        if (changed) {
            this.persist();
            this.emit();
        }
    }

    setOpacity(id: ChartSourceId, opacity: number): void {
        const src = this.sources.find((s) => s.id === id);
        if (!src) return;
        src.opacity = Math.max(0.1, Math.min(1, opacity));
        this.persist();
        this.emit();
    }

    /** Update LINZ key and rebuild catalog */
    updateLinzKey(key: string): void {
        setLinzApiKey(key);
        const linzSource = this.sources.find((s) => s.id === 'linz-charts');
        if (linzSource) {
            linzSource.tileUrl = LINZ_TILE_URL_TEMPLATE.replace('{LINZ_KEY}', key.trim());
            linzSource.description = 'New Zealand hydrographic charts';
        }
        this.emit();
    }

    onChange(cb: CatalogChangeCallback): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private persist(): void {
        const state: StoredState = {
            enabledSources: this.sources.filter((s) => s.enabled).map((s) => s.id),
            opacities: Object.fromEntries(this.sources.map((s) => [s.id, s.opacity])) as Partial<
                Record<ChartSourceId, number>
            >,
        };
        saveState(state);
    }

    private emit(): void {
        const snapshot = [...this.sources];
        for (const cb of this.listeners) cb(snapshot);
    }
}

export const ChartCatalogService = new ChartCatalogServiceClass();
