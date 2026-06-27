/**
 * fetchLimitedSea — the physics of how big a wind-driven sea can actually get
 * in a given fetch.
 *
 * WHY THIS EXISTS: global wave models (StormGlass / Open-Meteo) run on a coarse
 * grid that can't resolve the islands and headlands sheltering an enclosed bay,
 * so they leak open-ocean swell into water where it physically can't reach.
 * Newport (Moreton Bay, QLD) reading 2.7 m when the real bay sea is ~0.3-0.6 m
 * is the canonical case. Inside enclosed water the only waves are LOCALLY wind-
 * generated, and their height is bounded by the fetch — the over-water distance
 * the wind blows across. This module computes that bound.
 *
 * UNITS: SI throughout — wind in m/s once converted, fetch in metres, Hs in
 * metres. Callers convert from knots / km / feet at the boundary.
 *
 * SAFETY: this only ever CAPS a model value (never raises it), and we apply it
 * solely where geometry confirms enclosure (see shelterGeometry). Capping uses
 * the *longest* over-water fetch available, i.e. the most generous wind-sea the
 * basin can sustain, so it can't under-state an exposed coast.
 */

const G = 9.81; // m/s²
const KTS_TO_MS = 0.514444;

/**
 * Pierson–Moskowitz fully-developed significant wave height (m) for a sustained
 * wind — the ceiling a wind sea reaches with unlimited fetch and duration.
 * Hs ≈ 0.0246 · U10²  (U10 in m/s).
 */
export function fullyDevelopedHsMeters(windKts: number | null | undefined): number {
    const u = Math.max(0, (windKts ?? 0) * KTS_TO_MS);
    return 0.0246 * u * u;
}

/**
 * Fetch-limited significant wave height (m) from the JONSWAP/SMB growth law:
 *   g·Hs/U²  =  0.0016 · (g·F/U²)^½     ⇒    Hs = 0.0016 · U · √(F/g)
 * capped at the fully-developed value (a wind sea can't exceed fully developed
 * no matter how long the fetch).
 *
 * @param windKts  sustained wind speed (knots)
 * @param fetchKm  over-water fetch (km)
 */
export function fetchLimitedHsMeters(windKts: number | null | undefined, fetchKm: number | null | undefined): number {
    const u = Math.max(0, (windKts ?? 0) * KTS_TO_MS);
    const F = Math.max(0, (fetchKm ?? 0) * 1000);
    if (u <= 0 || F <= 0) return 0;
    const fetchLimited = 0.0016 * u * Math.sqrt(F / G);
    return Math.min(fetchLimited, fullyDevelopedHsMeters(windKts));
}

export interface ShelterCap {
    /** The wave height to display (m): min(model, fetch-limited cap). */
    hsMeters: number;
    /** True when the model value was actually pulled down. */
    capped: boolean;
    /** The fetch-limited ceiling used (m). */
    capMeters: number;
}

/**
 * Cap a model significant wave height at what the local fetch can sustain.
 * Returns the model value unchanged when it's already at or below the cap.
 *
 * @param modelHsMeters  the model's significant wave height (m)
 * @param windKts        local sustained wind (knots)
 * @param fetchKm        the basin's longest over-water fetch (km) — generous on purpose
 */
export function capWaveToFetch(
    modelHsMeters: number | null | undefined,
    windKts: number | null | undefined,
    fetchKm: number | null | undefined,
): ShelterCap {
    const model = Number.isFinite(modelHsMeters as number) ? Math.max(0, modelHsMeters as number) : 0;
    const cap = fetchLimitedHsMeters(windKts, fetchKm);
    if (cap > 0 && model > cap) {
        return { hsMeters: cap, capped: true, capMeters: cap };
    }
    return { hsMeters: model, capped: false, capMeters: cap };
}
