/**
 * obsCentre — what Obs centres on while the location box follows a receiver,
 * and the one calm message it shows when that receiver has no live fix.
 *
 * Shane 2026-10-06, after testing Obs on a bus: "If the punter selects their
 * boat in the location box then it should put the vessels location in the
 * middle of the screen ... If the punter is on a duck I don't know maybe a
 * bus, then that should make no difference. But if the punter has selected
 * current location, then that should be the punters phone as centre on the
 * screen regardless of where they are. If there is no gps from their phone
 * then the last known location with a clear message telling them that."
 *
 *  · The BOAT (her row in the box, or the boat crewed on): her own chain only,
 *    the bus, the Pi, her cloud row (services/weatherPosition), then her held
 *    last fix with a message naming her and its age. Never the phone,
 *    wherever it is. The ownship arbiter (services/ownshipPosition) falls back
 *    to the phone, so Obs no longer centres through it.
 *  · CURRENT LOCATION (the phone): the phone's GPS only, then its last kept
 *    fix (services/phoneLastFix) with a message. Never the boat.
 *  · Neither has ever reported: the broad view, and a message saying whose
 *    position is missing.
 *
 * The locate button follows the box too (locateOnObs): the boat for her row
 * or the boat crewed on, the phone for the phone, and for a chosen place the
 * boat when the account has one, else the phone.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type mapboxgl from 'mapbox-gl';
import { GpsService } from '../../services/GpsService';
import { NmeaStore } from '../../services/NmeaStore';
import { LocationStore } from '../../stores/LocationStore';
import { rememberPhoneFix, storedPhoneFix } from '../../services/phoneLastFix';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { getCrewingVessel } from '../../services/vessel/sharedBinders';
import {
    PHONE_FIX_MAX_AGE_MS,
    WEATHER_FOLLOW_TARGET_EVENT,
    boatFixNow,
    boatOrHeldFix,
    getWeatherFollowCrewOwner,
    getWeatherFollowTarget,
    weatherFixStatus,
    type WeatherFix,
} from '../../services/weatherPosition';
import { SKIPPER_BOAT_FALLBACK } from '../vessel/skipperBoatFallback';

/** Whose position Obs is after: the phone, or a boat (null = the account's own, else her skipper's id). */
export type ObsSubject = { kind: 'phone' } | { kind: 'boat'; crewOwnerId: string | null };

export interface ObsFix {
    lat: number;
    lon: number;
    /** When the receiver produced it. */
    timestamp: number;
    /** A current fix; false for a last known one. */
    live: boolean;
}

/** A fresh phone read may be this old (the ownship acquisition's limit, kept). */
const PHONE_READ_MAX_AGE_MS = 30_000;
const FUTURE_FIX_TOLERANCE_MS = 5_000;

const cameraClaims = new Set<(map: mapboxgl.Map) => void>();

/**
 * Hear a flight the skipper asked for (find-boat), so the startup camera
 * treats it as the skipper taking over. Told directly rather than through the
 * flight's own camera events: Mapbox fires no movestart for a flight that
 * begins while the camera is already easing (a layer's zoom frame).
 */
export function onObsCameraClaim(listener: (map: mapboxgl.Map) => void): () => void {
    cameraClaims.add(listener);
    return () => {
        cameraClaims.delete(listener);
    };
}

function claimObsCamera(map: mapboxgl.Map): void {
    for (const listener of [...cameraClaims]) listener(map);
}

/** The broad view's centre: useMapInit's Aus + NZ box, [145, -28]. */
export const OBS_BROAD_CENTRE: [number, number] = [145, -28];

/** What 'Current Location' follows right now, as Obs reads it. */
export function obsFollowSubject(): ObsSubject {
    const target = getWeatherFollowTarget();
    if (target === 'phone') return { kind: 'phone' };
    return { kind: 'boat', crewOwnerId: target === 'crew' ? getWeatherFollowCrewOwner() : null };
}

function sameSubject(a: ObsSubject, b: ObsSubject): boolean {
    if (a.kind === 'phone' || b.kind === 'phone') return a.kind === b.kind;
    return a.crewOwnerId === b.crewOwnerId;
}

function usable(lat: number, lon: number, timestamp: number, now: number): boolean {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0) &&
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        timestamp <= now + FUTURE_FIX_TOLERANCE_MS
    );
}

// ── The phone ───────────────────────────────────────────────────

/**
 * The phone's newest fix this device holds, asking no one: GpsService's watch
 * tap (this session), then (with `stored`) the fix kept across relaunches.
 * `live` within the weather's phone budget. Both are dated by the fix itself.
 * LocationStore's GPS entry is not read: it is dated by its write, and an
 * account change re-stamps it, so an hours-old fix would pass for live (its
 * GPS writes come from the same watch tap anyway).
 */
export function phoneFixNow(now = Date.now(), options: { stored?: boolean } = {}): ObsFix | null {
    const candidates: Array<{ lat: number; lon: number; timestamp: number }> = [];
    const watched = GpsService.getLastKnownPosition();
    if (watched) candidates.push({ lat: watched.latitude, lon: watched.longitude, timestamp: watched.timestamp });
    if (options.stored !== false) {
        const kept = storedPhoneFix(now);
        if (kept) candidates.push(kept);
    }
    let best: { lat: number; lon: number; timestamp: number } | null = null;
    for (const fix of candidates) {
        if (usable(fix.lat, fix.lon, fix.timestamp, now) && (!best || fix.timestamp > best.timestamp)) best = fix;
    }
    return best ? { ...best, live: now - best.timestamp <= PHONE_FIX_MAX_AGE_MS } : null;
}

let phoneReadInFlight: Promise<ObsFix | null> | null = null;

/**
 * Ask the phone once: passive (already granted only, never a prompt), 30 s
 * stale limit, 10 s timeout. A good answer is kept as the last phone fix.
 * Shared while in flight, so the camera and the message never ask twice.
 */
export function acquirePhoneFix(): Promise<ObsFix | null> {
    if (phoneReadInFlight) return phoneReadInFlight;
    const request = (async (): Promise<ObsFix | null> => {
        try {
            const position = await GpsService.getCurrentPositionIfGranted({
                staleLimitMs: PHONE_READ_MAX_AGE_MS,
                timeoutSec: 10,
            });
            const now = Date.now();
            if (!position || !usable(position.latitude, position.longitude, position.timestamp, now)) return null;
            if (now - position.timestamp > PHONE_READ_MAX_AGE_MS) return null;
            rememberPhoneFix(position, now);
            return { lat: position.latitude, lon: position.longitude, timestamp: position.timestamp, live: true };
        } catch {
            return null;
        }
    })().finally(() => {
        if (phoneReadInFlight === request) phoneReadInFlight = null;
    });
    phoneReadInFlight = request;
    return request;
}

// ── The boat ────────────────────────────────────────────────────

function fromWeatherFix(fix: WeatherFix, now: number): ObsFix {
    return { lat: fix.lat, lon: fix.lon, timestamp: fix.timestamp, live: weatherFixStatus(fix, now) === 'live' };
}

/** The boat's position this device holds, asking no one; `held: false` for a live one only. */
export function vesselFixNow(crewOwnerId: string | null, now = Date.now(), options: { held?: boolean } = {}) {
    const fix = boatFixNow(now, crewOwnerId, options);
    return fix ? fromWeatherFix(fix, now) : null;
}

/** Ask the boat's chain (bus, Pi, cloud, then her held fix). A look: it keeps nothing and ends no choice. */
export async function lookUpVesselFix(crewOwnerId: string | null): Promise<ObsFix | null> {
    try {
        const fix = await boatOrHeldFix(Date.now(), crewOwnerId, { readOnly: true });
        return fix ? fromWeatherFix(fix, Date.now()) : null;
    } catch {
        return null;
    }
}

// ── Either ──────────────────────────────────────────────────────

/** The subject's best position right now, live or last known; `lastKnown: false` for live only. */
export function fixNow(subject: ObsSubject, now = Date.now(), options: { lastKnown?: boolean } = {}): ObsFix | null {
    const lastKnown = options.lastKnown !== false;
    const fix =
        subject.kind === 'phone'
            ? phoneFixNow(now, { stored: lastKnown })
            : vesselFixNow(subject.crewOwnerId, now, { held: lastKnown });
    return fix && (lastKnown || fix.live) ? fix : null;
}

/** Ask the subject's receivers; the best last known position when none is live. */
export async function lookUpFix(subject: ObsSubject): Promise<ObsFix | null> {
    if (subject.kind === 'boat') return lookUpVesselFix(subject.crewOwnerId);
    const fresh = await acquirePhoneFix();
    return fresh ?? phoneFixNow(Date.now());
}

/** Where Obs's map is built when the box follows a receiver: its best position, live or last known. */
export function obsFollowStartFix(now = Date.now()): ObsFix | null {
    return fixNow(obsFollowSubject(), now);
}

/** The sync re-check cadence; the boat's chain throttles its own network asks (30 s). */
export const OBS_LIVE_CHECK_MS = 5_000;
/** The phone is asked again no more often than this while it has no fix. */
export const OBS_PHONE_ASK_MS = 30_000;

/**
 * Wait for the subject's first live fix: store notifications plus a 5 s
 * re-check, and a lookup each tick for the boat (her chain throttles itself)
 * or every 30 s for the phone. Calls `onLive` once, then stops. Returns the
 * stop function.
 */
export function watchForLiveFix(subject: ObsSubject, onLive: (fix: ObsFix) => void): () => void {
    let stopped = false;
    let asking = false;
    let lastAsk = Date.now();
    const cleanups: Array<() => void> = [];
    const stop = () => {
        if (stopped) return;
        stopped = true;
        cleanups.forEach((fn) => fn());
    };
    const found = (fix: ObsFix | null) => {
        if (stopped || !fix?.live) return;
        stop();
        onLive(fix);
    };
    const check = () => found(fixNow(subject, Date.now(), { lastKnown: false }));
    const ask = () => {
        if (stopped || asking) return;
        asking = true;
        lastAsk = Date.now();
        const lookup = subject.kind === 'phone' ? acquirePhoneFix() : lookUpVesselFix(subject.crewOwnerId);
        void lookup.then(
            (fix) => {
                asking = false;
                found(fix);
            },
            () => {
                asking = false;
            },
        );
    };
    cleanups.push(subject.kind === 'phone' ? LocationStore.subscribe(check) : NmeaStore.subscribe(check));
    const timer = setInterval(() => {
        check();
        if (subject.kind === 'boat' || Date.now() - lastAsk >= OBS_PHONE_ASK_MS) ask();
    }, OBS_LIVE_CHECK_MS);
    cleanups.push(() => clearInterval(timer));
    return stop;
}

// ── The message ─────────────────────────────────────────────────

export type PhonePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface ObsCentreNotice {
    id: number;
    subject: ObsSubject;
    /** 'held': the chart shows a last known position; 'none': there has never been one. */
    state: 'held' | 'none';
    /** The last known fix's time, for 'held'. */
    at: number | null;
    /** The phone's Location permission, for the phone's 'none' copy. */
    permission: PhonePermission | null;
}

let notice: ObsCentreNotice | null = null;
let noticeSeq = 0;
/** See holdStandIn. */
let standIn: { noticeId: number; map: mapboxgl.Map; zoom: number; release: () => void } | null = null;
const noticeListeners = new Set<() => void>();

function publishNotice(next: ObsCentreNotice | null): void {
    notice = next;
    if (standIn && standIn.noticeId !== next?.id) releaseStandIn();
    for (const listener of [...noticeListeners]) listener();
}

/**
 * Show the message (replacing any other). Returns its id. The same words
 * again keep the standing message, so VoiceOver does not say them twice.
 */
export function showObsCentreNotice(
    next: Omit<ObsCentreNotice, 'id' | 'permission'> & { permission?: PhonePermission },
) {
    const permission = next.permission ?? null;
    if (
        notice &&
        sameSubject(notice.subject, next.subject) &&
        notice.state === next.state &&
        notice.at === next.at &&
        notice.permission === permission
    )
        return notice.id;
    noticeSeq += 1;
    publishNotice({ subject: next.subject, state: next.state, at: next.at, permission, id: noticeSeq });
    return noticeSeq;
}

/** Clear the message: any, one by id, or only one about `subject`. */
export function clearObsCentreNotice(which?: number | ObsSubject): void {
    if (!notice) return;
    if (typeof which === 'number' && notice.id !== which) return;
    if (typeof which === 'object' && !sameSubject(notice.subject, which)) return;
    publishNotice(null);
}

export function getObsCentreNotice(): ObsCentreNotice | null {
    return notice;
}

export function subscribeObsCentreNotice(listener: () => void): () => void {
    noticeListeners.add(listener);
    return () => {
        noticeListeners.delete(listener);
    };
}

export function useObsCentreNotice(): ObsCentreNotice | null {
    return useSyncExternalStore(subscribeObsCentreNotice, getObsCentreNotice, getObsCentreNotice);
}

// Where one account's boat or phone was is not the next account's message.
subscribeAuthIdentityScope(() => clearObsCentreNotice());

/**
 * A crewed boat's message goes once she is neither followed nor crewed on
 * (Switch boat, or the crewing ending): the words would otherwise fall back
 * to "your skipper's boat" and read as the new one.
 */
function dropStaleCrewNotice(): void {
    const crewOwnerId = notice?.subject.kind === 'boat' ? notice.subject.crewOwnerId : null;
    if (!crewOwnerId) return;
    if (crewOwnerId === getWeatherFollowCrewOwner() || crewOwnerId === getCrewingVessel()?.ownerId) return;
    publishNotice(null);
}
if (typeof window !== 'undefined') window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, dropStaleCrewNotice);

/**
 * A last known position the locate button flew to, still on screen: no
 * gesture since. Its receiver's first live fix flies there once (the startup
 * camera does the same for its own stand-in), so the chart is never left on
 * an old position after its message goes.
 */
function releaseStandIn(): void {
    const current = standIn;
    standIn = null;
    current?.release();
}

function holdStandIn(noticeId: number, map: mapboxgl.Map, zoom: number): void {
    releaseStandIn();
    const onGesture = (event: unknown) => {
        if (event && typeof event === 'object' && 'originalEvent' in event && event.originalEvent) releaseStandIn();
    };
    const events = ['movestart', 'zoomstart', 'dragstart'] as const;
    try {
        events.forEach((name) => map.on(name, onGesture));
    } catch {
        return; // the map went away meanwhile
    }
    standIn = {
        noticeId,
        map,
        zoom,
        release: () => {
            try {
                events.forEach((name) => map.off(name, onGesture));
            } catch {
                /* the map went away */
            }
        },
    };
}

/** The message's receiver is live: fly there if its stand-in is still on screen, then clear the message. */
function noticeWentLive(noticeId: number, fix: ObsFix): void {
    const held = standIn && standIn.noticeId === noticeId ? standIn : null;
    if (held) {
        releaseStandIn();
        claimObsCamera(held.map);
        try {
            held.map.flyTo({ center: [fix.lon, fix.lat], zoom: held.zoom, duration: 1200 });
        } catch {
            /* the map went away */
        }
    }
    clearObsCentreNotice(noticeId);
}

/** While Obs shows and a message is up, clear it once its receiver has a live fix again. */
export function useObsCentreNoticeWatch(enabled: boolean): void {
    const current = useObsCentreNotice();
    const id = current?.id ?? null;
    useEffect(() => {
        if (!enabled || !current) return undefined;
        const noticeId = current.id;
        const live = fixNow(current.subject, Date.now(), { lastKnown: false });
        if (live) {
            noticeWentLive(noticeId, live);
            return undefined;
        }
        return watchForLiveFix(current.subject, (fix) => noticeWentLive(noticeId, fix));
        // The id stands for the notice.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, id]);
}

// ── Words ───────────────────────────────────────────────────────

/** The boats Obs can name: the account's own, and the one it crews on. */
export interface ObsBoatNames {
    /** settings.vessel.name, or null when she has none. */
    own: string | null;
    /** The boat crewed on: her skipper's id, and her name when known. */
    crew: { ownerId: string; name: string | null } | null;
}

function boatWords(crewOwnerId: string | null, names: ObsBoatNames): { name: string | null; phrase: string } {
    if (crewOwnerId) {
        const name = names.crew?.ownerId === crewOwnerId ? names.crew.name?.trim() || null : null;
        return { name, phrase: SKIPPER_BOAT_FALLBACK };
    }
    return { name: names.own?.trim() || null, phrase: 'your boat' };
}

/** Her name, or 'your boat' / "your skipper's boat" when none is known. */
export function obsBoatLabel(crewOwnerId: string | null, names: ObsBoatNames): string {
    const { name, phrase } = boatWords(crewOwnerId, names);
    return name ?? phrase;
}

const pad = (value: number) => String(value).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A fix's age in words, on this phone's clock: 'just now', '12 min ago',
 * '3 h ago', then 'yesterday 16:40', 'Sat 16:40', '12 Sep'.
 */
export function humanFixAge(timestamp: number, now = Date.now()): string {
    const age = Math.max(0, now - timestamp);
    const minutes = Math.floor(age / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 12) return `${hours} h ago`;
    const then = new Date(timestamp);
    const today = new Date(now);
    const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((dayStart(today) - dayStart(then)) / 86_400_000);
    const clock = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
    if (days <= 0) return `today ${clock}`;
    if (days === 1) return `yesterday ${clock}`;
    if (days < 7) return `${WEEKDAYS[then.getDay()]} ${clock}`;
    return `${then.getDate()} ${MONTHS[then.getMonth()]}`;
}

/** The message, in words. */
export function obsCentreNoticeText(current: ObsCentreNotice, names: ObsBoatNames, now = Date.now()): string {
    if (current.subject.kind === 'phone') {
        if (current.state === 'held' && current.at !== null)
            return `Phone GPS unavailable · showing where you were ${humanFixAge(current.at, now)}`;
        return current.permission === 'granted'
            ? 'Phone GPS unavailable: no fix yet'
            : 'Phone GPS unavailable: allow location to centre here';
    }
    const { name, phrase } = boatWords(current.subject.crewOwnerId, names);
    if (current.state === 'held' && current.at !== null) {
        const age = humanFixAge(current.at, now);
        return name
            ? `Showing ${name}'s last known position · ${age}`
            : `Showing the last known position of ${phrase} · ${age}`;
    }
    return `No position from ${name ?? phrase} yet`;
}

// ── The locate button ───────────────────────────────────────────

/**
 * The boat find-boat looks for: the one the box follows (her row, or the boat
 * crewed on); otherwise the account's own, or the boat it crews on when it
 * has no boat of its own.
 */
export function findBoatOwner(ownBoatNamed: boolean): string | null {
    const target = getWeatherFollowTarget();
    if (target === 'crew') return getWeatherFollowCrewOwner();
    if (target === 'boat' || ownBoatNamed) return null;
    return getCrewingVessel()?.ownerId ?? null;
}

/**
 * What the locate button finds. While the box follows a receiver, that
 * receiver (Shane 2026-10-06: the boat's row "should put the vessels location
 * in the middle of the screen"; Current Location "should be the punters phone
 * as centre on the screen regardless of where they are"). A chosen place
 * follows nothing: the boat (find-boat), unless the account has no boat at
 * all (none named, none crewed on, no position of its own ever), when it is
 * the phone, as Locate me always was for a punter without a boat.
 */
export function obsLocateSubject(boxFollows: boolean, ownBoatNamed: boolean, now = Date.now()): ObsSubject {
    if (boxFollows) return obsFollowSubject();
    const crewOwnerId = findBoatOwner(ownBoatNamed);
    const hasBoat =
        getWeatherFollowTarget() !== 'phone' ||
        ownBoatNamed ||
        crewOwnerId !== null ||
        vesselFixNow(null, now) !== null;
    return hasBoat ? { kind: 'boat', crewOwnerId } : { kind: 'phone' };
}

/** What a locate did, for the button's own status line. */
export interface LocateOutcome {
    centred: boolean;
    /** Words for the status region; '' when the chart's message speaks. */
    announcement: string;
    /** Nothing found and the chart's message is about something else: the button says so on screen. */
    noFix?: boolean;
}

/**
 * The boat's network lookup may take this long before the button settles on
 * her last known fix: inside the button's own 11 s no-fix line, so the button
 * never says "not moved" before a late flight.
 */
export const LOCATE_LOOKUP_DEADLINE_MS = 10_000;

let locateSeq = 0;

function withDeadline<T>(lookup: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([lookup, late]).finally(() => clearTimeout(timer));
}

/** A message about another receiver whose stand-in is still on screen keeps its place. */
function noticeAboutOther(subject: ObsSubject): boolean {
    return notice !== null && !sameSubject(notice.subject, subject);
}

/**
 * Show the button's message. When the same words were already standing (so
 * the chip says nothing new), they are the button's own words for this tap.
 */
function showForTap(next: Parameters<typeof showObsCentreNotice>[0], names: ObsBoatNames) {
    const before = notice?.id ?? null;
    const id = showObsCentreNotice(next);
    const standing = id === before && notice ? obsCentreNoticeText(notice, names) : '';
    return { id, standing };
}

function flyFor(map: mapboxgl.Map, to: ObsFix, zoom: number): boolean {
    claimObsCamera(map);
    try {
        map.flyTo({ center: [to.lon, to.lat], zoom, duration: 1200 });
        return true;
    } catch {
        return false; // the map went away meanwhile
    }
}

/**
 * Find-boat: fly to the BOAT at `zoom`. A live fix flies and clears the
 * message; her last known fix flies with the message (and takes her first
 * live fix once, until a gesture); none leaves the chart where it is and
 * says so. Never the phone. A newer tap supersedes this one (resolves null).
 */
export async function locateVessel(
    map: mapboxgl.Map,
    crewOwnerId: string | null,
    names: ObsBoatNames,
    zoom: number,
): Promise<LocateOutcome | null> {
    const seq = ++locateSeq;
    // Always after the tap returns, so the button knows an outcome is coming.
    await Promise.resolve();
    let fix = vesselFixNow(crewOwnerId, Date.now(), { held: false });
    if (!fix?.live) {
        // Past the deadline: what this device holds (her held fix), not a late flight.
        const answer = await withDeadline<ObsFix | null | undefined>(
            lookUpVesselFix(crewOwnerId),
            LOCATE_LOOKUP_DEADLINE_MS,
            undefined,
        );
        fix = answer === undefined ? vesselFixNow(crewOwnerId, Date.now()) : answer;
    }
    if (seq !== locateSeq) return null;
    const subject: ObsSubject = { kind: 'boat', crewOwnerId };
    const label = obsBoatLabel(crewOwnerId, names);
    if (fix?.live) {
        clearObsCentreNotice();
        return { centred: flyFor(map, fix, zoom), announcement: `Chart centred on ${label}.` };
    }
    if (fix) {
        const { id, standing } = showForTap({ subject, state: 'held', at: fix.timestamp }, names);
        const centred = flyFor(map, fix, zoom);
        if (centred) holdStandIn(id, map, zoom);
        return { centred, announcement: standing };
    }
    if (noticeAboutOther(subject))
        return { centred: false, announcement: `No position from ${label} yet. The chart has not moved.`, noFix: true };
    const { standing } = showForTap({ subject, state: 'none', at: null }, names);
    return standing ? { centred: false, announcement: standing, noFix: true } : { centred: false, announcement: '' };
}

/** The phone's Location permission for the message's words; 'unknown' when it cannot be read. */
export async function readPhonePermission(): Promise<PhonePermission> {
    try {
        return await GpsService.locationPermission();
    } catch {
        return 'unknown';
    }
}

/** The phone's words name no boat. */
const NO_BOAT_NAMES: ObsBoatNames = { own: null, crew: null };

/**
 * Locate me on the phone: its live fix, else one asked for on the tap (a
 * foreground request: the tap is the punter asking, so iOS may show its
 * prompt), then its last known fix with the message, else the message alone.
 * Never the boat. A newer tap supersedes this one (resolves null).
 */
export async function locatePhone(map: mapboxgl.Map, zoom: number): Promise<LocateOutcome | null> {
    const seq = ++locateSeq;
    await Promise.resolve();
    let fix = phoneFixNow(Date.now(), { stored: false });
    if (!fix?.live) {
        try {
            const position = await GpsService.requestCurrentForegroundPosition({
                staleLimitMs: PHONE_READ_MAX_AGE_MS,
                timeoutSec: 10,
            });
            const now = Date.now();
            if (position && usable(position.latitude, position.longitude, position.timestamp, now)) {
                rememberPhoneFix(position, now);
                fix = {
                    lat: position.latitude,
                    lon: position.longitude,
                    timestamp: position.timestamp,
                    live: now - position.timestamp <= PHONE_FIX_MAX_AGE_MS,
                };
            }
        } catch {
            /* no fix: the last known one, below */
        }
    }
    if (seq !== locateSeq) return null;
    const subject: ObsSubject = { kind: 'phone' };
    if (fix?.live) {
        clearObsCentreNotice();
        return { centred: flyFor(map, fix, zoom), announcement: 'Chart centred on your position.' };
    }
    const kept = phoneFixNow(Date.now());
    if (kept) {
        const { id, standing } = showForTap({ subject, state: 'held', at: kept.timestamp }, NO_BOAT_NAMES);
        const centred = flyFor(map, kept, zoom);
        if (centred) holdStandIn(id, map, zoom);
        return { centred, announcement: standing };
    }
    const permission = await readPhonePermission();
    if (seq !== locateSeq) return null;
    if (noticeAboutOther(subject))
        return { centred: false, announcement: 'Phone GPS unavailable. The chart has not moved.', noFix: true };
    const { standing } = showForTap({ subject, state: 'none', at: null, permission }, NO_BOAT_NAMES);
    return standing ? { centred: false, announcement: standing, noFix: true } : { centred: false, announcement: '' };
}

/** The locate button on Obs: the boat or the phone, as obsLocateSubject chose. */
export function locateOnObs(
    map: mapboxgl.Map,
    subject: ObsSubject,
    names: ObsBoatNames,
    zoom: number,
): Promise<LocateOutcome | null> {
    return subject.kind === 'phone' ? locatePhone(map, zoom) : locateVessel(map, subject.crewOwnerId, names, zoom);
}

/** Test seam. */
export function __resetObsCentreForTests(): void {
    releaseStandIn();
    notice = null;
    noticeSeq = 0;
    locateSeq = 0;
    phoneReadInFlight = null;
}
