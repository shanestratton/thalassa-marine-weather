/**
 * Where the satellite land check samples a route, and what the charts can say
 * at a sample (127-ROUTE-W). Pure, and imports nothing that does IO: the
 * route job (services/routing/routeJob.ts) works out the charts' verdict at
 * every sample in the route worker, and the check itself
 * (services/routing/landBackstop.ts, which re-exports all of this) asks NOAA
 * ETOPO about the same samples on the main thread. Same samples, same
 * verdicts: `chartVerdicts.length === samplePolyline(polyline).length`.
 */
import type { ChartWaterVerdict } from '../engine/chartWaterEvidence';

export type LonLat = [number, number];

/** Along-route sampling interval. */
export const SAMPLE_STEP_M = 400;
/** Hard cap on samples per validation (legacy gebco-depth endpoint batch limit). */
export const MAX_SAMPLES = 180;

/** What the charts said at one sample: a probe's verdict, or 'unchecked'
 *  where the probe threw (it vouches nothing there — fail closed). */
export type BackstopChartVerdict = ChartWaterVerdict | 'unchecked';

/** Great-circle metres between two [lon, lat] points. */
export function greatCircleM(a: LonLat, b: LonLat): number {
    const R = 6371000;
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/** Pure: sample a polyline every ~stepM, capped at maxSamples (incl. ends). */
export function samplePolyline(polyline: LonLat[], stepM = SAMPLE_STEP_M, maxSamples = MAX_SAMPLES): LonLat[] {
    if (polyline.length < 2) return [...polyline];
    let total = 0;
    for (let i = 0; i < polyline.length - 1; i++) total += greatCircleM(polyline[i], polyline[i + 1]);
    const step = Math.max(stepM, total / Math.max(1, maxSamples - 1));

    const out: LonLat[] = [polyline[0]];
    let carried = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const segLen = greatCircleM(a, b);
        if (segLen === 0) continue;
        let along = step - carried;
        while (along < segLen) {
            const t = along / segLen;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            along += step;
        }
        carried = (carried + segLen) % step;
    }
    out.push(polyline[polyline.length - 1]);
    return out;
}
