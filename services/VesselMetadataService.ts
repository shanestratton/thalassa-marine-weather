/**
 * VesselMetadataService — Client-side vessel intelligence lookup
 *
 * Queries the `vessel_metadata` table (populated by the Railway scraper)
 * to enrich AIS targets with vessel name, flag, photo, and dimensions.
 *
 * Features:
 * - LRU cache (max 500 vessels, 10-min TTL)
 * - Batch lookup (up to 50 MMSIs at once)
 * - Instant MMSI decoding for flag fallback (no server round-trip)
 * - Premium-gated: full data only for premium users
 */

import { supabase } from './supabase';
import { decodeMmsi, getMmsiFlag, type MmsiDecodedResult } from '../utils/MmsiDecoder';
import { createLogger } from '../utils/createLogger';

const log = createLogger('VesselMetadata');

// ── Types ──

export interface VesselMetadata {
    mmsi: number;
    vessel_name: string | null;
    vessel_type: string | null;
    flag_country: string | null;
    flag_emoji: string | null;
    call_sign: string | null;
    imo_number: number | null;
    loa: number | null;
    beam: number | null;
    draft: number | null;
    photo_url: string | null;
    thumbnail_url: string | null;
    data_source: string | null;
    is_verified: boolean;
    last_scraped_at: string;
}

/** Enriched vessel info for the UI — always available (falls back to MMSI decode) */
export interface VesselIntel {
    /** Vessel name or null if unknown */
    name: string | null;
    /** Flag emoji — always available (from MMSI decode) */
    flag: string;
    /** Country name — always available */
    country: string;
    /** Thumbnail URL or null */
    thumbnail: string | null;
    /** Full metadata if available */
    metadata: VesselMetadata | null;
    /** MMSI decode result */
    decoded: MmsiDecodedResult;
    /** Whether data came from the scraper (vs MMSI decode only) */
    isEnriched: boolean;
}

// ── Cache ──

interface CacheEntry {
    data: VesselMetadata | null;
    timestamp: number;
}

const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

class VesselMetadataServiceClass {
    private cache = new Map<number, CacheEntry>();
    private pendingBatch = new Set<number>();
    private batchTimer: ReturnType<typeof setTimeout> | null = null;
    private batchResolvers: Array<() => void> = [];

    /**
     * Get enriched vessel intelligence for an MMSI.
     * Returns immediately with MMSI decode; enriches from DB if cached.
     */
    getVesselIntel(mmsi: number): VesselIntel {
        const decoded = decodeMmsi(mmsi);
        const cached = this.getFromCache(mmsi);

        if (cached !== undefined) {
            return {
                name: cached?.vessel_name ?? null,
                flag: cached?.flag_emoji ?? decoded.flag,
                country: cached?.flag_country ?? decoded.country,
                thumbnail: cached?.thumbnail_url ?? null,
                metadata: cached,
                decoded,
                isEnriched: cached !== null,
            };
        }

        // Not cached — schedule background fetch, return MMSI decode for now
        this.scheduleBatchFetch(mmsi);

        return {
            name: null,
            flag: decoded.flag,
            country: decoded.country,
            thumbnail: null,
            metadata: null,
            decoded,
            isEnriched: false,
        };
    }

    /**
     * Get just the flag emoji for quick map label rendering.
     * Zero latency — pure MMSI decode.
     */
    getFlag(mmsi: number): string {
        return getMmsiFlag(mmsi);
    }

    /**
     * Batch lookup vessel metadata for multiple MMSIs.
     * Returns a Map of MMSI → VesselMetadata (or null if not found).
     */
    async batchLookup(mmsis: number[]): Promise<Map<number, VesselMetadata | null>> {
        const results = new Map<number, VesselMetadata | null>();
        const toFetch: number[] = [];

        // Check cache first
        for (const mmsi of mmsis) {
            const cached = this.getFromCache(mmsi);
            if (cached !== undefined) {
                results.set(mmsi, cached);
            } else {
                toFetch.push(mmsi);
            }
        }

        // Fetch uncached from Supabase
        if (toFetch.length > 0 && supabase) {
            try {
                const { data, error } = await supabase.rpc('lookup_vessel_metadata', {
                    mmsi_list: toFetch,
                });

                if (error) {
                    log.warn('Batch lookup failed:', error.message);
                } else if (data) {
                    const records = data as VesselMetadata[];
                    const found = new Set<number>();

                    for (const record of records) {
                        this.setCache(record.mmsi, record);
                        results.set(record.mmsi, record);
                        found.add(record.mmsi);
                    }

                    // Cache misses as null (so we don't re-fetch)
                    for (const mmsi of toFetch) {
                        if (!found.has(mmsi)) {
                            this.setCache(mmsi, null);
                            results.set(mmsi, null);
                        }
                    }
                }
            } catch (e) {
                log.warn('Batch lookup error:', e);
            }
        }

        return results;
    }

    // ── Private ──

    private getFromCache(mmsi: number): VesselMetadata | null | undefined {
        const entry = this.cache.get(mmsi);
        if (!entry) return undefined;
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            this.cache.delete(mmsi);
            return undefined;
        }
        return entry.data;
    }

    private setCache(mmsi: number, data: VesselMetadata | null): void {
        // Evict oldest if at capacity
        if (this.cache.size >= CACHE_MAX_SIZE) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(mmsi, { data, timestamp: Date.now() });
    }

    /**
     * Schedule a background batch fetch. Collects MMSIs for 500ms
     * then fires a single batch query.
     */
    private scheduleBatchFetch(mmsi: number): void {
        this.pendingBatch.add(mmsi);

        if (this.batchTimer) return; // Already scheduled

        this.batchTimer = setTimeout(async () => {
            const batch = Array.from(this.pendingBatch).slice(0, 50);
            this.pendingBatch.clear();
            this.batchTimer = null;

            if (batch.length > 0) {
                await this.batchLookup(batch);
                // Notify waiting resolvers
                for (const resolve of this.batchResolvers) {
                    resolve();
                }
                this.batchResolvers = [];
            }
        }, 500);
    }

    /** Clear the entire cache */
    clearCache(): void {
        this.cache.clear();
    }
}

export const VesselMetadataService = new VesselMetadataServiceClass();
