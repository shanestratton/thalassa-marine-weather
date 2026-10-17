import { MarineWeatherReport, WeatherModel, OffshoreModel } from '../../types';
import { parseLocation, reverseGeocode } from './api/geocoding';
import { fetchOpenMeteo } from './api/openmeteo';
import { applyMarineModel, finalizeMarineForecast } from './applyMarineModel';
import { fetchWeatherKitFull, buildReportFromWeatherKit } from './api/weatherkit';
import { fetchUnifiedWeather } from './api/unified';
import { fetchRealTides, interpolateTideHourly } from './api/tides';
import { saveToCache, getFromCacheOffline } from './cache';
import { assessShelter } from './shelter';
import { crumb } from '../../utils/flightRecorder';
import { Capacitor } from '@capacitor/core';
import { announceCell } from './wxPublished';
import { withTimeout } from '../../utils/deadline';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    resolveForecastModel,
    resolveOffshoreModel,
    offshoreAtmosphericModel,
    isConcreteModel,
    isSpitfire,
} from './forecastModels';
import { fetchSpitfire, applySpitfireToReport } from './spitfire';
import { piCache } from '../PiCacheService';
import { satelliteModeActive } from '../networkPolicy';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('index');

// Session/pair listeners belong to an actual full marine read, not importing
// a pure weather helper or opening the compact Satellite path.
async function fetchMarineModelV2(lat: number, lon: number) {
    const marine = await import('./api/marineModel');
    return marine.fetchMarineModelV2(lat, lon);
}

// --- RE-EXPORTS (Maintain API Compatibility) ---
export { MAJOR_BUOYS } from './config';
export { getApiKeySuffix, isStormglassKeyPresent, debugStormglassConnection, checkStormglassStatus } from './keys';
export { reverseGeocode, parseLocation } from './api/geocoding';
export { fetchOpenMeteo } from './api/openmeteo';
export { fetchActiveBuoys } from './api/buoys';
export { fetchWeatherKitRealtime, fetchWeatherKitFull, fetchMinutelyRain } from './api/weatherkit';
export { fetchUnifiedWeather, fetchUnifiedWeatherRaw, extractNowcast } from './api/unified';

// Atmospheric source selection and independent versioned marine enrichment.
// No active StormGlass request or premium fallback remains in this orchestrator.

// ── Request Dedup ──
// If an identical fetch is already in-flight, piggyback on its Promise
// instead of firing 4 more concurrent API calls.
// Key granularity: ~1km (2 decimal places of lat/lon).
const _inflight = new Map<string, Promise<MarineWeatherReport>>();

interface ForecastSelection {
    userId: string | undefined;
    forecastModel: WeatherModel;
    offshoreModel: OffshoreModel;
    satelliteMode: boolean;
}
const forecastSelection = (): ForecastSelection => {
    const settings = useSettingsStore.getState().settings;
    return {
        userId: useAuthStore.getState().user?.id,
        forecastModel: resolveForecastModel(settings.forecastModel),
        offshoreModel: resolveOffshoreModel(settings.offshoreModel),
        satelliteMode: settings.satelliteMode === true,
    };
};
const sameSelection = (a: ForecastSelection, b: ForecastSelection) =>
    a.userId === b.userId &&
    a.forecastModel === b.forecastModel &&
    a.offshoreModel === b.offshoreModel &&
    a.satelliteMode === b.satelliteMode;

const matchesOffshoreModel = (report: MarineWeatherReport, model: OffshoreModel): boolean =>
    report.locationType === 'offshore' &&
    report.modelUsed
        .split('+')
        .some(
            (part) =>
                part === `om:${offshoreAtmosphericModel(model)}` || part === `wx:${offshoreAtmosphericModel(model)}`,
        );

/**
 * Fill the holes a single forecast model physically cannot fill.
 *
 * When the user pins a model, that model's report becomes the atmospheric
 * base — but no forecast model publishes `uv_index` at all (it's a CAMS
 * product), and `visibility` exists upstream only for UKMO and GFS, so ICON
 * (the default) and ECMWF will NEVER carry it. Rather than show "—" forever,
 * borrow those two fields from the WeatherKit-backed report the pipeline has
 * already fetched in parallel: no extra request, real data.
 *
 * Strictly gap-fill — the pinned model's own values always win where it has
 * them, so this can never overwrite real model output. Mutates `report`.
 *
 * @returns true if anything was actually borrowed, so the caller can keep the
 *          `modelUsed` tag honest about the blend.
 */
export function gapFillModelBlindSpots(report: MarineWeatherReport, supplement: MarineWeatherReport | null): boolean {
    if (!supplement) return false;
    let borrowed = false;

    const current = { ...report.current };
    if (current.uvIndex == null && supplement.current?.uvIndex != null) {
        current.uvIndex = supplement.current.uvIndex;
        borrowed = true;
    }
    if (current.visibility == null && supplement.current?.visibility != null) {
        current.visibility = supplement.current.visibility;
        borrowed = true;
    }
    report.current = current;

    // Hourly series — matched on UTC epoch hour, because the two sources
    // format their timestamps differently ("…T17:00:00Z" vs "…T17:00").
    if (supplement.hourly?.length && report.hourly?.length) {
        const toHourKey = (t: string) => Math.floor(new Date(t).getTime() / 3600000);
        const supHourly = new Map(supplement.hourly.map((h) => [toHourKey(h.time), h]));
        report.hourly = report.hourly.map((h) => {
            if (h.uvIndex != null && h.visibility != null) return h;
            const s = supHourly.get(toHourKey(h.time));
            if (!s) return h;
            const uvIndex = h.uvIndex ?? s.uvIndex ?? h.uvIndex;
            const visibility = h.visibility ?? s.visibility ?? h.visibility;
            if (uvIndex !== h.uvIndex || visibility !== h.visibility) borrowed = true;
            return { ...h, uvIndex, visibility };
        });
    }

    // Daily UV max — drives the forecast cards, same reasoning.
    if (supplement.forecast?.length && report.forecast?.length) {
        const supDaily = new Map(supplement.forecast.map((d) => [d.isoDate || d.date, d]));
        report.forecast = report.forecast.map((d) => {
            if (d.uvIndex != null) return d;
            const s = supDaily.get(d.isoDate || d.date);
            if (s?.uvIndex == null) return d;
            borrowed = true;
            return { ...d, uvIndex: s.uvIndex };
        });
    }

    return borrowed;
}

export const fetchWeatherByStrategy = async (
    lat: number,
    lon: number,
    name: string,
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland',
): Promise<MarineWeatherReport> => {
    // Coalesce only metre-scale GPS jitter. The former 0.01° identity could
    // hand one caller another point's full weather/tide report kilometres
    // away while the first request was in flight.
    // Snapshot before the first await. A model/account switch must start a
    // distinct request even at the very same position.
    const selection = forecastSelection();
    const dedupKey = JSON.stringify([lat, lon, name, locationType, selection]);
    const existing = _inflight.get(dedupKey);
    if (existing) return structuredClone(await existing);

    const promise = _fetchWeatherByStrategyImpl(lat, lon, name, selection, locationType);
    _inflight.set(dedupKey, promise);
    try {
        return structuredClone(await promise);
    } finally {
        if (_inflight.get(dedupKey) === promise) _inflight.delete(dedupKey);
    }
};

const _fetchWeatherByStrategyImpl = async (
    lat: number,
    lon: number,
    name: string,
    selection: ForecastSelection,
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland',
): Promise<MarineWeatherReport> => {
    if (selection.satelliteMode) {
        // One bounded compact request. A failed compact response must never
        // fan out into the full-size provider pack on a metered connection.
        const compact = await withTimeout(fetchUnifiedWeather(lat, lon, name, selection.userId), null, 20_000);
        if (!compact) throw new Error('Compact forecast unavailable. Retry when the satellite link is ready.');
        compact.limitedForecast = 'satellite';
        compact.locationType = locationType;
        return finalizeMarineForecast(applyMarineModel(compact, null));
    }
    let isOffshore = locationType === 'offshore';
    const needsMarine = locationType !== 'inland';
    const { userId, offshoreModel } = selection;

    // Offshore models use the named atmospheric domain, while marine is always
    // Météo-France waves paired with independent best-match motion/temperature.
    let glassModel = isOffshore ? offshoreAtmosphericModel(offshoreModel) : selection.forecastModel;
    let modelPinned = isOffshore || isConcreteModel(glassModel);
    // SPITFIRE is a published blend, not a grid — it is fetched separately and
    // only exists near the locations the wx box computes. Asking for it away
    // from those returns null and we fall through to the normal path.
    const spitfireWanted = !isOffshore && isSpitfire(glassModel);
    const spitfirePromise = spitfireWanted ? fetchSpitfire(lat, lon) : Promise.resolve(null);

    // ── Wait for Pi Cache discovery to settle (boot race fix) ──
    // On cold start, the health check is still in flight when the dashboard
    // mounts and fires this fetch. Without this gate, every fetcher sees
    // piCache.isAvailable() === false and falls through to the network —
    // bypassing a Pi that's about to come online ~200ms later.
    //
    // Uses piCache.awaitReady default (500ms, was 1500ms before 2026-04-23).
    // Plus internal shortcuts: no-op if Pi disabled, no-op if last-seen
    // was > 24h ago (user ashore — persisted in localStorage), no-op after
    // 3 consecutive misses this session. Those together make the typical
    // cold-start latency near-zero for users without / away from the Pi.
    await piCache.awaitReady();

    // Every atmospheric source keeps the original8s bound. Marine is
    // supplementary: after atmosphere/tides settle it gets the same1.5s grace.
    // Late results may populate only the marine client's bounded public RAM;
    // its account/vessel/pair revision fences prevent retired cache writes.
    const shelterPromise = assessShelter(lat, lon).catch(() => null);

    // Tell the wx publisher a boat occupies this cell (coarse 0.25° cell, no
    // user id, change-detected — a moored boat writes ~4 rows a day). This is
    // what makes follow-the-vessels coverage turn; it must never delay or
    // fail the fetch, so it is fire-and-forget by construction.
    announceCell(lat, lon);

    const SOURCE_BUDGET_MS = 8_000;
    const SUPPLEMENTARY_GRACE_MS = 1_500;
    const t0 = Date.now();
    const timings: string[] = [];
    /** Marks a source the grace window cut while it was still running. */
    const CUT = Symbol('cut');
    const bounded = <T>(label: string, p: Promise<T>, cutWhen?: Promise<unknown>): Promise<T | null> => {
        const started = Date.now();
        const budgeted = withTimeout<T | null>(
            p.catch((e) => {
                log.warn(`${label} failed:`, (e as Error)?.message || e);
                return null;
            }),
            null,
            SOURCE_BUDGET_MS,
        );
        const raced: Promise<T | null | typeof CUT> = cutWhen
            ? Promise.race<T | null | typeof CUT>([budgeted, cutWhen.then((): typeof CUT => CUT)])
            : budgeted;
        return raced.then((settled) => {
            const ms = Date.now() - started;
            const cut = settled === CUT;
            const value = cut ? null : (settled as T | null);
            // "!" gave up, "~" still running and will fill its own cache.
            timings.push(`${label}=${ms}${cut ? '~' : value === null ? '!' : ''}`);
            return value;
        });
    };

    // WeatherKit runs WITH the pack on native, consumed only if unified
    // fails. It used to run serially AFTER the allSettled — so its 8 s budget
    // ADDED to the window precisely when the network was already degraded
    // (worst case ~16 s). On iOS this is the on-device framework: starting it
    // unconditionally costs a local call that unified's own first rung was
    // making anyway. On web it would be a real duplicate edge-function hit
    // per fetch, so the web keeps the serial rare-path below.
    const weatherKitParallel = Capacitor.isNativePlatform()
        ? bounded('weatherkit', fetchWeatherKitFull(lat, lon))
        : null;

    // 1. Unified get-weather: single endpoint, subscription-routed
    const unifiedPromise = bounded('unified', fetchUnifiedWeather(lat, lon, name, userId));

    // 3. WorldTides: Direct tide fetch (24h cached — always fires)
    const tidePromise = bounded('tides', fetchRealTides(lat, lon));

    // 4. OpenMeteo: atmospheric + CAPE. Always fetched so offshore
    //    users get convective-energy readings even when Unified
    //    serves the primary data. Carries the Glass model selection —
    //    when a model is pinned this becomes the atmospheric base.
    const omPromise = bounded('openmeteo', fetchOpenMeteo(lat, lon, name, false, glassModel));

    /**
     * The tier the report cannot be built without. The grace clock for the
     * supplementary tier starts when THIS settles, not at a fixed wall time —
     * so a uniformly slow network still gets every source, and it is only a
     * source slow RELATIVE to the others that gets cut.
     */
    const essentials = Promise.all([
        unifiedPromise,
        tidePromise,
        omPromise,
        weatherKitParallel ?? Promise.resolve(null),
    ]);
    const graceGate = essentials.then(() => new Promise((resolve) => setTimeout(resolve, SUPPLEMENTARY_GRACE_MS)));

    const [unifiedResult, tideResult, omResult, marineResult] = await Promise.allSettled([
        unifiedPromise,
        tidePromise,
        omPromise,
        needsMarine ? bounded('marine', fetchMarineModelV2(lat, lon), graceGate) : Promise.resolve(null),
    ]);

    // warn, not info — info is silenced in prod, and this line is the whole
    // point of the exercise. A trailing "!" marks a source that gave up; "~"
    // one the grace window cut while it was still running.
    log.warn(`[perf] wx sources ${Date.now() - t0}ms total: ${timings.join(' ')}`);

    const unifiedReport = unifiedResult.status === 'fulfilled' ? unifiedResult.value : null;
    const tideData = tideResult.status === 'fulfilled' ? tideResult.value : null;
    let openMeteoReport = omResult.status === 'fulfilled' ? omResult.value : null;
    const marineReading = marineResult.status === 'fulfilled' ? marineResult.value : null;

    // A first visit may be classified offshore by the atmospheric/geographic
    // lookup. Correct its selected atmosphere once, reusing marine/tides and
    // all other results. Never refetch the entire pack recursively.
    if (locationType === undefined && openMeteoReport?.locationType === 'offshore') {
        isOffshore = true;
        const wanted = offshoreAtmosphericModel(offshoreModel);
        if (glassModel === wanted) modelPinned = true;
        else {
            modelPinned = false;
            if (sameSelection(selection, forecastSelection())) {
                const corrected = await bounded('offshore-model', fetchOpenMeteo(lat, lon, name, false, wanted));
                if (corrected) {
                    openMeteoReport = corrected;
                    glassModel = wanted;
                    modelPinned = true;
                }
            }
        }
    }

    // ── FALLBACK: if unified failed, add WeatherKit as a potential base ──
    // OpenMeteo is already fetched above, so we only need WeatherKit here.
    let weatherKitFull = null;

    if (!unifiedReport) {
        log.info('Unified endpoint unavailable — falling back to WeatherKit + OpenMeteo');
        // MUST go through bounded(), like the five sources above.
        //
        // This was a bare `await fetchWeatherKitFull(...).catch(...)`, and
        // .catch handles a REJECTION, not a STALL — the exact distinction the
        // header comment above already draws. fetchWeatherKitFull passes no
        // connectTimeout/readTimeout (weatherkit.ts:417) and its own fallback
        // is a bare fetch, so under CapacitorHttp it inherited the 600 s
        // native floor with nothing in JS to cut it short.
        //
        // Worst possible placement for the one unbounded call: it runs only
        // when `!unifiedReport` — i.e. once the network has already shown it
        // is failing — and it is SEQUENTIAL after the allSettled, so its
        // latency ADDS to the 8 s budget rather than overlapping it. The
        // _inflight map then hands the stalled promise to every retry, so
        // pull-to-refresh joined the hang instead of escaping it.
        //
        // bounded() also drops it into the [perf] timing line, so next time
        // the slow member is named rather than guessed at.
        weatherKitFull = weatherKitParallel
            ? await weatherKitParallel
            : await bounded('weatherkit-fallback', fetchWeatherKitFull(lat, lon));
    }

    // --- BUILD BASE REPORT ---
    let report: MarineWeatherReport;
    /** Pinned-model path only: true once UV/visibility were gap-filled from
     *  the WeatherKit-backed report, so the model tag can say so. */
    let borrowedFromWeatherKit = false;
    if (modelPinned && openMeteoReport) {
        // ✅ PINNED MODEL: the user chose a specific forecast model, so its
        // report IS the atmospheric truth — no other-provider current override
        // (that blend exists to paper over model uncertainty; here the model
        // is the point). Marine enrichment, tides, and CAPE still merge in
        // the shared pipeline below.
        report = structuredClone(openMeteoReport);

        // ── Gap-fill what a single model domain physically cannot supply ──
        const supplement =
            unifiedReport ?? (weatherKitFull ? buildReportFromWeatherKit(weatherKitFull, lat, lon, name) : null);
        borrowedFromWeatherKit = gapFillModelBlindSpots(report, supplement);
    } else if (unifiedReport) {
        // ✅ UNIFIED PATH: Single-endpoint response (premium or free)
        report = structuredClone(unifiedReport);
    } else if (weatherKitFull) {
        // FALLBACK: WeatherKit as atmospheric base
        report = buildReportFromWeatherKit(weatherKitFull, lat, lon, name);
    } else if (openMeteoReport) {
        // Last resort — OpenMeteo only
        report = structuredClone(openMeteoReport);
    } else {
        // All APIs failed — try offline cache as last resort
        const offlineResult = getFromCacheOffline({ lat, lon });
        if (offlineResult && (!isOffshore || matchesOffshoreModel(offlineResult.data, offshoreModel))) {
            const staleReport = structuredClone(offlineResult.data);
            staleReport._stale = true;
            staleReport._staleAgeMinutes = offlineResult.ageMinutes;
            // Expired marine is not a current sea observation, even when the
            // atmospheric offline forecast remains useful and explicitly stale.
            return finalizeMarineForecast(applyMarineModel(staleReport, null));
        }
        throw new Error(`All weather APIs failed for ${name}`);
    }

    // --- EXTEND DAILY HORIZON ---
    // WeatherKit / the unified endpoint cap the daily forecast at ~10 days
    // (today + 9). OpenMeteo (always fetched above) reaches 16, so append its
    // trailing days — keyed by ISO date, only dates strictly after the last one
    // we already have — to give a full 10 days in advance in the day carousel.
    // No-op when the primary source already reaches that far.
    if (openMeteoReport?.forecast?.length && report.forecast?.length) {
        const haveDates = new Set(report.forecast.map((d) => d.isoDate || d.date));
        const last = report.forecast[report.forecast.length - 1];
        const lastKey = last?.isoDate || last?.date || '';
        const extraDays = openMeteoReport.forecast.filter((d) => {
            const key = d.isoDate || d.date;
            return !!key && !haveDates.has(key) && key > lastKey;
        });
        if (extraDays.length) {
            report.forecast = [...report.forecast, ...extraDays].slice(0, 12);
        }
    }

    const computedLocationType = locationType || openMeteoReport?.locationType || report.locationType || 'coastal';
    report.locationType = computedLocationType;

    // --- APPLY TIDES (WorldTides — direct, first-class) ---
    // Tides are fetched directly from WorldTides API, not as a side effect
    // of StormGlass or OpenMeteo. 24h cached — harmonic predictions are deterministic.
    if (tideData?.tides?.length) {
        report.tides = tideData.tides;
        if (tideData.guiDetails) report.tideGUIDetails = tideData.guiDetails;

        // Dense half-hourly heights for the graph — shared with the tide-only
        // refresh in WeatherContext (services/weather/api/tides.ts).
        const interpolated = interpolateTideHourly(tideData.tides);
        if (interpolated.length > 0) report.tideHourly = interpolated;
    }

    // --- INHERIT LOCATION METADATA FROM OPENMETEO ---
    if (report.distToLandKm == null && openMeteoReport?.distToLandKm != null) {
        report.distToLandKm = openMeteoReport.distToLandKm;
    }
    if (report.isLandlocked == null && openMeteoReport?.isLandlocked != null) {
        report.isLandlocked = openMeteoReport.isLandlocked;
    }

    // --- ENRICH WITH OPENMETEO CAPE (current + hourly) ---
    // WeatherKit does not supply CAPE. Keep the original atmospheric
    // Open-Meteo supplement independent of marine availability.
    if (openMeteoReport?.current?.cape != null) {
        const current = { ...report.current };
        current.cape = openMeteoReport.current.cape;
        report.current = current;
    }
    if (openMeteoReport?.hourly?.length) {
        const toHourKey = (t: string) => Math.floor(new Date(t).getTime() / 3600000);
        const omHourlyMap = new Map(openMeteoReport.hourly.map((h) => [toHourKey(h.time), h]));
        report.hourly = report.hourly.map((h) => {
            // Keep a value already supplied by the selected atmosphere.
            if (h.cape != null) return h;
            const omH = omHourlyMap.get(toHourKey(h.time));
            if (omH?.cape == null) return h;
            return { ...h, cape: omH.cape };
        });
    }
    // Safety net: the NOW card reads `report.current.cape` directly (it does
    // NOT fall through to hourly like the forecast cards do). openmeteo.ts
    // builds `current.cape` from `hourly.cape[currentHourIndex]`, but that
    // index lookup compares `now.toISOString()` (UTC) against hourly times
    // indexed by local time (`&timezone=auto`) — so findIndex returns -1 in
    // any non-UTC zone and curCAPE ends up `undefined`. The hourly merge
    // above succeeds because it keys on UTC epoch hours. Backfill current
    // from the hourly slot that covers "now" so the NOW card doesn't show
    // "--" while every forecast hour shows a real value.
    if ((report.current.cape == null || report.current.cape === 0) && report.hourly?.length) {
        const nowKey = Math.floor(Date.now() / 3600000);
        const nowHour = report.hourly.find((h) => Math.floor(new Date(h.time).getTime() / 3600000) === nowKey);
        if (nowHour && typeof nowHour.cape === 'number' && nowHour.cape > 0) {
            report.current = { ...report.current, cape: nowHour.cape };
        }
    }

    // --- INHERIT TIMEZONE ---
    if (!report.timeZone) {
        report.timeZone = openMeteoReport?.timeZone;
    }
    if (report.utcOffset === undefined) {
        report.utcOffset = openMeteoReport?.utcOffset;
    }

    // --- BACKFILL DAILY GUST FROM HOURLY ---
    // Marine daily representatives are assigned separately by exact local
    // date and source clock after this atmospheric gap fill.
    if (report.forecast?.length && report.hourly?.length) {
        const tzOpt = report.timeZone ? { timeZone: report.timeZone } : {};
        const hoursByDay = new Map<string, typeof report.hourly>();
        for (const h of report.hourly) {
            const day = new Date(h.time).toLocaleDateString('en-CA', tzOpt);
            const list = hoursByDay.get(day);
            if (list) list.push(h);
            else hoursByDay.set(day, [h]);
        }
        report.forecast = report.forecast.map((d) => {
            const hrs = hoursByDay.get(d.isoDate || d.date);
            if (!hrs?.length) return d;
            const out = { ...d };
            if (out.windGust == null) {
                const gusts = hrs.map((h) => h.windGust).filter((g): g is number => typeof g === 'number' && g > 0);
                if (gusts.length) out.windGust = parseFloat(Math.max(...gusts).toFixed(1));
            }
            return out;
        });
    }

    // --- SPITFIRE OVERLAY ---
    // Applied late, on top of the fully-merged report, so the consensus owns
    // the atmospherics while tides, waves and sun times survive from the
    // normal pipeline. Returns null away from the locations the wx box
    // computes, in which case nothing happens and the base report stands.
    const spitfireResult = await spitfirePromise;
    const spitfire = isOffshore ? null : spitfireResult;
    if (spitfire) applySpitfireToReport(report, spitfire);

    // --- MODEL TAG ---
    const sourcesParts: string[] = [];
    if (spitfire) {
        sourcesParts.push('spitfire');
    } else if (modelPinned && openMeteoReport) {
        // e.g. "wx:dwd_icon" (self-hosted) or "om:dwd_icon" (commercial)
        sourcesParts.push(`${openMeteoReport.modelUsed.startsWith('wx_') ? 'wx' : 'om'}:${glassModel}`);
        // UV / visibility borrowed from WeatherKit — the report is a blend,
        // so don't let the tag claim it's pure model output.
        if (borrowedFromWeatherKit) sourcesParts.push('wk');
    } else if (unifiedReport) {
        sourcesParts.push(unifiedReport.modelUsed.includes('rb') ? 'rb+om' : 'wk');
    } else if (weatherKitFull?.observation) {
        sourcesParts.push('wk');
    }
    if (marineReading) sourcesParts.push('marine-v2');
    if (!modelPinned && !unifiedReport && openMeteoReport) sourcesParts.push('om');
    report.modelUsed = sourcesParts.join('+') || report.modelUsed;

    report.locationName = name;
    report.coordinates = { lat, lon };

    // Enclosed water receives an explicit unknown, never a fabricated capped
    // ocean wave or coarse current. The already-started assessment is bounded.
    let enclosed = false;
    try {
        crumb('shelter:start');
        const shelter = await withTimeout(shelterPromise, null, 4_500);
        enclosed = shelter?.enclosed === true;
        crumb('shelter:done');
    } catch (e) {
        log.warn('shelter assessment unavailable:', (e as Error)?.message || e);
    }
    report = finalizeMarineForecast(applyMarineModel(report, marineReading, enclosed));

    // The general/offline cache is coordinate-keyed. A late obsolete model
    // response may return to its original caller, but must not replace the
    // active selection's cache entry.
    if (sameSelection(selection, forecastSelection())) saveToCache({ lat, lon }, report);
    return report;
};

// ═══════════════════════════════════════════════════════════════
// LEGACY CONVENIENCE FUNCTIONS
// Used by RoutePlanner + VoyageForm (non-dashboard contexts)
// ═══════════════════════════════════════════════════════════════

/**
 * Fast Weather: Uses OpenMeteo only (no edge function latency).
 * Used by RoutePlanner and VoyageForm for quick departure/waypoint data.
 * NOT used for the main dashboard (dashboard uses fetchWeatherByStrategy).
 */
export const fetchFastWeather = async (
    location: string,
    coords?: { lat: number; lon: number },
    model: WeatherModel = 'best_match',
): Promise<MarineWeatherReport> => {
    if (satelliteModeActive()) {
        if (!coords) throw new Error('Choose a saved position for a compact satellite forecast.');
        return fetchWeatherByStrategy(coords.lat, coords.lon, location);
    }
    // 1. Resolve Location
    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;

        // Auto-resolve name if generic
        if (!name || name === 'Current Location' || name.includes('Lat:')) {
            try {
                const resolved = await reverseGeocode(lat, lon);
                if (resolved) name = resolved;
                else {
                    const latStr = Math.abs(lat).toFixed(2) + (lat >= 0 ? 'N' : 'S');
                    const lonStr = Math.abs(lon).toFixed(2) + (lon >= 0 ? 'E' : 'W');
                    name = `Ocean Point ${latStr} ${lonStr}`;
                }
            } catch (e) {
                log.warn('[index]', e);
                name = `Location ${lat.toFixed(2)},${lon.toFixed(2)}`;
            }
        }
    } else {
        const parsed = await parseLocation(location);
        lat = parsed.lat;
        lon = parsed.lon;
        name = parsed.name;
    }

    // The quick path uses the same marine admission and final alert policy;
    // neither a legacy atmospheric sea placeholder nor a provider failure is0.
    const selection = forecastSelection();
    const result = await withTimeout(
        Promise.all([
            fetchOpenMeteo(lat, lon, name, true, model),
            fetchMarineModelV2(lat, lon),
            withTimeout(
                assessShelter(lat, lon).catch(() => null),
                null,
                4_500,
            ),
        ]),
        null,
        15_000,
    );
    if (!result) throw new Error('Fast Fetch Timeout');
    const [atmosphere, marine, shelter] = result;
    const data = finalizeMarineForecast(applyMarineModel(atmosphere, marine, shelter?.enclosed === true));
    if (sameSelection(selection, forecastSelection()) && model === selection.forecastModel)
        saveToCache({ lat, lon }, data);
    return data;
};

/** The fallback uses the same bounded source policy and never revives the
 * retired paid marine provider or a coordinate-only legacy marine cache. */
export const fetchPrecisionWeather = async (
    location: string,
    coords?: { lat: number; lon: number },
    forceRefresh = false,
    existingLocationType?: 'inshore' | 'coastal' | 'offshore' | 'inland',
): Promise<MarineWeatherReport> => {
    if (satelliteModeActive()) {
        if (!coords) throw new Error('Choose a saved position for a compact satellite forecast.');
        return fetchWeatherByStrategy(coords.lat, coords.lon, location, existingLocationType);
    }
    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;

        if (
            !name ||
            name === 'Current Location' ||
            name.startsWith('WP ') ||
            /^-?\d/.test(name) ||
            /^\d+\.\d+°[NSEW]/.test(name)
        ) {
            const r = await reverseGeocode(lat, lon);
            if (r) name = r;
        }
    } else {
        const p = await parseLocation(location);
        lat = p.lat;
        lon = p.lon;
        name = p.name;
    }

    // Each source has its own bounded cache; forceRefresh remains API-compatible.
    void forceRefresh;

    return fetchWeatherByStrategy(lat, lon, name, existingLocationType);
};
