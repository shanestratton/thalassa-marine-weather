/**
 * useAisStreamLayer — Sole owner of the 'ais-targets' map source.
 *
 * Fetches server-side AIS targets from Supabase and merges them
 * with local NMEA AIS data. Local targets always take priority.
 *
 * Triggers re-merge on:
 *   - Map idle (debounced, refetches from server)
 *   - Local AIS data change (immediate re-merge with cached server data)
 */
import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { AisStreamService } from '../../services/AisStreamService';
import { AisStore } from '../../services/AisStore';
import { supabase } from '../../services/supabase';
import { onLocalAisChange } from './useAisLayer';

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

/**
 * Map AIS navigational status code to a display colour.
 * Matches the same palette used in AisStore for local targets.
 */
function navStatusColor(status: number): string {
    switch (status) {
        case 0: return '#22c55e'; // Under way (engine) — green
        case 1: return '#f59e0b'; // At anchor — amber
        case 2: return '#ef4444'; // Not under command — red
        case 3: return '#f97316'; // Restricted manoeuvrability — orange
        case 4: return '#f97316'; // Constrained by draught — orange
        case 5: return '#94a3b8'; // Moored — grey
        case 6: return '#ef4444'; // Aground — red
        case 7: return '#06b6d4'; // Fishing — cyan
        case 8: return '#22c55e'; // Under way (sail) — green
        case 15: return '#38bdf8'; // Not defined / Class B — sky blue
        default: return '#38bdf8'; // Unknown — sky blue
    }
}

/** Human-readable nav status label */
function navStatusLabel(status: number): string {
    switch (status) {
        case 0: return 'Under Way (Engine)';
        case 1: return 'At Anchor';
        case 2: return 'Not Under Command';
        case 3: return 'Restricted Manoeuvrability';
        case 4: return 'Constrained by Draught';
        case 5: return 'Moored';
        case 6: return 'Aground';
        case 7: return 'Fishing';
        case 8: return 'Under Way (Sail)';
        case 14: return 'AIS-SART Active';
        case 15: return 'Not Defined';
        default: return 'Unknown';
    }
}

export function useAisStreamLayer(
    map: mapboxgl.Map | null,
    enabled: boolean,
): void {
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isMounted = useRef(true);
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    // Cache the last server fetch so local-change re-merges don't need a new fetch
    const cachedServerFeatures = useRef<GeoJSON.Feature[]>([]);

    /**
     * Merge local AIS + cached internet AIS and write to map source.
     * Local targets always take priority by MMSI.
     */
    const mergeAndWrite = useCallback(() => {
        if (!map || !enabled) return;

        // Get local AIS targets
        const localGeoJson = AisStore.toGeoJSON();
        const localMmsis = new Set(
            localGeoJson.features.map((f) => f.properties?.mmsi),
        );

        // Filter internet targets: remove any MMSI already tracked locally
        const internetFeatures = cachedServerFeatures.current
            .filter((f) => !localMmsis.has(f.properties?.mmsi))
            .map((f) => ({
                ...f,
                properties: {
                    ...f.properties,
                    source: 'aisstream',
                    statusColor: navStatusColor(f.properties?.navStatus ?? f.properties?.nav_status ?? 15),
                },
            }));

        // Merge: local targets (tagged 'local') + internet-only targets
        const merged: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                // Local targets (full opacity, fresher data)
                ...localGeoJson.features.map((f) => ({
                    ...f,
                    properties: { ...f.properties, source: 'local' },
                })),
                // Internet targets (slightly transparent)
                ...internetFeatures,
            ],
        };

        // Write to map source — this is the ONLY place that writes to 'ais-targets'
        const source = map.getSource(AIS_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
        if (source) {
            source.setData(merged);
        }
    }, [map, enabled]);

    /**
     * Fetch from server, cache the response, then merge with local data.
     */
    const fetchAndMerge = useCallback(async () => {
        if (!map || !enabled || !supabase) {
            // No Supabase? Just render local data
            mergeAndWrite();
            return;
        }

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

            // Cache server features for re-merge on local data changes
            cachedServerFeatures.current = geojson.features || [];
        } catch (e) {
            console.warn('[useAisStreamLayer] Fetch failed:', e);
        }

        // Merge with latest local data
        mergeAndWrite();
    }, [map, enabled, mergeAndWrite]);

    // ── Listen for local AIS data changes → re-merge immediately ──
    useEffect(() => {
        if (!map || !enabled) return;

        const unsub = onLocalAisChange(() => {
            mergeAndWrite();
        });

        return unsub;
    }, [map, enabled, mergeAndWrite]);

    // ── Debounced fetch on map idle ──
    useEffect(() => {
        if (!map || !enabled) return;

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

    // ── Vessel detail popup on tap/click ──
    useEffect(() => {
        if (!map || !enabled) return;

        const handleClick = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
            if (!e.features || e.features.length === 0) return;

            const f = e.features[0];
            const p = f.properties;
            if (!p) return;

            const coords = (f.geometry as GeoJSON.Point).coordinates.slice() as [number, number];

            // Close existing popup
            if (popupRef.current) {
                popupRef.current.remove();
            }

            const name = p.name || `MMSI ${p.mmsi}`;
            const statusColor = p.statusColor || '#38bdf8';
            const status = navStatusLabel(p.navStatus ?? 15);
            const sog = p.sog != null ? `${Number(p.sog).toFixed(1)} kn` : '—';
            const cog = p.cog != null ? `${Number(p.cog).toFixed(0)}°` : '—';
            const heading = p.heading != null && p.heading !== 511 ? `${p.heading}°` : '—';
            const callSign = p.callSign || '—';
            const destination = p.destination || '—';
            const source = p.source === 'local' ? '📡 Local NMEA' : '🌐 AISStream';

            // Format "last seen" relative time
            let lastSeen = '—';
            const ts = p.updatedAt || p.lastUpdated;
            if (ts) {
                const ago = Date.now() - new Date(typeof ts === 'number' ? ts : ts).getTime();
                const mins = Math.floor(ago / 60000);
                if (mins < 1) lastSeen = 'Just now';
                else if (mins < 60) lastSeen = `${mins}m ago`;
                else {
                    const hrs = Math.floor(mins / 60);
                    const rem = mins % 60;
                    lastSeen = rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
                }
            }
            if (p.source === 'local') lastSeen = 'Live';

            const html = `
                <div style="
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    background: rgba(15, 23, 42, 0.95);
                    backdrop-filter: blur(12px);
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 12px;
                    padding: 14px 16px;
                    color: #e2e8f0;
                    min-width: 220px;
                    max-width: 280px;
                ">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                        <div style="
                            width:10px; height:10px; border-radius:50%;
                            background:${statusColor};
                            box-shadow: 0 0 6px ${statusColor};
                            flex-shrink:0;
                        "></div>
                        <div style="font-weight:800; font-size:13px; letter-spacing:0.3px;">
                            ${name}
                        </div>
                    </div>
                    <div style="
                        display:grid; grid-template-columns: auto 1fr;
                        gap: 4px 12px; font-size:11px;
                    ">
                        <span style="color:#94a3b8;">Status</span>
                        <span style="color:${statusColor}; font-weight:600;">${status}</span>

                        <span style="color:#94a3b8;">MMSI</span>
                        <span>${p.mmsi}</span>

                        <span style="color:#94a3b8;">Call Sign</span>
                        <span>${callSign}</span>

                        <span style="color:#94a3b8;">SOG</span>
                        <span>${sog}</span>

                        <span style="color:#94a3b8;">COG</span>
                        <span>${cog}</span>

                        <span style="color:#94a3b8;">Heading</span>
                        <span>${heading}</span>

                        <span style="color:#94a3b8;">Destination</span>
                        <span style="font-weight:600;">${destination}</span>

                        <span style="color:#94a3b8;">Last Seen</span>
                        <span style="color:${lastSeen === 'Live' ? '#22c55e' : '#94a3b8'};">${lastSeen}</span>

                        <span style="color:#94a3b8;">Source</span>
                        <span style="font-size:10px;">${source}</span>
                    </div>
                </div>
            `;

            popupRef.current = new mapboxgl.Popup({
                closeButton: true,
                closeOnClick: true,
                maxWidth: '300px',
                className: 'ais-vessel-popup',
                offset: 12,
            })
                .setLngLat(coords)
                .setHTML(html)
                .addTo(map);
        };

        // Cursor change on hover
        const handleMouseEnter = () => {
            map.getCanvas().style.cursor = 'pointer';
        };
        const handleMouseLeave = () => {
            map.getCanvas().style.cursor = '';
        };

        map.on('click', 'ais-targets-circle', handleClick);
        map.on('mouseenter', 'ais-targets-circle', handleMouseEnter);
        map.on('mouseleave', 'ais-targets-circle', handleMouseLeave);

        return () => {
            map.off('click', 'ais-targets-circle', handleClick);
            map.off('mouseenter', 'ais-targets-circle', handleMouseEnter);
            map.off('mouseleave', 'ais-targets-circle', handleMouseLeave);
            if (popupRef.current) {
                popupRef.current.remove();
                popupRef.current = null;
            }
        };
    }, [map, enabled]);

    // Reset mounted flag on mount
    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);
}
