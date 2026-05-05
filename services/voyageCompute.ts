/**
 * voyageCompute.ts — Deterministic Voyage Plan Generator
 *
 * REPLACES Gemini (`fetchVoyagePlan`) for safety-critical route geometry.
 *
 * The previous Gemini-based generator hallucinated almost everything that
 * actually mattered:
 *   - Origin/destination place names (got rewritten to administrative regions)
 *   - distanceApprox (claimed "1.9 days" for an 870 NM passage at 6 kn)
 *   - durationApprox (was an LLM string, not a calculation)
 *   - waypoints (zigzag patterns that inflated distance 2× when summed)
 *   - departureDate (sometimes echoed today instead of user's pick)
 *
 * useVoyageForm was already overriding all of those after the call, so the
 * Gemini turn was paying real latency + tokens for fields we threw away.
 *
 * This module produces the same VoyagePlan shape from deterministic inputs:
 *   1. Geocode origin/destination via parseLocation (Mapbox + Nominatim)
 *   2. Compute great-circle distance origin → destination (canonical
 *      passage distance — the actual route may be slightly longer after
 *      bathymetric and weather routing, but never the 2× inflation
 *      Gemini's zigzag summing produced)
 *   3. Compute duration as distance / vessel.cruisingSpeed
 *   4. Return a VoyagePlan with empty waypoints (the enhancement pipeline
 *      — bathymetricRouter → weatherRouter — fills these in with real
 *      sea-following geometry)
 *
 * The plan is "seed only" — the post-compute enhancement pipeline does
 * the heavy lifting:
 *   - bathymetricRouter populates routeGeoJSON with depth-safe waterway
 *     geometry (hundreds of points hugging real coastlines)
 *   - weatherRouter optimises that centerline through a time-dependent
 *     weather corridor, producing the final ETA-aware track
 *
 * Optional Gemini prose (overview, hazards, customs, safe harbours) can be
 * fetched separately as a non-blocking enrichment, but is NEVER allowed
 * to influence coordinates, distance, duration, or the route polyline.
 */

import { VoyagePlan, VesselProfile } from '../types';
import { parseLocation } from './weather/api/geocoding';
import { calculateDistance } from '../utils/navigationCalculations';
import { createLogger } from '../utils/createLogger';

const log = createLogger('voyageCompute');

/**
 * Format duration hours into the same human-readable shape Gemini returned
 * (so downstream parsers like PassagePlanSave's `parseFloat(durationApprox)`
 * keep working unchanged).
 */
function formatDuration(hours: number): string {
    if (hours < 24) {
        return `${Math.round(hours)} hours`;
    }
    const days = Math.floor(hours / 24);
    const remHrs = Math.round(hours % 24);
    return remHrs > 0 ? `${days}d ${remHrs}h` : `${days} days`;
}

/**
 * Compute a deterministic voyage plan — no LLM, no hallucinations.
 *
 * Mirrors the public signature of fetchVoyagePlan so the call site can
 * swap modules without changing argument plumbing. Optional weatherContext
 * and userLocation parameters are accepted for signature compatibility but
 * not used here — they remain available to any future Gemini-prose
 * enrichment layer.
 */
export const computeVoyagePlan = async (
    origin: string,
    destination: string,
    vessel: VesselProfile,
    departureDate: string,
    _vesselUnits?: unknown,
    _generalUnits?: unknown,
    _via?: string,
    _weatherContext?: Record<string, unknown>,
    _userLocation?: { lat: number; lon: number },
): Promise<VoyagePlan> => {
    if (!origin || !destination) {
        throw new Error('Origin and destination are required.');
    }

    // ── 1. Geocode endpoints ──
    // parseLocation already handles coordinate strings ("WP 32.5, -117.2"),
    // major buoys, Mapbox forward geocode, Nominatim fallback, and the
    // Gemini autocorrect-suggester. It throws on hard-fail, which we
    // bubble up so the caller's try/catch shows the user a sensible
    // "Location 'foo' not found" instead of a hallucinated route.
    const [originGeo, destGeo] = await Promise.all([parseLocation(origin), parseLocation(destination)]);

    if (originGeo.lat === 0 && originGeo.lon === 0) {
        throw new Error(`Could not geocode origin: "${origin}"`);
    }
    if (destGeo.lat === 0 && destGeo.lon === 0) {
        throw new Error(`Could not geocode destination: "${destination}"`);
    }

    // ── 2. Great-circle distance ──
    // End-to-end haversine. The actual sailed track will be slightly
    // longer after bathymetric routing (waypoints around hazards/headlands)
    // and weather routing (corridor detours), but rarely 2×. The
    // enhancement pipeline replaces this string downstream once the
    // weather router returns a real cost-optimised total.
    const distNM = calculateDistance(originGeo.lat, originGeo.lon, destGeo.lat, destGeo.lon);

    // ── 3. Duration from vessel cruising speed ──
    // 6 kn floor matches the rest of the app (used in WeatherRoutingService,
    // weatherRouter, IsochronePrecomputeCache) when a vessel profile is
    // missing or has cruisingSpeed=0.
    const speedKn = vessel?.cruisingSpeed && vessel.cruisingSpeed > 0 ? vessel.cruisingSpeed : 6;
    const hours = distNM / speedKn;

    log.info(
        `compute: ${origin} → ${destination} = ${Math.round(distNM)} NM @ ${speedKn} kn = ${formatDuration(hours)}`,
    );

    // ── 4. Build the seed plan ──
    // waypoints is intentionally empty — the bathymetric router will
    // populate routeGeoJSON with depth-safe sea-following geometry
    // (hundreds of points), and the bend-detection step in useVoyageForm
    // surfaces named turn-points from that polyline. The weather router
    // then converts those into the final corridor-optimised waypoints
    // with wind/wave/depth conditions baked in.
    //
    // overview is a neutral placeholder — Gemini's "professional Master
    // Mariner summary" was prose that often contradicted the safety
    // suitability assessment downstream. If the user wants prose, the
    // optional enrichment hook can fetch it separately without blocking
    // the route from rendering.
    const plan: VoyagePlan = {
        origin,
        destination,
        departureDate,
        originCoordinates: { lat: originGeo.lat, lon: originGeo.lon },
        destinationCoordinates: { lat: destGeo.lat, lon: destGeo.lon },
        distanceApprox: `${Math.round(distNM)} nautical miles`,
        durationApprox: formatDuration(hours),
        overview: `Direct passage from ${origin} to ${destination}, approximately ${Math.round(distNM)} NM at ${speedKn} kn cruising speed.`,
        waypoints: [],
        // Suitability defaults to a neutral placeholder — the weather
        // router and bathymetric router populate maxWindEncountered /
        // maxWaveEncountered from real forecast/depth data, and the UI
        // shows the latest values once they arrive. We don't claim SAFE
        // or UNSAFE up front because we don't know yet — that's the
        // enhancement pipeline's job.
        suitability: {
            status: 'CAUTION',
            reasoning: 'Awaiting weather and depth analysis. Enhancement pipeline running…',
        },
    };

    return plan;
};
