/**
 * DiaryRelayOutbox — durable, Pi-local relay for diary entries.
 *
 * A phone can hand a diary entry to the boat Pi while it has a reliable
 * boat-LAN connection but no internet.  The Pi writes it to SQLite before
 * acknowledging the request, then delivers it to the Supabase diary-relay
 * Edge Function when the Pi's explicit local policy permits ordinary
 * internet use.
 *
 * The Pi never holds a Supabase service-role key.  It stores only the
 * scoped per-Pi relay credential supplied by the signed-in app.  Credentials
 * stay inside this module's private SQLite store and are intentionally never
 * included in status responses or log messages.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normaliseExactHttpOrigin, normaliseOutboundHttpUrl, outboundFetch } from './outboundHttp.js';

// The Edge Function accepts at most 160 KiB JSON. Leave ample room for the
// `{ entry }` envelope and UTF-8 representation so a Pi never retains a
// payload it cannot safely deliver upstream.
const MAX_ENTRY_BYTES = 128 * 1024;
const MAX_OPERATION_ID_LENGTH = 128;
// Keep the Pi's validator aligned with the Edge Function. A response outside
// this range cannot be a canonical diary-relay acknowledgement.
const MAX_CLIENT_REVISION = 999_999_999;
const RETRY_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const MAX_ERROR_LENGTH = 1_000;
const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER_BINDING_MISSING = 'Diary relay owner binding is missing';
const OWNER_BINDING_MISMATCH = 'Diary relay owner does not match the configured Pi';
const RELAY_AUTHORITY_MISMATCH = 'Diary relay authority does not match the Pi trust anchor';
const DIARY_RELAY_PATH = '/functions/v1/diary-relay';
const ANCHOR_RELAY_PATH = '/functions/v1/anchor-relay';

export type DiaryRelayStatus = 'queued' | 'synced' | 'needs_repair';

export interface DiaryRelayConfigInput {
    url?: string;
    relayId?: string;
    token?: string;
    ownerId?: string;
    /** Pi-local network policy. This is accepted only through /api/configure. */
    allowInternet?: boolean;
}

/**
 * Diary payloads are intentionally stored as complete opaque snapshots so a
 * Pi restart cannot lose fields introduced by newer app builds. `boat_id` is
 * documented here because it binds a note to the vessel selected at capture;
 * older envelopes without it remain valid.
 */
export type DiaryRelayEntry = Record<string, unknown> & {
    boat_id?: string | null;
};

export interface DiaryRelayEnvelope {
    entry: DiaryRelayEntry;
    /** Optional per-entry relay snapshot. A configured Pi relay takes precedence on retry. */
    relay?: Omit<DiaryRelayConfigInput, 'allowInternet'>;
    /**
     * Retained for wire compatibility with older phones. The Pi-wide persisted
     * policy is now the sole WAN gate, so a temporary satellite state cannot
     * permanently strand an otherwise valid diary entry in the Pi outbox.
     */
    allowInternet?: boolean;
}

export interface DiaryRelayPublicConfiguration {
    configured: boolean;
    allowInternet: boolean;
    /** Stable Pi identity used by a signed-in device to pair relay credentials. */
    relayId: string | null;
    ownerId: string | null;
}

export interface DiaryRelayPublicRecord {
    /**
     * Boat-LAN-safe status metadata only. Diary text, media, relay URLs,
     * bearer credentials, and canonical server rows are intentionally absent.
     */
    kind: 'entry' | 'cancellation';
    operationId: string;
    status: DiaryRelayStatus;
    clientRevision: number;
    allowInternet: boolean;
    attemptCount: number;
    queuedAt: number;
    syncedAt?: number;
    lastAttemptAt?: number;
    lastError?: string;
}

export interface DiaryRelayStats {
    queued: number;
    synced: number;
    needsRepair: number;
    cancellationsQueued: number;
    cancellationsSynced: number;
    relay: DiaryRelayPublicConfiguration;
}

interface RelayCredentials {
    url: string;
    relayId: string;
    token: string;
    ownerId: string;
}

interface StoredRelayConfiguration {
    url: string | null;
    relayId: string | null;
    token: string | null;
    ownerId: string | null;
    allowInternet: boolean;
}

interface StoredOutboxRow {
    operation_id: string;
    entry_json: string;
    entry_hash: string;
    client_revision: number;
    relay_url: string | null;
    relay_id: string | null;
    relay_token: string | null;
    /** Immutable account binding for this operation; never refreshed across owners. */
    relay_owner_id: string | null;
    allow_internet: number;
    status: 'queued' | 'synced';
    needs_repair: number;
    attempt_count: number;
    next_attempt_at: number;
    last_attempt_at: number | null;
    last_error: string | null;
    server_entry_json: string | null;
    created_at: number;
    updated_at: number;
    synced_at: number | null;
}

/**
 * A tombstone is deliberately kept separately from the entry outbox. Deleting
 * a queued entry alone is not enough: after a Pi reboot we still need a
 * durable instruction to delete the remote copy before any later writes run.
 */
interface StoredCancellationRow {
    operation_id: string;
    relay_url: string | null;
    relay_id: string | null;
    relay_token: string | null;
    /** Immutable account binding inherited from the cancelled operation. */
    relay_owner_id: string | null;
    status: 'queued' | 'synced';
    needs_repair: number;
    attempt_count: number;
    next_attempt_at: number;
    last_attempt_at: number | null;
    last_error: string | null;
    created_at: number;
    updated_at: number;
    synced_at: number | null;
}

interface OwnerBoundRelayResolution {
    relay: RelayCredentials | null;
    /** Present only when forwarding must be quarantined rather than retried. */
    error?: DiaryRelayPermanentError;
}

export class DiaryRelayOperationConflictError extends Error {
    constructor(operationId: string) {
        super(`Diary operation "${operationId}" was already queued with different content`);
        this.name = 'DiaryRelayOperationConflictError';
    }
}

/** A tombstoned operation may never be re-enqueued by a stale device retry. */
export class DiaryRelayOperationCancelledError extends Error {
    constructor(operationId: string) {
        super(`Diary operation "${operationId}" has been cancelled`);
        this.name = 'DiaryRelayOperationCancelledError';
    }
}

export class DiaryRelayValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DiaryRelayValidationError';
    }
}

interface DiaryRelayFetchResponse {
    readonly ok: boolean;
    readonly status: number;
    text(): Promise<string>;
}

type DiaryRelayFetch = (url: string, init: RequestInit) => Promise<DiaryRelayFetchResponse>;

/**
 * An upstream response that will not improve with network retries. Its public
 * message is deliberately metadata-only: no Edge response body or diary text
 * is copied into the Boat-LAN status surface.
 */
class DiaryRelayPermanentError extends Error {
    constructor(
        readonly safeMessage: string,
        readonly remoteCancellation = false,
    ) {
        super(safeMessage);
        this.name = 'DiaryRelayPermanentError';
    }
}

export interface DiaryRelayOutboxOptions {
    /** Exact process-startup Supabase trust anchor; never sourced from an HTTP request. */
    trustedSupabaseOrigin: string;
    /** Tests can inject a deterministic clock. */
    now?: () => number;
    /** Tests can inject a fetch implementation without touching global fetch. */
    fetchImpl?: DiaryRelayFetch;
    retryIntervalMs?: number;
    requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(json: string | null): Record<string, unknown> | undefined {
    if (!json) return undefined;
    try {
        const parsed: unknown = JSON.parse(json);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** Deterministic JSON fingerprint so a reused operation id cannot overwrite a different entry. */
function stableJson(value: unknown): string {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'string':
            return JSON.stringify(value);
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (!Number.isFinite(value))
                throw new DiaryRelayValidationError('Diary entry contains a non-finite number');
            return JSON.stringify(value);
        case 'object': {
            if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
            if (!isRecord(value)) throw new DiaryRelayValidationError('Diary entry contains an unsupported value');
            return `{${Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
                .join(',')}}`;
        }
        default:
            throw new DiaryRelayValidationError('Diary entry contains an unsupported value');
    }
}

function entryDetails(entry: unknown): {
    entry: DiaryRelayEntry;
    operationId: string;
    clientRevision: number;
    raw: string;
    hash: string;
} {
    if (!isRecord(entry)) throw new DiaryRelayValidationError('entry must be an object');
    const operationId = validateOperationId(entry.client_operation_id);
    const suppliedRevision = entry.client_revision;
    if (
        suppliedRevision !== undefined &&
        (typeof suppliedRevision !== 'number' ||
            !Number.isSafeInteger(suppliedRevision) ||
            suppliedRevision < 1 ||
            suppliedRevision > MAX_CLIENT_REVISION)
    ) {
        throw new DiaryRelayValidationError('entry.client_revision is invalid');
    }
    const clientRevision = suppliedRevision ?? 1;

    let raw: string | undefined;
    try {
        raw = JSON.stringify(entry);
    } catch {
        throw new DiaryRelayValidationError('Diary entry must be JSON-serializable');
    }
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_ENTRY_BYTES) {
        throw new DiaryRelayValidationError('Diary entry is too large for the Pi relay');
    }
    const hash = createHash('sha256').update(stableJson(entry)).digest('hex');
    return { entry, operationId, clientRevision, raw, hash };
}

function validateOperationId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new DiaryRelayValidationError('client_operation_id is required');
    }
    if (value.length > MAX_OPERATION_ID_LENGTH || !OPERATION_ID_RE.test(value)) {
        throw new DiaryRelayValidationError('client_operation_id is invalid');
    }
    return value;
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

function validText(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength || hasControlCharacter(value)) {
        throw new DiaryRelayValidationError(`relay.${field} is invalid`);
    }
    return value.trim();
}

function newPiRelayId(): string {
    // Match the Edge Function's strict relay-id grammar. Keeping this stable
    // in SQLite lets a device pair the same Pi after any restart.
    return `pi_${randomUUID().replace(/-/g, '')}`;
}

/** Derive the only relay endpoint this process may persist or contact. */
export function canonicalDiaryRelayEndpoint(trustedSupabaseOrigin: string): string {
    const origin = normaliseExactHttpOrigin(trustedSupabaseOrigin);
    return new URL(DIARY_RELAY_PATH, `${origin}/`).href;
}

/** The anchor watch's endpoint, from the same trust anchor and nothing else. */
export function canonicalAnchorRelayEndpoint(trustedSupabaseOrigin: string): string {
    const origin = normaliseExactHttpOrigin(trustedSupabaseOrigin);
    return new URL(ANCHOR_RELAY_PATH, `${origin}/`).href;
}

function validateRelay(input: unknown, trustedRelayEndpoint: string): RelayCredentials {
    if (!isRecord(input)) throw new DiaryRelayValidationError('relay must be an object');
    const url = validText(input.url, 'url', 2_048);
    const relayId = validText(input.relayId, 'relayId', 256);
    const token = validText(input.token, 'token', 8_192);
    const ownerId = validText(input.ownerId, 'ownerId', 256);
    if (!RELAY_ID_RE.test(relayId)) {
        throw new DiaryRelayValidationError('relay.relayId is invalid');
    }

    let parsed: URL;
    try {
        parsed = normaliseOutboundHttpUrl(url);
    } catch {
        throw new DiaryRelayValidationError('relay.url is invalid');
    }
    // The authority and complete path come from process startup. A Boat-LAN
    // request can provide credentials only for that one canonical endpoint;
    // it cannot redirect private diary data or relay tokens to another host.
    if (parsed.href !== trustedRelayEndpoint) {
        throw new DiaryRelayValidationError('relay.url must exactly match the trusted diary-relay endpoint');
    }
    return { url: trustedRelayEndpoint, relayId, token, ownerId };
}

function relayFromParts(
    trustedRelayEndpoint: string,
    url: string | null | undefined,
    relayId: string | null | undefined,
    token: string | null | undefined,
    ownerId: string | null | undefined,
): RelayCredentials | null {
    if (!url || !relayId || !token || !ownerId) return null;
    try {
        return validateRelay({ url, relayId, token, ownerId }, trustedRelayEndpoint);
    } catch {
        return null;
    }
}

function hasImmutableOwnerBinding(relay: RelayCredentials | null, ownerId: string | null): boolean {
    return Boolean(ownerId && relay && relay.ownerId === ownerId);
}

function retryDelayMs(attemptCount: number): number {
    // 5s, 10s, 20s … capped at 15 minutes. The edge function is idempotent,
    // so retrying after a lost response is safe.
    const exponent = Math.max(0, Math.min(attemptCount - 1, 20));
    return Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** exponent);
}

function errorMessage(error: unknown, secrets: ReadonlyArray<string | null | undefined> = []): string {
    // Public status must never become a covert diary-content echo. Only our
    // deliberately generated protocol messages are retained; arbitrary fetch
    // errors (which can include request context) collapse to a safe label.
    let message = error instanceof DiaryRelayPermanentError ? error.safeMessage : 'Diary relay transport failed';
    for (const secret of secrets) {
        if (secret) message = message.split(secret).join('[redacted]');
    }
    return message.slice(0, MAX_ERROR_LENGTH);
}

function isPermanentRelayStatus(status: number): boolean {
    // 400/422/413 are malformed or oversized content; 401/403 are relay
    // credentials/ownership; a non-cancellation 409 is a revision conflict.
    // None improve by retrying the same durable payload.
    return status === 400 || status === 401 || status === 403 || status === 409 || status === 413 || status === 422;
}

/**
 * Persistent SQLite-backed diary relay outbox.
 *
 * The constructor intentionally creates a private directory under CACHE_DIR
 * with owner-only permissions. This protects the relay credential from other
 * users on the Pi; normal Boat-LAN clients only ever see the HTTP status view.
 */
export class DiaryRelayOutbox {
    private readonly db: Database.Database;
    private readonly trustedRelayEndpoint: string;
    private readonly now: () => number;
    private readonly fetchImpl: DiaryRelayFetch;
    private readonly requestTimeoutMs: number;
    /** Entry and cancellation requests must be able to run for the same id. */
    private readonly inFlight = new Set<string>();
    private readonly cancellationInFlight = new Set<string>();
    /** Lets a durable cancellation abort an entry request that is still on the wire. */
    private readonly entryAbortControllers = new Map<string, AbortController>();
    private retryTimer: NodeJS.Timeout | null = null;
    private closed = false;

    constructor(cacheDir: string, options: DiaryRelayOutboxOptions) {
        this.trustedRelayEndpoint = canonicalDiaryRelayEndpoint(options.trustedSupabaseOrigin);
        this.now = options.now ?? Date.now;
        const outboxDir = path.join(cacheDir, 'diary-relay');
        fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(outboxDir, 0o700);
        } catch {
            // Best effort only. Some mounted boat volumes do not support POSIX modes.
        }

        this.db = new Database(path.join(outboxDir, 'outbox.db'));
        try {
            fs.chmodSync(path.join(outboxDir, 'outbox.db'), 0o600);
        } catch {
            /* best effort */
        }
        // The write that acknowledges a phone request must survive a sudden
        // power loss as well as a normal process restart. FULL is deliberately
        // stronger than the weather cache's NORMAL setting.
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = FULL');
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS diary_relay_config (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                relay_url TEXT,
                relay_id TEXT,
                relay_token TEXT,
                relay_owner_id TEXT,
                allow_internet INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS diary_relay_outbox (
                operation_id TEXT PRIMARY KEY,
                entry_json TEXT NOT NULL,
                entry_hash TEXT NOT NULL,
                client_revision INTEGER NOT NULL DEFAULT 1,
                relay_url TEXT,
                relay_id TEXT,
                relay_token TEXT,
                relay_owner_id TEXT,
                allow_internet INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL CHECK (status IN ('queued', 'synced')) DEFAULT 'queued',
                needs_repair INTEGER NOT NULL DEFAULT 0,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL,
                last_attempt_at INTEGER,
                last_error TEXT,
                server_entry_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                synced_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_diary_relay_due
                ON diary_relay_outbox (status, next_attempt_at);

            CREATE TABLE IF NOT EXISTS diary_relay_cancellations (
                operation_id TEXT PRIMARY KEY,
                relay_url TEXT,
                relay_id TEXT,
                relay_token TEXT,
                relay_owner_id TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'synced')) DEFAULT 'queued',
                needs_repair INTEGER NOT NULL DEFAULT 0,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL,
                last_attempt_at INTEGER,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                synced_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_diary_relay_cancellations_due
                ON diary_relay_cancellations (status, next_attempt_at);
        `);
        // Existing Pi relay installations predate revision-aware entries.
        // SQLite can add the non-null/default column in place without
        // disturbing the durable rows already waiting offshore.
        const outboxColumns = this.db.prepare('PRAGMA table_info(diary_relay_outbox)').all() as Array<{ name: string }>;
        if (!outboxColumns.some((column) => column.name === 'client_revision')) {
            this.db.exec('ALTER TABLE diary_relay_outbox ADD COLUMN client_revision INTEGER NOT NULL DEFAULT 1');
        }
        if (!outboxColumns.some((column) => column.name === 'needs_repair')) {
            this.db.exec('ALTER TABLE diary_relay_outbox ADD COLUMN needs_repair INTEGER NOT NULL DEFAULT 0');
        }
        if (!outboxColumns.some((column) => column.name === 'relay_owner_id')) {
            this.db.exec('ALTER TABLE diary_relay_outbox ADD COLUMN relay_owner_id TEXT');
        }
        const cancellationColumns = this.db.prepare('PRAGMA table_info(diary_relay_cancellations)').all() as Array<{
            name: string;
        }>;
        if (!cancellationColumns.some((column) => column.name === 'needs_repair')) {
            this.db.exec('ALTER TABLE diary_relay_cancellations ADD COLUMN needs_repair INTEGER NOT NULL DEFAULT 0');
        }
        if (!cancellationColumns.some((column) => column.name === 'relay_owner_id')) {
            this.db.exec('ALTER TABLE diary_relay_cancellations ADD COLUMN relay_owner_id TEXT');
        }
        const configColumns = this.db.prepare('PRAGMA table_info(diary_relay_config)').all() as Array<{ name: string }>;
        if (!configColumns.some((column) => column.name === 'relay_owner_id')) {
            this.db.exec('ALTER TABLE diary_relay_config ADD COLUMN relay_owner_id TEXT');
        }
        const existing = this.db.prepare('SELECT relay_id FROM diary_relay_config WHERE singleton = 1').get() as
            | { relay_id: string | null }
            | undefined;
        if (!existing) {
            const now = this.now();
            this.db
                .prepare(
                    'INSERT INTO diary_relay_config (singleton, relay_url, relay_id, relay_token, relay_owner_id, allow_internet, updated_at) VALUES (1, NULL, ?, NULL, NULL, 0, ?)',
                )
                .run(newPiRelayId(), now);
        } else if (!existing.relay_id || !RELAY_ID_RE.test(existing.relay_id)) {
            // A short-lived pre-release build may have written an incomplete
            // row. Give it a real Pi identity before any user pairs it.
            this.db
                .prepare('UPDATE diary_relay_config SET relay_id = ?, updated_at = ? WHERE singleton = 1')
                .run(newPiRelayId(), this.now());
        }

        this.invalidateUntrustedPersistedRelayUrls();

        // The Pi cannot reliably identify an arbitrary uplink as satellite or
        // ordinary Internet on its own. Fail closed after every process boot
        // until a currently connected authenticated app re-applies the
        // skipper's policy. This prevents a stale `true` flag from draining
        // private diary work over a satellite link during a restart race.
        this.db
            .prepare('UPDATE diary_relay_config SET allow_internet = 0, updated_at = ? WHERE singleton = 1')
            .run(this.now());

        this.fetchImpl =
            options.fetchImpl ?? ((url, init) => outboundFetch(url, init as Parameters<typeof outboundFetch>[1]));
        this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        const retryInterval = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
        if (retryInterval > 0) {
            this.retryTimer = setInterval(() => {
                void this.flushDue().catch((error) => {
                    // Do not include entries/tokens in logs.
                    console.warn(`Diary relay retry sweep failed: ${errorMessage(error)}`);
                });
            }, retryInterval);
            this.retryTimer.unref();
        }
        // A Pi can reboot while offshore. Once its persisted policy and scoped
        // relay are both valid, start draining immediately rather than waiting
        // for the first periodic sweep.
        queueMicrotask(() => {
            if (this.closed) return;
            void this.flushDue().catch((error) => {
                console.warn(`Diary relay startup sweep failed: ${errorMessage(error)}`);
            });
        });
    }

    /** Persist Pi-local relay configuration. Never return the token. */
    /**
     * Lend the pairing credential to the video relay, and to nothing else.
     *
     * The video worker presents this to the SAME Edge Function the outbox
     * writes through, which answers with a signed upload URL for one object in
     * the owner's folder — so the strongest thing these credentials can ever
     * do is what the diary relay could already do, plus place a file the
     * caller named into the skipper's own video folder.
     */
    lendVideoCredentials(): { url: string; relayId: string; token: string; ownerId: string } | null {
        const configured = this.readConfiguration();
        const relay = relayFromParts(
            this.trustedRelayEndpoint,
            configured.url,
            configured.relayId,
            configured.token,
            configured.ownerId,
        );
        return relay ? { url: relay.url, relayId: relay.relayId, token: relay.token, ownerId: relay.ownerId } : null;
    }

    /**
     * Lend the pairing credential to the anchor watch, and to nothing else.
     *
     * The broadcaster presents this to the anchor-relay Edge Function, which
     * verifies the credential AND that the signed-in app authorised THIS relay
     * for the session code it names. So the strongest thing these credentials
     * can do here is publish this boat's position to a channel the skipper's
     * own app has already granted — and that grant lapses in six hours whether
     * or not anyone remembers to revoke it.
     *
     * Deliberately no url: the caller derives the endpoint from the
     * process-startup trust anchor, so a Boat-LAN request can never point the
     * boat's position at a host of its choosing.
     */
    lendAnchorCredentials(): { relayId: string; token: string } | null {
        const configured = this.readConfiguration();
        const relay = relayFromParts(
            this.trustedRelayEndpoint,
            configured.url,
            configured.relayId,
            configured.token,
            configured.ownerId,
        );
        return relay ? { relayId: relay.relayId, token: relay.token } : null;
    }

    /**
     * Lend the pairing credential to the telemetry publisher, and to nothing
     * else. It presents this to the telemetry-relay Edge Function, which
     * verifies the credential and stores one bounded snapshot row for the
     * skipper who paired this Pi — the strongest thing it can do is say where
     * the boat is and what her instruments read, to the people the skipper
     * already lets see that. No url, for the same reason as the anchor watch:
     * the endpoint comes from the process-startup trust anchor.
     */
    lendTelemetryCredentials(): { relayId: string; token: string } | null {
        return this.lendAnchorCredentials();
    }

    configure(input: DiaryRelayConfigInput): DiaryRelayPublicConfiguration {
        if (input.allowInternet !== undefined && typeof input.allowInternet !== 'boolean') {
            throw new DiaryRelayValidationError('allowInternet must be a boolean');
        }
        const current = this.readConfiguration();
        const hasRelayField =
            input.url !== undefined ||
            input.relayId !== undefined ||
            input.token !== undefined ||
            input.ownerId !== undefined;
        let nextUrl = current.url;
        let nextRelayId = current.relayId;
        let nextToken = current.token;
        let nextOwnerId = current.ownerId;
        if (hasRelayField) {
            const relay = validateRelay(
                {
                    url: input.url ?? current.url,
                    relayId: input.relayId ?? current.relayId,
                    token: input.token ?? current.token,
                    ownerId: input.ownerId ?? current.ownerId,
                },
                this.trustedRelayEndpoint,
            );
            nextUrl = relay.url;
            nextRelayId = relay.relayId;
            nextToken = relay.token;
            nextOwnerId = relay.ownerId;
        }
        const allowInternet = input.allowInternet === undefined ? current.allowInternet : input.allowInternet;
        const now = this.now();
        this.db
            .prepare(
                `UPDATE diary_relay_config
                 SET relay_url = ?, relay_id = ?, relay_token = ?, relay_owner_id = ?, allow_internet = ?, updated_at = ?
                 WHERE singleton = 1`,
            )
            .run(nextUrl, nextRelayId, nextToken, nextOwnerId, allowInternet ? 1 : 0, now);
        // A refreshed relay token or an explicit opt-in may make old entries
        // immediately deliverable. Wake the worker without waiting 15 seconds.
        void this.flushDue().catch(() => {});
        return this.getConfiguration();
    }

    getConfiguration(): DiaryRelayPublicConfiguration {
        const current = this.readConfiguration();
        const relay = relayFromParts(
            this.trustedRelayEndpoint,
            current.url,
            current.relayId,
            current.token,
            current.ownerId,
        );
        return {
            configured: relay !== null,
            allowInternet: current.allowInternet,
            // This is intentionally available before pairing: a signed-in app
            // needs it to obtain the scoped relay bearer for this Pi.
            relayId: current.relayId && RELAY_ID_RE.test(current.relayId) ? current.relayId : null,
            ownerId: relay?.ownerId ?? null,
        };
    }

    enqueue(envelope: DiaryRelayEnvelope): DiaryRelayPublicRecord {
        const { entry, operationId, clientRevision, raw, hash } = entryDetails(envelope?.entry);
        if (envelope.allowInternet !== undefined && typeof envelope.allowInternet !== 'boolean') {
            throw new DiaryRelayValidationError('allowInternet must be a boolean');
        }
        const suppliedRelay =
            envelope.relay === undefined ? null : validateRelay(envelope.relay, this.trustedRelayEndpoint);
        const now = this.now();
        let replacedOlderRevision = false;
        const result = this.db.transaction(() => {
            // A phone can retry old local state after the user has deleted it.
            // The tombstone takes precedence forever, including over a newer
            // app build that tries to replay the original operation id.
            if (this.readCancellation(operationId)) throw new DiaryRelayOperationCancelledError(operationId);

            const existing = this.readRow(operationId);
            if (existing) {
                const configured = this.readConfiguration();
                const bindingError = this.ownerBindingProblem(
                    existing.relay_owner_id,
                    existing.relay_url,
                    existing.relay_id,
                    existing.relay_token,
                    existing.relay_owner_id,
                    configured,
                    suppliedRelay,
                );
                if (existing.status !== 'synced' && bindingError) {
                    this.markEntryNeedsRepair(operationId, existing.client_revision, bindingError, null);
                    return this.readRow(operationId)!;
                }
                if (clientRevision < existing.client_revision) return existing;
                if (clientRevision === existing.client_revision) {
                    if (existing.entry_hash !== hash) throw new DiaryRelayOperationConflictError(operationId);
                    // A retry from the phone may carry a fresh per-Pi token.
                    // Never rewrite a confirmed server result, but allow
                    // unsynced rows to refresh their private relay snapshot.
                    if (existing.status !== 'synced') {
                        const allowInternet =
                            envelope.allowInternet === undefined
                                ? existing.allow_internet
                                : envelope.allowInternet
                                  ? 1
                                  : 0;
                        this.db
                            .prepare(
                                `UPDATE diary_relay_outbox
                                 SET relay_url = ?, relay_id = ?, relay_token = ?, relay_owner_id = ?, allow_internet = ?,
                                     next_attempt_at = ?, updated_at = ?
                                 WHERE operation_id = ?`,
                            )
                            .run(
                                suppliedRelay?.url ?? existing.relay_url,
                                suppliedRelay?.relayId ?? existing.relay_id,
                                suppliedRelay?.token ?? existing.relay_token,
                                // `relay_owner_id` is the immutable account
                                // binding for this operation; credentials may
                                // refresh only for that same account.
                                existing.relay_owner_id,
                                allowInternet,
                                now,
                                now,
                                operationId,
                            );
                    }
                    return this.readRow(operationId)!;
                }

                // Revision is the only safe way to update a durable operation.
                // A higher revision replaces a queued row and reopens an
                // already-synced row. The Edge Function performs the matching
                // revision check, so an interrupted old request cannot win.
                const configuredRelay = relayFromParts(
                    this.trustedRelayEndpoint,
                    configured.url,
                    configured.relayId,
                    configured.token,
                    configured.ownerId,
                );
                const relay = suppliedRelay ?? configuredRelay;
                this.db
                    .prepare(
                        `UPDATE diary_relay_outbox
                         SET entry_json = ?, entry_hash = ?, client_revision = ?,
                             relay_url = ?, relay_id = ?, relay_token = ?, relay_owner_id = ?, allow_internet = ?,
                             status = 'queued', needs_repair = 0, attempt_count = 0, next_attempt_at = ?, last_attempt_at = NULL,
                             last_error = NULL, server_entry_json = NULL, updated_at = ?, synced_at = NULL
                         WHERE operation_id = ?`,
                    )
                    .run(
                        raw,
                        hash,
                        clientRevision,
                        relay?.url ?? existing.relay_url,
                        relay?.relayId ?? existing.relay_id,
                        relay?.token ?? existing.relay_token,
                        // Higher revisions retain the original owner binding.
                        existing.relay_owner_id,
                        envelope.allowInternet === undefined ? existing.allow_internet : envelope.allowInternet ? 1 : 0,
                        now,
                        now,
                        operationId,
                    );
                replacedOlderRevision = true;
                return this.readRow(operationId)!;
            }

            // A configured relay is copied into the record so reboot-resume
            // works even if the app does not resend this entry. A later config
            // refresh still takes precedence when forwarding.
            const configured = this.readConfiguration();
            const configuredRelay = relayFromParts(
                this.trustedRelayEndpoint,
                configured.url,
                configured.relayId,
                configured.token,
                configured.ownerId,
            );
            const relay = suppliedRelay ?? configuredRelay;
            const initialBindingError = !relay
                ? OWNER_BINDING_MISSING
                : configured.ownerId && configured.ownerId !== relay.ownerId
                  ? OWNER_BINDING_MISMATCH
                  : null;
            this.db
                .prepare(
                    `INSERT INTO diary_relay_outbox (
                        operation_id, entry_json, entry_hash, client_revision,
                        relay_url, relay_id, relay_token, relay_owner_id,
                        allow_internet, status, needs_repair, attempt_count, next_attempt_at, last_error, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`,
                )
                .run(
                    operationId,
                    raw,
                    hash,
                    clientRevision,
                    relay?.url ?? null,
                    relay?.relayId ?? null,
                    relay?.token ?? null,
                    relay?.ownerId ?? null,
                    envelope.allowInternet === true ? 1 : 0,
                    initialBindingError ? 1 : 0,
                    now,
                    initialBindingError,
                    now,
                    now,
                );
            return this.readRow(operationId)!;
        })();
        if (replacedOlderRevision) this.entryAbortControllers.get(operationId)?.abort();
        // `entry` is retained only to make the type checker understand the
        // validated entry is intentional; the returned row is the durable copy.
        void entry;
        return this.toPublicRecord(result);
    }

    /**
     * Create a durable cancellation tombstone before returning to the phone.
     * A queued local entry is removed in the same SQLite transaction, while a
     * record that was already delivered is left intact until the Edge action
     * deletes it. In either case the tombstone wins all future status/flushes.
     */
    cancel(operationId: string): DiaryRelayPublicRecord {
        const validatedOperationId = validateOperationId(operationId);
        const now = this.now();
        const cancellation = this.db.transaction(() => {
            const existingCancellation = this.readCancellation(validatedOperationId);
            const entry = this.readRow(validatedOperationId);
            const configured = this.readConfiguration();
            const configuredRelay = relayFromParts(
                this.trustedRelayEndpoint,
                configured.url,
                configured.relayId,
                configured.token,
                configured.ownerId,
            );
            const entryRelay = entry
                ? relayFromParts(
                      this.trustedRelayEndpoint,
                      entry.relay_url,
                      entry.relay_id,
                      entry.relay_token,
                      entry.relay_owner_id,
                  )
                : null;

            if (!existingCancellation) {
                // A cancellation of an existing diary inherits that diary's
                // immutable owner. It must not quietly adopt a newly paired
                // account merely because the Pi's current config changed.
                const boundOwner = entry ? entry.relay_owner_id : (configuredRelay?.ownerId ?? null);
                const bindingError = entry
                    ? this.ownerBindingProblem(
                          entry.relay_owner_id,
                          entry.relay_url,
                          entry.relay_id,
                          entry.relay_token,
                          entry.relay_owner_id,
                          configured,
                      )
                    : configuredRelay
                      ? null
                      : new DiaryRelayPermanentError(OWNER_BINDING_MISSING);
                const relay = entryRelay ?? configuredRelay;
                this.db
                    .prepare(
                        `INSERT INTO diary_relay_cancellations (
                            operation_id, relay_url, relay_id, relay_token, relay_owner_id,
                            status, needs_repair, attempt_count, next_attempt_at, last_error, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`,
                    )
                    .run(
                        validatedOperationId,
                        relay?.url ?? null,
                        relay?.relayId ?? null,
                        relay?.token ?? null,
                        boundOwner,
                        bindingError ? 1 : 0,
                        now,
                        bindingError ? errorMessage(bindingError) : null,
                        now,
                        now,
                    );
            } else if (existingCancellation.status !== 'synced') {
                const bindingError = this.ownerBindingProblem(
                    existingCancellation.relay_owner_id,
                    existingCancellation.relay_url,
                    existingCancellation.relay_id,
                    existingCancellation.relay_token,
                    existingCancellation.relay_owner_id,
                    configured,
                );
                if (bindingError) {
                    this.markCancellationNeedsRepair(validatedOperationId, bindingError, null);
                } else {
                    const existingRelay = relayFromParts(
                        this.trustedRelayEndpoint,
                        existingCancellation.relay_url,
                        existingCancellation.relay_id,
                        existingCancellation.relay_token,
                        existingCancellation.relay_owner_id,
                    );
                    const relay = configuredRelay ?? existingRelay;
                    this.db
                        .prepare(
                            `UPDATE diary_relay_cancellations
                             SET relay_url = ?, relay_id = ?, relay_token = ?, relay_owner_id = ?,
                                 needs_repair = 0, attempt_count = 0, next_attempt_at = ?, last_attempt_at = NULL,
                                 last_error = NULL, updated_at = ?
                             WHERE operation_id = ? AND status = 'queued'`,
                        )
                        .run(
                            relay?.url ?? existingCancellation.relay_url,
                            relay?.relayId ?? existingCancellation.relay_id,
                            relay?.token ?? existingCancellation.relay_token,
                            // Never mutate an existing cancellation's owner.
                            existingCancellation.relay_owner_id,
                            now,
                            now,
                            validatedOperationId,
                        );
                }
            }

            // Deleting the unsent row is deliberately atomic with writing the
            // tombstone. It cannot reappear after reboot or a retry sweep.
            this.db
                .prepare("DELETE FROM diary_relay_outbox WHERE operation_id = ? AND status = 'queued'")
                .run(validatedOperationId);
            return this.readCancellation(validatedOperationId)!;
        })();
        // If a request was already in flight, abort its local transport. A
        // packet that has already reached the Edge is harmless: this durable
        // cancellation is retried before remaining entries until it is applied.
        this.entryAbortControllers.get(validatedOperationId)?.abort();
        void this.flushDue().catch(() => {});
        return this.toPublicCancellationRecord(cancellation);
    }

    getStatus(operationId: string): DiaryRelayPublicRecord | null {
        if (!operationId || operationId.length > MAX_OPERATION_ID_LENGTH) return null;
        const cancellation = this.readCancellation(operationId);
        if (cancellation) return this.toPublicCancellationRecord(cancellation);
        const row = this.readRow(operationId);
        return row ? this.toPublicRecord(row) : null;
    }

    /**
     * The immediate submitting client may need the canonical Supabase row to
     * retire its own local draft. Keep that payload off all LAN status APIs:
     * this method is intentionally consumed only by POST /api/diary/entries
     * after a just-completed `synced` handoff.
     */
    getCanonicalEntry(operationId: string): Record<string, unknown> | null {
        const row = this.readRow(operationId);
        if (!row || row.status !== 'synced' || row.needs_repair === 1) return null;
        return parseObject(row.server_entry_json) ?? null;
    }

    getStats(): DiaryRelayStats {
        const queued = this.db
            .prepare("SELECT COUNT(*) AS count FROM diary_relay_outbox WHERE status = 'queued' AND needs_repair = 0")
            .get() as {
            count: number;
        };
        const synced = this.db
            .prepare("SELECT COUNT(*) AS count FROM diary_relay_outbox WHERE status = 'synced'")
            .get() as {
            count: number;
        };
        const entryNeedsRepair = this.db
            .prepare('SELECT COUNT(*) AS count FROM diary_relay_outbox WHERE needs_repair = 1')
            .get() as { count: number };
        const cancellationsQueued = this.db
            .prepare(
                "SELECT COUNT(*) AS count FROM diary_relay_cancellations WHERE status = 'queued' AND needs_repair = 0",
            )
            .get() as {
            count: number;
        };
        const cancellationsSynced = this.db
            .prepare("SELECT COUNT(*) AS count FROM diary_relay_cancellations WHERE status = 'synced'")
            .get() as {
            count: number;
        };
        const cancellationNeedsRepair = this.db
            .prepare('SELECT COUNT(*) AS count FROM diary_relay_cancellations WHERE needs_repair = 1')
            .get() as { count: number };
        return {
            queued: queued.count,
            synced: synced.count,
            needsRepair: entryNeedsRepair.count + cancellationNeedsRepair.count,
            cancellationsQueued: cancellationsQueued.count,
            cancellationsSynced: cancellationsSynced.count,
            relay: this.getConfiguration(),
        };
    }

    /** Try one entry immediately. It always reads durable state first. */
    async attempt(operationId: string): Promise<DiaryRelayPublicRecord | null> {
        const cancellation = this.readCancellation(operationId);
        if (cancellation) return this.toPublicCancellationRecord(cancellation);
        const starting = this.readRow(operationId);
        if (!starting || starting.status === 'synced') return starting ? this.toPublicRecord(starting) : null;
        if (starting.needs_repair === 1) return this.toPublicRecord(starting);
        if (this.inFlight.has(operationId)) return this.getStatus(operationId);

        const policy = this.readConfiguration();
        const resolved = this.resolveOwnerBoundRelay(
            starting.relay_owner_id,
            starting.relay_url,
            starting.relay_id,
            starting.relay_token,
            starting.relay_owner_id,
            policy,
        );
        if (resolved.error) {
            this.markEntryNeedsRepair(operationId, starting.client_revision, resolved.error, null);
            return this.getStatus(operationId);
        }
        const relay = resolved.relay;
        if (!relay) return this.toPublicRecord(starting);
        // The persisted Pi-wide policy is intentionally the only WAN gate.
        // A phone may hand off while it is offline/satellite; that temporary
        // client state must not permanently maroon the durable entry.
        if (!policy.allowInternet) return this.toPublicRecord(starting);

        this.inFlight.add(operationId);
        const controller = new AbortController();
        this.entryAbortControllers.set(operationId, controller);
        try {
            const durableEntry = parseObject(starting.entry_json);
            if (!durableEntry) {
                throw new DiaryRelayPermanentError('Diary relay entry is corrupted');
            }
            const serverEntry = await this.forwardEntry(
                relay,
                durableEntry,
                controller,
                starting.operation_id,
                starting.client_revision,
            );
            const now = this.now();
            this.db
                .prepare(
                    `UPDATE diary_relay_outbox
                         SET status = 'synced', server_entry_json = ?, last_attempt_at = ?, last_error = NULL,
                         next_attempt_at = ?, updated_at = ?, synced_at = ?
                     WHERE operation_id = ? AND client_revision = ? AND status = 'queued'`,
                )
                .run(JSON.stringify(serverEntry), now, now, now, now, operationId, starting.client_revision);
        } catch (error) {
            if (error instanceof DiaryRelayPermanentError && error.remoteCancellation) {
                this.recordRemoteCancellation(operationId, relay);
            } else if (error instanceof DiaryRelayPermanentError) {
                this.markEntryNeedsRepair(operationId, starting.client_revision, error, relay);
            } else {
                this.scheduleEntryRetry(operationId, starting.client_revision, error, relay);
            }
        } finally {
            this.inFlight.delete(operationId);
            if (this.entryAbortControllers.get(operationId) === controller) {
                this.entryAbortControllers.delete(operationId);
            }
        }
        return this.getStatus(operationId);
    }

    /**
     * Try one durable cancellation tombstone. It is intentionally separate
     * from `attempt()` so a deletion can be retried without ever reviving the
     * entry it suppresses.
     */
    async attemptCancellation(operationId: string): Promise<DiaryRelayPublicRecord | null> {
        const starting = this.readCancellation(operationId);
        if (!starting || starting.status === 'synced') {
            return starting ? this.toPublicCancellationRecord(starting) : null;
        }
        if (starting.needs_repair === 1) return this.toPublicCancellationRecord(starting);
        if (this.cancellationInFlight.has(operationId)) return this.getStatus(operationId);

        const policy = this.readConfiguration();
        const resolved = this.resolveOwnerBoundRelay(
            starting.relay_owner_id,
            starting.relay_url,
            starting.relay_id,
            starting.relay_token,
            starting.relay_owner_id,
            policy,
        );
        if (resolved.error) {
            this.markCancellationNeedsRepair(operationId, resolved.error, null);
            return this.getStatus(operationId);
        }
        const relay = resolved.relay;
        if (!relay) return this.toPublicCancellationRecord(starting);
        if (!policy.allowInternet) return this.toPublicCancellationRecord(starting);

        this.cancellationInFlight.add(operationId);
        try {
            await this.forwardCancellation(relay, operationId);
            const now = this.now();
            this.db
                .prepare(
                    `UPDATE diary_relay_cancellations
                     SET status = 'synced', last_attempt_at = ?, last_error = NULL,
                         next_attempt_at = ?, updated_at = ?, synced_at = ?
                     WHERE operation_id = ? AND status = 'queued'`,
                )
                .run(now, now, now, now, operationId);
        } catch (error) {
            if (error instanceof DiaryRelayPermanentError) {
                this.markCancellationNeedsRepair(operationId, error, relay);
            } else {
                this.scheduleCancellationRetry(operationId, error, relay);
            }
        } finally {
            this.cancellationInFlight.delete(operationId);
        }
        return this.getStatus(operationId);
    }

    /**
     * Drain durable work whose retry deadline has passed. Cancellation
     * tombstones always drain before entries, including the automatic startup
     * sweep after a Pi reboot.
     */
    async flushDue(limit = 8): Promise<number> {
        if (this.closed) return 0;
        const config = this.readConfiguration();
        const boundedLimit = Math.max(1, Math.min(limit, 32));
        // Quarantine legacy/partially-written rows even while WAN is disabled
        // or the Pi is awaiting a new credential. This prevents an old
        // ownerless record from becoming eligible later by accident.
        let attempted = this.quarantineInvalidOwnerBindings(config, boundedLimit);
        // A persisted Pi policy *and* a complete persisted relay are required
        // for autonomous retries. Envelope snapshots still make a newly
        // received entry durable, but they cannot turn a half-configured Pi
        // into an unexpected WAN sender after a reboot.
        if (
            !config.allowInternet ||
            !relayFromParts(this.trustedRelayEndpoint, config.url, config.relayId, config.token, config.ownerId)
        )
            return attempted;
        const now = this.now();
        const cancellationRows = this.db
            .prepare(
                `SELECT * FROM diary_relay_cancellations
                 WHERE status = 'queued' AND needs_repair = 0 AND next_attempt_at <= ?
                 ORDER BY created_at ASC LIMIT ?`,
            )
            .all(now, boundedLimit) as StoredCancellationRow[];
        for (const row of cancellationRows) {
            if (this.cancellationInFlight.has(row.operation_id)) continue;
            attempted++;
            await this.attemptCancellation(row.operation_id);
        }
        const remaining = boundedLimit - attempted;
        if (remaining <= 0) return attempted;
        const rows = this.db
            .prepare(
                `SELECT * FROM diary_relay_outbox
                 WHERE status = 'queued' AND needs_repair = 0 AND next_attempt_at <= ?
                 ORDER BY created_at ASC LIMIT ?`,
            )
            .all(now, remaining) as StoredOutboxRow[];
        for (const row of rows) {
            if (this.inFlight.has(row.operation_id)) continue;
            attempted++;
            await this.attempt(row.operation_id);
        }
        return attempted;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
        }
        this.db.close();
    }

    /**
     * Pre-hardening builds accepted any HTTPS host whose path ended with the
     * Edge Function suffix. Scrub those persisted credentials before the
     * startup sweep can perform network I/O, and quarantine pending work so a
     * later policy-only update cannot revive an attacker-selected authority.
     */
    private invalidateUntrustedPersistedRelayUrls(): void {
        const now = this.now();
        this.db.transaction(() => {
            this.db
                .prepare(
                    `UPDATE diary_relay_config
                     SET relay_url = NULL, relay_token = NULL, relay_owner_id = NULL,
                         allow_internet = 0, updated_at = ?
                     WHERE relay_url IS NOT NULL AND relay_url <> ?`,
                )
                .run(now, this.trustedRelayEndpoint);

            this.db
                .prepare(
                    `UPDATE diary_relay_outbox
                     SET needs_repair = 1, next_attempt_at = ?, last_error = ?, updated_at = ?
                     WHERE status = 'queued' AND needs_repair = 0
                       AND relay_url IS NOT NULL AND relay_url <> ?`,
                )
                .run(now, RELAY_AUTHORITY_MISMATCH, now, this.trustedRelayEndpoint);
            this.db
                .prepare(
                    `UPDATE diary_relay_outbox
                     SET relay_url = NULL, relay_token = NULL, updated_at = ?
                     WHERE relay_url IS NOT NULL AND relay_url <> ?`,
                )
                .run(now, this.trustedRelayEndpoint);

            this.db
                .prepare(
                    `UPDATE diary_relay_cancellations
                     SET needs_repair = 1, next_attempt_at = ?, last_error = ?, updated_at = ?
                     WHERE status = 'queued' AND needs_repair = 0
                       AND relay_url IS NOT NULL AND relay_url <> ?`,
                )
                .run(now, RELAY_AUTHORITY_MISMATCH, now, this.trustedRelayEndpoint);
            this.db
                .prepare(
                    `UPDATE diary_relay_cancellations
                     SET relay_url = NULL, relay_token = NULL, updated_at = ?
                     WHERE relay_url IS NOT NULL AND relay_url <> ?`,
                )
                .run(now, this.trustedRelayEndpoint);
        })();
    }

    private readConfiguration(): StoredRelayConfiguration {
        const row = this.db
            .prepare(
                'SELECT relay_url, relay_id, relay_token, relay_owner_id, allow_internet FROM diary_relay_config WHERE singleton = 1',
            )
            .get() as
            | {
                  relay_url: string | null;
                  relay_id: string | null;
                  relay_token: string | null;
                  relay_owner_id: string | null;
                  allow_internet: number;
              }
            | undefined;
        return {
            url: row?.relay_url ?? null,
            relayId: row?.relay_id ?? null,
            token: row?.relay_token ?? null,
            ownerId: row?.relay_owner_id ?? null,
            allowInternet: row?.allow_internet === 1,
        };
    }

    private readRow(operationId: string): StoredOutboxRow | undefined {
        return this.db.prepare('SELECT * FROM diary_relay_outbox WHERE operation_id = ?').get(operationId) as
            | StoredOutboxRow
            | undefined;
    }

    private readCancellation(operationId: string): StoredCancellationRow | undefined {
        return this.db.prepare('SELECT * FROM diary_relay_cancellations WHERE operation_id = ?').get(operationId) as
            | StoredCancellationRow
            | undefined;
    }

    /**
     * A queued payload is irrevocably bound to the account that supplied its
     * relay credential. A later Pi pairing for another account must never turn
     * the Pi into a cross-account delivery channel. The row credential may be
     * used only when no conflicting configured owner exists.
     */
    private resolveOwnerBoundRelay(
        ownerId: string | null,
        relayUrl: string | null,
        relayId: string | null,
        relayToken: string | null,
        relayOwnerId: string | null,
        configured: StoredRelayConfiguration,
    ): OwnerBoundRelayResolution {
        const bindingError = this.ownerBindingProblem(ownerId, relayUrl, relayId, relayToken, relayOwnerId, configured);
        if (bindingError) return { relay: null, error: bindingError };
        const rowRelay = relayFromParts(this.trustedRelayEndpoint, relayUrl, relayId, relayToken, relayOwnerId)!;

        const configuredRelay = relayFromParts(
            this.trustedRelayEndpoint,
            configured.url,
            configured.relayId,
            configured.token,
            configured.ownerId,
        );
        if (configuredRelay) {
            if (configuredRelay.ownerId !== ownerId) {
                return { relay: null, error: new DiaryRelayPermanentError(OWNER_BINDING_MISMATCH) };
            }
            return { relay: configuredRelay };
        }

        return { relay: rowRelay };
    }

    private ownerBindingProblem(
        ownerId: string | null,
        relayUrl: string | null,
        relayId: string | null,
        relayToken: string | null,
        relayOwnerId: string | null,
        configured: StoredRelayConfiguration,
        suppliedRelay?: RelayCredentials | null,
    ): DiaryRelayPermanentError | null {
        const rowRelay = relayFromParts(this.trustedRelayEndpoint, relayUrl, relayId, relayToken, relayOwnerId);
        if (!hasImmutableOwnerBinding(rowRelay, ownerId)) {
            return new DiaryRelayPermanentError(OWNER_BINDING_MISSING);
        }

        // Compare the configured owner even if its credential is currently
        // incomplete. A partial re-pair for another account is still a hard
        // security boundary, not a reason to fall back to an old row token.
        if (configured.ownerId && configured.ownerId !== ownerId) {
            return new DiaryRelayPermanentError(OWNER_BINDING_MISMATCH);
        }
        if (suppliedRelay && suppliedRelay.ownerId !== ownerId) {
            return new DiaryRelayPermanentError(OWNER_BINDING_MISMATCH);
        }
        return null;
    }

    /**
     * Upgrade safety for rows created by older Pi builds: ownerless or
     * cross-account records become durable `needs_repair` state before any
     * network work is considered.
     */
    private quarantineInvalidOwnerBindings(configured: StoredRelayConfiguration, limit: number): number {
        let quarantined = 0;
        const entryRows = this.db
            .prepare(
                `SELECT * FROM diary_relay_outbox
                 WHERE status = 'queued' AND needs_repair = 0
                 ORDER BY created_at ASC`,
            )
            .all() as StoredOutboxRow[];
        for (const row of entryRows) {
            if (quarantined >= limit) break;
            const error = this.ownerBindingProblem(
                row.relay_owner_id,
                row.relay_url,
                row.relay_id,
                row.relay_token,
                row.relay_owner_id,
                configured,
            );
            if (!error) continue;
            this.markEntryNeedsRepair(row.operation_id, row.client_revision, error, null);
            quarantined++;
        }

        const remaining = Math.max(0, limit - quarantined);
        if (remaining === 0) return quarantined;
        const cancellationRows = this.db
            .prepare(
                `SELECT * FROM diary_relay_cancellations
                 WHERE status = 'queued' AND needs_repair = 0
                 ORDER BY created_at ASC`,
            )
            .all() as StoredCancellationRow[];
        for (const row of cancellationRows) {
            if (quarantined >= limit) break;
            const error = this.ownerBindingProblem(
                row.relay_owner_id,
                row.relay_url,
                row.relay_id,
                row.relay_token,
                row.relay_owner_id,
                configured,
            );
            if (!error) continue;
            this.markCancellationNeedsRepair(row.operation_id, error, null);
            quarantined++;
        }
        return quarantined;
    }

    private scheduleEntryRetry(
        operationId: string,
        clientRevision: number,
        error: unknown,
        relay: RelayCredentials,
    ): void {
        const current = this.readRow(operationId);
        if (
            !current ||
            current.status !== 'queued' ||
            current.needs_repair === 1 ||
            current.client_revision !== clientRevision
        ) {
            return;
        }
        const now = this.now();
        const attempts = current.attempt_count + 1;
        this.db
            .prepare(
                `UPDATE diary_relay_outbox
                 SET attempt_count = ?, next_attempt_at = ?, last_attempt_at = ?, last_error = ?, updated_at = ?
                 WHERE operation_id = ? AND client_revision = ? AND status = 'queued' AND needs_repair = 0`,
            )
            .run(
                attempts,
                now + retryDelayMs(attempts),
                now,
                errorMessage(error, [relay.token]),
                now,
                operationId,
                clientRevision,
            );
    }

    private markEntryNeedsRepair(
        operationId: string,
        clientRevision: number,
        error: DiaryRelayPermanentError,
        relay: RelayCredentials | null,
    ): void {
        const current = this.readRow(operationId);
        if (
            !current ||
            current.status !== 'queued' ||
            current.needs_repair === 1 ||
            current.client_revision !== clientRevision
        ) {
            return;
        }
        const now = this.now();
        const attempts = current.attempt_count + 1;
        this.db
            .prepare(
                `UPDATE diary_relay_outbox
                 SET needs_repair = 1, attempt_count = ?, next_attempt_at = ?, last_attempt_at = ?,
                     last_error = ?, updated_at = ?
                 WHERE operation_id = ? AND client_revision = ? AND status = 'queued' AND needs_repair = 0`,
            )
            .run(attempts, now, now, errorMessage(error, [relay?.token]), now, operationId, clientRevision);
    }

    private scheduleCancellationRetry(operationId: string, error: unknown, relay: RelayCredentials): void {
        const current = this.readCancellation(operationId);
        if (!current || current.status !== 'queued' || current.needs_repair === 1) return;
        const now = this.now();
        const attempts = current.attempt_count + 1;
        this.db
            .prepare(
                `UPDATE diary_relay_cancellations
                 SET attempt_count = ?, next_attempt_at = ?, last_attempt_at = ?, last_error = ?, updated_at = ?
                 WHERE operation_id = ? AND status = 'queued' AND needs_repair = 0`,
            )
            .run(attempts, now + retryDelayMs(attempts), now, errorMessage(error, [relay.token]), now, operationId);
    }

    private markCancellationNeedsRepair(
        operationId: string,
        error: DiaryRelayPermanentError,
        relay: RelayCredentials | null,
    ): void {
        const current = this.readCancellation(operationId);
        if (!current || current.status !== 'queued' || current.needs_repair === 1) return;
        const now = this.now();
        const attempts = current.attempt_count + 1;
        this.db
            .prepare(
                `UPDATE diary_relay_cancellations
                 SET needs_repair = 1, attempt_count = ?, next_attempt_at = ?, last_attempt_at = ?,
                     last_error = ?, updated_at = ?
                 WHERE operation_id = ? AND status = 'queued' AND needs_repair = 0`,
            )
            .run(attempts, now, now, errorMessage(error, [relay?.token]), now, operationId);
    }

    /**
     * The Edge has an authoritative cancellation tombstone. Persist that fact
     * locally before returning so a stale device replay can never revive it.
     */
    private recordRemoteCancellation(operationId: string, relay: RelayCredentials): void {
        const now = this.now();
        this.db.transaction(() => {
            const existing = this.readCancellation(operationId);
            if (existing) {
                this.db
                    .prepare(
                        `UPDATE diary_relay_cancellations
                         SET relay_url = ?, relay_id = ?, relay_token = ?, relay_owner_id = ?,
                             status = 'synced', needs_repair = 0, last_attempt_at = ?, last_error = NULL,
                             next_attempt_at = ?, updated_at = ?, synced_at = ?
                         WHERE operation_id = ?`,
                    )
                    .run(
                        relay.url,
                        relay.relayId,
                        relay.token,
                        // Preserve the immutable existing owner binding.
                        existing.relay_owner_id,
                        now,
                        now,
                        now,
                        now,
                        operationId,
                    );
            } else {
                this.db
                    .prepare(
                        `INSERT INTO diary_relay_cancellations (
                            operation_id, relay_url, relay_id, relay_token, relay_owner_id,
                            status, needs_repair, attempt_count, next_attempt_at, last_attempt_at,
                            created_at, updated_at, synced_at
                        ) VALUES (?, ?, ?, ?, ?, 'synced', 0, 1, ?, ?, ?, ?, ?)`,
                    )
                    .run(operationId, relay.url, relay.relayId, relay.token, relay.ownerId, now, now, now, now, now);
            }
            this.db
                .prepare("DELETE FROM diary_relay_outbox WHERE operation_id = ? AND status = 'queued'")
                .run(operationId);
        })();
    }

    private toPublicRecord(row: StoredOutboxRow): DiaryRelayPublicRecord {
        return {
            kind: 'entry',
            operationId: row.operation_id,
            status: row.needs_repair === 1 ? 'needs_repair' : row.status,
            clientRevision: row.client_revision,
            allowInternet: row.allow_internet === 1,
            attemptCount: row.attempt_count,
            queuedAt: row.created_at,
            ...(row.synced_at ? { syncedAt: row.synced_at } : {}),
            ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
            ...(row.last_error ? { lastError: row.last_error } : {}),
        };
    }

    private toPublicCancellationRecord(row: StoredCancellationRow): DiaryRelayPublicRecord {
        return {
            kind: 'cancellation',
            operationId: row.operation_id,
            status: row.needs_repair === 1 ? 'needs_repair' : row.status,
            clientRevision: 1,
            allowInternet: this.readConfiguration().allowInternet,
            attemptCount: row.attempt_count,
            queuedAt: row.created_at,
            ...(row.synced_at ? { syncedAt: row.synced_at } : {}),
            ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
            ...(row.last_error ? { lastError: row.last_error } : {}),
        };
    }

    private async forwardEntry(
        relay: RelayCredentials,
        entry: DiaryRelayEntry,
        controller: AbortController,
        operationId: string,
        clientRevision: number,
    ): Promise<Record<string, unknown>> {
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            const response = await this.fetchImpl(relay.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-Thalassa-Pi-Relay-Id': relay.relayId,
                    'X-Thalassa-Pi-Relay-Token': relay.token,
                },
                body: JSON.stringify({ entry }),
                signal: controller.signal,
            });
            const text = await response.text();
            if (!response.ok) {
                const parsed = parseObject(text);
                if (
                    response.status === 409 &&
                    parsed?.cancelled === true &&
                    parsed.client_operation_id === operationId
                ) {
                    // The Edge's tombstone is authoritative. Convert this
                    // stale Pi write into the same durable local cancellation
                    // instead of retrying it forever.
                    throw new DiaryRelayPermanentError('Diary operation was cancelled remotely', true);
                }
                if (isPermanentRelayStatus(response.status)) {
                    throw new DiaryRelayPermanentError(`Diary relay needs repair (HTTP ${response.status})`);
                }
                // Do not retain an upstream response body: a broken or hostile
                // endpoint could echo our scoped relay credential or diary
                // text into a public status response.
                throw new Error(`Diary relay request failed with HTTP ${response.status}`);
            }
            if (!text) throw new Error('Diary relay returned an incomplete success response');
            const parsed = parseObject(text);
            // The Edge Function's `{ ok: true }` acknowledgement is the only
            // condition that is allowed to advance a durable row to `synced`.
            // A 2xx proxy page, malformed response, or `{ ok: false }` stays
            // queued so the app can re-hand-off once its media/config is fixed.
            if (!parsed || parsed.ok !== true) throw new Error('Diary relay returned an incomplete success response');
            const status = parsed.status;
            const canonicalEntry = parsed.entry;
            if (
                (status !== 'accepted' && status !== 'stale') ||
                !isRecord(canonicalEntry) ||
                canonicalEntry.client_operation_id !== operationId ||
                typeof canonicalEntry.client_revision !== 'number' ||
                !Number.isSafeInteger(canonicalEntry.client_revision) ||
                canonicalEntry.client_revision < 1 ||
                canonicalEntry.client_revision > MAX_CLIENT_REVISION ||
                // `accepted` must acknowledge the exact revision that was
                // posted. A `stale` result can legitimately carry a newer
                // canonical revision from a direct-device upload, but never
                // an older one.
                (status === 'accepted' && canonicalEntry.client_revision !== clientRevision) ||
                (status === 'stale' && canonicalEntry.client_revision < clientRevision)
            ) {
                throw new Error('Diary relay returned an invalid canonical entry acknowledgement');
            }
            return canonicalEntry;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async forwardCancellation(relay: RelayCredentials, operationId: string): Promise<void> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            const response = await this.fetchImpl(relay.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-Thalassa-Pi-Relay-Id': relay.relayId,
                    'X-Thalassa-Pi-Relay-Token': relay.token,
                },
                body: JSON.stringify({ action: 'cancel', client_operation_id: operationId }),
                signal: controller.signal,
            });
            const text = await response.text();
            if (!response.ok) {
                // Never persist upstream response text: it may be hostile or
                // echo a credential, and public status never exposes tokens.
                if (isPermanentRelayStatus(response.status)) {
                    throw new DiaryRelayPermanentError(`Diary cancellation needs repair (HTTP ${response.status})`);
                }
                throw new Error(`Diary cancellation relay failed with HTTP ${response.status}`);
            }
            const parsed = parseObject(text);
            if (
                !parsed ||
                parsed.ok !== true ||
                parsed.cancelled !== true ||
                parsed.client_operation_id !== operationId
            ) {
                throw new Error('Diary cancellation relay returned an incomplete success response');
            }
        } finally {
            clearTimeout(timeout);
        }
    }
}
