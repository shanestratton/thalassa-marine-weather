/**
 * marine — waves, swell, sea temperature and current, from OUR infrastructure.
 *
 * Pi first, then Supabase, then nothing (Shane 2026-07-22: "it needs to live
 * on the pi and the supabase. pi first, if the data is not there or no pi or
 * stale, then the supabase. that is it."). Upstream on both is Open-Meteo's
 * marine grid via the customer key those machines already hold — so this
 * removes StormGlass as a third party without adding one, and the commercial
 * key stops shipping inside the app bundle.
 *
 * This is deliberately its OWN source rather than a block on the get-weather
 * response. On iOS `fetchUnifiedWeather` returns from the native Apple
 * WeatherKit plugin before it ever reaches the Pi or the edge function
 * (services/weather/api/unified.ts:319-337), and Apple carries no marine data
 * at all. Marine bolted onto that response would simply never arrive on the
 * platform the boat actually runs.
 *
 * ── THE SNAP GUARD, which is the whole safety story here ──
 *
 * Open-Meteo's marine grid is ocean-only. An inshore request is not rejected
 * and does not return nulls — it is SNAPPED to the nearest wet cell and
 * answered from there, confidently. Measured at Newport on 2026-07-22:
 *
 *     requested -27.2100, 153.1000
 *     returned  -27.2083, 153.2084   → 10.7 km east, out in Moreton Bay
 *     wave_height 0.58 m             → no null, no warning
 *
 * That is open-water swell presented as your anchorage: precisely the error
 * the sheltered-water damping exists to correct, except sourced rather than
 * modelled. So every response carries how far it was snapped, and anything
 * beyond SNAP_MAX_KM is refused as a local reading.
 */
import { piCache } from '../../PiCacheService';
import { withTimeout } from '../../../utils/deadline';
import { createLogger } from '../../../utils/createLogger';

const log = createLogger('Marine');

/** Beyond this the returned cell is somewhere else, not here. ~1 grid cell of
 *  slack for a legitimately coastal point; Newport's 10.7 km snap is refused. */
const SNAP_MAX_KM = 2;

/** Per-hop budget. AbortSignal is a no-op under CapacitorHttp, so this is the
 *  only thing that actually bounds these calls on device. */
const HOP_MS = 4_000;

const KMH_TO_MS = 1000 / 3600;
const M_TO_FT = 3.28084;

export interface MarineReading {
    /** FEET — the report boundary is feet, not metres (the shelter damping
     *  multiplies by M_PER_FT to get back to metres). Open-Meteo gives metres;
     *  the conversion happens here, once. */
    waveHeight: number | null;
    wavePeriod: number | null;
    waveDirection: number | null;
    swellHeight: number | null;
    swellPeriod: number | null;
    swellDirection: number | null;
    secondarySwellHeight: number | null;
    secondarySwellPeriod: number | null;
    /** °C */
    waterTemperature: number | null;
    /** METRES PER SECOND. Open-Meteo reports km/h; StormGlass reported m/s and
     *  the app expects m/s, so a straight port would have read 3.6× fast. */
    currentSpeed: number | null;
    currentDirection: number | null;
    /** How far the answering grid cell is from the point asked for. */
    snappedKm: number;
    /** Which machine served it — for the [perf]/parity lines. */
    via: 'pi' | 'supabase';
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const R = 6371;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLon = ((bLon - aLon) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mToFt = (v: unknown): number | null => {
    const n = num(v);
    return n === null ? null : parseFloat((n * M_TO_FT).toFixed(2));
};

interface RawMarine {
    latitude?: number;
    longitude?: number;
    current?: Record<string, unknown>;
}

/**
 * Map an Open-Meteo marine payload, converting units at this boundary and
 * NOWHERE else. Exported for tests: the unit and snap rules are the two things
 * that would silently corrupt a marine reading if they regressed.
 */
export function mapMarine(
    raw: RawMarine,
    reqLat: number,
    reqLon: number,
    via: 'pi' | 'supabase',
): MarineReading | null {
    const c = raw?.current;
    if (!c) return null;

    const gotLat = num(raw.latitude);
    const gotLon = num(raw.longitude);
    // No echoed coordinate means we cannot prove the reading is local. For a
    // marine safety number, unprovable is refused.
    if (gotLat === null || gotLon === null) return null;

    return {
        waveHeight: mToFt(c.wave_height),
        wavePeriod: num(c.wave_period),
        waveDirection: num(c.wave_direction),
        swellHeight: mToFt(c.swell_wave_height),
        swellPeriod: num(c.swell_wave_period),
        swellDirection: num(c.swell_wave_direction),
        secondarySwellHeight: mToFt(c.secondary_swell_wave_height),
        secondarySwellPeriod: num(c.secondary_swell_wave_period),
        waterTemperature: num(c.sea_surface_temperature),
        currentSpeed: (() => {
            const kmh = num(c.ocean_current_velocity);
            return kmh === null ? null : parseFloat((kmh * KMH_TO_MS).toFixed(3));
        })(),
        currentDirection: num(c.ocean_current_direction),
        snappedKm: parseFloat(haversineKm(reqLat, reqLon, gotLat, gotLon).toFixed(2)),
        via,
    };
}

/** Is this reading actually about the place that was asked for? */
export function isLocalReading(r: MarineReading | null, maxKm = SNAP_MAX_KM): boolean {
    return !!r && r.snappedKm <= maxKm;
}

async function hop(url: string, reqLat: number, reqLon: number, via: 'pi' | 'supabase'): Promise<MarineReading | null> {
    const res = await withTimeout(
        fetch(url).then(
            (r) => (r.ok ? r.json() : null),
            () => null,
        ),
        null,
        HOP_MS,
    );
    return res ? mapMarine(res as RawMarine, reqLat, reqLon, via) : null;
}

/**
 * Fetch marine conditions. Pi first, Supabase second, null last.
 *
 * Returns the reading even when it was snapped too far — the caller decides,
 * via isLocalReading, so the distance can be logged rather than silently
 * swallowed. Nothing here throws; a marine source that can explode is a
 * marine source that takes the whole report down with it.
 */
export async function fetchMarine(lat: number, lon: number): Promise<MarineReading | null> {
    const params = `lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;

    if (piCache.isAvailable()) {
        try {
            const piUrl = `${piCache.baseUrl}/api/weather/marine?${params}`;
            const viaPi = await hop(piUrl, lat, lon, 'pi');
            if (viaPi) return viaPi;
            log.warn('Pi marine miss — falling through to Supabase');
        } catch {
            /* fall through */
        }
    }

    try {
        const base = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
        if (!base) return null;
        const key = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
        const url = `${base}/functions/v1/get-marine?${params}${key ? `&apikey=${key}` : ''}`;
        return await hop(url, lat, lon, 'supabase');
    } catch {
        return null;
    }
}
