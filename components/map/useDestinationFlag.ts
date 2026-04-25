/**
 * useDestinationFlag — pulsing flag marker at the active voyage's
 * destination, plus a small distance/bearing chip relative to the
 * user's current GPS position.
 *
 * Three render states (matches the user's mental model):
 *   1. Voyage active with destinationCoordinates → flag + chip
 *   2. Voyage active but no destination set      → no flag, route line
 *      from useFollowRouteMapbox is enough to show direction of travel
 *   3. No active voyage                          → nothing
 *
 * Always co-renders with useVesselTracker (which always shows the
 * vessel) so the user has a clear "I am here, going there" picture
 * the moment they open the chart.
 *
 * The chip uses the same scrubber-pill visual language as everything
 * else on the chart screen (slate translucent + blur + 16px radius)
 * for consistency.
 */
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { GpsService } from '../../services/GpsService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('DestinationFlag');

const KM_PER_NM = 1.852;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const toDeg = (r: number) => (r * 180) / Math.PI;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lon2 - lon1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function compass(bearing: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(bearing / 45) % 8];
}

function buildFlagElement(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'destination-flag-marker';
    el.style.cssText = `
        position: relative;
        width: 36px; height: 44px;
        pointer-events: none;
        transform: translateY(-22px); /* anchor the flag pole base at lat/lon */
    `;

    // Pulse halo behind the flag
    const halo = document.createElement('div');
    halo.style.cssText = `
        position: absolute;
        left: 50%; bottom: 0;
        width: 24px; height: 24px;
        margin-left: -12px;
        border-radius: 50%;
        background: rgba(34, 197, 94, 0.35);
        animation: vesselPulse 2.4s ease-in-out infinite;
    `;
    el.appendChild(halo);

    // Flag SVG — pole + flapping pennant. Green to differentiate from
    // the cyan vessel arrow.
    const flag = document.createElement('div');
    flag.style.cssText = `
        position: absolute;
        left: 50%; bottom: 0;
        width: 32px; height: 44px;
        margin-left: -8px;
    `;
    flag.innerHTML = `
        <svg viewBox="0 0 32 44" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="flagGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#22c55e"/>
                    <stop offset="1" stop-color="#15803d"/>
                </linearGradient>
            </defs>
            <!-- Pole -->
            <rect x="6" y="2" width="2" height="40" fill="white" stroke="#0f172a" stroke-width="0.5"/>
            <!-- Pennant -->
            <path d="M8 4 L26 8 L20 12 L26 16 L8 20 Z"
                  fill="url(#flagGrad)" stroke="white" stroke-width="1" stroke-linejoin="round"/>
            <!-- Anchor circle at base -->
            <circle cx="7" cy="42" r="3" fill="#22c55e" stroke="white" stroke-width="1"/>
        </svg>
    `;
    el.appendChild(flag);
    return el;
}

function buildChipElement(label: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'destination-flag-chip';
    el.style.cssText = `
        position: absolute;
        bottom: 50px;
        left: 50%; transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(34, 197, 94, 0.35);
        border-radius: 12px;
        padding: 4px 8px;
        color: rgba(255,255,255,0.9);
        font-size: 10px;
        font-weight: 600;
        white-space: nowrap;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    `;
    el.textContent = label;
    return el;
}

export function useDestinationFlag(mapRef: React.MutableRefObject<mapboxgl.Map | null>, mapReady: boolean) {
    const markerRef = useRef<mapboxgl.Marker | null>(null);
    const labelChipRef = useRef<HTMLDivElement | null>(null);

    // Re-render when follow-route state changes — using selector so we
    // don't subscribe to noisy fields like routeCoords.
    const isFollowing = useFollowRouteStore((s) => s.isFollowing);
    const voyagePlan = useFollowRouteStore((s) => s.voyagePlan);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Clean up previous marker on every re-render — easier than
        // mutating in place when the destination changes.
        const cleanup = () => {
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
            }
            labelChipRef.current = null;
        };

        const dest = voyagePlan?.destinationCoordinates;
        if (!isFollowing || !voyagePlan || !dest) {
            cleanup();
            return;
        }

        // Mount the flag marker.
        cleanup();
        const flagEl = buildFlagElement();
        const chipEl = buildChipElement(voyagePlan.destination || 'Destination');
        flagEl.appendChild(chipEl);
        labelChipRef.current = chipEl;

        const marker = new mapboxgl.Marker({ element: flagEl, anchor: 'bottom' })
            .setLngLat([dest.lon, dest.lat])
            .addTo(map);
        markerRef.current = marker;

        log.warn(`Destination flag mounted at ${dest.lat.toFixed(3)}, ${dest.lon.toFixed(3)}`);

        // GPS subscription — refresh the chip's distance + bearing as
        // the vessel moves. Throttled by GpsService's own update cadence.
        let lastGpsAt = 0;
        const unsub = GpsService.watchPosition((pos) => {
            const now = Date.now();
            // Throttle UI updates to 1Hz — the chip doesn't need to flicker.
            if (now - lastGpsAt < 1000) return;
            lastGpsAt = now;
            if (!labelChipRef.current) return;
            const km = haversineKm(pos.latitude, pos.longitude, dest.lat, dest.lon);
            const nm = km / KM_PER_NM;
            const bearing = bearingDeg(pos.latitude, pos.longitude, dest.lat, dest.lon);
            const dest_label = voyagePlan.destination || 'Destination';
            // Format: "Newport · 47 NM SE"
            const distLabel = nm < 10 ? nm.toFixed(1) : Math.round(nm).toString();
            labelChipRef.current.textContent = `${dest_label} · ${distLabel} NM ${compass(bearing)}`;
        });

        return () => {
            unsub();
            cleanup();
        };
    }, [mapRef, mapReady, isFollowing, voyagePlan]);
}
