import type mapboxgl from 'mapbox-gl';

export type MapPoint = { lat: number; lon: number };

/** Fallback name for a tapped point with no geocoded place name. */
export function coordName(lat: number, lon: number): string {
    return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
}

/**
 * Cache key for one trace leg. The final leg owns marks projected onto its far
 * endpoint, so it must re-grade when a new pin makes it an interior leg.
 */
export function legCacheKey(a: MapPoint, b: MapPoint, isLast: boolean): string {
    return `${a.lat.toFixed(6)},${a.lon.toFixed(6)}|${b.lat.toFixed(6)},${b.lon.toFixed(6)}${isLast ? '|last' : ''}`;
}

/** Fit a saved route's complete extent without obscuring it behind map UI. */
export function fitTraceBounds(map: mapboxgl.Map, points: readonly MapPoint[]): void {
    if (points.length === 0) return;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const point of points) {
        minLon = Math.min(minLon, point.lon);
        minLat = Math.min(minLat, point.lat);
        maxLon = Math.max(maxLon, point.lon);
        maxLat = Math.max(maxLat, point.lat);
    }
    map.fitBounds(
        [
            [minLon, minLat],
            [maxLon, maxLat],
        ],
        { padding: { top: 90, bottom: 130, left: 300, right: 40 }, maxZoom: 15, duration: 900 },
    );
}

/** Maximum span of one trace-grading context window. */
export const TRACE_CLUSTER_SPAN_M = 24_000;
/** Auto-routed legs are split below the depth-grid grading ceiling. */
export const AUTO_MAX_LEG_M = 15_000;
/** Keep a safe route when its detour remains close to the direct line. */
export const NEAR_DIRECT_CAP = 1.15;
/** Adopt a tide-direct route only when it materially improves the safe route. */
export const TIDE_ADOPT_FACTOR = 0.7;

// Parked presentation flags. Wiring stays compiled and tested so the features
// can be deliberately reintroduced without reviving dead code.
export const AUTO_ROUTE_BUTTON_VISIBLE = false;
export const TRACER_COPY_BUTTON_VISIBLE = false;
export const SAIL_IT_BUTTON_VISIBLE = false;
export const CHARTS_FAB_CATEGORY_VISIBLE = false;
export const COURSE_FRAME_VISIBLE = false;
export const TRACER_CARD_LIBRARY_VISIBLE = false;
export const TRACER_CARD_SHARE_VISIBLE = false;

/** Equirectangular distance in metres between two nearby points. */
export function distMetres(a: MapPoint, b: MapPoint): number {
    const metresPerLonDegree = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return Math.hypot((b.lat - a.lat) * 110_540, (b.lon - a.lon) * metresPerLonDegree);
}

/** Epoch milliseconds to the local value expected by datetime-local inputs. */
export function msToLocalInput(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
