import mapboxgl from 'mapbox-gl';
import { useEffect, type MutableRefObject } from 'react';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';

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
            const el = document.createElement('div');
            el.innerHTML = `<div style="
                width: 28px; height: 28px; background: #38bdf8;
                border: 3px solid #fff; border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg); box-shadow: 0 4px 12px rgba(56,189,248,0.5);
                animation: pinBounce 0.3s ease-out;
            "></div>`;
            pinMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
                .setLngLat([lng, lat])
                .addTo(map);

            try {
                const { reverseGeocode } = await import('../../services/weatherService');
                const name = await reverseGeocode(lat, lng);
                const fallback = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
                onLocationSelect?.(lat, lng, name || fallback);
            } catch (e) {
                log.warn('[MapHub]', e);
                const fallback = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
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
