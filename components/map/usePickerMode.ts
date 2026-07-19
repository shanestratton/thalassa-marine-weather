import mapboxgl from 'mapbox-gl';
import { useEffect, type MutableRefObject } from 'react';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';
import { createPinMarker } from '../../utils/createMarkerEl';
import { LocationStore } from '../../stores/LocationStore';

const log = createLogger('usePickerMode');

export function usePickerMode(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    pinMarkerRef: MutableRefObject<mapboxgl.Marker | null>,
    pickerMode: boolean,
    onLocationSelect?: (lat: number, lon: number, name?: string) => void,
) {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !pickerMode) return;

        const handleClick = async (e: mapboxgl.MapMouseEvent) => {
            const { lng, lat } = e.lngLat;
            triggerHaptic('medium');

            if (pinMarkerRef.current) pinMarkerRef.current.remove();
            const el = createPinMarker({ size: 28 });
            pinMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
                .setLngLat([lng, lat])
                .addTo(map);

            const fallback = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;

            // Claim the store as a user-placed pin BEFORE the geocode.
            // useLiveLocationName re-stamps source:'gps' every 3s and only
            // yields to 'map_pin', so without this the boat's own position
            // overwrites the picked location's name on The Glass within
            // seconds — the weather is fetched for the pick, but every
            // label says where the boat is. Long-press already does this
            // (useMapInit); the location-box picker never did.
            void LocationStore.setFromMapPin(lat, lng, fallback);

            try {
                const { reverseGeocode } = await import('../../services/weatherService');
                const name = await reverseGeocode(lat, lng);
                const display = name || fallback;
                void LocationStore.setFromMapPin(lat, lng, display);
                onLocationSelect?.(lat, lng, display);
            } catch (e) {
                log.warn('[MapHub]', e);
                onLocationSelect?.(lat, lng, fallback);
            }
        };

        map.on('click', handleClick);
        return () => {
            map.off('click', handleClick);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pickerMode, onLocationSelect]);
}
