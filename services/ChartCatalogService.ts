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
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

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
            tileUrl: linzKey ? linzTileUrl(linzKey) : null,
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

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

function loadState(scope: AuthIdentityScope): StoredState {
    if (!isAuthIdentityScopeCurrent(scope)) return { enabledSources: [], opacities: {} };
    try {
        const raw = localStorage.getItem(authScopedStorageKey(STORAGE_KEY, scope));
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<StoredState>;
            const validIds = new Set<ChartSourceId>(['noaa-ncds', 'noaa-ecdis', 'linz-charts', 'openseamap']);
            const enabledSources = Array.isArray(parsed.enabledSources)
                ? parsed.enabledSources.filter((id): id is ChartSourceId => validIds.has(id as ChartSourceId))
                : [];
            const opacities: StoredState['opacities'] = {};
            if (parsed.opacities && typeof parsed.opacities === 'object') {
                for (const id of validIds) {
                    const opacity = parsed.opacities[id];
                    if (typeof opacity === 'number' && Number.isFinite(opacity)) {
                        opacities[id] = Math.max(0.1, Math.min(1, opacity));
                    }
                }
            }
            return { enabledSources, opacities };
        }
    } catch {
        /* ignore */
    }
    return { enabledSources: [], opacities: {} };
}

function saveState(state: StoredState, scope: AuthIdentityScope): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    try {
        localStorage.setItem(authScopedStorageKey(STORAGE_KEY, scope), JSON.stringify(state));
    } catch {
        /* ignore */
    }
}

// ── LINZ Key Management ──
// LINZ keys are free access tokens for CC-BY 4.0 government data.
// Not a paid secret — safe to ship as a default for zero-config NZ charts.
const LINZ_DEFAULT_KEY = '2fe89f4752854178887ab9864765404d';

function purgeUnownedLegacyKey(): void {
    try {
        // The historical key had no owner marker. Assigning it to whichever
        // account happens to sign in next would disclose one user's override
        // to another, so it is retired rather than guessed.
        localStorage.removeItem(LINZ_KEY_STORAGE);
    } catch {
        /* ignore */
    }
}

function normalizeLinzKey(key: string): string | null {
    const normalized = key.trim();
    return normalized.length >= 8 && normalized.length <= 256 ? normalized : null;
}

function linzTileUrl(key: string): string {
    return LINZ_TILE_URL_TEMPLATE.replace('{LINZ_KEY}', encodeURIComponent(key));
}

export function getLinzApiKey(scope: AuthIdentityScope = getAuthIdentityScope()): string | null {
    if (!isAuthIdentityScopeCurrent(scope)) return LINZ_DEFAULT_KEY;
    try {
        purgeUnownedLegacyKey();
        // Current account's override → env var → built-in default.
        const stored = localStorage.getItem(authScopedStorageKey(LINZ_KEY_STORAGE, scope));
        const normalizedStored = stored ? normalizeLinzKey(stored) : null;
        if (normalizedStored) return normalizedStored;
        if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LINZ_API_KEY) {
            return import.meta.env.VITE_LINZ_API_KEY;
        }
        return LINZ_DEFAULT_KEY;
    } catch {
        return LINZ_DEFAULT_KEY;
    }
}

export function setLinzApiKey(key: string, scope: AuthIdentityScope = getAuthIdentityScope()): boolean {
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    const normalized = normalizeLinzKey(key);
    if (!normalized) return false;
    try {
        purgeUnownedLegacyKey();
        localStorage.setItem(authScopedStorageKey(LINZ_KEY_STORAGE, scope), normalized);
        log.info('LINZ API key override saved for the active account');
        return true;
    } catch {
        return false;
    }
}

// ── Service API ──

type CatalogChangeCallback = (sources: ChartSource[]) => void;

class ChartCatalogServiceClass {
    private sources: ChartSource[] = [];
    private listeners = new Set<CatalogChangeCallback>();
    private initialized = false;
    private scope = getAuthIdentityScope();

    constructor() {
        subscribeAuthIdentityScope((next) => {
            const wasInitialized = this.initialized;
            this.scope = next;
            this.sources = [];
            if (wasInitialized) this.hydrate(next);
            this.emit();
        });
    }

    initialize(scope: AuthIdentityScope = getAuthIdentityScope()): void {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (this.initialized && sameScope(this.scope, scope)) return;
        this.initialized = true;
        this.hydrate(scope);
    }

    private hydrate(scope: AuthIdentityScope): void {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        this.scope = scope;
        const linzKey = getLinzApiKey(scope);
        this.sources = buildCatalog(linzKey);

        // Apply saved state
        const state = loadState(scope);
        for (const src of this.sources) {
            src.enabled = state.enabledSources.includes(src.id);
            if (state.opacities[src.id] !== undefined) {
                src.opacity = state.opacities[src.id]!;
            }
        }

        log.info(`Chart catalog initialized: ${this.sources.length} sources, ${state.enabledSources.length} enabled`);
    }

    private accepts(scope: AuthIdentityScope): boolean {
        this.initialize(scope);
        return isAuthIdentityScopeCurrent(scope) && sameScope(this.scope, scope);
    }

    getSources(scope: AuthIdentityScope = getAuthIdentityScope()): ChartSource[] {
        if (!this.accepts(scope)) return [];
        return this.sources.map((source) => ({ ...source }));
    }

    getEnabledSources(scope: AuthIdentityScope = getAuthIdentityScope()): ChartSource[] {
        return this.getSources(scope).filter((s) => s.enabled && s.tileUrl);
    }

    toggleSource(id: ChartSourceId, scope: AuthIdentityScope = getAuthIdentityScope()): void {
        if (!this.accepts(scope)) return;
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
        this.persist(scope);
        this.emit();
    }

    /** Disable every source in one pass. Used by the single-select chart picker. */
    disableAll(scope: AuthIdentityScope = getAuthIdentityScope()): void {
        if (!this.accepts(scope)) return;
        let changed = false;
        for (const s of this.sources) {
            if (s.enabled) {
                s.enabled = false;
                changed = true;
            }
        }
        if (changed) {
            this.persist(scope);
            this.emit();
        }
    }

    setOpacity(id: ChartSourceId, opacity: number, scope: AuthIdentityScope = getAuthIdentityScope()): void {
        if (!this.accepts(scope)) return;
        const src = this.sources.find((s) => s.id === id);
        if (!src) return;
        src.opacity = Math.max(0.1, Math.min(1, opacity));
        this.persist(scope);
        this.emit();
    }

    /** Update LINZ key and rebuild catalog */
    updateLinzKey(key: string, scope: AuthIdentityScope = getAuthIdentityScope()): boolean {
        if (!this.accepts(scope) || !setLinzApiKey(key, scope)) return false;
        const linzSource = this.sources.find((s) => s.id === 'linz-charts');
        if (linzSource) {
            linzSource.tileUrl = linzTileUrl(key.trim());
            linzSource.description = 'New Zealand hydrographic charts';
        }
        this.emit();
        return true;
    }

    onChange(cb: CatalogChangeCallback): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private persist(scope: AuthIdentityScope): void {
        if (!this.accepts(scope)) return;
        const state: StoredState = {
            enabledSources: this.sources.filter((s) => s.enabled).map((s) => s.id),
            opacities: Object.fromEntries(this.sources.map((s) => [s.id, s.opacity])) as Partial<
                Record<ChartSourceId, number>
            >,
        };
        saveState(state, scope);
    }

    private emit(): void {
        const snapshot = this.sources.map((source) => ({ ...source }));
        for (const cb of this.listeners) {
            try {
                cb(snapshot);
            } catch (error) {
                log.warn('Chart catalog listener failed:', error);
            }
        }
    }
}

export const ChartCatalogService = new ChartCatalogServiceClass();
