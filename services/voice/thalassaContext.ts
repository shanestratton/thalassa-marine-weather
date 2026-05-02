/**
 * thalassaContext — snapshot of what the skipper currently sees in Thalassa.
 *
 * Bundled into every voice/text request to the cloud Bosun edge function so
 * Haiku has BP2-style "current state" alongside the static vessel profile.
 * The edge function injects this into the system prompt before every call.
 *
 * What we send:
 *   - Selected location (lat/lon/name + how it was set + how stale)
 *   - Current conditions at that location (the Glass-section weather)
 *   - Active passage plan (if any)
 *   - Device-local time
 *
 * What we DON'T send (yet):
 *   - Scuttlebutt DMs / chat — auth-scoped + sensitive, follow-up commit
 *   - NMEA / boat instruments — those live on the Pi when it exists
 *   - Full hourly forecast / tide tables — too verbose; tools fetch on demand
 *
 * Reads stores synchronously — no async, no network. Safe to call right
 * before any voice/text submit.
 */

import { BgGeoManager } from '../BgGeoManager';
import { LocationStore } from '../../stores/LocationStore';
import { useWeatherStore } from '../../stores/weatherStore';
import { PassageStore } from '../../stores/PassageStore';
import type {
    ThalassaContext,
    ThalassaLocation,
    ThalassaConditions,
    ThalassaPassage,
    ThalassaPhoneGps,
} from '../../types/voice';

/**
 * Cached reverse-geocoded place name for the phone GPS position.
 * Keyed on coordinates rounded to 0.01° (~1.1 km cell) so we don't
 * hit Nominatim every voice query for an essentially-stationary boat.
 * prewarmPhoneGpsContext() refreshes this asynchronously on console
 * open; gatherPhoneGps() reads it synchronously when assembling the
 * snapshot Calypso sees.
 */
let cachedReverseGeocode: { lat: number; lon: number; place: string } | null = null;
let lastReverseGeocodeAttempt = 0;
const REVERSE_GEOCODE_RETRY_MS = 30_000;

function roundCoord(x: number): number {
    return Math.round(x * 100) / 100;
}

/**
 * Pre-fetch a reverse-geocoded place name for the current phone GPS
 * position. Async — kicked off from the BosunConsole's prewarm hook
 * so the cache is populated before the skipper's first query.
 *
 * Silently no-ops if no GPS, or if a same-cell entry is already cached.
 * Uses Open-Meteo's reverse-geocoding (covers populated areas; returns
 * null at sea, which we want — Calypso reads coords aloud in that case).
 */
export async function prewarmPhoneGpsContext(): Promise<void> {
    const pos = BgGeoManager.getLastPosition();
    if (!pos) return;
    const rlat = roundCoord(pos.latitude);
    const rlon = roundCoord(pos.longitude);
    if (cachedReverseGeocode && cachedReverseGeocode.lat === rlat && cachedReverseGeocode.lon === rlon) {
        return;
    }
    // Cool-off window so we don't hammer Nominatim on every console open
    // when offshore (no result will ever come back; Nominatim's free
    // tier is 1 req/sec).
    if (Date.now() - lastReverseGeocodeAttempt < REVERSE_GEOCODE_RETRY_MS) return;
    lastReverseGeocodeAttempt = Date.now();
    try {
        const { reverseGeocode } = await import('../weather/api/geocoding');
        const place = await reverseGeocode(pos.latitude, pos.longitude);
        if (place) {
            cachedReverseGeocode = { lat: rlat, lon: rlon, place };
        } else {
            // Probably at sea — clear so Calypso falls back to coords
            cachedReverseGeocode = null;
        }
    } catch {
        /* network blip — leave cache alone, will retry next prewarm */
    }
}

function gatherPhoneGps(): ThalassaPhoneGps | undefined {
    const pos = BgGeoManager.getLastPosition();
    if (!pos) return undefined;
    if (!Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) return undefined;
    const rlat = roundCoord(pos.latitude);
    const rlon = roundCoord(pos.longitude);
    const placeMatch =
        cachedReverseGeocode && cachedReverseGeocode.lat === rlat && cachedReverseGeocode.lon === rlon
            ? cachedReverseGeocode.place
            : undefined;
    return {
        lat: Number(pos.latitude.toFixed(5)),
        lon: Number(pos.longitude.toFixed(5)),
        accuracyM: Math.round(pos.accuracy),
        speedKt: Number.isFinite(pos.speed) && pos.speed >= 0 ? Number((pos.speed * 1.94384).toFixed(1)) : undefined,
        headingDeg:
            typeof pos.heading === 'number' && Number.isFinite(pos.heading) && pos.heading >= 0
                ? Math.round(pos.heading)
                : undefined,
        ageSec: ageSeconds(pos.receivedAt) ?? 0,
        place: placeMatch,
    };
}

function ageSeconds(ts: number | undefined): number | undefined {
    if (!ts || !Number.isFinite(ts)) return undefined;
    return Math.max(0, Math.round((Date.now() - ts) / 1000));
}

function gatherLocation(): ThalassaLocation | undefined {
    const loc = LocationStore.getState();
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return undefined;
    return {
        lat: Number(loc.lat.toFixed(5)),
        lon: Number(loc.lon.toFixed(5)),
        name: loc.name,
        source: loc.source,
        ageSec: ageSeconds(loc.timestamp) ?? 0,
    };
}

function gatherConditions(): ThalassaConditions | undefined {
    const wx = useWeatherStore.getState().weatherData;
    if (!wx) return undefined;
    const cur = wx.current;
    if (!cur) return undefined;

    // generatedAt is ISO — convert to age in seconds for the LLM.
    let ageSec: number | undefined;
    if (wx.generatedAt) {
        const ts = Date.parse(wx.generatedAt);
        if (Number.isFinite(ts)) ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    }

    return {
        locationName: wx.locationName,
        windKt: cur.windSpeed ?? undefined,
        windDirDeg: cur.windDegree,
        windDirCompass: cur.windDirection,
        gustKt: cur.windGust ?? undefined,
        waveHeightM: cur.waveHeight ?? undefined,
        wavePeriodSec: cur.wavePeriod ?? cur.swellPeriod ?? undefined,
        airTempC: cur.airTemperature ?? undefined,
        waterTempC: cur.waterTemperature ?? undefined,
        pressureHpa: cur.pressure ?? undefined,
        humidityPct: cur.humidity ?? undefined,
        condition: cur.condition,
        description: cur.description,
        source: wx.modelUsed || undefined,
        ageSec,
    };
}

function gatherPassage(): ThalassaPassage | undefined {
    const p = PassageStore.getState();
    if (!p || !p.hasRoute) return undefined;
    if (!p.departPort || !p.destPort) return undefined;
    return {
        from: p.departPort,
        to: p.destPort,
        distanceNm: p.totalDistanceNM,
        durationHours: p.totalDurationHours,
        departureTime: p.departureTime ?? undefined,
        arrivalTime: p.arrivalTime ?? undefined,
        maxWindKt: p.maxWindKt ?? undefined,
        maxWaveM: p.maxWaveM ?? undefined,
    };
}

/**
 * Gather a snapshot of current Thalassa state for Bosun.
 *
 * Returns undefined-safe partials so the edge function can render only
 * what's actually populated — no "lat: null" noise in the system prompt.
 */
export function gatherThalassaContext(): ThalassaContext {
    return {
        localTimeIso: new Date().toISOString(),
        location: gatherLocation(),
        conditions: gatherConditions(),
        passage: gatherPassage(),
        phoneGps: gatherPhoneGps(),
    };
}
