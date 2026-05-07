/**
 * CountrySnippetService — three-tier resolver for "what does the
 * skipper need to know about <country>?" snippets used by the trip
 * overview sheet + Captain's Brief PDF.
 *
 * The hand-curated table in TripOverviewService covers the Pacific
 * milk run + AU/NZ — fine for the standard cruise loop, useless for
 * a Caribbean / Med / Asia tester. This service fills the gap with:
 *
 *   1. CURATED — `getCountrySnippets()` table in TripOverviewService.
 *      Hand-vetted, ships with the app. Trusted source of truth.
 *
 *   2. CACHED — localStorage cache of previously-resolved AI snippets.
 *      30-day TTL. Saves API spend + works offline after first hit.
 *
 *   3. AI-GENERATED — Gemini call via fetchCountryYachtBrief(). Marked
 *      explicitly as AI-generated in the UI + PDF so the user knows
 *      to verify with the consulate. Not a substitute for legal /
 *      maritime authority — only a starting point.
 *
 *   4. STUB — minimal placeholder when Gemini is unavailable / offline.
 *      Always available; says "verify these things with local authority".
 *
 * Failures cascade silently: AI fails → stub. Stub never fails.
 *
 * Cost: 1 Gemini call per cache miss per country. For a 4-country trip
 * the first export costs ~$0.005; subsequent exports are free for
 * 30 days. Cache key is the country name (lower-case, trimmed).
 */

import type { CountrySnippet } from './TripOverviewService';
import { getCountrySnippets as getCuratedSnippetsList } from './TripOverviewService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('CountrySnippet');

const CACHE_KEY_PREFIX = 'thalassa_country_snippet:';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Where the snippet came from — drives the AI-generated badge. */
export type SnippetSource = 'curated' | 'cache' | 'ai' | 'stub';

export interface ResolvedCountrySnippet extends CountrySnippet {
    source: SnippetSource;
    /** ISO timestamp the snippet was fetched/cached. Useful for the
     *  PDF footer and stale-cache expiry checks. */
    fetchedAtIso?: string;
}

interface CachedEntry {
    snippet: CountrySnippet;
    fetchedAtIso: string;
}

function cacheKey(country: string): string {
    return CACHE_KEY_PREFIX + country.trim().toLowerCase();
}

function readCache(country: string): CachedEntry | null {
    try {
        const raw = localStorage.getItem(cacheKey(country));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachedEntry;
        // TTL check — drop expired entries lazily.
        if (Date.now() - new Date(parsed.fetchedAtIso).getTime() > CACHE_TTL_MS) {
            localStorage.removeItem(cacheKey(country));
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function writeCache(country: string, snippet: CountrySnippet): void {
    try {
        const entry: CachedEntry = {
            snippet,
            fetchedAtIso: new Date().toISOString(),
        };
        localStorage.setItem(cacheKey(country), JSON.stringify(entry));
    } catch {
        /* quota / disabled — cache is best-effort */
    }
}

/** Generic fallback when no curated entry exists AND Gemini is
 *  unavailable. Never a wrong-confidence answer; always a "verify
 *  this yourself" prompt structured the same way as a real entry. */
function makeStub(country: string): CountrySnippet {
    return {
        country,
        visa: 'Confirm current visa requirements for AU/NZ yacht arrivals with the consulate before departure.',
        biosecurity:
            'Declare all fresh produce, meat, dairy, and seeds on arrival. Strictness varies by country — verify specifics with local customs.',
        portsOfEntry: 'Verify designated yacht ports of entry with the local maritime authority.',
        notes: 'Some countries require advance notice (24–96 h) and/or an agent. Check Noonsite, the local yacht club, or the cruising guide for your region.',
    };
}

/**
 * Resolve a single country snippet through the three-tier pipeline.
 * Returns curated/cached results synchronously-ish; otherwise hits
 * Gemini and writes back to cache. Always resolves — never throws.
 */
export async function resolveCountrySnippet(country: string): Promise<ResolvedCountrySnippet> {
    // Tier 1: curated. Reuse the existing helper so we benefit from
    // its case + alias handling without duplicating the table.
    const curatedHit = getCuratedSnippetsList([country])[0];
    if (curatedHit) {
        return { ...curatedHit, source: 'curated' };
    }

    // Tier 2: localStorage cache.
    const cached = readCache(country);
    if (cached) {
        return { ...cached.snippet, source: 'cache', fetchedAtIso: cached.fetchedAtIso };
    }

    // Tier 3: Gemini.
    try {
        const { fetchCountryYachtBrief } = await import('./geminiService');
        const brief = await fetchCountryYachtBrief(country);
        if (brief) {
            const snippet: CountrySnippet = {
                country,
                visa: brief.visa,
                biosecurity: brief.biosecurity,
                portsOfEntry: brief.portsOfEntry,
                notes: brief.notes,
            };
            writeCache(country, snippet);
            log.info(`AI snippet generated for "${country}"`);
            return { ...snippet, source: 'ai', fetchedAtIso: new Date().toISOString() };
        }
    } catch (e) {
        log.warn(`AI snippet fetch failed for "${country}":`, e);
    }

    // Tier 4: stub.
    return { ...makeStub(country), source: 'stub' };
}

/**
 * Resolve a list of country names in parallel. Order preserved.
 * Used by the trip overview sheet + PDF generator to surface all
 * detected countries at once. ~1-2 s per AI miss; subsequent loads
 * are instant via the localStorage cache.
 */
export async function resolveCountrySnippets(countries: string[]): Promise<ResolvedCountrySnippet[]> {
    if (countries.length === 0) return [];
    return Promise.all(countries.map((c) => resolveCountrySnippet(c)));
}

/** Wipe a single country's cache (admin/debug). */
export function clearCountryCache(country: string): void {
    try {
        localStorage.removeItem(cacheKey(country));
    } catch {
        /* ignore */
    }
}

/** Wipe all cached country snippets (admin/debug). */
export function clearAllCountryCaches(): void {
    try {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(CACHE_KEY_PREFIX)) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
    } catch {
        /* ignore */
    }
}
