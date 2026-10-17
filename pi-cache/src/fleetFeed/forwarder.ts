/** Loss-only forwarding; constructors are inert. No public target/alarm adoption. */
import { randomUUID } from 'node:crypto';
import {
    AIS_FLEET_FORWARDING as LIMIT,
    fleetForwardBatchBytes,
    fleetForwardBindingKey,
    parseFleetForwardBatch,
    validFleetAisSentence,
    type FleetForwardBinding,
    type FleetForwardObservation,
} from '../fleetFeedWire.js';
import { fleetHash, verifyFleetReceipt, type FleetPiContext } from './contract.js';
import type { FleetConsentStore } from './store.js';
import type { PiIdentity } from '../identity.js';
export interface FleetRawInput {
    setContext(key: string | null): void;
    snapshot?(): { configured: boolean; connected: boolean; lastReceivedAt: number | null };
}
export interface FleetForwardDeps {
    store: FleetConsentStore;
    identity: Pick<PiIdentity, 'deviceId' | 'signPayload'>;
    operatorEnabled: boolean;
    readContext(binding: FleetForwardBinding): Promise<FleetPiContext | null>;
    input: FleetRawInput;
    /** Fixed operator HTTPS endpoint only, constructed outside request input. */
    send(
        body: string,
        signature: string,
        relayId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<{ status: number }>;
    now?: () => number;
}
export class FleetForwarder {
    private readonly now: () => number;
    private readonly bootId = randomUUID();
    private sequence = 0;
    private epoch = 0;
    private context: string | null = null;
    private queue: FleetForwardObservation[] = [];
    private pending: AbortController | null = null;
    private busy = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private state = 'off';
    private lastAcknowledgedAt: number | null = null;
    constructor(private readonly deps: FleetForwardDeps) {
        this.now = deps.now ?? Date.now;
    }
    status() {
        return {
            schema: 1,
            state: this.state,
            queued: this.queue.length,
            lastAcknowledgedAt: this.lastAcknowledgedAt,
            deliveryConfirmed: false,
            operatorConfigured: this.deps.operatorEnabled,
            receiver: this.deps.input.snapshot?.() ?? null,
        };
    }
    /** A line is accepted only from the currently admitted read-only raw-input generation. */
    ingest(sentence: string, at: number, sourceContext: string): void {
        if (
            !this.context ||
            sourceContext !== this.context ||
            !validFleetAisSentence(sentence) ||
            !Number.isSafeInteger(at) ||
            at > this.now() ||
            this.now() - at > LIMIT.observationAgeMs
        )
            return;
        this.queue.push({ sentence, receivedAt: at });
        if (this.queue.length > LIMIT.maxSentences) this.queue.splice(0, this.queue.length - LIMIT.maxSentences);
    }
    private hold(state: string): void {
        this.epoch++;
        this.context = null;
        this.queue = [];
        this.pending?.abort();
        this.pending = null;
        this.deps.input.setContext(null);
        this.state = state;
    }
    off(): void {
        this.hold('off');
        this.deps.store.off(this.now());
        this.lastAcknowledgedAt = null;
    }
    changed(): void {
        this.hold('off');
        this.lastAcknowledgedAt = null;
    }
    start(): void {
        if (!this.deps.operatorEnabled || this.timer) return;
        // Short authority checks; network batches are no more than once/minute.
        this.timer = setInterval(() => {
            void this.tick();
        }, 2000);
        this.timer.unref();
        void this.tick();
    }
    close(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.hold('off');
    }
    private lastAttemptAt = 0;
    async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        const epoch = this.epoch;
        try {
            if (!this.deps.operatorEnabled) {
                this.hold('prerequisites-held');
                return;
            }
            const snapshot = this.deps.store.read(this.now()),
                raw = snapshot.receipt;
            if (!raw?.consent.enabled) {
                this.hold('off');
                return;
            }
            const context = await this.deps.readContext(raw.consent.binding);
            if (this.epoch !== epoch || this.deps.store.read(this.now()).generation !== snapshot.generation) return;
            if (!context) {
                this.hold('source-or-pair-unavailable');
                return;
            }
            const receipt = verifyFleetReceipt(raw, context.token, this.now());
            if (
                !receipt ||
                receipt.consent.binding.piDeviceId !== this.deps.identity.deviceId ||
                fleetForwardBindingKey(context.binding) !== fleetForwardBindingKey(receipt.consent.binding)
            ) {
                this.off();
                this.state = 'review-required';
                return;
            }
            if (!context.allowInternet) {
                this.hold('internet-paused');
                return;
            }
            const key = JSON.stringify([snapshot.generation, fleetForwardBindingKey(context.binding)]);
            if (this.context !== key) {
                this.hold('listening');
                this.context = key;
                this.deps.input.setContext(key);
            }
            this.queue = this.queue.filter(
                (row) => row.receivedAt <= this.now() && this.now() - row.receivedAt <= LIMIT.observationAgeMs,
            );
            if (!this.queue.length || this.now() - this.lastAttemptAt < 60_000) {
                this.state = this.deps.input.snapshot?.().connected === false ? 'receiver-unavailable' : 'listening';
                return;
            }
            const now = this.now(),
                observations = this.queue.splice(0),
                sentEpoch = this.epoch;
            if (++this.sequence > 2147483647) {
                this.off();
                this.state = 'review-required';
                return;
            }
            const cell = observations.some((o) => o.sentence.startsWith('!AIVDM')) ? context.cell : null;
            const batch = parseFleetForwardBatch(
                {
                    schema: 1,
                    binding: context.binding,
                    consentRevision: receipt.consent.revision,
                    bootId: this.bootId,
                    sequence: this.sequence,
                    sentAt: now,
                    cell,
                    observations,
                },
                now,
            );
            if (!batch) {
                this.hold('source-unavailable');
                return;
            }
            const body = fleetForwardBatchBytes(batch),
                signature = this.deps.identity.signPayload(fleetHash(body), LIMIT.batchPath, now);
            const controller = new AbortController(),
                deadline = setTimeout(() => controller.abort(), 8000);
            deadline.unref();
            this.pending = controller;
            this.lastAttemptAt = now;
            try {
                const response = await this.deps.send(
                    body,
                    signature,
                    context.binding.relayId,
                    context.token,
                    controller.signal,
                );
                if (
                    controller.signal.aborted ||
                    this.epoch !== sentEpoch ||
                    this.deps.store.read(this.now()).generation !== snapshot.generation
                )
                    return;
                if ([401, 403, 409].includes(response.status)) {
                    this.off();
                    this.state = 'review-required';
                    return;
                }
                if (response.status !== 200) {
                    this.hold('service-unavailable');
                    return;
                }
                this.lastAcknowledgedAt = this.now();
                this.state = 'acknowledged';
            } finally {
                clearTimeout(deadline);
                if (this.pending === controller) this.pending = null;
            }
        } catch {
            this.hold('unavailable');
        } finally {
            this.busy = false;
        }
    }
}
