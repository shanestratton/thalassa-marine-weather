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
import { createLogger } from '../../utils/createLogger';

const log = createLogger('useEndpointNames');

export interface EndpointCoord {
    latitude: number;
    longitude: number | null;
}

/** 4 decimal places ≈ 11 m — well inside "same berth". */
const key = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;
const placeCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

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
        return name;
    } finally {
        inflight.delete(k);
    }
}

/** Hemisphere-tagged latitude — the last-resort label when nothing resolves. */
const coarseFallback = (c: EndpointCoord | undefined): string | null => {
    if (!c || !c.latitude) return null;
    return `${Math.abs(c.latitude).toFixed(1)}°${c.latitude >= 0 ? 'N' : 'S'}`;
};

/**
 * Place names for a voyage's endpoints. Returns the coarse lat fallback until
 * (or unless) a lookup resolves, so a row is never blank and never blocks.
 */
export function useEndpointNames(
    first: EndpointCoord | undefined,
    last: EndpointCoord | undefined,
): { startLabel: string | null; endLabel: string | null } {
    const [startLocName, setStartLocName] = useState<string | null>(null);
    const [endLocName, setEndLocName] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        if (first?.latitude && first.latitude !== 0) {
            void reverseGeocodePlace(first.latitude, first.longitude ?? 0).then((name) => {
                if (alive && name) setStartLocName(name);
            });
        }
        // The end is geocoded even when it matches the start, so a single-fix
        // voyage still shows a place rather than one bare label.
        if (last?.latitude && last.latitude !== 0) {
            void reverseGeocodePlace(last.latitude, last.longitude ?? 0).then((name) => {
                if (alive && name) setEndLocName(name);
            });
        }
        return () => {
            alive = false;
        };
    }, [first?.latitude, first?.longitude, last?.latitude, last?.longitude]);

    return {
        startLabel: startLocName || coarseFallback(first),
        endLabel: endLocName || coarseFallback(last),
    };
}
