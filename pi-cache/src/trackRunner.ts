/**
 * TrackRecorderRunner — the loop that keeps the boat's track.
 *
 * Shane 2026-08-30: "we need a toggle in the settings that kicks it off so
 * that the pi starts doing it." So it is OFF until asked, and the toggle is
 * the only thing that starts it — a recorder that quietly logged everywhere
 * the boat had ever been without being asked would be a surprise nobody wants
 * to find out about later.
 *
 * The loop is deliberately dull: read the bus, ask the policy whether this fix
 * is worth keeping, append what it says. All the judgement lives in
 * trackRecorder (pure, tested); all the units live in trackSignalk; this file
 * only owns the timer and the failure handling.
 *
 * FAILURE IS NORMAL AND IS NOT AN ERROR. Signal K restarts, the gateway drops
 * its slot, the boat loses power at the panel. A tick that cannot read a fix
 * records nothing and says so in its status; it does not throw, does not stop
 * the timer, and does not lose the state it had. The next good fix simply
 * continues the track, and the gap in the log is the honest record of a gap in
 * the data.
 */

import { fetchSelfDocument, type BroadcastDeps } from './anchorBroadcaster.js';
import { EMPTY_STATE, considerFix, type RecorderState, type TrackRules } from './trackRecorder.js';
import { readTrackFix } from './trackSignalk.js';
import type { TrackStore } from './trackStore.js';

/**
 * How often the bus is sampled. Not how often a point is written — that is the
 * policy's business, and at anchor it will write nothing for hours.
 *
 * Four seconds is chosen for TURNS. A tack takes ten to fifteen seconds, so
 * this resolves one into two or three samples; a minute-long poll would record
 * the boat leaving on one tack and arriving on the other with a straight line
 * between, which is a track of a passage she never sailed. It costs one
 * loopback HTTP request, so the only argument against it is noise in a log.
 */
export const TRACK_POLL_INTERVAL_MS = 4_000;

/** Fold the WAL back periodically, so a power cut costs one interval. */
export const TRACK_CHECKPOINT_INTERVAL_MS = 5 * 60_000;

export type TrackTickOutcome = 'logged' | 'held' | 'no-fix' | 'no-gps-time' | 'unreachable';

export interface TrackRunnerDeps extends BroadcastDeps {
    store: TrackStore;
    rules?: TrackRules;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
}

export class TrackRecorderRunner {
    private timer: ReturnType<typeof setInterval> | null = null;
    private checkpointTimer: ReturnType<typeof setInterval> | null = null;
    private state: RecorderState = EMPTY_STATE;
    private lastOutcome: TrackTickOutcome | null = null;
    private written = 0;

    constructor(private readonly deps: TrackRunnerDeps) {}

    start(): void {
        if (this.timer) return;
        const setIntervalFn = this.deps.setIntervalImpl ?? setInterval;
        this.timer = setIntervalFn(() => void this.tick(), TRACK_POLL_INTERVAL_MS);
        this.checkpointTimer = setIntervalFn(() => this.deps.store.checkpoint(), TRACK_CHECKPOINT_INTERVAL_MS);
        void this.tick();
    }

    stop(): void {
        const clear = this.deps.clearIntervalImpl ?? clearInterval;
        if (this.timer) {
            clear(this.timer);
            this.timer = null;
        }
        if (this.checkpointTimer) {
            clear(this.checkpointTimer);
            this.checkpointTimer = null;
        }
        /* Close the WAL on the way out. Stopping is the one moment we know the
           track is complete, so it is the cheapest possible time to make sure
           it is on disk. */
        this.deps.store.checkpoint();
        /* State is dropped on purpose. On restart the next fix is a 'first'
           point, which is honest: we cannot claim to know the boat did not
           move while we were not watching. */
        this.state = EMPTY_STATE;
    }

    isRunning(): boolean {
        return this.timer !== null;
    }

    /** Safe to hand to /status — it names no credential and no position. */
    describe(): {
        running: boolean;
        lastOutcome: TrackTickOutcome | null;
        writtenThisSession: number;
        stored: ReturnType<TrackStore['summary']>;
    } {
        return {
            running: this.isRunning(),
            lastOutcome: this.lastOutcome,
            writtenThisSession: this.written,
            stored: this.deps.store.summary(),
        };
    }

    /** Exposed so a test can drive one tick without a timer. */
    async tick(): Promise<TrackTickOutcome> {
        let outcome: TrackTickOutcome;
        try {
            const doc = await fetchSelfDocument(this.deps);
            if (doc === null) {
                outcome = 'unreachable';
            } else {
                const fix = readTrackFix(doc);
                if (!fix) {
                    outcome = 'no-fix';
                } else if (fix.gpsTimeMs === null) {
                    // The bus has a position but no GPS clock. Recording it
                    // against the Pi's own clock is how a track gets misfiled
                    // for ever, so it is dropped and named.
                    outcome = 'no-gps-time';
                } else {
                    const { append, state } = considerFix(this.state, fix, this.deps.rules);
                    this.state = state;
                    if (append.length > 0) {
                        this.written += this.deps.store.append(append);
                        outcome = 'logged';
                    } else {
                        outcome = 'held';
                    }
                }
            }
        } catch {
            // A tick must never take the recorder down. Signal K restarts.
            outcome = 'unreachable';
        }
        this.lastOutcome = outcome;
        return outcome;
    }
}
