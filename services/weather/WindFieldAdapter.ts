/**
 * WindFieldAdapter — Bridges the existing WindGrid data to the IsochroneRouter's WindField interface.
 *
 * Takes a WindGrid (from Open-Meteo, GRIB decode, or .wind.bin) and provides
 * the `getWind(lat, lon, timeOffsetHours)` method the isochrone engine expects.
 *
 * Interpolation:
 *   - Spatial: bilinear interpolation between the 4 nearest grid points
 *   - Temporal: linear interpolation between bracketing forecast hours
 *
 * Also supports multi-model stacking — combine multiple WindGrid instances
 * from different models (GFS, ECMWF, ICON) into an ensemble.
 */

import type { WindGrid } from './windField';
import type { WindField } from '../IsochroneRouter';

// ── Single-Grid Adapter ──────────────────────────────────────────

/**
 * Adapt a single WindGrid to the WindField interface.
 *
 * The WindGrid stores U/V components in m/s. This adapter converts to
 * wind speed (knots) and meteorological direction (degrees, "from").
 */
export function createWindFieldFromGrid(
    grid: WindGrid,
    forecastBaseTime?: Date, // When the forecast starts (default: now)
): WindField {
    const baseTime = forecastBaseTime ?? new Date();
    const hoursPerStep = grid.totalHours > 1 ? 1 : 1; // Grid is hourly

    return {
        getWind(lat: number, lon: number, timeOffsetHours: number) {
            // Temporal interpolation — find the hour bracket
            const hourIdx = Math.max(0, Math.min(grid.totalHours - 1, timeOffsetHours / hoursPerStep));
            const h0 = Math.floor(hourIdx);
            const h1 = Math.min(h0 + 1, grid.totalHours - 1);
            const tFrac = hourIdx - h0;

            // Spatial interpolation — find the grid cell
            const latIdx = ((lat - grid.south) / (grid.north - grid.south)) * (grid.height - 1);
            const lonIdx = ((lon - grid.west) / (grid.east - grid.west)) * (grid.width - 1);

            if (latIdx < 0 || latIdx >= grid.height || lonIdx < 0 || lonIdx >= grid.width) {
                return null; // Outside grid bounds
            }

            const r0 = Math.floor(latIdx);
            const r1 = Math.min(r0 + 1, grid.height - 1);
            const c0 = Math.floor(lonIdx);
            const c1 = Math.min(c0 + 1, grid.width - 1);
            const rFrac = latIdx - r0;
            const cFrac = lonIdx - c0;

            // Bilinear interpolation for U and V at hour h0
            const u_h0 = bilinear(grid.u[h0], r0, r1, c0, c1, rFrac, cFrac, grid.width);
            const v_h0 = bilinear(grid.v[h0], r0, r1, c0, c1, rFrac, cFrac, grid.width);

            // Bilinear interpolation for U and V at hour h1
            const u_h1 = bilinear(grid.u[h1], r0, r1, c0, c1, rFrac, cFrac, grid.width);
            const v_h1 = bilinear(grid.v[h1], r0, r1, c0, c1, rFrac, cFrac, grid.width);

            // Temporal interpolation
            const u = u_h0 + (u_h1 - u_h0) * tFrac;
            const v = v_h0 + (v_h1 - v_h0) * tFrac;

            // Convert U/V (m/s, meteorological) to speed (kts) and direction (degrees, "from")
            const speedMs = Math.sqrt(u * u + v * v);
            const speedKts = speedMs * 1.94384; // m/s → kts

            // Direction wind is blowing FROM (meteorological convention)
            // U/V are stored as blowing-TO, so we reverse
            const dirRad = Math.atan2(-u, -v);
            const dirDeg = ((dirRad * 180) / Math.PI + 360) % 360;

            return {
                speed: Math.round(speedKts * 10) / 10,
                direction: Math.round(dirDeg),
            };
        },
    };
}

function bilinear(
    data: Float32Array,
    r0: number,
    r1: number,
    c0: number,
    c1: number,
    rFrac: number,
    cFrac: number,
    width: number,
): number {
    const v00 = data[r0 * width + c0] ?? 0;
    const v10 = data[r1 * width + c0] ?? 0;
    const v01 = data[r0 * width + c1] ?? 0;
    const v11 = data[r1 * width + c1] ?? 0;

    const top = v00 + (v01 - v00) * cFrac;
    const bot = v10 + (v11 - v10) * cFrac;
    return top + (bot - top) * rFrac;
}

// ── Multi-Model Ensemble ─────────────────────────────────────────

export interface ModelSource {
    name: string; // e.g., 'GFS', 'ECMWF', 'ICON', 'ACCESS-G'
    grid: WindGrid;
    forecastBaseTime?: Date;
    weight?: number; // Ensemble weight (default: 1.0)
}

export interface EnsembleWind {
    speed: number; // Ensemble mean speed (kts)
    direction: number; // Ensemble mean direction (degrees)
    models: {
        name: string;
        speed: number;
        direction: number;
    }[];
    spread: number; // Speed spread (max - min) — high = low confidence
    directionSpread: number; // Direction spread (degrees) — high = models disagree
    confidence: 'high' | 'medium' | 'low'; // Based on spread
}

/**
 * Create a multi-model ensemble WindField.
 *
 * Queries all models and returns the weighted mean, plus spread metrics.
 * Used for passage planning confidence assessment.
 */
export function createEnsembleWindField(sources: ModelSource[]): {
    windField: WindField;
    getEnsembleWind: (lat: number, lon: number, timeOffsetHours: number) => EnsembleWind | null;
} {
    const fields = sources.map((s) => ({
        name: s.name,
        field: createWindFieldFromGrid(s.grid, s.forecastBaseTime),
        weight: s.weight ?? 1.0,
    }));

    const totalWeight = fields.reduce((sum, f) => sum + f.weight, 0);

    function getEnsembleWind(lat: number, lon: number, timeOffsetHours: number): EnsembleWind | null {
        const results: { name: string; speed: number; direction: number; weight: number }[] = [];

        for (const f of fields) {
            const wind = f.field.getWind(lat, lon, timeOffsetHours);
            if (wind) {
                results.push({ name: f.name, speed: wind.speed, direction: wind.direction, weight: f.weight });
            }
        }

        if (results.length === 0) return null;

        // Weighted mean speed
        const meanSpeed = results.reduce((sum, r) => sum + r.speed * r.weight, 0) / totalWeight;

        // Weighted mean direction (circular mean using unit vectors)
        let sumSin = 0,
            sumCos = 0;
        for (const r of results) {
            const rad = (r.direction * Math.PI) / 180;
            sumSin += Math.sin(rad) * r.weight;
            sumCos += Math.cos(rad) * r.weight;
        }
        const meanDir = ((Math.atan2(sumSin / totalWeight, sumCos / totalWeight) * 180) / Math.PI + 360) % 360;

        // Spread metrics
        const speeds = results.map((r) => r.speed);
        const speedSpread = Math.max(...speeds) - Math.min(...speeds);

        // Direction spread (max angular difference between any two models)
        let maxDirDiff = 0;
        for (let i = 0; i < results.length; i++) {
            for (let j = i + 1; j < results.length; j++) {
                let diff = Math.abs(results[i].direction - results[j].direction);
                if (diff > 180) diff = 360 - diff;
                maxDirDiff = Math.max(maxDirDiff, diff);
            }
        }

        // Confidence assessment
        let confidence: 'high' | 'medium' | 'low' = 'high';
        if (speedSpread > 15 || maxDirDiff > 60) confidence = 'low';
        else if (speedSpread > 8 || maxDirDiff > 30) confidence = 'medium';

        return {
            speed: Math.round(meanSpeed * 10) / 10,
            direction: Math.round(meanDir),
            models: results.map((r) => ({ name: r.name, speed: r.speed, direction: r.direction })),
            spread: Math.round(speedSpread * 10) / 10,
            directionSpread: Math.round(maxDirDiff),
            confidence,
        };
    }

    // The WindField interface uses the ensemble mean
    const windField: WindField = {
        getWind(lat, lon, timeOffsetHours) {
            const ensemble = getEnsembleWind(lat, lon, timeOffsetHours);
            if (!ensemble) return null;
            return { speed: ensemble.speed, direction: ensemble.direction };
        },
    };

    return { windField, getEnsembleWind };
}
