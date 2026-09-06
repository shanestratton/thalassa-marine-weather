/**
 * weatherPosition — where the weather is FOR.
 *
 * Shane, 2026-09-06, after driving to his daughter's: "the weather location
 * came with me … boat GPS followed by u-blox GPS and finally phone gps", and
 * for when the boat goes quiet: "hold her last fix. with a message of course."
 *
 * The Glass and the Obs weather layers used to follow the PHONE — the GPS
 * follower in WeatherContext, the boot path in useAppController and the
 * orchestrator's "Current Location" all went straight to the phone. A boat
 * app's weather is for the boat, so the order is now:
 *
 *   1. the boat, through services/boatPositionChain — the bus, then the Pi,
 *      whose Signal K already ranks the bus above its u-blox USB stick;
 *   2. failing that, the boat's LAST fix this device saw, held with its age on
 *      screen; when the phone is clearly somewhere else the skipper is asked
 *      once, per hold, whether they meant the boat or the phone;
 *   3. the phone, only when no boat has ever answered on this device, or when
 *      the skipper chose it for this hold.
 *
 * The phone is never read here. Whether a phone fix is acceptable is the
 * caller's decision (the same doctrine as boatFix()), so the caller passes a
 * function for it — which also keeps this module clear of every location
 * permission surface.
 */
import { busFix, piFix, type BoatFix, type BoatFixRung } from './boatPositionChain';
import { authScopedStorageKey } from './authIdentityScope';
import { haversineNM } from '../utils/gpsFollow';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WeatherPosition');

export type WeatherFixKind = 'bus' | 'pi' | 'held' | 'phone';
export type HeldChoice = 'boat' | 'phone';

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

function toWeatherFix(fix: BoatFix, kind: 'bus' | 'pi'): WeatherFix {
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

/**
 * Rungs 1 and 2, then the held fix. Never the phone.
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

/**
 * Where the weather should be for, and whether to ask.
 *
 * `mayAsk: false` is for boot and fetch paths that have no UI to ask with:
 * they hold the boat without consulting the phone, and leave the question to
 * the follower's next tick.
 */
export async function resolveWeatherPosition(
    phone: PhoneFixProvider,
    options: { now?: number; mayAsk?: boolean } = {},
): Promise<WeatherPositionResolution> {
    const now = options.now ?? Date.now();
    const mayAsk = options.mayAsk ?? true;

    const boat = await boatOrHeldFix(now);
    if (boat && boat.kind !== 'held') return { fix: boat, held: null, phone: null, ask: false };

    if (!boat) {
        const fix = await phoneFix(phone);
        return { fix, held: null, phone: fix, ask: false };
    }

    const held = boat;
    const choice = getHeldChoice(held);
    if (choice === 'boat') return { fix: held, held, phone: null, ask: false };
    if (choice === 'phone') {
        const fix = await phoneFix(phone);
        return { fix: fix ?? held, held, phone: fix, ask: false };
    }

    // No choice yet: hold the boat, and ask only when the phone is clearly elsewhere.
    const phoneNow = mayAsk ? await phoneFix(phone) : null;
    const apart = phoneNow ? haversineNM(held.lat, held.lon, phoneNow.lat, phoneNow.lon) >= ASK_DISTANCE_NM : false;
    if (apart) log.info(`Boat quiet since ${new Date(held.timestamp).toISOString()}; phone is elsewhere — asking`);
    return { fix: held, held, phone: phoneNow, ask: apart };
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
        case 'held':
            return `Boat's last fix · ${formatFixAge(now - fix.timestamp)}`;
        case 'phone':
            return 'Phone GPS';
    }
}

/** Test seam: forget the Pi throttle and the remember throttle. */
export function __resetWeatherPositionForTests(): void {
    piLastAskedAt = Number.NEGATIVE_INFINITY;
    piLastAnswer = null;
    piInFlight = null;
    lastRememberedAt = Number.NEGATIVE_INFINITY;
    lastRemembered = null;
}
