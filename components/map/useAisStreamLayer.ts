/**
 * useAisStreamLayer — Fetches server-side AIS targets from Supabase
 * and merges them with local NMEA AIS data on the map.
 *
 * Local NMEA targets always take priority (by MMSI).
 * Internet targets fill coverage beyond VHF range.
 *
 * Triggers on map `idle` event (debounced) to refresh when the user
 * pans or zooms the map.
 */
import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { AisStreamService } from '../../services/AisStreamService';
import { AisStore } from '../../services/AisStore';
import { supabase } from '../../services/supabase';

const FETCH_DEBOUNCE_MS = 1500;
const AIS_SOURCE_ID = 'ais-targets';

// Convert map zoom to a sensible radius in nautical miles
function zoomToRadiusNm(zoom: number): number {
    if (zoom >= 14) return 5;
    if (zoom >= 12) return 10;
    if (zoom >= 10) return 25;
    if (zoom >= 8) return 50;
    if (zoom >= 6) return 100;
    return 200;
}

export function useAisStreamLayer(
    map: mapboxgl.Map | null,
    enabled: boolean,
): void {
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isMounted = useRef(true);

    const fetchAndMerge = useCallback(async () => {
        if (!map || !enabled || !supabase) return;

        const center = map.getCenter();
        const zoom = map.getZoom();
        const radiusNm = zoomToRadiusNm(zoom);

        try {
            const geojson = await AisStreamService.fetchNearby({
                lat: center.lat,
                lon: center.lng,
                radiusNm,
            });

            if (!isMounted.current || !map) return;

            // Get local AIS targets to skip (local takes priority)
            const localGeoJson = AisStore.toGeoJSON();
            const localMmsis = new Set(
                localGeoJson.features.map((f) => f.properties?.mmsi),
            );

            // Filter out internet targets that are already tracked locally
            const internetOnly = {
                type: 'FeatureCollection' as const,
                features: geojson.features.filter(
                    (f: GeoJSON.Feature) => !localMmsis.has(f.properties?.mmsi),
                ),
            };

            // Merge: local targets + internet-only targets
            const merged: GeoJSON.FeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    // Local targets (higher opacity, fresher data)
                    ...localGeoJson.features.map((f) => ({
                        ...f,
                        properties: { ...f.properties, source: 'local' },
                    })),
                    // Internet targets (slightly lower opacity)
                    ...internetOnly.features.map((f: GeoJSON.Feature) => ({
                        ...f,
                        properties: { ...f.properties, source: 'aisstream' },
                    })),
                ],
            };

            // Update the map source
            const source = map.getSource(AIS_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
            if (source) {
                source.setData(merged);
            }
        } catch (e) {
            console.warn('[useAisStreamLayer] Fetch failed:', e);
        }
    }, [map, enabled]);

    // Debounced fetch on map idle
    useEffect(() => {
        if (!map || !enabled || !supabase) return;

        const onIdle = () => {
            if (debounceTimer.current) {
                clearTimeout(debounceTimer.current);
            }
            debounceTimer.current = setTimeout(fetchAndMerge, FETCH_DEBOUNCE_MS);
        };

        map.on('idle', onIdle);

        // Initial fetch
        fetchAndMerge();

        return () => {
            isMounted.current = false;
            map.off('idle', onIdle);
            if (debounceTimer.current) {
                clearTimeout(debounceTimer.current);
            }
        };
    }, [map, enabled, fetchAndMerge]);

    // Reset mounted flag on mount
    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);
}
