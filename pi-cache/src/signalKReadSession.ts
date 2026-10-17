import { randomUUID } from 'node:crypto';
import { createSignalKClient, type SignalKClient } from './signalKClient.js';
import { startSignalKReadStream } from './signalKReadStream.js';
import {
    signalkRecord,
    validSignalKSelf,
    type SignalKNotice,
    type SignalKNotificationSnapshot,
    type SignalKReadSessionState,
} from './signalkProtocol.js';
export type { SignalKNotificationSnapshot, SignalKReadSessionState } from './signalkProtocol.js';
import type { SignalkDocuments } from './lanTelemetry.js';

const SELF_REFRESH_MS = 30_000;
const CYCLE_MS = 5_000;
const MAX_NOTIFICATION_BODY = 16_384;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
type StreamOptions = Parameters<typeof startSignalKReadStream>[0];
interface Timer {
    cancel(): void;
}
export interface SignalKReadSessionOptions {
    origin: string;
    accessToken?: string;
    allowInsecureLan?: boolean;
    /** Test seams. The operator supplies configuration; an HTTP caller cannot supply these. */
    client?: Pick<SignalKClient, 'getSelf' | 'getVessels'>;
    stream?: (options: StreamOptions) => { stop(): void };
    now?: () => number;
    schedule?: (callback: () => void, ms: number) => Timer;
}

/** Overlay only the protocol's bounded, validated leaf envelopes, retaining original clocks.
 * The full bounded REST document remains available to existing GNSS/Systems/AIS readers.
 * A delayed REST refresh cannot resurrect a value cleared by a newer delta. */
function overlay(base: Record<string, unknown>, delta: Record<string, unknown>): Record<string, unknown> {
    const out = structuredClone(base);
    function visit(node: Record<string, unknown>, parts: string[]): void {
        for (const [key, value] of Object.entries(node)) {
            if (BAD_KEYS.has(key) || key === 'uuid') continue;
            const record = signalkRecord(value);
            if (!record) continue;
            const path = [...parts, key];
            if (Object.hasOwn(record, 'value') && typeof record.timestamp === 'string') {
                let target = out;
                for (const part of path.slice(0, -1)) {
                    if (!Object.hasOwn(target, part) || !signalkRecord(target[part])) target[part] = {};
                    target = target[part] as Record<string, unknown>;
                }
                const previous = signalkRecord(target[key]);
                const oldAt = typeof previous?.timestamp === 'string' ? Date.parse(previous.timestamp) : NaN;
                const at = Date.parse(record.timestamp);
                if (Number.isFinite(at) && (!Number.isFinite(oldAt) || at >= oldAt))
                    target[key] = structuredClone(record);
            } else visit(record, path);
        }
    }
    visit(delta, []);
    return out;
}

/** One operator-configured source, consumed by all Pi readers. No caller-triggered network requests. */
export class SignalKReadSession {
    private readonly client: Pick<SignalKClient, 'getSelf' | 'getVessels'>;
    private readonly now: () => number;
    private running = false;
    private epoch = 0;
    private lifecycle = 0;
    private timer?: Timer;
    private request?: AbortController;
    private socket?: { stop(): void };
    private state: SignalKReadSessionState = 'stopped';
    private self: string | null = null;
    private selfDoc: Record<string, unknown> | null = null;
    private streamDoc: Record<string, unknown> | null = null;
    private vesselsDoc: Record<string, unknown> | null = null;
    private notices: SignalKNotice[] = [];
    private session: string | null = null;
    private startedAt: number | null = null;
    private selfReadAt = 0;
    private nextRetryAt = 0;
    private retryMs = 2_000;

    constructor(private readonly options: SignalKReadSessionOptions) {
        // Validate origin/token even when a test provides its HTTP implementation.
        const client = createSignalKClient(options);
        this.client = options.client ?? client;
        this.now = options.now ?? Date.now;
    }
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.state = 'connecting';
        const lifecycle = ++this.lifecycle;
        await this.cycle(lifecycle).catch(() => this.failed(lifecycle));
    }
    stop(): void {
        this.running = false;
        this.lifecycle++;
        this.timer?.cancel();
        this.timer = undefined;
        this.retire('stopped');
        this.nextRetryAt = 0;
        this.retryMs = 2_000;
    }
    private retire(state: SignalKReadSessionState): void {
        this.epoch++;
        this.request?.abort();
        this.request = undefined;
        const socket = this.socket;
        this.socket = undefined;
        this.self = null;
        this.selfDoc = this.streamDoc = this.vesselsDoc = null;
        this.notices = [];
        this.session = null;
        this.startedAt = null;
        this.state = state;
        socket?.stop();
    }
    private schedule(lifecycle: number): void {
        if (!this.running || lifecycle !== this.lifecycle || this.timer) return;
        const callback = () => {
            this.timer = undefined;
            void this.cycle(lifecycle).catch(() => this.failed(lifecycle));
        };
        this.timer = this.options.schedule
            ? this.options.schedule(callback, CYCLE_MS)
            : (() => {
                  const timer = setTimeout(callback, CYCLE_MS);
                  timer.unref();
                  return { cancel: () => clearTimeout(timer) };
              })();
    }
    private failed(lifecycle: number): void {
        if (!this.running || lifecycle !== this.lifecycle) return;
        this.retire('unavailable');
        this.nextRetryAt = this.now() + this.retryMs;
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        this.schedule(lifecycle);
    }
    private async cycle(lifecycle: number): Promise<void> {
        if (!this.running || lifecycle !== this.lifecycle) return;
        const epoch = this.epoch;
        const now = this.now();
        // A backwards wall clock cannot bypass reconnect pacing or keep a future refresh timestamp.
        if (this.selfReadAt > now) this.selfReadAt = 0;
        if (this.nextRetryAt - now > 30_000) this.nextRetryAt = now + 30_000;
        if (!this.self && now < this.nextRetryAt) return this.schedule(lifecycle);
        const controller = new AbortController();
        this.request = controller;
        const refreshSelf = !this.self || now - this.selfReadAt >= SELF_REFRESH_MS;
        const [own, vessels] = await Promise.allSettled([
            refreshSelf ? this.client.getSelf({ signal: controller.signal }) : Promise.resolve(null),
            this.client.getVessels({ signal: controller.signal }),
        ]);
        if (!this.running || lifecycle !== this.lifecycle || this.epoch !== epoch) return this.schedule(lifecycle);
        this.request = undefined;
        const ownBody = own.status === 'fulfilled' && own.value?.status === 200 ? signalkRecord(own.value.body) : null;
        if (refreshSelf && ownBody) {
            const uuid = ownBody.uuid;
            if (!validSignalKSelf(uuid) || (this.self !== null && uuid !== this.self)) {
                this.retire('unavailable');
                this.nextRetryAt = now + this.retryMs;
                this.retryMs = Math.min(30_000, this.retryMs * 2);
                return this.schedule(lifecycle);
            }
            this.selfReadAt = now;
            this.selfDoc = this.streamDoc ? overlay(ownBody, this.streamDoc) : structuredClone(ownBody);
            if (!this.self) {
                this.self = uuid;
                this.session = randomUUID();
                this.startedAt = this.now();
                this.state = 'connecting';
                const streamEpoch = this.epoch;
                try {
                    const socket = (this.options.stream ?? startSignalKReadStream)({
                        ...this.options,
                        selfUrn: uuid,
                        onDocument: (doc) => {
                            if (!this.running || streamEpoch !== this.epoch || doc.uuid !== this.self) return;
                            this.streamDoc = doc;
                            if (this.selfDoc) this.selfDoc = overlay(this.selfDoc, doc);
                        },
                        onNotifications: (active) => {
                            if (this.running && streamEpoch === this.epoch) this.notices = active;
                        },
                        onState: (state) => {
                            if (!this.running || streamEpoch !== this.epoch) return;
                            if (state === 'disconnected' || state === 'stopped') {
                                this.retire('unavailable');
                                this.nextRetryAt = this.now() + this.retryMs;
                                this.retryMs = Math.min(30_000, this.retryMs * 2);
                            } else {
                                this.state = state;
                                if (state === 'reading') this.retryMs = 2_000;
                            }
                        },
                    });
                    if (this.epoch !== streamEpoch || !this.running) socket.stop();
                    else this.socket = socket;
                } catch {
                    this.retire('unavailable');
                    this.nextRetryAt = this.now() + this.retryMs;
                    this.retryMs = Math.min(30_000, this.retryMs * 2);
                }
            }
        } else if (!this.self) {
            this.state = 'unavailable';
            this.nextRetryAt = now + this.retryMs;
            this.retryMs = Math.min(30_000, this.retryMs * 2);
        }
        if (this.epoch === epoch)
            this.vesselsDoc =
                vessels.status === 'fulfilled' && vessels.value.status === 200
                    ? signalkRecord(vessels.value.body)
                    : null;
        this.schedule(lifecycle);
    }
    async readDocuments(): Promise<SignalkDocuments> {
        const reading = this.running && this.state === 'reading';
        return {
            selfDoc: reading && this.selfDoc ? structuredClone(this.selfDoc) : null,
            vesselsDoc: reading && this.vesselsDoc ? structuredClone(this.vesselsDoc) : null,
            selfAnswer: reading && this.self ? `vessels.${this.self}` : null,
            readAt: this.now(),
        };
    }
    notificationSnapshot(): SignalKNotificationSnapshot {
        const now = this.now();
        const result: SignalKNotificationSnapshot = {
            schema: 1,
            session: this.session,
            startedAt: this.startedAt,
            state: this.state,
            servedAt: now,
            notices: [],
            truncated: false,
        };
        const active =
            this.state === 'reading' ? this.notices.filter((n) => now >= n.at && now - n.at <= 72 * 3600_000) : [];
        for (const notice of active) {
            result.notices.push({ ...notice });
            if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_NOTIFICATION_BODY - 32) {
                result.notices.pop();
                result.truncated = true;
                break;
            }
        }
        return result;
    }
}
