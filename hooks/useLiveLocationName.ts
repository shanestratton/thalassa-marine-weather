/**
 * useLiveLocationName — live-updating reverse geocode of the user's GPS.
 *
 * Why: The Glass shows a location label ("Brisbane, QLD") alongside the
 * weather. Weather is expensive to refresh so we only pull it every few
 * minutes — but users at sea want the label to keep up with where they
 * actually are, not be stuck on where they were 10 min ago.
 *
 * What it does:
 *   - Subscribes to the live GPS stream via GpsService.watchPosition.
 *     This is free — Transistorsoft's BgGeoManager is already running
 *     for anchor watch / ship log / MOB, so we're just adding a listener
 *     on the existing CLLocationManager instance.
 *   - Every 10 seconds, if the latest buffered position has moved > 50m
 *     from whatever we last reverse-geocoded, hits reverseGeocode() and
 *     returns the new name.
 *   - Gated on LocationStore.source === 'gps' so when the user has
 *     actively pinned a different spot on the map (source = 'map_pin'
 *     / 'favorite' / 'search') we stop overriding their choice.
 *
 * Returns the current live name or null if the gate is closed or no
 * position is available yet.
 */

import { useEffect, useState, useRef } from 'react';
import { GpsService } from '../services/GpsService';
import { LocationStore } from '../stores/LocationStore';
import { reverseGeocode } from '../services/weatherService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useLiveLocationName');

// Tuning constants. 10s cadence matches what the user asked for; 50m
// movement threshold filters GPS jitter while still catching meaningful
// movement (e.g. motoring out of the marina).
const POLL_INTERVAL_MS = 10_000;
const MIN_MOVEMENT_M = 50;

/** Approximate great-circle distance in metres between two coords. */
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000; // Earth radius in metres
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Format a lat/lon pair as a human-readable marine coordinate, e.g.
 * "23.5142°S, 154.2310°E". Used as a fallback when reverseGeocode
 * returns nothing — which is the common case over open ocean, where
 * Nominatim has no named admin region.
 */
function formatCoords(lat: number, lon: number): string {
    const latPart = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonPart = `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    return `${latPart}, ${lonPart}`;
}

export function useLiveLocationName(): string | null {
    const [name, setName] = useState<string | null>(null);

    // Ref-stashed latest position so the 10s interval doesn't need to
    // re-subscribe every time a new GPS fix arrives.
    const latestPosRef = useRef<{ lat: number; lon: number } | null>(null);
    // Last position we successfully reverse-geocoded — used for the
    // movement-threshold check.
    const lastGeocodedRef = useRef<{ lat: number; lon: number } | null>(null);

    useEffect(() => {
        // Subscribe to the GPS stream. watchPosition returns an
        // unsubscribe fn; call it on cleanup.
        const unsub = GpsService.watchPosition((pos) => {
            latestPosRef.current = { lat: pos.latitude, lon: pos.longitude };
        });

        // Poll the ref every 10s; reverse-geocode when it's worth doing.
        const intervalId = setInterval(async () => {
            // Gate: only honour a user-placed pin as a hard override.
            // 'gps' / 'initial' / 'search' / 'favorite' sources all get
            // live-updated — the home port from onboarding (stored as
            // 'search') shouldn't pin the label to a possibly-wrong
            // geocoding match when the user's phone is physically
            // somewhere else. Only 'map_pin' (user explicitly tapped
            // a point on the map) is treated as a strict override.
            const storeSource = LocationStore.getState().source;
            if (storeSource === 'map_pin') return;

            const latest = latestPosRef.current;
            if (!latest) return;

            // Skip if we haven't moved enough since the last geocode.
            const last = lastGeocodedRef.current;
            if (last && distanceMeters(last.lat, last.lon, latest.lat, latest.lon) < MIN_MOVEMENT_M) {
                return;
            }

            try {
                const resolved = await reverseGeocode(latest.lat, latest.lon);
                // Offshore fallback: reverseGeocode returns null/empty over
                // open ocean (Nominatim doesn't have a "Pacific Ocean" at
                // 20°S 160°W in its admin hierarchy). Swap in formatted
                // coords so the punter still sees a useful, updating label
                // instead of being stuck on the last shore name.
                const displayName = resolved || formatCoords(latest.lat, latest.lon);
                lastGeocodedRef.current = { ...latest };
                setName(displayName);
                // Mirror into LocationStore so any other consumer that
                // reads from there sees the fresh label too.
                LocationStore.setFromGPS(latest.lat, latest.lon, displayName);
            } catch (err) {
                // Even on network/API failure we can still show coords
                // rather than leave the label stale.
                log.warn('reverseGeocode failed — falling back to coords', err);
                const fallback = formatCoords(latest.lat, latest.lon);
                lastGeocodedRef.current = { ...latest };
                setName(fallback);
                LocationStore.setFromGPS(latest.lat, latest.lon, fallback);
            }
        }, POLL_INTERVAL_MS);

        return () => {
            unsub();
            clearInterval(intervalId);
        };
    }, []);

    return name;
}
