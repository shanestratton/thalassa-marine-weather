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
 * Storage: localStorage, ~1 KB per port. 1000-port soft cap so the
 * cache never balloons; oldest-by-lastUsedAt evicted first.
 *
 * Privacy: stays on-device. Future enhancement could add an opt-in
 * sync to Supabase so a user's personal ports follow them between
 * iPad and phone, but that requires a moderation tier we don't
 * have yet. For now: local-only.
 */

import { createLogger } from '../utils/createLogger';

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

    if (existing) {
        existing.timesUsed += 1;
        existing.lastUsedAt = now;
        // Keep the canonical/coords fresh — Mapbox might return a
        // better feature on a later attempt.
        existing.canonicalName = canonicalName;
        existing.lat = lat;
        existing.lon = lon;
    } else {
        list.push({
            typedName,
            canonicalName,
            lat,
            lon,
            timesUsed: 1,
            firstUsedAt: now,
            lastUsedAt: now,
        });

        // Cap the cache — drop least-recently-used when we exceed.
        if (list.length > MAX_ENTRIES) {
            list.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
            list.splice(MAX_ENTRIES);
        }
    }

    persist();
    log.info(`recorded "${typedName}" → "${canonicalName}" (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
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
    list.splice(idx, 1);
    persist();
    return true;
}

/** Wipe the entire personal port cache. */
export function clearPersonalPorts(): void {
    _cache = [];
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* ignore */
    }
}
