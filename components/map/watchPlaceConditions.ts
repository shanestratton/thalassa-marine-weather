import type mapboxgl from 'mapbox-gl';
import { loadPlaceConditions } from '../../services/anchorages/PlaceConditionsService';
import { distanceNM, type ConditionsPlace } from '../../services/anchorages/placeConditions';

/** Only runs while the owning overlay is mounted. Repaints before fetching so
 * stale/offline green cannot persist; generation fences avoid late UI writes. */
export function watchPlaceConditions(map: mapboxgl.Map, places: () => ConditionsPlace[], paint: () => void) {
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
        if (disposed) return;
        const own = ++generation;
        paint();
        if (document.visibilityState === 'hidden') return;
        if (map.getZoom() < 9) return;
        const b = map.getBounds();
        if (!b) return;
        const centre = map.getCenter();
        const visible = places()
            .filter((p) => {
                const lon = p.lon + Math.round((centre.lng - p.lon) / 360) * 360;
                return p.lat >= b.getSouth() && p.lat <= b.getNorth() && lon >= b.getWest() && lon <= b.getEast();
            })
            .sort(
                (a, z) =>
                    distanceNM(a, { lat: centre.lat, lon: centre.lng }) -
                    distanceNM(z, { lat: centre.lat, lon: centre.lng }),
            );
        await loadPlaceConditions(visible);
        if (!disposed && own === generation) paint();
    };
    const changed = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            void refresh();
        }, 350);
    };
    const visibility = () => {
        if (document.visibilityState === 'visible') changed();
    };
    map.on('moveend', changed);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    document.addEventListener('visibilitychange', visibility);
    const interval = setInterval(changed, 60_000);
    changed();
    return {
        changed,
        dispose: () => {
            disposed = true;
            generation++;
            clearTimeout(timer);
            clearInterval(interval);
            map.off('moveend', changed);
            window.removeEventListener('online', changed);
            window.removeEventListener('offline', changed);
            document.removeEventListener('visibilitychange', visibility);
        },
    };
}
