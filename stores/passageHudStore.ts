/**
 * passageHudStore — is the Obs chart's passage pane open?
 *
 * Shane, 2026-09-17, three days under way to Gladstone: "the only real issue
 * i have is i dont really know which screen to look at, so i am thinking we
 * need a new layer on the obs page. this layer will show cog, sog, wind speed,
 * direction and true and apparent … most of the info needs to be on a pane
 * that can be hidden to one side (left i am thinking)."
 *
 * This is the one switch for that pane. Remembered on this device so the
 * skipper who opened it at the start of a passage finds it open on the next
 * glance. Same shape as chartPassageOverlay: a module value, a listener set,
 * and useSyncExternalStore for the components — no zustand, nothing to hydrate.
 *
 * PHASE 2 — LOOK AHEAD (Shane 2026-09-18: "ok next phase"). The same module
 * now carries the one time axis the chart shares while the skipper is looking
 * ahead along the route:
 *
 *   lookAhead.on       — false = LIVE. Nothing on the chart is a forecast.
 *   lookAhead.aheadMs  — how far ahead of NOW the scrubber stands. An OFFSET,
 *                        not a clock time: parked at +6 h it stays +6 h from
 *                        wherever she is when the skipper next looks.
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
 */
import { useSyncExternalStore } from 'react';

const KEY = 'thalassa_passage_hud_open_v1';
/** Off until the skipper asks for it in Settings → Preferences (Shane's home for toggles). */
const ENABLED_KEY = 'thalassa_passage_hud_enabled_v1';

function readFlag(key: string): boolean {
    try {
        return localStorage.getItem(key) === '1';
    } catch {
        return false;
    }
}
const read = (): boolean => readFlag(KEY);

let open = read();
let enabled = readFlag(ENABLED_KEY);
const listeners = new Set<() => void>();

export function isPassageHudOpen(): boolean {
    return open;
}

export function setPassageHudOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    // The scrubber belongs to the open strip. Hiding the strip ends the glance.
    if (!next) stopPassageLookAhead();
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

/**
 * Whether the strip exists on the chart at all. OFF by default: three review
 * rounds measured it against the chart's furniture and each found something
 * new in its column, so it reaches a punter only when the skipper turns it on.
 */
export function isPassageHudEnabled(): boolean {
    return enabled;
}

export function setPassageHudEnabled(next: boolean): void {
    if (next === enabled) return;
    enabled = next;
    try {
        if (next) localStorage.setItem(ENABLED_KEY, '1');
        else localStorage.removeItem(ENABLED_KEY);
    } catch {
        /* storage unavailable — the in-session value still rules */
    }
    // Switching it off must not leave the chart's furniture stepped aside for
    // a strip that is no longer there.
    if (!next && open) {
        open = false;
        try {
            localStorage.removeItem(KEY);
        } catch {
            /* as above */
        }
    }
    if (!next) stopPassageLookAhead();
    listeners.forEach((fn) => fn());
}

export function usePassageHudEnabled(): boolean {
    return useSyncExternalStore(subscribePassageHud, isPassageHudEnabled, isPassageHudEnabled);
}

// ── Look ahead ─────────────────────────────────────────────────

/** Shane 2026-09-18: "lets get it out to 7 days". */
export const LOOK_AHEAD_MAX_MS = 7 * 24 * 3_600_000;

export interface PassageLookAhead {
    on: boolean;
    aheadMs: number;
    playing: boolean;
}

const LIVE: PassageLookAhead = Object.freeze({ on: false, aheadMs: 0, playing: false });
// A NEW object on every change and the SAME object otherwise — what
// useSyncExternalStore needs from a snapshot.
let lookAhead: PassageLookAhead = LIVE;
const lookAheadListeners = new Set<() => void>();

function setLookAhead(next: PassageLookAhead): void {
    if (next.on === lookAhead.on && next.aheadMs === lookAhead.aheadMs && next.playing === lookAhead.playing) return;
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

/** Into look-ahead, standing at NOW: the model's numbers for this hour. */
export function startPassageLookAhead(): void {
    if (lookAhead.on) return;
    setLookAhead({ on: true, aheadMs: 0, playing: false });
}

/** Back to LIVE. Also forgets the ghost: there is no ghost of the present. */
export function stopPassageLookAhead(): void {
    setLookAhead(LIVE);
    publishPassageGhost(null);
    publishPassageGhostPath(null);
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
let ghostPath: readonly { lat: number; lon: number }[] | null = null;
const ghostListeners = new Set<() => void>();

export function getPassageGhostPath(): readonly { lat: number; lon: number }[] | null {
    return ghostPath;
}

export function publishPassageGhostPath(next: readonly { lat: number; lon: number }[] | null): void {
    const clean = next && next.length >= 2 ? next : null;
    if (clean === ghostPath) return;
    if (
        clean &&
        ghostPath &&
        clean.length === ghostPath.length &&
        clean.every((p, i) => p.lat === ghostPath![i].lat && p.lon === ghostPath![i].lon)
    ) {
        return;
    }
    ghostPath = clean;
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
 * Hours of wind field ahead of NOW that the chart's wind layer holds, or null
 * when that layer is off / has no grid. The field is 48 hourly frames; the
 * strip's numbers reach seven days. The scrubber says where the one stops.
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
 * Hours ahead of NOW that the chart's rain imagery can follow the scrubber to
 * (the forecast frames reach about four), or null when the rain layer is off or
 * has no frame it can put a clock time on. Twin of the wind coverage above.
 */
let rainCoverageHours: number | null = null;
const rainCoverageListeners = new Set<() => void>();

export function getPassageRainCoverageHours(): number | null {
    return rainCoverageHours;
}

export function reportPassageRainCoverage(hours: number | null): void {
    const next = hours !== null && Number.isFinite(hours) && hours > 0 ? Math.round(hours * 10) / 10 : null;
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
    enabled = readFlag(ENABLED_KEY);
    lookAhead = LIVE;
    ghost = null;
    ghostPath = null;
    windCoverageHours = null;
    rainCoverageHours = null;
    speedPref = readSpeedPref();
    unsyncedLayers = NO_LAYERS;
}
