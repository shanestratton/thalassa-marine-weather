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

import { LocationStore } from '../../stores/LocationStore';
import { useWeatherStore } from '../../stores/weatherStore';
import { PassageStore } from '../../stores/PassageStore';
import type { ThalassaContext, ThalassaLocation, ThalassaConditions, ThalassaPassage } from '../../types/voice';

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
    };
}
