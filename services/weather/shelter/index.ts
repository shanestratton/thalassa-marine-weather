/**
 * shelter — orchestrates the sheltered-water wave fix.
 *
 *   coastline (OSM) → enclosure raycast → fetch-limited cap on the wave fields.
 *
 * `assessShelter` is best-effort and cached; `dampReportWaves` only ever pulls
 * wave heights DOWN, and only when geometry says the point is genuinely boxed
 * in — so an exposed coast (or any spot where coastline data is unavailable) is
 * left exactly as the model reported it.
 */

import { fetchCoastlineSegments } from './coastlineSource';
import { assessFetch } from './shelterGeometry';
import { capWaveToFetch } from './fetchLimitedSea';
import type { MarineWeatherReport } from '../../../types';

const FT_PER_M = 3.28084;
const M_PER_FT = 0.3048;

export interface ShelterInfo {
    enclosed: boolean;
    /** Longest over-water fetch (km) — the generous bound used for capping. */
    maxFetchKm: number;
}

const assessCache = new Map<string, ShelterInfo>();

function key(lat: number, lon: number): string {
    const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
    return `${r(lat)}_${r(lon)}`;
}

/**
 * Whether the point sits in enclosed water and, if so, its longest fetch.
 * Returns null when coastline data can't be had (caller leaves waves alone).
 */
export async function assessShelter(lat: number, lon: number): Promise<ShelterInfo | null> {
    const k = key(lat, lon);
    const cached = assessCache.get(k);
    if (cached) return cached;

    const coast = await fetchCoastlineSegments(lat, lon);
    if (!coast) return null; // transient — don't cache, retry next time

    const fa = assessFetch(lat, lon, coast);
    const info: ShelterInfo = { enclosed: fa.enclosed, maxFetchKm: fa.maxFetchKm };
    assessCache.set(k, info);
    return info;
}

/** Cap one feet-valued wave height at the local fetch. */
function capFeet(
    waveFt: number | null | undefined,
    windKts: number | null | undefined,
    fetchKm: number,
): { ft: number | null | undefined; capped: boolean } {
    if (waveFt == null || !Number.isFinite(waveFt)) return { ft: waveFt, capped: false };
    const { hsMeters, capped } = capWaveToFetch(waveFt * M_PER_FT, windKts, fetchKm);
    if (!capped) return { ft: waveFt, capped: false };
    return { ft: parseFloat((hsMeters * FT_PER_M).toFixed(1)), capped: true };
}

/**
 * Cap the report's wave fields (current / hourly / forecast — all in feet) at
 * what the local fetch can sustain, using each sample's own wind. Mutates the
 * report and flags it. Returns true if anything was adjusted.
 */
export function dampReportWaves(report: MarineWeatherReport, shelter: ShelterInfo): boolean {
    if (!shelter.enclosed) return false;
    const F = shelter.maxFetchKm;
    let any = false;

    if (report.current) {
        const c = capFeet(report.current.waveHeight, report.current.windSpeed, F);
        if (c.capped) {
            report.current = { ...report.current, waveHeight: c.ft as number };
            any = true;
        }
    }

    if (Array.isArray(report.hourly)) {
        report.hourly = report.hourly.map((h) => {
            const c = capFeet(h.waveHeight, h.windSpeed, F);
            if (c.capped) {
                any = true;
                return { ...h, waveHeight: c.ft as number };
            }
            return h;
        });
    }

    if (Array.isArray(report.forecast)) {
        report.forecast = report.forecast.map((d) => {
            const c = capFeet(d.waveHeight, d.windSpeed, F);
            if (c.capped) {
                any = true;
                return { ...d, waveHeight: c.ft as number };
            }
            return d;
        });
    }

    if (any) {
        report.shelterAdjusted = true;
        report.shelterFetchKm = Math.round(F);
    }
    return any;
}
