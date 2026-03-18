/**
 * useAisStreamLayer — Sole owner of the 'ais-targets' map source.
 *
 * Fetches server-side AIS targets from Supabase and merges them
 * with local NMEA AIS data. Local targets always take priority.
 *
 * Includes:
 *   - CPA/TCPA collision avoidance calculations
 *   - Ship type decoding (cargo, tanker, fishing, etc.)
 *   - Premium vessel detail popup with collision warnings
 */
import { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { AisStreamService } from '../../services/AisStreamService';
import { AisStore } from '../../services/AisStore';
import { supabase } from '../../services/supabase';
import { onLocalAisChange } from './useAisLayer';
import { LocationStore } from '../../stores/LocationStore';
import { NmeaStore } from '../../services/NmeaStore';
import { computeCpa } from '../../utils/cpaCalculation';

const FETCH_DEBOUNCE_MS = 1500;
const AIS_SOURCE_ID = 'ais-targets';
const PREDICTED_TRACKS_SOURCE_ID = 'ais-predicted-tracks';
const TRACK_INTERVALS_MIN = [5, 10, 15]; // Projected positions at 5, 10, 15 minutes

/**
 * Project a position forward by given minutes at given COG/SOG.
 * Returns [lon, lat].
 */
function projectPosition(
    lat: number, lon: number, cogDeg: number, sogKn: number, minutes: number,
): [number, number] {
    const hours = minutes / 60;
    const distNm = sogKn * hours;
    const distDeg = distNm / 60; // 1° latitude ≈ 60 NM
    const cogRad = (cogDeg * Math.PI) / 180;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const newLat = lat + distDeg * Math.cos(cogRad);
    const newLon = lon + (distDeg * Math.sin(cogRad)) / cosLat;
    return [newLon, newLat];
}

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
 */
function navStatusColor(status: number): string {
    switch (status) {
        case 0: return '#22c55e';
        case 1: return '#f59e0b';
        case 2: return '#ef4444';
        case 3: return '#f97316';
        case 4: return '#f97316';
        case 5: return '#94a3b8';
        case 6: return '#ef4444';
        case 7: return '#06b6d4';
        case 8: return '#22c55e';
        case 15: return '#38bdf8';
        default: return '#38bdf8';
    }
}

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

// ── Ship type decoder (ITU-R M.1371-5, Table 53) ──────────────

function decodeShipType(code: number): { icon: string; label: string } {
    if (code >= 20 && code <= 29) return { icon: '🚤', label: 'Wing in Ground' };
    if (code === 30) return { icon: '🎣', label: 'Fishing Vessel' };
    if (code === 31) return { icon: '🚢', label: 'Towing' };
    if (code === 32) return { icon: '🚢', label: 'Towing (Large)' };
    if (code === 33) return { icon: '⛏️', label: 'Dredger' };
    if (code === 34) return { icon: '🤿', label: 'Diving Operations' };
    if (code === 35) return { icon: '⚓', label: 'Military' };
    if (code === 36) return { icon: '⛵', label: 'Sailing Vessel' };
    if (code === 37) return { icon: '🚤', label: 'Pleasure Craft' };
    if (code >= 40 && code <= 49) return { icon: '🚀', label: 'High Speed Craft' };
    if (code === 50) return { icon: '🧭', label: 'Pilot Vessel' };
    if (code === 51) return { icon: '🔍', label: 'SAR Vessel' };
    if (code === 52) return { icon: '🚢', label: 'Tug' };
    if (code === 53) return { icon: '🚢', label: 'Port Tender' };
    if (code === 54) return { icon: '🏭', label: 'Anti-Pollution' };
    if (code === 55) return { icon: '🚔', label: 'Law Enforcement' };
    if (code === 58) return { icon: '🏥', label: 'Medical Transport' };
    if (code === 59) return { icon: '🚢', label: 'Non-combatant Ship' };
    if (code >= 60 && code <= 69) {
        const label = code === 69 ? 'Cruise Ship' : 'Passenger Ship';
        return { icon: '🛳️', label };
    }
    if (code >= 70 && code <= 79) {
        const labels: Record<number, string> = {
            70: 'Cargo Ship', 71: 'Cargo — Hazmat (A)', 72: 'Cargo — Hazmat (B)',
            73: 'Cargo — Hazmat (C)', 74: 'Cargo — Hazmat (D)',
            75: 'Car Carrier', 76: 'Bulk Carrier', 77: 'Container Ship',
            78: 'RoRo Cargo', 79: 'Cargo (Other)',
        };
        return { icon: '🚢', label: labels[code] || 'Cargo Ship' };
    }
    if (code >= 80 && code <= 89) {
        const labels: Record<number, string> = {
            80: 'Tanker', 81: 'Tanker — Hazmat (A)', 82: 'Tanker — Hazmat (B)',
            83: 'Tanker — Hazmat (C)', 84: 'Tanker — Hazmat (D)',
            85: 'LNG / LPG Carrier', 86: 'Chemical Tanker',
            87: 'Oil Tanker', 88: 'Gas Carrier', 89: 'Tanker (Other)',
        };
        return { icon: '🚢', label: labels[code] || 'Tanker' };
    }
    if (code >= 90 && code <= 99) return { icon: '🚢', label: 'Other Vessel' };
    return { icon: '🚢', label: 'Unknown Type' };
}

export function useAisStreamLayer(
    map: mapboxgl.Map | null,
    enabled: boolean,
): void {
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isMounted = useRef(true);
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const cachedServerFeatures = useRef<GeoJSON.Feature[]>([]);

    const mergeAndWrite = useCallback(() => {
        if (!map || !enabled) return;

        const localGeoJson = AisStore.toGeoJSON();
        const localMmsis = new Set(
            localGeoJson.features.map((f) => f.properties?.mmsi),
        );

        const now = Date.now();

        const internetFeatures = cachedServerFeatures.current
            .filter((f) => !localMmsis.has(f.properties?.mmsi))
            .map((f) => {
                const updatedAt = f.properties?.updatedAt || f.properties?.updated_at;
                const ageMs = updatedAt ? now - new Date(updatedAt).getTime() : 0;
                const staleMinutes = Math.max(0, Math.floor(ageMs / 60000));
                return {
                    ...f,
                    properties: {
                        ...f.properties,
                        source: 'aisstream',
                        statusColor: navStatusColor(f.properties?.navStatus ?? f.properties?.nav_status ?? 15),
                        staleMinutes,
                    },
                };
            });

        const merged: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                ...localGeoJson.features.map((f) => ({
                    ...f,
                    properties: { ...f.properties, source: 'local', staleMinutes: 0 },
                })),
                ...internetFeatures,
            ],
        };

        const source = map.getSource(AIS_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
        if (source) {
            source.setData(merged);
        }

        // ── Generate predicted track lines for moving vessels ──
        const trackFeatures: GeoJSON.Feature[] = [];
        for (const feat of merged.features) {
            const p = feat.properties;
            if (!p) continue;
            const sog = Number(p.sog ?? 0);
            const cog = Number(p.cog ?? 0);
            const stale = Number(p.staleMinutes ?? 0);

            // Skip stationary, very stale, or no-position vessels
            if (sog < 0.5 || stale > 60) continue;
            const coords = (feat.geometry as GeoJSON.Point)?.coordinates;
            if (!coords || coords.length < 2) continue;

            const [lon, lat] = coords;
            const color = p.statusColor || '#38bdf8';

            // Build projected line: current pos → 5 → 10 → 15 min
            const lineCoords: [number, number][] = [[lon, lat]];
            for (const minutes of TRACK_INTERVALS_MIN) {
                const projected = projectPosition(lat, lon, cog, sog, minutes);
                lineCoords.push(projected);

                // Time-tick dot at each interval
                trackFeatures.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: projected },
                    properties: { statusColor: color, staleMinutes: stale, minutes },
                });
            }

            // The track line itself
            trackFeatures.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: lineCoords },
                properties: { statusColor: color, staleMinutes: stale },
            });
        }

        const trackSource = map.getSource(PREDICTED_TRACKS_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
        if (trackSource) {
            trackSource.setData({ type: 'FeatureCollection', features: trackFeatures });
        }
    }, [map, enabled]);

    const fetchAndMerge = useCallback(async () => {
        if (!map || !enabled || !supabase) {
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
            cachedServerFeatures.current = geojson.features || [];
        } catch (e) {
            console.warn('[useAisStreamLayer] Fetch failed:', e);
        }

        mergeAndWrite();
    }, [map, enabled, mergeAndWrite]);

    // Listen for local AIS data changes → re-merge
    useEffect(() => {
        if (!map || !enabled) return;
        const unsub = onLocalAisChange(() => mergeAndWrite());
        return unsub;
    }, [map, enabled, mergeAndWrite]);

    // Debounced fetch on map idle
    useEffect(() => {
        if (!map || !enabled) return;

        const onIdle = () => {
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
            debounceTimer.current = setTimeout(fetchAndMerge, FETCH_DEBOUNCE_MS);
        };

        map.on('idle', onIdle);
        fetchAndMerge();

        return () => {
            isMounted.current = false;
            map.off('idle', onIdle);
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    }, [map, enabled, fetchAndMerge]);

    // ── Premium vessel popup on tap ──
    useEffect(() => {
        if (!map || !enabled) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handleClick = (e: any) => {
            if (!e.features || e.features.length === 0) return;

            const f = e.features[0];
            const p = f.properties;
            if (!p) return;

            const coords = (f.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            const [targetLon, targetLat] = coords;

            if (popupRef.current) popupRef.current.remove();

            // ── Identity ──
            const name = p.name || `MMSI ${p.mmsi}`;
            const statusColor = p.statusColor || '#38bdf8';
            const status = navStatusLabel(p.navStatus ?? 15);
            const sogVal = p.sog != null ? Number(p.sog) : 0;
            const cogVal = p.cog != null ? Number(p.cog) : 0;
            const sog = sogVal > 0 ? `${sogVal.toFixed(1)} kn` : 'Stationary';
            const cogStr = p.cog != null ? `${cogVal.toFixed(0)}°` : '—';
            const hdg = p.heading != null && p.heading !== 511 ? `${p.heading}°` : '—';
            const callSign = p.callSign || '—';
            const destination = p.destination || '—';
            const source = p.source === 'local' ? '📡 Local NMEA' : '🌐 AISStream';

            // ── Ship type ──
            const { icon: shipIcon, label: shipLabel } = decodeShipType(p.shipType ?? 0);

            // ── Last seen ──
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

            // ── CPA / TCPA ──
            const own = LocationStore.getState();
            const nmea = NmeaStore.getState();
            const ownSog = nmea.sog.value ?? 0;
            const ownCog = nmea.cog.value ?? 0;
            const cpaResult = computeCpa(
                own.lat, own.lon, ownCog, ownSog,
                targetLat, targetLon, cogVal, sogVal,
            );

            let cpaSection = '';
            if (cpaResult) {
                const { cpa, tcpa, distance, bearing, risk } = cpaResult;
                const rc: Record<string, string> = {
                    DANGER: '#ef4444', CAUTION: '#f59e0b', SAFE: '#22c55e', NONE: '#64748b',
                };
                const rl: Record<string, string> = {
                    DANGER: '⚠️ DANGER — Risk of Collision',
                    CAUTION: '⚡ CAUTION — Close Approach',
                    SAFE: '✅ Safe Passage',
                    NONE: '↔ Diverging',
                };
                const riskColor = rc[risk] || '#64748b';

                const banner = (risk === 'DANGER' || risk === 'CAUTION')
                    ? `<div style="background:${riskColor}18;border:1px solid ${riskColor}40;border-radius:8px;padding:6px 10px;margin-bottom:10px;text-align:center;font-size:11px;font-weight:700;color:${riskColor};letter-spacing:0.3px;">${rl[risk]}</div>`
                    : '';

                const tcpaStr = tcpa < 0 ? 'Diverging' : tcpa < 60 ? `${tcpa.toFixed(0)} min` : `${(tcpa / 60).toFixed(1)} hrs`;

                cpaSection = `
                    ${banner}
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;padding:8px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Distance</div>
                            <div style="font-size:14px;font-weight:700;color:#e2e8f0;">${distance.toFixed(1)} NM</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Bearing</div>
                            <div style="font-size:14px;font-weight:700;color:#e2e8f0;">${bearing.toFixed(0)}°</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">CPA</div>
                            <div style="font-size:14px;font-weight:700;color:${riskColor};">${cpa.toFixed(2)} NM</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">TCPA</div>
                            <div style="font-size:14px;font-weight:700;color:${riskColor};">${tcpaStr}</div>
                        </div>
                    </div>
                `;
            }

            const html = `
                <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:rgba(15,23,42,0.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:14px 16px;color:#e2e8f0;min-width:240px;max-width:300px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <span style="font-size:20px;">${shipIcon}</span>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:800;font-size:14px;letter-spacing:0.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</div>
                            <div style="font-size:10px;color:#94a3b8;">${shipLabel}</div>
                        </div>
                        <div style="width:10px;height:10px;border-radius:50%;background:${statusColor};box-shadow:0 0 8px ${statusColor};flex-shrink:0;"></div>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;padding:4px 0;">
                        <span style="color:${statusColor};font-weight:700;font-size:11px;">${status}</span>
                        <span style="color:#475569;">•</span>
                        <span style="font-size:11px;color:#94a3b8;">${sog}</span>
                        <span style="color:#475569;">•</span>
                        <span style="font-size:10px;color:${lastSeen === 'Live' ? '#22c55e' : '#64748b'};">${lastSeen}</span>
                    </div>
                    ${cpaSection}
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:11px;">
                        <span style="color:#64748b;">MMSI</span>
                        <span style="font-family:monospace;font-size:10px;">${p.mmsi}</span>
                        <span style="color:#64748b;">Call Sign</span>
                        <span>${callSign}</span>
                        <span style="color:#64748b;">COG / Hdg</span>
                        <span>${cogStr} / ${hdg}</span>
                        <span style="color:#64748b;">Destination</span>
                        <span style="font-weight:600;color:#e2e8f0;">${destination}</span>
                        <span style="color:#64748b;">Source</span>
                        <span style="font-size:10px;">${source}</span>
                    </div>
                </div>
            `;

            popupRef.current = new mapboxgl.Popup({
                closeButton: true,
                closeOnClick: true,
                maxWidth: '320px',
                className: 'ais-vessel-popup',
                offset: 14,
            })
                .setLngLat(coords)
                .setHTML(html)
                .addTo(map);
        };

        const handleMouseEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
        const handleMouseLeave = () => { map.getCanvas().style.cursor = ''; };

        map.on('click', 'ais-targets-circle', handleClick);
        map.on('mouseenter', 'ais-targets-circle', handleMouseEnter);
        map.on('mouseleave', 'ais-targets-circle', handleMouseLeave);

        return () => {
            map.off('click', 'ais-targets-circle', handleClick);
            map.off('mouseenter', 'ais-targets-circle', handleMouseEnter);
            map.off('mouseleave', 'ais-targets-circle', handleMouseLeave);
            if (popupRef.current) { popupRef.current.remove(); popupRef.current = null; }
        };
    }, [map, enabled]);

    useEffect(() => {
        isMounted.current = true;
        return () => { isMounted.current = false; };
    }, []);
}
