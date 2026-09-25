import { useEffect, useRef, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { NmeaStore } from '../../services/NmeaStore';
import {
    acquireFreshOwnshipPosition,
    getCachedOwnshipPosition,
    type OwnshipPosition,
} from '../../services/ownshipPosition';
import { LocationStore } from '../../stores/LocationStore';

/** Centre OBS once on a real fix; weather/home selections never own this camera. */
export function useObsStartupCamera(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabled: boolean,
): void {
    const started = useRef(false);
    const finished = useRef(false);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    useEffect(() => {
        if (!enabled) {
            // A pending launch must not recapture the camera after visiting
            // Plan, a picker, a shared pin, or another tab.
            if (started.current) finished.current = true;
            return;
        }
        const map = mapRef.current;
        if (!map || finished.current) return;
        started.current = true;

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
        const onGesture = (event: unknown) => {
            if (!event || typeof event !== 'object' || !('originalEvent' in event) || !event.originalEvent) return;
            finished.current = true;
            dispose();
        };
        const centre = (position: OwnshipPosition | null) => {
            if (disposed || finished.current || !enabledRef.current || mapRef.current !== map || !position) return;
            finished.current = true;
            dispose();
            map.jumpTo({ center: [position.lon, position.lat], zoom: 10 });
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
            if (!finished.current) {
                void acquireFreshOwnshipPosition({ locationAccess: 'already-granted' }).then((position) => {
                    // The boat can report while the phone lookup is pending.
                    // Recheck the arbiter so that late phone data cannot win.
                    centre(getCachedOwnshipPosition() ?? position);
                });
            }
        }
        return dispose;
    }, [enabled, mapReady, mapRef]);
}
