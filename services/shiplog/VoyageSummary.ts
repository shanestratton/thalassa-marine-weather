/**
 * VoyageSummary — server-side (or lightweight client-side) roll-up of the
 * Ship's Log so the list never has to download individual track points.
 *
 * Two-layer design:
 *   1. FAST PATH — the `get_voyage_summaries` Postgres RPC aggregates one
 *      row per voyage server-side (see the migration of the same name).
 *   2. FALLBACK — if the RPC isn't deployed yet (PGRST202 "function not
 *      found") we fetch a LIGHTWEIGHT column projection (not select('*'))
 *      and aggregate client-side via `summarizeEntries`. Still far cheaper
 *      than the old select('*') full-point pull, and means the app works
 *      before the SQL is pasted and gets faster the moment it is.
 *
 * Full per-point detail for a single voyage is loaded on demand by
 * `getVoyageEntries` — only when the user expands a card or opens its map.
 */

import { ShipLogEntry } from '../../types';
import { supabase } from '../supabase';
import { createLogger } from '../../utils/logger';
import { SHIP_LOGS_TABLE, fromDbFormat } from './helpers';

const log = createLogger('VoyageSummary');

/** One aggregated voyage — everything a collapsed VoyageCard renders. */
export interface VoyageSummary {
    voyageId: string;
    entryCount: number;
    /** ISO timestamp of the earliest entry. */
    startedAt: string;
    /** ISO timestamp of the latest entry. */
    endedAt: string;
    /** Max cumulative distance across the voyage (NM). */
    totalDistanceNM: number;
    /** Mean speed across moving entries (kts); 0 if none recorded. */
    avgSpeedKts: number;
    hasManual: boolean;
    isPlannedRoute: boolean;
    isImported: boolean;
    firstLat: number | null;
    firstLon: number | null;
    lastLat: number | null;
    lastLon: number | null;
    /** is_on_water of the earliest entry (drives card title coloring). */
    firstIsOnWater: boolean | null;
}

/**
 * Pure client-side aggregation — the fallback core, and the unit-tested
 * contract the RPC mirrors. Groups a flat entry list into one summary per
 * voyageId. Newest voyage first (by latest entry timestamp).
 */
export function summarizeEntries(entries: ShipLogEntry[]): VoyageSummary[] {
    const byVoyage = new Map<string, ShipLogEntry[]>();
    for (const e of entries) {
        const vid = e.voyageId || 'default_voyage';
        const list = byVoyage.get(vid);
        if (list) list.push(e);
        else byVoyage.set(vid, [e]);
    }

    const summaries: VoyageSummary[] = [];
    for (const [voyageId, list] of byVoyage) {
        // Sort oldest→newest once; derive first/last + bounds from it.
        const sorted = [...list].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const first = sorted[0];
        const last = sorted[sorted.length - 1];

        let totalDistanceNM = 0;
        let speedSum = 0;
        let speedCount = 0;
        let hasManual = false;
        let isPlannedRoute = false;
        let isImported = false;

        for (const e of list) {
            if (e.cumulativeDistanceNM && e.cumulativeDistanceNM > totalDistanceNM) {
                totalDistanceNM = e.cumulativeDistanceNM;
            }
            if (e.speedKts && e.speedKts > 0) {
                speedSum += e.speedKts;
                speedCount += 1;
            }
            if (e.entryType === 'manual') hasManual = true;
            if (e.source === 'planned_route') isPlannedRoute = true;
            else if (e.source && e.source !== 'device') isImported = true;
        }

        summaries.push({
            voyageId,
            entryCount: list.length,
            startedAt: first?.timestamp ?? last?.timestamp ?? new Date(0).toISOString(),
            endedAt: last?.timestamp ?? first?.timestamp ?? new Date(0).toISOString(),
            totalDistanceNM,
            avgSpeedKts: speedCount > 0 ? speedSum / speedCount : 0,
            hasManual,
            isPlannedRoute,
            isImported,
            firstLat: first?.latitude ?? null,
            firstLon: first?.longitude ?? null,
            lastLat: last?.latitude ?? null,
            lastLon: last?.longitude ?? null,
            firstIsOnWater: first?.isOnWater ?? null,
        });
    }

    summaries.sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime());
    return summaries;
}

// Once we learn the RPC isn't deployed, stop hammering it with calls that
// will only 404 — flip to the fallback for the rest of the session.
let rpcUnavailable = false;

/** Map a raw RPC row (snake_case) to a VoyageSummary. */
function fromRpcRow(row: Record<string, unknown>): VoyageSummary {
    return {
        voyageId: String(row.voyage_id ?? ''),
        entryCount: Number(row.entry_count ?? 0),
        startedAt: String(row.started_at ?? new Date(0).toISOString()),
        endedAt: String(row.ended_at ?? new Date(0).toISOString()),
        totalDistanceNM: Number(row.total_distance_nm ?? 0),
        avgSpeedKts: Number(row.avg_speed_kts ?? 0),
        hasManual: Boolean(row.has_manual),
        isPlannedRoute: Boolean(row.is_planned_route),
        isImported: Boolean(row.is_imported),
        firstLat: row.first_lat == null ? null : Number(row.first_lat),
        firstLon: row.first_lon == null ? null : Number(row.first_lon),
        lastLat: row.last_lat == null ? null : Number(row.last_lat),
        lastLon: row.last_lon == null ? null : Number(row.last_lon),
        firstIsOnWater: row.first_is_on_water == null ? null : Boolean(row.first_is_on_water),
    };
}

/**
 * Lightweight projection columns — everything summarizeEntries needs and
 * nothing it doesn't (no notes, weather blobs, formatted strings, …).
 */
const SUMMARY_COLUMNS =
    'voyage_id, timestamp, latitude, longitude, cumulative_distance_nm, speed_kts, entry_type, source, is_on_water, archived';

const FALLBACK_PAGE_SIZE = 1000;
const FALLBACK_MAX_ROWS = 200_000;

/**
 * Fetch one summary per voyage. Tries the server-side RPC first; on
 * "function not found" (or any RPC error) falls back to a lightweight
 * projection fetch aggregated client-side.
 */
export async function getVoyageSummaries(includeArchived = false): Promise<VoyageSummary[]> {
    if (!supabase) return [];

    if (!rpcUnavailable) {
        try {
            const { data, error } = await supabase.rpc('get_voyage_summaries', {
                p_include_archived: includeArchived,
            });
            if (error) {
                // PGRST202 = function not found in schema cache (not deployed yet).
                if (error.code === 'PGRST202' || /function .* does not exist/i.test(error.message)) {
                    log.warn('get_voyage_summaries RPC not deployed — using client-side fallback');
                    rpcUnavailable = true;
                } else {
                    log.warn('get_voyage_summaries RPC error, falling back:', error.message);
                }
            } else if (Array.isArray(data)) {
                return data.map((r) => fromRpcRow(r as Record<string, unknown>));
            }
        } catch (e) {
            log.warn('get_voyage_summaries RPC threw, falling back:', e);
        }
    }

    return summariesFromProjection(includeArchived);
}

/** Fallback path: paginate the lightweight projection, aggregate locally. */
async function summariesFromProjection(includeArchived: boolean): Promise<VoyageSummary[]> {
    if (!supabase) return [];
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return [];

        const rows: Record<string, unknown>[] = [];
        let offset = 0;
        while (rows.length < FALLBACK_MAX_ROWS) {
            let q = supabase
                .from(SHIP_LOGS_TABLE)
                .select(SUMMARY_COLUMNS)
                .eq('user_id', user.id)
                .order('timestamp', { ascending: false })
                .range(offset, offset + FALLBACK_PAGE_SIZE - 1);
            if (!includeArchived) q = q.or('archived.is.null,archived.eq.false');

            const { data, error } = await q;
            if (error) {
                log.warn('summary projection page failed:', error.message);
                break;
            }
            const page = data || [];
            rows.push(...(page as Record<string, unknown>[]));
            if (page.length < FALLBACK_PAGE_SIZE) break;
            offset += FALLBACK_PAGE_SIZE;
        }

        const entries = rows.map((r) => fromDbFormat(r));
        return summarizeEntries(entries);
    } catch (e) {
        log.warn('summariesFromProjection failed:', e);
        return [];
    }
}

/**
 * Lazy-load the FULL entry list for a single voyage — called when the user
 * expands a card or opens its track map. Bounded; newest-first.
 */
export async function getVoyageEntries(voyageId: string, includeArchived = false): Promise<ShipLogEntry[]> {
    if (!supabase || !voyageId) return [];
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return [];

        const all: ShipLogEntry[] = [];
        let offset = 0;
        const PAGE = 1000;
        const MAX = 500_000;
        while (all.length < MAX) {
            let q = supabase
                .from(SHIP_LOGS_TABLE)
                .select('*')
                .eq('user_id', user.id)
                .eq('voyage_id', voyageId)
                .order('timestamp', { ascending: false })
                .range(offset, offset + PAGE - 1);
            if (!includeArchived) q = q.or('archived.is.null,archived.eq.false');

            const { data, error } = await q;
            if (error) {
                log.warn('getVoyageEntries page failed:', error.message);
                break;
            }
            const page = data || [];
            all.push(...page.map((row) => fromDbFormat(row)));
            if (page.length < PAGE) break;
            offset += PAGE;
        }
        return all;
    } catch (e) {
        log.warn('getVoyageEntries failed:', e);
        return [];
    }
}

/** Test-only: reset the RPC-availability latch between cases. */
export function __resetRpcLatchForTests() {
    rpcUnavailable = false;
}
