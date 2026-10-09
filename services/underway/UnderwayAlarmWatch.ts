/**
 * UnderwayAlarmWatch — off route and shoal water, sounding (build 126,
 * 126-02a). Loaded lazily, on idle, by hooks/useAppBootstrap.ts.
 *
 * Every 2 s, and as the boat's instruments or the followed route change, it
 * reads the app (readUnderwayInputs) and runs the one rule
 * (./underwayRule.ts). Then, as the collision alarm does
 * (services/CollisionAlarmService.ts):
 *
 *  - SOUND through AlarmAudioService under its own leases, 'off-route-watch'
 *    and 'shoal-watch'. Leases are owner-scoped, so clearing either can never
 *    silence the anchor alarm, and this path never force-stops: the anchor
 *    keeps priority, and its overlay sits above the alarm stack.
 *  - THE LOCK SCREEN through the shared safety path
 *    (AnchorSafetyNotificationService), kinds 'off-route' and 'shoal': Time
 *    Sensitive, their own ids, behind iOS's verified-enabled check. Focus lets
 *    them through only where the skipper allows Thalassa's Time Sensitive
 *    notifications; nothing here claims more.
 *  - THE CARDS and the strip through ./underwayAlarmStore.ts, drawn by the
 *    app-wide alarm stack under the collision cards: shoal, then off route.
 *  - HONEST: the strip says when it cannot see (no position, a stale or lost
 *    sounder, not yet on the route). Going to the background with an alarm armed and
 *    nothing keeping Thalassa running (no voyage track, anchor watch or MOB
 *    holding the background GPS) posts one plain notice, because iOS then
 *    suspends the app and a suspended app watches nothing.
 *
 * Off route runs only while a route is followed, until she reaches its end.
 * It steers by the boat's own GPS, else this phone's own last fix (read
 * passively, as the passage HUD does), and takes 'offshore' only from real
 * shore evidence. Shoal water runs under way, with or without a route, off the
 * boat's own sounder only. No tier check anywhere: safety is never paywalled.
 */
import { Capacitor } from '@capacitor/core';
import { AlarmAudioService } from '../AlarmAudioService';
import { AnchorSafetyNotificationService, type SafetyAlertKind } from '../AnchorSafetyNotificationService';
import { NmeaStore } from '../NmeaStore';
import { GpsService, type GpsPosition } from '../GpsService';
import { LocationStore } from '../../stores/LocationStore';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ShipLogService } from '../ShipLogService';
import { readCollisionAnchorWatch } from '../collisionAnchorWatch';
import { resolveOwnMotion, resolveOwnshipPosition } from '../ownshipPosition';
import { buildRouteIndex, type RouteIndex, type RoutePoint } from '../routeProgress';
import { vesselDraftIsAssumed, vesselDraftMetres } from '../units';
import { collisionOwnStill } from '../../utils/collisionRule';
import { destinationPoint } from '../../utils/navigationCalculations';
import { createLogger } from '../../utils/createLogger';
import { UnderwayAlarmStore, type UnderwayAlarmCard, type UnderwayAlarmKind } from './underwayAlarmStore';
import { underKeelClearanceM } from './underKeelClearance';
import {
    SHOAL_START,
    UNDERWAY_NOTICES,
    UNDERWAY_RULE,
    XTE_START,
    acknowledgeShoal,
    lockScreenText,
    measureXteOnIndex,
    muteXte,
    nextShoalState,
    nextXteState,
    offRouteLines,
    sanitiseUnderwayPrefs,
    shoalAudible,
    shoalDepthFrom,
    shoalLines,
    xteAudible,
    xteLimitNm,
    type ShoalDepth,
    type ShoalState,
    type ShoreZone,
    type UnderwayPrefs,
    type XteState,
} from './underwayRule';

const log = createLogger('UnderwayAlarm');

const TICK_MS = 2_000;
/** Store updates (several a second) run a pass at most this often; the tick covers the rest. */
const MIN_PASS_GAP_MS = 500;
/** A plain (not Time Sensitive) local notice; clear of the anchor's 99001/991xx and the collision's 97125xx. */
const PAUSED_NOTICE_ID = 97_126_02;
/** A phone or boat clock this far ahead is still a fix (ownshipPosition's own skew). */
const FUTURE_SKEW_MS = 5_000;

/** Everything one pass needs, read once. Exported so tests can hand it in. */
export interface UnderwayInputs {
    nowMs: number;
    prefs: UnderwayPrefs;
    /** The route she follows, or null. `key` changes with each new follow or a changed line. */
    following: { key: string; route: readonly RoutePoint[] } | null;
    /**
     * A fresh fix and its own time (a relayed fix: when her receiver said it),
     * or null: the boat's GPS first, else this phone's own.
     */
    fix: { lat: number; lon: number; at: number } | null;
    sogKn: number | null;
    cogDeg: number | null;
    /** An anchor watch is on for this position (services/collisionAnchorWatch.ts). */
    atAnchor: boolean;
    /**
     * The Ship's Log shore zone while a voyage track records AND it rests on
     * real ocean + coastline evidence, else null. (The log's own 'nearshore' is
     * also its offline fallback, which proves nothing about the coast.)
     */
    zone: ShoreZone | null;
    depth: ShoalDepth;
    draftM: number;
    draftAssumed: boolean;
    marginM: number;
}

function routeKey(follow: { voyageId?: string | null; startedAt?: string | null }, route: readonly RoutePoint[]) {
    const first = route[0];
    const last = route[route.length - 1];
    return `${follow.voyageId ?? ''}|${follow.startedAt ?? ''}|${route.length}|${first.lat},${first.lon}|${last.lat},${last.lon}`;
}

type OwnFix = { lat: number; lon: number; at: number; source: 'nmea' | 'gps' };

/**
 * Her position for the off-route alarm: the boat's own GPS when it is fresh,
 * else this phone's own last fix, read PASSIVELY (GpsService keeps the newest
 * fix any watcher was given; nothing here starts the GPS or asks permission),
 * exactly as the passage HUD reads it, so the HUD and the alarm agree.
 * LocationStore only ever holds a chosen place in production (never 'gps'),
 * so resolveOwnshipPosition alone left a phone-only boat with no fix at all.
 */
function readOwnFix(nmea: ReturnType<typeof NmeaStore.getState>, phone: GpsPosition | null, nowMs: number) {
    const fresh = (at: number) =>
        Number.isFinite(at) && nowMs - at <= UNDERWAY_RULE.xte.fixMaxAgeMs && at - nowMs <= FUTURE_SKEW_MS;
    const own = resolveOwnshipPosition(nmea, LocationStore.getState(), nowMs);
    if (own?.source === 'nmea') {
        // A fix relayed down the Pi's cloud row is as old as her receiver says, not as when this phone read it.
        const at = own.relay?.reportedAt ?? own.timestamp;
        if (fresh(at)) return { lat: own.lat, lon: own.lon, at, source: 'nmea' } satisfies OwnFix;
    }
    if (phone && Number.isFinite(phone.latitude) && Number.isFinite(phone.longitude) && fresh(phone.timestamp)) {
        return { lat: phone.latitude, lon: phone.longitude, at: phone.timestamp, source: 'gps' } satisfies OwnFix;
    }
    if (own?.source === 'gps' && fresh(own.timestamp)) {
        return { lat: own.lat, lon: own.lon, at: own.timestamp, source: 'gps' } satisfies OwnFix;
    }
    return null;
}

export function readUnderwayInputs(nowMs: number = Date.now()): UnderwayInputs {
    const settings = useSettingsStore.getState().settings;
    const follow = useFollowRouteStore.getState();
    const route = Array.isArray(follow.routeCoords) ? follow.routeCoords : [];
    const nmea = NmeaStore.getState();
    const phone = GpsService.getLastKnownPosition();
    const own = readOwnFix(nmea, phone, nowMs);
    const motion = resolveOwnMotion(nmea, phone, nowMs);
    const anchorWatch = readCollisionAnchorWatch(own);
    return {
        nowMs,
        prefs: sanitiseUnderwayPrefs(settings?.underwayAlarms),
        following: follow.isFollowing && route.length >= 2 ? { key: routeKey(follow, route), route } : null,
        fix: own ? { lat: own.lat, lon: own.lon, at: own.at } : null,
        sogKn: motion.sogKn,
        cogDeg: motion.cogDeg,
        atAnchor: anchorWatch === 'at-anchor',
        zone: ShipLogService.getEvidencedShoreZone(),
        depth: shoalDepthFrom(nmea, NmeaStore.isBoatFeed()),
        draftM: vesselDraftMetres(settings?.vessel),
        draftAssumed: vesselDraftIsAssumed(settings?.vessel),
        marginM: underKeelClearanceM(settings),
    };
}

// ── State ───────────────────────────────────────────────────────────────────

let xte: XteState = XTE_START;
let shoal: ShoalState = SHOAL_START;
let followKey: string | null = null;
let routeRef: readonly RoutePoint[] | null = null;
let routeIndex: RouteIndex | null = null;
let alongHint: number | undefined;
/** What the last pass found: the buttons republish against it. */
let context = { offRouteOn: false, shoalOn: false, underWay: false };
let armed = false;

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribers: Array<() => void> = [];
let started = false;
let queued = false;
let lastPassAt = 0;
let backgrounded = false;
let lifecycleAttached = false;
/** Bumped on every return to the foreground: a late 'background' answer is dropped. */
let lifecycleEpoch = 0;

interface Voice {
    owner: string;
    kind: SafetyAlertKind;
    token: string | null;
    wanted: boolean;
    alertLive: boolean;
}

const voices: Record<UnderwayAlarmKind, Voice> = {
    shoal: { owner: 'shoal-watch', kind: 'shoal', token: null, wanted: false, alertLive: false },
    'off-route': { owner: 'off-route-watch', kind: 'off-route', token: null, wanted: false, alertLive: false },
};

let tail: Promise<void> = Promise.resolve();

/** Side effects run one at a time, in order, so the last state always wins. */
function run(operation: () => Promise<void>): void {
    tail = tail.then(operation).catch((error) => log.warn('under-way alarm side effect failed:', error));
}

/** Start or stop one alarm's sound and lock-screen alert, only when that must change. */
function drive(voice: Voice, want: boolean, text: () => { title: string; body: string }): void {
    if (want === voice.wanted && !(want && voice.token === null)) return;
    const announce = want && !voice.wanted ? text() : null;
    voice.wanted = want;
    run(async () => {
        // Act on the LATEST intent, not on what was true when this was queued.
        if (voice.wanted && !voice.token) {
            voice.token = await AlarmAudioService.acquire(voice.owner).catch((error) => {
                log.warn(`${voice.kind} alarm audio could not start:`, error);
                return null;
            });
        } else if (!voice.wanted && voice.token) {
            const token = voice.token;
            voice.token = null;
            await AlarmAudioService.release(token).catch(() => AlarmAudioService.releaseEventually(token));
        }
        if (announce && voice.wanted) {
            voice.alertLive = true;
            await AnchorSafetyNotificationService.scheduleSafetyAlert(voice.kind, announce.title, announce.body).catch(
                (error) => log.warn(`${voice.kind} lock-screen alert could not be scheduled:`, error),
            );
        } else if (!voice.wanted && voice.alertLive) {
            voice.alertLive = false;
            await AnchorSafetyNotificationService.cancelSafetyAlert(voice.kind).catch((error) =>
                log.warn(`${voice.kind} lock-screen alert could not be withdrawn:`, error),
            );
        }
    });
}

/** The cards, the strip and the sound, from the rule's state now. */
function publish(nowMs: number): void {
    const shoalOn = shoalAudible(shoal);
    const offRouteOn = xteAudible(xte, nowMs);
    const cards: UnderwayAlarmCard[] = [];
    if (shoal.sounding && !shoal.acknowledged) {
        cards.push({ kind: 'shoal', ...shoalLines(shoal), sounding: true, mutedUntil: null });
    }
    if (xte.sounding) {
        cards.push({
            kind: 'off-route',
            ...offRouteLines(xte),
            sounding: offRouteOn,
            mutedUntil: offRouteOn ? null : xte.mutedUntil,
        });
    }
    const notices: string[] = [];
    if (context.offRouteOn) {
        if (xte.status === 'no-fix') notices.push(UNDERWAY_NOTICES.noFix);
        else if (!xte.latched) notices.push(UNDERWAY_NOTICES.arming);
    }
    if (context.shoalOn && context.underWay) {
        if (shoal.status === 'stale') notices.push(UNDERWAY_NOTICES.shoalStale);
        else if (shoal.status === 'lost') notices.push(UNDERWAY_NOTICES.shoalLost);
    }
    UnderwayAlarmStore.set(cards, notices);

    drive(voices.shoal, shoalOn, () => lockScreenText('shoal', shoalLines(shoal)));
    drive(voices['off-route'], offRouteOn, () => lockScreenText('off-route', offRouteLines(xte)));
}

/** One pass of the watch. Exported for tests, which hand in their own inputs. */
export function runUnderwayPass(inputs: UnderwayInputs = readUnderwayInputs()): void {
    attachLifecycle();
    lastPassAt = inputs.nowMs;
    const { nowMs, prefs } = inputs;
    const still = inputs.sogKn !== null && collisionOwnStill(inputs.sogKn, inputs.atAnchor);
    const underWay = inputs.sogKn !== null && !still;

    // Off route: only while a route is followed, armed afresh for each new line.
    const following = prefs.offRoute.enabled ? inputs.following : null;
    if (following && following.route !== routeRef) {
        routeRef = following.route;
        routeIndex = buildRouteIndex(following.route);
    }
    // A route with no length (every point the same) is no line to keep to.
    const offRouteOn = following !== null && routeIndex !== null;
    if (!offRouteOn || !following) {
        xte = XTE_START;
        followKey = null;
        routeRef = null;
        routeIndex = null;
        alongHint = undefined;
    } else {
        if (following.key !== followKey) {
            xte = XTE_START;
            followKey = following.key;
            alongHint = undefined;
        }
        const measure = inputs.fix
            ? measureXteOnIndex(routeIndex, inputs.fix, {
                  alongNm: alongHint,
                  headingDeg: inputs.cogDeg ?? undefined,
              })
            : null;
        if (measure) alongHint = measure.alongNm;
        const limit = xteLimitNm(inputs.zone, measure?.leg ?? null, prefs.offRoute);
        xte = nextXteState(xte, {
            fixAt: measure && inputs.fix ? inputs.fix.at : null,
            offTrackNm: measure?.offTrackNm ?? null,
            limitNm: limit.limitNm,
            offshore: limit.offshore,
            still,
            remainingNm: measure?.remainingNm ?? null,
            endNm: measure?.endNm ?? null,
        });
        // A mute that has run out is gone: the card no longer says 'muted'.
        if (xte.mutedUntil !== null && nowMs >= xte.mutedUntil) xte = { ...xte, mutedUntil: null };
    }

    // Shoal water: under way, with or without a route, off the boat's own sounder.
    const shoalOn = prefs.shoal.enabled;
    shoal = shoalOn
        ? nextShoalState(shoal, {
              ...inputs.depth,
              underWay,
              draftM: inputs.draftM,
              draftAssumed: inputs.draftAssumed,
              marginM: inputs.marginM,
          })
        : SHOAL_START;

    // Arrived at the end of the route: off route is over for it, and says nothing more.
    const offRouteWatching = offRouteOn && !xte.arrived;
    context = { offRouteOn: offRouteWatching, shoalOn, underWay };
    // Armed: something this watch would sound for if Thalassa kept running.
    armed =
        offRouteWatching ||
        xte.sounding ||
        shoal.sounding ||
        (shoalOn && underWay && (shoal.status === 'watching' || shoal.status === 'stale' || shoal.status === 'lost'));
    publish(nowMs);
}

// The cards' buttons, heard at once (not on the next pass). The watch check's
// "I'm on watch" (126-02b) is its own to hear, never a shoal acknowledgement.
UnderwayAlarmStore.subscribeActions(({ kind, nowMs }) => {
    if (kind === 'off-route') xte = muteXte(xte, nowMs);
    else if (kind === 'shoal') shoal = acknowledgeShoal(shoal);
    else return;
    publish(nowMs);
});

// ── Background: say so when nothing keeps Thalassa running ─────────────────

/** The plugin, imported once and shared. */
let localNotificationsPlugin: Promise<typeof import('@capacitor/local-notifications')> | null = null;

async function localNotice(id: number, text: string): Promise<void> {
    const split = text.indexOf(': ');
    try {
        localNotificationsPlugin ??= import('@capacitor/local-notifications');
        const { LocalNotifications } = await localNotificationsPlugin.catch((error) => {
            localNotificationsPlugin = null;
            throw error;
        });
        await LocalNotifications.schedule({
            notifications: [{ id, title: text.slice(0, split), body: text.slice(split + 2) }],
        });
    } catch (error) {
        log.warn('under-way alarms paused notice could not be posted:', error);
    }
}

async function keepAliveActive(): Promise<boolean> {
    // A browser tab has nothing that keeps it running once hidden.
    if (!Capacitor.isNativePlatform()) return false;
    try {
        // A voyage track, an anchor watch or MOB holds the background GPS
        // engine, which is what keeps iOS from suspending the app.
        const { BgGeoManager } = await import('../BgGeoManager');
        return (await BgGeoManager.getLeaseState()).active;
    } catch {
        return false;
    }
}

async function wentToBackground(): Promise<void> {
    const epoch = lifecycleEpoch;
    const keepAlive = await keepAliveActive();
    if (epoch !== lifecycleEpoch) return;
    await UnderwayAlarmWatch.onBackground(keepAlive);
}

function attachLifecycle(): void {
    if (lifecycleAttached) return;
    lifecycleAttached = true;
    if (Capacitor.isNativePlatform()) {
        // didEnterBackground / willEnterForeground, as the collision alarm uses:
        // appStateChange would read Control Centre or a call as a pause.
        void import('@capacitor/app')
            .then(({ App }) => {
                void App.addListener('pause', () => void wentToBackground());
                void App.addListener('resume', () => UnderwayAlarmWatch.onForeground());
            })
            .catch(() => undefined);
        return;
    }
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void wentToBackground();
        else UnderwayAlarmWatch.onForeground();
    });
}

// ── Running it ──────────────────────────────────────────────────────────────

// ── Smoke builds only ───────────────────────────────────────────────────────

/**
 * THALASSA_DEBUG_AIS_INJECTOR=1 builds only (126-02a, for the locked-phone +
 * Focus smoke at a marina dock): a fictional off-route excursion or shoal
 * reading around her real position, through the real rule, sound and lock
 * screen. Off route: a 4 NM line through where she first was for 15 s (so the
 * alarm arms), then the same line 0.4 NM west; her position is held there and
 * re-stamped each pass, since a phone lying still at a dock may report no new
 * fix. Shoal: 0.3 m under the keel off a live fictional sounder. Both make her
 * 4 kn under way. The build-time
 * constant is the literal false in every other build, so the branches
 * reading it fold away and nothing can set it.
 */
let debugScenario: {
    kind: UnderwayAlarmKind;
    startedAt: number;
    until: number;
    where?: { lat: number; lon: number };
    lines?: { on: RoutePoint[]; off: RoutePoint[] };
} | null = null;

/** Start (or with null, stop) a smoke scenario; either way the alarms start again from quiet. */
export function setDebugUnderway(next: { kind: UnderwayAlarmKind; startedAt: number; until: number } | null): void {
    if (!__THALASSA_DEBUG_AIS_INJECTOR__) return;
    debugScenario = next ? { ...next } : null;
    xte = XTE_START;
    shoal = SHOAL_START;
    followKey = null;
    publish(Date.now());
}

function withDebugScenario(inputs: UnderwayInputs): UnderwayInputs {
    const scenario = __THALASSA_DEBUG_AIS_INJECTOR__ ? debugScenario : null;
    if (!scenario) return inputs;
    if (inputs.nowMs >= scenario.until) {
        setDebugUnderway(null);
        return inputs;
    }
    const moving = { sogKn: 4, cogDeg: 0, atAnchor: false };
    if (scenario.kind === 'shoal') {
        return {
            ...inputs,
            ...moving,
            depth: {
                boatFeed: true,
                depthM: 0.3,
                reference: 'below-keel',
                offsetM: null,
                freshness: 'live',
                readingAt: inputs.nowMs,
            },
        };
    }
    if (!scenario.where && inputs.fix) scenario.where = { lat: inputs.fix.lat, lon: inputs.fix.lon };
    const where = scenario.where;
    if (!where) return inputs;
    const line = (centre: { lat: number; lon: number }) => [
        destinationPoint(centre.lat, centre.lon, 180, 2),
        destinationPoint(centre.lat, centre.lon, 0, 2),
    ];
    scenario.lines ??= { on: line(where), off: line(destinationPoint(where.lat, where.lon, 270, 0.4)) };
    const on = inputs.nowMs - scenario.startedAt < 15_000;
    return {
        ...inputs,
        ...moving,
        fix: { ...where, at: inputs.nowMs },
        zone: 'nearshore',
        following: { key: `debug-${scenario.startedAt}`, route: on ? scenario.lines.on : scenario.lines.off },
    };
}

function safePass(why: string): void {
    try {
        runUnderwayPass(withDebugScenario(readUnderwayInputs()));
    } catch (error) {
        log.warn(`under-way pass failed on ${why}:`, error);
    }
}

/** A burst of store updates gets one pass, a microtask after its first. */
function queuePass(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        if (!started || Date.now() - lastPassAt < MIN_PASS_GAP_MS) return;
        safePass('update');
    });
}

/** Start the app-wide watch. Idempotent; returns the stopper. */
export function startUnderwayAlarmWatch(): () => void {
    if (started) return stopUnderwayAlarmWatch;
    started = true;
    unsubscribers = [NmeaStore.subscribe(queuePass), useFollowRouteStore.subscribe(queuePass)];
    timer = setInterval(() => safePass('tick'), TICK_MS);
    safePass('start');
    return stopUnderwayAlarmWatch;
}

function stopRunning(): void {
    if (timer) clearInterval(timer);
    timer = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    started = false;
}

/** Stop watching, and stand down: an alarm with no watch behind it must not sound on. */
export function stopUnderwayAlarmWatch(): void {
    stopRunning();
    xte = XTE_START;
    shoal = SHOAL_START;
    followKey = null;
    routeRef = null;
    routeIndex = null;
    alongHint = undefined;
    context = { offRouteOn: false, shoalOn: false, underWay: false };
    armed = false;
    publish(Date.now());
}

export const UnderwayAlarmWatch = {
    async onBackground(keepAlive: boolean, _nowMs: number = Date.now()): Promise<void> {
        if (backgrounded) return;
        backgrounded = true;
        if (!armed || keepAlive) return;
        await localNotice(PAUSED_NOTICE_ID, UNDERWAY_NOTICES.paused);
    },

    onForeground(_nowMs: number = Date.now()): void {
        lifecycleEpoch += 1;
        backgrounded = false;
    },

    /** Test seam: resolves once every queued side effect has run. */
    whenIdle(): Promise<void> {
        return tail;
    },

    /** Test seam. */
    __resetForTests(): void {
        stopRunning();
        xte = XTE_START;
        shoal = SHOAL_START;
        followKey = null;
        routeRef = null;
        routeIndex = null;
        alongHint = undefined;
        context = { offRouteOn: false, shoalOn: false, underWay: false };
        armed = false;
        for (const voice of Object.values(voices)) {
            voice.token = null;
            voice.wanted = false;
            voice.alertLive = false;
        }
        tail = Promise.resolve();
        backgrounded = false;
        lifecycleAttached = false;
        lifecycleEpoch = 0;
        queued = false;
        lastPassAt = 0;
    },
};
