/** Private live radar picture. No persistence, cloud feed, filters or alarm-clearing decisions. */
import { RadarFeed, ageRadarContact } from '../../utils/radarFeed';
import type { RadarContact, RadarOwnship } from '../../utils/radarTarget';
import type { OwnedPiRadarPicture } from './piRadar';
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
export interface RadarPiSession {
    readonly feedId: string;
    readonly source: 'pi';
}
export interface RadarPictureSnapshot {
    readonly version: number;
    readonly contacts: readonly RadarContact[];
    readonly feeds: readonly {
        feedId: string;
        source: 'gateway' | 'pi';
        ownship: RadarOwnship | null;
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

function freezeOwnship(own: RadarOwnship | null): RadarOwnship | null {
    return own
        ? Object.freeze({
              ...own,
              position: own.position ? Object.freeze({ ...own.position }) : null,
              heading: own.heading ? Object.freeze({ ...own.heading }) : null,
              motion: own.motion ? Object.freeze({ ...own.motion }) : null,
          })
        : null;
}

const EMPTY: RadarPictureSnapshot = Object.freeze({
    version: 0,
    contacts: Object.freeze([]),
    feeds: Object.freeze([]),
});

/** One selected physical gateway input; replacement tokens cannot revive or retire their successor. */
export class RadarPictureStore {
    private entry: Entry | null = null;
    private pi: { token: RadarPiSession; owner: AuthIdentityScope; picture: OwnedPiRadarPicture } | null = null;
    private gatewayState = EMPTY;
    private piState = EMPTY;
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
    getSnapshot = (): RadarPictureSnapshot => {
        if (this.disposed) return EMPTY;
        const gateway = this.entry && this.deps.current(this.entry.owner);
        const pi = this.pi && this.deps.current(this.pi.owner) && this.pi.picture.isCurrent();
        return gateway ? (pi ? this.state : this.gatewayState) : pi ? this.piState : EMPTY;
    };
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
        if (this.entry?.token !== token) return;
        this.entry.feed.reset();
        this.entry = null;
        this.stopIdleTimer();
        this.publish();
    }
    /** Install one verified paired cache; stale async polls cannot replace a newer packet. */
    acceptPi(picture: OwnedPiRadarPicture): RadarPiSession | null {
        if (this.disposed || !picture.isCurrent()) return null;
        const owner = this.deps.scope();
        const previous = this.pi && this.deps.current(this.pi.owner) && this.pi.picture.isCurrent() ? this.pi : null;
        if (!this.deps.current(owner) || (previous && picture.servedAt < previous.picture.servedAt)) return null;
        if (!picture.connected || !picture.feedId) {
            this.pi = null;
            this.stopIdleTimer();
            this.publish();
            return null;
        }
        const token =
            previous?.token.feedId === picture.feedId
                ? previous.token
                : Object.freeze({ source: 'pi' as const, feedId: picture.feedId });
        this.pi = {
            token,
            owner,
            picture: {
                ...picture,
                contacts: picture.contacts.map(freezeContact),
                ownship: freezeOwnship(picture.ownship),
            },
        };
        this.cancelTick ??= this.deps.schedule(() => this.tick());
        this.publish();
        return token;
    }
    retirePi(token: RadarPiSession): void {
        if (this.pi?.token !== token) return;
        this.pi = null;
        this.stopIdleTimer();
        this.publish();
    }
    private stopIdleTimer(): void {
        if (!this.entry && !this.pi) {
            this.cancelTick?.();
            this.cancelTick = null;
        }
    }
    tick(): void {
        if (this.disposed) return;
        if (this.entry && !this.deps.current(this.entry.owner)) {
            this.entry.feed.reset();
            this.entry = null;
        }
        if (this.pi && (!this.deps.current(this.pi.owner) || !this.pi.picture.isCurrent())) this.pi = null;
        this.stopIdleTimer();
        this.publish();
    }
    private publish(): void {
        const entry = this.entry,
            pi = this.pi,
            now = this.deps.now();
        const gatewayContacts = entry ? entry.feed.contacts(now).map(freezeContact) : [];
        const gatewayFeeds = entry
            ? [
                  Object.freeze({
                      feedId: entry.token.feedId,
                      source: entry.token.source,
                      ownship: freezeOwnship(entry.feed.ownshipSnapshot()),
                      lastFrameAt: entry.lastFrameAt,
                      lastTargetAt: entry.lastTargetAt,
                  }),
              ]
            : [];
        const piContacts = pi
            ? pi.picture.contacts
                  .filter((c) => now - c.at <= 120_000)
                  .map((c) => freezeContact(ageRadarContact(c, now)))
            : [];
        const piFeeds = pi
            ? [
                  Object.freeze({
                      feedId: pi.token.feedId,
                      source: pi.token.source,
                      ownship: pi.picture.ownship,
                      lastFrameAt: pi.picture.lastFrameAt,
                      lastTargetAt: pi.picture.lastTargetAt,
                  }),
              ]
            : [];
        const snapshot = (contacts: RadarContact[], feeds: RadarPictureSnapshot['feeds']): RadarPictureSnapshot =>
            Object.freeze({
                version: this.state.version + 1,
                contacts: Object.freeze(contacts),
                feeds: Object.freeze(feeds),
            });
        this.gatewayState = snapshot(gatewayContacts, gatewayFeeds);
        this.piState = snapshot(piContacts, piFeeds);
        this.state = snapshot([...gatewayContacts, ...piContacts], [...gatewayFeeds, ...piFeeds]);
        for (const listener of [...this.listeners]) listener();
    }
    reset(): void {
        this.entry?.feed.reset();
        this.entry = null;
        this.pi = null;
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
