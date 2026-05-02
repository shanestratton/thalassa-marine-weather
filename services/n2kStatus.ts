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
    private timer: ReturnType<typeof setInterval> | null = null;

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
     * Start the 30s background poll. Idempotent — calling twice doesn't
     * spawn two timers. Stops itself when no piHost is discoverable
     * and resumes when one shows up.
     */
    start(): void {
        if (this.timer) return;
        // Fire one off immediately so consumers get a value before the
        // first interval tick.
        void this.refresh();
        this.timer = setInterval(() => {
            // Visibility gate matches PiCacheService — no point burning
            // network when the user has the app backgrounded.
            if (typeof document !== 'undefined' && document.hidden) return;
            void this.refresh();
        }, POLL_INTERVAL_MS);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Force an immediate fetch — used when the System Status modal opens. */
    async refresh(): Promise<void> {
        const piHost = BoatNetworkService.getState().piHost;
        if (!piHost) {
            this.publish(INITIAL);
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
            // so the UI dims the row.
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
