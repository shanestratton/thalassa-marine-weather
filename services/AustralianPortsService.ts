/**
 * AustralianPortsService — destination geocoder fallback for
 * Australian seaports.
 *
 * Why this exists
 * ───────────────
 * Route planner geocodes user-typed destinations (e.g. "Port of
 * Brisbane") through a fallback chain that ends at Mapbox. Mapbox
 * historically lands "Port of Brisbane" at the cargo gate / road
 * centroid — about 2.5 km NW of the actual port pinpoint and well
 * WEST of the marked shipping channel. The inshore router then
 * picks the cheapest path to those off-channel coords, which goes
 * through coarse-bathymetry CAUTION cells — painting the Brisbane
 * half of every passage plan red.
 *
 * Fix: a curated dataset of 82 Australian seaports (DITRDCSA federal
 * "Australian Seaports" GeoJSON, includes every major port + minor
 * seaports declared as First Ports of Entry) seeded into Supabase
 * by migration 20260516170000_australian_ports.sql. This service
 * fetches the dataset once per session and exposes a fuzzy-match
 * lookup the geocoder consults before falling back to Mapbox.
 *
 * Lookup strategy
 * ───────────────
 * 1. Normalise the query: lowercase, strip "Port of " prefix, strip
 *    Australian state / "Australia" suffixes ("Brisbane, QLD" →
 *    "brisbane").
 * 2. Exact name match (lowercased).
 * 3. Port name appears as a substring of the user query (handles
 *    "Brisbane port marina" → "Brisbane").
 * 4. User query appears as a substring of the port name (handles
 *    "Lockhart" → "Lockhart River (Quintell Beach)"), 4+ chars to
 *    avoid trigger-happy partials like "port" matching everything.
 *
 * Data shape: matches MarinePort from geocoding.ts so the geocoder
 * can treat both lookup paths interchangeably.
 */
import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AustralianPorts');

export interface AustralianPort {
    id: number;
    name: string;
    lat: number;
    lon: number;
    /** First Port of Entry — relevant for customs/clearance routes. */
    fpoe: boolean;
}

// Module-level cache. First call kicks off the fetch; subsequent
// calls reuse the same promise (so concurrent callers don't race
// duplicate queries). Cleared to null on error so a transient
// failure doesn't poison the session.
let portsPromise: Promise<AustralianPort[]> | null = null;

async function loadAllPorts(): Promise<AustralianPort[]> {
    if (portsPromise) return portsPromise;
    if (!supabase) {
        log.warn('[australian-ports] Supabase not configured — port lookup unavailable');
        return [];
    }
    portsPromise = (async () => {
        try {
            const { data, error } = await supabase
                .from('australian_ports')
                .select('id, name, lat, lon, fpoe')
                .limit(500);
            if (error) {
                log.warn(`[australian-ports] fetch error — ${error.message}`);
                portsPromise = null;
                return [];
            }
            const rows = (data ?? []) as AustralianPort[];
            log.warn(`[australian-ports] loaded ${rows.length} ports from Supabase`);
            return rows;
        } catch (e) {
            log.warn(`[australian-ports] fetch threw — ${e instanceof Error ? e.message : String(e)}`);
            portsPromise = null;
            return [];
        }
    })();
    return portsPromise;
}

// Strip common prefixes / suffixes so "Port of Brisbane, QLD"
// reduces to "brisbane" before we try to match it.
const STATE_SUFFIX_RE =
    /[,\s]+(qld|nsw|vic|sa|wa|tas|nt|act|queensland|new south wales|victoria|south australia|western australia|tasmania|northern territory|australian capital territory|australia)\s*$/i;

function normalisePortQuery(query: string): string {
    let q = query.toLowerCase().trim();
    // Repeatedly strip trailing state/region tokens — "Brisbane, QLD,
    // Australia" needs two passes.
    let prev = '';
    while (prev !== q) {
        prev = q;
        q = q.replace(STATE_SUFFIX_RE, '').trim();
    }
    // Strip "Port of " prefix.
    q = q.replace(/^port\s+of\s+/, '').trim();
    return q;
}

/**
 * Find an Australian seaport matching the user's query. Returns null
 * if no match — the geocoder then falls through to Mapbox.
 *
 * The fetch is lazy — first call kicks off a Supabase round-trip
 * (~50-200ms) and caches the result for the session. Subsequent
 * calls are in-memory.
 */
export async function findAustralianPort(query: string): Promise<AustralianPort | null> {
    const ports = await loadAllPorts();
    if (ports.length === 0) return null;

    const norm = normalisePortQuery(query);
    if (!norm) return null;

    // 1. Exact name match (case-insensitive).
    let match = ports.find((p) => p.name.toLowerCase() === norm);
    if (match) return match;

    // 2. Port name appears as a substring of the user query.
    //    Handles "brisbane marina" → "Brisbane".
    match = ports.find((p) => {
        const portLc = p.name.toLowerCase();
        // Avoid trivial 1-2 char partials matching nothing useful.
        if (portLc.length < 4) return false;
        return norm.includes(portLc);
    });
    if (match) return match;

    // 3. User query appears as a substring of the port name.
    //    Handles "Lockhart" → "Lockhart River (Quintell Beach)".
    //    Require 4+ chars on the query side so generic words like
    //    "port" don't match every port name.
    if (norm.length >= 4) {
        match = ports.find((p) => p.name.toLowerCase().includes(norm));
        if (match) return match;
    }

    return null;
}
