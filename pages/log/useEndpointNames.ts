/**
 * useEndpointNames — reverse-geocode a voyage's first/last fix into place
 * names, so a route can be called "Newport → Scarborough" instead of a
 * coordinate pair or a generic label.
 *
 * Extracted from VoyageCard (2026-07-19) when the cast-off "Following a
 * route?" sheet needed the same names: every route in it read "Suggested
 * route", so a skipper picking one to broadcast was choosing blind between
 * identical rows (Shane: "the heading on all of the routes is the same...
 * they should really be the name of the route"). Shared rather than copied —
 * the card and the sheet name the SAME voyage, and two copies of a naming
 * rule drift into disagreeing about it.
 *
 * Cached at module scope on a ~11 m coordinate grid: the sheet geocodes every
 * planned route at once, and those endpoints are usually the same berth the
 * cards already looked up. A cache hit also means an offline cast-off still
 * shows names the app resolved earlier in the session.
 */
import { useEffect, useState } from 'react';
import { pruneMap } from '../../utils/boundedMap';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('useEndpointNames');

export interface EndpointCoord {
    latitude: number | null;
    longitude: number | null;
}

type UsableEndpointCoord = { latitude: number; longitude: number };

/** 4 decimal places ≈ 11 m — well inside "same berth". */
const key = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
const placeCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
/** 11 m keys mean a jittering live position mints keys forever — cap it. */
const PLACE_CACHE_MAX = 300;

/**
 * Resolve one position to a short local place name, or null.
 * Mapbox first (better on the coast), Nominatim at widening zooms after.
 */
export async function reverseGeocodePlace(lat: number, lon: number): Promise<string | null> {
    const k = key(lat, lon);
    if (placeCache.has(k)) return placeCache.get(k) ?? null;
    const running = inflight.get(k);
    if (running) return running; // two cards + a sheet row must not fire three lookups

    const job = (async (): Promise<string | null> => {
        // 1. The app's own geocoder — Mapbox-backed, more reliable inshore.
        try {
            const { reverseGeocode: appGeocode } = await import('../../services/weatherService');
            const name = await appGeocode(lat, lon);
            if (name) {
                // "Newport, Redcliffe, QLD" → "Newport"
                const parts = name
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                if (parts.length > 0) return parts[0];
            }
        } catch (e) {
            log.warn('fall through to Nominatim:', e);
        }

        // 2. Nominatim, widening out — coastal/offshore fixes often miss at z16.
        for (const zoom of [16, 14, 10, 8, 5]) {
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=${zoom}&addressdetails=1`,
                );
                if (!res.ok) continue;
                const data = await res.json();
                const addr = data.address || {};
                const local =
                    addr.neighbourhood ||
                    addr.suburb ||
                    addr.village ||
                    addr.town ||
                    addr.city_district ||
                    addr.city ||
                    addr.hamlet ||
                    addr.county ||
                    null;
                if (local) return local;
            } catch (e) {
                log.warn('geocode skip:', e);
                continue;
            }
        }
        return null;
    })();

    inflight.set(k, job);
    try {
        const name = await job;
        placeCache.set(k, name);
        pruneMap(placeCache, PLACE_CACHE_MAX);
        return name;
    } finally {
        inflight.delete(k);
    }
}

/**
 * Two-decimal GPS fallback for an endpoint that has no usable place name.
 *
 * This is deliberately a display-only fallback: it never changes the saved
 * log entry, so a future successful reverse-geocode can still replace it with
 * a harbour, anchorage, or town name. Reject the common `(0, 0)` placeholder
 * rather than presenting it as a real departure or arrival.
 */
const hasUsableEndpointCoordinates = (c: EndpointCoord | undefined): c is UsableEndpointCoord => {
    const lat = c?.latitude;
    const lon = c?.longitude;
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180 &&
        (lat !== 0 || lon !== 0)
    );
};

export function formatEndpointCoordinates(c: EndpointCoord | undefined): string | null {
    if (!hasUsableEndpointCoordinates(c)) return null;
    return `${c.latitude.toFixed(2)}, ${c.longitude.toFixed(2)}`;
}

/**
 * Place names for a voyage's endpoints. Returns a two-decimal GPS pair until
 * (or unless) a lookup resolves, so a row is never blank and never blocks.
 */
export function useEndpointNames(
    first: EndpointCoord | undefined,
    last: EndpointCoord | undefined,
): { startLabel: string | null; endLabel: string | null } {
    const [startLocName, setStartLocName] = useState<string | null>(null);
    const [endLocName, setEndLocName] = useState<string | null>(null);
    const firstLatitude = first?.latitude ?? null;
    const firstLongitude = first?.longitude ?? null;
    const lastLatitude = last?.latitude ?? null;
    const lastLongitude = last?.longitude ?? null;

    useEffect(() => {
        let alive = true;
        const start = { latitude: firstLatitude, longitude: firstLongitude };
        const end = { latitude: lastLatitude, longitude: lastLongitude };
        // A card can stay mounted while its live voyage gets a new endpoint.
        // Clear the old locality before resolving the new pair, otherwise an
        // earlier voyage name can briefly masquerade as this voyage's start.
        setStartLocName(null);
        setEndLocName(null);
        if (hasUsableEndpointCoordinates(start)) {
            void reverseGeocodePlace(start.latitude, start.longitude).then((name) => {
                const resolved = name?.trim();
                if (alive && resolved) setStartLocName(resolved);
            });
        }
        // The end is geocoded even when it matches the start, so a single-fix
        // voyage still shows a place rather than one bare label.
        if (hasUsableEndpointCoordinates(end)) {
            void reverseGeocodePlace(end.latitude, end.longitude).then((name) => {
                const resolved = name?.trim();
                if (alive && resolved) setEndLocName(resolved);
            });
        }
        return () => {
            alive = false;
        };
    }, [firstLatitude, firstLongitude, lastLatitude, lastLongitude]);

    return {
        startLabel: startLocName || formatEndpointCoordinates(first),
        endLabel: endLocName || formatEndpointCoordinates(last),
    };
}
