/**
 * The chart's orientation (127-11): one owner of the bearing.
 *
 * Shane 2026-10-09: "charts may need to have course-up, north-up and heading
 * up and track up. what do you think?", and 2026-10-10: "oh, um add in the
 * course up and north up etc. that is cool to see as well".
 *
 * 11a, the part every layer reads so that it stays right the moment the chart
 * turns:
 *   - whether a turning mode is on: the wind field's square and the ENC
 *     merge window take a shape any bearing fits inside;
 *   - the bearing a fit must keep (chartFitBearing): Mapbox's fitBounds turns
 *     the chart to 0 unless told, and the mode would turn it straight back;
 *   - the mark every orientation turn carries in its eventData, so Locate and
 *     the tracer's long press never take one for a move of their own.
 *
 * 11b, the modes and the controller that turns the chart (orientChart):
 *   - North up: 0.
 *   - Course up on Obs: the route ahead, from the point abeam of her to the
 *     point 0.3 NM further along; a new bearing replaces the held one only
 *     after it differs by 10° or more for 5 s, so a dense autorouted line's
 *     small bends never wobble the chart. Past the end, the last leg.
 *   - Course up on the planner: the selected pin's leg, else the first.
 *   - Track up: her course over the ground (her lanes, or the phone's own GPS
 *     course when the phone is all she has), North up below 1.0 kn for 20 s,
 *     back at 1.5 kn for 5 s.
 *   - Heading up: her TRUE heading from her compass only, never the legacy
 *     heading, the phone's compass or COG. The two-compass guard (the August
 *     'heading war' on Serene Summer: two sources 23-27° apart at rest) holds
 *     North up and says "Her compass is jumping between two headings".
 * A mode that cannot be honoured yet holds North up and says why (advice, not
 * walls), and turns the chart the moment its data arrives. It never turns
 * under a finger, mid-flight, or before the chart's first settle (A13).
 *
 * The gesture locks all stay (Shane 2026-05-18: "prevent the earth from
 * rotating on the chart page"): modes turn the chart, fingers never do.
 */
import type mapboxgl from 'mapbox-gl';
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';
import { pointAlongRoute, progressAlongRoute, type RoutePoint } from '../../services/routeProgress';
import { crumb } from '../../utils/flightRecorder';
import { onObsCameraClaim } from './obsCameraClaims';
import { angle, freshMetric, freshTime } from './ownshipDirection';
import { ownshipMotion, subscribeOwnshipMotion, type OwnshipMotion } from './ownshipMotion';

let turning = false;
let target: number | null = null;
const listeners = new Set<() => void>();

/** A mode that turns the chart (Course, Track or Heading up) is on, whatever it shows this moment. */
export const chartTurning = (): boolean => turning;

/**
 * The controller's word: whether a turning mode is on, and the bearing it
 * wants the chart at now (0 while it holds North up). Null when no controller
 * runs: fits then keep the chart's own bearing. Listeners hear only a flip.
 */
export function setChartOrientation(next: { turning: boolean; target: number | null }): void {
    const flip = next.turning !== turning;
    turning = next.turning;
    target = next.target !== null && Number.isFinite(next.target) ? next.target : null;
    if (flip) for (const listener of [...listeners]) listener();
}

export function subscribeChartTurning(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The chart's bearing now; 0 for a map that cannot say (a torn-down map, a test double). */
export function chartBearing(map: Pick<mapboxgl.Map, 'getBearing'>): number {
    try {
        const bearing = map.getBearing();
        return Number.isFinite(bearing) ? bearing : 0;
    } catch {
        return 0;
    }
}

/** The bearing every fit on the chart names: the mode's target, else the chart's own (0 north up). */
export const chartFitBearing = (map: Pick<mapboxgl.Map, 'getBearing'>): number => target ?? chartBearing(map);

/** An orientation turn, by the mark in its eventData; never a gesture, Locate or a fit. */
export const isOrientationEvent = (event: unknown): boolean =>
    (event as { thalassaOrientation?: unknown } | null)?.thalassaOrientation === true;

// ── 11b: the modes ─────────────────────────────────────────────────────

export type ChartMode = 'north' | 'course' | 'track' | 'heading';
/** Obs and the planner keep their own choice (the base picker's precedent, Shane 2026-07-17). */
export type ChartSurface = 'obs' | 'plan';
/** Why a chosen mode holds the chart North up for now; the chooser says it in words. */
export type OrientReason = 'noroute' | 'slow' | 'noheading' | 'twocompass' | 'nolegs';
/** What one mode would show now: a bearing, or why North up. */
export interface ModeStatus {
    target: number | null;
    reason: OrientReason | null;
}
export interface ChartOrientationView {
    /** The surface whose controller runs; null when none does (Obs hidden, another surface). */
    surface: ChartSurface | null;
    mode: ChartMode;
    /** The bearing its mode turns the chart to; null North up (chosen, or held for `reason`). */
    target: number | null;
    reason: OrientReason | null;
    /** What each turning mode would show now, for the chooser's rows. */
    modes: Record<Exclude<ChartMode, 'north'>, ModeStatus>;
}

/**
 * Shane's question 1 (127-11, "For Shane"): may the chart move itself to keep
 * her on screen in Course, Track and Heading up? Our recommendation, recorded:
 * yes, on in the turning modes until he says otherwise. North up never moves
 * the camera on its own.
 */
export const KEEP_HER_ON_SCREEN = true;

/** One key per surface on this device: never an account setting (a phone in Heading up never turns the desk). */
export const orientationKey = (surface: ChartSurface): string => `thalassa_chart_orientation_${surface}_v1`;

/** The mode last picked on this device for the surface; North up for none, an unknown one, or blocked storage. */
export function savedChartMode(surface: ChartSurface): ChartMode {
    let mode: string | null = null;
    try {
        mode = localStorage.getItem(orientationKey(surface));
    } catch {
        /* a private window or blocked storage: North up */
    }
    // The planner offers North up and Course up only.
    return mode === 'course' || (surface === 'obs' && (mode === 'track' || mode === 'heading')) ? mode : 'north';
}

const norm = (deg: number): number => ((deg % 360) + 360) % 360;
/** The signed shortest turn from one bearing to another, (-180, 180]: 350° to 10° is +20°. */
export const arc = (from: number, to: number): number => {
    const d = norm(to - from);
    return d > 180 ? d - 360 : d;
};
/** One step of a circular EMA by the time since the last sample, the short way round. */
export const emaStep = (prev: number | null, value: number, dtMs: number, tauMs: number): number =>
    prev === null ? norm(value) : norm(prev + arc(prev, value) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs)));

/** The planner's Course up: the selected pin's leg, else the first; the last pin, the leg into it. */
export function plannerLegBearing(pins: readonly RoutePoint[], selected: number | null | undefined): number | null {
    if (pins.length < 2) return null;
    const i = Math.max(0, Math.min(selected ?? 0, pins.length - 2));
    return calculateBearing(pins[i].lat, pins[i].lon, pins[i + 1].lat, pins[i + 1].lon);
}

const KN = 1.9438444924;

/** Her motion by her lane's gates: null for no fix, a stale one, or her held fix (history). */
function readHer(m: OwnshipMotion | null, now: number) {
    if (!m || m.lane === 'held' || !freshTime(m.at, now, m.maxAgeMs)) return null;
    const { instruments: i, maxAgeMs: age } = m;
    const vessel = m.lane !== 'phone';
    // The phone's geolocation heading is its course over ground; her lanes never lend it a compass.
    const cog = vessel ? (freshMetric(i.cog, now, age) && angle(i.cog.value) ? i.cog : null) : null;
    const hdg = vessel && freshMetric(i.headingTrue, now, age) && angle(i.headingTrue.value) ? i.headingTrue : null;
    return {
        lat: m.lat,
        lon: m.lon,
        sog: vessel
            ? freshMetric(i.sog, now, age)
                ? i.sog.value
                : null
            : m.speed !== null && Number.isFinite(m.speed)
              ? m.speed * KN
              : null,
        cog: vessel ? (cog?.value ?? null) : angle(m.heading) ? m.heading : null,
        cogAt: vessel ? (cog?.lastUpdated ?? 0) : m.at,
        hdg: hdg?.value ?? null,
        hdgAt: hdg?.lastUpdated ?? 0,
    };
}
type Her = NonNullable<ReturnType<typeof readHer>>;

/**
 * A steadied bearing: a circular EMA of its samples (one per sample time),
 * shown only when it has moved `minDeg` or more and no sooner than `gapMs`
 * after the last change, and then either once the samples agree with it (the
 * turn is over) or while it is 30° or more behind (a long turn is followed).
 * So the small wander of a boat holding her course never turns the chart, and
 * a turn takes a few eases, not one per sample.
 */
function steady(tauMs: number, minDeg: number, gapMs: number) {
    let ema: number | null = null;
    let raw = 0;
    let at = 0;
    let out: number | null = null;
    let outAt = -Infinity;
    return {
        feed(value: number, t: number) {
            if (t === at) return;
            ema = emaStep(ema, value, t - at, tauMs);
            raw = value;
            at = t;
        },
        /** The bearing to show; `hold` keeps the last one (a suspected second compass). */
        get(now: number, hold = false): number | null {
            const d = ema === null || out === null ? 0 : Math.abs(arc(out, ema));
            if (
                ema !== null &&
                !hold &&
                (out === null || (now - outAt >= gapMs && d >= minDeg && (d >= 30 || Math.abs(arc(ema, raw)) < minDeg)))
            ) {
                out = ema;
                outAt = now;
            }
            return out;
        },
        reset() {
            ema = out = null;
            at = 0;
        },
    };
}

const north = (reason: OrientReason): ModeStatus => ({ target: null, reason });
const shows = (bearing: number | null, reason: OrientReason): ModeStatus =>
    bearing === null ? north(reason) : { target: bearing, reason: null };

/** Track up: her course over the ground, τ 8 s, turns at 6° or more, at most every 4 s. */
function trackUp() {
    const s = steady(8_000, 6, 4_000);
    let moving = false;
    let fastSince: number | null = null;
    let slowSince: number | null = null;
    return (her: Her | null, now: number): ModeStatus => {
        const kn = her?.sog ?? null;
        if (kn !== null && kn >= 1.5) {
            slowSince = null;
            fastSince ??= now;
            if (now - fastSince >= 5_000) moving = true;
        } else if (kn === null || kn < 1) {
            fastSince = null;
            slowSince ??= now;
            if (now - slowSince >= 20_000) {
                moving = false;
                s.reset();
            }
        } else fastSince = slowSince = null;
        if (her && her.cog !== null && kn !== null && kn >= 1) s.feed(her.cog, her.cogAt);
        return shows(moving ? s.get(now) : null, 'slow');
    };
}

/**
 * Heading up: her true heading, τ 3 s, turns at 4° or more, at most every 2 s.
 * The two-compass guard: over the last 60 s, jumps of 15° or more from one
 * sample to the next that reverse twice (A→B→A→B) while she is stopped (SOG
 * under 0.5 kn) or her COG holds within 5° are two sources, not a turning
 * boat (a tack moves her COG too). The small or nil steps between jumps do
 * not count: a source that holds for several samples (the Pi's 2 s poll, the
 * gateway's 5 s aggregate) is still one side of the war. North up then,
 * until 60 s pass with no jump; the first jump already holds the chart where
 * it is, so it never swings to the other compass first.
 */
function headingUp() {
    const s = steady(3_000, 4, 2_000);
    let log: Array<{ t: number; sog: number | null; cog: number | null }> = [];
    let jumps: Array<{ t: number; up: boolean }> = [];
    let last: number | null = null;
    let lastAt = 0;
    let tripped = false;
    let suspect = false;
    return (her: Her | null, now: number): ModeStatus => {
        if (her?.hdg == null) {
            // A heading that comes back after a gap is not a jump.
            last = null;
            return north('noheading');
        }
        const recent = (x: { t: number }) => now - x.t < 60_000;
        if (her.hdgAt !== lastAt) {
            lastAt = her.hdgAt;
            const step = last === null ? 0 : arc(last, her.hdg);
            last = her.hdg;
            log = [...log.filter(recent), { t: now, sog: her.sog, cog: her.cog }];
            jumps = jumps.filter(recent);
            if (Math.abs(step) >= 15) jumps.push({ t: now, up: step > 0 });
            const flips = jumps.filter((x, i) => i && x.up !== jumps[i - 1].up).length;
            const first = log[0].cog;
            const still =
                log.every((x) => x.sog !== null && x.sog < 0.5) ||
                (first !== null && log.every((x) => x.cog !== null && Math.abs(arc(first, x.cog)) <= 5));
            suspect = still && jumps.length > 0;
            if (still && flips >= 2) tripped = true;
            s.feed(her.hdg, her.hdgAt);
        }
        if (tripped && !jumps.some(recent)) tripped = suspect = false;
        return tripped ? north('twocompass') : shows(s.get(now, suspect), 'noheading');
    };
}

/** Course up on Obs: the route ahead, held until it differs by 10° or more for 5 s. */
function courseUp() {
    let held: number | null = null;
    let offSince: number | null = null;
    let along: number | undefined;
    let seen: unknown[] = [];
    let ahead: number | null = null;
    return (route: readonly RoutePoint[] | null | undefined, her: Her | null, now: number): ModeStatus => {
        if (!route || !her) {
            held = offSince = null;
            return north('noroute');
        }
        // Measured again only when she moves or the route changes.
        if (seen[0] !== route || seen[1] !== her.lat || seen[2] !== her.lon) {
            // A new route starts its own hold and its own reckoning.
            if (seen[0] !== route) {
                held = null;
                along = undefined;
            }
            seen = [route, her.lat, her.lon];
            const p = progressAlongRoute(route, her, { alongNm: along, headingDeg: her.cog ?? undefined });
            const to = p && pointAlongRoute(route, p.alongNm + 0.3);
            along = p?.alongNm;
            ahead =
                !p || !to
                    ? null
                    : calculateDistance(p.abeam.lat, p.abeam.lon, to.lat, to.lon) > 0.01
                      ? calculateBearing(p.abeam.lat, p.abeam.lon, to.lat, to.lon)
                      : to.bearingDeg;
        }
        if (ahead === null) return north('noroute');
        if (held === null || Math.abs(arc(held, ahead)) < 10) {
            held ??= ahead;
            offSince = null;
        } else if (now - (offSince ??= now) >= 5_000) {
            held = ahead;
            offSince = null;
        }
        return shows(held, 'noroute');
    };
}

let view: ChartOrientationView = {
    surface: null,
    mode: 'north',
    target: null,
    reason: null,
    modes: { course: north('noroute'), track: north('slow'), heading: north('noheading') },
};
const viewListeners = new Set<() => void>();
const setView = (next: ChartOrientationView) => {
    if (JSON.stringify(next) === JSON.stringify(view)) return;
    view = next;
    for (const listener of [...viewListeners]) listener();
};

/** What the chart's orientation shows and could show now, for the arrow, the rose and the chooser. */
export const chartOrientationView = (): ChartOrientationView => view;
export function subscribeChartOrientation(listener: () => void): () => void {
    viewListeners.add(listener);
    return () => {
        viewListeners.delete(listener);
    };
}

/** The running controller (one chart turns at a time: Obs's or the planner's). */
let current: { map: mapboxgl.Map; pick(mode: ChartMode): void; follow(): void } | null = null;

/** The skipper's pick on the surface showing: kept on this device, applied at once. */
export const pickChartMode = (mode: ChartMode): void => current?.pick(mode);

/** Locate went to her: keeping her on screen comes back on (a pan or a claim stood it down). */
export function keepHerOnScreen(map: mapboxgl.Map): void {
    if (current?.map === map) current.follow();
}

let framed = 0;
/**
 * The passage's whole-route overview holds the camera (usePassageRouteFrame):
 * it already keeps her and the route in view, so keeping her on screen stands
 * down until it lets go; else the two would take the camera in turn every
 * 20 s. Returns the release.
 */
export function holdChartFrame(): () => void {
    framed++;
    return () => void framed--;
}

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
const MARK = { thalassaOrientation: true };

/**
 * Turn `map` by the surface's mode until stopped. `inputs` gives Obs its
 * route ahead and the planner its leg; call refresh() when either changes.
 * Stopping (Obs hidden, the surface gone) leaves no listener or timer behind,
 * and puts the chart North up for whatever shows next.
 */
export function orientChart(
    map: mapboxgl.Map,
    surface: ChartSurface,
    inputs: () => { route?: readonly RoutePoint[] | null; leg?: number | null; pivot?: RoutePoint | null },
): { refresh: () => void; stop: () => void } {
    let mode = savedChartMode(surface);
    const course = courseUp();
    const track = trackUp();
    const heading = headingUp();
    // The late start (A13): nothing turns before the chart's first settle,
    // when the Obs startup camera has placed it.
    let started = map.loaded?.() ?? true;
    let down = false;
    let upAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let follow = true;
    let keptAt = -Infinity;
    let said = '';
    let her: Her | null = null;

    /** Where a place is on screen, with the view's size; no point when it is off it. */
    const seen = (at: RoutePoint | null | undefined): [{ x: number; y: number } | null, number, number] => {
        const { clientWidth: w, clientHeight: h } = map.getContainer();
        const p = at && map.project([at.lon, at.lat]);
        return [p && p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h ? p : null, w, h];
    };

    /**
     * Ease to the mode's bearing, about her when she is on screen (she stays
     * put while the chart swings round her); on the planner, about the leg's
     * own pin. Never mid-flight or under a finger: then at the next moveend,
     * or 300 ms after the finger lifts.
     */
    const turn = () => {
        clearTimeout(timer);
        const from = chartBearing(map);
        const by = arc(from, view.target ?? 0);
        if (!started || Math.abs(by) < 0.5 || down || map.isMoving()) return;
        const wait = upAt + 300 - Date.now();
        if (wait > 0) {
            timer = setTimeout(turn, wait);
            return;
        }
        const pivot = her ?? inputs().pivot;
        const [at] = seen(pivot);
        map.easeTo(
            {
                bearing: from + by,
                duration: reducedMotion() ? 0 : Math.min(1200, Math.max(300, 12 * Math.abs(by))),
                easing: (k: number) => 1 - (1 - k) ** 3,
                around: at && pivot ? [pivot.lon, pivot.lat] : undefined,
            },
            MARK,
        );
    };

    const evaluate = () => {
        const now = Date.now();
        her = readHer(ownshipMotion(), now);
        const { route, leg } = inputs();
        const modes = {
            course: surface === 'plan' ? shows(leg ?? null, 'nolegs') : course(route, her, now),
            track: track(her, now),
            heading: heading(her, now),
        };
        const status = mode === 'north' ? null : modes[mode];
        setChartOrientation({ turning: !!status, target: status?.target ?? 0 });
        setView({ surface, mode, target: status?.target ?? null, reason: status?.reason ?? null, modes });
        // Flight-recorder crumbs on a change of mode or fallback only, never a coordinate.
        const words = `${mode}${status?.reason ? `→north ${status.reason}` : ''}`;
        if (words !== said) crumb('chart:orient', (said = words));
        turn();
        // Keep her on screen: in a turning mode, making way, she has left the
        // middle 60% of the view. One move to the lower third, at most every 20 s.
        if (
            !KEEP_HER_ON_SCREEN ||
            !status ||
            !follow ||
            framed ||
            !started ||
            !her ||
            !((her.sog ?? 0) >= 1) ||
            down ||
            map.isMoving() ||
            now - keptAt < 20_000
        )
            return;
        // Measured only now: the view's size is a layout read.
        const [at, w, h] = seen(her);
        if (at && (at.x < w * 0.2 || at.x > w * 0.8 || at.y < h * 0.2 || at.y > h * 0.8)) {
            keptAt = now;
            map.easeTo({ center: [her.lon, her.lat], offset: [0, h / 6], duration: reducedMotion() ? 0 : 800 }, MARK);
        }
    };

    // A pan or a pinch is the skipper's: keeping her on screen stands down
    // until Locate. The zoom buttons (a click) leave it be.
    const standDown = (event?: unknown) => {
        const original = (event as { originalEvent?: Event }).originalEvent;
        if (original && original.type !== 'click') follow = false;
    };
    // The map's own events, so a finger released off the chart still lifts
    // (Mapbox hears mouseup on the window, and a drag ends with dragend).
    const events: Array<[string, (event?: unknown) => void]> = [
        // Off the event, never inside it: Mapbox fires an interrupted ease's
        // moveend from stop(), at the start of the jumpTo, fitBounds or
        // flight that interrupts it. An ease started there would begin from
        // the camera as it was before that move and put it back on the next
        // frame. Deferred, the move lands first; a flight still in the air
        // is turned at its own moveend.
        [
            'moveend',
            () => {
                clearTimeout(timer);
                timer = setTimeout(turn, 0);
            },
        ],
        // The late start (A13): the first settle, after the Obs startup camera.
        [
            'idle',
            () => {
                started = true;
                evaluate();
            },
        ],
        ['dragstart', standDown],
        ['zoomstart', standDown],
        ...(['mousedown', 'touchstart'].map((type) => [type, () => (down = true)]) as Array<[string, () => void]>),
        ...(['mouseup', 'touchend', 'touchcancel', 'dragend'].map((type) => [
            type,
            () => {
                if (!down) return;
                down = false;
                upAt = Date.now();
                turn();
            },
        ]) as Array<[string, () => void]>),
    ];
    const loose = map as unknown as Record<'on' | 'off', (type: string, listener: (event?: unknown) => void) => void>;
    for (const [type, listener] of events) loose.on(type, listener);
    const unclaim = onObsCameraClaim((claimed) => {
        if (claimed === map) follow = false;
    });
    const unhear = subscribeOwnshipMotion(evaluate);

    const self = {
        map,
        pick(next: ChartMode) {
            mode = next;
            try {
                localStorage.setItem(orientationKey(surface), next);
            } catch {
                /* blocked storage: the pick lasts this session */
            }
            evaluate();
        },
        follow() {
            follow = true;
            keptAt = -Infinity;
        },
    };
    current = self;
    evaluate();

    return {
        refresh: evaluate,
        stop() {
            clearTimeout(timer);
            unhear();
            unclaim();
            for (const [type, listener] of events) loose.off(type, listener);
            if (current === self) current = null;
            setChartOrientation({ turning: false, target: null });
            setView({ ...view, surface: null, mode: 'north', target: null, reason: null });
            if (Math.abs(chartBearing(map)) >= 0.5) map.jumpTo({ bearing: 0 }, MARK);
        },
    };
}
