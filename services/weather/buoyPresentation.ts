import type { EvidenceStation, MeasuredBuoyDetail } from './evidenceContract';
export const BUOY_LAYER_SOURCE = 'measured-buoys141-source';
export const BUOY_LAYER_POINTS = 'measured-buoys141-points';
export const BUOY_CREDIT =
    'NOAA NDBC preliminary automated realtime screening; Queensland DES operational wave buoys provisional. Per-network source and original measurement times remain attached.';
export function buoyAge(observedAt: number, nowMs: number): string {
    const minutes = Math.floor((nowMs / 1000 - observedAt) / 60);
    return minutes < 0
        ? 'time unavailable'
        : minutes < 60
          ? `${minutes} min ago`
          : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}
/** Pick at most64 current viewport stations at least44px apart; no fetch/camera action. */
export function thinnedBuoyStations(
    stations: readonly EvidenceStation[],
    nowMs: number,
    project: (station: EvidenceStation) => { x: number; y: number },
    width: number,
    height: number,
): readonly EvidenceStation[] {
    if (!Number.isFinite(nowMs) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return [];
    const occupied: { x: number; y: number }[] = [];
    const result: EvidenceStation[] = [];
    for (const station of stations) {
        if (nowMs >= station.expiresAt * 1000 || Math.abs(station.lat) > 85.05112878) continue;
        const point = project(station);
        if (
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y) ||
            point.x < 0 ||
            point.y < 0 ||
            point.x > width ||
            point.y > height
        )
            continue;
        if (occupied.some((previous) => Math.hypot(previous.x - point.x, previous.y - point.y) < 44)) continue;
        occupied.push(point);
        result.push(station);
        if (result.length >= 64) break;
    }
    return result;
}
/** Dots preserve irregular sampling and missing values instead of interpolating gaps. */
export function buoyGraph(detail: MeasuredBuoyDetail, nowMs: number) {
    const end = Math.floor(nowMs / 1000);
    const start = end - 72 * 3600;
    const all = [...detail.measured, ...detail.issuedForecasts.flatMap((line) => line.points)];
    const max = Math.max(1, ...all.filter((p) => p[0] >= start && p[0] <= end).map((p) => p[1]));
    const top = Math.ceil(max * 1.15 * 10) / 10;
    const dots = (points: readonly (readonly number[])[]) =>
        points
            .filter((p) => p[0] >= start && p[0] <= end)
            .map(
                (p) =>
                    `M${(35 + ((p[0] - start) / (end - start)) * 275 - 0.75).toFixed(2)},${(120 - (p[1] / top) * 100).toFixed(2)}h1.5`,
            )
            .join('');
    return {
        start,
        end,
        top,
        measured: dots(detail.measured),
        issued: detail.issuedForecasts.map((line) => ({ model: line.model, path: dots(line.points) })),
    };
}
