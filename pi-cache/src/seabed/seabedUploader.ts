/**
 * Seabed mapping: the Pi sends its closed batches to the seabed-relay Edge
 * Function, and pulls the owner's settings back.
 *
 * Built like the TelemetryPublisher: the pairing credential the diary relay
 * already holds (never a service-role key), the endpoint from the
 * process-startup Supabase origin (never from a request), the skipper's
 * internet policy respected (satellite = nothing goes), and one log line per
 * change of outcome, never per cycle.
 *
 * Every 10 minutes: pull the config, then send the oldest due batches, six at
 * most. Failures back off from 10 minutes to 6 hours. A 404 means the
 * function is not deployed yet: wait 12 hours and say so once, so the Pi
 * stays quiet until Shane pushes it.
 *
 * Only batches logged for the account the Pi is paired to NOW are sent
 * (ownerId binds the log to the pairing first). 409 not-logger means another
 * device logs this boat now: the batch waits six hours, like the other
 * deferrals.
 */
import type { SeabedStore } from './seabedStore.js';

export const SEABED_RELAY_PATH = '/functions/v1/seabed-relay';
export const UPLOAD_INTERVAL_MS = 10 * 60_000;
export const MAX_BACKOFF_MS = 6 * 3_600_000;
export const NOT_DEPLOYED_WAIT_MS = 12 * 3_600_000;
export const DEFER_MS = 6 * 3_600_000;
const BATCHES_PER_CYCLE = 6;
const REQUEST_TIMEOUT_MS = 30_000;

type FetchLike = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type SeabedUploadOutcome =
    | 'sent'
    | 'idle'
    | 'internet-off'
    | 'not-paired'
    | 'no-anon-key'
    | 'waiting'
    | 'not-deployed'
    | 'unauthorised'
    | 'unreachable'
    | 'rejected'
    | 'not-enabled'
    | 'no-platform'
    | 'no-active-vessel'
    | 'consent-outdated'
    | 'not-logger';

export interface SeabedUploaderDeps {
    fetchImpl: FetchLike;
    endpoint: string;
    anonKey: () => string;
    credentials: () => { relayId: string; token: string } | null;
    internetAllowed: () => boolean;
    store: SeabedStore;
    /** The function's `config` answer, for the caller to apply (or ignore when the LAN is newer). */
    onConfig: (config: Record<string, unknown>) => void;
    /** Consent withdrawn in the cloud: stop capturing (the queue is already purged). */
    onWithdrawn?: () => void;
    /** The account the Pi is paired to, after binding the log to it. */
    ownerId: () => string | null;
    now?: () => number;
    log?: (line: string) => void;
}

export interface SeabedUploaderStatus {
    running: boolean;
    lastOutcome: SeabedUploadOutcome | null;
    lastUploadAt: number | null;
    nextAttemptAt: number;
}

interface Reply {
    status: number;
    body: Record<string, unknown>;
}

export class SeabedUploader {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inFlight = false;
    private failures = 0;
    private pausedUntil = 0;
    private lastOutcome: SeabedUploadOutcome | null = null;
    private lastUploadAt: number | null = null;

    constructor(private readonly deps: SeabedUploaderDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        // A minute after boot, not at once: let Signal K and the network settle.
        this.schedule(60_000);
    }

    stop(): void {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    status(): SeabedUploaderStatus {
        return {
            running: this.running,
            lastOutcome: this.lastOutcome,
            lastUploadAt: this.lastUploadAt,
            nextAttemptAt: this.pausedUntil,
        };
    }

    /** Wake now (a LAN config push): the next cycle runs at once, unless a pause is in force. */
    nudge(): void {
        if (!this.running || this.inFlight) return;
        if (this.timer) clearTimeout(this.timer);
        this.schedule(0);
    }

    private schedule(delayMs: number): void {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            void this.cycle().finally(() => this.schedule(this.nextDelayMs()));
        }, delayMs);
        this.timer.unref?.();
    }

    private nextDelayMs(): number {
        if (this.failures === 0) return UPLOAD_INTERVAL_MS;
        return Math.min(MAX_BACKOFF_MS, UPLOAD_INTERVAL_MS * 2 ** this.failures);
    }

    private async post(body: Record<string, unknown>): Promise<Reply | null> {
        const credential = this.deps.credentials();
        if (!credential) return null;
        const anonKey = this.deps.anonKey();
        try {
            const res = await this.deps.fetchImpl(this.deps.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: anonKey,
                    Authorization: `Bearer ${anonKey}`,
                    'X-Thalassa-Pi-Relay-Id': credential.relayId,
                    'X-Thalassa-Pi-Relay-Token': credential.token,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            let parsed: unknown = null;
            try {
                parsed = await res.json();
            } catch {
                parsed = null;
            }
            const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
            return { status: res.status, body: record };
        } catch {
            return null;
        }
    }

    /** One cycle. Never throws; the outcome says what happened. Public for the tests. */
    async cycle(): Promise<SeabedUploadOutcome> {
        if (this.inFlight) return this.lastOutcome ?? 'idle';
        this.inFlight = true;
        try {
            return this.finish(await this.attempt());
        } catch {
            return this.finish('unreachable');
        } finally {
            this.inFlight = false;
        }
    }

    private finish(outcome: SeabedUploadOutcome): SeabedUploadOutcome {
        if (outcome !== this.lastOutcome) {
            const note = outcome === 'not-deployed' ? ' (seabed-relay is not deployed yet; next try in 12 h)' : '';
            (this.deps.log ?? console.log)(`[seabed] uploader: ${outcome}${note}`);
        }
        this.lastOutcome = outcome;
        if (outcome === 'unreachable' || outcome === 'unauthorised' || outcome === 'rejected') this.failures += 1;
        else if (outcome !== 'waiting') this.failures = 0;
        return outcome;
    }

    private failureFor(reply: Reply | null): SeabedUploadOutcome | null {
        if (reply === null) return 'unreachable';
        if (reply.status === 404) {
            this.pausedUntil = this.now() + NOT_DEPLOYED_WAIT_MS;
            return 'not-deployed';
        }
        if (reply.status === 401 || reply.status === 403) return 'unauthorised';
        return null;
    }

    private async attempt(): Promise<SeabedUploadOutcome> {
        if (!this.deps.internetAllowed()) return 'internet-off';
        if (!this.deps.credentials()) return 'not-paired';
        if (!this.deps.anonKey()) return 'no-anon-key';
        const now = this.now();
        if (now < this.pausedUntil) return 'waiting';

        const config = await this.post({ action: 'config' });
        const configFailure = this.failureFor(config);
        if (configFailure) return configFailure;
        const reply = config as Reply;
        if (reply.status === 409 && reply.body.code === 'no-active-vessel') {
            this.pausedUntil = now + DEFER_MS;
            return 'no-active-vessel';
        }
        if (reply.status < 200 || reply.status >= 300) return 'rejected';
        this.deps.onConfig(reply.body);

        let sent = 0;
        for (const batch of this.deps.store.dueBatches(now, BATCHES_PER_CYCLE, this.deps.ownerId())) {
            const res = await this.post({
                action: 'batch',
                device: 'pi',
                encoding: 'gzip',
                csv_b64: batch.gz.toString('base64'),
                sha256: batch.sha256,
                meta: batch.meta,
                counters: batch.counters,
            });
            const failure = this.failureFor(res);
            if (failure) return failure;
            const r = res as Reply;
            if (r.status >= 200 && r.status < 300) {
                this.deps.store.markUploaded(batch.id, this.now());
                this.lastUploadAt = this.now();
                sent += 1;
                continue;
            }
            const code = typeof r.body.code === 'string' ? r.body.code : '';
            if (r.status === 409 && code === 'not-enabled') {
                const purged = this.deps.store.purgeAll();
                (this.deps.log ?? console.log)(`[seabed] switched off in the cloud: ${purged} queued batch(es) purged`);
                this.deps.onWithdrawn?.();
                return 'not-enabled';
            }
            if (
                r.status === 409 &&
                ['no-platform', 'no-active-vessel', 'consent-outdated', 'not-logger'].includes(code)
            ) {
                this.deps.store.deferBatch(batch.id, now + DEFER_MS, code);
                return code as SeabedUploadOutcome;
            }
            if (r.status === 413 || r.status === 422) {
                const why = typeof r.body.error === 'string' ? r.body.error : `HTTP ${r.status}`;
                this.deps.store.markRejected(batch.id, why, this.now());
                continue;
            }
            return 'rejected';
        }
        this.deps.store.prune(this.now());
        return sent > 0 ? 'sent' : 'idle';
    }
}
