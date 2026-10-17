import { useEffect } from 'react';
import type { RefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import type { TraceRoutePoint } from '../../services/routing/traceRoutePoint';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
/** A hollow reference mark is distinct from the numbered, draggable passing
 * point. Both positions are the user's private choices, never chart facts. */
export function useTracerConstraintMarks(
    mapRef: RefObject<mapboxgl.Map | null>,
    active: boolean,
    points: readonly TraceRoutePoint[],
): void {
    useEffect(() => {
        if (!active || !points.some((p) => p.constraint)) return;
        const owner = getAuthIdentityScope();
        const marks: mapboxgl.Marker[] = [];
        let stopped = false,
            attempts = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        const clear = () => {
            marks.splice(0).forEach((m) => m.remove());
        };
        const install = () => {
            const map = mapRef.current;
            if (stopped || !isAuthIdentityScopeCurrent(owner)) return true;
            if (!map) return false;
            for (const point of points) {
                const mark = point.constraint;
                if (!mark || marks.length >= 256) continue;
                const el = document.createElement('div');
                el.textContent = `◇ Mark · ${mark.leaveSide}`;
                el.style.cssText =
                    'color:#fff;background:#0f172a;border:1px dashed #fbbf24;border-radius:5px;padding:3px 5px;font:700 10px system-ui;pointer-events:none;';
                el.setAttribute('aria-label', `Original user mark; leave to ${mark.leaveSide}`);
                marks.push(new mapboxgl.Marker({ element: el }).setLngLat([mark.lon, mark.lat]).addTo(map));
            }
            return true;
        };
        const unsubscribe = subscribeAuthIdentityScope(() => {
            stopped = true;
            if (timer) clearInterval(timer);
            clear();
        });
        if (!install())
            timer = setInterval(() => {
                if (++attempts >= 100 || install()) {
                    clearInterval(timer);
                    timer = undefined;
                }
            }, 200);
        return () => {
            stopped = true;
            if (timer) clearInterval(timer);
            unsubscribe();
            clear();
        };
    }, [mapRef, active, points]);
}
