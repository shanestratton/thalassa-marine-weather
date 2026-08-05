import mapboxgl from 'mapbox-gl';
import { useEffect, type MutableRefObject } from 'react';
import { GpsService } from '../../services/GpsService';

export function useLocationDot(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    locationDotRef: MutableRefObject<mapboxgl.Marker | null>,
    mapReady: boolean,
) {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const unsub = GpsService.watchPosition((pos) => {
            const { latitude, longitude } = pos;
            if (!locationDotRef.current) {
                const el = document.createElement('div');
                el.className = 'loc-dot';
                locationDotRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([longitude, latitude])
                    .addTo(map);
            } else {
                locationDotRef.current.setLngLat([longitude, latitude]);
            }
        });

        return () => {
            unsub();
            if (locationDotRef.current) {
                locationDotRef.current.remove();
                locationDotRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady]);
}
