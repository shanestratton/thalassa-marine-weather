/**
 * The under-way alarms' one rule (build 126, 126-02a): off route (XTE) and
 * shoal water. PURE: no stores, no clock of its own, no side effects. The
 * watch (./UnderwayAlarmWatch.ts) reads the app and calls these; the tests
 * (tests/UnderwayRule.test.ts) pin them.
 *
 * OFF ROUTE, while she follows a route:
 *  - The limit is the skipper's inshore one (0.25 NM by default), or the
 *    offshore one (1 NM) when the Ship's Log shore zone says offshore: more
 *    than 5 NM from the OSM coastline, worldwide
 *    (services/shiplog/ShoreZoneResolver.ts). With no zone (no track
 *    recording), a leg of 20 NM or more she is 5 NM or more from both ends of
 *    is open water and offshore too. Anything else is inshore: unknown never
 *    widens the limit near land.
 *  - It arms only once she has been within the limit since following began,
 *    so leaving a berth off the line does not set it off.
 *  - It sounds on two fresh fixes over the limit at least 10 s apart, in a
 *    row (a fix back inside, a stop or a lost fix starts the count again),
 *    and clears only under 80% of the limit held 20 s. With no fresh fix it
 *    neither sounds nor clears. Stopped (hove-to, at anchor) it never sounds:
 *    a sounding alarm stands down without counting as back on the route (a
 *    mute holds), and under way again it needs two fresh fixes once more.
 *  - It is over for this route once she reaches its end on the line (within
 *    the limit of the end, having been well clear of it first, so a day sail
 *    that ends where it starts is not over in the berth). Carrying on past
 *    the end pin into a marina is not 'off the route'.
 *  - A mute lasts 30 minutes; it ends early when the alarm clears.
 *
 * SHOAL WATER, under way, with or without a route:
 *  - What is under the keel is the Instrument Panel's own rule, keelOffsetFor
 *    (utils/keelDepth.ts, re-exported here: one function, never two). A
 *    'below-transducer' reading always means the offset is unknown (the Pi and
 *    the NMEA path fold a known one into 'below-keel'), so the draft comes off
 *    it, and any offset beside it is ignored.
 *  - Only the boat's own feed (the gateway, or the Pi over the boat LAN; never
 *    the Pi's cloud row) and only live readings count: three under the margin
 *    IN A ROW under way sound (a stop, a lost feed or a gap of more than 15 s
 *    starts the count again); it clears at the margin + 0.3 m held 10 s.
 *    Stale or dead readings neither sound nor clear. Stopped, a sounding alarm
 *    holds (she may be aground). A sounder lost under way is said ('lost');
 *    one lost after she stopped is the skipper walking off with the phone.
 *  - An acknowledgement silences it until it clears; then it re-arms.
 *
 * The words every card, strip and lock-screen alert uses are built here too.
 */
import type { NmeaDepthReference } from '../../types/navigation';
import { keelOffsetFor } from '../../utils/keelDepth';
import { calculateDistance } from '../../utils/navigationCalculations';
import {
    buildRouteIndex,
    progressAlongRoute,
    type RouteIndex,
    type RoutePoint,
    type RouteProgressHint,
} from '../routeProgress';

export { keelOffsetFor };

/** The Ship's Log shore zone (services/shiplog/helpers.ts LoggingZone). */
export type ShoreZone = 'nearshore' | 'coastal' | 'offshore';
/** NmeaStore's freshness tiers: live under 6.5 s, stale to 13 s, dead after. */
export type DepthFreshness = 'live' | 'stale' | 'dead';

export const UNDERWAY_RULE = Object.freeze({
    xte: Object.freeze({
        /** Two fresh fixes over the limit, this far apart, sound it. */
        confirmMs: 10_000,
        /** It clears only under this share of the limit… */
        clearFraction: 0.8,
        /** …held this long. */
        clearHoldMs: 20_000,
        muteMs: 30 * 60_000,
        /** A fix older than this is no fix: it neither sounds nor clears. */
        fixMaxAgeMs: 30_000,
    }),
    openWater: Object.freeze({ legMinNm: 20, endsClearNm: 5 }),
    /** She has left the route's end once she is this many limits from it (a day sail starts at its end). */
    arrival: Object.freeze({ leftEndLimits: 2 }),
    shoal: Object.freeze({
        soundAfterReadings: 3,
        clearAboveMarginM: 0.3,
        clearHoldMs: 10_000,
        /** Readings further apart than this are not 'in a row'. */
        readingGapMs: 15_000,
    }),
});

// ── The skipper's choices (Settings → Preferences → Under-way alarms) ──────

export interface OffRoutePrefs {
    enabled: boolean;
    inshoreNm: number;
    offshoreNm: number;
}

export interface UnderwayPrefs {
    offRoute: OffRoutePrefs;
    shoal: { enabled: boolean };
    /** The watch check (126-02b): a dead-man check every `intervalMin` while a voyage track records. */
    watchCheck: { enabled: boolean; intervalMin: number };
}

export const XTE_INSHORE_CHOICES_NM: readonly number[] = [0.1, 0.25, 0.5];
export const XTE_OFFSHORE_CHOICES_NM: readonly number[] = [0.5, 1, 2];
/** The watch check's intervals, in minutes (126-02b). */
export const WATCH_CHECK_INTERVALS_MIN: readonly number[] = [10, 15, 20, 30];

/**
 * Off route and shoal water ON for every account (safety is never paywalled):
 * a quarter mile inshore, a mile offshore. The watch check OFF until switched
 * on: it asks for a tap every interval, and an alarm people learn to swipe
 * away is worse than none (126-02b).
 */
export const UNDERWAY_DEFAULTS: UnderwayPrefs = {
    offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 1 },
    shoal: { enabled: true },
    watchCheck: { enabled: false, intervalMin: 15 },
};

const PREF_LIMITS = { inshoreNm: { min: 0.05, max: 1 }, offshoreNm: { min: 0.25, max: 3 } };

const record = (raw: unknown): Record<string, unknown> =>
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

function clampNm(raw: unknown, fallback: number, limits: { min: number; max: number }): number {
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(limits.max, Math.max(limits.min, raw)) : fallback;
}

/** A saved interval, as the nearest choice (the shorter on a tie); unreadable is the default. */
function watchIntervalMin(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return UNDERWAY_DEFAULTS.watchCheck.intervalMin;
    return WATCH_CHECK_INTERVALS_MIN.reduce((best, m) => (Math.abs(m - raw) < Math.abs(best - raw) ? m : best));
}

/**
 * Saved choices, read defensively: off route and shoal are off only when
 * switched off, the watch check on only when switched on; limits are clamped.
 */
export function sanitiseUnderwayPrefs(raw: unknown): UnderwayPrefs {
    const saved = record(raw);
    const offRoute = record(saved.offRoute);
    const shoal = record(saved.shoal);
    const watchCheck = record(saved.watchCheck);
    const d = UNDERWAY_DEFAULTS.offRoute;
    return {
        offRoute: {
            enabled: offRoute.enabled !== false,
            inshoreNm: clampNm(offRoute.inshoreNm, d.inshoreNm, PREF_LIMITS.inshoreNm),
            offshoreNm: clampNm(offRoute.offshoreNm, d.offshoreNm, PREF_LIMITS.offshoreNm),
        },
        shoal: { enabled: shoal.enabled !== false },
        watchCheck: { enabled: watchCheck.enabled === true, intervalMin: watchIntervalMin(watchCheck.intervalMin) },
    };
}

// ── Off route ───────────────────────────────────────────────────────────────

/** The leg she is abeam of, and where along it she is. */
export interface LegContext {
    legLengthNm: number;
    fromStartNm: number;
    toEndNm: number;
}

export interface XteLimit {
    limitNm: number;
    offshore: boolean;
    basis: 'shore-zone' | 'open-water-leg' | 'inshore';
}

/** Which limit applies: the shore zone if known, else an open-water leg, else inshore. */
export function xteLimitNm(zone: ShoreZone | null | undefined, leg: LegContext | null, prefs: OffRoutePrefs): XteLimit {
    if (zone === 'offshore') return { limitNm: prefs.offshoreNm, offshore: true, basis: 'shore-zone' };
    if (zone === 'coastal' || zone === 'nearshore') {
        return { limitNm: prefs.inshoreNm, offshore: false, basis: 'shore-zone' };
    }
    const water = UNDERWAY_RULE.openWater;
    if (
        leg &&
        leg.legLengthNm >= water.legMinNm &&
        leg.fromStartNm >= water.endsClearNm &&
        leg.toEndNm >= water.endsClearNm
    ) {
        return { limitNm: prefs.offshoreNm, offshore: true, basis: 'open-water-leg' };
    }
    return { limitNm: prefs.inshoreNm, offshore: false, basis: 'inshore' };
}

export interface XteMeasure {
    offTrackNm: number;
    /** Where she is reckoned along the route: the next measure's hint. */
    alongNm: number;
    leg: LegContext;
    /** Along the route from the point abeam of her to its end. */
    remainingNm: number;
    /** Straight from her to the route's end. */
    endNm: number;
}

/**
 * How far off the route she is, and the leg she is abeam of, on a route
 * measured once (buildRouteIndex). The geometry is routeProgress's, so it
 * is antimeridian-safe and handles out-and-back routes. Null with no route or
 * no position: never a zero that reads as on the line.
 */
export function measureXteOnIndex(
    index: RouteIndex | null,
    position: RoutePoint | null | undefined,
    hint: RouteProgressHint = {},
): XteMeasure | null {
    if (!index) return null;
    const progress = progressAlongRoute(index.points, position, hint);
    if (!progress) return null;
    const start = index.cumNm[progress.legIndex];
    const end = index.cumNm[progress.legIndex + 1];
    const last = index.points[index.lastRealLeg + 1];
    return {
        offTrackNm: progress.offTrackNm,
        alongNm: progress.alongNm,
        leg: {
            legLengthNm: end - start,
            fromStartNm: Math.max(0, progress.alongNm - start),
            toEndNm: Math.max(0, end - progress.alongNm),
        },
        remainingNm: progress.remainingNm,
        endNm: calculateDistance(position!.lat, position!.lon, last.lat, last.lon),
    };
}

export function measureXte(
    route: readonly RoutePoint[],
    position: RoutePoint | null | undefined,
    hint: RouteProgressHint = {},
): XteMeasure | null {
    return measureXteOnIndex(buildRouteIndex(route), position, hint);
}

export type XteStatus = 'arming' | 'watching' | 'sounding' | 'no-fix' | 'stopped' | 'arrived';

export interface XteState {
    /** She has been within the limit since following began: the alarm is armed. */
    latched: boolean;
    sounding: boolean;
    /** The first fix of the run over the limit. */
    overSince: number | null;
    /** The first fix of the run under 80% of the limit, while sounding. */
    clearSince: number | null;
    lastFixAt: number | null;
    offTrackNm: number | null;
    limitNm: number | null;
    offshore: boolean;
    mutedUntil: number | null;
    /** She has been well clear of the route's end since following began. */
    leftEnd: boolean;
    /** She reached the end on the line: the route is sailed, and the alarm is over for it. */
    arrived: boolean;
    status: XteStatus;
}

export const XTE_START: XteState = Object.freeze({
    latched: false,
    sounding: false,
    overSince: null,
    clearSince: null,
    lastFixAt: null,
    offTrackNm: null,
    limitNm: null,
    offshore: false,
    mutedUntil: null,
    leftEnd: false,
    arrived: false,
    status: 'arming',
});

export interface XteObservation {
    /** The fresh fix's own time, or null: no fix, or one too old to steer by. */
    fixAt: number | null;
    offTrackNm: number | null;
    limitNm: number;
    offshore: boolean;
    /** Stopped by the collision rule's own test (collisionOwnStill). */
    still: boolean;
    /** Along the route to its end (XteMeasure.remainingNm); without it, arrival is never judged. */
    remainingNm?: number | null;
    /** Straight to the route's end (XteMeasure.endNm). */
    endNm?: number | null;
}

export function nextXteState(prev: XteState, obs: XteObservation): XteState {
    // The route is sailed: nothing past its end is 'off' it.
    if (prev.arrived) return prev;
    if (obs.fixAt === null || obs.offTrackNm === null || !Number.isFinite(obs.offTrackNm)) {
        // Neither sounds nor clears, and the fixes either side of it are not 'in a row'.
        return { ...prev, overSince: null, clearSince: null, status: 'no-fix' };
    }
    // The same fix seen again is not a second fix.
    if (prev.lastFixAt !== null && obs.fixAt <= prev.lastFixAt) {
        return prev.status === 'no-fix' ? { ...prev, status: settledStatus(prev) } : prev;
    }
    const off = obs.offTrackNm;
    const limit = obs.limitNm;
    const next: XteState = {
        ...prev,
        lastFixAt: obs.fixAt,
        offTrackNm: off,
        limitNm: limit,
        offshore: obs.offshore,
    };
    const endNm = obs.endNm;
    if (typeof endNm === 'number' && endNm > limit * UNDERWAY_RULE.arrival.leftEndLimits) next.leftEnd = true;
    const remaining = obs.remainingNm;
    if (next.leftEnd && typeof remaining === 'number' && remaining <= limit && off <= limit) {
        return {
            ...next,
            latched: true,
            arrived: true,
            sounding: false,
            overSince: null,
            clearSince: null,
            mutedUntil: null,
            status: 'arrived',
        };
    }
    // Stopped (hove-to, at anchor): never sounds. A sounding alarm stands down
    // (not 'back on the route': a mute holds), and under way again it takes
    // two fresh fixes once more.
    if (obs.still) return { ...next, sounding: false, overSince: null, clearSince: null, status: 'stopped' };

    if (!next.latched) {
        if (off <= limit) return { ...next, latched: true, overSince: null, status: 'watching' };
        return { ...next, status: 'arming' };
    }

    const rule = UNDERWAY_RULE.xte;
    if (!next.sounding) {
        if (off > limit) {
            next.overSince ??= obs.fixAt;
            if (obs.fixAt - next.overSince >= rule.confirmMs) {
                next.sounding = true;
                next.clearSince = null;
            }
        } else {
            next.overSince = null;
        }
    } else if (off < limit * rule.clearFraction) {
        next.clearSince ??= obs.fixAt;
        if (obs.fixAt - next.clearSince >= rule.clearHoldMs) {
            // Back on the route: the alarm, and any mute on it, are over.
            next.sounding = false;
            next.overSince = null;
            next.clearSince = null;
            next.mutedUntil = null;
        }
    } else {
        next.clearSince = null;
    }
    return { ...next, status: settledStatus(next) };
}

function settledStatus(s: XteState): XteStatus {
    if (!s.latched) return 'arming';
    return s.sounding ? 'sounding' : 'watching';
}

/** Mute 30 minutes: only an alarm that is sounding can be muted. */
export function muteXte(state: XteState, nowMs: number): XteState {
    if (!state.sounding) return state;
    return { ...state, mutedUntil: nowMs + UNDERWAY_RULE.xte.muteMs };
}

export function xteAudible(state: XteState, nowMs: number): boolean {
    return state.sounding && !(state.mutedUntil !== null && nowMs < state.mutedUntil);
}

// ── Shoal water ─────────────────────────────────────────────────────────────

/** Metres under the keel for a depth in its own reference: keelOffsetFor, nothing else. */
export function underKeelM(depthM: number, reference: NmeaDepthReference | null | undefined, draftM: number): number {
    return depthM + keelOffsetFor(reference, draftM);
}

/** The depth as the watch reads it off the store, and whether it came off the boat itself. */
export interface ShoalDepth {
    /** The gateway socket, or the Pi over the boat LAN (NmeaStore.isBoatFeed); never the cloud row. */
    boatFeed: boolean;
    depthM: number | null;
    reference: NmeaDepthReference | null;
    /** Carried for the record and NEVER read: a known offset arrives folded into 'below-keel'. */
    offsetM?: number | null;
    freshness: DepthFreshness;
    /** When the store last took this reading (its lastUpdated). */
    readingAt: number;
}

/** The depth fields of NmeaStore's state (structural, so this stays pure). */
export interface DepthStoreFields {
    depth?: { value: number | null; lastUpdated: number; freshness: DepthFreshness } | null;
    depthReference?: NmeaDepthReference | null;
    depthOffsetM?: number | null;
}

export function shoalDepthFrom(store: DepthStoreFields, boatFeed: boolean): ShoalDepth {
    const depth = store.depth;
    const value = depth?.value;
    return {
        boatFeed,
        depthM: typeof value === 'number' && Number.isFinite(value) ? value : null,
        reference: store.depthReference ?? null,
        offsetM: store.depthOffsetM ?? null,
        freshness: depth?.freshness ?? 'dead',
        readingAt: depth?.lastUpdated ?? 0,
    };
}

export interface ShoalObservation extends ShoalDepth {
    /** Making way by the collision rule's own test (collisionOwnStill): never stopped, never at anchor. */
    underWay: boolean;
    draftM: number;
    /** vesselDraftIsAssumed: the skipper never set it. */
    draftAssumed: boolean;
    /** underKeelClearanceM(). */
    marginM: number;
}

export type ShoalStatus = 'watching' | 'sounding' | 'stale' | 'lost' | 'no-depth' | 'stopped';

export interface ShoalState {
    sounding: boolean;
    acknowledged: boolean;
    shallowReadings: number;
    clearSince: number | null;
    lastReadingAt: number | null;
    /** A live reading off the boat has been seen: a quiet sounder now is news. */
    sawLiveDepth: boolean;
    /**
     * The last live reading came while she was under way: losing the boat's
     * feed now is news ('lost'). One lost after she stopped is the skipper
     * walking off with the phone, and is not.
     */
    liveUnderWay: boolean;
    depthM: number | null;
    reference: NmeaDepthReference | null;
    underKeelM: number | null;
    draftM: number;
    draftAssumed: boolean;
    marginM: number;
    status: ShoalStatus;
}

export const SHOAL_START: ShoalState = Object.freeze({
    sounding: false,
    acknowledged: false,
    shallowReadings: 0,
    clearSince: null,
    lastReadingAt: null,
    sawLiveDepth: false,
    liveUnderWay: false,
    depthM: null,
    reference: null,
    underKeelM: null,
    draftM: 0,
    draftAssumed: false,
    marginM: 0.5,
    status: 'no-depth',
});

export function nextShoalState(prev: ShoalState, obs: ShoalObservation): ShoalState {
    const rule = UNDERWAY_RULE.shoal;
    // Whatever breaks the run of readings starts the count (and the clear hold) again.
    const restart = { shallowReadings: 0, clearSince: null };
    // No depth off the boat at all (no gateway, no Pi on the LAN, or only the
    // cloud row): it cannot see, and it holds whatever it was doing. Lost
    // under way, it says so.
    if (!obs.boatFeed) {
        return { ...prev, ...restart, sawLiveDepth: false, status: prev.liveUnderWay ? 'lost' : 'no-depth' };
    }
    if (obs.depthM === null || !Number.isFinite(obs.depthM)) {
        return { ...prev, ...restart, status: prev.sawLiveDepth ? 'stale' : 'no-depth' };
    }
    if (obs.freshness !== 'live') return { ...prev, status: 'stale' };
    // Stopped: the sounder is alive, but nothing sounds or clears, and shallow
    // readings at a berth never add up toward an alarm.
    if (!obs.underWay) return { ...prev, ...restart, sawLiveDepth: true, liveUnderWay: false, status: 'stopped' };

    const next: ShoalState = {
        ...prev,
        sawLiveDepth: true,
        liveUnderWay: true,
        depthM: obs.depthM,
        reference: obs.reference,
        underKeelM: underKeelM(obs.depthM, obs.reference, obs.draftM),
        draftM: obs.draftM,
        draftAssumed: obs.draftAssumed,
        marginM: obs.marginM,
    };
    if (prev.lastReadingAt !== null && obs.readingAt <= prev.lastReadingAt) {
        // The same reading seen again: shown, never counted twice.
        return { ...next, status: next.sounding ? 'sounding' : 'watching' };
    }
    // Readings far apart (a suspended app between them) are not in a row.
    const inRow = prev.lastReadingAt === null || obs.readingAt - prev.lastReadingAt <= rule.readingGapMs;
    if (!inRow) Object.assign(next, restart);
    next.lastReadingAt = obs.readingAt;
    const underKeel = next.underKeelM!;
    if (underKeel < obs.marginM) {
        next.shallowReadings += 1;
        next.clearSince = null;
        if (next.shallowReadings >= rule.soundAfterReadings) next.sounding = true;
    } else if (underKeel >= obs.marginM + rule.clearAboveMarginM) {
        next.shallowReadings = 0;
        if (next.sounding) {
            next.clearSince ??= obs.readingAt;
            if (obs.readingAt - next.clearSince >= rule.clearHoldMs) {
                // Deep water again: over, and re-armed.
                next.sounding = false;
                next.acknowledged = false;
                next.clearSince = null;
            }
        }
    } else {
        // Between the margin and the clear line: neither counts toward sounding nor clearing.
        next.clearSince = null;
    }
    return { ...next, status: next.sounding ? 'sounding' : 'watching' };
}

/** Acknowledge: silent until it clears. Only a sounding alarm can be acknowledged. */
export function acknowledgeShoal(state: ShoalState): ShoalState {
    return state.sounding ? { ...state, acknowledged: true } : state;
}

export function shoalAudible(state: ShoalState): boolean {
    return state.sounding && !state.acknowledged;
}

// ── The words ───────────────────────────────────────────────────────────────

/** Said when the watch cannot see, or cannot run. */
export const UNDERWAY_NOTICES = Object.freeze({
    arming: 'Off-route alarm arms once you are on the route.',
    noFix: 'Off-route alarm: no position fix',
    shoalStale: 'Shoal alarm: depth reading stale',
    shoalLost: 'Shoal alarm: no depth from the boat',
    paused: 'Under-way alarms paused: Thalassa is in the background without a voyage track.',
});

export interface AlarmLines {
    title: string;
    /** The number, said plainly. */
    value: string;
    /** What it is measured from (lower case: it follows the number on the lock screen). */
    detail: string;
    note?: string;
}

const metres = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);

const MEASURED_FROM: Record<NmeaDepthReference | 'unknown', string> = {
    'below-keel': 'below the keel',
    'below-waterline': 'below the waterline',
    'below-transducer': 'below the transducer, taken as at the waterline',
    unknown: 'from a point it does not name, taken as the waterline',
};

export function shoalLines(
    s: Pick<ShoalState, 'depthM' | 'reference' | 'underKeelM' | 'draftM' | 'draftAssumed' | 'marginM'>,
): AlarmLines {
    const note = `Margin under the keel: ${metres(s.marginM)} m`;
    if (s.underKeelM === null || s.depthM === null) {
        return { title: 'SHOAL WATER', value: 'depth unknown', detail: 'no live reading from the sounder', note };
    }
    if (s.reference === 'below-keel') {
        return {
            title: 'SHOAL WATER',
            value: `${metres(s.underKeelM)} m under the keel`,
            detail: 'your sounder measures from the keel',
            note,
        };
    }
    const draft = s.draftAssumed
        ? `${metres(s.draftM)} m (draft not set: set it in Vessel)`
        : `your ${metres(s.draftM)} m draft`;
    return {
        title: 'SHOAL WATER',
        value: `about ${metres(s.underKeelM)} m under the keel`,
        detail: `your sounder reads ${metres(s.depthM)} m ${MEASURED_FROM[s.reference ?? 'unknown']}, minus ${draft}`,
        note,
    };
}

const nm = (x: number): string => (x < 10 ? x.toFixed(2) : x.toFixed(1));

export function offRouteLines(s: Pick<XteState, 'offTrackNm' | 'limitNm' | 'offshore' | 'status'>): AlarmLines {
    const lost = s.status === 'no-fix';
    const value = s.offTrackNm === null ? 'off the line' : `${lost ? 'last ' : ''}${nm(s.offTrackNm)} NM off the line`;
    const limit = s.limitNm === null ? '' : `limit ${s.limitNm} NM ${s.offshore ? 'offshore' : 'inshore'}`;
    return { title: 'OFF ROUTE', value, detail: lost ? `${limit}; no position fix now` : limit };
}

const sentence = (text: string): string => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : '');

/** The lock-screen alert's title and body (Time Sensitive, 'shoal' / 'off-route'). */
export function lockScreenText(kind: 'shoal' | 'off-route', lines: AlarmLines): { title: string; body: string } {
    if (kind === 'shoal') {
        return {
            title: `Shoal water: ${lines.value}`,
            body: `${sentence(lines.detail)} ${sentence(lines.note ?? '')}`.trim(),
        };
    }
    return {
        title: `Off route: ${lines.value}`,
        body: `Steer back to the route you are following: ${lines.detail}.`,
    };
}
