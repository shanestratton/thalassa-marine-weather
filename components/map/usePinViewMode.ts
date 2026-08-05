/**
 * usePinViewMode — pin-view (chat pin tap) behaviour: the visual pin marker,
 * the temporary weather-layer snapshot/clear/restore, the auth-identity sync
 * that exits pin view when the account changes, and the Get Directions
 * handler that builds a Mapbox driving route to the pin.
 *
 * Extracted verbatim from MapHub.tsx as part of the MapHub decomposition.
 * Closure captures became the `deps` parameter; no logic changes. The
 * `isPinView` state and `ownedPinViewRef` themselves STAY in MapHub (the
 * tracer region reads them) and arrive here as parameters — only the
 * pin-view effects/handlers moved. `readCurrentPinView` and the
 * `PinViewHandoff` type moved here from MapHub module scope (now exported;
 * MapHub still uses both).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import mapboxgl from 'mapbox-gl';
import {
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import type { WeatherLayer } from './mapConstants';
import type { useWeatherLayers } from './useWeatherLayers';
import type { useWeather } from '../../context/WeatherContext';

export type PinViewHandoff = {
    lat: number;
    lng: number;
    identity: AuthIdentityScope;
};

export function readCurrentPinView(): PinViewHandoff | null {
    if (typeof window === 'undefined') return null;
    const pinView = window.__thalassaPinView;
    if (!pinView) return null;
    if (!isAuthIdentityScopeCurrent(pinView.identity)) {
        if (window.__thalassaPinView === pinView) delete window.__thalassaPinView;
        return null;
    }
    return pinView;
}

export interface PinViewModeDeps {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    isPinView: boolean;
    setIsPinView: Dispatch<SetStateAction<boolean>>;
    ownedPinViewRef: MutableRefObject<PinViewHandoff | null>;
    pinMarkerRef: MutableRefObject<mapboxgl.Marker | null>;
    weather: Pick<
        ReturnType<typeof useWeatherLayers>,
        'userLayers' | 'setActiveLayer' | 'activeLayers' | 'toggleLayer'
    >;
    cycloneVisible: boolean;
    setCycloneVisible: Dispatch<SetStateAction<boolean>>;
    squallVisible: boolean;
    setSquallVisible: Dispatch<SetStateAction<boolean>>;
    saveVoyagePlan: ReturnType<typeof useWeather>['saveVoyagePlan'];
}

export function usePinViewMode({
    mapRef,
    mapReady,
    isPinView,
    setIsPinView,
    ownedPinViewRef,
    pinMarkerRef,
    weather,
    cycloneVisible,
    setCycloneVisible,
    squallVisible,
    setSquallVisible,
    saveVoyagePlan,
}: PinViewModeDeps) {
    // ── Pin View: Drop a visual-only pin marker (no navigation side-effects) ──
    useEffect(() => {
        const pv = readCurrentPinView();
        if (!isPinView || !pv || !mapReady || !mapRef.current) return;
        ownedPinViewRef.current = pv;
        const map = mapRef.current;

        // Remove any existing pin
        if (pinMarkerRef.current) pinMarkerRef.current.remove();

        // Create visual pin marker
        const el = document.createElement('div');
        el.className = 'mapbox-pin-marker';
        const pinDiv = document.createElement('div');
        pinDiv.style.cssText =
            'width:32px;height:32px;background:linear-gradient(135deg,#f59e0b,#ef4444);border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 4px 16px rgba(245,158,11,0.5);animation:pinBounce 0.4s ease-out;';
        el.appendChild(pinDiv);
        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([pv.lng, pv.lat]).addTo(map);
        pinMarkerRef.current = marker;

        // Fly to the pin
        map.flyTo({ center: [pv.lng, pv.lat], zoom: 7, duration: 1200 });
        return () => {
            if (pinMarkerRef.current === marker) {
                marker.remove();
                pinMarkerRef.current = null;
            }
        };
    }, [isPinView, mapReady, mapRef, ownedPinViewRef, pinMarkerRef]);

    // ── Pin View: temporarily clear weather overlays for a clean map ──
    // Shane: "when the punter does click the pin, we need to ensure
    // there are no other layers showing. at the moment, all the layers
    // that where on stay there." Solution: snapshot the user's active
    // weather layers + cyclone/squall toggles when entering pin view,
    // turn them off, restore on exit. The user's chart-catalog
    // selection (their chosen vector charts) stays — that's
    // legitimate context for navigating to a pin.
    const savedLayersRef = useRef<{
        weather: Set<WeatherLayer> | null;
        cyclone: boolean;
        squall: boolean;
    } | null>(null);
    useEffect(() => {
        if (!isPinView) return;
        // Snapshot
        savedLayersRef.current = {
            // userLayers, not activeLayers — the latter reads empty under any
            // suppressing surface, and this snapshot is restored on exit.
            weather: new Set(weather.userLayers),
            cyclone: cycloneVisible,
            squall: squallVisible,
        };
        // Clear
        weather.setActiveLayer('none');
        setCycloneVisible(false);
        setSquallVisible(false);
        return () => {
            // Restore on exit
            const saved = savedLayersRef.current;
            if (!saved) return;
            // Restore weather layers one by one (toggleLayer preserves
            // cross-group selections, which is how the user had them).
            saved.weather?.forEach((layer) => {
                if (!weather.activeLayers.has(layer)) weather.toggleLayer(layer);
            });
            setCycloneVisible(saved.cyclone);
            setSquallVisible(saved.squall);
            savedLayersRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPinView]);

    // ── Pin View: Get Directions handler ──
    // Builds a Mapbox driving route from current GPS to the pin and
    // saves it as a VoyagePlan. Exits pin view on success so the
    // user's normal layers come back along with the route, ready to
    // navigate.
    const [pinDirectionsBusy, setPinDirectionsBusy] = useState(false);
    const [pinDirectionsError, setPinDirectionsError] = useState<string | null>(null);

    useEffect(() => {
        const syncIdentity = () => {
            const pinView = readCurrentPinView();
            ownedPinViewRef.current = pinView;
            setIsPinView(!!pinView);
            setPinDirectionsBusy(false);
            setPinDirectionsError(null);
        };
        const unsubscribeIdentity = subscribeAuthIdentityScope(syncIdentity);
        return () => {
            unsubscribeIdentity();
            const ownedPinView = ownedPinViewRef.current;
            if (ownedPinView && window.__thalassaPinView === ownedPinView) {
                delete window.__thalassaPinView;
            }
            ownedPinViewRef.current = null;
        };
    }, [ownedPinViewRef, setIsPinView]);

    const handlePinDirections = useCallback(async () => {
        const pv = readCurrentPinView();
        if (!pv || pinDirectionsBusy) return;
        ownedPinViewRef.current = pv;
        const actionScope = pv.identity;
        const destination = Object.freeze({ lat: pv.lat, lng: pv.lng });
        setPinDirectionsBusy(true);
        setPinDirectionsError(null);
        try {
            const { GpsService } = await import('../../services/GpsService');
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            const pos = await GpsService.requestCurrentForegroundPosition({ staleLimitMs: 30_000, timeoutSec: 10 });
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            if (!pos) {
                setPinDirectionsError('Could not get your GPS position.');
                return;
            }
            const { buildDirectionsVoyagePlan } = await import('../../services/MapboxDirectionsService');
            if (!isAuthIdentityScopeCurrent(actionScope)) return;
            const plan = await buildDirectionsVoyagePlan(
                { lat: pos.latitude, lon: pos.longitude, name: 'My Location' },
                { lat: destination.lat, lon: destination.lng, name: 'Pin' },
                'driving',
            );
            if (!isAuthIdentityScopeCurrent(actionScope) || window.__thalassaPinView !== pv) return;
            if (!plan) {
                setPinDirectionsError('No driving route found.');
                return;
            }
            saveVoyagePlan(plan);
            // Exit pin view so layers/route are visible normally.
            delete window.__thalassaPinView;
            ownedPinViewRef.current = null;
            setIsPinView(false);
        } catch (e) {
            if (isAuthIdentityScopeCurrent(actionScope)) {
                setPinDirectionsError(e instanceof Error ? e.message : 'Directions failed.');
            }
        } finally {
            if (isAuthIdentityScopeCurrent(actionScope)) {
                setPinDirectionsBusy(false);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pinDirectionsBusy]);

    return { pinDirectionsBusy, pinDirectionsError, handlePinDirections };
}
