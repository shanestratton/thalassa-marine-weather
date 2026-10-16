/** Fixed radar family only; no raw observations, positions, names or destination supplied by a phone. */
import { createHash } from 'node:crypto';
import { canonicalPiAlarmRelayEndpoint } from '../piAlarmRelay.js';
import { radarContextKey, radarRecord, validRadarContext } from './radarWatchContract.js';
import {
    RADAR_RELAY_BATCH,
    RADAR_RELAY_KEY,
    type RadarRelayAck,
    type RadarRelayContext,
    type RadarRelayResolved,
    type RadarRelayUpsert,
} from './radarRelayContract.js';
import type { RadarWatchEvent, RadarWatchRelayPass } from './watch.js';
export interface RadarRelayDeps {
    endpoint: string;
    fetchImpl: typeof fetch;
    anonKey: () => string;
    credentials: () => { relayId: string; token: string } | null;
    ownerId: () => string | null;
    internetAllowed: () => boolean;
    now?: () => number;
}
export interface RadarRelayStatus {
    state: 'unavailable' | 'ready' | 'internet-off' | 'not-paired' | 'conflict';
    checkedAt: number | null;
    conflictRevision?: string;
}
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const MAX_KNOWN = 800,
    MAX_PENDING = 1200;
export class RadarRelay {
    private pass: RadarWatchRelayPass | null = null;
    private current: () => boolean = () => false;
    private applyAck: (
        context: RadarRelayContext,
        acks: readonly { key: string; ackedAt: number }[],
    ) => void | Promise<void> = () => {};
    private generation = 0;
    private identity: string | null = null;
    private cloud: { context: RadarRelayContext; revision: string } | null = null;
    private owedRetire: { context: RadarRelayContext; revision: string; identity: string } | null = null;
    private latest = new Map<string, RadarRelayUpsert>();
    private known = new Set<string>();
    private inFlight = new Set<string>();
    private acks = new Map<string, RadarRelayAck>();
    private resolved = new Map<string, RadarRelayResolved>();
    private pending: Promise<void> | null = null;
    private lastAttempt = -Infinity;
    private view: RadarRelayStatus = { state: 'unavailable', checkedAt: null };
    private devices = 0;
    private conflict: { revision: string; local: string } | null = null;
    private reviewed: string | null = null;
    private overflow = false;
    private cursor = 0;
    private knownRetiredKey: string | null = null;
    constructor(private readonly deps: RadarRelayDeps) {
        const url = new URL(deps.endpoint);
        if (url.protocol !== 'https:' || canonicalPiAlarmRelayEndpoint(url.origin) !== deps.endpoint)
            throw Error('Fixed radar relay endpoint required');
    }
    private now() {
        return (this.deps.now ?? Date.now)();
    }
    private credentialsKey(): string | null {
        const c = this.deps.credentials(),
            owner = this.deps.ownerId(),
            anon = this.deps.anonKey();
        return c && owner && anon
            ? createHash('sha256')
                  .update(JSON.stringify([owner, c.relayId, c.token, anon]))
                  .digest('hex')
            : null;
    }
    status(): RadarRelayStatus {
        if (!this.deps.internetAllowed()) return { state: 'internet-off', checkedAt: null };
        if (!this.credentialsKey()) return { state: 'not-paired', checkedAt: null };
        if (!this.current() || this.identity !== this.credentialsKey() || this.overflow)
            return { state: 'unavailable', checkedAt: null };
        if (this.conflict)
            return { state: 'conflict', checkedAt: this.view.checkedAt, conflictRevision: this.conflict.revision };
        return this.view.checkedAt !== null &&
            this.now() >= this.view.checkedAt &&
            this.now() - this.view.checkedAt <= 30000
            ? { ...this.view }
            : { state: 'unavailable', checkedAt: null };
    }
    event(event: RadarWatchEvent): void {
        if (event.action === 'retire') {
            this.knownRetiredKey = radarContextKey(event.context);
            if (this.cloud && radarContextKey(this.cloud.context) === radarContextKey(event.context) && this.identity)
                this.owedRetire = { ...this.cloud, identity: this.identity };
            this.generation++;
            this.pass = null;
            this.current = () => false;
            this.latest.clear();
            this.known.clear();
            this.acks.clear();
            this.resolved.clear();
            this.view = { state: 'unavailable', checkedAt: null };
            this.schedule(true);
            return;
        }
        if (event.action === 'bind') return; // A source-evaluated pass is required before any request.
        if (!this.pass || radarContextKey(event.context) !== radarContextKey(this.pass.context)) return;
        if (event.action === 'ack') {
            if (this.acks.size >= MAX_PENDING && !this.acks.has(event.ack.key)) {
                this.overflow = true;
                return;
            }
            this.acks.set(event.ack.key, { ...event.ack });
        } else if (event.action === 'resolved') {
            if (this.known.has(event.resolved.key) || this.inFlight.has(event.resolved.key))
                this.resolved.set(event.resolved.key, { ...event.resolved });
            this.latest.delete(event.resolved.key);
            this.acks.delete(event.resolved.key);
        }
    }
    update(pass: RadarWatchRelayPass, isCurrent: () => boolean, applyAck: typeof this.applyAck): void {
        if (!validRadarContext(pass.context) || pass.upserts.length > 400) return;
        const key = radarContextKey(pass.context),
            old = this.pass && radarContextKey(this.pass.context);
        if (key !== old) {
            this.generation++;
            this.known.clear();
            this.latest.clear();
            this.acks.clear();
            this.resolved.clear();
            this.conflict = null;
            this.reviewed = null;
            this.overflow = false;
            this.view = { state: 'unavailable', checkedAt: null };
        }
        this.pass = structuredClone(pass);
        this.current = isCurrent;
        this.applyAck = applyAck;
        const previous = this.latest;
        this.latest = new Map(pass.upserts.map((u) => [u.key, u]));
        // An explicit ACK arriving during an upsert must follow that in-flight creation.
        for (const key of this.acks.keys())
            if (!this.latest.has(key) && previous.has(key)) this.latest.set(key, previous.get(key)!);
        this.schedule();
    }
    /** Root calls this on its existing one-second loop, including after stand-down. */
    pump(): void {
        this.schedule();
    }
    private schedule(immediate = false): void {
        if (this.pending || (!immediate && this.now() - this.lastAttempt < 5000)) return;
        const generation = this.generation;
        this.pending = this.run()
            .catch(() => {
                this.view = { state: 'unavailable', checkedAt: null };
            })
            .finally(() => {
                this.pending = null;
                if (generation !== this.generation && this.owedRetire) this.schedule(true);
            });
    }
    review(expectedRevision: string, localContext: RadarRelayContext): boolean {
        if (
            !this.current() ||
            !this.conflict ||
            this.conflict.revision !== expectedRevision ||
            this.conflict.local !== radarContextKey(localContext)
        )
            return false;
        this.reviewed = expectedRevision;
        this.conflict = null;
        this.lastAttempt = -Infinity;
        return true;
    }
    async settled(): Promise<void> {
        while (this.pending) await this.pending;
    }
    private async post(body: object, generation: number, cancelOnly = false): Promise<Record<string, unknown> | null> {
        const credentials = this.deps.credentials(),
            identity = this.credentialsKey();
        if (
            !credentials ||
            !identity ||
            !this.deps.internetAllowed() ||
            (!cancelOnly && !this.current()) ||
            generation !== this.generation
        )
            return null;
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
                        apikey: this.deps.anonKey(),
                        Authorization: `Bearer ${this.deps.anonKey()}`,
                        'X-Thalassa-Pi-Relay-Id': credentials.relayId,
                        'X-Thalassa-Pi-Relay-Token': credentials.token,
                    },
                    body: encoded,
                    signal: controller.signal,
                    redirect: 'error',
                    cache: 'no-store',
                });
                if (controller.signal.aborted) {
                    await response.body?.cancel();
                    return null;
                }
                if (response.status === 409) {
                    await response.body?.cancel();
                    return { conflict: true };
                }
                if (!response.ok) {
                    await response.body?.cancel();
                    return null;
                }
                const reader = response.body?.getReader();
                if (!reader) return null;
                const abort = () => {
                    void reader.cancel().catch(() => undefined);
                };
                controller.signal.addEventListener('abort', abort, { once: true });
                const chunks: Uint8Array[] = [];
                let bytes = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        bytes += value.byteLength;
                        if (bytes > 16384) {
                            await reader.cancel();
                            return null;
                        }
                        chunks.push(value);
                    }
                } finally {
                    controller.signal.removeEventListener('abort', abort);
                    reader.releaseLock();
                }
                const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                return radarRecord(result) ? result : null;
            };
            const result = await Promise.race([
                request(),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        resolve(null);
                    }, 8000);
                    timer.unref();
                }),
            ]);
            return generation === this.generation &&
                identity === this.credentialsKey() &&
                this.deps.internetAllowed() &&
                (cancelOnly || this.current())
                ? result
                : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
    private enabled(body: Record<string, unknown> | null): body is Record<string, unknown> {
        return (
            !!body && body.ok === true && radarRecord(body.radar) && body.radar.v === 1 && body.radar.enabled === true
        );
    }
    private async run(): Promise<void> {
        this.lastAttempt = this.now();
        const generation = this.generation,
            pass = this.pass,
            identity = this.credentialsKey();
        if (!identity) return;
        if (identity !== this.identity) {
            this.cloud = null;
            this.devices = 0;
        }
        this.identity = identity;
        this.view = { state: 'unavailable', checkedAt: null };
        if (this.owedRetire) {
            const old = this.owedRetire;
            if (old.identity === identity) {
                const retired = await this.post(
                    { family: 'radar', action: 'retire', context: old.context, contextRevision: old.revision },
                    generation,
                    true,
                );
                if (
                    !retired ||
                    (!retired.conflict &&
                        (!this.enabled(retired) || retired.retired !== true || !uuid(retired.contextRevision)))
                )
                    return;
            }
            if (generation !== this.generation || identity !== this.credentialsKey()) return;
            this.owedRetire = null;
            this.cloud = null;
        }
        if (!pass || !this.current() || this.deps.ownerId() !== pass.context.binding.ownerId) return;
        if (this.conflict) return;
        const key = radarContextKey(pass.context);
        if (!this.cloud || radarContextKey(this.cloud.context) !== key) {
            const probe = await this.post({ family: 'radar', action: 'probe' }, generation);
            if (
                !this.enabled(probe) ||
                !Number.isSafeInteger(probe.devices) ||
                (probe.devices as number) < 0 ||
                (probe.devices as number) > 1000 ||
                !(probe.contextRevision === null || uuid(probe.contextRevision)) ||
                typeof probe.retired !== 'boolean' ||
                !(probe.context === null || validRadarContext(probe.context))
            )
                return;
            this.devices = probe.devices as number;
            const remote = probe.context as RadarRelayContext | null;
            if ((remote && !uuid(probe.contextRevision)) || (!remote && probe.contextRevision !== null)) return;
            const identical = remote && radarContextKey(remote) === key && !probe.retired;
            const known =
                remote &&
                this.cloud &&
                probe.contextRevision === this.cloud.revision &&
                radarContextKey(remote) === radarContextKey(this.cloud.context);
            const knownRetired = !!remote && probe.retired === true && radarContextKey(remote) === this.knownRetiredKey;
            const reviewed =
                remote &&
                remote.binding.ownerId === pass.context.binding.ownerId &&
                remote.binding.piDeviceId === pass.context.binding.piDeviceId &&
                remote.binding.pairingId === pass.context.binding.pairingId &&
                this.reviewed === probe.contextRevision;
            if (remote && !identical && !known && !knownRetired && !reviewed) {
                this.conflict = { revision: probe.contextRevision as string, local: key };
                this.view = { state: 'conflict', checkedAt: this.now() };
                return;
            }
            const bound = await this.post(
                {
                    family: 'radar',
                    action: 'bind',
                    context: pass.context,
                    expectedContextRevision: probe.contextRevision,
                },
                generation,
            );
            if (
                !this.enabled(bound) ||
                !uuid(bound.contextRevision) ||
                bound.queued !== 0 ||
                !Array.isArray(bound.acked) ||
                bound.acked.length ||
                !Array.isArray(bound.acknowledgements) ||
                bound.acknowledgements.length
            )
                return;
            this.cloud = { context: structuredClone(pass.context), revision: bound.contextRevision };
            this.reviewed = null;
        }
        if (generation !== this.generation || !this.current()) return;
        const upserts: RadarRelayUpsert[] = [],
            acks: RadarRelayAck[] = [],
            resolved = [...this.resolved.values()].slice(0, RADAR_RELAY_BATCH);
        let left = RADAR_RELAY_BATCH - resolved.length;
        for (const ack of this.acks.values()) {
            const first = !this.known.has(ack.key),
                upsert = this.latest.get(ack.key);
            if (left < (first ? 2 : 1)) break;
            if (first && (!upsert || this.now() - upsert.sourceAt > 15000)) {
                this.acks.delete(ack.key);
                continue;
            }
            if (first) {
                upserts.push(upsert!);
                left--;
            }
            acks.push(ack);
            left--;
        }
        const options = [...this.latest.values()];
        this.cursor %= Math.max(1, options.length);
        for (const u of [...options.slice(this.cursor), ...options.slice(0, this.cursor)]) {
            if (!left) break;
            if (
                this.resolved.has(u.key) ||
                upserts.some((x) => x.key === u.key) ||
                this.now() < u.sourceAt ||
                this.now() - u.sourceAt > 15000
            )
                continue;
            if (
                !this.known.has(u.key) &&
                this.known.size + upserts.filter((x) => !this.known.has(x.key)).length >= MAX_KNOWN
            ) {
                this.overflow = true;
                continue;
            }
            upserts.push(u);
            left--;
        }
        this.inFlight = new Set(upserts.map((u) => u.key));
        const requested = new Set([...upserts, ...acks].map((u) => u.key));
        const answer = await this.post(
            {
                family: 'radar',
                action: 'sync',
                context: pass.context,
                contextRevision: this.cloud.revision,
                evaluatedAt: this.now(),
                upserts,
                acks,
                resolved,
                more:
                    this.latest.size + this.acks.size + this.resolved.size >
                    upserts.length + acks.length + resolved.length,
            },
            generation,
        );
        this.inFlight.clear();
        if (answer?.conflict === true) {
            this.cloud = null;
            return;
        }
        if (
            !this.enabled(answer) ||
            answer.contextRevision !== this.cloud.revision ||
            !Number.isSafeInteger(answer.queued) ||
            (answer.queued as number) < 0 ||
            (answer.queued as number) > 8 ||
            !Array.isArray(answer.acked) ||
            !Array.isArray(answer.acknowledgements) ||
            answer.acked.length > 8 ||
            answer.acknowledgements.length !== answer.acked.length
        )
            return;
        const remoteAcks: { key: string; ackedAt: number }[] = [],
            seen = new Set<string>();
        for (const a of answer.acknowledgements) {
            if (
                !radarRecord(a) ||
                Object.keys(a).length !== 2 ||
                typeof a.key !== 'string' ||
                !RADAR_RELAY_KEY.test(a.key) ||
                !requested.has(a.key) ||
                seen.has(a.key) ||
                !answer.acked.includes(a.key) ||
                !Number.isSafeInteger(a.ackedAt) ||
                (a.ackedAt as number) < Number(a.key.split(':')[2]) ||
                (a.ackedAt as number) > this.now() + 1000
            )
                return;
            seen.add(a.key);
            remoteAcks.push({ key: a.key, ackedAt: a.ackedAt as number });
        }
        this.cursor = (this.cursor + Math.max(1, upserts.length)) % Math.max(1, options.length);
        for (const u of upserts) this.known.add(u.key);
        for (const a of acks) if (this.acks.get(a.key)?.ackedAt === a.ackedAt) this.acks.delete(a.key);
        for (const r of resolved) {
            this.resolved.delete(r.key);
            this.known.delete(r.key);
            this.latest.delete(r.key);
        }
        this.overflow = this.known.size >= MAX_KNOWN || this.acks.size >= MAX_PENDING;
        await this.applyAck(pass.context, remoteAcks);
        if (generation !== this.generation || identity !== this.credentialsKey() || !this.current()) return;
        this.view = { state: this.devices > 0 ? 'ready' : 'unavailable', checkedAt: this.now() };
    }
}
