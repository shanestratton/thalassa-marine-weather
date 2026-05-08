/**
 * n2kStatus — polls the Bosun Pi's `/api/n2k/status` endpoint and
 * publishes a small reactive snapshot for the System Status modal.
 *
 * Backend contract: bosun-pi/bosun_n2k_api.py.
 *
 * Design notes:
 *
 *   - Polling only runs when the Pi is discoverable (piHost from
 *     BoatNetworkService). When the Pi vanishes, the cached snapshot
 *     ages out to null and the System Status modal renders the dim
 *     "no Pi" state.
 *
 *   - 30s cadence is enough — the underlying CAN bus state changes on
 *     "minutes" timescales (powering boat instruments on/off,
 *     plugging into a marina backbone). The modal also force-refreshes
 *     immediately on open via `refresh()`.
 *
 *   - Fail-soft: any HTTP / network error sets `reachable=false` and
 *     leaves the previous snapshot in place. UI shows a dim row, not
 *     a red error.
 */
import { BoatNetworkService } from './BoatNetworkService';

const BOSUN_WEB_PORT = 5000;
const POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;

// ── Failure backoff ──
// Boats without an N2K bridge running on the Pi were getting hammered
// every 30s with connection-refused errors that flooded the Xcode
// console with `tcp_input flags=[R.]` and `nw_endpoint_flow_failed`
// noise. Once we've seen consistent failures, slow the cadence way
// down — by N consecutive misses the service is clearly not running,
// and continuing to probe at 30s gains nothing.
//
//   0-2 consecutive misses  → keep polling at 30s  (original cadence)
//   3-5 misses              → 5 min between polls
//   6-9 misses              → 15 min
//   10+ misses              → 30 min  (probe twice an hour, just in
//                                       case the user starts the service
//                                       mid-session)
//
// One successful fetch resets the counter to 0.
const FAILURE_BACKOFF_MS: Record<number, number> = {
    0: POLL_INTERVAL_MS, // 30s
    3: 5 * 60_000, // 5 min
    6: 15 * 60_000, // 15 min
    10: 30 * 60_000, // 30 min
};

export type N2kHealth = 'red' | 'amber' | 'green';

/** Subset of the Pi's response we surface to the UI. */
export interface N2kStatus {
    /** True if we got a valid response — separate from health (which is server-asserted). */
    reachable: boolean;
    /** Server's health rollup. Null when unreachable. */
    health: N2kHealth | null;
    /** Server's one-line summary (renderable as-is). Null when unreachable. */
    summary: string | null;
    /** Wire layer (`can0`) up at the kernel level? */
    wireUp: boolean;
    /** Frames flowing through the bus? */
    hasTraffic: boolean;
    /** Tracked-paths populated count. */
    pathsSeen: number;
    /** Tracked-paths total. */
    pathsTotal: number;
    /** Last update epoch (ms). */
    lastFetchedAt: number | null;
}

interface PiEnvelope<T> {
    value: T | null;
    source: string;
    timestamp: string;
    error: string | null;
    latency_ms: number;
}

interface RawValue {
    health: N2kHealth;
    summary: string;
    wire_up: boolean;
    has_traffic: boolean;
    tracked_paths_seen: number;
    tracked_paths_total: number;
}

const INITIAL: N2kStatus = {
    reachable: false,
    health: null,
    summary: null,
    wireUp: false,
    hasTraffic: false,
    pathsSeen: 0,
    pathsTotal: 0,
    lastFetchedAt: null,
};

class N2kStatusServiceClass {
    private status: N2kStatus = INITIAL;
    private listeners = new Set<(s: N2kStatus) => void>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Consecutive failure count — drives the backoff schedule above. */
    private consecutiveFailures = 0;

    getStatus(): N2kStatus {
        return this.status;
    }

    /**
     * Subscribe to updates. Returns unsubscribe. Caller is fired
     * immediately with the current snapshot so React effects don't
     * have to seed manually.
     */
    onStatusChange(listener: (s: N2kStatus) => void): () => void {
        this.listeners.add(listener);
        listener(this.status);
        return () => this.listeners.delete(listener);
    }

    /**
     * Start the background poll. Idempotent — calling twice doesn't
     * spawn two timers. Stops itself when no piHost is discoverable
     * and resumes when one shows up. Uses a self-rescheduling setTimeout
     * (instead of setInterval) so each tick can pick its own delay
     * based on the current failure count — that's what implements
     * the backoff schedule above.
     */
    start(): void {
        if (this.timer) return;
        // Fire one off immediately so consumers get a value before the
        // first delay.
        void this.tick();
    }

    private tick = async (): Promise<void> => {
        // Visibility gate matches PiCacheService — no point burning
        // network when the user has the app backgrounded.
        if (typeof document === 'undefined' || !document.hidden) {
            await this.refresh();
        }
        // Schedule the NEXT tick using the current failure count to
        // pick a delay. Reading the schedule fresh each time means a
        // recovery (failure count drops to 0) immediately bumps us
        // back to 30s without waiting out the long backoff.
        const delay = this.delayForFailures(this.consecutiveFailures);
        this.timer = setTimeout(this.tick, delay);
    };

    /** Map a consecutive-failure count to the next-poll delay. */
    private delayForFailures(failures: number): number {
        // Walk the FAILURE_BACKOFF_MS table from highest threshold down,
        // returning the first one this failure count meets. O(table size).
        const thresholds = Object.keys(FAILURE_BACKOFF_MS)
            .map(Number)
            .sort((a, b) => b - a);
        for (const t of thresholds) {
            if (failures >= t) return FAILURE_BACKOFF_MS[t];
        }
        return POLL_INTERVAL_MS;
    }

    stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Force an immediate fetch — used when the System Status modal opens.
     *  Resets the backoff counter on a successful fetch so an N2K bridge
     *  that's just been started picks up immediately. */
    async refresh(): Promise<void> {
        const piHost = BoatNetworkService.getState().piHost;
        if (!piHost) {
            this.publish(INITIAL);
            // No piHost is a "skipped" not a "failed" — don't penalise
            // future polls for a transient discovery gap.
            return;
        }

        const url = `http://${piHost}:${BOSUN_WEB_PORT}/api/n2k/status`;
        const ctrl = new AbortController();
        const watchdog = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const env = (await r.json()) as PiEnvelope<RawValue>;
            if (!env.value) throw new Error(env.error || 'empty value');
            const v = env.value;
            // Successful fetch — reset the backoff so we go right back
            // to 30s polling. If the user just spun up the N2K bridge
            // after 20 minutes of silence, this catches the recovery
            // immediately rather than making them wait out the next
            // long-backoff window.
            this.consecutiveFailures = 0;
            this.publish({
                reachable: true,
                health: v.health,
                summary: v.summary,
                wireUp: !!v.wire_up,
                hasTraffic: !!v.has_traffic,
                pathsSeen: v.tracked_paths_seen,
                pathsTotal: v.tracked_paths_total,
                lastFetchedAt: Date.now(),
            });
        } catch {
            // Soft-fail: keep the existing summary/wireUp etc. in case the
            // user just dropped a single packet, but mark as unreachable
            // so the UI dims the row. Bump the consecutive-failure count
            // — once it crosses the thresholds in FAILURE_BACKOFF_MS,
            // the tick loop slows down to stop spamming the network
            // with connection-refused errors when no N2K bridge is
            // running on the Pi.
            this.consecutiveFailures++;
            this.publish({ ...this.status, reachable: false });
        } finally {
            clearTimeout(watchdog);
        }
    }

    private publish(next: N2kStatus): void {
        this.status = next;
        for (const l of this.listeners) {
            try {
                l(next);
            } catch {
                /* listener-thrown errors must not stop the poll */
            }
        }
    }
}

export const n2kStatus = new N2kStatusServiceClass();
