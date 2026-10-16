/** Pair/vessel lifecycle for an already operator-configured local reader. HTTP reads never start it. */
import { createHash } from 'node:crypto';
import type { SignalKNotificationSnapshot } from '../signalkProtocol.js';
import type { RadarRawReader } from './rawReader.js';
import { validRadarOwner, type RadarWatchOwner } from './radarWatchContract.js';

const uuid = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function radarContextKey(
    ownerId: unknown,
    piDeviceId: unknown,
    relayId: unknown,
    source: Pick<SignalKNotificationSnapshot, 'state' | 'session'> | null,
): string | null {
    if (
        !uuid(ownerId) ||
        !uuid(piDeviceId) ||
        typeof relayId !== 'string' ||
        !/^[A-Za-z0-9:_-]{1,256}$/.test(relayId) ||
        source?.state !== 'reading' ||
        !uuid(source.session)
    )
        return null;
    // A read session exists only after Signal K verifies self. It is retired on self/connection changes.
    return createHash('sha256')
        .update(JSON.stringify([ownerId, piDeviceId, relayId, source.session]))
        .digest('hex');
}

export class RadarContextSession {
    private context: string | null = null;
    private owner: RadarWatchOwner | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    constructor(
        private readonly reader: Pick<RadarRawReader, 'start' | 'stop' | 'snapshot'>,
        private readonly readContext: () => string | null,
        private readonly readOwner: () => RadarWatchOwner | null = () => null,
    ) {}
    private current(): string | null {
        try {
            const context = this.readContext();
            return context && /^[0-9a-f]{64}$/.test(context) ? context : null;
        } catch {
            return null;
        }
    }
    private state(): { context: string; owner: RadarWatchOwner } | null {
        try {
            const context = this.current(),
                owner = this.readOwner();
            if (!context || !validRadarOwner(owner) || this.current() !== context) return null;
            return { context, owner: { ...owner } };
        } catch {
            return null;
        }
    }
    private same(state: { context: string; owner: RadarWatchOwner } | null): boolean {
        const key = (owner: RadarWatchOwner | null) =>
            owner ? JSON.stringify([owner.ownerId, owner.piDeviceId, owner.pairingId, owner.feedId]) : 'null';
        return (state?.context ?? null) === this.context && key(state?.owner ?? null) === key(this.owner);
    }
    start(): void {
        if (this.timer) return;
        this.refresh();
        this.timer = setInterval(() => this.refresh(), 1000);
        this.timer.unref();
    }
    /** Called by the background lifecycle, never by an HTTP read. */
    refresh(): void {
        const state = this.state();
        if (this.same(state)) return;
        this.retire();
        if (state) {
            this.reader.start(state.context);
            this.context = state.context;
            this.owner = state.owner;
        }
    }
    /** Stop synchronously before changing the owning relay or during source retirement. */
    retire(): void {
        this.context = null;
        this.owner = null;
        this.reader.stop();
    }
    snapshot(): ReturnType<RadarRawReader['snapshot']> & { owner: RadarWatchOwner | null } {
        // Validate both sides of the cache read; neither a request nor a missing owner can start it.
        if (this.context && !this.same(this.state())) this.retire();
        const raw = this.reader.snapshot();
        if (this.context && !this.same(this.state())) this.retire();
        if (!this.context || !this.owner)
            return {
                ...raw,
                connected: false,
                feedId: null,
                ownship: null,
                observations: [],
                lastFrameAt: null,
                lastTargetAt: null,
                owner: null,
            };
        return { ...raw, owner: { ...this.owner } };
    }
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.retire();
    }
}
