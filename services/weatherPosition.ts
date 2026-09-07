/**
 * weatherPosition — where the weather is FOR.
 *
 * Shane, 2026-09-08: "the weather should always be the punters location, BUT
 * in the saved locations, there should be one that has the vessel name as a
 * special saved location." So 'Current Location' FOLLOWS one of two things:
 *
 *   • the PHONE — the default. The punter's weather is where the punter is.
 *     The boat's receivers are only a fallback for a phone that cannot answer
 *     (no permission, no fix yet).
 *   • the BOAT — when the skipper picks her row (named after the vessel) in
 *     the saved-locations menu. Then the order is the boat's own: the bus (a
 *     gateway socket, or the Pi over the boat LAN), the Pi direct (its Signal K
 *     already ranks the bus above its u-blox stick), the Pi's cloud row (the
 *     boat seen from a distance — good for a forecast, nothing that steers),
 *     and failing all of those her LAST fix this device saw, held with its age
 *     on screen. The phone only when no boat has ever answered here.
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
import { busFix, cloudFix, piFix, type BoatFix, type BoatFixRung } from './boatPositionChain';
import { authScopedStorageKey } from './authIdentityScope';
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
let cloudLastAskedAt = 0;
let piLastAnswer: BoatFix | null = null;
let piInFlight: Promise<BoatFix | null> | null = null;
let lastRememberedAt = Number.NEGATIVE_INFINITY;
let lastRemembered: { lat: number; lon: number } | null = null;

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
    if (!validCoordinates(fix.latitude, fix.longitude)) return;
    const moved =
        !lastRemembered ||
        haversineNM(lastRemembered.lat, lastRemembered.lon, fix.latitude, fix.longitude) >= REMEMBER_MIN_MOVE_NM;
    if (!moved && now - lastRememberedAt < REMEMBER_MIN_INTERVAL_MS) return;
    const stored: StoredBoatFix = {
        lat: fix.latitude,
        lon: fix.longitude,
        timestamp: Number.isFinite(fix.timestamp) ? fix.timestamp : now,
        rung: fix.rung,
        source: fix.source ?? null,
    };
    writeJson(authScopedStorageKey(LAST_BOAT_FIX_KEY), stored);
    lastRemembered = { lat: fix.latitude, lon: fix.longitude };
    lastRememberedAt = now;
}

/** The boat's last remembered fix for this account on this device, or null. */
export function heldBoatFix(): WeatherFix | null {
    const stored = readJson<StoredBoatFix>(authScopedStorageKey(LAST_BOAT_FIX_KEY));
    if (!stored || !validCoordinates(stored.lat, stored.lon) || !Number.isFinite(stored.timestamp)) return null;
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
    if (piInFlight) return piLastAnswer;
    if (now - piLastAskedAt < PI_POLL_MS) return piLastAnswer;
    piLastAskedAt = now;
    piInFlight = piFix()
        .then((fix) => {
            piLastAnswer = fix;
            return fix;
        })
        .catch(() => null)
        .finally(() => {
            piInFlight = null;
        });
    return piInFlight;
}

async function throttledCloudFix(now: number): Promise<BoatFix | null> {
    if (cloudInFlight) return cloudLastAnswer;
    if (now - cloudLastAskedAt < CLOUD_POLL_MS) return cloudLastAnswer;
    cloudLastAskedAt = now;
    cloudInFlight = Promise.resolve()
        .then(() => cloudFix(now))
        .then((fix) => {
            cloudLastAnswer = fix;
            return fix;
        })
        .catch(() => null)
        .finally(() => {
            cloudInFlight = null;
        });
    return cloudInFlight;
}

/**
 * The boat's receivers, then her cloud row, then the held fix. Never the phone.
 *
 * A live boat answer also ends any standing boat-or-phone choice: she is
 * reporting again, so the weather goes back to her.
 */
export async function boatOrHeldFix(now = Date.now()): Promise<WeatherFix | null> {
    const bus = busFix();
    if (bus) {
        rememberBoatFix(bus, now);
        clearHeldChoice();
        return toWeatherFix(bus, 'bus');
    }
    const pi = await throttledPiFix(now);
    if (pi) {
        rememberBoatFix(pi, now);
        clearHeldChoice();
        return toWeatherFix(pi, 'pi');
    }
    const cloud = await throttledCloudFix(now);
    if (cloud) {
        rememberBoatFix(cloud, now);
        clearHeldChoice();
        return toWeatherFix(cloud, 'cloud');
    }
    return heldBoatFix();
}

async function phoneFix(provider: PhoneFixProvider): Promise<WeatherFix | null> {
    try {
        const fix = await provider();
        if (!fix || !validCoordinates(fix.lat, fix.lon)) return null;
        return {
            lat: fix.lat,
            lon: fix.lon,
            timestamp: Number.isFinite(fix.timestamp) ? fix.timestamp : Date.now(),
            kind: 'phone',
        };
    } catch {
        return null;
    }
}

/** The follow target for this account on this device. The phone until the skipper picks the boat. */
export function getWeatherFollowTarget(): WeatherFollowTarget {
    try {
        return storage()?.getItem(authScopedStorageKey(FOLLOW_TARGET_KEY)) === 'boat' ? 'boat' : 'phone';
    } catch {
        return 'phone';
    }
}

export function setWeatherFollowTarget(target: WeatherFollowTarget): void {
    try {
        storage()?.setItem(authScopedStorageKey(FOLLOW_TARGET_KEY), target);
    } catch {
        /* storage unavailable — the in-session follower still honours the next tick's read */
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
        // The punter's weather is where the punter is. Her receivers are only
        // a fallback for a phone that cannot answer.
        const fix = await phoneFix(phone);
        if (fix) return { fix, held: null, phone: fix, ask: false };
        const boat = await boatOrHeldFix(now);
        return { fix: boat, held: boat?.kind === 'held' ? boat : null, phone: null, ask: false };
    }

    // The skipper picked the boat: her receivers, her cloud row, then her held
    // last fix with its age. The phone only when no boat has ever answered here.
    const boat = await boatOrHeldFix(now);
    if (boat) return { fix: boat, held: boat.kind === 'held' ? boat : null, phone: null, ask: false };
    const fix = await phoneFix(phone);
    return { fix, held: null, phone: fix, ask: false };
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
): string {
    if (!fix) return 'No position';
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
    cloudInFlight = null;
    cloudLastAnswer = null;
    cloudLastAskedAt = 0;
    piLastAskedAt = Number.NEGATIVE_INFINITY;
    piLastAnswer = null;
    piInFlight = null;
    lastRememberedAt = Number.NEGATIVE_INFINITY;
    lastRemembered = null;
}
