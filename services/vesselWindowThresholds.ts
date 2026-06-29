/**
 * vesselWindowThresholds — tailor the 👍/🆗/👎 weather-window verdict to the
 * actual yacht. A 55' bluewater cutter shrugs off conditions that would pin a
 * 28' coastal cruiser, so the thresholds can't be one-size-fits-all.
 *
 * Vessel-dependent metrics — wind, gust, wave — scale to the boat:
 *   - wind/gust → the boat's comfortable sustained-wind ceiling, taken from
 *       its stated maxWindSpeed (kt) if set, else its LEARNED polar's power
 *       peak (the wind beyond which boatspeed plateaus = overpowered), else
 *       its length.
 *   - wave → its stated maxWaveHeight (feet, always set at onboarding).
 * Crew/safety metrics (UV, visibility, rain) are NOT boat-dependent and keep
 * fixed defaults (handled by the caller).
 *
 * UNITS: wind/gust in knots, wave in FEET — the verdict's raw `pick` units.
 * (VesselProfile.maxWaveHeight is stored in feet; maxWindSpeed in knots.)
 */

import type { VesselProfile } from '../types/vessel';
import type { PolarData } from '../types/navigation';

export interface MetricThreshold {
    good: number;
    poor: number;
}
export interface VesselWindowThresholds {
    wind: MetricThreshold; // kt
    gust: MetricThreshold; // kt
    wave: MetricThreshold; // ft
}

/** Generic moderate-cruiser fallback (the pre-vessel-aware defaults). */
export const MODERATE_WINDOW: VesselWindowThresholds = {
    wind: { good: 15, poor: 22 },
    gust: { good: 20, poor: 28 },
    wave: { good: 3.3, poor: 5.9 }, // ≈1.0 m / 1.8 m
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The wind (kt) at which the boat's best boatspeed peaks. Beyond it more wind
 * stops adding speed (the boat is overpowered / reefing) — a polar-derived
 * comfortable-wind ceiling. Null for an empty/degenerate polar.
 */
export function polarPowerPeakTws(polar: PolarData | null | undefined): number | null {
    if (!polar?.windSpeeds?.length || !polar.matrix?.length) return null;
    const bestPerWind = polar.windSpeeds.map((_, j) =>
        Math.max(...polar.matrix.map((row) => (Number.isFinite(row?.[j]) ? row[j] : 0))),
    );
    let peak = 0;
    for (let j = 1; j < bestPerWind.length; j++) if (bestPerWind[j] > bestPerWind[peak]) peak = j;
    const tws = polar.windSpeeds[peak];
    return Number.isFinite(tws) && tws > 0 ? tws : null;
}

/** Length-based comfortable-wind ceiling (kt) — last-resort proxy. */
function sizeComfortWind(loaFt: number | null | undefined): number | null {
    if (!loaFt || loaFt <= 0) return null;
    return clamp(13 + (loaFt - 30) * 0.28, 12, 32); // 28ft≈13, 38ft≈15, 55ft≈20, 65ft≈23
}

/**
 * Per-metric good/poor cut-offs tailored to a vessel.
 *
 * @param polar the vessel's LEARNED polar (null when none — do NOT pass the
 *   generic default; the length fallback covers a boat with no learned polar).
 */
export function vesselWindowThresholds(
    vessel: VesselProfile | null | undefined,
    polar: PolarData | null | undefined,
): VesselWindowThresholds {
    // Comfortable sustained-wind ceiling (kt).
    let comfortWind: number | null = null;
    if (vessel?.maxWindSpeed && vessel.maxWindSpeed > 0) {
        comfortWind = vessel.maxWindSpeed * 0.78; // scale the max-survivable down to comfort
    } else {
        comfortWind = polarPowerPeakTws(polar) ?? sizeComfortWind(vessel?.length);
    }

    const wind = comfortWind
        ? { good: r0(clamp(comfortWind * 0.68, 8, 32)), poor: r0(clamp(comfortWind, 12, 42)) }
        : MODERATE_WINDOW.wind;
    const gust = comfortWind
        ? { good: r0(clamp(comfortWind * 0.9, 10, 36)), poor: r0(clamp(comfortWind * 1.3, 16, 52)) }
        : MODERATE_WINDOW.gust;

    // Wave (feet) from the boat's stated max wave height.
    const wave =
        vessel?.maxWaveHeight && vessel.maxWaveHeight > 0
            ? {
                  good: r1(clamp(vessel.maxWaveHeight * 0.3, 1.5, 9)),
                  poor: r1(clamp(vessel.maxWaveHeight * 0.6, 3, 18)),
              }
            : MODERATE_WINDOW.wave;

    return { wind, gust, wave };
}
