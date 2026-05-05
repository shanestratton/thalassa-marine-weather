/**
 * WaveFieldAdapter — Bridges sparse wave samples (services/weather/waveField.ts)
 * to the IsochroneRouter's WaveField interface.
 *
 * Spatial: inverse-distance-weighted interpolation between sample points
 * within a 3° search radius (~180 NM at the equator — well within the
 * 50 NM autocorrelation length of significant wave height fields).
 *
 * Temporal: linear interpolation between bracketing forecast hours.
 *
 * Direction handling: directions can't be averaged linearly (170° and
 * 190° average to 180°, but 350° and 10° should average to 0°/360°,
 * not 180°). We interpolate via unit-vector decomposition.
 */

import type { WaveField } from '../isochrone/types';
import type { WaveFieldData } from './waveField';

const SEARCH_RADIUS_DEG = 3.0;

/** Linear interpolation. */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Circular mean of two angles (degrees) weighted by t (0..1). */
function lerpAngle(a: number, b: number, t: number): number {
    const ax = Math.cos((a * Math.PI) / 180);
    const ay = Math.sin((a * Math.PI) / 180);
    const bx = Math.cos((b * Math.PI) / 180);
    const by = Math.sin((b * Math.PI) / 180);
    const x = lerp(ax, bx, t);
    const y = lerp(ay, by, t);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Build a WaveField from fetched sparse sample data.
 *
 * Returns null if the sample set is empty so the caller can skip
 * passing a wave field to the engine (the engine treats null as "no
 * wave penalty, polar gives raw boat speed").
 */
export function createWaveFieldFromSamples(data: WaveFieldData | null): WaveField | null {
    if (!data || data.samples.length === 0) return null;

    const refMs = new Date(data.referenceTimeIso).getTime();
    if (isNaN(refMs)) return null;

    return {
        getWave(lat: number, lon: number, timeOffsetHours: number) {
            // Temporal bracket — relative to engine's "departure + offset",
            // not the field's reference time. Adjust accordingly: the
            // engine queries with timeOffsetHours from departureTime,
            // which we assume is close to refMs.
            const queryMs = Date.now() + timeOffsetHours * 3600_000;
            // Map to the field's hour index
            const hourFloat = (queryMs - refMs) / 3600_000;
            if (hourFloat < 0) return null;
            const h0 = Math.floor(hourFloat);
            const h1 = Math.min(h0 + 1, data.totalHours - 1);
            if (h0 >= data.totalHours) return null;
            const tFrac = hourFloat - h0;

            // Find samples within search radius and IDW their values
            let weightSum = 0;
            let heightSum = 0;
            let periodSum = 0;
            let dirX = 0;
            let dirY = 0;
            let neighbours = 0;

            for (const sample of data.samples) {
                const dLat = sample.lat - lat;
                const dLon = sample.lon - lon;
                if (Math.abs(dLat) > SEARCH_RADIUS_DEG || Math.abs(dLon) > SEARCH_RADIUS_DEG) continue;

                const distSq = dLat * dLat + dLon * dLon;
                if (distSq > SEARCH_RADIUS_DEG * SEARCH_RADIUS_DEG) continue;

                const w = 1 / Math.max(0.001, distSq);

                // Time-interp this sample's height/period/direction
                const h = lerp(sample.heightM[h0] ?? 0, sample.heightM[h1] ?? 0, tFrac);
                const p = lerp(sample.periodS[h0] ?? 8, sample.periodS[h1] ?? 8, tFrac);
                const d = lerpAngle(sample.directionFromDeg[h0] ?? 0, sample.directionFromDeg[h1] ?? 0, tFrac);

                heightSum += h * w;
                periodSum += p * w;
                // Decompose direction to vectors for IDW
                dirX += Math.cos((d * Math.PI) / 180) * w;
                dirY += Math.sin((d * Math.PI) / 180) * w;
                weightSum += w;
                neighbours++;
            }

            if (neighbours === 0 || weightSum === 0) return null;

            const heightM = heightSum / weightSum;
            const periodS = periodSum / weightSum;
            const directionFromDeg = ((Math.atan2(dirY / weightSum, dirX / weightSum) * 180) / Math.PI + 360) % 360;

            return {
                heightM: Math.round(heightM * 100) / 100,
                periodS: Math.round(periodS * 10) / 10,
                directionFromDeg: Math.round(directionFromDeg),
            };
        },
    };
}
