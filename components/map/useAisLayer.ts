/**
 * useAisLayer — React hook that manages local AIS data and layer visibility.
 *
 * Subscribes to AisStore for local NMEA AIS updates and triggers a callback
 * when local data changes. Does NOT write to the map source directly —
 * that's handled by useAisStreamLayer which is the sole owner of the
 * 'ais-targets' GeoJSON source, merging local + internet data.
 *
 * Still handles layer visibility toggling.
 */
import { useEffect, useRef, _useCallback, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { AisStore } from '../../services/AisStore';

const UPDATE_THROTTLE_MS = 2000;

/** Listeners that want to know when local AIS data changes */
type LocalAisChangeCallback = () => void;
const localAisChangeListeners = new Set<LocalAisChangeCallback>();

/** Subscribe to local AIS data changes (used by useAisStreamLayer to re-merge) */
export function onLocalAisChange(cb: LocalAisChangeCallback): () => void {
    localAisChangeListeners.add(cb);
    return () => localAisChangeListeners.delete(cb);
}

export function useAisLayer(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean, visible: boolean): void {
    const lastUpdateRef = useRef(0);
    const pendingUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Subscribe to AisStore and notify listeners when local data changes ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Ensure source exists
        if (!map.getSource('ais-targets')) return;

        const notifyLocalChange = () => {
            for (const cb of localAisChangeListeners) cb();
        };

        const throttledUpdate = () => {
            const now = Date.now();
            const elapsed = now - lastUpdateRef.current;

            if (elapsed >= UPDATE_THROTTLE_MS) {
                lastUpdateRef.current = now;
                notifyLocalChange();
            } else if (!pendingUpdateRef.current) {
                pendingUpdateRef.current = setTimeout(() => {
                    pendingUpdateRef.current = null;
                    lastUpdateRef.current = Date.now();
                    notifyLocalChange();
                }, UPDATE_THROTTLE_MS - elapsed);
            }
        };

        const unsub = AisStore.subscribe(throttledUpdate);

        // Initial notification
        notifyLocalChange();

        return () => {
            unsub();
            if (pendingUpdateRef.current) {
                clearTimeout(pendingUpdateRef.current);
                pendingUpdateRef.current = null;
            }
        };
    }, [mapRef, mapReady]);

    // ── Toggle layer visibility ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const visibility = visible ? 'visible' : 'none';
        const layerIds = ['ais-targets-glow', 'ais-targets-circle', 'ais-targets-heading', 'ais-targets-label'];

        for (const id of layerIds) {
            if (map.getLayer(id)) {
                map.setLayoutProperty(id, 'visibility', visibility);
            }
        }
    }, [mapRef, mapReady, visible]);
}
