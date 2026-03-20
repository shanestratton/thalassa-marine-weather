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
import { AisGuardZone } from '../../services/AisGuardZone';
import { triggerHaptic } from '../../utils/system';
import { VesselMetadataService } from '../../services/VesselMetadataService';
import { getMmsiFlag } from '../../utils/MmsiDecoder';
import { isFeatureLockedSync } from '../../managers/FeatureGate';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('useAisStreamLayer');

const FETCH_DEBOUNCE_MS = 1500;
const AIS_SOURCE_ID = 'ais-targets';
const PREDICTED_TRACKS_SOURCE_ID = 'ais-predicted-tracks';
const TRACK_INTERVALS_MIN = [5, 10, 15]; // Projected positions at 5, 10, 15 minutes

/**
 * Project a position forward by given minutes at given COG/SOG.
 * Returns [lon, lat].
 */
function projectPosition(lat: number, lon: number, cogDeg: number, sogKn: number, minutes: number): [number, number] {
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
        case 0:
            return '#22c55e';
        case 1:
            return '#f59e0b';
        case 2:
            return '#ef4444';
        case 3:
            return '#f97316';
        case 4:
            return '#f97316';
        case 5:
            return '#94a3b8';
        case 6:
            return '#ef4444';
        case 7:
            return '#06b6d4';
        case 8:
            return '#22c55e';
        case 15:
            return '#38bdf8';
        default:
            return '#38bdf8';
    }
}

function navStatusLabel(status: number): string {
    switch (status) {
        case 0:
            return 'Under Way (Engine)';
        case 1:
            return 'At Anchor';
        case 2:
            return 'Not Under Command';
        case 3:
            return 'Restricted Manoeuvrability';
        case 4:
            return 'Constrained by Draught';
        case 5:
            return 'Moored';
        case 6:
            return 'Aground';
        case 7:
            return 'Fishing';
        case 8:
            return 'Under Way (Sail)';
        case 14:
            return 'AIS-SART Active';
        case 15:
            return 'Not Defined';
        default:
            return 'Unknown';
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
            70: 'Cargo Ship',
            71: 'Cargo — Hazmat (A)',
            72: 'Cargo — Hazmat (B)',
            73: 'Cargo — Hazmat (C)',
            74: 'Cargo — Hazmat (D)',
            75: 'Car Carrier',
            76: 'Bulk Carrier',
            77: 'Container Ship',
            78: 'RoRo Cargo',
            79: 'Cargo (Other)',
        };
        return { icon: '🚢', label: labels[code] || 'Cargo Ship' };
    }
    if (code >= 80 && code <= 89) {
        const labels: Record<number, string> = {
            80: 'Tanker',
            81: 'Tanker — Hazmat (A)',
            82: 'Tanker — Hazmat (B)',
            83: 'Tanker — Hazmat (C)',
            84: 'Tanker — Hazmat (D)',
            85: 'LNG / LPG Carrier',
            86: 'Chemical Tanker',
            87: 'Oil Tanker',
            88: 'Gas Carrier',
            89: 'Tanker (Other)',
        };
        return { icon: '🚢', label: labels[code] || 'Tanker' };
    }
    if (code >= 90 && code <= 99) return { icon: '🚢', label: 'Other Vessel' };
    return { icon: '🚢', label: 'Unknown Type' };
}

export function useAisStreamLayer(map: mapboxgl.Map | null, enabled: boolean): void {
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isMounted = useRef(true);
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    const cachedServerFeatures = useRef<GeoJSON.Feature[]>([]);

    const mergeAndWrite = useCallback(() => {
        if (!map || !enabled) return;

        const localGeoJson = AisStore.toGeoJSON();
        const localMmsis = new Set(localGeoJson.features.map((f) => f.properties?.mmsi));

        const now = Date.now();

        const internetFeatures = cachedServerFeatures.current
            .filter((f) => !localMmsis.has(f.properties?.mmsi))
            .map((f) => {
                const p = f.properties || {};
                const updatedAt = p.updatedAt || p.updated_at;
                const ageMs = updatedAt ? now - new Date(updatedAt).getTime() : 0;
                const staleMinutes = Math.max(0, Math.floor(ageMs / 60000));

                // Normalize snake_case (Supabase) → camelCase (popup expects)
                const navStatus = p.navStatus ?? p.nav_status ?? 15;
                const shipType = p.shipType ?? p.ship_type ?? 0;

                return {
                    ...f,
                    properties: {
                        ...p,
                        source: 'aisstream',
                        statusColor: navStatusColor(navStatus),
                        staleMinutes,
                        // Ensure camelCase versions are always present
                        navStatus,
                        shipType,
                        callSign: p.callSign || p.call_sign || '',
                        updatedAt: updatedAt || '',
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

        // ── Guard Zone check ──
        const own = LocationStore.getState();
        const newAlerts = AisGuardZone.checkFeatures(own.lat, own.lon, merged.features);
        if (newAlerts.length > 0) {
            triggerHaptic('heavy');
            // Dispatch custom event for UI to show alert toast
            window.dispatchEvent(new CustomEvent('ais-guard-alert', { detail: newAlerts }));
        }

        // ── Guard Zone radius circle on map ──
        const guardSource = map.getSource('ais-guard-zone') as mapboxgl.GeoJSONSource | undefined;
        if (guardSource) {
            const gz = AisGuardZone.getState();
            if (gz.enabled && own.lat !== 0 && own.lon !== 0) {
                // Generate circle polygon (64 points)
                const radiusDeg = gz.radiusNm / 60; // NM to degrees latitude
                const cosLat = Math.cos((own.lat * Math.PI) / 180);
                const pts: [number, number][] = [];
                for (let i = 0; i <= 64; i++) {
                    const angle = (i / 64) * 2 * Math.PI;
                    pts.push([own.lon + (radiusDeg * Math.cos(angle)) / cosLat, own.lat + radiusDeg * Math.sin(angle)]);
                }
                guardSource.setData({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [pts] },
                    properties: {},
                });
            } else {
                guardSource.setData({ type: 'FeatureCollection', features: [] });
            }
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
            log.warn('[useAisStreamLayer] Fetch failed:', e);
        }

        mergeAndWrite();

        // ── Pre-fetch vessel metadata for visible targets ──
        // So data is ready before users tap (eliminates MMSI-only popup delay)
        const mmsis = (cachedServerFeatures.current || [])
            .map((f) => f.properties?.mmsi)
            .filter((m): m is number => typeof m === 'number' && m > 0);
        if (mmsis.length > 0) {
            const unique = [...new Set(mmsis)].slice(0, 50);
            VesselMetadataService.batchLookup(unique).catch(() => {
                /* silent — best-effort pre-fetch */
            });
        }
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

            // ── Identity — "Bingo" interception ──
            const isPremium = !isFeatureLockedSync('vessel_intel');
            const flagEmoji = getMmsiFlag(p.mmsi);
            const intel = isPremium ? VesselMetadataService.getVesselIntel(p.mmsi) : null;

            // ── On-demand lookup: if premium user and no vessel name, fire Edge Function ──
            const needsOnDemandLookup = isPremium && !intel?.name;
            const lookupSpinnerId = `lookup-spinner-${p.mmsi}-${Date.now()}`;
            if (needsOnDemandLookup) {
                VesselMetadataService.onDemandLookup(p.mmsi).then((result) => {
                    const spinnerEl = document.getElementById(lookupSpinnerId);
                    if (result && result.vessel_name && popupRef.current) {
                        // Update spinner to show success
                        if (spinnerEl) {
                            spinnerEl.innerHTML = `
                                <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.15);border-radius:8px;font-size:10px;color:#22c55e;">
                                    <span>\u2713 Found: ${result.flag_emoji || ''} ${result.vessel_name}</span>
                                </div>
                            `;
                        }
                        // Update the name/flag in the existing popup header (in-place, no flash)
                        const popup = popupRef.current;
                        if (popup) {
                            const el = popup.getElement();
                            if (el) {
                                const nameEl = el.querySelector('[data-vessel-name]') as HTMLElement;
                                if (nameEl) nameEl.textContent = result.vessel_name || '';
                                const flagEl = el.querySelector('[data-vessel-flag]') as HTMLElement;
                                if (flagEl)
                                    flagEl.textContent = `${result.flag_emoji || ''} ${result.flag_country || ''}`;
                            }
                        }
                    } else {
                        // Not found — update spinner to show result
                        if (spinnerEl) {
                            spinnerEl.innerHTML = `
                                <div style="padding:6px 10px;background:rgba(100,116,139,0.08);border:1px solid rgba(100,116,139,0.15);border-radius:8px;font-size:10px;color:#64748b;">
                                    No registry data found
                                </div>
                            `;
                        }
                    }
                });
            }

            // Enriched name: DB name > AIS name > decoded country vessel > MMSI fallback
            const vesselName = intel?.name ?? p.name ?? null;
            const displayName = vesselName
                ? `${intel?.flag ?? flagEmoji} ${vesselName}`
                : `${flagEmoji} MMSI ${p.mmsi}`;

            const statusColor = p.statusColor || '#38bdf8';
            const status = navStatusLabel(p.navStatus ?? 15);
            const sogVal = p.sog != null ? Number(p.sog) : 0;
            const cogVal = p.cog != null ? Number(p.cog) : 0;
            const sog = sogVal > 0 ? `${sogVal.toFixed(1)} kn` : 'Stationary';
            const cogStr = p.cog != null ? `${cogVal.toFixed(0)}°` : '—';
            const hdg = p.heading != null && p.heading !== 511 ? `${p.heading}°` : '—';
            const destination = p.destination || '—';
            const source = p.source === 'local' ? '📡 Local NMEA' : '🌐 AISStream';

            // ── Ship type — always fill from best source ──
            const vesselType = intel?.metadata?.vessel_type ?? null;
            const { icon: shipIcon, label: shipLabel } = decodeShipType(p.shipType ?? 0);
            const typeLabel = vesselType || (shipLabel !== 'Unknown' ? shipLabel : 'Vessel');

            // ── Call sign — merge AIS + DB ──
            const callSign = intel?.metadata?.call_sign || p.callSign || '—';

            // ── Thumbnail ──
            const thumbnail = intel?.thumbnail ?? null;

            // ── Flag country (always available from decoder) ──
            const flagCountry = intel?.metadata?.flag_country || intel?.country || null;

            // ── Dimensions — always show what we have ──
            const loa = intel?.metadata?.loa ?? null;
            const beam = intel?.metadata?.beam ?? null;
            const draft = intel?.metadata?.draft ?? null;
            const hasDimensions = loa || beam || draft;

            let dimensionsHtml = '';
            if (hasDimensions) {
                const dims: string[] = [];
                if (loa) dims.push(`LOA: ${Number(loa).toFixed(1)}m`);
                if (beam) dims.push(`Beam: ${Number(beam).toFixed(1)}m`);
                if (draft) dims.push(`Draft: ${Number(draft).toFixed(1)}m`);
                dimensionsHtml = `
                    <div style="display:flex;gap:8px;margin-bottom:10px;padding:6px 8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.15);border-radius:8px;font-size:10px;color:#94a3b8;">
                        ${dims.map((d) => `<span>${d}</span>`).join('<span style="color:#334155;">•</span>')}
                    </div>
                `;
            }

            // ── IMO + Data Source (premium) ──
            const imoNumber = intel?.metadata?.imo_number ?? null;
            const dataSource = intel?.metadata?.data_source ?? null;
            const isVerified = intel?.metadata?.is_verified ?? false;

            // ── Upgrade banner (free users without vessel name) ──
            const upgradeBanner = !isPremium
                ? `<div style="background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.15);border-radius:8px;padding:6px 10px;margin-bottom:10px;text-align:center;font-size:10px;color:#38bdf8;cursor:pointer;" onclick="window.dispatchEvent(new CustomEvent('trigger-paywall'))">
                    🔒 Upgrade for vessel photo, dimensions &amp; registry data
                   </div>`
                : '';

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
                own.lat,
                own.lon,
                ownCog,
                ownSog,
                targetLat,
                targetLon,
                cogVal,
                sogVal,
                p.navStatus ?? p.nav_status ?? 15,
            );

            let cpaSection = '';
            if (cpaResult) {
                const { cpa, tcpa, distance, bearing, risk } = cpaResult;
                const rc: Record<string, string> = {
                    DANGER: '#ef4444',
                    CAUTION: '#f59e0b',
                    SAFE: '#22c55e',
                    NONE: '#64748b',
                };
                const noneLabel = tcpa < 0 ? '↔ Diverging' : '🔇 No Risk';
                const rl: Record<string, string> = {
                    DANGER: '⚠️ DANGER — Risk of Collision',
                    CAUTION: '⚡ CAUTION — Close Approach',
                    SAFE: '✅ Safe Passage',
                    NONE: noneLabel,
                };
                const riskColor = rc[risk] || '#64748b';

                const banner =
                    risk === 'DANGER' || risk === 'CAUTION'
                        ? `<div style="background:${riskColor}18;border:1px solid ${riskColor}40;border-radius:8px;padding:6px 10px;margin-bottom:10px;text-align:center;font-size:11px;font-weight:700;color:${riskColor};letter-spacing:0.3px;">${rl[risk]}</div>`
                        : '';

                const tcpaStr =
                    tcpa < 0 ? 'Diverging' : tcpa < 60 ? `${tcpa.toFixed(0)} min` : `${(tcpa / 60).toFixed(1)} hrs`;

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

            // ── "View Details" button (premium — opens full modal) ──
            const detailBtnId = `vessel-detail-${p.mmsi}-${Date.now()}`;
            const viewDetailsBtn =
                isPremium && intel?.metadata
                    ? `<button id="${detailBtnId}" style="width:100%;margin-top:8px;padding:8px 12px;background:linear-gradient(135deg,rgba(14,165,233,0.15),rgba(139,92,246,0.15));border:1px solid rgba(14,165,233,0.25);border-radius:10px;color:#38bdf8;font-size:11px;font-weight:700;letter-spacing:0.5px;cursor:pointer;text-transform:uppercase;transition:all 0.2s;">
                    View Full Details ›
                   </button>`
                    : '';

            // ── Build full modal data for detail button ──
            const modalData =
                isPremium && intel?.metadata
                    ? JSON.stringify({
                          mmsi: p.mmsi,
                          name: vesselName || `MMSI ${p.mmsi}`,
                          flag: intel?.flag ?? flagEmoji,
                          flagCountry: flagCountry || 'Unknown',
                          type: typeLabel,
                          callSign,
                          imo: imoNumber,
                          loa,
                          beam,
                          draft,
                          thumbnail: thumbnail || null,
                          destination,
                          sog: sogVal,
                          cog: cogVal,
                          heading: p.heading,
                          status,
                          statusColor,
                          lastSeen,
                          source,
                          dataSource,
                          isVerified,
                          lat: targetLat.toFixed(5),
                          lon: targetLon.toFixed(5),
                      }).replace(/'/g, "\\'")
                    : '';

            const html = `
                <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:rgba(15,23,42,0.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:14px 16px;color:#e2e8f0;min-width:240px;max-width:300px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        ${
                            thumbnail
                                ? `<img src="${thumbnail}" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid rgba(255,255,255,0.1);flex-shrink:0;" />`
                                : `<div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,rgba(14,165,233,0.15),rgba(139,92,246,0.15));border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">${shipIcon}</div>`
                        }
                        <div style="flex:1;min-width:0;">
                            <div data-vessel-name style="font-weight:800;font-size:14px;letter-spacing:0.3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${displayName}</div>
                            <div style="font-size:10px;color:#94a3b8;display:flex;align-items:center;gap:4px;">
                                <span>${typeLabel}</span>
                                ${isVerified ? '<span style="color:#22c55e;font-size:9px;">✓ Verified</span>' : ''}
                                ${flagCountry ? `<span style="color:#475569;">•</span><span data-vessel-flag>${flagCountry}</span>` : ''}
                            </div>
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
                    ${upgradeBanner}
                    ${
                        needsOnDemandLookup
                            ? `
                        <div id="${lookupSpinnerId}" style="margin-bottom:10px;">
                            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.15);border-radius:8px;font-size:10px;color:#38bdf8;">
                                <span style="display:inline-block;width:12px;height:12px;border:2px solid rgba(56,189,248,0.3);border-top-color:#38bdf8;border-radius:50%;animation:spin 0.8s linear infinite;"></span>
                                <span>Searching registry…</span>
                            </div>
                        </div>
                        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
                    `
                            : ''
                    }
                    ${dimensionsHtml}
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
                        ${imoNumber ? `<span style="color:#64748b;">IMO</span><span style="font-family:monospace;font-size:10px;">${imoNumber}</span>` : ''}
                        ${dataSource ? `<span style="color:#64748b;">Registry</span><span style="font-size:10px;color:#94a3b8;">${dataSource}</span>` : ''}
                    </div>
                    ${viewDetailsBtn}
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

            // ── Attach detail modal click handler ──
            if (isPremium && intel?.metadata && modalData) {
                setTimeout(() => {
                    const btn = document.getElementById(detailBtnId);
                    if (btn) {
                        btn.addEventListener('click', () => {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const d = JSON.parse(modalData) as any;

                            // Remove popup
                            if (popupRef.current) popupRef.current.remove();

                            // Create full-screen modal overlay
                            const overlay = document.createElement('div');
                            overlay.id = 'vessel-detail-modal';
                            overlay.style.cssText = `position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:fadeIn 0.2s ease-out;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`;

                            const heroImg = d.thumbnail
                                ? `<div style="width:100%;height:180px;background:url('${d.thumbnail}') center/cover no-repeat;border-radius:16px 16px 0 0;position:relative;">
                                    <div style="position:absolute;inset:0;background:linear-gradient(transparent 50%,rgba(15,23,42,0.9) 100%);border-radius:16px 16px 0 0;"></div>
                                    <div style="position:absolute;bottom:12px;left:16px;right:16px;">
                                        <div style="font-size:20px;font-weight:900;color:white;text-shadow:0 2px 8px rgba(0,0,0,0.5);">${d.flag} ${d.name}</div>
                                        <div style="font-size:12px;color:rgba(255,255,255,0.8);margin-top:2px;">${d.type}${d.isVerified ? ' • ✓ Verified' : ''}</div>
                                    </div>
                                   </div>`
                                : `<div style="padding:20px 16px 12px;text-align:center;">
                                    <div style="font-size:48px;margin-bottom:8px;">${d.flag}</div>
                                    <div style="font-size:20px;font-weight:900;color:#e2e8f0;">${d.name}</div>
                                    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">${d.type}${d.isVerified ? ' • ✓ Verified' : ''}</div>
                                   </div>`;

                            const row = (label: string, value: string | number | null, mono = false) => {
                                if (!value && value !== 0) return '';
                                const valStyle = mono ? 'font-family:monospace;font-size:12px;' : 'font-weight:600;';
                                return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                                    <span style="color:#64748b;font-size:12px;">${label}</span>
                                    <span style="color:#e2e8f0;font-size:12px;${valStyle}">${value}</span>
                                </div>`;
                            };

                            overlay.innerHTML = `
                                <div style="width:100%;max-width:400px;max-height:90vh;background:rgba(15,23,42,0.98);border:1px solid rgba(255,255,255,0.1);border-radius:16px 16px 0 0;overflow-y:auto;color:#e2e8f0;animation:slideUp 0.3s ease-out;">
                                    <button id="vessel-modal-close" style="position:absolute;top:12px;right:12px;z-index:10;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.15);color:white;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>

                                    ${heroImg}

                                    <div style="padding:0 16px 16px;">
                                        <div style="margin:16px 0 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Vessel Specifications</div>
                                        ${row('MMSI', d.mmsi, true)}
                                        ${row('IMO', d.imo, true)}
                                        ${row('Call Sign', d.callSign)}
                                        ${row('Flag', `${d.flag} ${d.flagCountry}`)}
                                        ${row('Type', d.type)}
                                        ${row('LOA', d.loa ? d.loa.toFixed(1) + ' m' : null)}
                                        ${row('Beam', d.beam ? d.beam.toFixed(1) + ' m' : null)}
                                        ${row('Draft', d.draft ? d.draft.toFixed(1) + ' m' : null)}

                                        <div style="margin:16px 0 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Navigation</div>
                                        ${row('Status', `<span style="color:${d.statusColor};font-weight:700;">${d.status}</span>`)}
                                        ${row('SOG', d.sog > 0 ? d.sog.toFixed(1) + ' kn' : 'Stationary')}
                                        ${row('COG', d.cog != null ? d.cog.toFixed(0) + '°' : '—')}
                                        ${row('Heading', d.heading != null && d.heading !== 511 ? d.heading + '°' : '—')}
                                        ${row('Destination', d.destination)}
                                        ${row('Position', `${d.lat}°, ${d.lon}°`)}
                                        ${row('Last Seen', d.lastSeen)}

                                        <div style="margin:16px 0 8px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Data Source</div>
                                        ${row('Source', d.source)}
                                        ${row('Registry', d.dataSource)}
                                        ${row('Verified', d.isVerified ? '✓ Yes' : '✗ No')}
                                    </div>
                                </div>
                            `;

                            document.body.appendChild(overlay);

                            // Close handlers
                            const closeModal = () => {
                                overlay.style.animation = 'fadeOut 0.2s ease-in';
                                setTimeout(() => overlay.remove(), 200);
                            };
                            overlay.addEventListener('click', (ev) => {
                                if (ev.target === overlay) closeModal();
                            });
                            document.getElementById('vessel-modal-close')?.addEventListener('click', closeModal);
                        });
                    }
                }, 100);
            }
        };

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

    useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);
}
