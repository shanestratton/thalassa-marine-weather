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
import { supabase, getCurrentUserId } from '../supabase';
import { getCachedSummaries, setCachedSummaries } from './VoyageSummaryCache';
import { createLogger } from '../../utils/createLogger';
import { SHIP_LOGS_TABLE, fromDbFormat } from './helpers';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import {
    applyVoyageArchiveIntentOverlay,
    filterVoyageTombstonedEntries,
    getVoyageArchiveIntentSnapshot,
    type VoyageArchiveIntentSnapshot,
} from './OfflineQueue';

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
    /**
     * Fraction of this voyage's entries (that carry is_on_water data) which
     * are on LAND. null when no entry has water data. Used by the career
     * roll-up to exclude land tracks (car drives) via majority vote —
     * preserves the old per-entry filter now that the list is summary-driven.
     */
    landFraction: number | null;
}

const DEFAULT_VOYAGE_ID = 'default_voyage';

/**
 * NULL and the historical empty-string value both mean "ungrouped". Some
 * clients also wrote the UI sentinel literally, so reads deliberately fold
 * all three representations into one bucket.
 */
function normalizeVoyageId(value: unknown): string {
    return typeof value === 'string' && value.length > 0 ? value : DEFAULT_VOYAGE_ID;
}

/**
 * Pure client-side aggregation — the fallback core, and the unit-tested
 * contract the RPC mirrors. Groups a flat entry list into one summary per
 * voyageId. Newest voyage first (by latest entry timestamp).
 */
export function summarizeEntries(entries: ShipLogEntry[]): VoyageSummary[] {
    const byVoyage = new Map<string, ShipLogEntry[]>();
    for (const e of entries) {
        const vid = normalizeVoyageId(e.voyageId);
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
        let waterDataCount = 0;
        let landCount = 0;

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
            if (e.isOnWater === true) waterDataCount += 1;
            else if (e.isOnWater === false) {
                waterDataCount += 1;
                landCount += 1;
            }
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
            landFraction: waterDataCount > 0 ? landCount / waterDataCount : null,
        });
    }

    summaries.sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime());
    return summaries;
}

/**
 * Overlay locally-held entries onto a server summary list.
 *
 * The list is driven by server `summaries`, but two kinds of voyage carry
 * fresher truth in local `entries` than the server roll-up does:
 *   - the ACTIVE live-tracking voyage (its points are streaming into
 *     state, some not yet synced to the cloud), and
 *   - any voyage the user EXPANDED (we lazy-loaded its full points).
 *
 * For every voyageId present in `entries`, recompute its summary from
 * those points and replace the server copy (or insert it if the server
 * hasn't seen the voyage yet — e.g. a brand-new active voyage). Voyages
 * with no local entries pass through untouched. Result stays newest-first.
 *
 * Pure + testable.
 */
export function mergeSummariesWithLive(summaries: VoyageSummary[], entries: ShipLogEntry[]): VoyageSummary[] {
    if (entries.length === 0) return summaries;

    const liveByVoyage = new Map<string, VoyageSummary>();
    for (const s of summarizeEntries(entries)) {
        liveByVoyage.set(s.voyageId, s);
    }

    const out: VoyageSummary[] = [];
    const usedLive = new Set<string>();
    for (const s of summaries) {
        const live = liveByVoyage.get(s.voyageId);
        if (live) {
            out.push(live);
            usedLive.add(s.voyageId);
        } else {
            out.push(s);
        }
    }
    // Voyages present locally but not (yet) in the server summary list.
    for (const [vid, live] of liveByVoyage) {
        if (!usedLive.has(vid)) out.push(live);
    }

    out.sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime());
    return out;
}

// Once we learn the RPC isn't deployed, stop hammering it with calls that
// will only 404 — flip to the fallback for the rest of the session.
let rpcUnavailable = false;

/** Map a raw RPC row (snake_case) to a VoyageSummary. */
function fromRpcRow(row: Record<string, unknown>): VoyageSummary {
    return {
        voyageId: normalizeVoyageId(row.voyage_id),
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
        // land_fraction is added by a newer RPC revision; an older deployed
        // function simply omits it → null → the voyage counts as maritime
        // (fail-open), same as "no water data".
        landFraction: row.land_fraction == null ? null : Number(row.land_fraction),
    };
}

// ── Land vs sea classification ──────────────────────────────────────
// A voyage is "on land" (a car drive, a walk) when the majority of its
// water-tagged fixes are on land. Land voyages are shown in green and
// excluded from the career tiles (distance / time at sea / voyages);
// sea voyages are blue and count. landFraction == null means no water
// data was captured — fail OPEN to sea (don't drop real passages).
export const LAND_VOYAGE_FRACTION = 0.6;

export function isLandVoyage(s: Pick<VoyageSummary, 'landFraction'>): boolean {
    return s.landFraction != null && s.landFraction >= LAND_VOYAGE_FRACTION;
}

/** Counts toward career stats: the sailor's own, sailed, water-majority voyage. */
export function isMaritimeVoyage(s: Pick<VoyageSummary, 'isImported' | 'isPlannedRoute' | 'landFraction'>): boolean {
    return !s.isImported && !s.isPlannedRoute && !isLandVoyage(s);
}

/** Career roll-up output — the shape the Log's career panel renders. */
export interface CareerTotals {
    totalDistance: number;
    totalTimeAtSeaHrs: number;
    totalVoyages: number;
}

/**
 * Compute career totals from voyage SUMMARIES — accurate across the WHOLE
 * history (no 10k-row cap). Counts only the sailor's own maritime voyages:
 *   - own: not imported, not a planned/suggested route
 *   - maritime: landFraction is null (no water data → assume water,
 *     fail-open) OR < 0.6 (majority of fixes on water) — mirrors the old
 *     per-entry majority vote that kept car drives out of sea miles.
 *
 * Pure + testable.
 */
export function careerTotalsFromSummaries(summaries: VoyageSummary[]): CareerTotals {
    let totalDistance = 0;
    let timeMs = 0;
    let totalVoyages = 0;

    for (const s of summaries) {
        if (!isMaritimeVoyage(s)) continue;

        totalVoyages += 1;
        totalDistance += s.totalDistanceNM || 0;
        const start = new Date(s.startedAt).getTime();
        const end = new Date(s.endedAt).getTime();
        if (isFinite(start) && isFinite(end) && end > start) timeMs += end - start;
    }

    return {
        totalDistance,
        totalTimeAtSeaHrs: Math.round((timeMs / (1000 * 60 * 60)) * 10) / 10,
        totalVoyages,
    };
}

// ── Planned-vs-actual matching ──────────────────────────────────────

/** Equirectangular NM between two lat/lon — fine at passage scale. */
function approxNM(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const dLat = bLat - aLat;
    const dLon = (bLon - aLon) * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon) * 60; // 1° ≈ 60 NM
}

/**
 * Find the planned route that best matches a sailed voyage, by START and
 * END coordinates (robust where the old voyage_name→label string-join is
 * fragile — no FK, suffix-trimming and arrow-spacing drift break it).
 * A planned route matches when BOTH its first point is within toleranceNM
 * of the sailed first point AND its last within toleranceNM of the sailed
 * last. Returns the closest match's voyageId, or null. Pure + testable.
 */
export function matchPlannedRouteByCoords(
    sailed: VoyageSummary,
    candidates: VoyageSummary[],
    toleranceNM = 3,
): string | null {
    if (sailed.firstLat == null || sailed.firstLon == null || sailed.lastLat == null || sailed.lastLon == null) {
        return null;
    }
    let best: string | null = null;
    let bestScore = Infinity;
    for (const c of candidates) {
        if (!c.isPlannedRoute || c.voyageId === sailed.voyageId) continue;
        if (c.firstLat == null || c.firstLon == null || c.lastLat == null || c.lastLon == null) continue;
        const dStart = approxNM(sailed.firstLat, sailed.firstLon, c.firstLat, c.firstLon);
        const dEnd = approxNM(sailed.lastLat, sailed.lastLon, c.lastLat, c.lastLon);
        if (dStart > toleranceNM || dEnd > toleranceNM) continue;
        const score = dStart + dEnd;
        if (score < bestScore) {
            bestScore = score;
            best = c.voyageId;
        }
    }
    return best;
}

// ── Personal records ────────────────────────────────────────────────
// Career-wide bests, derived purely from voyage SUMMARIES (no full
// entry load). Top-speed-ever and biggest-day's-run need per-point /
// per-day data the summary doesn't carry — deferred to a future RPC
// field. These three are honest from summary data alone.

export interface PersonalRecords {
    longestPassageNM: number;
    longestPassageVoyageId: string | null;
    fastestAvgKts: number;
    fastestVoyageId: string | null;
    longestDurationMs: number;
    longestDurationVoyageId: string | null;
    /** Voyages counted (own maritime, sailed) — 0 ⇒ render the empty state. */
    voyageCount: number;
}

/**
 * Pure rollup of career records over voyage summaries. Counts only the
 * sailor's own maritime voyages (not imported, not planned, water
 * majority) — the same filter careerTotalsFromSummaries uses — so a car
 * drive or a saved route never sets a "record".
 */
export function computePersonalRecords(summaries: VoyageSummary[]): PersonalRecords {
    const rec: PersonalRecords = {
        longestPassageNM: 0,
        longestPassageVoyageId: null,
        fastestAvgKts: 0,
        fastestVoyageId: null,
        longestDurationMs: 0,
        longestDurationVoyageId: null,
        voyageCount: 0,
    };
    for (const s of summaries) {
        if (s.isImported || s.isPlannedRoute) continue;
        const isMaritime = s.landFraction == null || s.landFraction < 0.6;
        if (!isMaritime) continue;
        rec.voyageCount += 1;

        if ((s.totalDistanceNM || 0) > rec.longestPassageNM) {
            rec.longestPassageNM = s.totalDistanceNM || 0;
            rec.longestPassageVoyageId = s.voyageId;
        }
        if ((s.avgSpeedKts || 0) > rec.fastestAvgKts) {
            rec.fastestAvgKts = s.avgSpeedKts || 0;
            rec.fastestVoyageId = s.voyageId;
        }
        const start = new Date(s.startedAt).getTime();
        const end = new Date(s.endedAt).getTime();
        const dur = isFinite(start) && isFinite(end) && end > start ? end - start : 0;
        if (dur > rec.longestDurationMs) {
            rec.longestDurationMs = dur;
            rec.longestDurationVoyageId = s.voyageId;
        }
    }
    return rec;
}

// ── Empty-track auto-prune ──────────────────────────────────────────
// A voyage that recorded but never went anywhere — distance rounds to
// "0.0 NM". Almost always an accidental start/stop or a cold-start that
// never got a real fix; clutter the user asked to have swept away.
/** Distance below which a track reads "0.0 NM" (rounds at 1 dp). */
export const EMPTY_TRACK_NM = 0.05;
/** A voyage touched this recently might still be recording (this or another device). */
export const RECENT_ACTIVE_MS = 15 * 60 * 1000;

/**
 * Pick voyages safe to auto-delete: genuinely zero-distance device
 * tracks that nobody is still recording and that carry no deliberate
 * content. PURE + testable — the guards are the whole safety story:
 *
 *   - totalDistanceNM is max(cumulative), which is MONOTONIC, so an
 *     out-and-back passage (returns to the same dock) or a legacy
 *     resume-corrupted voyage still reads well above zero. Only a
 *     never-moved track reads < EMPTY_TRACK_NM. (This is why we key on
 *     distance, not first↔last displacement.)
 *   - never the active voyage on THIS device (activeVoyageId), nor one
 *     whose latest entry is within RECENT_ACTIVE_MS (might be live on
 *     ANOTHER device sharing the backend).
 *   - never planned routes or imported tracks (not sailed telemetry).
 *   - never a voyage with a manual entry — the user logged something
 *     deliberately, so it's not junk even if the boat didn't move.
 */
export function selectEmptyVoyagesToPrune(
    summaries: VoyageSummary[],
    opts: { activeVoyageId?: string | null; nowMs: number },
): string[] {
    const { activeVoyageId, nowMs } = opts;
    const out: string[] = [];
    for (const s of summaries) {
        if (s.totalDistanceNM >= EMPTY_TRACK_NM) continue;
        if (s.voyageId === activeVoyageId) continue;
        if (s.isPlannedRoute || s.isImported) continue;
        if (s.hasManual) continue;
        const endedMs = Date.parse(s.endedAt);
        if (Number.isFinite(endedMs) && nowMs - endedMs < RECENT_ACTIVE_MS) continue;
        out.push(s.voyageId);
    }
    return out;
}

/**
 * Lightweight projection columns — everything summarizeEntries needs and
 * nothing it doesn't (no notes, weather blobs, formatted strings, …).
 */
const SUMMARY_COLUMNS =
    'id, user_id, voyage_id, timestamp, latitude, longitude, cumulative_distance_nm, speed_kts, entry_type, source, is_on_water, archived';

const FALLBACK_PAGE_SIZE = 1000;
const FALLBACK_MAX_ROWS = 200_000;
const DETAIL_MAX_ROWS = 500_000;

interface SummaryTruthEnvelope extends Partial<ShipLogEntry> {
    summary: VoyageSummary;
    voyageId: string;
    timestamp: string;
    archived: boolean;
}

/**
 * Apply durable local delete/archive truth to aggregate rows. Using startedAt
 * as the default-voyage boundary is intentionally conservative for cache/RPC
 * payloads: an aggregate that may contain a pre-delete row is hidden until a
 * row-level refresh can rebuild the post-delete bucket.
 */
async function applySummaryReadTruth(
    summaries: VoyageSummary[],
    includeArchived: boolean,
    scope: AuthIdentityScope,
): Promise<VoyageSummary[]> {
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    const envelopes: SummaryTruthEnvelope[] = summaries.map((summary) => ({
        summary,
        voyageId: normalizeVoyageId(summary.voyageId),
        timestamp: summary.startedAt,
        archived: false,
    }));
    const notDeleted = await filterVoyageTombstonedEntries(envelopes, scope);
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    const overlaid = await applyVoyageArchiveIntentOverlay(notDeleted, scope);
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    return overlaid
        .filter((row) => includeArchived || row.archived !== true)
        .map((row) => ({ ...row.summary, voyageId: normalizeVoyageId(row.summary.voyageId) }));
}

function targetMatchesRow(targetVoyageId: string, rowVoyageId: unknown): boolean {
    return normalizeVoyageId(rowVoyageId) === targetVoyageId;
}

/**
 * Fetch rows first, then apply owner-scoped local truth before aggregating.
 * queryArchived controls the SQL projection; includeArchived controls what is
 * returned after the durable archive overlay. They intentionally differ for
 * a pending unarchive, whose cloud rows may still be archived.
 */
async function fetchVisibleProjectionEntries(
    scope: AuthIdentityScope,
    options: {
        targetVoyageId?: string;
        queryArchived: boolean;
        includeArchived: boolean;
        columns?: string;
        maxRows?: number;
    },
): Promise<ShipLogEntry[]> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return [];
    const targetVoyageId = options.targetVoyageId ? normalizeVoyageId(options.targetVoyageId.trim()) : undefined;
    const maxRows = options.maxRows ?? FALLBACK_MAX_ROWS;
    const rows: Record<string, unknown>[] = [];
    let offset = 0;

    while (rows.length < maxRows) {
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        let query = supabase
            .from(SHIP_LOGS_TABLE)
            .select(options.columns ?? SUMMARY_COLUMNS)
            .eq('user_id', scope.userId);
        if (targetVoyageId === DEFAULT_VOYAGE_ID) {
            query = query.or('voyage_id.is.null,voyage_id.eq.,voyage_id.eq.default_voyage');
        } else if (targetVoyageId) {
            query = query.eq('voyage_id', targetVoyageId);
        }
        if (!options.queryArchived) query = query.or('archived.is.null,archived.eq.false');
        query = query
            .order('timestamp', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + FALLBACK_PAGE_SIZE - 1);

        const { data, error } = await query;
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        if (error) {
            log.warn('voyage projection page failed:', error.message);
            break;
        }
        const page = (data || []) as unknown as Record<string, unknown>[];
        if (
            page.some(
                (row) =>
                    row.user_id !== scope.userId ||
                    (targetVoyageId !== undefined && !targetMatchesRow(targetVoyageId, row.voyage_id)),
            )
        ) {
            log.warn('voyage projection returned a row outside the requested owner/voyage');
            return [];
        }
        rows.push(...page);
        if (page.length < FALLBACK_PAGE_SIZE) break;
        offset += FALLBACK_PAGE_SIZE;
    }

    if (!isAuthIdentityScopeCurrent(scope)) return [];
    let entries = rows.map((row) => {
        const entry = fromDbFormat(row);
        entry.voyageId = normalizeVoyageId(row.voyage_id);
        return entry;
    });
    entries = await filterVoyageTombstonedEntries(entries, scope);
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    entries = await applyVoyageArchiveIntentOverlay(entries, scope);
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    return options.includeArchived ? entries : entries.filter((entry) => entry.archived !== true);
}

function replaceVoyageSummary(
    summaries: VoyageSummary[],
    voyageId: string,
    replacement: VoyageSummary[],
): VoyageSummary[] {
    return [...summaries.filter((summary) => normalizeVoyageId(summary.voyageId) !== voyageId), ...replacement];
}

async function hydratePendingUnarchives(
    summaries: VoyageSummary[],
    intents: VoyageArchiveIntentSnapshot[],
    scope: AuthIdentityScope,
): Promise<VoyageSummary[]> {
    let hydrated = summaries;
    for (const intent of intents) {
        if (intent.archived || !isAuthIdentityScopeCurrent(scope)) continue;
        const voyageId = normalizeVoyageId(intent.voyageId);
        const entries = await fetchVisibleProjectionEntries(scope, {
            targetVoyageId: voyageId,
            queryArchived: true,
            includeArchived: false,
        });
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        hydrated = replaceVoyageSummary(hydrated, voyageId, summarizeEntries(entries));
    }
    return hydrated;
}

/**
 * Fetch one summary per voyage. Tries the server-side RPC first; on
 * "function not found" (or any RPC error) falls back to a lightweight
 * projection fetch aggregated client-side.
 */
export async function getVoyageSummaries(includeArchived = false): Promise<VoyageSummary[]> {
    const scope = getAuthIdentityScope();
    if (!supabase || !scope.userId) return [];

    const sessionUserId = await getCurrentUserId();
    if (!isAuthIdentityScopeCurrent(scope) || sessionUserId !== scope.userId) return [];

    try {
        // Load the owner-scoped ledgers before painting any remote state. A
        // corrupt/unreadable durable ledger fails closed instead of reviving
        // a voyage whose delete/archive command has already been accepted.
        await getVoyageArchiveIntentSnapshot(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        let result: VoyageSummary[] | null = null;
        let usedRpc = false;

        if (!rpcUnavailable) {
            try {
                if (!isAuthIdentityScopeCurrent(scope)) return [];
                const { data, error } = await supabase.rpc('get_voyage_summaries', {
                    p_include_archived: includeArchived,
                });
                if (!isAuthIdentityScopeCurrent(scope)) return [];
                if (error) {
                    // PGRST202 = function not found in schema cache (not deployed yet).
                    if (error.code === 'PGRST202' || /function .* does not exist/i.test(error.message)) {
                        log.warn('get_voyage_summaries RPC not deployed — using client-side fallback');
                        // Deployment availability is process-global, but a late
                        // account-A result must not mutate any state in B.
                        if (isAuthIdentityScopeCurrent(scope)) rpcUnavailable = true;
                    } else {
                        log.warn('get_voyage_summaries RPC error, falling back:', error.message);
                    }
                } else if (Array.isArray(data)) {
                    result = data.map((row) => fromRpcRow(row as Record<string, unknown>));
                    usedRpc = true;
                }
            } catch (error) {
                log.warn('get_voyage_summaries RPC threw, falling back:', error);
            }
        }

        if (result === null) {
            if (!isAuthIdentityScopeCurrent(scope)) return [];
            result = await summariesFromProjection(includeArchived, scope);
        } else if (usedRpc) {
            // Rebuild the sentinel bucket from individual rows even when the
            // server RPC exists. This supports older deployed RPCs that
            // excluded NULL rows and lets the local deletion time boundary
            // remove pre-delete default rows without swallowing new ones.
            const defaultEntries = await fetchVisibleProjectionEntries(scope, {
                targetVoyageId: DEFAULT_VOYAGE_ID,
                queryArchived: includeArchived,
                includeArchived,
            });
            if (!isAuthIdentityScopeCurrent(scope)) return [];
            result = replaceVoyageSummary(result, DEFAULT_VOYAGE_ID, summarizeEntries(defaultEntries));
        }
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        // A pending unarchive may contradict the cloud predicate used by the
        // base query, so fetch those voyage rows with archived rows included.
        const latestIntents = await getVoyageArchiveIntentSnapshot(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        if (!includeArchived) {
            result = await hydratePendingUnarchives(result, latestIntents, scope);
        }
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        // Re-apply at the last possible point: a delete/archive accepted while
        // the network request was in flight must win over its late response.
        result = await applySummaryReadTruth(result, includeArchived, scope);
        if (!isAuthIdentityScopeCurrent(scope)) return [];

        // Write-through to the local cache so the NEXT Log open paints
        // instantly. The cache read applies these ledgers again, so even a
        // later stale write can never repaint deleted/archived state.
        if (!includeArchived) {
            void setCachedSummaries(result, scope);
        }

        return isAuthIdentityScopeCurrent(scope) ? result : [];
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) {
            log.warn('getVoyageSummaries failed closed while applying local truth:', error);
        }
        return [];
    }
}

/**
 * INSTANT local read of the last-cached voyage summaries (no network).
 * The Log boots from this on mount to paint the list immediately, then
 * calls getVoyageSummaries() to refresh from the cloud in the background.
 */
export async function getCachedVoyageSummaries(): Promise<VoyageSummary[]> {
    const scope = getAuthIdentityScope();
    if (!scope.userId) return [];
    try {
        const summaries = await getCachedSummaries(scope);
        if (!isAuthIdentityScopeCurrent(scope) || !summaries) return [];
        return await applySummaryReadTruth(summaries, false, scope);
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) {
            log.warn('cached voyage summaries failed closed while applying local truth:', error);
        }
        return [];
    }
}

/** Fallback path: paginate the lightweight projection, aggregate locally. */
async function summariesFromProjection(includeArchived: boolean, scope: AuthIdentityScope): Promise<VoyageSummary[]> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return [];
    try {
        const entries = await fetchVisibleProjectionEntries(scope, {
            queryArchived: includeArchived,
            includeArchived,
        });
        return isAuthIdentityScopeCurrent(scope) ? summarizeEntries(entries) : [];
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.warn('summariesFromProjection failed:', error);
        return [];
    }
}

/**
 * Lazy-load the FULL entry list for a single voyage — called when the user
 * expands a card or opens its track map. Bounded; newest-first.
 */
export async function getVoyageEntries(voyageId: string, includeArchived = false): Promise<ShipLogEntry[]> {
    const scope = getAuthIdentityScope();
    const targetVoyageId = normalizeVoyageId(voyageId.trim());
    if (!supabase || !scope.userId || !voyageId.trim()) return [];
    try {
        const sessionUserId = await getCurrentUserId();
        if (!isAuthIdentityScopeCurrent(scope) || sessionUserId !== scope.userId) return [];

        const intents = await getVoyageArchiveIntentSnapshot(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        const pendingUnarchive = intents.some(
            (intent) => !intent.archived && normalizeVoyageId(intent.voyageId) === targetVoyageId,
        );
        const entries = await fetchVisibleProjectionEntries(scope, {
            targetVoyageId,
            queryArchived: includeArchived || pendingUnarchive,
            includeArchived,
            columns: '*',
            maxRows: DETAIL_MAX_ROWS,
        });
        return isAuthIdentityScopeCurrent(scope) ? entries : [];
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) {
            log.warn('getVoyageEntries failed closed while applying local truth:', error);
        }
        return [];
    }
}

/** Test-only: reset the RPC-availability latch between cases. */
export function __resetRpcLatchForTests() {
    rpcUnavailable = false;
}
