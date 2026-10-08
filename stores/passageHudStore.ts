/**
 * passageHudStore — is the Obs chart's passage pane open?
 *
 * Shane, 2026-09-17, three days under way to Gladstone: "the only real issue
 * i have is i dont really know which screen to look at, so i am thinking we
 * need a new layer on the obs page. this layer will show cog, sog, wind speed,
 * direction and true and apparent … most of the info needs to be on a pane
 * that can be hidden to one side (left i am thinking)."
 *
 * NO SWITCH (build 124, Shane 2026-10-08: "I don't think that we need a setting
 * for it. It should just be the standard setup for routes. Or tracks on the log
 * page."). The pane is on the chart whenever there is something to show — a
 * followed route, a recording running or paused, or a route PREVIEWED on Obs
 * (below) — see hooks/usePassageHudAvailable. This module keeps only whether
 * the readings are open or tucked away, remembered on this device. Same shape
 * as chartPassageOverlay: a module value, a listener set, and
 * useSyncExternalStore for the components — no zustand, nothing to hydrate.
 *
 * PHASE 2 — LOOK AHEAD (Shane 2026-09-18: "ok next phase"). The same module
 * now carries the one time axis the chart shares while the skipper is looking
 * ahead along the route:
 *
 *   lookAhead.on       — false = LIVE. Nothing on the chart is a forecast.
 *   lookAhead.departureMs — a chosen departure time, or null to follow NOW.
 *   lookAhead.aheadMs  — elapsed passage time after that departure. Legacy
 *                        rolling looks stay +6 h from NOW when parked at +6 h.
 *   lookAhead.playing  — the scrubber is running itself forward.
 *
 * Three readers, one writer each way: the strip (forecast cells), the ghost on
 * the chart (useRouteGhostMarker) and the wind timeline (useWeatherLayers) all
 * follow `aheadMs`; the wind timeline reports back how many hours of field it
 * actually has, so the scrubber can say where the chart's wind stops instead
 * of holding its last frame under a ghost that has sailed on.
 *
 * NEVER PERSISTED. Look-ahead is a glance, not a state to boot into: the chart
 * must never open showing tomorrow's wind to someone who did not ask for it.
 *
 * THE PREVIEW (build 124). A route pulled up on Obs (Layers → Routes) that is
 * not the followed one is previewed on the pane: looked ahead from its first
 * point at a departure the skipper chooses, labelled "Preview — not following".
 * The chart publishes it here (components/map/mapHub/obsRoutePick); nothing in
 * it is follow state, and it is never persisted either.
 */
import { useSyncExternalStore } from 'react';
import { PASSAGE_DEPARTURE_MAX_MS } from '../services/passageDeparture';
import type { RoutePoint } from '../services/routeProgress';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../services/authIdentityScope';
import { isPassageOverlayOn, setPassageOverlay, subscribePassageOverlay } from './chartPassageOverlay';

export { PASSAGE_DEPARTURE_MAX_MS } from '../services/passageDeparture';

const KEY = 'thalassa_passage_hud_open_v1';

const read = (): boolean => {
    try {
        return localStorage.getItem(KEY) === '1';
    } catch {
        return false;
    }
};

let open = read();
// OBS starts with no layers: a launch never applies the HUD's weather layers.
// Only an activation (a recording starting, below) does, once.
let activation = 0;
const activatedRecordings = new Set<string>();
const listeners = new Set<() => void>();

export function isPassageHudOpen(): boolean {
    return open;
}

export function setPassageHudOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    // Collapse only hides the instruments. The bottom scrubber keeps the same
    // forecast time, playback and ghost, with its own way back to live.
    try {
        if (next) localStorage.setItem(KEY, '1');
        else localStorage.removeItem(KEY);
    } catch {
        /* storage unavailable — the in-session value still rules */
    }
    listeners.forEach((fn) => fn());
}

export function togglePassageHud(): void {
    setPassageHudOpen(!open);
}

export function subscribePassageHud(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function usePassageHudOpen(): boolean {
    return useSyncExternalStore(subscribePassageHud, isPassageHudOpen, isPassageHudOpen);
}

/** A new recording gets one set of initial layers, without enforcing them later. */
export function getPassageHudActivation(): number {
    return activation;
}

export function usePassageHudActivation(): number {
    return useSyncExternalStore(subscribePassageHud, getPassageHudActivation, getPassageHudActivation);
}

/** Repeated recorder updates and same-voyage resumes respect the skipper's display choices. */
export function activatePassageHudForRecording(recordingId: string): void {
    const id = recordingId.trim();
    if (!id) return;
    const scope = getAuthIdentityScope();
    const key = JSON.stringify([scope.key, scope.generation, id]);
    if (activatedRecordings.has(key)) return;
    activatedRecordings.add(key);
    stopPassageLookAhead();
    activation += 1;
    // A recording starting brings the passage up, as the old switch did.
    overviewAsked = true;
    listeners.forEach((fn) => fn());
    setPassageHudOpen(true);
    setPassageOverlay(true);
}

// ── The whole-route overview: asked for, never implied ─────────
//
// The overview (components/map/usePassageRouteFrame) fits the whole followed
// route and the boat, and takes the camera back after any programmatic move.
// Before build 124 it engaged only once the skipper switched the HUD on. With
// no switch, being on the chart is not enough: a plain Layers → Passage toggle
// must not move the camera (Obs: layer toggles never do). So it waits for an
// ask — the HUD's own Route & track or Ahead, or a recording starting — and
// the ask lasts while the Passage overlay stays on. Session-only, never stored.

let overviewAsked = false;

export function isPassageOverviewAsked(): boolean {
    return overviewAsked;
}

/** The HUD asks for the passage on the chart, framed whole. Call before turning the overlay on. */
export function askPassageOverview(): void {
    if (overviewAsked) return;
    overviewAsked = true;
    listeners.forEach((fn) => fn());
}

export function usePassageOverviewAsked(): boolean {
    return useSyncExternalStore(subscribePassageHud, isPassageOverviewAsked, isPassageOverviewAsked);
}

// The overlay going off (Layers, a pick, an account change) withdraws the ask.
subscribePassageOverlay(() => {
    if (!overviewAsked || isPassageOverlayOn()) return;
    overviewAsked = false;
    listeners.forEach((fn) => fn());
});

// ── The preview: a route pulled up on Obs, not followed ────────

export interface PassageHudPreviewRoute {
    id: string;
    /** What the chart's Routes picker calls it. */
    label: string;
    /** The line as drawn on the chart — the same array, so caches key on it. */
    points: readonly RoutePoint[];
}

let preview: PassageHudPreviewRoute | null = null;
const previewListeners = new Set<() => void>();

export function getPassageHudPreviewRoute(): PassageHudPreviewRoute | null {
    return preview;
}

/**
 * Set or clear the previewed route. Any change ends a running look-ahead: the
 * ghost, its line and the scrubber belonged to the route that was on screen.
 * Writes nothing anywhere else — a preview is not a follow.
 */
export function setPassageHudPreviewRoute(next: PassageHudPreviewRoute | null): void {
    const clean = next && next.points.length >= 2 ? next : null;
    if (
        clean === preview ||
        (clean &&
            preview &&
            clean.id === preview.id &&
            clean.label === preview.label &&
            clean.points === preview.points)
    ) {
        return;
    }
    preview = clean;
    stopPassageLookAhead();
    previewListeners.forEach((fn) => fn());
}

export function subscribePassageHudPreviewRoute(fn: () => void): () => void {
    previewListeners.add(fn);
    return () => {
        previewListeners.delete(fn);
    };
}

export function usePassageHudPreviewRoute(): PassageHudPreviewRoute | null {
    return useSyncExternalStore(subscribePassageHudPreviewRoute, getPassageHudPreviewRoute, getPassageHudPreviewRoute);
}

// ── Look ahead ─────────────────────────────────────────────────

/** Shane 2026-09-18: "lets get it out to 7 days". */
export const LOOK_AHEAD_MAX_MS = 7 * 24 * 3_600_000;

export interface PassageLookAhead {
    on: boolean;
    /** Fixed departure in epoch milliseconds; null preserves the rolling NOW axis. */
    departureMs: number | null;
    aheadMs: number;
    playing: boolean;
}

const LIVE: PassageLookAhead = Object.freeze({ on: false, departureMs: null, aheadMs: 0, playing: false });
// A NEW object on every change and the SAME object otherwise — what
// useSyncExternalStore needs from a snapshot.
let lookAhead: PassageLookAhead = LIVE;
const lookAheadListeners = new Set<() => void>();

function setLookAhead(next: PassageLookAhead): void {
    if (
        next.on === lookAhead.on &&
        next.departureMs === lookAhead.departureMs &&
        next.aheadMs === lookAhead.aheadMs &&
        next.playing === lookAhead.playing
    )
        return;
    lookAhead = next.on ? next : LIVE;
    lookAheadListeners.forEach((fn) => fn());
}

export function getPassageLookAhead(): PassageLookAhead {
    return lookAhead;
}

export function subscribePassageLookAhead(fn: () => void): () => void {
    lookAheadListeners.add(fn);
    return () => {
        lookAheadListeners.delete(fn);
    };
}

export function usePassageLookAhead(): PassageLookAhead {
    return useSyncExternalStore(subscribePassageLookAhead, getPassageLookAhead, getPassageLookAhead);
}

const isLookingAhead = (): boolean => lookAhead.on;

/**
 * Just the on/off. For the chart furniture that only needs to step aside: the
 * full snapshot changes at pointer rate during a drag, and re-rendering the
 * weather controls sixty times a second to learn "still on" is pure waste.
 */
export function usePassageLookAheadOn(): boolean {
    return useSyncExternalStore(subscribePassageLookAhead, isLookingAhead, isLookingAhead);
}

/**
 * Choose a fixed departure from now through five days ahead and reset the
 * passage clock. Null explicitly resets to a rolling NOW departure; an
 * omitted date starts idempotently. Invalid dates leave the look unchanged.
 */
export function startPassageLookAhead(departureMs?: number | null): void {
    if (departureMs === undefined) {
        if (lookAhead.on) return;
        setLookAhead({ on: true, departureMs: null, aheadMs: 0, playing: false });
        return;
    }
    if (departureMs === null) {
        setLookAhead({ on: true, departureMs: null, aheadMs: 0, playing: false });
        return;
    }
    const now = Date.now();
    if (!Number.isFinite(departureMs) || departureMs < now || departureMs > now + PASSAGE_DEPARTURE_MAX_MS) return;
    setLookAhead({ on: true, departureMs, aheadMs: 0, playing: false });
}

/** Back to LIVE. Also forgets the ghost: there is no ghost of the present. */
export function stopPassageLookAhead(): void {
    setLookAhead(LIVE);
    publishPassageGhost(null);
    publishPassageGhostPath(null);
    publishPassageGhostJoinPath(null);
}

/** Move the scrubber. Ignored while live; clamped to 0…`maxMs` (≤ 7 days). */
export function setPassageAheadMs(ms: number, maxMs: number = LOOK_AHEAD_MAX_MS): void {
    if (!lookAhead.on || !Number.isFinite(ms)) return;
    const ceiling = Math.max(0, Math.min(Number.isFinite(maxMs) ? maxMs : LOOK_AHEAD_MAX_MS, LOOK_AHEAD_MAX_MS));
    setLookAhead({ ...lookAhead, aheadMs: Math.max(0, Math.min(ms, ceiling)) });
}

export function setPassageLookAheadPlaying(playing: boolean): void {
    if (!lookAhead.on) return;
    setLookAhead({ ...lookAhead, playing });
}

// ── The ghost ──────────────────────────────────────────────────

/** Where she will be at the scrubbed moment, for the chart to draw. */
export interface PassageGhost {
    lat: number;
    lon: number;
    /** The way the route runs there, degrees true. */
    bearingDeg: number;
    /** Short chip under the ghost — "+6 h". */
    label: string;
}

let ghost: PassageGhost | null = null;
/**
 * The water still to sail: from the point abeam of the boat to the route's
 * end. The Obs chart stopped drawing the followed route on its own account on
 * 2026-08-03 ("remove all of the spaghetti"), and the Passage overlay only
 * draws a line it can match to an active voyage — so without this a ghost can
 * ride a line nobody can see. Drawn for exactly as long as the glance lasts:
 * opt-in per look, which is the shape Shane asked routes on this chart to be.
 */
let ghostPath: readonly RoutePoint[] | null = null;
/** Unchecked forecast approach from the actual fix to the route, separate from the followed geometry. */
let ghostJoinPath: readonly RoutePoint[] | null = null;
const ghostListeners = new Set<() => void>();

export function getPassageGhostPath(): readonly RoutePoint[] | null {
    return ghostPath;
}

function sameGhostPath(a: readonly RoutePoint[] | null, b: readonly RoutePoint[] | null): boolean {
    return (
        a === b || (!!a && !!b && a.length === b.length && a.every((p, i) => p.lat === b[i].lat && p.lon === b[i].lon))
    );
}

export function publishPassageGhostPath(next: readonly RoutePoint[] | null): void {
    const clean = next && next.length >= 2 ? next : null;
    if (sameGhostPath(clean, ghostPath)) return;
    ghostPath = clean;
    ghostListeners.forEach((fn) => fn());
}

export function getPassageGhostJoinPath(): readonly RoutePoint[] | null {
    return ghostJoinPath;
}

export function publishPassageGhostJoinPath(next: readonly RoutePoint[] | null): void {
    const clean = next && next.length >= 2 ? next : null;
    if (sameGhostPath(clean, ghostJoinPath)) return;
    ghostJoinPath = clean;
    ghostListeners.forEach((fn) => fn());
}

export function getPassageGhost(): PassageGhost | null {
    return ghost;
}

export function subscribePassageGhost(fn: () => void): () => void {
    ghostListeners.add(fn);
    return () => {
        ghostListeners.delete(fn);
    };
}

export function publishPassageGhost(next: PassageGhost | null): void {
    if (next === ghost) return;
    if (
        next &&
        ghost &&
        next.lat === ghost.lat &&
        next.lon === ghost.lon &&
        next.bearingDeg === ghost.bearingDeg &&
        next.label === ghost.label
    ) {
        return;
    }
    ghost = next;
    ghostListeners.forEach((fn) => fn());
}

// ── How much wind the chart actually has ───────────────────────

/**
 * Hours of wind field after the selected departure (NOW for a rolling look).
 * Zero means no future coverage from that departure; null means the layer is
 * off or its coverage is unavailable. The scrubber says where the field stops.
 */
let windCoverageHours: number | null = null;
const windCoverageListeners = new Set<() => void>();

export function getPassageWindCoverageHours(): number | null {
    return windCoverageHours;
}

export function reportPassageWindCoverage(hours: number | null): void {
    const next = hours !== null && Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 10) / 10 : null;
    if (next === windCoverageHours) return;
    windCoverageHours = next;
    windCoverageListeners.forEach((fn) => fn());
}

// Module-level, so useSyncExternalStore sees ONE subscribe function and does
// not tear down and re-add its listener on every render.
function subscribePassageWindCoverage(fn: () => void): () => void {
    windCoverageListeners.add(fn);
    return () => {
        windCoverageListeners.delete(fn);
    };
}

export function usePassageWindCoverageHours(): number | null {
    return useSyncExternalStore(subscribePassageWindCoverage, getPassageWindCoverageHours, getPassageWindCoverageHours);
}

// ── How the ghost makes her way (phase 3) ──────────────────────

/**
 * 'polar' — by the wind: the vessel's polar, scaled to her cruising speed,
 * tacking inside her close-hauled angle and motoring when it gets slow.
 * 'cruise' — phase 2's flat cruising speed, exactly as Shane first asked for it.
 * A PREFERENCE, so unlike the look-ahead itself it is remembered on this device.
 */
export type PassageSpeedPref = 'polar' | 'cruise';
const SPEED_KEY = 'thalassa_passage_speed_mode_v1';
const readSpeedPref = (): PassageSpeedPref => {
    try {
        return localStorage.getItem(SPEED_KEY) === 'cruise' ? 'cruise' : 'polar';
    } catch {
        return 'polar';
    }
};
let speedPref: PassageSpeedPref = readSpeedPref();
const speedPrefListeners = new Set<() => void>();

export function getPassageSpeedPref(): PassageSpeedPref {
    return speedPref;
}

export function setPassageSpeedPref(next: PassageSpeedPref): void {
    if (next === speedPref) return;
    speedPref = next;
    try {
        if (next === 'cruise') localStorage.setItem(SPEED_KEY, 'cruise');
        else localStorage.removeItem(SPEED_KEY);
    } catch {
        /* storage unavailable — the in-session value still rules */
    }
    speedPrefListeners.forEach((fn) => fn());
}

function subscribePassageSpeedPref(fn: () => void): () => void {
    speedPrefListeners.add(fn);
    return () => {
        speedPrefListeners.delete(fn);
    };
}

export function usePassageSpeedPref(): PassageSpeedPref {
    return useSyncExternalStore(subscribePassageSpeedPref, getPassageSpeedPref, getPassageSpeedPref);
}

// ── How far the chart's RAIN reaches ───────────────────────────

/**
 * Hours after the selected departure (NOW for a rolling look) that rain
 * imagery can follow. Zero means no future coverage; null means the layer is
 * off or has no frame it can put a clock time on. Twin of wind coverage above.
 */
let rainCoverageHours: number | null = null;
const rainCoverageListeners = new Set<() => void>();

export function getPassageRainCoverageHours(): number | null {
    return rainCoverageHours;
}

export function reportPassageRainCoverage(hours: number | null): void {
    const next = hours !== null && Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 10) / 10 : null;
    if (next === rainCoverageHours) return;
    rainCoverageHours = next;
    rainCoverageListeners.forEach((fn) => fn());
}

function subscribePassageRainCoverage(fn: () => void): () => void {
    rainCoverageListeners.add(fn);
    return () => {
        rainCoverageListeners.delete(fn);
    };
}

export function usePassageRainCoverageHours(): number | null {
    return useSyncExternalStore(subscribePassageRainCoverage, getPassageRainCoverageHours, getPassageRainCoverageHours);
}

// ── Layers that do NOT follow the scrubber ─────────────────────

/**
 * Only the wind field follows the look-ahead (and the isobars, when they ride
 * it). Rain radar reaches about two hours; the ocean products are 8–12 MB a
 * step. While their own time pills are stood down they carry NO time label at
 * all — so a rain layer showing this minute's radar would sit under a clock
 * reading Saturday 18:00 with nothing to say otherwise (review, 2026-09-18).
 * The chart reports which of them are up; the scrubber says so in words.
 */
const NO_LAYERS: readonly string[] = Object.freeze([]);
let unsyncedLayers: readonly string[] = NO_LAYERS;
const unsyncedListeners = new Set<() => void>();

export function getPassageUnsyncedLayers(): readonly string[] {
    return unsyncedLayers;
}

export function reportPassageUnsyncedLayers(names: readonly string[]): void {
    const next = names.length === 0 ? NO_LAYERS : names;
    if (next.length === unsyncedLayers.length && next.every((n, i) => n === unsyncedLayers[i])) return;
    unsyncedLayers = next === NO_LAYERS ? NO_LAYERS : Object.freeze([...next]);
    unsyncedListeners.forEach((fn) => fn());
}

function subscribePassageUnsyncedLayers(fn: () => void): () => void {
    unsyncedListeners.add(fn);
    return () => {
        unsyncedListeners.delete(fn);
    };
}

export function usePassageUnsyncedLayers(): readonly string[] {
    return useSyncExternalStore(subscribePassageUnsyncedLayers, getPassageUnsyncedLayers, getPassageUnsyncedLayers);
}

/** Test seam. */
export function __resetPassageHudForTests(): void {
    open = read();
    activation = 0;
    overviewAsked = false;
    preview = null;
    activatedRecordings.clear();
    lookAhead = LIVE;
    ghost = null;
    ghostPath = null;
    ghostJoinPath = null;
    windCoverageHours = null;
    rainCoverageHours = null;
    speedPref = readSpeedPref();
    unsyncedLayers = NO_LAYERS;
}

// Account changes synchronously remove the previous owner's HUD and forecast.
subscribeAuthIdentityScope(() => {
    setPassageHudPreviewRoute(null);
    setPassageHudOpen(false);
    stopPassageLookAhead();
    setPassageOverlay(false);
    if (overviewAsked) {
        overviewAsked = false;
        listeners.forEach((fn) => fn());
    }
});
