import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';
import type { CurrentField2D } from '../services/routing/env/EnvFields';
import type { CurrentBounds } from '../services/weather/currentSeries';

const subscribe = (notify: () => void) => subscribeAuthIdentityScope(() => notify());

/** All route vertices must fit the same bounded cohort; a looping line cannot hide outside endpoints. */
export function forecastSteeringBounds(points: ReadonlyArray<{ lat: number; lon: number }>): CurrentBounds | null {
    if (!points.length || points.length > 4096) return null;
    let north = -90,
        south = 90,
        west = Infinity,
        east = -Infinity;
    const first = points[0].lon;
    for (const point of points) {
        if (![point.lat, point.lon].every(Number.isFinite) || Math.abs(point.lat) >= 90 || Math.abs(point.lon) > 180)
            return null;
        const lon = first + ((point.lon - first + 540) % 360) - 180;
        north = Math.max(north, point.lat);
        south = Math.min(south, point.lat);
        west = Math.min(west, lon);
        east = Math.max(east, lon);
    }
    if (east - west >= 180) return null;
    const wrap = (lon: number) => ((lon + 540) % 360) - 180;
    return {
        north: Math.min(90, north + 0.01),
        south: Math.max(-90, south - 0.01),
        west: wrap(west - 0.01),
        east: wrap(east + 0.01),
    };
}

/** RAM only. Account/boat/geometry/clock changes hide the old field before effects run. */
export function useForecastSteeringField(request: {
    points: ReadonlyArray<{ lat: number; lon: number }>;
    startMs: number;
    endMs: number;
    vesselKey: string;
    enabled: boolean;
    satelliteMode?: boolean;
}): CurrentField2D | null {
    const owner = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope);
    const bounds = request.enabled ? forecastSteeringBounds(request.points) : null;
    const startMs = Math.floor(request.startMs / 3_600_000) * 3_600_000;
    const endMs = Math.ceil(request.endMs / 3_600_000) * 3_600_000;
    const key = JSON.stringify([
        owner.key,
        owner.generation,
        request.vesselKey,
        bounds,
        startMs,
        endMs,
        !!request.satelliteMode,
    ]);
    const [loaded, setLoaded] = useState<{ key: string; field: CurrentField2D; expiresMs: number } | null>(null);
    useEffect(() => {
        if (!bounds || !Number.isFinite(startMs) || !Number.isFinite(endMs) || request.satelliteMode) return;
        const controller = new AbortController();
        void (async () => {
            const [{ loadRegionalCurrentSeries }, { currentFieldFromSeries }] = await Promise.all([
                import('../services/weather/api/currentRegionalLoader'),
                import('../services/routing/env/CmemsCurrentField'),
            ]);
            if (controller.signal.aborted || !isAuthIdentityScopeCurrent(owner)) return;
            const series = await loadRegionalCurrentSeries({ bounds, startMs, endMs, signal: controller.signal });
            if (series && !controller.signal.aborted && isAuthIdentityScopeCurrent(owner))
                setLoaded({ key, field: currentFieldFromSeries(series), expiresMs: series.expiresMs });
        })().catch(() => {
            /* Missing/invalid assets remain unavailable. */
        });
        return () => controller.abort();
        // The scalar key contains every request and identity field.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return loaded?.key === key && loaded.expiresMs > Date.now() ? loaded.field : null;
}
