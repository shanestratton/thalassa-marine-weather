import { canonicalPiAlarmRelayEndpoint } from '../piAlarmRelay.js';
import { wakeHash, wakeRecord, wakeUuid, type WakeRelayConflict } from './contract.js';
import {
    wakeCloudContextKey,
    parseWakeCloudContext,
    WAKE_RELAY_KINDS,
    type WakeCloudContext,
    type WakeRelayPass,
    type WakePushStatus,
} from './relayProtocol.js';

export interface WakeRelayDeps {
    endpoint: string;
    fetchImpl: typeof fetch;
    anonKey: () => string;
    credentials: () => { relayId: string; token: string } | null;
    ownerId: () => string | null;
    internetAllowed: () => boolean;
    now?: () => number;
    higherPriority?: () => 'none' | 'anchor' | 'collision' | 'distress';
}
const eventKey = /^wake-(depth|wind|speed|pressure|coolant|oil|rpm|battery):[0-9a-f]{12}:[0-9]{10,13}$/;
const unknownStatus = (): WakePushStatus => ({
    state: 'unavailable',
    capability: 0,
    checkedAt: null,
    contextRevision: null,
});
/** Serialized fixed requests only. No controller request or source document can choose the destination. */
export class WakeRelay {
    private view = unknownStatus();
    private identity: string | null = null;
    private cloud: WakeCloudContext | null = null;
    private cloudRevision: string | null = null;
    private desired: WakeRelayPass | null = null;
    private generation = 0;
    private pending: Promise<void> | null = null;
    private lastAt = -Infinity;
    private devices = 0;
    private capabilityAt = -Infinity;
    private changed = false;
    private owedRetire: { context: WakeCloudContext; revision: string; identity: string } | null = null;
    private blockedConflict = false;
    private conflict: WakeRelayConflict | null = null;
    private conflictAt = -Infinity;
    private reviewedRevision: string | null = null;
    private applyAck: (contextKey: string, keys: readonly string[], now: number) => void = () => undefined;
    private isCurrent: () => boolean = () => false;
    constructor(private readonly deps: WakeRelayDeps) {
        const url = new URL(deps.endpoint);
        if (canonicalPiAlarmRelayEndpoint(url.origin) !== deps.endpoint)
            throw Error('Fixed wake relay endpoint required');
    }
    private now() {
        return (this.deps.now ?? Date.now)();
    }
    private credentialsKey(): string | null {
        const c = this.deps.credentials(),
            owner = this.deps.ownerId(),
            anon = this.deps.anonKey();
        return c && owner && anon ? wakeHash(JSON.stringify([owner, c.relayId, c.token, anon])) : null;
    }
    private blocked(): WakePushStatus['state'] | null {
        return !this.deps.internetAllowed() ? 'internet-off' : !this.credentialsKey() ? 'not-paired' : null;
    }
    status(): WakePushStatus {
        const blocked = this.blocked();
        if (blocked || this.identity !== this.credentialsKey())
            return { ...unknownStatus(), state: blocked ?? 'unavailable' };
        if (this.blockedConflict && this.isCurrent())
            return {
                ...unknownStatus(),
                state: 'conflict',
                ...(this.conflict && this.now() >= this.conflictAt && this.now() - this.conflictAt <= 30_000
                    ? { conflict: structuredClone(this.conflict), checkedAt: this.conflictAt }
                    : {}),
            };
        if (
            !this.isCurrent() ||
            this.view.checkedAt === null ||
            this.now() < this.view.checkedAt ||
            this.now() - this.view.checkedAt > 30_000
        )
            return unknownStatus();
        return { ...this.view };
    }
    /** Clear synchronously before a source/account/configuration retirement; no optimistic old green. */
    retire(): void {
        if (this.cloud && this.cloudRevision && this.identity)
            this.owedRetire = {
                context: structuredClone(this.cloud),
                revision: this.cloudRevision,
                identity: this.identity,
            };
        this.generation++;
        this.desired = null;
        this.isCurrent = () => false;
        this.view = unknownStatus();
        this.reviewedRevision = null;
        this.conflict = null;
        this.changed = true;
        this.schedule();
    }
    private schedule(): void {
        if (!this.pending)
            this.pending = this.run().finally(() => {
                this.pending = null;
                if (this.changed && (this.desired || this.owedRetire)) this.schedule();
            });
    }
    update(pass: WakeRelayPass | null, isCurrent: () => boolean, applyAck: typeof this.applyAck): void {
        if (!pass) {
            this.retire();
            return;
        }
        const next = wakeCloudContextKey(pass.context),
            old = this.desired && wakeCloudContextKey(this.desired.context);
        if (next !== old) {
            this.generation++;
            this.changed = true;
            this.view = unknownStatus();
            this.blockedConflict = false;
            this.reviewedRevision = null;
            this.conflict = null;
        }
        this.desired = structuredClone(pass);
        this.isCurrent = isCurrent;
        this.applyAck = applyAck;
        if (!this.pending && (this.changed || this.now() - this.lastAt >= 5000)) this.schedule();
    }
    /** Test/shutdown seam; caller never waits inside the keeper's source evaluation. */
    async settled(): Promise<void> {
        while (this.pending) await this.pending;
    }
    /** Explicit enrolled-owner review authorizes exactly one currently displayed cloud revision. */
    review(expected: string, localContextKey: string): boolean {
        if (
            !this.blockedConflict ||
            !this.conflict ||
            this.conflict.revision !== expected ||
            !this.desired ||
            wakeCloudContextKey(this.desired.context) !== localContextKey ||
            !this.isCurrent() ||
            this.identity !== this.credentialsKey() ||
            this.now() < this.conflictAt ||
            this.now() - this.conflictAt > 30_000
        )
            return false;
        this.generation++;
        this.reviewedRevision = expected;
        this.changed = true;
        this.schedule();
        return true;
    }
    private async post(
        body: Record<string, unknown>,
        generation: number,
        cancelOnly = false,
    ): Promise<Record<string, unknown> | null> {
        if (this.blocked() || generation !== this.generation || (!cancelOnly && !this.isCurrent())) return null;
        const c = this.deps.credentials(),
            anon = this.deps.anonKey(),
            identity = this.credentialsKey();
        if (!c || !anon || !identity) return null;
        const encoded = JSON.stringify(body);
        if (Buffer.byteLength(encoded) > 8192) return null;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const request = async () => {
                const response = await this.deps.fetchImpl(this.deps.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        apikey: anon,
                        Authorization: `Bearer ${anon}`,
                        'X-Thalassa-Pi-Relay-Id': c.relayId,
                        'X-Thalassa-Pi-Relay-Token': c.token,
                    },
                    body: encoded,
                    signal: controller.signal,
                    redirect: 'error',
                    cache: 'no-store',
                });
                if (response.status === 409) {
                    await response.body?.cancel();
                    return { wakeConflict: true };
                }
                if (!response.ok) {
                    await response.body?.cancel();
                    return null;
                }
                const reader = response.body?.getReader();
                if (!reader) return null;
                const chunks: Uint8Array[] = [];
                let size = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        size += value.byteLength;
                        if (size > 8192) {
                            await reader.cancel();
                            return null;
                        }
                        chunks.push(value);
                    }
                } finally {
                    reader.releaseLock();
                }
                const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                return wakeRecord(value) ? value : null;
            };
            const answer = await Promise.race([
                request(),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        resolve(null);
                    }, 8000);
                    timer.unref();
                }),
            ]);
            const valid =
                generation === this.generation &&
                identity === this.credentialsKey() &&
                (cancelOnly || this.isCurrent());
            if (valid && answer?.wakeConflict === true) {
                this.blockedConflict = true;
                return null;
            }
            return valid ? answer : null;
        } catch {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    private async run(): Promise<void> {
        this.lastAt = this.now();
        this.changed = false;
        const pass = this.desired,
            generation = this.generation;
        const reviewIntent = this.reviewedRevision;
        this.reviewedRevision = null;
        const retire = this.owedRetire;
        if (retire) {
            this.owedRetire = null;
            if (retire.identity === this.credentialsKey() && !this.blocked()) {
                const answer = await this.post(
                    { family: 'wake', action: 'retire', context: retire.context, contextRevision: retire.revision },
                    generation,
                    true,
                );
                if (generation !== this.generation) return;
                if (answer?.ok === true && answer.retired === true && wakeUuid(answer.contextRevision))
                    this.cloudRevision = answer.contextRevision;
            }
        }
        if (!pass || this.blocked() || !this.isCurrent() || pass.context.binding.ownerId !== this.deps.ownerId()) {
            this.view = unknownStatus();
            return;
        }
        const identity = this.credentialsKey(),
            key = wakeCloudContextKey(pass.context);
        if (identity !== this.identity) {
            this.identity = identity;
            this.cloud = null;
            this.cloudRevision = null;
            this.blockedConflict = false;
        }
        const current = () => generation === this.generation && this.isCurrent() && identity === this.credentialsKey();
        let bound: Record<string, unknown> | null;
        if (
            this.cloud &&
            wakeCloudContextKey(this.cloud) === key &&
            this.cloudRevision &&
            this.view.capability === 1 &&
            !this.blockedConflict &&
            this.now() >= this.capabilityAt &&
            this.now() - this.capabilityAt < 60_000
        ) {
            bound = { ok: true, wake: { v: 1, enabled: true }, contextRevision: this.cloudRevision };
        } else {
            const probe = await this.post({ family: 'wake', action: 'probe' }, generation);
            if (!current()) return;
            if (
                !probe ||
                probe.ok !== true ||
                !wakeRecord(probe.wake) ||
                probe.wake.v !== 1 ||
                probe.wake.enabled !== true ||
                !Number.isSafeInteger(probe.devices) ||
                (probe.devices as number) < 0 ||
                (probe.devices as number) > 1000 ||
                !(probe.contextRevision === null || wakeUuid(probe.contextRevision)) ||
                typeof probe.retired !== 'boolean'
            ) {
                this.view = unknownStatus();
                return;
            }
            this.devices = probe.devices as number;
            // A new process may resume only the identical saved configuration (new instance).
            // A known previous revision can be replaced after a local configuration CAS.
            const remote = probe.context === null ? null : parseWakeCloudContext(probe.context);
            const sameSaved = !!remote && wakeCloudContextKey({ ...remote, instance: pass.context.instance }) === key;
            const known =
                !!remote &&
                !!this.cloud &&
                probe.contextRevision === this.cloudRevision &&
                wakeCloudContextKey(remote) === wakeCloudContextKey(this.cloud);
            const samePair =
                !!remote &&
                remote.binding.ownerId === pass.context.binding.ownerId &&
                remote.binding.piDeviceId === pass.context.binding.piDeviceId &&
                remote.binding.pairingId === pass.context.binding.pairingId;
            const reviewed = samePair && reviewIntent === probe.contextRevision;
            if (
                probe.context !== null &&
                (!samePair ||
                    !remote ||
                    !wakeUuid(probe.contextRevision) ||
                    (!reviewed && ((probe.retired && !known) || (!sameSaved && !known) || this.blockedConflict)))
            ) {
                this.blockedConflict = true;
                this.reviewedRevision = null;
                this.conflict =
                    remote && samePair && wakeUuid(probe.contextRevision)
                        ? {
                              revision: probe.contextRevision,
                              configurationRevision: remote.configurationRevision,
                              rulesDigest: remote.rulesDigest,
                              feedMatches: remote.binding.feedId === pass.context.binding.feedId,
                              retired: probe.retired,
                              rules: remote.rules.map((r) => ({
                                  preset: WAKE_RELAY_KINDS[r.kind],
                                  enabled: r.enabled,
                                  threshold: r.threshold,
                                  sourceMatches:
                                      r.sourceKey === pass.context.rules.find((p) => p.kind === r.kind)?.sourceKey,
                                  quietHours: r.quietHours ? { ...r.quietHours } : null,
                              })),
                          }
                        : null;
                this.conflictAt = this.now();
                this.view = { ...unknownStatus(), state: 'conflict' };
                return;
            }
            bound = await this.post(
                {
                    family: 'wake',
                    action: 'bind',
                    context: pass.context,
                    expectedContextRevision: probe.contextRevision,
                },
                generation,
            );
            this.capabilityAt = this.now();
        }
        if (!current()) return;
        if (
            !bound ||
            bound.ok !== true ||
            !wakeUuid(bound.contextRevision) ||
            !wakeRecord(bound.wake) ||
            bound.wake.enabled !== true ||
            bound.wake.v !== 1
        ) {
            this.view = { ...unknownStatus(), state: this.blockedConflict ? 'conflict' : 'unavailable' };
            return;
        }
        this.cloud = structuredClone(pass.context);
        this.cloudRevision = bound.contextRevision;
        this.blockedConflict = false;
        this.conflict = null;
        this.reviewedRevision = null;
        // Handshakes may take time. Use the latest complete owned snapshot;
        // never substitute receipt time for its original sensor/evaluation clocks.
        const snapshot = this.desired && wakeCloudContextKey(this.desired.context) === key ? this.desired : pass;
        const answer = await this.post(
            {
                family: 'wake',
                action: 'sync',
                context: pass.context,
                contextRevision: bound.contextRevision,
                evaluatedAt: snapshot.evaluatedAt,
                higherPriority: this.deps.higherPriority?.() ?? 'none',
                states: snapshot.states,
            },
            generation,
        );
        if (!current()) return;
        if (
            !answer ||
            answer.ok !== true ||
            answer.contextRevision !== bound.contextRevision ||
            !wakeRecord(answer.wake) ||
            answer.wake.v !== 1 ||
            answer.wake.enabled !== true ||
            !Array.isArray(answer.acked) ||
            answer.acked.length > 8 ||
            answer.acked.some((k) => typeof k !== 'string' || !eventKey.test(k)) ||
            !Number.isSafeInteger(answer.queued) ||
            (answer.queued as number) < 0 ||
            (answer.queued as number) > 8
        ) {
            this.view = { ...unknownStatus(), state: this.blockedConflict ? 'conflict' : 'unavailable' };
            return;
        }
        this.applyAck(key, answer.acked as string[], this.now());
        this.view = {
            state: this.devices > 0 ? 'ready' : 'unavailable',
            capability: 1,
            checkedAt: this.now(),
            contextRevision: bound.contextRevision,
        };
    }
}
