/**
 * Which gateway to talk to: the Pi, or the YDWG direct.
 *
 * Shane 2026-08-29: "yes most definitely auto swap to direct for 3 people if
 * the pi dies."
 *
 * THE SHAPE OF THE PROBLEM. Once the Pi is aboard it takes one of the
 * YDWG-02's three TCP slots and re-serves the bus to everyone, which is how a
 * crew of four all get instruments. But that makes the Pi a single point of
 * failure for something that used to work for three people without it. So if
 * the Pi stops answering, every device falls back to the gateway directly —
 * and three of them will get in, which is the same three who would have had
 * data before the Pi existed. Nobody ends up worse off than they started.
 *
 * WHY THIS IS ITS OWN MODULE. The rule it encodes is not "try the other one".
 * It is a hysteresis problem, and this app has been bitten by that twice this
 * week — a wind panel that strobed between live and no-data, and a sail plan
 * that changed its mind every five seconds. A source that flaps is worse than
 * either source alone: it re-opens sockets, burns gateway slots, and shows the
 * skipper a connection that never settles.
 *
 * So the rules are deliberately asymmetric, the same way the sail plan's are:
 *
 *   LEAVING the Pi is patient. One failed cycle is a hiccup — a Wi-Fi roam, a
 *   Signal K restart. It takes several consecutive failures before the Pi is
 *   declared gone, because falling back costs a gateway slot that somebody
 *   else may be using.
 *
 *   RETURNING to the Pi is more patient still, and never speculative. While on
 *   the fallback the Pi is probed on a slow cadence, and the switch back only
 *   happens once it has actually DELIVERED DATA — not merely accepted a
 *   socket. That distinction is the whole lesson of the 2026-08-28 gateway
 *   work: a completed handshake is not a feed.
 */

export type GatewaySourceKind = 'pi' | 'direct';

export interface GatewayEndpoint {
    host: string;
    port: number;
}

/** Consecutive failed cycles on the Pi before the fallback is worth its slot. */
export const FAILURES_BEFORE_FALLBACK = 3;
/** How often to see whether the Pi is back, while running on the fallback. */
export const PI_PROBE_INTERVAL_MS = 3 * 60 * 1000;

export interface GatewaySourceState {
    kind: GatewaySourceKind;
    endpoint: GatewayEndpoint;
    /** True when this source has delivered at least one sentence. */
    proven: boolean;
}

/**
 * Pure decision state. Feed it outcomes; ask it where to connect. No sockets,
 * no timers — the caller owns both, so this can be tested exhaustively.
 */
export class GatewaySourceSelector {
    private kind: GatewaySourceKind;
    private consecutiveFailures = 0;
    private lastProbeAt = 0;
    private provenSince: number | null = null;

    constructor(
        private readonly pi: GatewayEndpoint | null,
        private readonly direct: GatewayEndpoint,
        startOn: GatewaySourceKind = 'pi',
    ) {
        // With no Pi configured there is nothing to prefer, and the fallback
        // is simply the gateway — which is exactly today's behaviour.
        this.kind = pi && startOn === 'pi' ? 'pi' : 'direct';
    }

    current(): GatewaySourceState {
        return {
            kind: this.kind,
            endpoint: this.kind === 'pi' && this.pi ? this.pi : this.direct,
            proven: this.provenSince !== null,
        };
    }

    /** A socket on the current source delivered a sentence. */
    onFed(now: number): void {
        this.consecutiveFailures = 0;
        if (this.provenSince === null) this.provenSince = now;
    }

    /**
     * A cycle on the current source ended without ever being fed — a refused
     * connect, a reset, an accepted socket that never spoke.
     *
     * Returns true when this caused a switch, so the caller can log it once
     * rather than on every failure.
     */
    onFailedCycle(now: number): boolean {
        this.consecutiveFailures += 1;
        this.provenSince = null;
        if (this.kind !== 'pi' || !this.pi) return false;
        if (this.consecutiveFailures < FAILURES_BEFORE_FALLBACK) return false;
        this.kind = 'direct';
        this.consecutiveFailures = 0;
        this.lastProbeAt = now;
        return true;
    }

    /**
     * Is it time to see whether the Pi is back?
     *
     * Only meaningful on the fallback. The caller opens a probe connection and
     * reports the result to `onProbeResult` — the running feed is left alone
     * until the Pi has proved itself, because interrupting a working
     * connection to try a hopeful one is how a skipper loses instruments at
     * the wrong moment.
     */
    shouldProbePi(now: number): boolean {
        if (this.kind !== 'direct' || !this.pi) return false;
        return now - this.lastProbeAt >= PI_PROBE_INTERVAL_MS;
    }

    /**
     * `fed` must mean the probe RECEIVED DATA, not that it connected. A
     * completed handshake is not a feed — that is the whole lesson of the
     * gateway work of 2026-08-28, where an accepted-then-reset socket read as
     * a healthy connection and strobed the panel for a day.
     */
    onProbeResult(now: number, fed: boolean): boolean {
        this.lastProbeAt = now;
        if (!fed || !this.pi) return false;
        this.kind = 'pi';
        this.consecutiveFailures = 0;
        this.provenSince = null;
        return true;
    }

    /** For the panel: what a skipper should be told they are reading from. */
    describe(): string {
        if (!this.pi) return 'Gateway';
        return this.kind === 'pi' ? 'Boat Pi' : 'Gateway (Pi unavailable)';
    }
}
