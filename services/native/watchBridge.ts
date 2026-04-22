/**
 * watchBridge — TypeScript wrapper around the Capacitor
 * `WatchConnectivity` plugin (ios/App/App/WatchConnectivityPlugin.swift).
 *
 * Pushes anchor-watch + weather snapshots to the paired Apple Watch
 * via WatchConnectivity's durable application-context channel. On
 * platforms without the plugin (web, Android, missing watch) the
 * methods are no-ops — callers don't need to platform-check.
 *
 * The watch app listens via WCSessionDelegate and updates its UI
 * accordingly. Reverse direction (watch → phone) is exposed via
 * `onMobTriggered` and `onAlarmAck` event listeners — wire these
 * into MobService and AnchorWatchService respectively.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('watchBridge');

// ── Types ────────────────────────────────────────────────────────────

/** Subset of AnchorWatchSnapshot the watch needs. Keep this small —
 *  WatchConnectivity has tight payload limits and re-serialising the
 *  entire 500-point positionHistory on every update would be wasteful. */
export interface WatchAnchorSnapshot {
    /** 'idle' | 'setting' | 'watching' | 'alarm' | 'paused' */
    state: string;
    /** Anchor coordinates (lat, lon, ts) — null when no anchor set */
    anchor: { lat: number; lon: number } | null;
    /** Current vessel coordinates */
    vessel: { lat: number; lon: number; accuracy: number } | null;
    /** Swing radius in metres */
    swingRadius: number;
    /** Distance from anchor in metres */
    distanceFromAnchor: number;
    /** Max recorded drift since watch started, in metres */
    maxDistanceRecorded: number;
    /** Bearing from anchor to vessel (degrees true) */
    bearingFromAnchor: number;
    /** Watch start timestamp (epoch ms) — null if not watching */
    watchStartedAt: number | null;
    /** When the alarm fired (epoch ms) — null if not alarming */
    alarmTriggeredAt: number | null;
}

export interface WatchWeatherSnapshot {
    /** Wind speed (knots) */
    windKts: number;
    /** Wind direction (degrees true, where the wind is FROM) */
    windDirDeg: number;
    /** Gust speed (knots) — optional, falls back to windKts on the watch */
    gustKts?: number;
    /** Vessel heading (degrees true) — for the compass card */
    headingDeg?: number;
    /** Speed over ground (knots) */
    sogKts?: number;
    /** Pressure (hPa) — used by the trend arrow */
    pressureHpa?: number;
    /** Generated-at timestamp (epoch ms) */
    generatedAt: number;
}

export interface WatchAvailability {
    available: boolean;
    paired: boolean;
    reachable: boolean;
    installed: boolean;
}

interface WatchConnectivityPlugin {
    isAvailable(): Promise<WatchAvailability>;
    pushAnchorState(snapshot: WatchAnchorSnapshot): Promise<void>;
    pushWeatherSnapshot(snapshot: WatchWeatherSnapshot): Promise<void>;
    addListener(
        eventName: 'mobTriggered' | 'alarmAck',
        listenerFunc: (event: Record<string, unknown>) => void,
    ): Promise<PluginListenerHandle>;
    removeAllListeners(): Promise<void>;
}

// ── Plugin registration ──────────────────────────────────────────────

const NativeWatch = registerPlugin<WatchConnectivityPlugin>('WatchConnectivity', {
    web: () => {
        // No-op web fallback so the import works in dev/Storybook.
        const noop = async () => undefined;
        const handle: PluginListenerHandle = { remove: async () => undefined };
        return {
            async isAvailable() {
                return { available: false, paired: false, reachable: false, installed: false };
            },
            pushAnchorState: noop as () => Promise<void>,
            pushWeatherSnapshot: noop as () => Promise<void>,
            async addListener() {
                return handle;
            },
            removeAllListeners: noop as () => Promise<void>,
        } as WatchConnectivityPlugin;
    },
});

// ── Public API ────────────────────────────────────────────────────────

/**
 * One-shot probe: is the watch wired up at all? Cache the result for
 * the session — it changes only when the user pairs/unpairs a watch
 * which won't happen mid-session.
 */
let _availabilityCache: WatchAvailability | null = null;
export async function getWatchAvailability(): Promise<WatchAvailability> {
    if (_availabilityCache) return _availabilityCache;
    if (Capacitor.getPlatform() !== 'ios') {
        _availabilityCache = { available: false, paired: false, reachable: false, installed: false };
        return _availabilityCache;
    }
    try {
        _availabilityCache = await NativeWatch.isAvailable();
        return _availabilityCache;
    } catch (err) {
        log.warn('isAvailable failed', err);
        _availabilityCache = { available: false, paired: false, reachable: false, installed: false };
        return _availabilityCache;
    }
}

/**
 * Push the latest anchor-watch state to the watch. Safe to call
 * frequently — the iOS plugin coalesces updates internally so only
 * the most recent snapshot is delivered when the watch becomes
 * reachable. No-op when no watch is paired.
 */
export async function pushAnchorState(snapshot: WatchAnchorSnapshot): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios') return;
    try {
        await NativeWatch.pushAnchorState(snapshot);
    } catch (err) {
        // Watch absence is normal — log at info, not warn.
        log.info('pushAnchorState noop / failed', err);
    }
}

/** Push the latest weather snapshot for the cockpit-glance view. */
export async function pushWeatherSnapshot(snapshot: WatchWeatherSnapshot): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios') return;
    try {
        await NativeWatch.pushWeatherSnapshot(snapshot);
    } catch (err) {
        log.info('pushWeatherSnapshot noop / failed', err);
    }
}

/**
 * Subscribe to the watch's MOB trigger. Returns a handle the caller
 * must `.remove()` on cleanup. Wired by MobService at app boot so
 * watch-initiated MOB events flow through the same alarm pipeline as
 * the in-app red MOB button.
 */
export async function onMobTriggered(handler: (event: Record<string, unknown>) => void): Promise<PluginListenerHandle> {
    return NativeWatch.addListener('mobTriggered', handler);
}

/** Subscribe to the watch's alarm-acknowledgement (silence / reset). */
export async function onAlarmAck(handler: (event: Record<string, unknown>) => void): Promise<PluginListenerHandle> {
    return NativeWatch.addListener('alarmAck', handler);
}
