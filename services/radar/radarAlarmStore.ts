/** Private phone radar encounters. Identity changes retire RAM, never another family's alarms. */
import { RadarEncounters, type RadarEncounterCard } from '../../utils/radarEncounters';
import type { RadarCollisionCandidate } from '../../utils/radarCollision';
import type { EncounterOwnState } from '../../utils/collisionEncounter';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
export interface RadarAlarmSnapshot {
    readonly armed: boolean;
    readonly cards: readonly RadarEncounterCard[];
    readonly capacity: Readonly<{ sourceAt: number; acknowledged: boolean }> | null;
    readonly feeds: number;
    readonly qualifiedFeeds: number;
}
const EMPTY: RadarAlarmSnapshot = Object.freeze({
    armed: false,
    cards: Object.freeze([]),
    capacity: null,
    feeds: 0,
    qualifiedFeeds: 0,
});
interface Dependencies {
    scope: () => AuthIdentityScope;
    current: (owner: AuthIdentityScope) => boolean;
    identityChanged: (listener: () => void) => () => void;
    epoch: () => string;
    now: () => number;
}
const defaults: Dependencies = {
    scope: getAuthIdentityScope,
    current: isAuthIdentityScopeCurrent,
    identityChanged: (listener) => subscribeAuthIdentityScope(listener),
    epoch: () => crypto.randomUUID().replaceAll('-', ''),
    now: Date.now,
};
export class RadarAlarmState {
    private readonly deps: Dependencies;
    private owner: AuthIdentityScope;
    private model: RadarEncounters | null = null;
    private state = EMPTY;
    private listeners = new Set<() => void>();
    private readonly removeIdentity: () => void;
    constructor(deps: Partial<Dependencies> = {}) {
        this.deps = { ...defaults, ...deps };
        this.owner = this.deps.scope();
        this.removeIdentity = this.deps.identityChanged(() => this.retire());
    }
    get = (): RadarAlarmSnapshot => (this.deps.current(this.owner) ? this.state : EMPTY);
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private publish(now = this.deps.now()): void {
        const cards = this.model?.cards(now) ?? [];
        this.state = Object.freeze({
            ...this.state,
            cards: Object.freeze(
                cards.map((c) =>
                    Object.freeze({
                        ...c,
                        assessment: Object.freeze({ ...c.assessment }),
                        ...(c.lost ? { lost: Object.freeze({ ...c.lost }) } : {}),
                    }),
                ),
            ),
            capacity: this.model?.capacity() ?? null,
        });
        this.listeners.forEach((fn) => fn());
    }
    private retire(): void {
        this.model?.reset();
        this.model = null;
        this.owner = this.deps.scope();
        this.state = EMPTY;
        this.listeners.forEach((fn) => fn());
    }
    setArmed(armed: boolean): void {
        if (!this.deps.current(this.owner)) this.retire();
        if (armed === this.state.armed) return;
        if (!armed) return this.retire();
        this.model = new RadarEncounters(this.deps.epoch());
        this.state = { ...EMPTY, armed: true };
        this.publish();
    }
    update(
        candidates: readonly RadarCollisionCandidate[],
        own: (c: RadarCollisionCandidate | undefined, key: string) => EncounterOwnState,
        status: { feeds: number; qualifiedFeeds: number },
        now = this.deps.now(),
    ): void {
        if (!this.deps.current(this.owner) || !this.model || !this.state.armed) return;
        this.model.update(candidates, own, now);
        this.state = {
            ...this.state,
            feeds: Math.max(0, Math.min(2, status.feeds)),
            qualifiedFeeds: Math.max(0, Math.min(2, status.qualifiedFeeds)),
        };
        this.publish(now);
    }
    acknowledge(input: {
        contactKey: string;
        episodeId: string;
        kind: 'radar-collision' | 'radar-close-quarters';
    }): boolean {
        if (!this.deps.current(this.owner) || !this.model) return false;
        const now = this.deps.now(),
            accepted = this.model.acknowledge(input, now);
        if (accepted) this.publish(now);
        return accepted;
    }
    dismiss(contactKey: string, episodeId: string): void {
        if (!this.deps.current(this.owner) || !this.model) return;
        this.model.dismiss(contactKey, episodeId);
        this.publish();
    }
    acknowledgeCapacity(sourceAt: number): void {
        if (this.deps.current(this.owner) && this.model?.acknowledgeCapacity(sourceAt)) this.publish();
    }
    dispose(): void {
        this.retire();
        this.removeIdentity();
        this.listeners.clear();
    }
}
export const RadarAlarmStore = new RadarAlarmState();
