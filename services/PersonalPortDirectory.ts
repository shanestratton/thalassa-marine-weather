/**
 * PersonalPortDirectory — auto-curated marine port cache.
 *
 * The hand-vetted MARINE_PORTS list in geocoding.ts ships with the
 * app and only grows when we cut a release. That's fine for the
 * obvious destinations (Nouméa, Port Vila, etc.) but useless for
 * the long tail of cruising stops a real skipper visits — every
 * little anchorage, marina, and reef pass on their cruising patch.
 *
 * This service is the long tail. Every successful geocode lookup
 * goes in here, keyed by what the user typed → the canonical name
 * + coords Mapbox resolved to. Subsequent searches by the same
 * (or a similar) name short-circuit to the cached coords instead
 * of re-hitting Mapbox — faster, offline-resilient, and protects
 * the user from Mapbox quietly returning a different "best match"
 * a month later as its index updates.
 *
 * Storage:
 *   - localStorage (always) — 1000-port soft cap, LRU evicted.
 *     Works offline, instant lookups.
 *   - Supabase `personal_ports` table (when authenticated) —
 *     fire-and-forget upsert on record, opportunistic pull on
 *     startup. Lets the user's directory follow them between
 *     devices: plan a route on the iPad → the same port resolves
 *     instantly on the iPhone.
 *
 * Conflict resolution: PostgreSQL UNIQUE(user_id, typed_name)
 * with `ON CONFLICT DO UPDATE` — last-write-wins on coords/canonical;
 * times_used is summed across rows when merging the local cache
 * with the cloud snapshot on startup.
 *
 * Phase 2 (deferred): the migration's `public_status` column lays
 * the groundwork for promoting a personal port to a community-vetted
 * shared list. Not wired yet — needs a moderation queue.
 */

import { createLogger } from '../utils/createLogger';
import { supabase } from './supabase';

const log = createLogger('PortDirectory');

const STORAGE_KEY = 'thalassa_personal_ports';
const MAX_ENTRIES = 1000;

export interface PersonalPort {
    /** What the user typed verbatim — the lookup key. */
    typedName: string;
    /** Canonical name Mapbox resolved to (used as the display label). */
    canonicalName: string;
    /** Coordinates of the resolved feature. */
    lat: number;
    lon: number;
    /** How many times the user has searched/used this port. */
    timesUsed: number;
    /** ISO timestamp of first observation. */
    firstUsedAt: string;
    /** ISO timestamp of most recent observation — drives LRU eviction. */
    lastUsedAt: string;
}

// In-memory cache — populated on first read, mirror of localStorage.
let _cache: PersonalPort[] | null = null;

function load(): PersonalPort[] {
    if (_cache !== null) return _cache;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            _cache = [];
            return _cache;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            _cache = [];
            return _cache;
        }
        // Defensive: accept partially-shaped entries from older builds
        // and drop anything missing required fields.
        _cache = parsed.filter(
            (p): p is PersonalPort =>
                typeof p?.typedName === 'string' &&
                typeof p?.canonicalName === 'string' &&
                typeof p?.lat === 'number' &&
                typeof p?.lon === 'number' &&
                Number.isFinite(p.lat) &&
                Number.isFinite(p.lon),
        );
        return _cache;
    } catch (e) {
        log.warn('load failed, starting empty:', e);
        _cache = [];
        return _cache;
    }
}

function persist(): void {
    if (_cache === null) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
    } catch (e) {
        // Quota exhausted — drop oldest 10% and retry once.
        log.warn('persist failed (quota?), evicting oldest 10% and retrying:', e);
        if (_cache.length > 100) {
            _cache.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
            _cache = _cache.slice(0, Math.floor(_cache.length * 0.9));
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache));
            } catch {
                /* still failing — give up silently */
            }
        }
    }
}

/** Normalise a typed string for comparison — trim + lowercase. */
function norm(s: string): string {
    return s.trim().toLowerCase();
}

/**
 * Look up a personal port by typed name. Substring match — typing
 * "isle of pines" matches a stored "Isle of Pines, NC" as well as
 * "Isle of Pines (-22.6650, 167.4500)". Returns the most-recently-
 * used match when several aliases share the same prefix.
 *
 * Returns null if no match — caller should fall through to Mapbox.
 */
export function findPersonalPort(typedName: string): PersonalPort | null {
    if (!typedName) return null;
    const q = norm(typedName);
    if (q.length < 3) return null; // avoid one-letter false positives

    const matches = load().filter((p) => {
        const t = norm(p.typedName);
        const c = norm(p.canonicalName);
        return t === q || c === q || t.includes(q) || q.includes(t);
    });

    if (matches.length === 0) return null;

    // Prefer EXACT match over substring. Among matches, prefer the
    // most-recently-used so a user's recent typing pattern wins
    // over a stale entry from years ago.
    matches.sort((a, b) => {
        const aExact = norm(a.typedName) === q || norm(a.canonicalName) === q ? 1 : 0;
        const bExact = norm(b.typedName) === q || norm(b.canonicalName) === q ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        return Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt);
    });

    return matches[0];
}

/**
 * Record a successful port lookup. Idempotent — re-recording an
 * existing entry just bumps timesUsed + lastUsedAt. Reject (0,0)
 * and out-of-range coords so a failed Mapbox response can't pollute
 * the directory.
 *
 * Local write is synchronous (writes to in-memory cache + localStorage).
 * Cloud upsert is fire-and-forget so the geocode caller never blocks
 * on a network round-trip; if Supabase is down, the local cache still
 * works perfectly and the cloud catches up on the next successful
 * recordPersonalPort call.
 */
export function recordPersonalPort(typedName: string, canonicalName: string, lat: number, lon: number): void {
    if (!typedName || !canonicalName) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return; // (0,0) sentinel

    const list = load();
    const q = norm(typedName);
    const now = new Date().toISOString();
    const existing = list.find((p) => norm(p.typedName) === q);

    let nextRow: PersonalPort;
    if (existing) {
        existing.timesUsed += 1;
        existing.lastUsedAt = now;
        // Keep the canonical/coords fresh — Mapbox might return a
        // better feature on a later attempt.
        existing.canonicalName = canonicalName;
        existing.lat = lat;
        existing.lon = lon;
        nextRow = existing;
    } else {
        nextRow = {
            typedName,
            canonicalName,
            lat,
            lon,
            timesUsed: 1,
            firstUsedAt: now,
            lastUsedAt: now,
        };
        list.push(nextRow);

        // Cap the cache — drop least-recently-used when we exceed.
        if (list.length > MAX_ENTRIES) {
            list.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
            list.splice(MAX_ENTRIES);
        }
    }

    persist();
    log.info(`recorded "${typedName}" → "${canonicalName}" (${lat.toFixed(4)}, ${lon.toFixed(4)})`);

    // Fire-and-forget cloud sync. Skipped silently when there's no
    // Supabase client or the user isn't signed in — local cache is
    // still authoritative for the unauthenticated case.
    void cloudUpsertPort(nextRow);
}

/** Return all personal ports, sorted most-recently-used first. */
export function listPersonalPorts(): PersonalPort[] {
    const list = load().slice();
    list.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
    return list;
}

/** Remove a port by typed name (case-insensitive). Returns true if removed. */
export function removePersonalPort(typedName: string): boolean {
    const list = load();
    const q = norm(typedName);
    const idx = list.findIndex((p) => norm(p.typedName) === q);
    if (idx < 0) return false;
    const removed = list.splice(idx, 1)[0];
    persist();
    // Fire-and-forget cloud delete. If offline / unauthenticated the
    // local removal still stands; the cloud row will stay until a
    // future syncFromCloud reconciliation drops it (next phase).
    void cloudDeletePort(removed.typedName);
    return true;
}

/** Wipe the entire personal port cache (local + cloud). */
export function clearPersonalPorts(): void {
    _cache = [];
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* ignore */
    }
    void cloudClearAllPorts();
}

// ── Supabase sync ──────────────────────────────────────────────────
//
// All cloud operations are best-effort. They never block the caller,
// they swallow their own errors, and they log a warning rather than
// surface a failure to the user. The local cache is the source of
// truth at runtime; the cloud is a cross-device convenience layer.

interface PortRow {
    typed_name: string;
    canonical_name: string;
    lat: number;
    lon: number;
    times_used: number;
    first_used_at: string;
    last_used_at: string;
}

function rowToPort(r: PortRow): PersonalPort {
    return {
        typedName: r.typed_name,
        canonicalName: r.canonical_name,
        lat: r.lat,
        lon: r.lon,
        timesUsed: r.times_used,
        firstUsedAt: r.first_used_at,
        lastUsedAt: r.last_used_at,
    };
}

async function cloudUpsertPort(p: PersonalPort): Promise<void> {
    if (!supabase) return;
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return; // unauthenticated — local-only is fine.
        const { error } = await supabase.from('personal_ports').upsert(
            {
                user_id: user.id,
                typed_name: p.typedName,
                canonical_name: p.canonicalName,
                lat: p.lat,
                lon: p.lon,
                times_used: p.timesUsed,
                first_used_at: p.firstUsedAt,
                last_used_at: p.lastUsedAt,
            },
            { onConflict: 'user_id,typed_name' },
        );
        if (error) log.warn('cloud upsert failed:', error.message);
    } catch (e) {
        log.warn('cloud upsert threw:', e);
    }
}

async function cloudDeletePort(typedName: string): Promise<void> {
    if (!supabase) return;
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const { error } = await supabase
            .from('personal_ports')
            .delete()
            .eq('user_id', user.id)
            .eq('typed_name', typedName);
        if (error) log.warn('cloud delete failed:', error.message);
    } catch (e) {
        log.warn('cloud delete threw:', e);
    }
}

async function cloudClearAllPorts(): Promise<void> {
    if (!supabase) return;
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const { error } = await supabase.from('personal_ports').delete().eq('user_id', user.id);
        if (error) log.warn('cloud clear failed:', error.message);
    } catch (e) {
        log.warn('cloud clear threw:', e);
    }
}

/**
 * One-shot pull of the user's port directory from Supabase, merged
 * into the local cache. Called on app startup (and re-callable on
 * sign-in). Merge semantics:
 *   - Cloud rows the local cache doesn't know about → added locally
 *   - Local rows the cloud doesn't know about → pushed to cloud
 *   - Rows in both → keep the more-recently-used row's coords +
 *     canonical name; sum timesUsed (so the global usage counter
 *     reflects use across all devices).
 *
 * Idempotent: calling it again with no changes is a cheap no-op.
 * Returns the number of cloud rows merged (informational).
 */
export async function syncPortsFromCloud(): Promise<number> {
    if (!supabase) return 0;
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return 0;
        const { data, error } = await supabase
            .from('personal_ports')
            .select('typed_name, canonical_name, lat, lon, times_used, first_used_at, last_used_at')
            .eq('user_id', user.id);
        if (error) {
            log.warn('cloud pull failed:', error.message);
            return 0;
        }
        const cloudPorts = (data ?? []).map((r) => rowToPort(r as PortRow));
        const local = load();

        // Build a normalised-typedName index of the local cache so we
        // can merge in O(N+M) rather than O(N×M).
        const localByKey = new Map<string, PersonalPort>();
        for (const p of local) localByKey.set(norm(p.typedName), p);

        // Track local-only rows so we can push them up after the merge
        // — keeps a freshly-signed-in user's existing localStorage
        // history flowing into the cloud without losing anything.
        const cloudByKey = new Map<string, PersonalPort>();
        for (const p of cloudPorts) cloudByKey.set(norm(p.typedName), p);

        let merged = 0;
        for (const cloud of cloudPorts) {
            const key = norm(cloud.typedName);
            const localMatch = localByKey.get(key);
            if (!localMatch) {
                local.push(cloud);
                merged++;
            } else {
                // Last-seen wins on coords + canonical; usage counter
                // sums across devices.
                const cloudFresher = Date.parse(cloud.lastUsedAt) > Date.parse(localMatch.lastUsedAt);
                if (cloudFresher) {
                    localMatch.canonicalName = cloud.canonicalName;
                    localMatch.lat = cloud.lat;
                    localMatch.lon = cloud.lon;
                    localMatch.lastUsedAt = cloud.lastUsedAt;
                }
                localMatch.timesUsed = Math.max(localMatch.timesUsed, cloud.timesUsed);
                merged++;
            }
        }

        // Cap the merged cache so a long history of cross-device use
        // can't push past MAX_ENTRIES.
        if (local.length > MAX_ENTRIES) {
            local.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
            local.splice(MAX_ENTRIES);
        }

        persist();

        // Push any local-only rows up — fire-and-forget per row so a
        // single failure doesn't abort the lot.
        for (const local_p of local) {
            const key = norm(local_p.typedName);
            if (!cloudByKey.has(key)) {
                void cloudUpsertPort(local_p);
            }
        }

        log.info(`cloud sync: merged ${merged} rows (cache size now ${local.length})`);
        return merged;
    } catch (e) {
        log.warn('cloud sync threw:', e);
        return 0;
    }
}
