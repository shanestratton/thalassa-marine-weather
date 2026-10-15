/**
 * The Pi's underway watch uses its own relay family (133-04).
 * Chart facts never cross this boundary: only encounter kind/key and ack age.
 * Capability is proved by an explicit probe; an old AIS-only deployment cannot
 * accidentally resolve AIS encounters or make this watch claim push readiness.
 */
export type PiUnderwayAlarmKind = 'off-route' | 'chart-ahead';
export interface PiUnderwayAlarm {
    key: string;
    kind: PiUnderwayAlarmKind;
    raisedAt: number;
    /** Acknowledged for this encounter, until it clears. */
    ackedAt: number | null;
}
export interface PiUnderwayPass {
    armed: boolean;
    alarms: readonly PiUnderwayAlarm[];
}
export type PiUnderwayPushState = 'ready' | 'unavailable' | 'internet-off' | 'not-paired';
export interface PiUnderwayPushStatus {
    state: PiUnderwayPushState;
    checkedAt: number | null;
    ownerId: string | null;
    /** Version 1 proves both the schema and matching send-push support. */
    underway: { v: 1; enabled: boolean };
}
type FetchLike = (
    url: string,
    init?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
export interface PiUnderwayAlarmRelayDeps {
    fetchImpl: FetchLike;
    /** canonicalPiAlarmRelayEndpoint(process-startup trusted Supabase origin). */
    endpoint: string;
    anonKey: () => string;
    credentials: () => { relayId: string; token: string } | null;
    internetAllowed: () => boolean;
    ownerId?: () => string | null;
    now?: () => number;
    utcOffsetMin?: () => number;
    timeoutMs?: number;
}

export const UNDERWAY_RELAY_SYNC_MS = 15_000;
export const UNDERWAY_RELAY_ACKED_SYNC_MS = 60_000;
export const UNDERWAY_RELAY_MAX_BACKOFF_MS = 5 * 60_000;
export const UNDERWAY_RELAY_PROBE_MS = 60 * 60_000;
export const UNDERWAY_RELAY_REPROBE_MS = 60_000;
export const UNDERWAY_RELAY_READY_MS = 65 * 60_000;
export const UNDERWAY_RELAY_TIMEOUT_MS = 8_000;
export const UNDERWAY_RELAY_RAISE_MAX_AGE_MS = 30_000;
const KEY = /^(off-route|chart-ahead)::[0-9]{10,13}$/;

function alarmCopy(raw: PiUnderwayAlarm): PiUnderwayAlarm | null {
    if (
        !raw ||
        !['off-route', 'chart-ahead'].includes(raw.kind) ||
        !Number.isSafeInteger(raw.raisedAt) ||
        !KEY.test(raw.key) ||
        raw.key !== `${raw.kind}::${raw.raisedAt}`
    )
        return null;
    return {
        key: raw.key,
        kind: raw.kind,
        raisedAt: raw.raisedAt,
        ackedAt: typeof raw.ackedAt === 'number' && Number.isFinite(raw.ackedAt) ? raw.ackedAt : null,
    };
}

/** Explicit allowlist: even an alarm object carrying chart evidence cannot leak it. */
export function wireUnderwayAlarm(alarm: PiUnderwayAlarm, now: number): Record<string, unknown> | null {
    const safe = alarmCopy(alarm);
    if (!safe) return null;
    return {
        key: safe.key,
        kind: safe.kind,
        acked_ms_ago: safe.ackedAt === null ? null : Math.max(0, Math.min(24 * 60 * 60_000, now - safe.ackedAt)),
    };
}

function openAlarms(alarms: readonly PiUnderwayAlarm[]): PiUnderwayAlarm[] {
    const out: PiUnderwayAlarm[] = [];
    for (const raw of alarms) {
        const alarm = alarmCopy(raw);
        if (alarm && !out.some((a) => a.kind === alarm.kind)) out.push(alarm);
        if (out.length === 2) break;
    }
    return out;
}

export class PiUnderwayAlarmRelay {
    private capabilityAt: number | null = null;
    private capabilityIdentity: string | null = null;
    private enabled = false;
    private devices = 0;
    private failures = 0;
    private lastRequestOk = false;
    private lastProbeAt: number | null = null;
    private lastSyncAt: number | null = null;
    private requesting = false;
    private knownKeys = new Set<string>();
    private raiseAttempted = new Map<PiUnderwayAlarmKind, string>();
    /** Also true at restart: a first empty sync closes this family's old events. */
    private relayMayHaveOpen = true;
    private desired: PiUnderwayPass = { armed: false, alarms: [] };
    private signature = '';
    private revision = 0;
    private running: Promise<void> | null = null;
    private applyAck: (key: string) => void = () => undefined;
    private appliedAcks = new Set<string>();

    constructor(private readonly deps: PiUnderwayAlarmRelayDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private blocked(): 'internet-off' | 'not-paired' | null {
        if (!this.deps.internetAllowed()) return 'internet-off';
        if (!this.deps.credentials() || !this.deps.anonKey()) return 'not-paired';
        return null;
    }

    private capable(): boolean {
        const age = this.capabilityAt === null ? Infinity : this.now() - this.capabilityAt;
        return (
            this.enabled && this.capabilityIdentity === this.identity() && age >= 0 && age <= UNDERWAY_RELAY_READY_MS
        );
    }

    private identity(): string | null {
        const credential = this.deps.credentials();
        return credential ? JSON.stringify([credential.relayId, credential.token, this.deps.anonKey()]) : null;
    }

    status(): PiUnderwayPushStatus {
        const blocked = this.blocked();
        const enabled = this.capable();
        return {
            state: blocked ?? (enabled && this.lastRequestOk && this.devices > 0 ? 'ready' : 'unavailable'),
            checkedAt: this.capabilityAt,
            ownerId: blocked === 'not-paired' ? null : (this.deps.ownerId?.() ?? null),
            underway: { v: 1, enabled },
        };
    }

    /** One bounded request at a time. No credential or server error text is logged. */
    private async post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
        if (this.requesting || this.blocked()) return null;
        const credential = this.deps.credentials();
        const anonKey = this.deps.anonKey();
        if (!credential || !anonKey) return null;
        this.requesting = true;
        const controller = new AbortController();
        const rawTimeout = this.deps.timeoutMs ?? UNDERWAY_RELAY_TIMEOUT_MS;
        const timeoutMs = Number.isFinite(rawTimeout)
            ? Math.max(250, Math.min(UNDERWAY_RELAY_TIMEOUT_MS, rawTimeout))
            : UNDERWAY_RELAY_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const offset = this.deps.utcOffsetMin?.();
            const utcOffset = Number.isInteger(offset) && offset! >= -720 && offset! <= 840 ? offset : null;
            const request = async () => {
                const res = await this.deps.fetchImpl(this.deps.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        apikey: anonKey,
                        Authorization: `Bearer ${anonKey}`,
                        'X-Thalassa-Pi-Relay-Id': credential.relayId,
                        'X-Thalassa-Pi-Relay-Token': credential.token,
                    },
                    body: JSON.stringify({ ...body, family: 'underway', utc_offset_min: utcOffset }),
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error('relay unavailable');
                const value = await res.json();
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid answer');
                const answer = value as Record<string, unknown>;
                if (answer.ok !== true) throw new Error('relay refused');
                return answer;
            };
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('relay timeout'));
                }, timeoutMs);
            });
            const answer = await Promise.race([request(), deadline]);
            this.failures = 0;
            this.lastRequestOk = true;
            return answer;
        } catch {
            this.failures = Math.min(10, this.failures + 1);
            this.lastRequestOk = false;
            return null;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            this.requesting = false;
        }
    }

    /** The server proves schema AND matching delivery support in this explicit family probe. */
    async probe(): Promise<PiUnderwayPushState> {
        const blocked = this.blocked();
        if (blocked) return blocked;
        if (this.requesting) return this.status().state;
        this.lastProbeAt = this.now();
        const identity = this.identity();
        const answer = await this.post({ action: 'probe' });
        const capability = answer?.underway as Record<string, unknown> | undefined;
        this.enabled = capability?.v === 1 && capability.enabled === true;
        this.capabilityAt = answer ? this.now() : null;
        this.capabilityIdentity = answer ? identity : null;
        const devices = answer?.devices;
        this.devices = typeof devices === 'number' && Number.isSafeInteger(devices) && devices >= 0 ? devices : 0;
        return this.status().state;
    }

    /** A fresh raise is sent once, never queued/retried; the next sync recovers an open encounter. */
    async raise(alarm: PiUnderwayAlarm): Promise<'sent' | Exclude<PiUnderwayPushState, 'ready'>> {
        const blocked = this.blocked();
        if (blocked) return blocked;
        const safe = alarmCopy(alarm);
        const now = this.now();
        if (
            !safe ||
            safe.ackedAt !== null ||
            this.raiseAttempted.get(safe.kind) === safe.key ||
            !this.capable() ||
            this.requesting ||
            now - safe.raisedAt > UNDERWAY_RELAY_RAISE_MAX_AGE_MS ||
            safe.raisedAt - now > 5_000
        )
            return 'unavailable';
        this.relayMayHaveOpen = true;
        this.raiseAttempted.set(safe.kind, safe.key);
        this.lastSyncAt = now;
        const answer = await this.post({ action: 'raise', alarm: wireUnderwayAlarm(safe, now) });
        if (answer) this.knownKeys.add(safe.key);
        if (this.signature) this.kick();
        return answer ? 'sent' : 'unavailable';
    }

    private waitMs(base: number): number {
        return this.failures === 0 ? base : Math.min(UNDERWAY_RELAY_MAX_BACKOFF_MS, base * 2 ** this.failures);
    }

    private probeDue(): boolean {
        if (this.lastProbeAt === null) return true;
        const base = this.capable() ? UNDERWAY_RELAY_PROBE_MS : UNDERWAY_RELAY_REPROBE_MS;
        return this.now() - this.lastProbeAt >= this.waitMs(base);
    }

    private syncDue(open: readonly PiUnderwayAlarm[]): boolean {
        if (open.length === 0 && !this.relayMayHaveOpen) return false;
        if (this.lastSyncAt === null) return true;
        if (this.failures === 0 && open.some((a) => !this.knownKeys.has(a.key))) return true;
        // A successful in-flight alarm sync must be followed immediately by a
        // stand-down, not 15 s later. Failed closes still obey bounded backoff.
        if (open.length === 0 && this.relayMayHaveOpen && this.failures === 0) return true;
        const base = open.some((a) => a.ackedAt === null) ? UNDERWAY_RELAY_SYNC_MS : UNDERWAY_RELAY_ACKED_SYNC_MS;
        return this.now() - this.lastSyncAt >= this.waitMs(base);
    }

    /** Watch callback, including once at stand-down. Does not block the watch loop. */
    afterPass(description: PiUnderwayPass, applyAck: (key: string) => void): void {
        const alarms = description.armed ? openAlarms(description.alarms) : [];
        this.desired = { armed: description.armed, alarms };
        this.applyAck = applyAck;
        const signature = JSON.stringify(this.desired);
        if (signature !== this.signature) {
            this.signature = signature;
            this.revision++;
        }
        for (const key of this.appliedAcks) if (!alarms.some((a) => a.key === key)) this.appliedAcks.delete(key);
        for (const [kind, key] of this.raiseAttempted)
            if (!alarms.some((a) => a.key === key)) this.raiseAttempted.delete(kind);
        this.kick();
    }

    private kick(): void {
        if (!this.running) this.running = this.run().finally(() => (this.running = null));
    }

    /** Focused tests and orderly shutdown can await the bounded work already in flight. */
    async whenIdle(): Promise<void> {
        await this.running;
    }

    private async run(): Promise<void> {
        let revision: number;
        do {
            revision = this.revision;
            if (this.blocked()) return;
            if (!this.desired.armed && !this.relayMayHaveOpen) return;
            if (this.probeDue()) await this.probe();
            if (revision !== this.revision) continue;
            if (!this.capable() || this.requesting) return;
            const open = this.desired.alarms.map((a) => ({ ...a }));
            if (!this.syncDue(open)) return;
            this.lastSyncAt = this.now();
            const answer = await this.post({
                action: 'sync',
                alarms: open.map((a) => wireUnderwayAlarm(a, this.now())),
            });
            if (answer) {
                this.relayMayHaveOpen = open.length > 0;
                this.knownKeys = new Set(open.map((a) => a.key));
                for (const key of Array.isArray(answer.acked) ? answer.acked : []) {
                    if (typeof key !== 'string' || this.appliedAcks.has(key)) continue;
                    // A response about an old route/encounter cannot acknowledge
                    // a replacement, and stand-down cannot call back into it.
                    const current = this.desired.armed && this.desired.alarms.find((a) => a.key === key);
                    if (!current || current.ackedAt !== null || !open.some((a) => a.key === key && a.ackedAt === null))
                        continue;
                    try {
                        this.applyAck(key);
                        this.appliedAcks.add(key);
                    } catch {
                        // A failing callback does not stop the watch or count as acknowledged.
                    }
                }
            }
        } while (revision !== this.revision);
    }
}
