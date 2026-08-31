import mapboxgl from 'mapbox-gl';
import { useEffect, type MutableRefObject } from 'react';
import { GpsService } from '../../services/GpsService';
import { NmeaGpsProvider } from '../../services/NmeaGpsProvider';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import { LocationStore } from '../../stores/LocationStore';

/**
 * The "you are here" dot — which, on a boat, means the BOAT.
 *
 * This used to watch the phone's GPS directly, which put the dot at the house
 * while the vessel sat on her mooring a mile out (Shane, 2026-08-31). The rest
 * of the app already answers "where is ownship" through one arbiter — NMEA
 * first while it is fresh, phone GPS as the fallback — and Guardian, the AIS
 * layer and the Log all use it. The chart now does too.
 *
 * The phone watch stays: it is both the fallback position and the tick that
 * repaints the dot, and NMEA updates repaint through their own subscription.
 */
export function useLocationDot(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    locationDotRef: MutableRefObject<mapboxgl.Marker | null>,
    mapReady: boolean,
) {
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // The NMEA store only ingests once something starts it, and until now
        // that something was the Instrument Panel — so a skipper who launched
        // the app straight into the chart got a phone-positioned dot while the
        // boat streamed unheard (Shane, 2026-08-31: "instrument panel is
        // correct, obs screen is incorrect"). Claim it here exactly the way
        // TheGlassPage does: start() is idempotent, and the config gate means
        // a phone that has never met a gateway opens no sockets.
        if (NmeaListenerService.getSavedConfig()) NmeaStore.start();

        const place = (latitude: number, longitude: number, viaVessel: boolean) => {
            if (!locationDotRef.current) {
                const el = document.createElement('div');
                el.className = 'loc-dot';
                locationDotRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([longitude, latitude])
                    .addTo(map);
            } else {
                locationDotRef.current.setLngLat([longitude, latitude]);
            }
            // A quiet tell for anyone debugging which truth the dot is on.
            locationDotRef.current.getElement().dataset.source = viaVessel ? 'vessel' : 'phone';
        };

        const update = (phone?: { latitude: number; longitude: number }) => {
            const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState());
            if (own && own.source === 'nmea') {
                place(own.lat, own.lon, true);
            } else if (phone) {
                place(phone.latitude, phone.longitude, false);
            } else if (own) {
                place(own.lat, own.lon, false);
            }
        };

        const unsubGps = GpsService.watchPosition((pos) => update(pos));
        const unsubNmea = NmeaGpsProvider.onPosition(() => update());
        update();

        return () => {
            unsubGps();
            unsubNmea();
            if (locationDotRef.current) {
                locationDotRef.current.remove();
                locationDotRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady]);
}
