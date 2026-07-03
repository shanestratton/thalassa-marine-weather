/**
 * LiveTrickle — live position sharing for the public Voyage Log.
 *
 * While a voyage is RECORDING, the durable track lives only on the device
 * (the OfflineQueue is the live store and uploads WHOLE at voyage stop —
 * the local-first contract this module must never disturb). The trickle is
 * a read-only SHADOW of that queue: on a throttled heartbeat it copies the
 * newest trackworthy points, decimates them to ≥30 s spacing, and UPSERTS
 * them into the `live_track` table keyed (user_id, timestamp) — idempotent
 * by construction, so retries, restarts and overlapping ticks can never
 * duplicate a point.
 *
 * The voyage-log edge function appends live_track rows NEWER than the last
 * durable ship_logs point as the public page's "live tail"; once the
 * at-stop upload lands in ship_logs, the durable track supersedes the
 * trickle automatically (the tail query starts after the last durable
 * point). The device prunes its own rows older than 7 days.
 *
 * Heartbeats come from TWO places, both cheap and throttled here:
 *   - the capture pipeline, after each locally-queued point (works in the
 *     BACKGROUND, where JS timers are suspended but the native GPS
 *     callbacks keep firing);
 *   - a foreground interval as a belt for quiet capture spells.
 *
 * Gated on settings.liveTrackShare (default OFF — sharing your live
 * position is an explicit choice). Fails quiet: no signal / no user / no
 * supabase → try again on the next heartbeat.
 */

import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../../utils/createLogger';
import { supabase, getCurrentUser } from '../supabase';
import { getOfflineEntries } from './OfflineQueue';
import { isTrackworthyEntry } from './helpers';
import type { ShipLogEntry } from '../../types/navigation';

const log = createLogger('LiveTrickle');

const LIVE_TRACK_TABLE = 'live_track';
const MARK_KEY = 'live_trickle_mark_v1';
/** Minimum time between upsert attempts. */
const TRICKLE_INTERVAL_MS = 2 * 60 * 1000;
/** Decimation floor — never publish points closer together than this. */
const MIN_SPACING_MS = 30 * 1000;
/** Rows per upsert batch (catch-up after a signal gap can span hours). */
const MAX_BATCH = 200;
/** Own-row retention in live_track. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let running = false;
let voyageId: string | null = null;
let lastAttemptMs = 0;
let tickInFlight = false;
let prunedThisSession = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function isEnabled(): Promise<boolean> {
    try {
        const { useSettingsStore } = await import('../../stores/settingsStore');
        return useSettingsStore.getState().settings.liveTrackShare === true;
    } catch {
        return false;
    }
}

async function readMark(): Promise<string> {
    try {
        const { value } = await Preferences.get({ key: MARK_KEY });
        return value ?? '';
    } catch {
        return '';
    }
}

async function writeMark(ts: string): Promise<void> {
    try {
        await Preferences.set({ key: MARK_KEY, value: ts });
    } catch (e) {
        log.warn('mark write failed:', e);
    }
}

/** Decimate ascending-time entries to ≥MIN_SPACING_MS, always keeping the newest. */
function decimate(entries: Partial<ShipLogEntry>[]): Partial<ShipLogEntry>[] {
    const kept: Partial<ShipLogEntry>[] = [];
    let lastKeptMs = -Infinity;
    for (const e of entries) {
        const ms = Date.parse(e.timestamp ?? '');
        if (!Number.isFinite(ms)) continue;
        if (ms - lastKeptMs >= MIN_SPACING_MS) {
            kept.push(e);
            lastKeptMs = ms;
        }
    }
    // The boat's CURRENT position matters most — if decimation dropped the
    // newest point, publish it anyway.
    const newest = entries[entries.length - 1];
    if (newest && kept[kept.length - 1] !== newest) kept.push(newest);
    return kept;
}

async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
        if (!supabase) return;
        if (!(await isEnabled())) return;
        const user = await getCurrentUser();
        if (!user) return;

        const mark = await readMark();
        const queue = await getOfflineEntries();
        const fresh = queue
            .filter(
                (e) =>
                    typeof e.timestamp === 'string' &&
                    e.timestamp > mark &&
                    typeof e.latitude === 'number' &&
                    typeof e.longitude === 'number' &&
                    isTrackworthyEntry(e),
            )
            .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
        if (fresh.length === 0) return;

        const batch = decimate(fresh).slice(-MAX_BATCH);
        const rows = batch.map((e) => ({
            user_id: user.id,
            voyage_id: e.voyageId ?? voyageId,
            timestamp: e.timestamp,
            latitude: e.latitude,
            longitude: e.longitude,
            speed_kts: e.speedKts ?? null,
            course_deg: e.courseDeg ?? null,
            source: 'device',
        }));

        const { error } = await supabase
            .from(LIVE_TRACK_TABLE)
            .upsert(rows, { onConflict: 'user_id,timestamp', ignoreDuplicates: true });
        if (error) {
            // No signal / RLS hiccup — mark NOT advanced, everything retries
            // on the next heartbeat.
            log.info('trickle upsert failed (will retry):', error.message);
            return;
        }
        await writeMark(rows[rows.length - 1].timestamp as string);
        log.info(`trickled ${rows.length} live point(s)`);

        // Opportunistic own-row hygiene, once per session.
        if (!prunedThisSession) {
            prunedThisSession = true;
            const cutoff = new Date(Date.now() - PRUNE_AFTER_MS).toISOString();
            void supabase.from(LIVE_TRACK_TABLE).delete().eq('user_id', user.id).lt('timestamp', cutoff);
        }
    } catch (e) {
        log.warn('trickle tick failed:', e);
    } finally {
        tickInFlight = false;
    }
}

/**
 * Throttled heartbeat. Called by the capture pipeline after each queued
 * point (background-capable) and by the foreground interval. Cheap no-op
 * when the trickle isn't running or the interval hasn't elapsed.
 */
export function noteLiveTrickleHeartbeat(): void {
    if (!running) return;
    const now = Date.now();
    if (now - lastAttemptMs < TRICKLE_INTERVAL_MS) return;
    lastAttemptMs = now;
    void tick();
}

/** Wire the trickle to a recording voyage. Idempotent. */
export function startLiveTrickle(activeVoyageId: string | null): void {
    voyageId = activeVoyageId;
    if (running) return;
    running = true;
    lastAttemptMs = 0; // first heartbeat fires immediately
    if (intervalHandle === null) {
        intervalHandle = setInterval(() => noteLiveTrickleHeartbeat(), TRICKLE_INTERVAL_MS);
    }
    log.info('live trickle armed');
}

/**
 * Stop the trickle. `finalFlush` publishes any last unsent points so the
 * public tail is complete while the at-stop upload is still in flight.
 */
export async function stopLiveTrickle(finalFlush = true): Promise<void> {
    if (!running) return;
    running = false;
    if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
    if (finalFlush) {
        lastAttemptMs = 0;
        await tick();
    }
    voyageId = null;
    log.info('live trickle stopped');
}
