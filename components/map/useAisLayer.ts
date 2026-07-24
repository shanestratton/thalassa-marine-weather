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
import { useEffect, useRef, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { AisStore } from '../../services/AisStore';

const UPDATE_THROTTLE_MS = 2000;
const AIS_LAYER_IDS = [
    'ais-targets-glow',
    'ais-targets-circle',
    'ais-targets-heading',
    'ais-targets-label',
    'ais-predicted-tracks-line',
    'ais-predicted-tracks-dots',
    'ais-guard-zone-fill',
    'ais-guard-zone-stroke',
] as const;
const AIS_SOURCE_IDS = ['ais-targets', 'ais-predicted-tracks', 'ais-guard-zone'] as const;
const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [],
};

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

        for (const id of AIS_LAYER_IDS) {
            if (map.getLayer(id)) {
                map.setLayoutProperty(id, 'visibility', visibility);
            }
        }

        if (!visible) {
            // Visibility alone is not enough: projected tracks and the guard
            // circle retain their last GeoJSON after the stream is paused, so
            // a style re-assert or re-enable can flash stale tactical data.
            // Clear only rendered Mapbox state; the caller-owned AIS preference
            // remains untouched and can restore normally on the Chart surface.
            for (const id of AIS_SOURCE_IDS) {
                const source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
                source?.setData(EMPTY_FEATURE_COLLECTION);
            }
        }
    }, [mapRef, mapReady, visible]);
}
