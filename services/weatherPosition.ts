/**
 * weatherPosition — where the weather is FOR.
 *
 * Shane, 2026-09-08: "the weather should always be the punters location, BUT
 * in the saved locations, there should be one that has the vessel name as a
 * special saved location." So 'Current Location' FOLLOWS one of two things:
 *
 *   • the PHONE — the default. The punter's weather is where the punter is.
 *     No permission or no fix means PHONE unavailable, never the boat.
 *   • the BOAT — when the skipper picks her row (named after the vessel) in
 *     the saved-locations menu. Then the order is the boat's own: the bus (a
 *     gateway socket, or the Pi over the boat LAN), the Pi direct (its Signal K
 *     already ranks the bus above its u-blox stick), the Pi's cloud row (the
 *     boat seen from a distance — good for a forecast, nothing that steers),
 *     and failing all of those her LAST fix this device saw, held with its age
 *     on screen. No boat fix means BOAT unavailable, never the phone.
 *
 * History: 2026-09-06 made the boat the default after the forecast drove to
 * Shane's daughter's with his phone ("hold her last fix. with a message of
 * course"); 2026-09-08 turned that into a choice the skipper makes in the
 * menu instead of a question the app asks. Nothing here asks any more — the
 * boat-or-phone dialog survives only as a way to switch from the ℹ panel
 * while a held fix is on screen, and its answer sets the same follow target.
 *
 * The phone is never read here. Whether a phone fix is acceptable is the
 * caller's decision (the same doctrine as boatFix()), so the caller passes a
 * function for it — which also keeps this module clear of every location
 * permission surface.
 */
import { busFix, cloudFix, piFix, CLOUD_FIX_MAX_AGE_MS, type BoatFix, type BoatFixRung } from './boatPositionChain';
import { authScopedStorageKey, getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import { NMEA_USABLE_MAX_AGE_MS } from './nmea/nmeaCadence';
import { haversineNM } from '../utils/gpsFollow';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WeatherPosition');

export type WeatherFixKind = 'bus' | 'pi' | 'cloud' | 'held' | 'phone';
export type HeldChoice = 'boat' | 'phone';
/** What 'Current Location' follows: the punter's phone (default) or the boat. */
export type WeatherFollowTarget = 'phone' | 'boat';

export interface WeatherFix {
    lat: number;
    lon: number;
    /** When the receiver produced the fix — for a held fix, how old it is. */
    timestamp: number;
    kind: WeatherFixKind;
    /** The receiver behind a boat or held fix. */
    rung?: BoatFixRung;
    /** Signal K's source id when the Pi answered, e.g. 'ublox-gps.GP'. */
    source?: string | null;
}

/** What the caller's phone provider returns. */
export interface PhoneFix {
    lat: number;
    lon: number;
    timestamp: number;
}
export type PhoneFixProvider = () => Promise<PhoneFix | null>;

export interface WeatherPositionResolution {
    /** Where the weather should be for; null when nothing at all can answer. */
    fix: WeatherFix | null;
    /** The boat's last fix, when the boat is quiet and one is remembered. */
    held: WeatherFix | null;
    /** The phone's fix, when it was consulted. */
    phone: WeatherFix | null;
    /**
     * True when the skipper should be asked boat-or-phone: the boat is quiet,
     * the phone is clearly somewhere else, and no choice stands for this hold.
     */
    ask: boolean;
}

/** Aboard, the phone and the boat agree; only ask when they are clearly apart. */
export const ASK_DISTANCE_NM = 2;
/** The follower ticks every 5 s; the Pi over the tailnet is asked at most this often. */
export const PI_POLL_MS = 30_000;
/** A cached phone fix is useful for weather, but must not be called current after this. */
export const PHONE_FIX_MAX_AGE_MS = 60_000;
/** Matches the Pi GPS endpoint's receiver freshness contract. */
const PI_FIX_MAX_AGE_MS = 60_000;
const FUTURE_FIX_TOLERANCE_MS = 5_000;
/** The remembered fix is rewritten no more often than this unless the boat has moved. */
export const REMEMBER_MIN_INTERVAL_MS = 60_000;
export const REMEMBER_MIN_MOVE_NM = 0.02;

const LAST_BOAT_FIX_KEY = 'thalassa_weather_last_boat_fix';
const HELD_CHOICE_KEY = 'thalassa_weather_held_choice';
const FOLLOW_TARGET_KEY = 'thalassa_weather_follow_target';
/** Fired on this window when the follow target changes; detail: { target }. */
export const WEATHER_FOLLOW_TARGET_EVENT = 'thalassa:weather-follow-target-changed';

interface StoredBoatFix {
    lat: number;
    lon: number;
    timestamp: number;
    rung: BoatFixRung;
    source?: string | null;
}

/** Bound to the fix it answered for: a newer boat fix makes the question fresh. */
interface StoredChoice {
    choice: HeldChoice;
    heldTimestamp: number;
}

let piLastAskedAt = Number.NEGATIVE_INFINITY;
/** The cloud row is asked at most this often; the boat does not move far in half a minute. */
export const CLOUD_POLL_MS = 30_000;
let cloudInFlight: Promise<BoatFix | null> | null = null;
let cloudLastAnswer: BoatFix | null = null;
let cloudLastAskedAt = Number.NEGATIVE_INFINITY;
let piLastAnswer: BoatFix | null = null;
let piInFlight: Promise<BoatFix | null> | null = null;
let lastRememberedAt = Number.NEGATIVE_INFINITY;
let lastRemembered: { lat: number; lon: number } | null = null;
let cacheScope = getAuthIdentityScope();
let sessionFollowTarget: WeatherFollowTarget | null = null;
let sessionTargetNeedsPersistence = false;

function resetCaches(): void {
    cloudInFlight = null;
    cloudLastAnswer = null;
    cloudLastAskedAt = Number.NEGATIVE_INFINITY;
    piLastAskedAt = Number.NEGATIVE_INFINITY;
    piLastAnswer = null;
    piInFlight = null;
    lastRememberedAt = Number.NEGATIVE_INFINITY;
    lastRemembered = null;
    sessionFollowTarget = null;
    sessionTargetNeedsPersistence = false;
}

/** Persisted keys alone cannot isolate the in-flight and throttled answers. */
function ensureCacheScope(): void {
    if (isAuthIdentityScopeCurrent(cacheScope)) return;
    resetCaches();
    cacheScope = getAuthIdentityScope();
}

function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

function readJson<T>(key: string): T | null {
    try {
        const raw = storage()?.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        storage()?.setItem(key, JSON.stringify(value));
    } catch {
        /* No storage — the hold simply will not survive a relaunch. */
    }
}

function validCoordinates(lat: unknown, lon: unknown): lat is number {
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
    );
}

function validTimestamp(timestamp: number, now: number): boolean {
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + FUTURE_FIX_TOLERANCE_MS;
}

/** Old versions stored phone-uploaded cloud rows under the boat key. Refuse those on read too. */
function isBoatReceiver(fix: Pick<BoatFix, 'rung' | 'source'>): boolean {
    if (fix.rung !== 'bus' && fix.rung !== 'pi' && fix.rung !== 'cloud') return false;
    if (fix.rung === 'cloud') return fix.source === 'pi-cloud';
    return !/(?:^|[\s.:_/-])(?:phone|device|mobile|geolocation|browser)(?:$|[\s.:_/-])/i.test(fix.source ?? '');
}

function usableBoatFix(fix: BoatFix | null, now: number): fix is BoatFix {
    if (!fix || !isBoatReceiver(fix) || !validCoordinates(fix.latitude, fix.longitude)) return false;
    if (!validTimestamp(fix.timestamp, now)) return false;
    const maxAge =
        fix.rung === 'bus' ? NMEA_USABLE_MAX_AGE_MS : fix.rung === 'cloud' ? CLOUD_FIX_MAX_AGE_MS : PI_FIX_MAX_AGE_MS;
    return now - fix.timestamp <= maxAge;
}

function toWeatherFix(fix: BoatFix, kind: 'bus' | 'pi' | 'cloud'): WeatherFix {
    return {
        lat: fix.latitude,
        lon: fix.longitude,
        timestamp: fix.timestamp,
        kind,
        rung: fix.rung,
        source: fix.source ?? null,
    };
}

/** Keep the boat's latest fix for the day she goes quiet. Throttled: a moving boat rewrites, a still one does not. */
export function rememberBoatFix(fix: BoatFix, now = Date.now()): void {
    ensureCacheScope();
    if (!isBoatReceiver(fix) || !validCoordinates(fix.latitude, fix.longitude) || !validTimestamp(fix.timestamp, now))
        return;
    const previous = heldBoatFix(now);
    if (previous && fix.timestamp < previous.timestamp) return;
    const moved =
        !lastRemembered ||
        haversineNM(lastRemembered.lat, lastRemembered.lon, fix.latitude, fix.longitude) >= REMEMBER_MIN_MOVE_NM;
    if (!moved && now - lastRememberedAt < REMEMBER_MIN_INTERVAL_MS) return;
    const stored: StoredBoatFix = {
        lat: fix.latitude,
        lon: fix.longitude,
        timestamp: fix.timestamp,
        rung: fix.rung,
        source: fix.source ?? null,
    };
    writeJson(authScopedStorageKey(LAST_BOAT_FIX_KEY), stored);
    lastRemembered = { lat: fix.latitude, lon: fix.longitude };
    lastRememberedAt = now;
}

/** The boat's last remembered fix for this account on this device, or null. */
export function heldBoatFix(now = Date.now()): WeatherFix | null {
    const stored = readJson<StoredBoatFix>(authScopedStorageKey(LAST_BOAT_FIX_KEY));
    if (
        !stored ||
        !isBoatReceiver(stored) ||
        !validCoordinates(stored.lat, stored.lon) ||
        !validTimestamp(stored.timestamp, now)
    )
        return null;
    return {
        lat: stored.lat,
        lon: stored.lon,
        timestamp: stored.timestamp,
        kind: 'held',
        rung: stored.rung,
        source: stored.source ?? null,
    };
}

export function getHeldChoice(held: WeatherFix): HeldChoice | null {
    const stored = readJson<StoredChoice>(authScopedStorageKey(HELD_CHOICE_KEY));
    if (!stored || stored.heldTimestamp !== held.timestamp) return null;
    return stored.choice === 'phone' || stored.choice === 'boat' ? stored.choice : null;
}

export function setHeldChoice(held: WeatherFix, choice: HeldChoice): void {
    const stored: StoredChoice = { choice, heldTimestamp: held.timestamp };
    writeJson(authScopedStorageKey(HELD_CHOICE_KEY), stored);
}

export function clearHeldChoice(): void {
    try {
        storage()?.removeItem(authScopedStorageKey(HELD_CHOICE_KEY));
    } catch {
        /* nothing to clear */
    }
}

async function throttledPiFix(now: number): Promise<BoatFix | null> {
    ensureCacheScope();
    const scope = getAuthIdentityScope();
    if (piInFlight) return piInFlight;
    if (now - piLastAskedAt < PI_POLL_MS) return piLastAnswer;
    piLastAskedAt = now;
    const request = piFix()
        .then((fix) => {
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            piLastAnswer = fix;
            return fix;
        })
        .catch(() => {
            if (isAuthIdentityScopeCurrent(scope)) piLastAnswer = null;
            return null;
        })
        .finally(() => {
            if (piInFlight === request) piInFlight = null;
        });
    piInFlight = request;
    return request;
}

async function throttledCloudFix(now: number): Promise<BoatFix | null> {
    ensureCacheScope();
    const scope = getAuthIdentityScope();
    if (cloudInFlight) return cloudInFlight;
    if (now - cloudLastAskedAt < CLOUD_POLL_MS) return cloudLastAnswer;
    cloudLastAskedAt = now;
    const request = Promise.resolve()
        .then(() => cloudFix(now))
        .then((fix) => {
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            cloudLastAnswer = fix;
            return fix;
        })
        .catch(() => {
            if (isAuthIdentityScopeCurrent(scope)) cloudLastAnswer = null;
            return null;
        })
        .finally(() => {
            if (cloudInFlight === request) cloudInFlight = null;
        });
    cloudInFlight = request;
    return request;
}

/**
 * The boat's receivers, then her cloud row, then the held fix. Never the phone.
 *
 * A live boat answer also ends any standing boat-or-phone choice: she is
 * reporting again, so the weather goes back to her.
 */
export async function boatOrHeldFix(now = Date.now()): Promise<WeatherFix | null> {
    ensureCacheScope();
    const scope = getAuthIdentityScope();
    const startedAt = Date.now();
    // A request can spend seconds on the network: re-age its answer on arrival.
    const currentTime = () => now + Math.max(0, Date.now() - startedAt);
    const bus = busFix();
    if (usableBoatFix(bus, currentTime())) {
        rememberBoatFix(bus, now);
        clearHeldChoice();
        return toWeatherFix(bus, 'bus');
    }
    const pi = await throttledPiFix(now);
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    if (usableBoatFix(pi, currentTime())) {
        rememberBoatFix(pi, currentTime());
        clearHeldChoice();
        return toWeatherFix(pi, 'pi');
    }
    const cloud = await throttledCloudFix(currentTime());
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    if (usableBoatFix(cloud, currentTime())) {
        rememberBoatFix(cloud, currentTime());
        clearHeldChoice();
        return toWeatherFix(cloud, 'cloud');
    }
    // A genuine older receiver fix can still be useful, explicitly as history.
    // Never replace a newer held fix with a late response from an older lane.
    for (const fix of [bus, pi, cloud]) {
        if (fix) rememberBoatFix(fix, currentTime());
    }
    return heldBoatFix(currentTime());
}

async function phoneFix(provider: PhoneFixProvider, now: number): Promise<WeatherFix | null> {
    const scope = getAuthIdentityScope();
    const startedAt = Date.now();
    try {
        const fix = await provider();
        if (!isAuthIdentityScopeCurrent(scope) || !fix || !validCoordinates(fix.lat, fix.lon)) return null;
        if (!validTimestamp(fix.timestamp, now + Math.max(0, Date.now() - startedAt))) return null;
        return {
            lat: fix.lat,
            lon: fix.lon,
            timestamp: fix.timestamp,
            kind: 'phone',
        };
    } catch {
        return null;
    }
}

/** The follow target for this account on this device. The phone until the skipper picks the boat. */
export function getWeatherFollowTarget(): WeatherFollowTarget {
    ensureCacheScope();
    try {
        const store = storage();
        // An explicit choice still stands when storage cannot persist or read it.
        if (!store || sessionTargetNeedsPersistence) return sessionFollowTarget ?? 'phone';
        const saved = store.getItem(authScopedStorageKey(FOLLOW_TARGET_KEY));
        sessionFollowTarget = saved === 'boat' ? 'boat' : 'phone';
        return sessionFollowTarget;
    } catch {
        return sessionFollowTarget ?? 'phone';
    }
}

export function setWeatherFollowTarget(target: WeatherFollowTarget): void {
    ensureCacheScope();
    sessionFollowTarget = target;
    sessionTargetNeedsPersistence = true;
    try {
        const store = storage();
        if (store) {
            store.setItem(authScopedStorageKey(FOLLOW_TARGET_KEY), target);
            // Ordinary reads can reflect changes made by another tab. Keep the
            // session copy as well, in case reading storage fails later.
            sessionTargetNeedsPersistence = false;
        }
    } catch {
        /* The explicit in-session choice is already captured above. */
    }
    log.info(`Weather follows the ${target}`);
    try {
        window.dispatchEvent(new CustomEvent(WEATHER_FOLLOW_TARGET_EVENT, { detail: { target } }));
    } catch {
        /* non-DOM host */
    }
}

/**
 * Where the weather should be for. Never asks (`ask` is always false since
 * 2026-09-08 — the choice is the vessel's row in the saved-locations menu).
 *
 * `mayAsk` is kept on the options for the boot and fetch callers that still
 * pass it; it no longer changes anything. `target` overrides the stored one
 * (tests, and a caller that already knows what the skipper just picked).
 */
export async function resolveWeatherPosition(
    phone: PhoneFixProvider,
    options: { now?: number; mayAsk?: boolean; target?: WeatherFollowTarget } = {},
): Promise<WeatherPositionResolution> {
    const now = options.now ?? Date.now();
    const target = options.target ?? getWeatherFollowTarget();

    if (target === 'phone') {
        const fix = await phoneFix(phone, now);
        return { fix, held: null, phone: fix, ask: false };
    }

    // The skipper picked the boat: her receivers, her cloud row, then her held
    // last fix with its age. A phone fix is never a substitute for the vessel.
    const boat = await boatOrHeldFix(now);
    return { fix: boat, held: boat?.kind === 'held' ? boat : null, phone: null, ask: false };
}

/** Recompute labels as a fix ages; a stored kind alone cannot establish liveness. */
export function weatherFixStatus(
    fix: Pick<WeatherFix, 'kind' | 'timestamp'> | null,
    now = Date.now(),
): 'live' | 'last-known' | 'unavailable' {
    if (!fix || !validTimestamp(fix.timestamp, now)) return 'unavailable';
    if (fix.kind === 'held') return 'last-known';
    const maxAge =
        fix.kind === 'phone'
            ? PHONE_FIX_MAX_AGE_MS
            : fix.kind === 'bus'
              ? NMEA_USABLE_MAX_AGE_MS
              : fix.kind === 'cloud'
                ? CLOUD_FIX_MAX_AGE_MS
                : PI_FIX_MAX_AGE_MS;
    return now - fix.timestamp <= maxAge ? 'live' : 'last-known';
}

/** 'just now', '5m ago', '3h ago', '2d ago' — the same words the forecast-age pill uses. */
export function formatFixAge(ageMs: number): string {
    const seconds = Math.floor(Math.max(0, ageMs) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/** Which receiver the weather is for, in words a skipper would use. */
export function describeWeatherFix(
    fix: Pick<WeatherFix, 'kind' | 'timestamp' | 'rung' | 'source'> | null,
    now = Date.now(),
    target?: WeatherFollowTarget,
): string {
    const status = weatherFixStatus(fix, now);
    if (!fix || status === 'unavailable')
        return target ? `${target === 'phone' ? 'Phone' : 'Boat'} GPS unavailable` : 'No position';
    if (status === 'last-known') {
        return `${fix.kind === 'phone' ? "Phone's" : "Boat's"} last fix · ${formatFixAge(now - fix.timestamp)}`;
    }
    switch (fix.kind) {
        case 'bus':
            return 'Boat GPS · live';
        case 'pi':
            return `${fix.source?.toLowerCase().includes('ublox') ? 'USB GPS (Pi)' : 'Boat GPS (via Pi)'} · live`;
        case 'cloud':
            return 'Boat GPS (via cloud) · live';
        case 'held':
            return `Boat's last fix · ${formatFixAge(now - fix.timestamp)}`;
        case 'phone':
            return 'Phone GPS';
    }
}

/** Test seam: forget the Pi throttle and the remember throttle. */
export function __resetWeatherPositionForTests(): void {
    resetCaches();
    cacheScope = getAuthIdentityScope();
}
