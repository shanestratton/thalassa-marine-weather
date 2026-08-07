/**
 * barometer — the iPhone's own barometer, logged and sea-level corrected.
 *
 * Wraps the native `Barometer` plugin (ios/App/App/BarometerPlugin.swift)
 * and does the three things the raw sensor can't do for itself:
 *
 *  1. KEEPS A RECORD. The three-hour tendency is the only number a single
 *     barometer can forecast with, so a reading taken the moment the panel
 *     opens is worth nothing. Samples are logged continuously while the app
 *     is foreground and persisted, so the record survives a restart and the
 *     panel has something to show the first time it is opened.
 *
 *  2. CALIBRATES THE ABSOLUTE VALUE. CMAltimeter reports station pressure
 *     with an absolute error of roughly ±1 hPa (unit-to-unit offsets of a
 *     couple of hPa are normal) but a relative precision near 0.01 hPa. So
 *     we anchor the absolute number to a forecast MSLP once, store the
 *     offset, and let the sensor carry the movement from there. The offset
 *     is shown in the UI and is re-anchored when the forecast is fresh —
 *     never silently.
 *
 *  3. FAILS HONESTLY. iPads, the simulator and every non-iOS platform have
 *     no barometer; a user can decline Motion & Fitness. All of those
 *     resolve to `available: false` with a reason, and the panel falls back
 *     to forecast pressure with the source chip saying so.
 *
 * See utils/barometerTendency.ts for the maths this feeds.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';
import type { PressureSample } from '../../utils/barometerTendency';

const log = createLogger('barometer');

// ── Native plugin surface ────────────────────────────────────────────

interface BarometerSampleEvent {
    pressureHpa: number;
    timestamp: number;
    samples: number;
}

interface BarometerPlugin {
    isAvailable(): Promise<{ available: boolean; authorization: string; running: boolean }>;
    start(options?: { intervalMs?: number }): Promise<{ running: boolean; intervalMs: number }>;
    stop(): Promise<void>;
    getLatest(): Promise<{ pressureHpa: number | null; timestamp: number | null }>;
    addListener(
        event: 'sample',
        cb: (data: BarometerSampleEvent) => void,
    ): Promise<PluginListenerHandle> & PluginListenerHandle;
    removeAllListeners(): Promise<void>;
}

const Native = registerPlugin<BarometerPlugin>('Barometer');

// ── Persistence ──────────────────────────────────────────────────────

const STORAGE_KEY = 'thalassa.barometer.v1';
/** Two days of record. Anything older can't inform a 3-hour tendency. */
const MAX_AGE_MS = 48 * 3_600_000;
/** Don't keep two samples closer together than this — the record is a trend, not a stream. */
const MIN_SPACING_MS = 100_000;
/** Hard cap on stored samples, so a pathological clock can't grow this without bound. */
const MAX_SAMPLES = 1800;
/** Native emission cadence. One median per window. */
const SAMPLE_INTERVAL_MS = 15_000;

export type PressureUnit = 'hPa' | 'inHg';

interface PersistedState {
    samples: [number, number][]; // [epochSeconds, hPa] — compact on purpose
    /** MSLP − station, hPa. Null until the user (or an auto-anchor) calibrates. */
    offsetHpa: number | null;
    offsetAt: number | null;
    unit: PressureUnit;
}

const EMPTY: PersistedState = { samples: [], offsetHpa: null, offsetAt: null, unit: 'hPa' };

function load(): PersistedState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...EMPTY };
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        return {
            samples: Array.isArray(parsed.samples)
                ? parsed.samples.filter((s) => Array.isArray(s) && s.length === 2)
                : [],
            offsetHpa: typeof parsed.offsetHpa === 'number' ? parsed.offsetHpa : null,
            offsetAt: typeof parsed.offsetAt === 'number' ? parsed.offsetAt : null,
            unit: parsed.unit === 'inHg' ? 'inHg' : 'hPa',
        };
    } catch {
        return { ...EMPTY };
    }
}

let state: PersistedState = load();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveSoon(): void {
    if (saveTimer) return;
    // Batched: a sample lands every 15 s and localStorage writes are sync.
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (err) {
            log.warn('could not persist barometer record', err);
        }
    }, 2_000);
}

// ── Availability ─────────────────────────────────────────────────────

export interface BarometerAvailability {
    available: boolean;
    /** Machine-readable reason when unavailable. */
    reason?: 'not-native' | 'no-hardware' | 'denied' | 'error';
    authorization?: string;
}

let availabilityCache: BarometerAvailability | null = null;

export async function checkAvailability(): Promise<BarometerAvailability> {
    if (availabilityCache) return availabilityCache;
    // Android phones do have barometers, but there is no plugin implementation
    // for them yet — claiming otherwise would just produce a silent failure.
    if (Capacitor.getPlatform() !== 'ios') {
        availabilityCache = { available: false, reason: 'not-native' };
        return availabilityCache;
    }
    try {
        const res = await Native.isAvailable();
        if (!res.available) {
            availabilityCache = { available: false, reason: 'no-hardware', authorization: res.authorization };
        } else if (res.authorization === 'denied' || res.authorization === 'restricted') {
            availabilityCache = { available: false, reason: 'denied', authorization: res.authorization };
        } else {
            availabilityCache = { available: true, authorization: res.authorization };
        }
    } catch (err) {
        log.warn('availability probe failed', err);
        availabilityCache = { available: false, reason: 'error' };
    }
    return availabilityCache;
}

// ── Sampling ─────────────────────────────────────────────────────────

type Subscriber = () => void;
const subscribers = new Set<Subscriber>();
let listener: PluginListenerHandle | null = null;
let appStateListener: PluginListenerHandle | null = null;
let starting: Promise<void> | null = null;
let logging = false;

function notify(): void {
    for (const fn of subscribers) {
        try {
            fn();
        } catch (err) {
            log.warn('subscriber threw', err);
        }
    }
}

function prune(nowMs: number): void {
    const cutoff = nowMs - MAX_AGE_MS;
    let next = state.samples.filter(([sec]) => sec * 1000 >= cutoff);
    if (next.length > MAX_SAMPLES) next = next.slice(next.length - MAX_SAMPLES);
    state.samples = next;
}

function record(hpa: number, atMs: number): void {
    const last = state.samples[state.samples.length - 1];
    if (last && atMs - last[0] * 1000 < MIN_SPACING_MS) {
        // Inside the spacing floor — overwrite rather than append, so the
        // newest reading still wins without inflating the record.
        state.samples[state.samples.length - 1] = [Math.round(atMs / 1000), Number(hpa.toFixed(2))];
    } else {
        state.samples.push([Math.round(atMs / 1000), Number(hpa.toFixed(2))]);
    }
    prune(atMs);
    saveSoon();
    notify();
}

/**
 * Begin logging. Idempotent — call it from anywhere that wants the record
 * to be accumulating (the Glass page does, on mount).
 */
export async function startLogging(): Promise<void> {
    if (logging) return;
    if (starting) return starting;
    starting = (async () => {
        const avail = await checkAvailability();
        if (!avail.available) return;
        try {
            listener = await Native.addListener('sample', (ev) => {
                if (typeof ev?.pressureHpa !== 'number' || !Number.isFinite(ev.pressureHpa)) return;
                record(ev.pressureHpa, typeof ev.timestamp === 'number' ? ev.timestamp : Date.now());
            });
            await Native.start({ intervalMs: SAMPLE_INTERVAL_MS });
            logging = true;
            log.info('logging started');
            await attachAppStateListener();
        } catch (err) {
            log.warn('could not start barometer logging', err);
            availabilityCache = { available: false, reason: 'error' };
        }
    })();
    try {
        await starting;
    } finally {
        starting = null;
    }
}

export async function stopLogging(): Promise<void> {
    if (!logging) return;
    logging = false;
    try {
        await Native.stop();
        await listener?.remove();
    } catch (err) {
        log.warn('could not stop barometer logging', err);
    }
    listener = null;
}

/**
 * iOS suspends CoreMotion delivery when the app backgrounds, so the record
 * gains a gap. Stopping and restarting around that is tidier than leaving a
 * dead subscription behind, and the gap itself is handled honestly: the
 * tendency maths refuses to interpolate across one it can't bridge.
 */
async function attachAppStateListener(): Promise<void> {
    if (appStateListener) return;
    try {
        const { App } = await import('@capacitor/app');
        appStateListener = await App.addListener('appStateChange', ({ isActive }) => {
            if (isActive) {
                if (!logging) void startLogging();
            } else {
                void Native.stop().catch(() => {});
                logging = false;
            }
        });
    } catch (err) {
        log.warn('app-state listener unavailable', err);
    }
}

// ── Reading the record ───────────────────────────────────────────────

/** The logged samples as station pressure, oldest first. */
export function getStationSamples(): PressureSample[] {
    return state.samples.map(([sec, hpa]) => ({ t: sec * 1000, hpa }));
}

/** The logged samples corrected to sea level by the stored offset. */
export function getSeaLevelSamples(): PressureSample[] {
    const off = state.offsetHpa ?? 0;
    return state.samples.map(([sec, hpa]) => ({ t: sec * 1000, hpa: hpa + off }));
}

export function getLatestSample(): PressureSample | null {
    const last = state.samples[state.samples.length - 1];
    return last ? { t: last[0] * 1000, hpa: last[1] } : null;
}

export function getOffset(): { offsetHpa: number | null; offsetAt: number | null } {
    return { offsetHpa: state.offsetHpa, offsetAt: state.offsetAt };
}

export function isLogging(): boolean {
    return logging;
}

/**
 * Anchor the sensor's absolute value to a known MSLP (normally the current
 * forecast's). Stores `reference − station` and returns it.
 *
 * This does NOT touch the stored samples: the offset is applied at read
 * time, so re-calibrating retroactively corrects the whole trace rather
 * than leaving a step in it.
 */
export function calibrateTo(referenceMslpHpa: number): number | null {
    const latest = getLatestSample();
    if (!latest || !Number.isFinite(referenceMslpHpa)) return null;
    const offset = referenceMslpHpa - latest.hpa;
    // A sane phone sits within a few hPa of the forecast at sea level, and a
    // couple of tens of hPa up a hill. Past 60 hPa (roughly 500 m) something
    // is wrong — a stale forecast, a bad fix — and baking it in would be worse
    // than staying uncalibrated.
    if (Math.abs(offset) > 60) {
        log.warn('refusing implausible calibration offset', { offset, referenceMslpHpa, station: latest.hpa });
        return null;
    }
    state.offsetHpa = Number(offset.toFixed(2));
    state.offsetAt = Date.now();
    saveSoon();
    notify();
    return state.offsetHpa;
}

export function clearCalibration(): void {
    state.offsetHpa = null;
    state.offsetAt = null;
    saveSoon();
    notify();
}

export function getUnit(): PressureUnit {
    return state.unit;
}

export function setUnit(unit: PressureUnit): void {
    state.unit = unit;
    saveSoon();
    notify();
}

/** Subscribe to record changes (new sample, calibration, unit). */
export function subscribe(fn: Subscriber): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

/** Test seam — drops the in-memory record and the availability cache. */
export function __resetForTests(): void {
    state = { ...EMPTY, samples: [] };
    availabilityCache = null;
    logging = false;
    subscribers.clear();
}
