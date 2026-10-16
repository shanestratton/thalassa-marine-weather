/** Passive status never arms. Every write starts with an explicit current phone intent. */
import { AisGuardZone } from '../AisGuardZone';
import { subscribeAuthIdentityScope } from '../authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { radarContextKey } from '../../utils/radarWatchContract';
import { sanitiseCollisionPrefs, type CollisionPrefs } from '../../utils/collisionRule';
import {
    readPiRadarWatch,
    armPiRadarWatch,
    stopPiRadarWatch,
    acknowledgePiRadarWatch,
    reviewPiRadarRelay,
    PiRadarWatchError,
    type PiRadarWatchProof,
} from './piRadarWatch';
import { radarOwnerKey, type PiRadarWatchView } from './piRadarWatchWire';
type Options = { signal?: AbortSignal; isCurrent?: () => boolean; allowCloud?: boolean };
interface Dependencies {
    read(options: Options): Promise<PiRadarWatchProof>;
    arm(
        proof: PiRadarWatchProof,
        prefs: CollisionPrefs,
        replace: boolean,
        options: Options,
    ): Promise<PiRadarWatchProof>;
    off(proof: PiRadarWatchProof, options: Options): Promise<PiRadarWatchProof>;
    ack(proof: PiRadarWatchProof, key: string, options: Options): Promise<PiRadarWatchProof>;
    review(proof: PiRadarWatchProof, options: Options): Promise<PiRadarWatchProof>;
    shield(): boolean;
    prefs(): CollisionPrefs;
    now(): number;
}
class ReviewRequired extends Error {}
export interface PiRadarWatchState {
    view: PiRadarWatchView | null;
    fresh: boolean;
    busy: boolean;
    error: string | null;
    deviceId: string | null;
    now: number;
    source: 'lan' | 'cloud' | null;
}
export class PiRadarWatchController {
    private proof: PiRadarWatchProof | null = null;
    private state: PiRadarWatchState = {
        view: null,
        fresh: false,
        busy: false,
        error: null,
        deviceId: null,
        now: 0,
        source: null,
    };
    private listeners = new Set<() => void>();
    private generation = 0;
    private abort: AbortController | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private holders = 0;
    private pollEpoch = 0;
    private pendingOff = false;
    constructor(private readonly deps: Dependencies) {}
    subscribe = (fn: () => void) => {
        this.listeners.add(fn);
        return () => {
            this.listeners.delete(fn);
        };
    };
    get = (): PiRadarWatchState => {
        if (this.proof && !this.proof.isCurrent()) this.reset();
        return this.state;
    };
    private publish(patch: Partial<PiRadarWatchState>): void {
        this.state = { ...this.state, ...patch, now: this.deps.now() };
        this.listeners.forEach((fn) => fn());
    }
    reset(): void {
        this.generation++;
        this.abort?.abort();
        this.abort = null;
        this.proof = null;
        this.pendingOff = false;
        this.publish({ view: null, fresh: false, busy: false, error: null, deviceId: null, source: null });
    }
    private install(proof: PiRadarWatchProof): void {
        if (!proof.isCurrent()) return;
        const previous = this.proof;
        if (
            previous &&
            radarOwnerKey(previous.view.owner) === radarOwnerKey(proof.view.owner) &&
            previous.view.servedAt > proof.view.servedAt
        )
            return;
        this.proof = proof;
        const view = structuredClone(proof.view);
        if (
            (proof.source === 'cloud' || view.more) &&
            view.context &&
            previous &&
            radarOwnerKey(previous.view.owner) === radarOwnerKey(view.owner) &&
            radarContextKey(previous.view.context) === radarContextKey(view.context)
        ) {
            const seen = new Set(view.alarms.map((c) => c.key)),
                acknowledged = new Set(proof.acknowledgedKeys ?? []);
            const retained = (this.state.view?.alarms ?? [])
                .filter((c) => !c.cleared && !seen.has(c.key) && !acknowledged.has(c.key))
                .map((c) => ({ ...c, unknown: true, cpaNm: null, tcpaMin: null, actionable: false }));
            const all = [...retained, ...view.alarms];
            view.capacity ||= this.state.view?.capacity ?? false;
            view.more ||= this.state.view?.more ?? false;
            view.alarms = all.slice(0, 400);
            view.alarms.sort(
                (a, b) => Number(b.closeQuarters) - Number(a.closeQuarters) || Number(a.unknown) - Number(b.unknown),
            );
            if (all.length > 400) {
                view.capacity = true;
                view.more = true;
            }
        }
        this.publish({
            view,
            fresh: true,
            deviceId: proof.deviceId,
            error: null,
            source: proof.source ?? 'lan',
        });
    }
    private failure(error: unknown): void {
        if (this.proof && !this.proof.isCurrent()) {
            this.reset();
            return;
        }
        this.publish({
            fresh: error instanceof ReviewRequired && this.state.fresh,
            error: error instanceof Error ? error.message : 'Pi radar unavailable.',
        });
    }
    async refresh(allowCloud = false): Promise<void> {
        if (this.state.busy) return;
        this.abort?.abort();
        const abort = new AbortController();
        this.abort = abort;
        const generation = ++this.generation;
        try {
            const result = await this.deps.read({
                signal: abort.signal,
                isCurrent: () => generation === this.generation,
                allowCloud,
            });
            if (generation === this.generation) this.install(result);
        } catch (error) {
            if (generation === this.generation) this.failure(error);
        } finally {
            if (generation === this.generation) this.abort = null;
        }
    }
    /** No cold-start/settings observer calls this method. */
    async armDeliberately(replace = false): Promise<void> {
        this.pendingOff = false;
        await this.write(async (options) => {
            if (!this.deps.shield()) throw Error('Arm the collision shield and complete its sound check first.');
            const proof = replace ? this.reviewed() : await this.deps.read(options);
            if (!options.isCurrent!()) throw Error('Radar action cancelled.');
            if (!replace && proof.view.context && proof.view.context.binding.deviceId !== proof.deviceId) {
                this.install(proof);
                throw new ReviewRequired('Another phone controls this Pi radar watch. Review it before taking over.');
            }
            return this.deps.arm(proof, this.deps.prefs(), replace, {
                ...options,
                isCurrent: () => options.isCurrent!() && this.deps.shield(),
            });
        });
    }
    private reviewed(): PiRadarWatchProof {
        if (!this.proof?.isCurrent() || !this.state.fresh || this.deps.now() - this.proof.view.servedAt > 5000)
            throw Error('Refresh and review the current Pi radar watch first.');
        return this.proof;
    }
    async standDownDeliberately(): Promise<void> {
        if (this.state.busy) {
            this.pendingOff = true;
            return;
        }
        await this.write(async (options) => {
            const proof = await this.deps.read(options);
            if (!options.isCurrent!()) throw Error('Radar action cancelled.');
            this.install(proof);
            if (!proof.view.context) return proof;
            if (proof.view.context.binding.deviceId !== proof.deviceId)
                throw new ReviewRequired('Only the current controller can stand this Pi radar watch down.');
            return this.deps.off(proof, options);
        });
    }
    async acknowledge(key: string): Promise<void> {
        const reviewed = this.proof;
        await this.write(async (options) => {
            if (!reviewed?.isCurrent()) throw Error('Refresh the owned Pi radar watch before acknowledging.');
            const fresh = await this.deps.read({ ...options, allowCloud: true });
            if (
                radarOwnerKey(fresh.view.owner) !== radarOwnerKey(reviewed.view.owner) ||
                radarContextKey(fresh.view.context) !== radarContextKey(reviewed.view.context) ||
                !fresh.view.alarms.some((c) => c.key === key && !c.cleared)
            )
                throw Error('That radar episode changed. Review the current alarm.');
            return this.deps.ack(fresh, key, options);
        });
    }
    async reviewRelay(): Promise<void> {
        await this.write((options) => this.deps.review(this.reviewed(), options));
    }
    private async write(action: (options: Options) => Promise<PiRadarWatchProof>): Promise<void> {
        if (this.state.busy) return;
        this.abort?.abort();
        const abort = new AbortController();
        this.abort = abort;
        const generation = ++this.generation;
        const options = { signal: abort.signal, isCurrent: () => generation === this.generation };
        this.publish({ busy: true, error: null });
        try {
            const result = await action(options);
            if (options.isCurrent()) this.install(result);
        } catch (error) {
            if (options.isCurrent()) this.failure(error);
        } finally {
            if (options.isCurrent()) {
                this.abort = null;
                this.publish({ busy: false });
                if (this.pendingOff) {
                    this.pendingOff = false;
                    void this.standDownDeliberately();
                }
            }
        }
    }
    /** One shared passive poller. Losing a UI lease never sends a stand-down. */
    retain(): () => void {
        this.holders++;
        if (this.holders === 1) {
            const epoch = ++this.pollEpoch;
            const poll = async () => {
                await this.refresh();
                if (this.holders && epoch === this.pollEpoch)
                    this.timer = setTimeout(
                        () => {
                            this.timer = null;
                            void poll();
                        },
                        this.state.source === 'lan' ? 3000 : 10000,
                    );
            };
            void poll();
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this.holders) return;
            this.pollEpoch++;
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            if (!this.state.busy) {
                this.generation++;
                this.abort?.abort();
                this.abort = null;
            }
        };
    }
}
export const PiRadarWatchStateStore = new PiRadarWatchController({
    read: async (options) => {
        try {
            return await readPiRadarWatch(options);
        } catch (error) {
            if (!(error instanceof PiRadarWatchError) || error.code !== 'unavailable') throw error;
            const { readCloudPiRadarWatch } = await import('./piRadarCloud');
            return readCloudPiRadarWatch(options);
        }
    },
    arm: armPiRadarWatch,
    off: stopPiRadarWatch,
    ack: async (proof, key, options) =>
        proof.source === 'cloud'
            ? (await import('./piRadarCloud')).acknowledgeCloudPiRadarWatch(proof, key, options)
            : acknowledgePiRadarWatch(proof, key, options),
    review: reviewPiRadarRelay,
    shield: () => {
        const s = AisGuardZone.getState();
        return s.enabled && s.collisionChecked === true;
    },
    prefs: () => sanitiseCollisionPrefs(useSettingsStore.getState().settings?.collisionAlarm),
    now: Date.now,
});
subscribeAuthIdentityScope(() => PiRadarWatchStateStore.reset());
