/**
 * What the boat already knows when a sighting is logged, captured with no
 * typing: where (the vessel's GPS chain), and when available the sea
 * temperature and depth off the instruments, the wind and sea state, and the
 * boat's speed and heading.
 *
 * Position — the vessel's GPS is the truth (Shane 2026-09-03: "a: garmin gps
 * b: usb gps c: phone gps"):
 *   1. the instrument bus, when its fix is 13 s old or less;
 *   2. the Pi (2 s timeout), when its fix is 30 s old or less;
 *   3. the Pi's cloud row (60 s or fresher) of THE SIGHTING'S BOAT: the
 *      caller names it ('self', or the skipper's id for a boat you crew on),
 *      so an owner who also crews never logs at the other boat's position;
 *      no boat for the sighting, no cloud lane. The read is time-boxed (3 s)
 *      and skipped offline, so bars-but-no-data never starves the phone rung.
 *      This phone is then NOT on the boat's LAN, so it is asked too: a phone
 *      fix good to 100 m that is more than 300 m from the boat means the
 *      punter is ashore (the same 300 m as GpsSubscriptionManager's
 *      PHONE_ABOARD_MAX_M) — logged at the PHONE's position as a shore-based
 *      observation, with no boat context;
 *   4. the phone, tagged 'phone'. When a boat is configured but none of its
 *      lanes answered, `boatSilent` says so and the sheet shows an amber line
 *      before the tap, so the fallback is explicit, never silent.
 * Never the photo's EXIF, never NmeaGpsProvider on its own.
 *
 * Context — only values fresh at the tap: an instrument reading 13 s old or
 * less (NMEA_USABLE_MAX_AGE_MS), and forecast values only when the app's
 * weather report is for within 30 km of the sighting, 6 h old or less, with
 * an hourly row within 90 min of it (weather follows the punter, not the
 * boat). Forecast values are tagged 'forecast' and carry the model name for
 * the CC-BY credit. The report keeps wave height in FEET (transformers.ts);
 * it is converted to metres here.
 *
 * Every value is range-checked against the table's CHECK constraints, so a
 * bad sensor can never make the server refuse the whole sighting.
 *
 * The real receivers load lazily (defaultContextDeps), so this module is
 * cheap to import and tests pass their own.
 */
import type { BoatFix } from '../boatPositionChain';
import {
    SHORE_PROTOCOL,
    VESSEL_PROTOCOL,
    type ContextSource,
    type DepthReference,
    type SightingPositionSource,
    type SightingSamplingProtocol,
} from './types';

/** NmeaStore's usable budget (services/nmea/nmeaCadence.ts NMEA_USABLE_MAX_AGE_MS). */
export const BUS_FIX_MAX_AGE_MS = 13_000;
export const PI_FIX_MAX_AGE_MS = 30_000;
export const PI_FIX_TIMEOUT_MS = 2_000;
/** services/supabase.ts sets no fetch timeout: a hung read must not hold the phone rung. */
export const CLOUD_FIX_TIMEOUT_MS = 3_000;
/** Same distance as GpsSubscriptionManager's private PHONE_ABOARD_MAX_M. */
export const SIGHTING_ABOARD_MAX_M = 300;
/** A phone fix must be at least this good to say the punter is not aboard. */
export const ASHORE_PHONE_ACCURACY_M = 100;
export const INSTRUMENT_MAX_AGE_MS = 13_000;
export const WEATHER_MAX_DISTANCE_M = 30_000;
export const WEATHER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const WEATHER_ROW_MAX_GAP_MS = 90 * 60 * 1000;
/** Nominal accuracy of a fix the boat's receivers produced and a lane relayed. */
export const BOAT_FIX_ACCURACY_M = 10;
const FEET_PER_METRE = 3.28084;
const KNOTS_PER_MS = 1.943844;

export interface PhoneFix {
    latitude: number;
    longitude: number;
    /** Metres. */
    accuracy: number;
    /** Metres per second, when known. */
    speed: number | null;
    heading: number | null;
    timestamp: number;
}

export interface Metric {
    value: number | null;
    lastUpdated: number;
    freshness?: string;
}

/** The slice of NmeaStore's state this reads. */
export interface InstrumentState {
    waterTemp: Metric;
    depth: Metric;
    depthReference: DepthReference | null;
    tws: Metric;
    twd: Metric;
    sog: Metric;
    cog: Metric;
    heading: Metric;
    headingTrue: Metric;
    gpsAccuracyM: Metric;
}

/** The slice of the app's MarineWeatherReport this reads. */
export interface WeatherSnapshot {
    coordinates?: { lat: number; lon: number };
    generatedAt: string;
    modelUsed: string;
    hourly: Array<{
        time: string;
        windSpeed: number | null;
        windDegree?: number;
        waveHeight: number | null;
        waterTemperature?: number | null;
    }>;
}

/**
 * Whose boat's cloud row to read: 'self' (your own), a skipper's user id (a
 * boat you crew on), null (the sighting has no boat: no cloud lane), or
 * undefined (the caller does not know: the row CloudTelemetryService picks).
 */
export type CloudOwner = 'self' | string | null | undefined;

export interface ContextDeps {
    now(): number;
    /** A gateway is saved or a Pi is paired: there is a boat GPS to expect. */
    boatConfigured(): Promise<boolean>;
    busFix(): Promise<BoatFix | null>;
    piFix(timeoutMs: number): Promise<BoatFix | null>;
    cloudFix(owner?: 'self' | string): Promise<BoatFix | null>;
    /** False when the phone knows it is offline (navigator.onLine): the cloud lane is skipped. */
    online?(): boolean;
    phoneFix(): Promise<PhoneFix | null>;
    instruments(): Promise<InstrumentState | null>;
    weather(): Promise<WeatherSnapshot | null>;
}

export interface SightingPosition {
    latitude: number;
    longitude: number;
    source: SightingPositionSource;
    /** Epoch ms of the fix. */
    fixAt: number;
    accuracyM: number;
    /** accuracy plus how far the boat moved while the fix aged. */
    uncertaintyM: number;
    /** Phone far from the boat's cloud fix: logged ashore, no boat. */
    ashore: boolean;
    /** For a cloud fix: whose boat's row it was ('self' or the skipper's id). */
    cloudOwner?: 'self' | string;
}

export interface SightingContext {
    capturedAt: number;
    position: SightingPosition | null;
    /** A boat GPS is configured and none of its lanes answered: the phone stood in (or nothing did). */
    boatSilent: boolean;
    samplingProtocol: SightingSamplingProtocol;
    seaTempC: number | null;
    seaTempSource: ContextSource | null;
    waterDepthM: number | null;
    depthReference: DepthReference | null;
    windSpeedKts: number | null;
    windDirDeg: number | null;
    windSource: ContextSource | null;
    waveHeightM: number | null;
    wxModel: string | null;
    sogKts: number | null;
    cogDeg: number | null;
    headingDeg: number | null;
}

// ── small helpers ───────────────────────────────────────────────────────────

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** The value if it is finite and inside [min, max] (the table's CHECK), else null. */
export function inRange(value: unknown, min: number, max: number, digits = 2): number | null {
    if (!finite(value) || value < min || value > max) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

/** A bearing as a whole degree 0-359, or null. */
export function bearing(value: unknown): number | null {
    if (!finite(value)) return null;
    const deg = Math.round(((value % 360) + 360) % 360);
    return deg === 360 ? 0 : deg;
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function validLatLon(lat: unknown, lon: unknown): boolean {
    return finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

/** A metric fresh enough at `now`: not dead, and updated within the instrument budget. */
export function freshValue(metric: Metric | undefined, now: number): number | null {
    if (!metric || !finite(metric.value) || metric.freshness === 'dead') return null;
    if (!finite(metric.lastUpdated) || metric.lastUpdated <= 0) return null;
    const age = now - metric.lastUpdated;
    if (age < -1_000 || age > INSTRUMENT_MAX_AGE_MS) return null;
    return metric.value;
}

function uncertainty(accuracyM: number, sogKts: number | null, ageMs: number): number {
    const drift = sogKts && sogKts > 0 ? (sogKts / KNOTS_PER_MS) * Math.max(0, ageMs / 1000) : 0;
    return Math.min(100_000, Math.max(1, Math.ceil(accuracyM + drift)));
}

function fromBoat(fix: BoatFix, now: number, accuracyM: number, instrumentSogKts: number | null): SightingPosition {
    const sog = finite(fix.sogKts) ? fix.sogKts : instrumentSogKts;
    const accuracy = Math.min(100_000, Math.max(1, Math.round(accuracyM)));
    return {
        latitude: fix.latitude,
        longitude: fix.longitude,
        source: fix.rung,
        fixAt: fix.timestamp,
        accuracyM: accuracy,
        uncertaintyM: uncertainty(accuracy, sog, now - fix.timestamp),
        ashore: false,
    };
}

function fromPhone(fix: PhoneFix, now: number, ashore: boolean): SightingPosition {
    const accuracy = Math.min(100_000, Math.max(1, Math.round(finite(fix.accuracy) ? fix.accuracy : 100)));
    const sogKts = finite(fix.speed) && fix.speed >= 0 ? fix.speed * KNOTS_PER_MS : null;
    return {
        latitude: fix.latitude,
        longitude: fix.longitude,
        source: 'phone',
        fixAt: fix.timestamp,
        accuracyM: accuracy,
        uncertaintyM: uncertainty(accuracy, sogKts, now - fix.timestamp),
        ashore,
    };
}

function boatFixUsable(fix: BoatFix | null, now: number, maxAgeMs: number): fix is BoatFix {
    if (!fix || !validLatLon(fix.latitude, fix.longitude) || !finite(fix.timestamp)) return false;
    const age = now - fix.timestamp;
    return age >= -5_000 && age <= maxAgeMs;
}

function phoneUsable(fix: PhoneFix | null): fix is PhoneFix {
    return !!fix && validLatLon(fix.latitude, fix.longitude) && finite(fix.timestamp);
}

export interface PositionDecision {
    position: SightingPosition | null;
    boatSilent: boolean;
    /** Speed and course the boat lane carried (the cloud row does). */
    laneSogKts: number | null;
    laneCogDeg: number | null;
    phone: PhoneFix | null;
}

/** A promise that gives up (null) after `ms`; the late answer is ignored. */
function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([promise.catch(() => null), late]).finally(() => clearTimeout(timer));
}

/**
 * Walk the chain: bus, Pi, cloud (the sighting's boat's row, time-boxed, with
 * the ashore test), then the phone. The receiver's own accuracy and the
 * boat's speed (for how far she moved while the fix aged) come from the
 * instruments when they have them. `cloudOwner` is asked only when the cloud
 * lane is reached, so the caller has had time to learn which boat it is.
 */
export async function decidePosition(
    deps: ContextDeps,
    gpsAccuracyM: number | null,
    instrumentSogKts: number | null = null,
    cloudOwner: () => Promise<CloudOwner> = async () => undefined,
): Promise<PositionDecision> {
    const accuracy = gpsAccuracyM && gpsAccuracyM > 0 ? gpsAccuracyM : BOAT_FIX_ACCURACY_M;

    const bus = await deps.busFix().catch(() => null);
    if (boatFixUsable(bus, deps.now(), BUS_FIX_MAX_AGE_MS)) {
        return {
            position: fromBoat(bus, deps.now(), accuracy, instrumentSogKts),
            boatSilent: false,
            laneSogKts: null,
            laneCogDeg: null,
            phone: null,
        };
    }

    const pi = await deps.piFix(PI_FIX_TIMEOUT_MS).catch(() => null);
    if (boatFixUsable(pi, deps.now(), PI_FIX_MAX_AGE_MS)) {
        return {
            position: fromBoat(pi, deps.now(), BOAT_FIX_ACCURACY_M, instrumentSogKts),
            boatSilent: false,
            laneSogKts: null,
            laneCogDeg: null,
            phone: null,
        };
    }

    const owner = await cloudOwner().catch(() => undefined);
    const online = deps.online ? deps.online() : true;
    const cloud =
        owner === null || !online
            ? null
            : await within(owner === undefined ? deps.cloudFix() : deps.cloudFix(owner), CLOUD_FIX_TIMEOUT_MS);
    // cloudFix holds its own 60 s rule; this re-checks against our clock.
    if (boatFixUsable(cloud, deps.now(), 60_000)) {
        const phone = await deps.phoneFix().catch(() => null);
        if (
            phoneUsable(phone) &&
            finite(phone.accuracy) &&
            phone.accuracy <= ASHORE_PHONE_ACCURACY_M &&
            haversineM(phone.latitude, phone.longitude, cloud.latitude, cloud.longitude) > SIGHTING_ABOARD_MAX_M
        ) {
            return {
                position: fromPhone(phone, deps.now(), true),
                boatSilent: false,
                laneSogKts: null,
                laneCogDeg: null,
                phone,
            };
        }
        return {
            position: {
                ...fromBoat(cloud, deps.now(), BOAT_FIX_ACCURACY_M, instrumentSogKts),
                ...(owner ? { cloudOwner: owner } : {}),
            },
            boatSilent: false,
            laneSogKts: finite(cloud.sogKts) ? cloud.sogKts : null,
            laneCogDeg: finite(cloud.cogDeg) ? cloud.cogDeg : null,
            phone: phoneUsable(phone) ? phone : null,
        };
    }

    const boatSilent = await deps.boatConfigured().catch(() => false);
    const phone = await deps.phoneFix().catch(() => null);
    return {
        position: phoneUsable(phone) ? fromPhone(phone, deps.now(), false) : null,
        boatSilent,
        laneSogKts: null,
        laneCogDeg: null,
        phone: phoneUsable(phone) ? phone : null,
    };
}

export interface InstrumentContext {
    seaTempC: number | null;
    waterDepthM: number | null;
    depthReference: DepthReference | null;
    windSpeedKts: number | null;
    windDirDeg: number | null;
    sogKts: number | null;
    cogDeg: number | null;
    headingDeg: number | null;
    gpsAccuracyM: number | null;
}

const DEPTH_REFERENCES: ReadonlySet<string> = new Set(['below-transducer', 'below-waterline', 'below-keel']);

/** Fresh instrument values, range-checked to the table. */
export function readInstruments(state: InstrumentState | null, now: number): InstrumentContext {
    if (!state) {
        return {
            seaTempC: null,
            waterDepthM: null,
            depthReference: null,
            windSpeedKts: null,
            windDirDeg: null,
            sogKts: null,
            cogDeg: null,
            headingDeg: null,
            gpsAccuracyM: null,
        };
    }
    const depth = inRange(freshValue(state.depth, now), 0, 12_000);
    const tws = inRange(freshValue(state.tws, now), 0, 200, 1);
    const twd = bearing(freshValue(state.twd, now));
    return {
        seaTempC: inRange(freshValue(state.waterTemp, now), -3, 40, 1),
        waterDepthM: depth,
        depthReference:
            depth !== null && state.depthReference && DEPTH_REFERENCES.has(state.depthReference)
                ? state.depthReference
                : null,
        // Wind goes in as a pair or not at all.
        windSpeedKts: tws !== null && twd !== null ? tws : null,
        windDirDeg: tws !== null && twd !== null ? twd : null,
        sogKts: inRange(freshValue(state.sog, now), 0, 80, 1),
        cogDeg: bearing(freshValue(state.cog, now)),
        headingDeg: bearing(freshValue(state.headingTrue, now) ?? freshValue(state.heading, now)),
        gpsAccuracyM: inRange(freshValue(state.gpsAccuracyM, now), 0.1, 100_000, 1),
    };
}

export interface WeatherContext {
    seaTempC: number | null;
    windSpeedKts: number | null;
    windDirDeg: number | null;
    waveHeightM: number | null;
    model: string | null;
}

const NO_WEATHER: WeatherContext = {
    seaTempC: null,
    windSpeedKts: null,
    windDirDeg: null,
    waveHeightM: null,
    model: null,
};

/** The forecast hour for this sighting, when the report is for here and now. */
export function readWeather(
    report: WeatherSnapshot | null,
    at: { latitude: number; longitude: number; eventAt: number; now: number },
): WeatherContext {
    if (!report || !report.coordinates || !Array.isArray(report.hourly)) return NO_WEATHER;
    const { lat, lon } = report.coordinates;
    if (!validLatLon(lat, lon)) return NO_WEATHER;
    if (haversineM(lat, lon, at.latitude, at.longitude) > WEATHER_MAX_DISTANCE_M) return NO_WEATHER;
    const generated = Date.parse(report.generatedAt);
    if (!Number.isFinite(generated) || at.now - generated > WEATHER_MAX_AGE_MS || generated - at.now > 60_000) {
        return NO_WEATHER;
    }
    let best: WeatherSnapshot['hourly'][number] | null = null;
    let bestGap = Infinity;
    for (const row of report.hourly) {
        const t = Date.parse(row.time);
        if (!Number.isFinite(t)) continue;
        const gap = Math.abs(t - at.eventAt);
        if (gap < bestGap) {
            best = row;
            bestGap = gap;
        }
    }
    if (!best || bestGap > WEATHER_ROW_MAX_GAP_MS) return NO_WEATHER;
    const windSpeedKts = inRange(best.windSpeed, 0, 200, 1);
    const windDirDeg = bearing(best.windDegree);
    const waveFt = finite(best.waveHeight) ? best.waveHeight : null;
    const model =
        typeof report.modelUsed === 'string' && report.modelUsed.trim() ? report.modelUsed.trim().slice(0, 60) : null;
    const out: WeatherContext = {
        seaTempC: inRange(best.waterTemperature, -3, 40, 1),
        windSpeedKts: windSpeedKts !== null && windDirDeg !== null ? windSpeedKts : null,
        windDirDeg: windSpeedKts !== null && windDirDeg !== null ? windDirDeg : null,
        waveHeightM: waveFt === null ? null : inRange(waveFt / FEET_PER_METRE, 0, 30, 2),
        model,
    };
    const any = out.seaTempC !== null || out.windSpeedKts !== null || out.waveHeightM !== null;
    return any ? out : NO_WEATHER;
}

export interface CaptureOptions {
    /** Which boat the sighting is from, asked when the cloud lane is reached (see CloudOwner). */
    vesselOwner?: () => Promise<CloudOwner>;
}

/**
 * Capture everything for a sighting. Never throws. The position may be null
 * (no receiver answered): the caller keeps the sighting as 'needs position'.
 */
export async function captureSightingContext(
    deps: ContextDeps = defaultContextDeps(),
    options: CaptureOptions = {},
): Promise<SightingContext> {
    const capturedAt = deps.now();
    const instrumentState = await deps.instruments().catch(() => null);
    const instruments = readInstruments(instrumentState, deps.now());
    const decision = await decidePosition(deps, instruments.gpsAccuracyM, instruments.sogKts, options.vesselOwner);
    const position = decision.position;
    const ashore = position?.ashore === true;

    const context: SightingContext = {
        capturedAt,
        position,
        boatSilent: decision.boatSilent,
        samplingProtocol: ashore ? SHORE_PROTOCOL : VESSEL_PROTOCOL,
        seaTempC: null,
        seaTempSource: null,
        waterDepthM: null,
        depthReference: null,
        windSpeedKts: null,
        windDirDeg: null,
        windSource: null,
        waveHeightM: null,
        wxModel: null,
        sogKts: null,
        cogDeg: null,
        headingDeg: null,
    };

    // Ashore: the boat's instruments describe somewhere else.
    if (!ashore) {
        context.seaTempC = instruments.seaTempC;
        context.seaTempSource = instruments.seaTempC !== null ? 'instrument' : null;
        context.waterDepthM = instruments.waterDepthM;
        context.depthReference = instruments.depthReference;
        if (instruments.windSpeedKts !== null) {
            context.windSpeedKts = instruments.windSpeedKts;
            context.windDirDeg = instruments.windDirDeg;
            context.windSource = 'instrument';
        }
        context.sogKts = instruments.sogKts ?? inRange(decision.laneSogKts, 0, 80, 1);
        context.cogDeg = instruments.cogDeg ?? bearing(decision.laneCogDeg);
        context.headingDeg = instruments.headingDeg;
        if (context.sogKts === null && position?.source === 'phone' && decision.phone && finite(decision.phone.speed)) {
            context.sogKts = inRange(decision.phone.speed * KNOTS_PER_MS, 0, 80, 1);
        }
    }

    if (position) {
        const report = await deps.weather().catch(() => null);
        const wx = readWeather(report, {
            latitude: position.latitude,
            longitude: position.longitude,
            eventAt: capturedAt,
            now: deps.now(),
        });
        let usedForecast = false;
        if (context.seaTempC === null && wx.seaTempC !== null) {
            context.seaTempC = wx.seaTempC;
            context.seaTempSource = 'forecast';
            usedForecast = true;
        }
        if (context.windSpeedKts === null && wx.windSpeedKts !== null) {
            context.windSpeedKts = wx.windSpeedKts;
            context.windDirDeg = wx.windDirDeg;
            context.windSource = 'forecast';
            usedForecast = true;
        }
        if (wx.waveHeightM !== null) {
            context.waveHeightM = wx.waveHeightM;
            usedForecast = true;
        }
        context.wxModel = usedForecast ? wx.model : null;
    }

    return context;
}

/** The real receivers, loaded on first use so this module stays light. */
export function defaultContextDeps(): ContextDeps {
    return {
        now: () => Date.now(),
        async boatConfigured() {
            const { NmeaListenerService } = await import('../NmeaListenerService');
            if (NmeaListenerService.getSavedConfig()) return true;
            const { getPairing } = await import('../PiPairingService');
            return getPairing() !== null;
        },
        async busFix() {
            // NmeaStore only ingests after start(); without it the bus rung is
            // always null (hooks/chat/usePinDrop.ts). Idempotent, and a phone
            // that never met a gateway opens nothing.
            const [{ NmeaListenerService }, { NmeaStore }, chain] = await Promise.all([
                import('../NmeaListenerService'),
                import('../NmeaStore'),
                import('../boatPositionChain'),
            ]);
            if (NmeaListenerService.getSavedConfig()) NmeaStore.start();
            return chain.busFix();
        },
        async piFix(timeoutMs) {
            const { piFix } = await import('../boatPositionChain');
            return piFix(timeoutMs);
        },
        async cloudFix(owner) {
            const { cloudFix } = await import('../boatPositionChain');
            return cloudFix(Date.now(), owner);
        },
        online() {
            return typeof navigator === 'undefined' || navigator.onLine !== false;
        },
        async phoneFix() {
            const { GpsService } = await import('../GpsService');
            const pos = await GpsService.requestCurrentForegroundPosition({
                staleLimitMs: 30_000,
                timeoutSec: 10,
                enableHighAccuracy: true,
            });
            if (!pos) return null;
            return {
                latitude: pos.latitude,
                longitude: pos.longitude,
                accuracy: pos.accuracy,
                speed: finite(pos.speed) && pos.speed >= 0 ? pos.speed : null,
                heading: pos.heading,
                timestamp: pos.timestamp,
            };
        },
        async instruments() {
            const { NmeaStore } = await import('../NmeaStore');
            const s = NmeaStore.getState();
            return {
                waterTemp: s.waterTemp,
                depth: s.depth,
                depthReference: s.depthReference,
                tws: s.tws,
                twd: s.twd,
                sog: s.sog,
                cog: s.cog,
                heading: s.heading,
                headingTrue: s.headingTrue,
                gpsAccuracyM: s.gpsAccuracyM,
            };
        },
        async weather() {
            const { useWeatherStore } = await import('../../stores/weatherStore');
            return (useWeatherStore.getState().weatherData as WeatherSnapshot | null) ?? null;
        },
    };
}
