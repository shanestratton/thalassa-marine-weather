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
 *   - Fires a reverse-geocode IMMEDIATELY on the first GPS fix (so the
 *     wrong-home-port label from onboarding gets corrected within a
 *     second of app open, not the 10-30s the pure-interval approach
 *     took). Subsequent fixes are debounced to the 10s polling cadence.
 *   - Only honours LocationStore.source === 'map_pin' as a strict
 *     override — everything else (gps / initial / search / favorite)
 *     gets live-updated.
 *
 * Returns the current live name or null if no position is available yet.
 */

import { useEffect, useState, useRef } from 'react';
import { GpsService } from '../services/GpsService';
import { LocationStore } from '../stores/LocationStore';
import { reverseGeocode } from '../services/weatherService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('useLiveLocationName');

// Tuning constants. 10s cadence for normal polling; 50m movement
// threshold filters GPS jitter while still catching meaningful
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
        let cancelled = false;

        // Shared worker fn — called from the first-fix callback and
        // from the 10s polling interval. Does the move-threshold check,
        // hits the geocoder, updates state + LocationStore.
        const tryReverseGeocode = async () => {
            if (cancelled) return;

            // Gate: only a user-placed map pin is a hard override.
            const storeSource = LocationStore.getState().source;
            if (storeSource === 'map_pin') return;

            const latest = latestPosRef.current;
            if (!latest) return;

            const last = lastGeocodedRef.current;
            if (last && distanceMeters(last.lat, last.lon, latest.lat, latest.lon) < MIN_MOVEMENT_M) {
                return;
            }

            try {
                const resolved = await reverseGeocode(latest.lat, latest.lon);
                if (cancelled) return;
                const displayName = resolved || formatCoords(latest.lat, latest.lon);
                lastGeocodedRef.current = { ...latest };
                setName(displayName);
                LocationStore.setFromGPS(latest.lat, latest.lon, displayName);
            } catch (err) {
                if (cancelled) return;
                log.warn('reverseGeocode failed — falling back to coords', err);
                const fallback = formatCoords(latest.lat, latest.lon);
                lastGeocodedRef.current = { ...latest };
                setName(fallback);
                LocationStore.setFromGPS(latest.lat, latest.lon, fallback);
            }
        };

        // Track whether we've already fired the immediate-on-first-fix
        // reverse-geocode. Subsequent fixes just update the ref — the
        // 10s interval handles the debouncing from there.
        let firstFixFired = false;

        const unsub = GpsService.watchPosition((pos) => {
            latestPosRef.current = { lat: pos.latitude, lon: pos.longitude };
            // First fix ever this session → reverse-geocode immediately,
            // don't wait for the interval. This is the bit that closes
            // the 10-60s gap where the label sat on whatever the last
            // cached weather report had (potentially a wrong geocoding
            // result from onboarding, like 'Old Aust Road, England' for
            // someone who typed 'Newport' and meant Newport QLD).
            if (!firstFixFired) {
                firstFixFired = true;
                void tryReverseGeocode();
            }
        });

        const intervalId = setInterval(tryReverseGeocode, POLL_INTERVAL_MS);

        return () => {
            cancelled = true;
            unsub();
            clearInterval(intervalId);
        };
    }, []);

    return name;
}
