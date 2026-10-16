/** Pair/vessel lifecycle for an already operator-configured local reader. HTTP reads never start it. */
import { createHash } from 'node:crypto';
import type { SignalKNotificationSnapshot } from '../signalkProtocol.js';
import type { RadarRawReader } from './rawReader.js';

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
    private timer: ReturnType<typeof setInterval> | null = null;
    constructor(
        private readonly reader: Pick<RadarRawReader, 'start' | 'stop' | 'snapshot'>,
        private readonly readContext: () => string | null,
    ) {}
    private current(): string | null {
        try {
            const context = this.readContext();
            return context && /^[0-9a-f]{64}$/.test(context) ? context : null;
        } catch {
            return null;
        }
    }
    start(): void {
        if (this.timer) return;
        this.refresh();
        this.timer = setInterval(() => this.refresh(), 1000);
        this.timer.unref();
    }
    /** Called by the background lifecycle, never by an HTTP read. */
    refresh(): void {
        const context = this.current();
        if (context === this.context) return;
        this.retire();
        if (context) {
            this.reader.start(context);
            this.context = context;
        }
    }
    /** Stop synchronously before changing the owning relay or during source retirement. */
    retire(): void {
        this.context = null;
        this.reader.stop();
    }
    snapshot(): ReturnType<RadarRawReader['snapshot']> {
        // A source/account transition may precede the next background tick. Drop it before serializing.
        if (this.current() !== this.context) this.retire();
        return this.reader.snapshot();
    }
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.retire();
    }
}
