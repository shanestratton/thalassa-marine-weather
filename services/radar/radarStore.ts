/** Private live radar picture. No persistence, cloud feed, filters or alarm-clearing decisions. */
import { RadarFeed } from '../../utils/radarFeed';
import type { RadarContact } from '../../utils/radarTarget';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';

export interface RadarInputSession {
    readonly feedId: string;
    readonly source: 'gateway';
}
export interface RadarPictureSnapshot {
    readonly version: number;
    readonly contacts: readonly RadarContact[];
    readonly feeds: readonly {
        feedId: string;
        source: 'gateway';
        lastFrameAt: number | null;
        lastTargetAt: number | null;
    }[];
}
interface Entry {
    token: RadarInputSession;
    owner: AuthIdentityScope;
    feed: RadarFeed;
    lastFrameAt: number | null;
    lastTargetAt: number | null;
}
interface Dependencies {
    scope: () => AuthIdentityScope;
    current: (scope: AuthIdentityScope) => boolean;
    identityChanged: (listener: () => void) => () => void;
    now: () => number;
    id: () => string;
    schedule: (listener: () => void) => () => void;
}
const defaults: Dependencies = {
    scope: getAuthIdentityScope,
    current: isAuthIdentityScopeCurrent,
    identityChanged: (listener) => subscribeAuthIdentityScope(listener),
    now: Date.now,
    id: () => crypto.randomUUID().replaceAll('-', ''),
    schedule: (listener) => {
        const timer = setInterval(listener, 1000);
        return () => clearInterval(timer);
    },
};
function freezeContact(contact: RadarContact): RadarContact {
    return Object.freeze({
        ...contact,
        position: contact.position ? Object.freeze({ ...contact.position }) : null,
        motion: contact.motion ? Object.freeze({ ...contact.motion }) : null,
    });
}

const EMPTY: RadarPictureSnapshot = Object.freeze({
    version: 0,
    contacts: Object.freeze([]),
    feeds: Object.freeze([]),
});

/** One selected physical gateway input; replacement tokens cannot revive or retire their successor. */
export class RadarPictureStore {
    private entry: Entry | null = null;
    private listeners = new Set<() => void>();
    private cancelTick: (() => void) | null = null;
    private removeIdentity: () => void;
    private disposed = false;
    private state: RadarPictureSnapshot = EMPTY;
    private readonly deps: Dependencies;
    constructor(deps: Partial<Dependencies> = {}) {
        this.deps = { ...defaults, ...deps };
        this.removeIdentity = this.deps.identityChanged(() => this.reset());
    }
    getSnapshot = (): RadarPictureSnapshot =>
        this.disposed || (this.entry && !this.deps.current(this.entry.owner)) ? EMPTY : this.state;
    subscribe = (listener: () => void): (() => void) => {
        if (this.disposed) return () => undefined;
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    openGateway(): RadarInputSession | null {
        if (this.disposed) return null;
        const id = this.deps.id();
        if (!/^[a-f0-9]{32}$/.test(id)) return null;
        const owner = this.deps.scope();
        if (!this.deps.current(owner)) return null;
        const token = Object.freeze({ source: 'gateway' as const, feedId: `gateway:${id}` });
        this.entry = { token, owner, feed: new RadarFeed(token.feedId), lastFrameAt: null, lastTargetAt: null };
        this.cancelTick ??= this.deps.schedule(() => this.tick());
        this.publish();
        return token;
    }
    ingest(token: RadarInputSession, sentence: string, receivedAt: number): boolean {
        const entry = this.entry;
        if (this.disposed || !entry || entry.token !== token || !this.deps.current(entry.owner)) return false;
        const accepted = entry.feed.ingest(sentence, receivedAt, this.deps.now());
        if (!accepted) return false;
        entry.lastFrameAt = Math.max(entry.lastFrameAt ?? 0, receivedAt);
        if (accepted === 'target') entry.lastTargetAt = Math.max(entry.lastTargetAt ?? 0, receivedAt);
        this.publish();
        return true;
    }
    retire(token: RadarInputSession): void {
        if (this.entry?.token === token) this.reset();
    }
    tick(): void {
        if (this.disposed) return;
        if (this.entry && !this.deps.current(this.entry.owner)) this.reset();
        else if (this.entry) this.publish();
    }
    private publish(): void {
        const entry = this.entry;
        this.state = Object.freeze({
            version: this.state.version + 1,
            contacts: Object.freeze(entry ? entry.feed.contacts(this.deps.now()).map(freezeContact) : []),
            feeds: Object.freeze(
                entry
                    ? [
                          Object.freeze({
                              feedId: entry.token.feedId,
                              source: entry.token.source,
                              lastFrameAt: entry.lastFrameAt,
                              lastTargetAt: entry.lastTargetAt,
                          }),
                      ]
                    : [],
            ),
        });
        for (const listener of [...this.listeners]) listener();
    }
    reset(): void {
        this.entry?.feed.reset();
        this.entry = null;
        this.cancelTick?.();
        this.cancelTick = null;
        this.publish();
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.removeIdentity();
        this.reset();
        this.listeners.clear();
    }
}
export const RadarStore = new RadarPictureStore();
