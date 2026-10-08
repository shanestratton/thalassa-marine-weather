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
 * 2026-10-05, crew: "when a punter is invited to another yacht, in the location
 * box, instead of showing their yacht, can it instead show the yacht that they
 * are now invited to" — and "if they have gps on their boat and on the invited
 * boat, you would need to be able to check both gps postions". So a third
 * target, the CREWED boat (the 'Switch boat' selection): her own chain, never
 * the account's own boat's. Her cloud row is read by her skipper's id; the
 * phone's own receivers count for her only when the paired Pi is known to be
 * hers (deviceRungOwner). Each boat keeps her own held fix. When the crewing
 * ends the weather goes back to the account's own boat when it has one, else
 * the phone.
 *
 * The phone is never read here. Whether a phone fix is acceptable is the
 * caller's decision (the same doctrine as boatFix()), so the caller passes a
 * function for it — which also keeps this module clear of every location
 * permission surface.
 */
import {
    busFix,
    cloudFix,
    deviceRungOwner,
    piFix,
    CLOUD_FIX_MAX_AGE_MS,
    type BoatFix,
    type BoatFixRung,
} from './boatPositionChain';
import { authScopedStorageKey, getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import {
    getCrewingVessel,
    getSharedBindersState,
    listCrewVessels,
    subscribeSharedBinders,
} from './vessel/sharedBinders';
import { NMEA_USABLE_MAX_AGE_MS } from './nmea/nmeaCadence';
import { haversineNM } from '../utils/gpsFollow';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WeatherPosition');

export type WeatherFixKind = 'bus' | 'pi' | 'cloud' | 'held' | 'phone';
export type HeldChoice = 'boat' | 'phone';
/** What 'Current Location' follows: the punter's phone (default), their own boat, or the boat they crew on. */
export type WeatherFollowTarget = 'phone' | 'boat' | 'crew';

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
    /**
     * What the lane carries beside the position, for the own-ship marker
     * (the cloud row has them; the bus is read from the instrument store, and
     * a held fix keeps none). Absent when the lane did not say.
     */
    sogKts?: number;
    cogDeg?: number;
    /** When the receiver sampled the position, never later than `timestamp`. */
    positionAt?: number;
    headingTrueDeg?: number;
    headingTrueAt?: number;
    /**
     * Her TRUE wind, when the lane carries it (the cloud row does), for Obs's
     * close-in wind ashore: knots, degrees true, the angle signed. Each only
     * when in range; `windSampleAt` is the Pi's own TWS sample time, and a
     * wind without it is not dated (components/map/closeInWind pickCloudTrueWind).
     */
    twsKts?: number;
    twdDeg?: number;
    twaDeg?: number;
    windSampleAt?: number;
    /** The Pi's own TWD sample time; absent from an older Pi (closeInWind pickCloudTrueWind). */
    twdSampleAt?: number;
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
/** Beside FOLLOW_TARGET_KEY = 'crew': whose boat, and where the weather goes when the crewing ends. */
const FOLLOW_CREW_KEY = 'thalassa_weather_follow_crew';
/**
 * Fired on this window when the followed receiver changes; detail: { target,
 * key } (see getWeatherFollowKey), plus reason 'binders' when no pick did it.
 */
export const WEATHER_FOLLOW_TARGET_EVENT = 'thalassa:weather-follow-target-changed';

/** The crewed boat followed: her skipper's id, and the target to fall back to. */
export interface CrewFollow {
    ownerId: string;
    fallback: 'boat' | 'phone';
}

interface StoredBoatFix {
    lat: number;
    lon: number;
    timestamp: number;
    rung: BoatFixRung;
    source?: string | null;
    /** Whose fix: 'own', or the skipper's id for a crewed boat. Absent on fixes kept before 2026-10-05. */
    boat?: string;
}

/** Bound to the fix it answered for: a newer boat fix makes the question fresh. */
interface StoredChoice {
    choice: HeldChoice;
    heldTimestamp: number;
}

let piLastAskedAt = Number.NEGATIVE_INFINITY;
/** The cloud row is asked at most this often; the boat does not move far in half a minute. */
export const CLOUD_POLL_MS = 30_000;
/** Each boat's cloud row on its own throttle, keyed '' for the own boat and the skipper's id for a crewed one. */
interface CloudLane {
    inFlight: Promise<BoatFix | null> | null;
    answer: BoatFix | null;
    askedAt: number;
}
const cloudLanes = new Map<string, CloudLane>();
let piLastAnswer: BoatFix | null = null;
let piInFlight: Promise<BoatFix | null> | null = null;
/** The remember throttle, per boat (same keys as cloudLanes). */
const remembered = new Map<string, { at: number; lat: number; lon: number }>();
let cacheScope = getAuthIdentityScope();
let sessionFollowTarget: WeatherFollowTarget | null = null;
let sessionCrewFollow: CrewFollow | null = null;
let sessionTargetNeedsPersistence = false;
/** The followed receiver last seen on this account (getWeatherFollowKey), for announcing a Switch boat. */
let followSeen: { scope: string; key: string } | null = null;

function resetCaches(): void {
    cloudLanes.clear();
    piLastAskedAt = Number.NEGATIVE_INFINITY;
    piLastAnswer = null;
    piInFlight = null;
    remembered.clear();
    sessionFollowTarget = null;
    sessionCrewFollow = null;
    sessionTargetNeedsPersistence = false;
    followSeen = null;
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

const finite = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);

function toWeatherFix(fix: BoatFix, kind: 'bus' | 'pi' | 'cloud'): WeatherFix {
    const out: WeatherFix = {
        lat: fix.latitude,
        lon: fix.longitude,
        timestamp: fix.timestamp,
        kind,
        rung: fix.rung,
        source: fix.source ?? null,
    };
    // Only what the lane said: a missing speed is unknown, never 0.
    if (finite(fix.sogKts) && fix.sogKts >= 0) out.sogKts = fix.sogKts;
    if (finite(fix.cogDeg) && fix.cogDeg >= 0 && fix.cogDeg < 360) out.cogDeg = fix.cogDeg;
    if (finite(fix.positionAt) && fix.positionAt > 0) out.positionAt = Math.min(fix.positionAt, fix.timestamp);
    if (
        finite(fix.headingTrueDeg) &&
        fix.headingTrueDeg >= 0 &&
        fix.headingTrueDeg < 360 &&
        finite(fix.headingTrueAt)
    ) {
        out.headingTrueDeg = fix.headingTrueDeg;
        out.headingTrueAt = fix.headingTrueAt;
    }
    // The wind as the lane said it, each value only in range; a missing one stays unknown.
    if (finite(fix.twsKts) && fix.twsKts >= 0 && fix.twsKts <= 150) out.twsKts = fix.twsKts;
    if (finite(fix.twdDeg) && fix.twdDeg >= 0 && fix.twdDeg < 360) out.twdDeg = fix.twdDeg;
    if (finite(fix.twaDeg) && fix.twaDeg >= -180 && fix.twaDeg <= 180) out.twaDeg = fix.twaDeg;
    if (finite(fix.windSampleAt) && fix.windSampleAt > 0) out.windSampleAt = fix.windSampleAt;
    if (finite(fix.twdSampleAt) && fix.twdSampleAt > 0) out.twdSampleAt = fix.twdSampleAt;
    return out;
}

/**
 * Where a boat's last fix is kept. The own boat keeps the key it always had
 * (already per account), so a fix held before 2026-10-05 stays hers; a crewed
 * boat's is keyed by her skipper's id.
 */
function heldFixKey(crewOwnerId: string | null): string {
    return authScopedStorageKey(crewOwnerId ? `${LAST_BOAT_FIX_KEY}:crew:${crewOwnerId}` : LAST_BOAT_FIX_KEY);
}

/**
 * Keep the boat's latest fix for the day she goes quiet. Throttled: a moving boat rewrites, a still one does not.
 * `crewOwnerId` names a crewed boat; null is the account's own.
 */
export function rememberBoatFix(fix: BoatFix, now = Date.now(), crewOwnerId: string | null = null): void {
    ensureCacheScope();
    if (!isBoatReceiver(fix) || !validCoordinates(fix.latitude, fix.longitude) || !validTimestamp(fix.timestamp, now))
        return;
    const previous = heldBoatFix(now, crewOwnerId);
    if (previous && fix.timestamp < previous.timestamp) return;
    const last = remembered.get(crewOwnerId ?? '');
    const moved = !last || haversineNM(last.lat, last.lon, fix.latitude, fix.longitude) >= REMEMBER_MIN_MOVE_NM;
    if (!moved && now - last.at < REMEMBER_MIN_INTERVAL_MS) return;
    const stored: StoredBoatFix = {
        lat: fix.latitude,
        lon: fix.longitude,
        timestamp: fix.timestamp,
        rung: fix.rung,
        source: fix.source ?? null,
        boat: crewOwnerId ?? 'own',
    };
    writeJson(heldFixKey(crewOwnerId), stored);
    remembered.set(crewOwnerId ?? '', { at: now, lat: fix.latitude, lon: fix.longitude });
}

/** The boat's last remembered fix for this account on this device, or null (`crewOwnerId`: a crewed boat). */
export function heldBoatFix(now = Date.now(), crewOwnerId: string | null = null): WeatherFix | null {
    const key = heldFixKey(crewOwnerId);
    const stored = readJson<StoredBoatFix>(key);
    // Before 2026-10-05 an account that crewed could keep its skipper's
    // position here (her cloud row, her Pi), so an unmarked fix is only the
    // own boat's for an account that crews nowhere. Dropped, not just skipped,
    // so it cannot pass as hers once the crewing ends.
    if (stored && !crewOwnerId && stored.boat === undefined && listCrewVessels().length > 0) {
        try {
            storage()?.removeItem(key);
        } catch {
            /* unreadable storage keeps nothing anyway */
        }
        return null;
    }
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

async function throttledCloudFix(now: number, crewOwnerId: string | null): Promise<BoatFix | null> {
    ensureCacheScope();
    const scope = getAuthIdentityScope();
    const key = crewOwnerId ?? '';
    const lane = cloudLanes.get(key) ?? { inFlight: null, answer: null, askedAt: Number.NEGATIVE_INFINITY };
    cloudLanes.set(key, lane);
    if (lane.inFlight) return lane.inFlight;
    if (now - lane.askedAt < CLOUD_POLL_MS) return lane.answer;
    lane.askedAt = now;
    const request = Promise.resolve()
        // The own boat reads strictly her own row: crewing elsewhere must never
        // lend her a skipper's position. A crewed boat reads her skipper's.
        .then(() => cloudFix(now, crewOwnerId ?? 'self'))
        .then((fix) => {
            if (!isAuthIdentityScopeCurrent(scope)) return null;
            lane.answer = fix;
            return fix;
        })
        .catch(() => {
            if (isAuthIdentityScopeCurrent(scope)) lane.answer = null;
            return null;
        })
        .finally(() => {
            if (lane.inFlight === request) lane.inFlight = null;
        });
    lane.inFlight = request;
    return request;
}

/**
 * Whether the phone's own receivers (the bus, the paired Pi) are this boat's.
 * A crewed boat takes them only when they are known to be hers. The own boat
 * takes them as she always has, unless they are known to be a boat this
 * account crews on.
 */
function devicesAreHers(rung: 'bus' | 'pi', crewOwnerId: string | null): boolean {
    const owner = deviceRungOwner(rung);
    if (crewOwnerId) return owner === crewOwnerId;
    return !owner || !listCrewVessels().some((vessel) => vessel.ownerId === owner);
}

/**
 * The boat's receivers, then her cloud row, then the held fix. Never the phone.
 * `crewOwnerId` names a boat this account crews on; null is the account's own.
 *
 * A live boat answer also ends any standing boat-or-phone choice: she is
 * reporting again, so the weather goes back to her. `readOnly` (the ★ menu's
 * look at a boat not being followed) keeps no fix and ends no choice.
 */
export async function boatOrHeldFix(
    now = Date.now(),
    crewOwnerId: string | null = null,
    options: { readOnly?: boolean } = {},
): Promise<WeatherFix | null> {
    ensureCacheScope();
    const scope = getAuthIdentityScope();
    const startedAt = Date.now();
    // A request can spend seconds on the network: re-age its answer on arrival.
    const currentTime = () => now + Math.max(0, Date.now() - startedAt);
    // While the account crews anywhere, a receiver that names no boat may be
    // the skipper's: shown for the own boat as always, never kept as hers.
    const unnamed = (rung: 'bus' | 'pi') => !crewOwnerId && !deviceRungOwner(rung) && listCrewVessels().length > 0;
    const keep = (fix: BoatFix, at: number, device?: 'bus' | 'pi') => {
        if (options.readOnly || (device && unnamed(device))) return;
        rememberBoatFix(fix, at, crewOwnerId);
    };
    const live = (fix: BoatFix, at: number, kind: 'bus' | 'pi' | 'cloud') => {
        keep(fix, at, kind === 'cloud' ? undefined : kind);
        if (!options.readOnly) clearHeldChoice();
        return toWeatherFix(fix, kind);
    };
    const bus = devicesAreHers('bus', crewOwnerId) ? busFix() : null;
    if (usableBoatFix(bus, currentTime())) return live(bus, now, 'bus');
    const pi = devicesAreHers('pi', crewOwnerId) ? await throttledPiFix(now) : null;
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    if (usableBoatFix(pi, currentTime())) return live(pi, currentTime(), 'pi');
    const cloud = await throttledCloudFix(currentTime(), crewOwnerId);
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    if (usableBoatFix(cloud, currentTime())) return live(cloud, currentTime(), 'cloud');
    // A genuine older receiver fix can still be useful, explicitly as history.
    // Never replace a newer held fix with a late response from an older lane.
    if (bus) keep(bus, currentTime(), 'bus');
    if (pi) keep(pi, currentTime(), 'pi');
    if (cloud) keep(cloud, currentTime());
    return heldBoatFix(currentTime(), crewOwnerId);
}

/**
 * The boat's position as this device knows it right now, asking no one: her
 * bus when the receivers are hers, else the Pi's and her cloud row's latest
 * throttled answers, else (with `held`) her held last fix. Never the phone.
 * Keeps nothing and ends no choice. For a first frame and for cheap re-checks
 * (Obs builds its map before any request could answer); boatOrHeldFix is the
 * lookup. `crewOwnerId` names a crewed boat; null is the account's own.
 */
export function boatFixNow(
    now = Date.now(),
    crewOwnerId: string | null = null,
    options: { held?: boolean } = {},
): WeatherFix | null {
    ensureCacheScope();
    const bus = devicesAreHers('bus', crewOwnerId) ? busFix() : null;
    if (usableBoatFix(bus, now)) return toWeatherFix(bus, 'bus');
    const pi = devicesAreHers('pi', crewOwnerId) ? piLastAnswer : null;
    if (usableBoatFix(pi, now)) return toWeatherFix(pi, 'pi');
    const cloud = cloudLanes.get(crewOwnerId ?? '')?.answer ?? null;
    if (usableBoatFix(cloud, now)) return toWeatherFix(cloud, 'cloud');
    return options.held === false ? null : heldBoatFix(now, crewOwnerId);
}

/**
 * The boat's cloud row as this device last read it, asking no one, or null
 * when it is not usable now. For the own-ship marker's speed while the Pi lane
 * (/api/gps carries no speed or course) is the one answering.
 */
export function boatCloudRowNow(now = Date.now(), crewOwnerId: string | null = null): WeatherFix | null {
    ensureCacheScope();
    const cloud = cloudLanes.get(crewOwnerId ?? '')?.answer ?? null;
    return usableBoatFix(cloud, now) ? toWeatherFix(cloud, 'cloud') : null;
}

/** Read the boat's cloud row once, on the chain's own 30 s throttle; keeps no fix and ends no choice. */
export async function lookUpBoatCloudRow(now = Date.now(), crewOwnerId: string | null = null): Promise<void> {
    await throttledCloudFix(now, crewOwnerId);
}

/** The boat the location box follows: null for the phone, else the crewed boat's skipper (null = the own boat). */
function followedBoat(): { crewOwnerId: string | null } | null {
    const follow = currentFollow();
    if (follow.target === 'phone' || (follow.target === 'crew' && !follow.crewOwnerId)) return null;
    return { crewOwnerId: follow.crewOwnerId };
}

/**
 * The followed boat's cloud row as this device last read it, asking no one;
 * null while the box follows the phone, or when her row is not usable now
 * (older than CLOUD_FIX_MAX_AGE_MS). Her own row for the own boat, her
 * skipper's for the boat crewed on: never another boat's. For Obs's close-in
 * wind ashore (Shane 2026-10-07: "when you use your vessel as your location,
 * the wind in obs at zoom 14 no longer uses the vessels wind data, even if it
 * knows it"), where nothing feeds the instrument store.
 */
export function followedBoatCloudRowNow(now = Date.now()): WeatherFix | null {
    const boat = followedBoat();
    return boat ? boatCloudRowNow(now, boat.crewOwnerId) : null;
}

/**
 * Read the followed boat's cloud row once, on the chain's shared 30 s throttle
 * (the camera and the marker read the same lane, so together they cost one
 * read per 30 s). Keeps no fix and ends no choice. Following the phone: nothing.
 */
export async function lookUpFollowedBoatCloudRow(now = Date.now()): Promise<void> {
    const boat = followedBoat();
    if (boat) await lookUpBoatCloudRow(now, boat.crewOwnerId);
}

/** The instrument feed, as NmeaStore describes it. */
export interface InstrumentFeedState {
    connectionStatus: string;
    remote: { via: 'lan' | 'cloud' } | null;
}

/**
 * Whether the instruments the store holds are the followed boat's (Shane
 * 2026-10-06: "if the punter selects wind and there is a metric for it, it
 * should show the vessels wind equipment"). Only while 'Current Location'
 * follows a boat, and only her own receivers, as her position chain takes
 * them: a gateway socket or the Pi over the boat LAN when they are hers, or
 * the cloud row when it is hers (`cloudOwnerId`: the owner of the row that
 * fed the store; the store prefers the account's own row, so while crewing it
 * may be the other boat's). Following the phone, never.
 */
export function followedBoatOwnsInstruments(feed: InstrumentFeedState, cloudOwnerId: string | null): boolean {
    const follow = currentFollow();
    if (follow.target === 'phone' || (follow.target === 'crew' && !follow.crewOwnerId)) return false;
    if (feed.connectionStatus === 'connected') return devicesAreHers('bus', follow.crewOwnerId);
    if (feed.connectionStatus !== 'remote' || !feed.remote) return false;
    if (feed.remote.via === 'lan') return devicesAreHers('pi', follow.crewOwnerId);
    const hers = follow.crewOwnerId ?? getAuthIdentityScope().userId;
    return Boolean(cloudOwnerId && hers && cloudOwnerId === hers);
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

function storedFollowTarget(): WeatherFollowTarget {
    try {
        const store = storage();
        // An explicit choice still stands when storage cannot persist or read it.
        if (!store || sessionTargetNeedsPersistence) return sessionFollowTarget ?? 'phone';
        const saved = store.getItem(authScopedStorageKey(FOLLOW_TARGET_KEY));
        sessionFollowTarget = saved === 'boat' || saved === 'crew' ? saved : 'phone';
        return sessionFollowTarget;
    } catch {
        return sessionFollowTarget ?? 'phone';
    }
}

function storedCrewFollow(): CrewFollow | null {
    if (sessionTargetNeedsPersistence) return sessionCrewFollow;
    const stored = readJson<Partial<CrewFollow>>(authScopedStorageKey(FOLLOW_CREW_KEY));
    if (!stored || typeof stored.ownerId !== 'string' || !stored.ownerId) return sessionCrewFollow;
    return { ownerId: stored.ownerId, fallback: stored.fallback === 'boat' ? 'boat' : 'phone' };
}

function storeFollowTarget(target: WeatherFollowTarget, crew: CrewFollow | null): void {
    sessionFollowTarget = target;
    sessionCrewFollow = crew;
    sessionTargetNeedsPersistence = true;
    try {
        const store = storage();
        if (store) {
            store.setItem(authScopedStorageKey(FOLLOW_TARGET_KEY), target);
            if (crew) store.setItem(authScopedStorageKey(FOLLOW_CREW_KEY), JSON.stringify(crew));
            else store.removeItem(authScopedStorageKey(FOLLOW_CREW_KEY));
            // Ordinary reads can reflect changes made by another tab. Keep the
            // session copy as well, in case reading storage fails later.
            sessionTargetNeedsPersistence = false;
        }
    } catch {
        /* The explicit in-session choice is already captured above. */
    }
}

/** The shared binder snapshot has answered for this account, so "not crew" is known, not merely unloaded. */
function crewingKnown(): boolean {
    const userId = getAuthIdentityScope().userId;
    return Boolean(userId && getSharedBindersState().snapshot?.userId === userId);
}

interface FollowNow {
    target: WeatherFollowTarget;
    /** The skipper's id while the target is a crewed boat. */
    crewOwnerId: string | null;
}

const followKey = (follow: FollowNow): string =>
    follow.target === 'crew' ? `crew:${follow.crewOwnerId}` : follow.target;

/**
 * What the weather follows right now. 'crew' follows the boat the account is
 * crewing on (Switch boat moves it), the stored boat while the crewing is not
 * yet known here, and once the crewing is known to have ended, the stored
 * fallback, which is then kept.
 */
function currentFollow(): FollowNow {
    ensureCacheScope();
    const stored = storedFollowTarget();
    let follow: FollowNow = { target: stored, crewOwnerId: null };
    if (stored === 'crew') {
        const crew = storedCrewFollow();
        const crewing = getCrewingVessel();
        if (crewing) follow = { target: 'crew', crewOwnerId: crewing.ownerId };
        else if (!crewingKnown() && crew) follow = { target: 'crew', crewOwnerId: crew.ownerId };
        else {
            follow = { target: crew?.fallback ?? 'phone', crewOwnerId: null };
            if (crewingKnown()) {
                storeFollowTarget(follow.target, null);
                log.info(`Crewing ended: the weather follows the ${follow.target}`);
            }
        }
    }
    const scope = getAuthIdentityScope().key;
    if (followSeen?.scope !== scope) followSeen = { scope, key: followKey(follow) };
    return follow;
}

/** The follow target for this account on this device. The phone until the skipper picks a boat. */
export function getWeatherFollowTarget(): WeatherFollowTarget {
    return currentFollow().target;
}

/** The skipper's id of the crewed boat the weather follows, or null when it follows something else. */
export function getWeatherFollowCrewOwner(): string | null {
    return currentFollow().crewOwnerId;
}

/** 'phone', 'boat' or 'crew:<skipper id>': changes whenever the followed receiver does, Switch boat included. */
export function getWeatherFollowKey(): string {
    return followKey(currentFollow());
}

/** `reason` 'binders': Switch boat or the crewing ending moved it, not a pick. */
function announceFollowTarget(reason?: 'binders'): void {
    const follow = currentFollow();
    const key = followKey(follow);
    followSeen = { scope: getAuthIdentityScope().key, key };
    try {
        window.dispatchEvent(
            new CustomEvent(WEATHER_FOLLOW_TARGET_EVENT, { detail: { target: follow.target, key, reason } }),
        );
    } catch {
        /* non-DOM host */
    }
}

/** `crew` names the crewed boat for 'crew' (without it the stored one stands; with none, nothing changes). */
export function setWeatherFollowTarget(target: WeatherFollowTarget, crew?: CrewFollow): void {
    ensureCacheScope();
    const crewFollow = target === 'crew' ? (crew ?? storedCrewFollow()) : null;
    if (target === 'crew' && !crewFollow?.ownerId) return;
    storeFollowTarget(target, crewFollow);
    log.info(`Weather follows the ${target}`);
    announceFollowTarget();
}

// Switch boat, or the end of the crewing, changes what 'crew' follows without
// anyone picking a row: tell the weather, as a pick would.
subscribeSharedBinders(() => {
    const scope = getAuthIdentityScope().key;
    const previous = followSeen;
    const key = getWeatherFollowKey();
    if (!previous || previous.scope !== scope || previous.key === key) return;
    announceFollowTarget('binders');
});

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
    options: { now?: number; mayAsk?: boolean; target?: WeatherFollowTarget; crewOwnerId?: string | null } = {},
): Promise<WeatherPositionResolution> {
    const now = options.now ?? Date.now();
    const target = options.target ?? getWeatherFollowTarget();

    if (target === 'phone') {
        const fix = await phoneFix(phone, now);
        return { fix, held: null, phone: fix, ask: false };
    }

    // The skipper picked a boat: her receivers, her cloud row, then her held
    // last fix with its age. A phone fix is never a substitute for the vessel,
    // and one boat is never a substitute for the other.
    const crewOwnerId = target === 'crew' ? (options.crewOwnerId ?? getWeatherFollowCrewOwner()) : null;
    if (target === 'crew' && !crewOwnerId) return { fix: null, held: null, phone: null, ask: false };
    const boat = await boatOrHeldFix(now, crewOwnerId);
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
