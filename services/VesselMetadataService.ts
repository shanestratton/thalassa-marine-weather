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

import { supabase, supabaseUrl, supabaseAnonKey } from './supabase';
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
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes for found vessels
const NULL_CACHE_TTL_MS = 60 * 1000; // 60 seconds for not-found (allows on-demand re-lookup)

class VesselMetadataServiceClass {
    private cache = new Map<number, CacheEntry>();
    private pendingBatch = new Set<number>();
    private pendingOnDemand = new Set<number>(); // Prevent duplicate on-demand lookups
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

                // ── AMSA Register enrichment for Australian vessels ──
                // For any AU vessel (503xxx) with a name but missing specs,
                // check amsa_register for LOA, type, home port
                await this.enrichFromAmsaRegister(results);
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
        // Use shorter TTL for null entries (allows on-demand re-lookup)
        const ttl = entry.data === null ? NULL_CACHE_TTL_MS : CACHE_TTL_MS;
        if (Date.now() - entry.timestamp > ttl) {
            this.cache.delete(mmsi);
            return undefined;
        }
        return entry.data;
    }

    /**
     * On-demand lookup for a single vessel via the Edge Function.
     * Called when user taps a vessel not in our database.
     * The Edge Function queries external APIs and caches the result.
     */
    async onDemandLookup(mmsi: number): Promise<VesselMetadata | null> {
        // Already looking up this MMSI
        if (this.pendingOnDemand.has(mmsi)) return this.getFromCache(mmsi) ?? null;

        // Already have data cached
        const cached = this.getFromCache(mmsi);
        if (cached !== undefined && cached !== null) return cached;

        if (!supabase) return null;

        this.pendingOnDemand.add(mmsi);
        try {
            // Direct fetch to Edge Function with query params
            const fnUrl = `${supabaseUrl}/functions/v1/lookup-vessel?mmsi=${mmsi}`;
            const resp = await fetch(fnUrl, {
                headers: {
                    Authorization: `Bearer ${supabaseAnonKey}`,
                    apikey: supabaseAnonKey,
                },
                signal: AbortSignal.timeout(12000),
            });

            if (!resp.ok) {
                log.warn(`On-demand lookup failed: HTTP ${resp.status}`);
                return null;
            }

            const result = await resp.json();

            if (result.found && result.vessel_name) {
                const metadata: VesselMetadata = {
                    mmsi: result.mmsi,
                    vessel_name: result.vessel_name,
                    vessel_type: result.vessel_type ?? null,
                    flag_country: result.flag_country ?? null,
                    flag_emoji: result.flag_emoji ?? null,
                    call_sign: result.call_sign ?? null,
                    imo_number: result.imo_number ?? null,
                    loa: result.loa ?? null,
                    beam: result.beam ?? null,
                    draft: result.draft ?? null,
                    photo_url: null,
                    thumbnail_url: null,
                    data_source: result.data_source ?? result.source ?? 'edge_function',
                    is_verified: false,
                    last_scraped_at: new Date().toISOString(),
                };
                this.setCache(mmsi, metadata);
                return metadata;
            }

            return null;
        } catch (e) {
            log.warn('On-demand lookup error:', e);
            return null;
        } finally {
            this.pendingOnDemand.delete(mmsi);
        }
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

    /**
     * Enrich Australian vessels (503xxxxxx) with AMSA register data.
     * Looks up vessel by name in amsa_register table to fill LOA, type, home port.
     */
    private async enrichFromAmsaRegister(results: Map<number, VesselMetadata | null>): Promise<void> {
        if (!supabase) return;

        // Find AU vessels that have a name but are missing LOA or type
        const toEnrich: Array<{ mmsi: number; name: string }> = [];
        for (const [mmsi, meta] of results.entries()) {
            const mmsiStr = String(mmsi);
            if (!mmsiStr.startsWith('503')) continue; // Not Australian
            if (!meta?.vessel_name) continue; // No name to match

            // Only enrich if missing LOA or vessel type
            if (!meta.loa || !meta.vessel_type) {
                toEnrich.push({ mmsi, name: meta.vessel_name });
            }
        }

        if (toEnrich.length === 0) return;

        try {
            // Query AMSA register by uppercase name
            const names = toEnrich.map((v) => v.name.toUpperCase());
            const { data, error } = await supabase
                .from('amsa_register')
                .select('ship_name_upper, length_m, vessel_type, home_port')
                .in('ship_name_upper', names);

            if (error || !data) return;

            // Build lookup map
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const amsaMap = new Map<string, any>();
            for (const row of data) {
                amsaMap.set(row.ship_name_upper, row);
            }

            // Merge AMSA data into existing metadata
            for (const { mmsi, name } of toEnrich) {
                const amsa = amsaMap.get(name.toUpperCase());
                if (!amsa) continue;

                const existing = results.get(mmsi);
                if (!existing) continue;

                // Fill missing fields
                if (!existing.loa && amsa.length_m) {
                    existing.loa = amsa.length_m;
                }
                if (!existing.vessel_type && amsa.vessel_type) {
                    existing.vessel_type = amsa.vessel_type;
                }
                if (!existing.flag_country) {
                    existing.flag_country = 'Australia';
                    existing.flag_emoji = '🇦🇺';
                }
                if (!existing.data_source) {
                    existing.data_source = 'amsa_register';
                }

                // Update cache with enriched data
                this.setCache(mmsi, existing);
            }
        } catch (e) {
            log.warn('AMSA register enrichment error:', e);
        }
    }
}

export const VesselMetadataService = new VesselMetadataServiceClass();
