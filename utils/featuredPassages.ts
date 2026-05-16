// Featured Passages — one signature route per marine region,
// surfaced to un-authed (and freshly-onboarded) users on The Glass.
//
// Why this exists
// ----------------
// The defer-sign-in flow (PR1) and the sample location (PR2 + Week
// 1a) get a visitor to a live weather panel within seconds of
// install. That answers "what's the weather here?" — but the app's
// real value is "Plan it, sail it, share it." The Featured Passage
// chip is the smallest possible nudge towards that value: a single
// real-world passage from the region's most iconic harbour to its
// closest must-see anchorage, with mileage. Tap → planner opens
// pre-filled with origin + destination → the visitor sees the
// product in motion.
//
// Routes
// ------
//   AU       → Sydney Harbour to Pittwater (~40 nm) — classic
//                weekend sail from CBD to NSW's prettiest anchorage.
//   NZ       → Auckland to Waiheke Island (~12 nm) — every Auckland
//                sailor's first overnighter.
//   UK       → Cowes to Cherbourg (~70 nm) — the Solent's flagship
//                Channel crossing, an RYA bucket-list passage.
//   US_EAST  → Newport, RI to Block Island (~18 nm) — the New
//                England day-sail of record.
//   US_WEST  → SF Bay (Golden Gate YC) to Half Moon Bay (~25 nm) —
//                the Coastal Pacific shake-down classic.
//   DEFAULT  → Falls back to AU (Sydney's passage) since AU is the
//                PR2 baseline sample.
//
// Pre-fill protocol
// -----------------
// The chip writes a small JSON blob to sessionStorage keyed by
// FEATURED_PASSAGE_PREFILL_KEY, then setPage('voyage'). The
// RoutePlanner controller (useVoyageForm) reads + clears the key
// on mount and seeds origin/destination from it. sessionStorage
// (not localStorage) so the hint dies with the app process — a
// returning user who didn't follow through doesn't get their next
// planner visit polluted weeks later.

import { detectRegion, type Region } from './locale';

export type FeaturedPassage = {
    id: string;
    region: Region;
    origin: { name: string; coords: { lat: number; lon: number } };
    destination: { name: string; coords: { lat: number; lon: number } };
    /** Approximate rhumb-line distance. The planner will recompute
     *  the real great-circle distance once the user actually plans. */
    distanceNm: number;
    /** One-line story shown on the chip's hover/aria-label. */
    story: string;
};

export const FEATURED_PASSAGE_PREFILL_KEY = 'thalassa_featured_passage_prefill';

const PASSAGES: Record<Region, FeaturedPassage> = {
    AU: {
        id: 'au-sydney-pittwater',
        region: 'AU',
        origin: { name: 'Sydney Harbour, NSW, AU', coords: { lat: -33.8568, lon: 151.2153 } },
        destination: { name: 'Pittwater, NSW, AU', coords: { lat: -33.6, lon: 151.3 } },
        distanceNm: 40,
        story: "Sydney's classic weekend passage — CBD lights at dawn, anchored off Coasters Retreat by dinner.",
    },
    NZ: {
        id: 'nz-auckland-waiheke',
        region: 'NZ',
        origin: { name: 'Auckland Harbour, NZ', coords: { lat: -36.8485, lon: 174.7633 } },
        destination: { name: 'Waiheke Island, NZ', coords: { lat: -36.8, lon: 175.1 } },
        distanceNm: 12,
        story: "Every Auckland sailor's first overnighter — clear the harbour and ride the easterly to Oneroa Bay.",
    },
    UK: {
        id: 'uk-cowes-cherbourg',
        region: 'UK',
        origin: { name: 'Cowes, Isle of Wight, UK', coords: { lat: 50.7591, lon: -1.297 } },
        destination: { name: 'Cherbourg, France', coords: { lat: 49.6386, lon: -1.6164 } },
        distanceNm: 70,
        story: "The Solent's flagship Channel crossing — RYA bucket-list, summer trade-winds and a French dinner.",
    },
    US_EAST: {
        id: 'us-east-newport-block',
        region: 'US_EAST',
        origin: { name: 'Newport, RI, USA', coords: { lat: 41.4901, lon: -71.3128 } },
        destination: { name: 'Block Island, RI, USA', coords: { lat: 41.1717, lon: -71.5589 } },
        distanceNm: 18,
        story: 'The New England day-sail of record — across Rhode Island Sound to Old Harbor for the night.',
    },
    US_WEST: {
        id: 'us-west-sf-hmb',
        region: 'US_WEST',
        origin: { name: 'San Francisco Bay, CA, USA', coords: { lat: 37.8082, lon: -122.4098 } },
        destination: { name: 'Half Moon Bay, CA, USA', coords: { lat: 37.5024, lon: -122.4869 } },
        distanceNm: 25,
        story: 'Out the Gate at slack, south down the coast in NW swell — the Pacific shake-down classic.',
    },
    DEFAULT: {
        // Mirror AU — keeps the chip non-empty for unmapped regions.
        id: 'default-sydney-pittwater',
        region: 'DEFAULT',
        origin: { name: 'Sydney Harbour, NSW, AU', coords: { lat: -33.8568, lon: 151.2153 } },
        destination: { name: 'Pittwater, NSW, AU', coords: { lat: -33.6, lon: 151.3 } },
        distanceNm: 40,
        story: "Sydney's classic weekend passage — CBD lights at dawn, anchored off Coasters Retreat by dinner.",
    },
};

let cached: FeaturedPassage | null = null;

/** Returns the region-appropriate featured passage. Memoised. */
export function getFeaturedPassage(): FeaturedPassage {
    if (cached) return cached;
    cached = PASSAGES[detectRegion()];
    return cached;
}

/** Test-only — clears the memoisation cache. */
export function _resetFeaturedPassageCacheForTests(): void {
    cached = null;
}

/** Write the prefill hint that RoutePlanner picks up on next mount. */
export function setFeaturedPassagePrefill(passage: FeaturedPassage): void {
    try {
        sessionStorage.setItem(
            FEATURED_PASSAGE_PREFILL_KEY,
            JSON.stringify({
                origin: passage.origin.name,
                destination: passage.destination.name,
                passageId: passage.id,
            }),
        );
    } catch {
        // sessionStorage disabled (private mode, etc.) — silently drop
        // the prefill. The user will still land on the planner; they'll
        // just type the origin/destination themselves.
    }
}

/** Read + clear the prefill hint. Returns null if absent or malformed. */
export function consumeFeaturedPassagePrefill(): { origin: string; destination: string; passageId: string } | null {
    try {
        const raw = sessionStorage.getItem(FEATURED_PASSAGE_PREFILL_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(FEATURED_PASSAGE_PREFILL_KEY);
        const parsed = JSON.parse(raw);
        if (typeof parsed?.origin !== 'string' || typeof parsed?.destination !== 'string') return null;
        return {
            origin: parsed.origin,
            destination: parsed.destination,
            passageId: typeof parsed.passageId === 'string' ? parsed.passageId : 'unknown',
        };
    } catch {
        return null;
    }
}
