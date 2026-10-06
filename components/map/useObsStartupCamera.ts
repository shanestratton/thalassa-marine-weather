import { useEffect, useRef, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { NmeaStore } from '../../services/NmeaStore';
import {
    acquireFreshOwnshipPosition,
    getCachedOwnshipPosition,
    type OwnshipPosition,
} from '../../services/ownshipPosition';
import { getWeatherFollowKey } from '../../services/weatherPosition';
import { LocationStore } from '../../stores/LocationStore';

/**
 * The Obs chart's zoom on the vessel: where it opens and where the find-boat
 * button flies (Shane 2026-10-06: "default to the vessel zoomed in at zoom 14
 * in the centre"; the find-boat button since 2026-10-05). Other charts keep
 * the z10 boot.
 */
export const OBS_VESSEL_ZOOM = 14;

/**
 * The Obs chart's zoom on a place chosen in the location box: the z10 golden
 * boot (every nav mark visible, local water filling the screen), the same
 * zoom the recentre-on-location button flies to.
 */
export const OBS_PLACE_ZOOM = 10;

interface LatLon {
    lat: number;
    lon: number;
}

/**
 * Where Obs opens: what the location box points at (Shane 2026-10-06: "if i
 * put hawaii in the glass page, when i go to the obs page, it should show me
 * that location from the get go").
 *
 *  · 'vessel' — the box follows a receiver (Current Location: the phone, the
 *    boat or the boat crewed on). Obs opens on the vessel at z14, from a real
 *    fix only.
 *  · 'place' — the box holds a chosen place (a search, a saved spot, a map
 *    pick). Obs opens there at z10. `center` is null until a name-only choice
 *    has resolved its coordinates; Obs waits rather than hopping via the boat.
 *
 * A place only ever moves the camera. It is never handed to anything that
 * stands for the vessel (ownship, the boat marker, find-boat).
 */
export type ObsStartTarget = { kind: 'vessel' } | { kind: 'place'; key: string; center: LatLon | null };

export const OBS_START_VESSEL: ObsStartTarget = { kind: 'vessel' };

const validPoint = (pt?: LatLon | null): pt is LatLon =>
    !!pt &&
    Number.isFinite(pt.lat) &&
    Number.isFinite(pt.lon) &&
    Math.abs(pt.lat) <= 90 &&
    Math.abs(pt.lon) <= 180 &&
    (pt.lat !== 0 || pt.lon !== 0);

/**
 * Read the location box. `defaultLocation` is the selection itself ('Current
 * Location' while following); its saved coordinates identify a pick exactly,
 * and the displayed report's coordinates fill in for a name-only choice.
 */
export function obsStartTarget(box: {
    defaultLocation?: string | null;
    defaultLocationCoords?: LatLon | null;
    weatherCoords?: LatLon | null;
}): ObsStartTarget {
    const name = box.defaultLocation?.trim();
    if (!name || name === 'Current Location') return OBS_START_VESSEL;
    const picked = validPoint(box.defaultLocationCoords) ? box.defaultLocationCoords : null;
    const center = picked ?? (validPoint(box.weatherCoords) ? box.weatherCoords : null);
    // The key is the CHOICE, not the report: a forecast refining its
    // coordinates is not the skipper moving the box.
    const key = picked ? `place:${name}@${picked.lat.toFixed(4)},${picked.lon.toFixed(4)}` : `place:${name}`;
    return { kind: 'place', key, center: center ? { lat: center.lat, lon: center.lon } : null };
}

/** What the box points at right now; a follow target counts as a change of box. */
function obsStartKey(target: ObsStartTarget): string {
    return target.kind === 'place' ? target.key : `follow:${getWeatherFollowKey()}`;
}

/**
 * Centre OBS where the location box points: a chosen place at z10 at once, or
 * the vessel at z14 on a real fix (passive late GPS allowed until the skipper
 * takes over the camera).
 *
 * Once per box: a later visit keeps wherever the skipper left the chart, and
 * only a change of box (a new place, or a new follow target) recentres, the
 * next time Obs shows. Layer toggles never move it (see useLayerFrameSnap).
 */
export function useObsStartupCamera(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabled: boolean,
    target: ObsStartTarget = OBS_START_VESSEL,
): void {
    /** The box the camera last settled for (centred, or the skipper took over). */
    const settledKey = useRef<string | null>(null);
    /** The box a centring is in progress for. */
    const activeKey = useRef<string | null>(null);
    /** Obs was showing on the previous run, so this run is not a fresh visit. */
    const showing = useRef(false);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const targetRef = useRef(target);
    targetRef.current = target;

    const placeKey = target.kind === 'place' ? target.key : null;
    const placeLat = target.kind === 'place' ? (target.center?.lat ?? null) : null;
    const placeLon = target.kind === 'place' ? (target.center?.lon ?? null) : null;

    useEffect(() => {
        if (!enabled) {
            showing.current = false;
            // A pending launch must not recapture the camera after visiting
            // Plan, a picker, a shared pin, or another tab. The exception is a
            // name-only place still resolving: it never centred, and leaving
            // is not the skipper taking over, so the next visit opens on it.
            if (activeKey.current !== null) {
                const pending = targetRef.current;
                const unresolvedPlace =
                    pending.kind === 'place' && !pending.center && pending.key === activeKey.current;
                if (!unresolvedPlace) settledKey.current = activeKey.current;
                activeKey.current = null;
            }
            return;
        }
        const map = mapRef.current;
        if (!map) return;
        const freshVisit = !showing.current;
        showing.current = true;
        const current = targetRef.current;
        const key = obsStartKey(current);
        if (activeKey.current === null) {
            // Only a visit starts a centring, and only for a box the camera
            // has not already settled for.
            if (!freshVisit || key === settledKey.current) return;
        }
        // Also covers the box moving before the camera settled (boot order).
        activeKey.current = key;

        let disposed = false;
        let unsubNmea: (() => void) | undefined;
        let unsubLocation: (() => void) | undefined;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            unsubNmea?.();
            unsubLocation?.();
            map.off('movestart', onGesture);
            map.off('zoomstart', onGesture);
            map.off('dragstart', onGesture);
        };
        const settle = () => {
            settledKey.current = activeKey.current;
            activeKey.current = null;
            dispose();
        };
        const onGesture = (event: unknown) => {
            if (!event || typeof event !== 'object' || !('originalEvent' in event) || !event.originalEvent) return;
            settle();
        };
        const jump = (point: LatLon, zoom: number) => {
            if (disposed || activeKey.current !== key || !enabledRef.current || mapRef.current !== map) return;
            settle();
            map.jumpTo({ center: [point.lon, point.lat], zoom });
        };

        if (current.kind === 'place') {
            // The camera moves; nothing else learns the place. Ownship is not
            // read, subscribed or refreshed, so no boat hop and no masquerade.
            if (current.center) {
                jump(current.center, OBS_PLACE_ZOOM);
                return dispose;
            }
            // Name-only choice still resolving: wait for it, unless the
            // skipper takes the camera first.
            map.on('movestart', onGesture);
            map.on('zoomstart', onGesture);
            map.on('dragstart', onGesture);
            return dispose;
        }

        const centre = (position: OwnshipPosition | null) => {
            if (position) jump(position, OBS_VESSEL_ZOOM);
        };
        const centreCached = () => centre(getCachedOwnshipPosition());

        // Listen while the style loads, so a gesture before mapReady also
        // prevents a late GPS result from undoing the skipper's view.
        map.on('movestart', onGesture);
        map.on('zoomstart', onGesture);
        map.on('dragstart', onGesture);
        if (mapReady) {
            unsubNmea = NmeaStore.subscribe(centreCached);
            unsubLocation = LocationStore.subscribe(centreCached);
            centreCached();
            if (!disposed) {
                void acquireFreshOwnshipPosition({ locationAccess: 'already-granted' }).then((position) => {
                    // The boat can report while the phone lookup is pending.
                    // Recheck the arbiter so that late phone data cannot win.
                    centre(getCachedOwnshipPosition() ?? position);
                });
            }
        }
        return dispose;
    }, [enabled, mapReady, mapRef, placeKey, placeLat, placeLon]);
}
