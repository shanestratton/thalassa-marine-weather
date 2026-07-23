/**
 * Offline Queue Manager
 *
 * Handles queueing, syncing, and managing ship log entries
 * when the device has no network connectivity.
 *
 * Extracted from ShipLogService to isolate offline-first concerns.
 */

import { Preferences } from '@capacitor/preferences';
import { ShipLogEntry } from '../../types';
import { supabase, getCurrentUser } from '../supabase';
import { createLogger } from '../../utils/createLogger';
import { SHIP_LOGS_TABLE, toDbFormat } from './helpers';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';

const log = createLogger('OfflineQueue');

const OFFLINE_QUEUE_KEY = 'ship_log_offline_queue';
const OFFLINE_QUEUE_QUARANTINE_KEY = `${OFFLINE_QUEUE_KEY}_quarantine_v2`;
const OFFLINE_QUEUE_DEAD_LETTER_KEY = `${OFFLINE_QUEUE_KEY}_dead_letters`;
const ENTRY_TOMBSTONE_KEY = 'ship_log_deleted_entries';
const VOYAGE_ARCHIVE_INTENT_KEY = 'ship_log_voyage_archive_intents';
const OFFLINE_QUEUE_FORMAT_VERSION = 3;
const OFFLINE_QUEUE_SEGMENT_SIZE = 500;
// Reassert a confirmed command briefly because aborting fetch does not prove
// Postgres stopped the older request. Pending commands never expire.
const ARCHIVE_REASSERT_TTL_MS = 10 * 60 * 1000;
/**
 * 250,000 one-second fixes is almost three continuous days of raw native
 * capture (and months at the normal adaptive cadence). Reaching this guard
 * rejects the NEW point without touching any retained point. The old 50k
 * ring silently discarded the beginning of a voyage.
 */
export const OFFLINE_QUEUE_CAPACITY = 250_000;
const MAX_OFFLINE_QUEUE_SEGMENTS = Math.ceil(OFFLINE_QUEUE_CAPACITY / OFFLINE_QUEUE_SEGMENT_SIZE);

interface OwnedOfflineEntry extends Partial<ShipLogEntry> {
    queue_id: string;
    /** Immutable capture owner. Null belongs only to anonymous browse mode. */
    owner_user_id: string | null;
}

export interface OfflineQueueDeadLetter {
    queueId: string;
    entry: Partial<ShipLogEntry>;
    failedAt: string;
    errorCode?: string;
    errorMessage: string;
}

interface StoredOfflineQueueDeadLetter {
    queue_id: string;
    owner_user_id: string | null;
    entry: OwnedOfflineEntry;
    failed_at: string;
    error_code?: string;
    error_message: string;
}

interface VoyageTombstone {
    owner_user_id: string | null;
    deleted_at: number;
    /**
     * Set only after Supabase confirms the delete. Missing means the cloud
     * delete is still owed and must be retried on every queue sync.
     */
    cloud_deleted_at?: number;
    /** Durable outbox metadata for planned-route voyage-table cleanup. */
    planned_route_name?: string;
    planned_route_day?: string;
    /** Exact owner-scoped voyages.id; destructive cascades require this. */
    planned_voyage_id?: string;
    /** Diagnostic marker: route metadata existed but no exact safe link did. */
    cascade_link_unavailable_at?: number;
    draft_cascade_completed_at?: number;
    active_cascade_completed_at?: number;
}

type VoyageTombstones = Record<string, VoyageTombstone>;

interface EntryTombstone {
    owner_user_id: string | null;
    deleted_at: number;
    /** First confirmed delete; retries continue through the race-fence TTL. */
    cloud_deleted_at?: number;
}

type EntryTombstones = Record<string, EntryTombstone>;

interface VoyageArchiveIntent {
    owner_user_id: string | null;
    archived: boolean;
    request_id: string;
    requested_at: number;
    /** Present only after an owner-scoped update and verification converged. */
    cloud_applied_at?: number;
}

type VoyageArchiveIntents = Record<string, VoyageArchiveIntent>;

export interface VoyageArchiveIntentReceipt {
    voyageId: string;
    archived: boolean;
    requestId: string;
    requestedAt: number;
}

export interface VoyageArchiveIntentSnapshot {
    voyageId: string;
    archived: boolean;
    requestedAt: number;
}

/**
 * Deletion-ledger keys originate in imported voyage ids and queue operation
 * ids, so names such as "constructor" and "__proto__" are valid data. Keep
 * them in prototype-free dictionaries: inherited Object properties must
 * never masquerade as durable deletion records.
 */
function createDictionary<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

interface QueueManifest {
    version: typeof OFFLINE_QUEUE_FORMAT_VERSION;
    generation: string;
    segment_count: number;
    entry_count: number;
}

interface QueueState {
    scope: AuthIdentityScope;
    readonly queueKey: string;
    readonly tombstoneKey: string;
    readonly entryTombstoneKey: string;
    readonly archiveIntentKey: string;
    readonly deadLetterKey: string;
    queue: OwnedOfflineEntry[] | null;
    hydrating: Promise<OwnedOfflineEntry[]> | null;
    appendsSincePersist: number;
    persistTimer: ReturnType<typeof setTimeout> | null;
    persisting: Promise<void> | null;
    persistTail: Promise<void>;
    tombstones: VoyageTombstones | null;
    tombstoneHydrating: Promise<VoyageTombstones> | null;
    tombstoneTail: Promise<void>;
    entryTombstones: EntryTombstones | null;
    entryTombstoneHydrating: Promise<EntryTombstones> | null;
    entryTombstoneTail: Promise<void>;
    archiveIntents: VoyageArchiveIntents | null;
    archiveIntentHydrating: Promise<VoyageArchiveIntents> | null;
    archiveIntentTail: Promise<void>;
    /** Serializes scope-wide Supabase mutations (queue upload vs delete/recreate). */
    cloudMutationTail: Promise<void>;
    /** Serializes work for one voyage without blocking unrelated voyage ledgers. */
    voyageOperationTails: Map<string, Promise<void>>;
    /** Invalidates an append that began before a delete/recreation boundary. */
    voyageEpochs: Map<string, number>;
    /** Rejects stale capture callbacks arriving while a stable id is recreated. */
    activeVoyageRecreations: Map<string, number>;
    /** Archive state applied to queued/new same-session rows for this voyage. */
    voyageArchiveIntents: Map<string, boolean>;
    isSyncing: boolean;
    generation: string | null;
    segmentCount: number;
    persistedLength: number;
    dirtyFrom: number | null;
    forceFullRewrite: boolean;
    revision: number;
    lastPersistError: Error | null;
}

function newQueueId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `shipq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function deterministicLegacyQueueId(value: unknown, index: number): string {
    let serialized: string;
    try {
        serialized = JSON.stringify(value) ?? String(value);
    } catch {
        serialized = String(value);
    }
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let offset = 0; offset < serialized.length; offset++) {
        const code = serialized.charCodeAt(offset);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ (code + offset), 0x85ebca6b) >>> 0;
    }
    return `legacy_${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}_${index.toString(36)}`;
}

function segmentKey(queueKey: string, generation: string, index: number): string {
    return `${queueKey}:v${OFFLINE_QUEUE_FORMAT_VERSION}:${generation}:${index}`;
}

function isQueueManifest(value: unknown): value is QueueManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<QueueManifest>;
    return (
        candidate.version === OFFLINE_QUEUE_FORMAT_VERSION &&
        typeof candidate.generation === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(candidate.generation) &&
        Number.isInteger(candidate.segment_count) &&
        Number(candidate.segment_count) >= 0 &&
        Number(candidate.segment_count) <= MAX_OFFLINE_QUEUE_SEGMENTS &&
        Number.isInteger(candidate.entry_count) &&
        Number(candidate.entry_count) >= 0 &&
        Number(candidate.entry_count) <= OFFLINE_QUEUE_CAPACITY
    );
}

export class OfflineQueueCapacityError extends Error {
    constructor() {
        super(
            `Ship-log offline storage is full (${OFFLINE_QUEUE_CAPACITY.toLocaleString()} retained entries). ` +
                'Sync or export the voyage before recording more points.',
        );
        this.name = 'OfflineQueueCapacityError';
    }
}

/** Pure capacity fence exported so the no-loss behaviour can be regression tested cheaply. */
export function assertOfflineQueueCapacity(currentLength: number): void {
    if (currentLength >= OFFLINE_QUEUE_CAPACITY) throw new OfflineQueueCapacityError();
}

function asError(error: unknown, message: string): Error {
    if (error instanceof Error) return error;
    return new Error(message, { cause: error });
}

function explicitEntryOwner(value: unknown): { known: boolean; userId: string | null } {
    if (!value || typeof value !== 'object') return { known: false, userId: null };
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'owner_user_id')) {
        const owner = record.owner_user_id;
        return owner === null || typeof owner === 'string'
            ? { known: true, userId: typeof owner === 'string' ? owner.trim() || null : null }
            : { known: false, userId: null };
    }
    const legacyOwner = record.userId ?? record.user_id;
    return typeof legacyOwner === 'string' && legacyOwner.trim()
        ? { known: true, userId: legacyOwner.trim() }
        : { known: false, userId: null };
}

// ── IN-MEMORY WRITE-THROUGH CACHE (2026-07-03) ──────────────────────
// The queue used to be re-read + re-serialised from Preferences on EVERY
// point — twice per auto point (append + rolling-waypoint demote). At the
// real iOS fix rate (~1 Hz underway; the "5 s cadence" is Android-only)
// an 8-hour passage builds a ~17 MB queue, so each new point cost two
// full multi-MB JSON parse+stringify cycles: O(n²) churn that stalls the
// flush loop behind GPS ingest until the 1200-slot ring buffer silently
// drops the OLDEST unflushed fixes — genuine track loss in the final
// hours of a long passage (adversarial audit 2026-07-03, finding #0).
//
// Now the queue lives in memory and persists in immutable generations of
// bounded 500-row segments. Normal capture rewrites only the dirty tail;
// destructive changes write a new generation and switch one tiny manifest
// only after every segment succeeds. Every appended capture awaits that
// bounded segment + manifest write before reporting success, so there is no
// acknowledged 10-second/24-fix crash-loss tail. The debounce below is only
// for ancillary rolling-waypoint metadata demotion; the next capture or a
// lifecycle flush carries it durably.
const PERSIST_INTERVAL_MS = 10_000;
const PERSIST_EVERY_N = 25;

const queueStates = new Map<string, QueueState>();
let legacyMigrationTail: Promise<void> = Promise.resolve();

function getQueueState(scope: AuthIdentityScope = getAuthIdentityScope()): QueueState {
    const existing = queueStates.get(scope.key);
    if (existing) {
        existing.scope = scope;
        return existing;
    }
    const state: QueueState = {
        scope,
        queueKey: authScopedStorageKey(OFFLINE_QUEUE_KEY, scope),
        tombstoneKey: authScopedStorageKey(TOMBSTONE_KEY, scope),
        entryTombstoneKey: authScopedStorageKey(ENTRY_TOMBSTONE_KEY, scope),
        archiveIntentKey: authScopedStorageKey(VOYAGE_ARCHIVE_INTENT_KEY, scope),
        deadLetterKey: authScopedStorageKey(OFFLINE_QUEUE_DEAD_LETTER_KEY, scope),
        queue: null,
        hydrating: null,
        appendsSincePersist: 0,
        persistTimer: null,
        persisting: null,
        persistTail: Promise.resolve(),
        tombstones: null,
        tombstoneHydrating: null,
        tombstoneTail: Promise.resolve(),
        entryTombstones: null,
        entryTombstoneHydrating: null,
        entryTombstoneTail: Promise.resolve(),
        archiveIntents: null,
        archiveIntentHydrating: null,
        archiveIntentTail: Promise.resolve(),
        cloudMutationTail: Promise.resolve(),
        voyageOperationTails: new Map(),
        voyageEpochs: new Map(),
        activeVoyageRecreations: new Map(),
        voyageArchiveIntents: new Map(),
        isSyncing: false,
        generation: null,
        segmentCount: 0,
        persistedLength: 0,
        dirtyFrom: null,
        forceFullRewrite: false,
        revision: 0,
        lastPersistError: null,
    };
    queueStates.set(scope.key, state);
    return state;
}

async function quarantineLegacyValues(
    kind: 'queue' | 'tombstones' | 'entry_tombstones' | 'archive_intents',
    values: unknown[],
): Promise<void> {
    if (values.length === 0) return;
    let existing: unknown[] = [];
    const { value } = await Preferences.get({ key: OFFLINE_QUEUE_QUARANTINE_KEY });
    if (value) {
        try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed)) existing = parsed;
        } catch {
            existing = [{ unreadable_quarantine_payload: value }];
        }
    }
    await Preferences.set({
        key: OFFLINE_QUEUE_QUARANTINE_KEY,
        value: JSON.stringify([
            ...existing,
            {
                kind,
                reason: 'missing or ambiguous owner',
                quarantined_at: new Date().toISOString(),
                values,
            },
        ]),
    });
}

function withLegacyMigrationLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = legacyMigrationTail.then(operation, operation);
    legacyMigrationTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function withVoyageTombstoneLock<T>(state: QueueState, operation: () => Promise<T>): Promise<T> {
    const result = state.tombstoneTail.then(operation, operation);
    state.tombstoneTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function withEntryTombstoneLock<T>(state: QueueState, operation: () => Promise<T>): Promise<T> {
    const result = state.entryTombstoneTail.then(operation, operation);
    state.entryTombstoneTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function withArchiveIntentLock<T>(state: QueueState, operation: () => Promise<T>): Promise<T> {
    const result = state.archiveIntentTail.then(operation, operation);
    state.archiveIntentTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function withCloudMutationLock<T>(state: QueueState, operation: () => Promise<T>): Promise<T> {
    const result = state.cloudMutationTail.then(operation, operation);
    state.cloudMutationTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function withVoyageOperationLock<T>(state: QueueState, voyageId: string, operation: () => Promise<T>): Promise<T> {
    const previous = state.voyageOperationTails.get(voyageId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
        () => undefined,
        () => undefined,
    );
    state.voyageOperationTails.set(voyageId, tail);
    void tail.finally(() => {
        if (state.voyageOperationTails.get(voyageId) === tail) {
            state.voyageOperationTails.delete(voyageId);
        }
    });
    return result;
}

function normalizedVoyageId(entry: Partial<ShipLogEntry>): string {
    return entry.voyageId || 'default_voyage';
}

function archiveIntentTargetsEntry(
    voyageId: string,
    intent: VoyageArchiveIntent,
    entry: Partial<ShipLogEntry>,
): boolean {
    if (!entryBelongsToVoyage(entry, voyageId)) return false;
    if (voyageId !== 'default_voyage') return true;
    const entryTime = new Date(entry.timestamp || 0).getTime();
    // The default id is a sentinel for ungrouped history. An archive command
    // is a time boundary, not a permanent rule for every future ungrouped fix.
    return !Number.isFinite(entryTime) || entryTime <= intent.requested_at;
}

function archiveIntentSupersededByDeletion(state: QueueState, voyageId: string, intent: VoyageArchiveIntent): boolean {
    const deletion = state.tombstones?.[voyageId];
    return Boolean(deletion && deletion.deleted_at >= intent.requested_at);
}

function archiveIntentIsAuthoritative(intent: VoyageArchiveIntent): boolean {
    return intent.cloud_applied_at === undefined || intent.cloud_applied_at >= Date.now() - ARCHIVE_REASSERT_TTL_MS;
}

function desiredArchiveStateForEntry(state: QueueState, entry: Partial<ShipLogEntry>): boolean | undefined {
    const voyageId = normalizedVoyageId(entry);
    const durableIntent = state.archiveIntents?.[voyageId];
    if (durableIntent) {
        if (
            !archiveIntentIsAuthoritative(durableIntent) ||
            archiveIntentSupersededByDeletion(state, voyageId, durableIntent) ||
            !archiveIntentTargetsEntry(voyageId, durableIntent, entry)
        ) {
            return entry.archived;
        }
        return durableIntent.archived;
    }
    // Backward compatibility for pre-outbox queues whose consistent archived
    // rows were the only durable record of the same-session intent.
    return state.voyageArchiveIntents.get(voyageId) ?? entry.archived;
}

function voyageEpoch(state: QueueState, voyageId: string): number {
    return state.voyageEpochs.get(voyageId) ?? 0;
}

function bumpVoyageEpoch(state: QueueState, voyageId: string): void {
    state.voyageEpochs.set(voyageId, voyageEpoch(state, voyageId) + 1);
}

/**
 * The historical keys were global. Adopt only values carrying an explicit
 * owner matching this scope. Ambiguous values are retained in a non-replayable
 * quarantine; explicitly different owners stay for their own future scope.
 */
async function migrateLegacyStateForScope(scope: AuthIdentityScope): Promise<void> {
    await withLegacyMigrationLock(async () => {
        const { value: legacyQueueValue } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (legacyQueueValue) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(legacyQueueValue) as unknown;
            } catch {
                await quarantineLegacyValues('queue', [{ unreadable_legacy_payload: legacyQueueValue }]);
                await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
                parsed = [];
            }

            if (!Array.isArray(parsed)) {
                await quarantineLegacyValues('queue', [parsed]);
                await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
            } else {
                const adopting: OwnedOfflineEntry[] = [];
                const remaining: unknown[] = [];
                const ambiguous: unknown[] = [];
                for (const [index, value] of parsed.entries()) {
                    const owner = explicitEntryOwner(value);
                    if (!owner.known || !value || typeof value !== 'object') {
                        ambiguous.push(value);
                    } else if (owner.userId !== scope.userId) {
                        remaining.push(value);
                    } else {
                        const record = value as Partial<ShipLogEntry> & Partial<OwnedOfflineEntry>;
                        adopting.push({
                            ...record,
                            userId: scope.userId ?? undefined,
                            queue_id:
                                typeof record.queue_id === 'string' && record.queue_id
                                    ? record.queue_id
                                    : deterministicLegacyQueueId(value, index),
                            owner_user_id: scope.userId,
                        });
                    }
                }
                if (adopting.length > 0) {
                    const key = authScopedStorageKey(OFFLINE_QUEUE_KEY, scope);
                    let existing: OwnedOfflineEntry[] = [];
                    const { value } = await Preferences.get({ key });
                    if (value) {
                        try {
                            const candidate = JSON.parse(value) as unknown;
                            if (Array.isArray(candidate)) {
                                existing = candidate as OwnedOfflineEntry[];
                            } else if (isQueueManifest(candidate)) {
                                existing = (await readSegmentedQueue(candidate, key)).entries;
                            } else {
                                throw new Error('unsupported scoped queue format');
                            }
                        } catch (error) {
                            await quarantineLegacyValues('queue', [{ scoped_key: key, unreadable_payload: value }]);
                            throw asError(error, 'Existing scoped ship-log queue could not be merged safely');
                        }
                    }
                    const ids = new Set(existing.map((entry) => entry.queue_id));
                    const merged = [...existing, ...adopting.filter((entry) => !ids.has(entry.queue_id))];
                    if (merged.length > OFFLINE_QUEUE_CAPACITY) throw new OfflineQueueCapacityError();
                    await Preferences.set({
                        key,
                        // loadQueue atomically re-segments this one-time merge.
                        value: JSON.stringify(merged),
                    });
                }
                await quarantineLegacyValues('queue', ambiguous);
                if (remaining.length > 0) {
                    await Preferences.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(remaining) });
                } else {
                    await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
                }
            }
        }

        const { value: legacyTombstoneValue } = await Preferences.get({ key: TOMBSTONE_KEY });
        if (!legacyTombstoneValue) return;
        let parsedTombstones: unknown;
        try {
            parsedTombstones = JSON.parse(legacyTombstoneValue) as unknown;
        } catch {
            await quarantineLegacyValues('tombstones', [{ unreadable_legacy_payload: legacyTombstoneValue }]);
            await Preferences.remove({ key: TOMBSTONE_KEY });
            return;
        }
        if (!parsedTombstones || typeof parsedTombstones !== 'object' || Array.isArray(parsedTombstones)) {
            await quarantineLegacyValues('tombstones', [parsedTombstones]);
            await Preferences.remove({ key: TOMBSTONE_KEY });
            return;
        }

        const adopting = createDictionary<VoyageTombstone>();
        const remaining = createDictionary<unknown>();
        const ambiguous: unknown[] = [];
        for (const [voyageId, raw] of Object.entries(parsedTombstones as Record<string, unknown>)) {
            const owner = explicitEntryOwner(raw);
            const deletedAt =
                raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).deleted_at === 'number'
                    ? ((raw as Record<string, unknown>).deleted_at as number)
                    : null;
            if (!owner.known || deletedAt === null) {
                ambiguous.push({ voyageId, value: raw });
            } else if (owner.userId !== scope.userId) {
                remaining[voyageId] = raw;
            } else {
                adopting[voyageId] = { owner_user_id: scope.userId, deleted_at: deletedAt };
            }
        }
        if (Object.keys(adopting).length > 0) {
            const key = authScopedStorageKey(TOMBSTONE_KEY, scope);
            let existing = createDictionary<VoyageTombstone>();
            const { value } = await Preferences.get({ key });
            if (value) {
                try {
                    const candidate = JSON.parse(value) as unknown;
                    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
                        existing = Object.assign(createDictionary<VoyageTombstone>(), candidate as VoyageTombstones);
                    } else {
                        throw new Error('unsupported scoped tombstone format');
                    }
                } catch (error) {
                    await quarantineLegacyValues('tombstones', [{ scoped_key: key, unreadable_payload: value }]);
                    throw asError(error, 'Existing scoped voyage deletion ledger could not be merged safely');
                }
            }
            await Preferences.set({ key, value: JSON.stringify({ ...adopting, ...existing }) });
        }
        await quarantineLegacyValues('tombstones', ambiguous);
        if (Object.keys(remaining).length > 0) {
            await Preferences.set({ key: TOMBSTONE_KEY, value: JSON.stringify(remaining) });
        } else {
            await Preferences.remove({ key: TOMBSTONE_KEY });
        }
    });
}

function markQueueDirty(state: QueueState, fromIndex: number, forceFullRewrite = false): void {
    state.revision++;
    state.dirtyFrom = state.dirtyFrom === null ? Math.max(0, fromIndex) : Math.min(state.dirtyFrom, fromIndex);
    if (forceFullRewrite) state.forceFullRewrite = true;
}

function parseSegment(value: string, key: string): OwnedOfflineEntry[] {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > OFFLINE_QUEUE_SEGMENT_SIZE) {
        throw new Error(`Invalid ship-log queue segment: ${key}`);
    }
    return parsed as OwnedOfflineEntry[];
}

async function readSegmentedQueue(
    manifest: QueueManifest,
    queueKey: string,
): Promise<{
    entries: OwnedOfflineEntry[];
    segmentCount: number;
    recoveredOrphan: boolean;
}> {
    const entries: OwnedOfflineEntry[] = [];
    const segmentLengths: number[] = [];
    let segmentCount = manifest.segment_count;

    for (let index = 0; index < manifest.segment_count; index++) {
        const key = segmentKey(queueKey, manifest.generation, index);
        const { value } = await Preferences.get({ key });
        if (!value) throw new Error(`Missing ship-log queue segment: ${key}`);
        const segment = parseSegment(value, key);
        segmentLengths.push(segment.length);
        entries.push(...segment);
    }

    // A new segment is written before the tiny manifest is advanced. If the
    // app is killed between those writes, recover that fully-written orphan
    // instead of losing it. More than one is possible after repeated bridge
    // failures, so continue until the first gap.
    while (segmentCount < MAX_OFFLINE_QUEUE_SEGMENTS) {
        const key = segmentKey(queueKey, manifest.generation, segmentCount);
        const { value } = await Preferences.get({ key });
        if (!value) break;
        const segment = parseSegment(value, key);
        segmentLengths.push(segment.length);
        entries.push(...segment);
        segmentCount++;
    }

    for (let index = 0; index < segmentLengths.length - 1; index++) {
        if (segmentLengths[index] !== OFFLINE_QUEUE_SEGMENT_SIZE) {
            throw new Error(`Ship-log queue segment ${index} is truncated`);
        }
    }
    // A manifest can lag a successful tail write, so a larger actual count is
    // recoverable. A smaller count means retained history is missing and must
    // be surfaced rather than silently normalised away.
    if (entries.length < manifest.entry_count) {
        throw new Error(`Ship-log queue is truncated (${entries.length} of ${manifest.entry_count} entries remain)`);
    }
    if (entries.length > OFFLINE_QUEUE_CAPACITY) {
        throw new Error(`Ship-log queue exceeds its safe capacity (${entries.length} entries)`);
    }
    return {
        entries,
        segmentCount,
        recoveredOrphan: segmentCount !== manifest.segment_count,
    };
}

async function loadQueue(state: QueueState = getQueueState()): Promise<OwnedOfflineEntry[]> {
    if (state.queue) return state.queue;
    if (state.hydrating) return state.hydrating;
    state.hydrating = (async () => {
        try {
            await migrateLegacyStateForScope(state.scope);
            const { value } = await Preferences.get({ key: state.queueKey });
            const parsed = value ? (JSON.parse(value) as unknown) : [];
            let rawQueue: OwnedOfflineEntry[];
            let needsFullRewrite = false;

            if (Array.isArray(parsed)) {
                // Version 2 and older used one ever-growing JSON array. Load it
                // once, then atomically switch to segmented version 3.
                rawQueue = parsed as OwnedOfflineEntry[];
                needsFullRewrite = rawQueue.length > 0;
                state.generation = null;
                state.segmentCount = 0;
                state.persistedLength = 0;
            } else if (isQueueManifest(parsed)) {
                const loaded = await readSegmentedQueue(parsed, state.queueKey);
                rawQueue = loaded.entries;
                state.generation = parsed.generation;
                state.segmentCount = loaded.segmentCount;
                state.persistedLength = rawQueue.length;
                needsFullRewrite = loaded.recoveredOrphan || parsed.entry_count !== rawQueue.length;
            } else {
                throw new Error('Unsupported or corrupt ship-log offline queue manifest');
            }

            if (rawQueue.length > OFFLINE_QUEUE_CAPACITY) {
                throw new Error(`Ship-log queue exceeds its safe capacity (${rawQueue.length} entries)`);
            }

            const queue: OwnedOfflineEntry[] = [];
            const rejected: unknown[] = [];
            let normalized = false;
            for (const value of rawQueue) {
                if (!value || typeof value !== 'object') {
                    rejected.push(value);
                    continue;
                }
                const owner = explicitEntryOwner(value);
                if (owner.known && owner.userId !== state.scope.userId) {
                    rejected.push(value);
                    continue;
                }
                const record = value as Partial<ShipLogEntry> & Partial<OwnedOfflineEntry>;
                const entry: OwnedOfflineEntry = {
                    ...record,
                    userId: state.scope.userId ?? undefined,
                    queue_id: typeof record.queue_id === 'string' && record.queue_id ? record.queue_id : newQueueId(),
                    owner_user_id: state.scope.userId,
                };
                if (entry.queue_id !== record.queue_id || entry.owner_user_id !== record.owner_user_id) {
                    normalized = true;
                }
                queue.push(entry);
            }
            state.queue = queue;
            const inferredArchiveStates = new Map<string, boolean>();
            const conflictingArchiveStates = new Set<string>();
            for (const entry of queue) {
                if (typeof entry.archived !== 'boolean') continue;
                const voyageId = normalizedVoyageId(entry);
                const previous = inferredArchiveStates.get(voyageId);
                if (previous !== undefined && previous !== entry.archived) {
                    conflictingArchiveStates.add(voyageId);
                } else {
                    inferredArchiveStates.set(voyageId, entry.archived);
                }
            }
            for (const [voyageId, archived] of inferredArchiveStates) {
                if (!conflictingArchiveStates.has(voyageId)) {
                    state.voyageArchiveIntents.set(voyageId, archived);
                }
            }
            // A crash can occur after the tiny archive outbox is committed but
            // before the (potentially large) queue generation is rewritten.
            // Reconcile every retained row from the durable desired state
            // before it can be displayed or replayed.
            await Promise.all([loadVoyageArchiveIntents(state), loadTombstones(state)]);
            for (const entry of queue) {
                const desired = desiredArchiveStateForEntry(state, entry);
                if (desired === undefined || entry.archived === desired) continue;
                entry.archived = desired;
                normalized = true;
            }
            await quarantineLegacyValues('queue', rejected);
            if (needsFullRewrite || normalized || rejected.length > 0) {
                markQueueDirty(state, 0, true);
                await persistNow(state);
            }
            return queue;
        } catch (error) {
            // Never replace unreadable durable data with an empty in-memory
            // queue: a later append would overwrite the only surviving copy.
            state.queue = null;
            const failure = asError(error, 'Ship-log offline queue could not be loaded');
            log.error('offline queue hydrate failed — durable copy left untouched', failure);
            throw failure;
        } finally {
            state.hydrating = null;
        }
    })();
    return state.hydrating;
}

async function cleanupGeneration(queueKey: string, generation: string | null, segmentCount: number): Promise<void> {
    if (!generation) return;
    for (let index = 0; index < segmentCount; index++) {
        try {
            await Preferences.remove({ key: segmentKey(queueKey, generation, index) });
        } catch (error) {
            // The manifest no longer references this generation. Cleanup can
            // safely retry on a later maintenance pass without risking data.
            log.warn('offline queue old-segment cleanup failed', error);
        }
    }
}

async function persistQueueSnapshot(
    state: QueueState,
    snapshot: OwnedOfflineEntry[],
    dirtyFrom: number,
    fullRewrite: boolean,
): Promise<void> {
    if (snapshot.length > OFFLINE_QUEUE_CAPACITY) {
        throw new OfflineQueueCapacityError();
    }

    const previousGeneration = state.generation;
    const previousSegmentCount = state.segmentCount;
    const generation = fullRewrite || !previousGeneration ? newQueueId() : previousGeneration;
    const segmentCount = Math.ceil(snapshot.length / OFFLINE_QUEUE_SEGMENT_SIZE);
    const firstSegment = fullRewrite ? 0 : Math.floor(dirtyFrom / OFFLINE_QUEUE_SEGMENT_SIZE);

    if (snapshot.length === 0) {
        await Preferences.remove({ key: state.queueKey });
        state.generation = null;
        state.segmentCount = 0;
        state.persistedLength = 0;
        await cleanupGeneration(state.queueKey, previousGeneration, previousSegmentCount);
        return;
    }

    // Data first, manifest last. The manifest is the atomic generation
    // pointer; an interrupted full rewrite leaves the old generation live.
    for (let index = firstSegment; index < segmentCount; index++) {
        const start = index * OFFLINE_QUEUE_SEGMENT_SIZE;
        const segment = snapshot.slice(start, start + OFFLINE_QUEUE_SEGMENT_SIZE);
        await Preferences.set({
            key: segmentKey(state.queueKey, generation, index),
            value: JSON.stringify(segment),
        });
    }

    const manifest: QueueManifest = {
        version: OFFLINE_QUEUE_FORMAT_VERSION,
        generation,
        segment_count: segmentCount,
        entry_count: snapshot.length,
    };
    await Preferences.set({ key: state.queueKey, value: JSON.stringify(manifest) });

    state.generation = generation;
    state.segmentCount = segmentCount;
    state.persistedLength = snapshot.length;
    state.lastPersistError = null;

    if (fullRewrite && previousGeneration !== generation) {
        await cleanupGeneration(state.queueKey, previousGeneration, previousSegmentCount);
    } else if (previousGeneration === generation && previousSegmentCount > segmentCount) {
        for (let index = segmentCount; index < previousSegmentCount; index++) {
            await Preferences.remove({ key: segmentKey(state.queueKey, generation, index) });
        }
    }
}

async function persistNow(state: QueueState = getQueueState(), forceFullRewrite = false): Promise<void> {
    if (forceFullRewrite) state.forceFullRewrite = true;
    // A promise tail serialises the ENTIRE read-snapshot-write decision.
    // Merely awaiting the current write lets multiple waiters resume together
    // and race manifests; each caller instead owns one FIFO lock turn.
    const previous = state.persistTail;
    let release!: () => void;
    state.persistTail = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        if (!state.queue) return;
        if (state.persistTimer) {
            clearTimeout(state.persistTimer);
            state.persistTimer = null;
        }
        state.appendsSincePersist = 0;
        if (state.dirtyFrom === null && !state.forceFullRewrite) return;

        const snapshot = state.queue.slice();
        const snapshotRevision = state.revision;
        const dirtyFrom = state.dirtyFrom ?? 0;
        const rewrite =
            state.forceFullRewrite || !state.generation || snapshot.length < state.persistedLength || dirtyFrom === 0;

        const operation = persistQueueSnapshot(state, snapshot, dirtyFrom, rewrite);
        state.persisting = operation;
        try {
            await operation;
            if (state.revision === snapshotRevision) {
                state.dirtyFrom = null;
                state.forceFullRewrite = false;
            }
        } catch (error) {
            state.lastPersistError = asError(error, 'Ship-log offline queue could not be persisted');
            log.error('offline queue persist failed (retained in memory; durable copy left untouched)', error);
            throw state.lastPersistError;
        } finally {
            if (state.persisting === operation) state.persisting = null;
        }
    } finally {
        release();
    }
}

function schedulePersist(state: QueueState): void {
    state.appendsSincePersist++;
    if (state.appendsSincePersist >= PERSIST_EVERY_N) {
        void persistNow(state).catch(() => {
            /* error is retained on state and made explicit to the next writer */
        });
        return;
    }
    if (state.persistTimer) return;
    state.persistTimer = setTimeout(() => {
        state.persistTimer = null;
        void persistNow(state).catch(() => {
            /* error is retained on state and made explicit to the next writer */
        });
    }, PERSIST_INTERVAL_MS);
}

/** Awaited disk flush — for lifecycle hooks (app background, tracking stop). */
export async function flushOfflineQueueToDisk(): Promise<void> {
    const state = getQueueState();
    await loadQueue(state);
    await persistNow(state);
}

/**
 * TEST-ONLY: drop all module-level state (in-memory queue cache, tombstone
 * cache, debounce timer, capture/sync latches) so each test starts pristine.
 * Never call from product code — mid-voyage, memQueue IS the live queue and
 * dropping it outside tests loses unflushed points.
 */
export function __resetOfflineQueueForTests(): void {
    // Timer first — a leaked debounce firing after the reset would persist
    // a stale snapshot into the next test's store.
    for (const state of queueStates.values()) {
        if (state.persistTimer) clearTimeout(state.persistTimer);
    }
    queueStates.clear();
    legacyMigrationTail = Promise.resolve();
    captureLocalOnly = false;
}

// ── LOCAL-ONLY CAPTURE MODE ─────────────────────────────────────────
// While a voyage is actively recording, every captured point is written
// to the DEVICE only (this queue) — zero network on the capture path.
// The whole voyage uploads to Supabase in the background once tracking
// stops. State lives HERE (not EntrySave) because the queue is the
// thing being protected: syncOfflineQueue refuses to run while the
// queue is the live store for a recording voyage.
// EntrySave re-exports the accessors for its existing callers.
let captureLocalOnly = false;
let captureScopeKey: string | null = null;

export function setCaptureLocalOnly(enabled: boolean): void {
    captureLocalOnly = enabled;
    captureScopeKey = enabled ? getAuthIdentityScope().key : null;
}

export function isCaptureLocalOnly(): boolean {
    return captureLocalOnly && captureScopeKey === getAuthIdentityScope().key;
}

subscribeAuthIdentityScope((_next, previous) => {
    const previousState = queueStates.get(previous.key);
    if (previousState?.queue) {
        void persistNow(previousState).catch((error) => {
            log.error('offline queue identity-switch flush failed', error);
        });
    }
    // A recording session belongs to exactly one identity. Account B must
    // never inherit A's local-only capture latch.
    captureLocalOnly = false;
    captureScopeKey = null;
});

export interface QueueOfflineEntryOptions {
    /** Stable across an online timeout and every later replay. */
    operationId?: string;
    /** Identity captured before the caller began asynchronous work. */
    expectedScope?: AuthIdentityScope;
    /**
     * When this append is the new rolling "Latest Position", demote older
     * rolling positions in the same durable mutation.
     */
    demotePreviousLatestForVoyage?: string;
}

/**
 * Queue an entry for offline sync and return its stable operation id.
 *
 * The queue is segmented on disk, so an append rewrites at most one 500-row
 * segment rather than the whole voyage. At the hard safety ceiling the NEW
 * append rejects explicitly; no retained track point is ever evicted.
 */
export async function queueOfflineEntry(
    entry: Partial<ShipLogEntry>,
    options: QueueOfflineEntryOptions = {},
): Promise<string> {
    const scope = options.expectedScope ?? getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Account changed before ship-log entry could be queued');
    }
    const operationId = options.operationId ?? newQueueId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
        throw new Error('Invalid ship-log operation id');
    }
    const state = getQueueState(scope);
    const voyageId = normalizedVoyageId(entry);
    const invocationEpoch = voyageEpoch(state, voyageId);
    if ((state.activeVoyageRecreations.get(voyageId) ?? 0) > 0) {
        throw new Error(`Voyage ${voyageId} is being recreated; stale capture was not queued`);
    }

    return withVoyageOperationLock(state, voyageId, async () => {
        if (
            voyageEpoch(state, voyageId) !== invocationEpoch ||
            (state.activeVoyageRecreations.get(voyageId) ?? 0) > 0
        ) {
            throw new Error(`Voyage ${voyageId} changed before the capture could be queued`);
        }

        const deleted = await withVoyageTombstoneLock(state, async () => {
            const stones = await loadTombstones(state);
            return isTombstoned(stones, entry);
        });
        if (deleted) {
            throw new Error(`Voyage ${voyageId} has been deleted; capture was not queued`);
        }
        const entryDeleted = await withEntryTombstoneLock(state, async () => {
            const stones = await loadEntryTombstones(state);
            return stones[operationId] !== undefined;
        });
        if (entryDeleted) {
            throw new Error(`Ship-log operation ${operationId} has been deleted; capture was not queued`);
        }

        const queue = await loadQueue(state);
        if (
            !isAuthIdentityScopeCurrent(scope) ||
            voyageEpoch(state, voyageId) !== invocationEpoch ||
            (state.activeVoyageRecreations.get(voyageId) ?? 0) > 0
        ) {
            throw new Error('Account or voyage changed while ship-log queue was loading');
        }

        // Surface a prior bridge/storage failure to the next capture instead
        // of continuing to claim successful durable retention.
        if (state.lastPersistError) await persistNow(state);

        return withEntryTombstoneLock(state, async () => {
            // Recheck while holding the ledger through the durable append.
            // Entry deletion either wins first (and this rejects) or waits and
            // removes the just-persisted row; it can never slip into the gap.
            const commitStones = await loadEntryTombstones(state);
            if (commitStones[operationId] !== undefined) {
                throw new Error(`Ship-log operation ${operationId} has been deleted; capture was not queued`);
            }

            // A caller can retry after a bridge exception whose write actually
            // completed. Treat the operation id as the queue's primary key too.
            if (queue.some((queued) => queued.queue_id === operationId)) return operationId;
            assertOfflineQueueCapacity(queue.length);

            const appendIndex = queue.length;
            queue.push({
                ...entry,
                // The synchronous auth fence is authoritative. Never retain a
                // caller-supplied userId that could belong to a previous account.
                userId: scope.userId ?? undefined,
                archived: desiredArchiveStateForEntry(state, entry),
                queue_id: operationId,
                owner_user_id: scope.userId,
            });
            let firstChanged = appendIndex;
            const demoteVoyageId = options.demotePreviousLatestForVoyage;
            if (demoteVoyageId) {
                const latestIndices: number[] = [];
                for (let index = 0; index < queue.length; index++) {
                    const queued = queue[index];
                    if (
                        normalizedVoyageId(queued) === demoteVoyageId &&
                        queued.entryType === 'waypoint' &&
                        queued.waypointName === 'Latest Position'
                    ) {
                        latestIndices.push(index);
                    }
                }
                if (latestIndices.length > 1) {
                    let newest = latestIndices[0];
                    for (const index of latestIndices.slice(1)) {
                        const newestTime = new Date(queue[newest].timestamp || 0).getTime();
                        const candidateTime = new Date(queue[index].timestamp || 0).getTime();
                        // Arrival order breaks exact timestamp ties in favour of
                        // the newly appended fix, but an older delayed callback
                        // can never demote a genuinely newer rolling waypoint.
                        if (candidateTime >= newestTime) newest = index;
                    }
                    for (const index of latestIndices) {
                        if (index === newest) continue;
                        queue[index].entryType = 'auto';
                        queue[index].waypointName = undefined;
                        firstChanged = Math.min(firstChanged, index);
                    }
                }
            }
            markQueueDirty(state, Math.min(firstChanged, appendIndex));

            // Each successful capture is durable before it is acknowledged. The
            // segmented format bounds this to one at-most-500-row segment instead
            // of rewriting the full voyage, removing the former 10 s / 24-fix
            // crash-loss window.
            await persistNow(state);
            return operationId;
        });
    });
}

/**
 * Demote any queued 'Latest Position' auto-waypoints for a voyage back to
 * plain 'auto' entries — the in-queue twin of EntrySave's DB-side
 * demotePreviousAutoWaypoint, used while local-only capture is active
 * (during a recording voyage the previous rolling waypoint lives here,
 * not in Supabase).
 */
export async function demoteLatestPositionInQueue(voyageId: string): Promise<void> {
    if (!voyageId) return;
    const state = getQueueState();
    try {
        await withVoyageOperationLock(state, voyageId, async () => {
            const queue = await loadQueue(state);
            const matching: number[] = [];
            for (let index = 0; index < queue.length; index++) {
                const queued = queue[index];
                if (
                    normalizedVoyageId(queued) === voyageId &&
                    queued.entryType === 'waypoint' &&
                    queued.waypointName === 'Latest Position'
                ) {
                    matching.push(index);
                }
            }

            // This helper can resolve after the next capture has already been
            // appended. Preserve the newest rolling point and demote only its
            // predecessors; queueOfflineEntry performs the complementary
            // atomic demote+append when the new point itself is saved.
            if (matching.length <= 1) return;
            let newest = matching[0];
            for (const index of matching.slice(1)) {
                const newestTime = new Date(queue[newest].timestamp || 0).getTime();
                const candidateTime = new Date(queue[index].timestamp || 0).getTime();
                if (candidateTime >= newestTime) newest = index;
            }

            let firstChanged = queue.length;
            for (const index of matching) {
                if (index === newest) continue;
                queue[index].entryType = 'auto';
                queue[index].waypointName = undefined;
                firstChanged = Math.min(firstChanged, index);
            }
            markQueueDirty(state, firstChanged);
            schedulePersist(state);
        });
    } catch (e) {
        log.warn('demoteLatestPositionInQueue failed', e);
    }
}

/**
 * Normalise rolling waypoints within a batch before upload: per voyage,
 * only the NEWEST 'Latest Position' survives — older ones (left behind by
 * crashes or missed demotions) become plain 'auto' entries. Pure; exported
 * for tests.
 */
export function normalizeLatestPositions(queue: Partial<ShipLogEntry>[]): Partial<ShipLogEntry>[] {
    const newestPerVoyage = new Map<string, number>(); // voyageId → index in queue
    queue.forEach((e, i) => {
        if (e.entryType !== 'waypoint' || e.waypointName !== 'Latest Position') return;
        const vid = e.voyageId || 'default_voyage';
        const prev = newestPerVoyage.get(vid);
        const prevTs = prev !== undefined ? new Date(queue[prev].timestamp || 0).getTime() : -1;
        if (new Date(e.timestamp || 0).getTime() >= prevTs) newestPerVoyage.set(vid, i);
    });
    const keep = new Set(newestPerVoyage.values());
    return queue.map((e, i) => {
        if (e.entryType === 'waypoint' && e.waypointName === 'Latest Position' && !keep.has(i)) {
            return { ...e, entryType: 'auto' as const, waypointName: undefined };
        }
        return e;
    });
}

// ── Voyage tombstones ────────────────────────────────────────────────
// deleteVoyage races the stop-tracking upload: syncOfflineQueue snapshots
// the queue BEFORE the empty-voyage auto-prune deletes it, then faithfully
// re-uploads the deleted entries — the "tidied away" voyage resurrects
// from the cloud on the next load (Shane 2026-07-03: "if you click on
// 'got it', it does not delete"). The local tombstone is retained until an
// explicit transactional stable-id recreation: sync purges its rows before
// snapshotting, and re-deletes anything an in-flight snapshot uploaded. The
// TTL limits only repeated cloud traffic after confirmation.
const TOMBSTONE_KEY = 'ship_log_deleted_voyages';
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function loadTombstones(state: QueueState = getQueueState()): Promise<VoyageTombstones> {
    if (state.tombstones) return state.tombstones;
    if (state.tombstoneHydrating) return state.tombstoneHydrating;
    state.tombstoneHydrating = (async () => {
        try {
            await migrateLegacyStateForScope(state.scope);
            const { value } = await Preferences.get({ key: state.tombstoneKey });
            const parsed = value ? (JSON.parse(value) as unknown) : {};
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('tombstones are not an object');
            }
            const accepted = createDictionary<VoyageTombstone>();
            const rejected: unknown[] = [];
            let normalized = false;
            for (const [voyageId, raw] of Object.entries(parsed as Record<string, unknown>)) {
                // A numeric stone in an identity-scoped key comes from the
                // first scoped release. The key itself proves its owner.
                if (typeof raw === 'number' && Number.isFinite(raw)) {
                    accepted[voyageId] = {
                        owner_user_id: state.scope.userId,
                        deleted_at: raw,
                    };
                    normalized = true;
                    continue;
                }
                if (!raw || typeof raw !== 'object') {
                    rejected.push({ voyageId, value: raw });
                    continue;
                }
                const owner = explicitEntryOwner(raw);
                const deletedAt = (raw as Record<string, unknown>).deleted_at;
                if (
                    (owner.known && owner.userId !== state.scope.userId) ||
                    typeof deletedAt !== 'number' ||
                    !Number.isFinite(deletedAt)
                ) {
                    rejected.push({ voyageId, value: raw });
                    continue;
                }
                accepted[voyageId] = {
                    owner_user_id: state.scope.userId,
                    deleted_at: deletedAt,
                    cloud_deleted_at:
                        typeof (raw as Record<string, unknown>).cloud_deleted_at === 'number'
                            ? ((raw as Record<string, unknown>).cloud_deleted_at as number)
                            : undefined,
                    planned_route_name:
                        typeof (raw as Record<string, unknown>).planned_route_name === 'string'
                            ? ((raw as Record<string, unknown>).planned_route_name as string)
                            : undefined,
                    planned_route_day:
                        typeof (raw as Record<string, unknown>).planned_route_day === 'string'
                            ? ((raw as Record<string, unknown>).planned_route_day as string)
                            : undefined,
                    planned_voyage_id:
                        typeof (raw as Record<string, unknown>).planned_voyage_id === 'string' &&
                        /^[A-Za-z0-9_-]{1,128}$/.test((raw as Record<string, unknown>).planned_voyage_id as string)
                            ? ((raw as Record<string, unknown>).planned_voyage_id as string)
                            : undefined,
                    cascade_link_unavailable_at:
                        typeof (raw as Record<string, unknown>).cascade_link_unavailable_at === 'number'
                            ? ((raw as Record<string, unknown>).cascade_link_unavailable_at as number)
                            : undefined,
                    draft_cascade_completed_at:
                        typeof (raw as Record<string, unknown>).draft_cascade_completed_at === 'number'
                            ? ((raw as Record<string, unknown>).draft_cascade_completed_at as number)
                            : undefined,
                    active_cascade_completed_at:
                        typeof (raw as Record<string, unknown>).active_cascade_completed_at === 'number'
                            ? ((raw as Record<string, unknown>).active_cascade_completed_at as number)
                            : undefined,
                };
                if (!owner.known) normalized = true;
            }
            state.tombstones = accepted;
            await quarantineLegacyValues('tombstones', rejected);
            if (normalized || rejected.length > 0) {
                await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(accepted) });
            }
            // Durable local fences do not expire merely because time passed:
            // a crash may have left an old queue generation containing the
            // deleted voyage. The TTL below limits repeated cloud traffic;
            // explicit stable-id recreation removes the fence transactionally.
            return state.tombstones;
        } catch (error) {
            // A corrupt/read-failed delete ledger must block mutation. Treating
            // it as empty would resurrect voyages and erase owed cloud deletes.
            state.tombstones = null;
            throw asError(error, 'Voyage deletion ledger could not be loaded');
        } finally {
            state.tombstoneHydrating = null;
        }
    })();
    return state.tombstoneHydrating;
}

async function loadEntryTombstones(state: QueueState = getQueueState()): Promise<EntryTombstones> {
    if (state.entryTombstones) return state.entryTombstones;
    if (state.entryTombstoneHydrating) return state.entryTombstoneHydrating;
    state.entryTombstoneHydrating = (async () => {
        try {
            const { value } = await Preferences.get({ key: state.entryTombstoneKey });
            const parsed = value ? (JSON.parse(value) as unknown) : {};
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('entry tombstones are not an object');
            }

            const accepted = createDictionary<EntryTombstone>();
            const rejected: unknown[] = [];
            for (const [operationId, raw] of Object.entries(parsed as Record<string, unknown>)) {
                if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId) || !raw || typeof raw !== 'object') {
                    rejected.push({ operationId, value: raw });
                    continue;
                }
                const owner = explicitEntryOwner(raw);
                const record = raw as Record<string, unknown>;
                if (
                    (owner.known && owner.userId !== state.scope.userId) ||
                    typeof record.deleted_at !== 'number' ||
                    !Number.isFinite(record.deleted_at)
                ) {
                    rejected.push({ operationId, value: raw });
                    continue;
                }
                accepted[operationId] = {
                    owner_user_id: state.scope.userId,
                    deleted_at: record.deleted_at,
                    cloud_deleted_at:
                        typeof record.cloud_deleted_at === 'number' && Number.isFinite(record.cloud_deleted_at)
                            ? record.cloud_deleted_at
                            : undefined,
                };
            }
            state.entryTombstones = accepted;
            await quarantineLegacyValues('entry_tombstones', rejected);
            if (rejected.length > 0) {
                await Preferences.set({ key: state.entryTombstoneKey, value: JSON.stringify(accepted) });
            }

            return accepted;
        } catch (error) {
            state.entryTombstones = null;
            throw asError(error, 'Entry deletion ledger could not be loaded');
        } finally {
            state.entryTombstoneHydrating = null;
        }
    })();
    return state.entryTombstoneHydrating;
}

async function loadVoyageArchiveIntents(state: QueueState = getQueueState()): Promise<VoyageArchiveIntents> {
    if (state.archiveIntents) return state.archiveIntents;
    if (state.archiveIntentHydrating) return state.archiveIntentHydrating;
    state.archiveIntentHydrating = (async () => {
        try {
            const { value } = await Preferences.get({ key: state.archiveIntentKey });
            const parsed = value ? (JSON.parse(value) as unknown) : {};
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('voyage archive intents are not an object');
            }

            const accepted = createDictionary<VoyageArchiveIntent>();
            const rejected: unknown[] = [];
            let normalized = false;
            for (const [voyageId, raw] of Object.entries(parsed as Record<string, unknown>)) {
                if (!voyageId || !raw || typeof raw !== 'object') {
                    rejected.push({ voyageId, value: raw });
                    continue;
                }
                const owner = explicitEntryOwner(raw);
                const record = raw as Record<string, unknown>;
                if (
                    (owner.known && owner.userId !== state.scope.userId) ||
                    typeof record.archived !== 'boolean' ||
                    typeof record.request_id !== 'string' ||
                    !/^[A-Za-z0-9_-]{1,128}$/.test(record.request_id) ||
                    typeof record.requested_at !== 'number' ||
                    !Number.isFinite(record.requested_at)
                ) {
                    rejected.push({ voyageId, value: raw });
                    continue;
                }
                accepted[voyageId] = {
                    owner_user_id: state.scope.userId,
                    archived: record.archived,
                    request_id: record.request_id,
                    requested_at: record.requested_at,
                    cloud_applied_at:
                        typeof record.cloud_applied_at === 'number' && Number.isFinite(record.cloud_applied_at)
                            ? record.cloud_applied_at
                            : undefined,
                };
                state.voyageArchiveIntents.set(voyageId, record.archived);
                if (!owner.known) normalized = true;
            }
            state.archiveIntents = accepted;
            await quarantineLegacyValues('archive_intents', rejected);
            if (normalized || rejected.length > 0) {
                await Preferences.set({ key: state.archiveIntentKey, value: JSON.stringify(accepted) });
            }
            return accepted;
        } catch (error) {
            state.archiveIntents = null;
            throw asError(error, 'Voyage archive outbox could not be loaded');
        } finally {
            state.archiveIntentHydrating = null;
        }
    })();
    return state.archiveIntentHydrating;
}

async function addEntryTombstone(
    operationId: string,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('Invalid queued ship-log entry id');
    if (!isAuthIdentityScopeCurrent(expectedScope)) {
        throw new Error('Account changed before entry deletion could be queued');
    }
    const state = getQueueState(expectedScope);
    await withEntryTombstoneLock(state, async () => {
        const stones = await loadEntryTombstones(state);
        if (!isAuthIdentityScopeCurrent(expectedScope)) {
            throw new Error('Account changed while entry deletion was queued');
        }
        if (stones[operationId]) return;
        stones[operationId] = {
            owner_user_id: expectedScope.userId,
            deleted_at: Date.now(),
        };
        try {
            await Preferences.set({ key: state.entryTombstoneKey, value: JSON.stringify(stones) });
        } catch (error) {
            delete stones[operationId];
            throw asError(error, 'Entry deletion could not be queued durably');
        }
    });
}

/** Mark a voyage as deleted — sync will never (re-)upload its entries. */
export async function addVoyageTombstone(
    voyageId: string,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    if (!voyageId) return;
    const scope = expectedScope;
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed before voyage deletion could be queued');
    const state = getQueueState(scope);
    // Synchronous invalidation catches a capture that started before this
    // delete but has not yet reached its serialized queue mutation.
    bumpVoyageEpoch(state, voyageId);
    await withVoyageOperationLock(state, voyageId, async () => {
        await withVoyageTombstoneLock(state, async () => {
            const stones = await loadTombstones(state);
            if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while voyage deletion was queued');
            const previous = stones[voyageId];
            if (previous) return;
            stones[voyageId] = {
                owner_user_id: scope.userId,
                deleted_at: Date.now(),
            };
            try {
                await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
            } catch (error) {
                if (previous) stones[voyageId] = previous;
                else delete stones[voyageId];
                throw asError(error, 'Voyage deletion could not be queued durably');
            }
        });
    });
}

function isTombstoned(stones: VoyageTombstones, e: Partial<ShipLogEntry>): boolean {
    const vid = e.voyageId || 'default_voyage';
    const stone = stones[vid];
    if (!stone) return false;
    if (vid !== 'default_voyage') return true;

    // default_voyage is a sentinel for ungrouped rows, not an immutable
    // voyage id. Its stone is a time boundary: old rows stay deleted while
    // a genuinely new ungrouped capture remains possible.
    const entryTime = new Date(e.timestamp || 0).getTime();
    return !Number.isFinite(entryTime) || entryTime <= stone.deleted_at;
}

/** Apply the same durable deletion ledger to cloud-read rows as local rows. */
export async function filterVoyageTombstonedEntries<T extends Partial<ShipLogEntry>>(
    entries: T[],
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<T[]> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    const state = getQueueState(expectedScope);
    const stones = await loadTombstones(state);
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    return entries.filter((entry) => !isTombstoned(stones, entry));
}

/** Hide cloud rows whose immutable operation id has a durable entry delete. */
export async function filterEntryTombstonedRows<T extends { client_operation_id?: unknown }>(
    rows: T[],
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<T[]> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    const state = getQueueState(expectedScope);
    const stones = await loadEntryTombstones(state);
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    return rows.filter((row) => {
        const operationId = row.client_operation_id;
        return typeof operationId !== 'string' || stones[operationId] === undefined;
    });
}

/**
 * Project the latest durable archive command onto cloud reads immediately.
 * This keeps accepted offline/timeout mutations truthful while the outbox is
 * converging, including making pending unarchives visible again.
 */
export async function applyVoyageArchiveIntentOverlay<T extends Partial<ShipLogEntry>>(
    entries: T[],
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<T[]> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    const state = getQueueState(expectedScope);
    await Promise.all([loadVoyageArchiveIntents(state), loadTombstones(state)]);
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];

    return entries.map((entry) => {
        const voyageId = normalizedVoyageId(entry);
        const intent = state.archiveIntents?.[voyageId];
        if (
            !intent ||
            !archiveIntentIsAuthoritative(intent) ||
            archiveIntentSupersededByDeletion(state, voyageId, intent) ||
            !archiveIntentTargetsEntry(voyageId, intent, entry) ||
            entry.archived === intent.archived
        ) {
            return entry;
        }
        return { ...entry, archived: intent.archived };
    });
}

/** Active local commands that may intentionally contradict current cloud rows. */
export async function getVoyageArchiveIntentSnapshot(
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<VoyageArchiveIntentSnapshot[]> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    const state = getQueueState(expectedScope);
    await Promise.all([loadVoyageArchiveIntents(state), loadTombstones(state)]);
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    return Object.entries(state.archiveIntents ?? createDictionary<VoyageArchiveIntent>())
        .filter(
            ([voyageId, intent]) =>
                archiveIntentIsAuthoritative(intent) && !archiveIntentSupersededByDeletion(state, voyageId, intent),
        )
        .map(([voyageId, intent]) => ({
            voyageId,
            archived: intent.archived,
            requestedAt: intent.requested_at,
        }));
}

/** Mark the durable delete intent confirmed without removing its race fence. */
export async function markVoyageCloudDeletionComplete(
    voyageId: string,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    if (!voyageId) return;
    if (!isAuthIdentityScopeCurrent(expectedScope)) return;
    const state = getQueueState(expectedScope);
    await withVoyageOperationLock(state, voyageId, async () => {
        await withVoyageTombstoneLock(state, async () => {
            const stones = await loadTombstones(state);
            if (!isAuthIdentityScopeCurrent(expectedScope)) return;
            const stone = stones[voyageId];
            if (!stone) return;
            const previous = stone.cloud_deleted_at;
            stone.cloud_deleted_at ??= Date.now();
            try {
                await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
            } catch (error) {
                stone.cloud_deleted_at = previous;
                throw asError(error, 'Voyage deletion acknowledgement could not be persisted');
            }
        });
    });
}

/** Attach the planned-route cascade to the durable voyage deletion outbox. */
export async function recordVoyageDeletionCascadeMetadata(
    voyageId: string,
    routeName: string,
    day: string,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
    plannedVoyageId?: string,
): Promise<void> {
    const normalizedName = routeName.trim();
    const normalizedPlannedVoyageId = plannedVoyageId?.trim();
    const hasDiagnostics = Boolean(normalizedName && /^\d{4}-\d{2}-\d{2}$/.test(day));
    const hasExactLink = Boolean(normalizedPlannedVoyageId && /^[A-Za-z0-9_-]{1,128}$/.test(normalizedPlannedVoyageId));
    if (!voyageId || (!hasDiagnostics && !hasExactLink) || !isAuthIdentityScopeCurrent(expectedScope)) {
        return;
    }
    const state = getQueueState(expectedScope);
    await withVoyageOperationLock(state, voyageId, async () => {
        await withVoyageTombstoneLock(state, async () => {
            const stones = await loadTombstones(state);
            const stone = stones[voyageId];
            if (!stone || !isAuthIdentityScopeCurrent(expectedScope)) return;
            const previous = {
                planned_route_name: stone.planned_route_name,
                planned_route_day: stone.planned_route_day,
                planned_voyage_id: stone.planned_voyage_id,
                cascade_link_unavailable_at: stone.cascade_link_unavailable_at,
                draft_cascade_completed_at: stone.draft_cascade_completed_at,
                active_cascade_completed_at: stone.active_cascade_completed_at,
            };
            if (hasDiagnostics) {
                stone.planned_route_name = normalizedName;
                stone.planned_route_day = day;
            }
            if (hasExactLink && normalizedPlannedVoyageId && normalizedPlannedVoyageId !== stone.planned_voyage_id) {
                stone.planned_voyage_id = normalizedPlannedVoyageId;
                stone.cascade_link_unavailable_at = undefined;
                stone.draft_cascade_completed_at = undefined;
                stone.active_cascade_completed_at = undefined;
            } else if (hasDiagnostics && !stone.planned_voyage_id) {
                stone.cascade_link_unavailable_at ??= Date.now();
            }
            try {
                await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
            } catch (error) {
                Object.assign(stone, previous);
                throw asError(error, 'Planned-voyage deletion metadata could not be queued durably');
            }
        });
    });
}

type AuthenticatedQueueScope = AuthIdentityScope & { userId: string };

const CLOUD_DELETE_TIMEOUT_MS = 8000;
const CLOUD_UPLOAD_TIMEOUT_MS = 15_000;

async function boundedCloudRequest<T>(
    operation: (signal: AbortSignal) => PromiseLike<T>,
    timeoutMs: number,
): Promise<T | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            Promise.resolve(operation(controller.signal)).catch((error) => {
                if (controller.signal.aborted) return null;
                throw error;
            }),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve(null);
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function boundedCloudDelete(operation: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    return (await boundedCloudRequest(operation, CLOUD_DELETE_TIMEOUT_MS)) ?? false;
}

/**
 * Serialize a multi-step, identity-scoped ship-log transaction with queue
 * replay and every direct cloud mutation. The callback must bound its own
 * network requests; local durable writes deliberately remain inside the lock
 * until they settle so we never acknowledge an entry deletion prematurely.
 */
export async function runShipLogCloudTransaction<T>(
    expectedScope: AuthIdentityScope,
    operation: () => Promise<T>,
): Promise<T | null> {
    if (!expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope)) return null;
    const state = getQueueState(expectedScope);
    return withCloudMutationLock(state, async () => {
        if (!isAuthIdentityScopeCurrent(expectedScope)) return null;
        const result = await operation();
        return isAuthIdentityScopeCurrent(expectedScope) ? result : null;
    });
}

/**
 * Serialize a direct ship-log mutation with queue replay and voyage
 * delete/recreation. The request is aborted before the lock is released on
 * timeout, so a late online save cannot resurrect a just-deleted voyage.
 */
export async function runVoyageCloudMutation<T>(
    voyageId: string,
    expectedScope: AuthIdentityScope,
    timeoutMs: number,
    operation: (signal: AbortSignal) => PromiseLike<T>,
    entryTimestamp?: string,
): Promise<T | null> {
    if (!voyageId || !expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope)) return null;
    const state = getQueueState(expectedScope);
    const invocationEpoch = voyageEpoch(state, voyageId);
    if ((state.activeVoyageRecreations.get(voyageId) ?? 0) > 0) return null;

    return withVoyageOperationLock(state, voyageId, async () => {
        if (
            !isAuthIdentityScopeCurrent(expectedScope) ||
            voyageEpoch(state, voyageId) !== invocationEpoch ||
            (state.activeVoyageRecreations.get(voyageId) ?? 0) > 0
        ) {
            return null;
        }
        const deleted = await withVoyageTombstoneLock(state, async () => {
            const stones = await loadTombstones(state);
            return isTombstoned(stones, {
                voyageId: voyageId === 'default_voyage' ? undefined : voyageId,
                timestamp: entryTimestamp,
            });
        });
        if (deleted) return null;

        return withCloudMutationLock(state, async () => {
            if (!isAuthIdentityScopeCurrent(expectedScope)) return null;
            const response = await boundedCloudRequest(operation, timeoutMs);
            return isAuthIdentityScopeCurrent(expectedScope) ? response : null;
        });
    });
}

async function deleteVoyageFromCloud(
    scope: AuthenticatedQueueScope,
    voyageId: string,
    deletedAt?: number,
): Promise<boolean> {
    return boundedCloudDelete(async (signal) => {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
        let query = supabase.from(SHIP_LOGS_TABLE).delete().eq('user_id', scope.userId);
        if (voyageId === 'default_voyage') {
            query = query.or('voyage_id.is.null,voyage_id.eq.');
            if (deletedAt !== undefined) query = query.lte('timestamp', new Date(deletedAt).toISOString());
        } else {
            query = query.eq('voyage_id', voyageId);
        }
        const { error } = await query.abortSignal(signal);
        if (error || !isAuthIdentityScopeCurrent(scope)) return false;

        // PostgREST can return { error: null } for a zero-row RLS mutation.
        // Verify the desired state with a bounded owner-scoped read before
        // acknowledging the durable tombstone.
        let remaining = supabase.from(SHIP_LOGS_TABLE).select('id').eq('user_id', scope.userId);
        if (voyageId === 'default_voyage') {
            remaining = remaining.or('voyage_id.is.null,voyage_id.eq.');
            if (deletedAt !== undefined) remaining = remaining.lte('timestamp', new Date(deletedAt).toISOString());
        } else {
            remaining = remaining.eq('voyage_id', voyageId);
        }
        const { data, error: verifyError } = await remaining.abortSignal(signal).limit(1);
        return !verifyError && (data?.length ?? 0) === 0 && isAuthIdentityScopeCurrent(scope);
    });
}

async function deleteEntryFromCloud(scope: AuthenticatedQueueScope, operationId: string): Promise<boolean> {
    return boundedCloudDelete(async (signal) => {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
        const { error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .delete()
            .eq('user_id', scope.userId)
            .eq('client_operation_id', operationId)
            .abortSignal(signal);
        if (error || !isAuthIdentityScopeCurrent(scope)) return false;
        const { data, error: verifyError } = await supabase
            .from(SHIP_LOGS_TABLE)
            .select('id')
            .eq('user_id', scope.userId)
            .eq('client_operation_id', operationId)
            .abortSignal(signal)
            .limit(1);
        return !verifyError && (data?.length ?? 0) === 0 && isAuthIdentityScopeCurrent(scope);
    });
}

interface ExactVoyageCascadeOutcome {
    draft: boolean;
    active: boolean;
}

async function reconcileExactPlannedVoyage(
    scope: AuthenticatedQueueScope,
    plannedVoyageId: string,
): Promise<ExactVoyageCascadeOutcome> {
    const failed: ExactVoyageCascadeOutcome = { draft: false, active: false };
    return (
        (await boundedCloudRequest(async (signal) => {
            if (!supabase || !isAuthIdentityScopeCurrent(scope)) return failed;
            const { data: initialRows, error: readError } = await supabase
                .from('voyages')
                .select('id, user_id, status')
                .eq('id', plannedVoyageId)
                .eq('user_id', scope.userId)
                .abortSignal(signal)
                .limit(1);
            if (readError || !isAuthIdentityScopeCurrent(scope)) return failed;
            const initial = initialRows?.[0] as { id?: unknown; user_id?: unknown; status?: unknown } | undefined;
            if (!initial) return { draft: true, active: true };
            if (initial.id !== plannedVoyageId || initial.user_id !== scope.userId) return failed;

            if (initial.status === 'planning') {
                const { error } = await supabase
                    .from('voyages')
                    .delete()
                    .eq('id', plannedVoyageId)
                    .eq('user_id', scope.userId)
                    .eq('status', 'planning')
                    .abortSignal(signal);
                if (error || !isAuthIdentityScopeCurrent(scope)) return failed;
            } else if (initial.status === 'active') {
                const { error } = await supabase
                    .from('voyages')
                    .update({ status: 'aborted' })
                    .eq('id', plannedVoyageId)
                    .eq('user_id', scope.userId)
                    .eq('status', 'active')
                    .abortSignal(signal);
                if (error || !isAuthIdentityScopeCurrent(scope)) return failed;
            } else {
                return { draft: true, active: true };
            }

            const { data: finalRows, error: verifyError } = await supabase
                .from('voyages')
                .select('id, user_id, status')
                .eq('id', plannedVoyageId)
                .eq('user_id', scope.userId)
                .abortSignal(signal)
                .limit(1);
            if (verifyError || !isAuthIdentityScopeCurrent(scope)) return failed;
            const finalRow = finalRows?.[0] as { id?: unknown; user_id?: unknown; status?: unknown } | undefined;
            if (!finalRow) return { draft: true, active: true };
            if (finalRow.id !== plannedVoyageId || finalRow.user_id !== scope.userId) return failed;
            return {
                draft: finalRow.status !== 'planning',
                active: finalRow.status !== 'active',
            };
        }, CLOUD_DELETE_TIMEOUT_MS)) ?? failed
    );
}

async function retryVoyageDeletionCascadesLocked(
    state: QueueState,
    scope: AuthenticatedQueueScope,
    voyageId: string,
): Promise<void> {
    const metadata = await withVoyageTombstoneLock(state, async () => {
        const stone = (await loadTombstones(state))[voyageId];
        return stone
            ? {
                  plannedVoyageId: stone.planned_voyage_id,
                  draftDone: stone.draft_cascade_completed_at !== undefined,
                  activeDone: stone.active_cascade_completed_at !== undefined,
              }
            : null;
    });
    if (!metadata?.plannedVoyageId || (metadata.draftDone && metadata.activeDone)) return;

    const exactOutcome = await withCloudMutationLock(state, () =>
        reconcileExactPlannedVoyage(scope, metadata.plannedVoyageId as string),
    );
    const outcomes = {
        draft: metadata.draftDone || exactOutcome.draft,
        active: metadata.activeDone || exactOutcome.active,
    };

    await withVoyageTombstoneLock(state, async () => {
        const stones = await loadTombstones(state);
        const stone = stones[voyageId];
        if (!stone) return;
        const previousDraft = stone.draft_cascade_completed_at;
        const previousActive = stone.active_cascade_completed_at;
        if (outcomes.draft) stone.draft_cascade_completed_at ??= Date.now();
        if (outcomes.active) stone.active_cascade_completed_at ??= Date.now();
        if (
            stone.draft_cascade_completed_at === previousDraft &&
            stone.active_cascade_completed_at === previousActive
        ) {
            return;
        }
        try {
            await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
        } catch (error) {
            stone.draft_cascade_completed_at = previousDraft;
            stone.active_cascade_completed_at = previousActive;
            throw asError(error, 'Planned-voyage cascade outcome could not be persisted');
        }
    });
}

async function updateVoyageCloudOutcome(
    state: QueueState,
    scope: AuthenticatedQueueScope,
    voyageId: string,
    deleted: boolean,
): Promise<void> {
    await withVoyageTombstoneLock(state, async () => {
        const stones = await loadTombstones(state);
        const stone = stones[voyageId];
        if (!stone) return;
        const previous = stone.cloud_deleted_at;
        if (deleted) stone.cloud_deleted_at ??= Date.now();
        else stone.cloud_deleted_at = undefined;
        if (stone.cloud_deleted_at === previous) return;
        try {
            await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
        } catch (error) {
            stone.cloud_deleted_at = previous;
            throw asError(error, 'Voyage cloud-delete outcome could not be persisted');
        }
    });
}

async function attemptVoyageCloudDeletionLocked(
    state: QueueState,
    scope: AuthenticatedQueueScope,
    voyageId: string,
): Promise<boolean> {
    const stone = await withVoyageTombstoneLock(state, async () => {
        const stones = await loadTombstones(state);
        return stones[voyageId] ?? null;
    });
    if (!stone || !isAuthIdentityScopeCurrent(scope)) return false;

    const deleted = await withCloudMutationLock(state, () => deleteVoyageFromCloud(scope, voyageId, stone.deleted_at));
    await updateVoyageCloudOutcome(state, scope, voyageId, deleted);
    try {
        await retryVoyageDeletionCascadesLocked(state, scope, voyageId);
    } catch (error) {
        log.warn(`Voyage ${voyageId} planned-route cascade remains pending`, error);
    }
    return deleted;
}

/**
 * Attempt the durable voyage delete now. The per-voyage and cloud FIFOs make
 * this mutually exclusive with queue upload and stable-id recreation.
 */
export async function attemptVoyageCloudDeletion(
    voyageId: string,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    if (!voyageId || !expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope)) return false;
    const state = getQueueState(expectedScope);
    return withVoyageOperationLock(state, voyageId, () =>
        attemptVoyageCloudDeletionLocked(state, expectedScope as AuthenticatedQueueScope, voyageId),
    );
}

function entryBelongsToVoyage(entry: Partial<ShipLogEntry>, voyageId: string): boolean {
    return normalizedVoyageId(entry) === voyageId;
}

/**
 * Commit the desired archive state to a small durable outbox before touching
 * queued rows or the cloud. Queue reconciliation and cloud convergence may
 * then retry independently after a timeout, bridge failure, or process death.
 */
export async function setVoyageArchivedInOfflineQueue(
    voyageId: string,
    archived: boolean,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<VoyageArchiveIntentReceipt> {
    if (!voyageId || !isAuthIdentityScopeCurrent(expectedScope)) {
        throw new Error('Account changed before queued voyage archive state could be updated');
    }
    const state = getQueueState(expectedScope);
    return withVoyageOperationLock(state, voyageId, async () => {
        if (!isAuthIdentityScopeCurrent(expectedScope)) {
            throw new Error('Account changed while queued voyage archive state was updated');
        }
        const deletion = await withVoyageTombstoneLock(state, async () => {
            const stones = await loadTombstones(state);
            return stones[voyageId];
        });
        if (voyageId !== 'default_voyage' && deletion) {
            throw new Error(`Voyage ${voyageId} has been deleted and cannot be archived`);
        }

        const requestId = newQueueId();
        const requestedAt = Date.now();
        const receipt: VoyageArchiveIntentReceipt = { voyageId, archived, requestId, requestedAt };
        await withArchiveIntentLock(state, async () => {
            const intents = await loadVoyageArchiveIntents(state);
            if (!isAuthIdentityScopeCurrent(expectedScope)) {
                throw new Error('Account changed while voyage archive intent was being persisted');
            }
            const previous = intents[voyageId];
            const hadPreviousMapIntent = state.voyageArchiveIntents.has(voyageId);
            const previousMapIntent = state.voyageArchiveIntents.get(voyageId);
            intents[voyageId] = {
                owner_user_id: expectedScope.userId,
                archived,
                request_id: requestId,
                requested_at: requestedAt,
            };
            state.voyageArchiveIntents.set(voyageId, archived);
            try {
                await Preferences.set({ key: state.archiveIntentKey, value: JSON.stringify(intents) });
            } catch (error) {
                if (previous) intents[voyageId] = previous;
                else delete intents[voyageId];
                if (hadPreviousMapIntent) {
                    state.voyageArchiveIntents.set(voyageId, previousMapIntent as boolean);
                } else {
                    state.voyageArchiveIntents.delete(voyageId);
                }
                throw asError(error, 'Voyage archive intent could not be queued durably');
            }
        });

        try {
            const queue = await loadQueue(state);
            let firstChanged = -1;
            for (let index = 0; index < queue.length; index++) {
                const entry = queue[index];
                const intent = state.archiveIntents?.[voyageId];
                if (!intent || !archiveIntentTargetsEntry(voyageId, intent, entry) || entry.archived === archived) {
                    continue;
                }
                if (firstChanged < 0) firstChanged = index;
                entry.archived = archived;
            }
            if (firstChanged >= 0) {
                markQueueDirty(state, firstChanged, true);
                await persistNow(state, true);
            }
        } catch (error) {
            // The small outbox is already durable. Keep the accepted intent
            // and let the next hydrate/sync reconcile the larger queue rather
            // than lying that the command vanished.
            log.warn(`Voyage ${voyageId} queue archive reconciliation remains pending`, error);
        }
        return receipt;
    });
}

export async function isVoyageArchiveIntentCurrent(
    receipt: VoyageArchiveIntentReceipt,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return false;
    const state = getQueueState(expectedScope);
    return withArchiveIntentLock(state, async () => {
        const intent = (await loadVoyageArchiveIntents(state))[receipt.voyageId];
        return (
            Boolean(intent) &&
            intent.request_id === receipt.requestId &&
            intent.archived === receipt.archived &&
            intent.requested_at === receipt.requestedAt &&
            isAuthIdentityScopeCurrent(expectedScope)
        );
    });
}

/** Mark only the exact archive command that reached verified cloud state. */
export async function markVoyageArchiveIntentCloudApplied(
    receipt: VoyageArchiveIntentReceipt,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return false;
    const state = getQueueState(expectedScope);
    return withArchiveIntentLock(state, async () => {
        const intents = await loadVoyageArchiveIntents(state);
        const intent = intents[receipt.voyageId];
        if (
            !intent ||
            intent.request_id !== receipt.requestId ||
            intent.archived !== receipt.archived ||
            intent.requested_at !== receipt.requestedAt ||
            !isAuthIdentityScopeCurrent(expectedScope)
        ) {
            return false;
        }
        const previous = intent.cloud_applied_at;
        intent.cloud_applied_at ??= Date.now();
        if (intent.cloud_applied_at === previous) return true;
        try {
            await Preferences.set({ key: state.archiveIntentKey, value: JSON.stringify(intents) });
            return true;
        } catch (error) {
            intent.cloud_applied_at = previous;
            throw asError(error, 'Voyage archive acknowledgement could not be persisted');
        }
    });
}

async function clearVoyageArchiveIntent(
    state: QueueState,
    voyageId: string,
    expectedScope: AuthIdentityScope,
): Promise<void> {
    await withArchiveIntentLock(state, async () => {
        const intents = await loadVoyageArchiveIntents(state);
        const previous = intents[voyageId];
        if (!previous) {
            state.voyageArchiveIntents.delete(voyageId);
            return;
        }
        const previousMapIntent = state.voyageArchiveIntents.get(voyageId);
        delete intents[voyageId];
        state.voyageArchiveIntents.delete(voyageId);
        try {
            await Preferences.set({ key: state.archiveIntentKey, value: JSON.stringify(intents) });
        } catch (error) {
            intents[voyageId] = previous;
            if (previousMapIntent !== undefined) {
                state.voyageArchiveIntents.set(voyageId, previousMapIntent);
            }
            throw asError(error, 'Voyage archive intent could not be cleared');
        }
        if (!isAuthIdentityScopeCurrent(expectedScope)) {
            throw new Error('Account changed while prior voyage archive state was cleared');
        }
    });
}

function plannedVoyageDay(voyageId: string): string | null {
    const match = voyageId.match(/^planned_(\d+)_/);
    if (!match) return null;
    const timestamp = Number(match[1]);
    if (!Number.isFinite(timestamp)) return null;
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function inferPlannedRouteName(queue: OwnedOfflineEntry[], voyageId: string): string | null {
    const rows = queue
        .filter((entry) => entryBelongsToVoyage(entry, voyageId))
        .slice()
        .sort((left, right) => new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime());
    if (rows.length < 2) return null;
    const first = rows[0].waypointName?.trim();
    const last = rows[rows.length - 1].waypointName?.trim();
    return first && last ? `${first} → ${last}` : null;
}

function inferPlannedVoyageId(queue: OwnedOfflineEntry[], voyageId: string): string | null {
    const ids = new Set(
        queue
            .filter((entry) => entryBelongsToVoyage(entry, voyageId))
            .map((entry) => entry.linkedPlanId?.trim())
            .filter((value): value is string => Boolean(value && /^[A-Za-z0-9_-]{1,128}$/.test(value))),
    );
    return ids.size === 1 ? Array.from(ids)[0] : null;
}

async function purgeVoyageFromQueueLocked(state: QueueState, voyageId: string): Promise<boolean> {
    const queue = await loadQueue(state);
    const filtered = queue.filter((entry) => !entryBelongsToVoyage(entry, voyageId));
    if (filtered.length === queue.length) return false;
    queue.length = 0;
    queue.push(...filtered);
    markQueueDirty(state, 0, true);
    await persistNow(state, true);
    return true;
}

async function retainVoyageFenceAfterFailedRecreation(
    state: QueueState,
    scope: AuthenticatedQueueScope,
    voyageId: string,
    cloudDeleteConfirmed: boolean,
): Promise<void> {
    try {
        await updateVoyageCloudOutcome(state, scope, voyageId, cloudDeleteConfirmed);
    } catch (error) {
        // The original durable stone still exists on disk. A failed
        // acknowledgement write merely causes another idempotent retry.
        log.warn(`Voyage ${voyageId} recreation rollback acknowledgement remains pending`, error);
    }
}

/**
 * Reuse a stable voyage id without exposing a gap in its deletion fence.
 *
 * A prior queue upload is allowed to finish first, then any stale local/cloud
 * rows are swept. The tombstone remains durable through the entire import and
 * is removed only after all chunks succeed. Failure re-deletes partial rows
 * and leaves the fence in place for sync to retry.
 */
export async function recreateVoyageWithFence<T>(
    voyageId: string,
    expectedScope: AuthIdentityScope,
    recreate: () => Promise<T>,
): Promise<T> {
    if (
        !voyageId ||
        voyageId === 'default_voyage' ||
        !expectedScope.userId ||
        !isAuthIdentityScopeCurrent(expectedScope)
    ) {
        throw new Error('Account changed before voyage could be recreated');
    }
    const state = getQueueState(expectedScope);
    const activeCount = state.activeVoyageRecreations.get(voyageId) ?? 0;
    state.activeVoyageRecreations.set(voyageId, activeCount + 1);
    bumpVoyageEpoch(state, voyageId);

    try {
        return await withVoyageOperationLock(state, voyageId, async () => {
            if (!isAuthIdentityScopeCurrent(expectedScope)) {
                throw new Error('Account changed while voyage was being recreated');
            }
            const authenticatedScope = expectedScope as AuthenticatedQueueScope;
            const deletionFence = await withVoyageTombstoneLock(state, async () => {
                const stones = await loadTombstones(state);
                const existing = stones[voyageId];
                if (existing) return existing;
                const temporary: VoyageTombstone = {
                    owner_user_id: expectedScope.userId,
                    deleted_at: Date.now(),
                };
                stones[voyageId] = temporary;
                try {
                    await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
                } catch (error) {
                    delete stones[voyageId];
                    throw asError(error, 'Voyage import fence could not be queued durably');
                }
                return temporary;
            });
            // Stable-id recreation is a new logical voyage. A confirmed or
            // pending archive command for the deleted predecessor must never
            // repaint the replacement as archived.
            await clearVoyageArchiveIntent(state, voyageId, expectedScope);

            return withCloudMutationLock(state, async () => {
                if (!isAuthIdentityScopeCurrent(authenticatedScope)) {
                    throw new Error('Account changed while voyage was being recreated');
                }

                // This also removes durable rows left behind by a crash after
                // a delete fence write, and makes brand-new/random imports
                // transactional across chunks.
                await purgeVoyageFromQueueLocked(state, voyageId);
                if (!(await deleteVoyageFromCloud(authenticatedScope, voyageId, deletionFence.deleted_at))) {
                    await retainVoyageFenceAfterFailedRecreation(state, authenticatedScope, voyageId, false);
                    throw new Error('Could not safely prepare the voyage id for import');
                }

                let result: T;
                try {
                    result = await recreate();
                    if (!isAuthIdentityScopeCurrent(authenticatedScope)) {
                        throw new Error('Account changed during import');
                    }
                } catch (error) {
                    const rolledBack = await deleteVoyageFromCloud(
                        authenticatedScope,
                        voyageId,
                        deletionFence.deleted_at,
                    ).catch(() => false);
                    await retainVoyageFenceAfterFailedRecreation(state, authenticatedScope, voyageId, rolledBack);
                    throw error;
                }

                try {
                    await withVoyageTombstoneLock(state, async () => {
                        const stones = await loadTombstones(state);
                        const stone = stones[voyageId];
                        if (!stone) {
                            throw new Error('Voyage deletion fence disappeared during recreation');
                        }
                        delete stones[voyageId];
                        try {
                            await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
                        } catch (error) {
                            stones[voyageId] = stone;
                            throw asError(error, 'Voyage recreation could not commit its deletion-fence removal');
                        }
                    });
                } catch (error) {
                    const rolledBack = await deleteVoyageFromCloud(
                        authenticatedScope,
                        voyageId,
                        deletionFence.deleted_at,
                    ).catch(() => false);
                    await retainVoyageFenceAfterFailedRecreation(state, authenticatedScope, voyageId, rolledBack);
                    throw error;
                }
                return result;
            });
        });
    } finally {
        const remaining = (state.activeVoyageRecreations.get(voyageId) ?? 1) - 1;
        if (remaining > 0) state.activeVoyageRecreations.set(voyageId, remaining);
        else state.activeVoyageRecreations.delete(voyageId);
    }
}

async function retryPendingVoyageDeletions(state: QueueState, scope: AuthenticatedQueueScope): Promise<void> {
    const voyageIds = await withVoyageTombstoneLock(state, async () => {
        const stones = await loadTombstones(state);
        const cutoff = Date.now() - TOMBSTONE_TTL_MS;
        return Object.entries(stones)
            .filter(
                ([voyageId, stone]) =>
                    (state.activeVoyageRecreations.get(voyageId) ?? 0) === 0 &&
                    (stone.cloud_deleted_at === undefined ||
                        stone.cloud_deleted_at >= cutoff ||
                        (Boolean(stone.planned_voyage_id) &&
                            (stone.draft_cascade_completed_at === undefined ||
                                stone.active_cascade_completed_at === undefined))),
            )
            .map(([voyageId]) => voyageId);
    });

    for (const voyageId of voyageIds) {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        try {
            const deleted = await withVoyageOperationLock(state, voyageId, () =>
                attemptVoyageCloudDeletionLocked(state, scope, voyageId),
            );
            if (deleted) log.info(`syncOfflineQueue: refreshed cloud deletion fence for ${voyageId}`);
            else log.warn(`syncOfflineQueue: cloud deletion retry still pending for ${voyageId}`);
        } catch (error) {
            log.warn(`syncOfflineQueue: cloud deletion retry failed for ${voyageId}`, error);
        }
    }
}

async function updateVoyageArchiveInCloud(
    scope: AuthenticatedQueueScope,
    receipt: VoyageArchiveIntentReceipt,
): Promise<boolean> {
    const result = await boundedCloudRequest(async (signal) => {
        if (!supabase || !isAuthIdentityScopeCurrent(scope)) return false;
        let mutation = supabase
            .from(SHIP_LOGS_TABLE)
            .update({ archived: receipt.archived }, { count: 'exact' })
            .eq('user_id', scope.userId);
        mutation =
            receipt.voyageId === 'default_voyage'
                ? mutation
                      .or('voyage_id.is.null,voyage_id.eq.')
                      .lte('timestamp', new Date(receipt.requestedAt).toISOString())
                : mutation.eq('voyage_id', receipt.voyageId);
        const response = await mutation.abortSignal(signal);
        if (
            response.error ||
            typeof response.count !== 'number' ||
            response.count < 1 ||
            !isAuthIdentityScopeCurrent(scope)
        ) {
            return false;
        }

        let verification = supabase.from(SHIP_LOGS_TABLE).select('id').eq('user_id', scope.userId);
        verification =
            receipt.voyageId === 'default_voyage'
                ? verification
                      .or('voyage_id.is.null,voyage_id.eq.')
                      .lte('timestamp', new Date(receipt.requestedAt).toISOString())
                : verification.eq('voyage_id', receipt.voyageId);
        verification = receipt.archived
            ? verification.or('archived.is.null,archived.eq.false')
            : verification.eq('archived', true);
        const { data, error } = await verification.abortSignal(signal).limit(1);
        return !error && (data?.length ?? 0) === 0 && isAuthIdentityScopeCurrent(scope);
    }, CLOUD_DELETE_TIMEOUT_MS);
    return result === true;
}

async function retryPendingVoyageArchiveIntents(
    state: QueueState,
    scope: AuthenticatedQueueScope,
    includeConfirmed = true,
): Promise<void> {
    await loadTombstones(state);
    const cutoff = Date.now() - ARCHIVE_REASSERT_TTL_MS;
    const pending = await withArchiveIntentLock(state, async () =>
        Object.entries(await loadVoyageArchiveIntents(state))
            .filter(
                ([voyageId, intent]) =>
                    !archiveIntentSupersededByDeletion(state, voyageId, intent) &&
                    (intent.cloud_applied_at === undefined || (includeConfirmed && intent.cloud_applied_at >= cutoff)),
            )
            .map(
                ([voyageId, intent]): VoyageArchiveIntentReceipt => ({
                    voyageId,
                    archived: intent.archived,
                    requestId: intent.request_id,
                    requestedAt: intent.requested_at,
                }),
            ),
    );

    for (const receipt of pending) {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        try {
            const applied = await withVoyageOperationLock(state, receipt.voyageId, async () => {
                if (!(await isVoyageArchiveIntentCurrent(receipt, scope))) {
                    return true; // superseded commands need no cloud acknowledgement
                }
                const converged = await withCloudMutationLock(state, () => updateVoyageArchiveInCloud(scope, receipt));
                if (!converged) return false;
                await markVoyageArchiveIntentCloudApplied(receipt, scope);
                return true;
            });
            if (applied) {
                log.info(`syncOfflineQueue: applied voyage archive intent for ${receipt.voyageId}`);
            } else {
                log.warn(`syncOfflineQueue: voyage archive intent remains pending for ${receipt.voyageId}`);
            }
        } catch (error) {
            log.warn(`syncOfflineQueue: voyage archive retry failed for ${receipt.voyageId}`, error);
        }
    }
}

async function retryEntryDeletions(state: QueueState, scope: AuthenticatedQueueScope): Promise<void> {
    const operationIds = await withEntryTombstoneLock(state, async () => {
        const stones = await loadEntryTombstones(state);
        const cutoff = Date.now() - TOMBSTONE_TTL_MS;
        return Object.entries(stones)
            .filter(([, stone]) => stone.cloud_deleted_at === undefined || stone.cloud_deleted_at >= cutoff)
            .map(([operationId]) => operationId);
    });

    // Never hold the ledger lock while waiting for the cloud FIFO. UUID
    // deletion takes the FIFO first and then persists its operation tombstone;
    // the inverse order here used to deadlock those two valid workflows.
    for (const operationId of operationIds) {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        let deleted = false;
        try {
            deleted = await withCloudMutationLock(state, () => deleteEntryFromCloud(scope, operationId));
        } catch (error) {
            log.warn(`syncOfflineQueue: entry deletion retry failed for ${operationId}`, error);
        }

        try {
            await withEntryTombstoneLock(state, async () => {
                const stones = await loadEntryTombstones(state);
                const stone = stones[operationId];
                if (!stone) return;
                const previous = stone.cloud_deleted_at;
                if (deleted) stone.cloud_deleted_at ??= Date.now();
                else stone.cloud_deleted_at = undefined;
                if (stone.cloud_deleted_at === previous) return;
                try {
                    await Preferences.set({
                        key: state.entryTombstoneKey,
                        value: JSON.stringify(stones),
                    });
                } catch (error) {
                    stone.cloud_deleted_at = previous;
                    throw asError(error, 'Entry cloud-delete outcome could not be persisted');
                }
            });
        } catch (error) {
            log.warn(`syncOfflineQueue: entry deletion outcome could not be persisted for ${operationId}`, error);
            continue;
        }

        if (deleted) log.info(`syncOfflineQueue: refreshed entry deletion fence for ${operationId}`);
        else log.warn(`syncOfflineQueue: entry deletion retry still pending for ${operationId}`);
    }
}

interface QueueUploadError {
    message?: unknown;
    code?: unknown;
    status?: unknown;
}

function isBisectablePermanentUploadError(error: QueueUploadError): boolean {
    const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
    const status = typeof error.status === 'number' ? error.status : null;
    // Restrict dead-lettering to row/payload-specific failures. Unknown,
    // auth, policy, schema, rate, and server failures retain the full queue.
    return (
        status === 413 ||
        ['22001', '22003', '22007', '22008', '22P02', '23502', '23505', '23514', '23P01'].includes(code)
    );
}

function parseDeadLetters(value: string | null, state: QueueState): StoredOfflineQueueDeadLetter[] {
    if (!value) return [];
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Ship-log dead-letter store is not an array');
    return parsed.map((raw, index) => {
        if (!raw || typeof raw !== 'object') throw new Error(`Invalid ship-log dead letter at index ${index}`);
        const record = raw as Partial<StoredOfflineQueueDeadLetter>;
        if (
            typeof record.queue_id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(record.queue_id) ||
            record.owner_user_id !== state.scope.userId ||
            !record.entry ||
            typeof record.entry !== 'object' ||
            record.entry.queue_id !== record.queue_id ||
            typeof record.failed_at !== 'string' ||
            typeof record.error_message !== 'string'
        ) {
            throw new Error(`Invalid or foreign ship-log dead letter at index ${index}`);
        }
        return record as StoredOfflineQueueDeadLetter;
    });
}

async function deadLetterEntry(state: QueueState, entry: OwnedOfflineEntry, error: QueueUploadError): Promise<void> {
    const { value } = await Preferences.get({ key: state.deadLetterKey });
    const records = parseDeadLetters(value, state);
    if (records.some((record) => record.queue_id === entry.queue_id)) return;
    if (records.length >= OFFLINE_QUEUE_CAPACITY) {
        throw new Error('Ship-log dead-letter storage is full; poison row remains in the live queue');
    }
    records.push({
        queue_id: entry.queue_id,
        owner_user_id: state.scope.userId,
        entry: { ...entry },
        failed_at: new Date().toISOString(),
        error_code: typeof error.code === 'string' ? error.code.slice(0, 64) : undefined,
        error_message:
            typeof error.message === 'string' && error.message
                ? error.message.slice(0, 1000)
                : 'Permanent database validation failure',
    });
    await Preferences.set({ key: state.deadLetterKey, value: JSON.stringify(records) });
}

/** Durable, owner-scoped poison rows retained for diagnostics/export/recovery. */
export async function getOfflineQueueDeadLetters(
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<OfflineQueueDeadLetter[]> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    const state = getQueueState(expectedScope);
    const { value } = await Preferences.get({ key: state.deadLetterKey });
    const records = parseDeadLetters(value, state);
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    return records.map((record) => ({
        queueId: record.queue_id,
        entry: { ...record.entry },
        failedAt: record.failed_at,
        errorCode: record.error_code,
        errorMessage: record.error_message,
    }));
}

export async function getOfflineQueueDeadLetterCount(
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<number> {
    return (await getOfflineQueueDeadLetters(expectedScope)).length;
}

/** Insert batch size — matches the GPX importer's chunking. */
const SYNC_CHUNK_SIZE = 500;

/**
 * Sync offline queue to Supabase — the upload half of local-first capture.
 *
 * Maps each queued entry to DB format (snake_case) with the user_id
 * stamped, normalises duplicate rolling waypoints, and idempotently upserts
 * chunks by (user_id, client_operation_id).
 * Transient/unknown failures retain the unsynced remainder. Known permanent
 * row-validation failures are bisected to one operation, durably dead-lettered
 * for export/recovery, and do not block valid later fixes.
 *
 * CONCURRENCY: the queue is append-only between snapshot and rewrite, so
 * the uploaded snapshot is always a PREFIX of the live queue. After
 * uploading we RE-READ the queue and slice off only what was uploaded —
 * never wipe the whole key. Points a recording voyage appended while the
 * upload was in flight survive. The previous implementation's
 * unconditional `Preferences.remove()` destroyed them (start tracking
 * while the page-mount sync is uploading → first minutes of the new
 * track gone).
 *
 * NOTE: the original implementation inserted the raw camelCase objects
 * with no user_id — Postgres rejected every batch and the queue never
 * drained. If a long-queued backlog suddenly appears in your log after
 * this fix, that's it finally syncing.
 *
 * @returns Number of entries synced
 */
export async function syncOfflineQueue(): Promise<number> {
    if (!supabase) return 0;
    const database = supabase;
    const scope = getAuthIdentityScope();
    const state = getQueueState(scope);
    const ownerUserId = scope.userId;
    if (!ownerUserId) return 0;
    if (state.isSyncing) return 0; // another sync is already running
    // Mid-voyage the queue IS the live store — never upload (or rewrite)
    // it until the voyage stops and stopTracking flips this off.
    if (isCaptureLocalOnly()) return 0;

    state.isSyncing = true;
    try {
        // Purge tombstoned (deleted-voyage) entries from the live queue
        // BEFORE snapshotting — a voyage the user just binned must never
        // upload (see the tombstone header above).
        const stones = await loadTombstones(state);
        const entryStones = await loadEntryTombstones(state);
        const user = await getCurrentUser();
        if (!user || user.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            return 0; // signed out/switched — keep this owner's queue intact
        }
        const authenticatedScope = scope as AuthenticatedQueueScope;
        await retryPendingVoyageDeletions(state, authenticatedScope);
        await retryEntryDeletions(state, authenticatedScope);
        await retryPendingVoyageArchiveIntents(state, authenticatedScope);

        const live = await loadQueue(state);
        if (!isAuthIdentityScopeCurrent(scope)) return 0;
        if (Object.keys(stones).length > 0 || Object.keys(entryStones).length > 0) {
            const kept = live.filter((e) => !isTombstoned(stones, e) && entryStones[e.queue_id] === undefined);
            if (kept.length !== live.length) {
                log.warn(`syncOfflineQueue: purged ${live.length - kept.length} locally deleted entries`);
                live.length = 0;
                live.push(...kept);
                markQueueDirty(state, 0, true);
                await persistNow(state, true);
            }
        }
        // Snapshot the LIVE in-memory queue (hydrating from disk if this is a
        // fresh session). slice() pins the upload set; appends during the
        // upload land in memQueue and survive via commitProgress below.
        const queue = live.slice();
        if (queue.length === 0) return 0;

        const normalized = normalizeLatestPositions(queue) as OwnedOfflineEntry[];

        // Remove only confirmed-success operation ids. Concurrent appends and
        // in-memory demotions are therefore never mistaken for a synced prefix.
        const commitProgress = async (uploaded: OwnedOfflineEntry[]) => {
            const uploadedIds = new Set(uploaded.map((entry) => entry.queue_id));
            const current = await loadQueue(state);
            const remaining = current.filter(
                (entry) => !uploadedIds.has(entry.queue_id) || entry.owner_user_id !== scope.userId,
            );
            current.length = 0;
            current.push(...remaining);
            markQueueDirty(state, 0, true);
            await persistNow(state, true);
        };

        let synced = 0;
        const uploaded: OwnedOfflineEntry[] = [];
        const deadLettered: OwnedOfflineEntry[] = [];
        const uploadOutcome = await withCloudMutationLock(
            state,
            async (): Promise<'complete' | 'failed' | 'scope-changed'> => {
                const uploadChunk = async (
                    sourceChunk: OwnedOfflineEntry[],
                ): Promise<'complete' | 'failed' | 'scope-changed'> => {
                    if (!isAuthIdentityScopeCurrent(scope)) return 'scope-changed';
                    const chunk = sourceChunk.map((e) => {
                        const row = toDbFormat({ ...e, userId: ownerUserId });
                        delete row.id; // never ship synthetic/display ids — DB generates real ones
                        row.client_operation_id = e.queue_id;
                        return row;
                    });

                    const response = await boundedCloudRequest(
                        (signal) =>
                            database
                                .from(SHIP_LOGS_TABLE)
                                .upsert(chunk, {
                                    onConflict: 'user_id,client_operation_id',
                                    ignoreDuplicates: true,
                                })
                                .abortSignal(signal),
                        CLOUD_UPLOAD_TIMEOUT_MS,
                    );
                    if (!response) {
                        log.warn(
                            `syncOfflineQueue: upload timed out at operation ${sourceChunk[0]?.queue_id ?? 'unknown'} ` +
                                `after ${synced} synced — keeping ${sourceChunk.length} row(s) and remainder`,
                        );
                        return 'failed';
                    }
                    if (response.error) {
                        const uploadError: QueueUploadError = {
                            message: response.error.message,
                            code: response.error.code,
                            status: response.status,
                        };
                        if (!isBisectablePermanentUploadError(uploadError)) {
                            log.warn(
                                `syncOfflineQueue: transient/unknown upload failure at operation ` +
                                    `${sourceChunk[0]?.queue_id ?? 'unknown'} after ${synced} synced — ` +
                                    `keeping ${sourceChunk.length} row(s) and remainder`,
                                typeof uploadError.message === 'string' ? uploadError.message : uploadError,
                            );
                            return 'failed';
                        }

                        if (sourceChunk.length > 1) {
                            const midpoint = Math.ceil(sourceChunk.length / 2);
                            const first = await uploadChunk(sourceChunk.slice(0, midpoint));
                            if (first !== 'complete') return first;
                            return uploadChunk(sourceChunk.slice(midpoint));
                        }

                        const poison = sourceChunk[0];
                        await deadLetterEntry(state, poison, uploadError);
                        deadLettered.push(poison);
                        log.error(
                            `syncOfflineQueue: operation ${poison.queue_id} moved to durable dead-letter storage; ` +
                                `valid rows will continue syncing`,
                            typeof uploadError.message === 'string' ? uploadError.message : uploadError,
                        );
                        return 'complete';
                    }
                    synced += chunk.length;
                    uploaded.push(...sourceChunk);
                    return 'complete';
                };

                for (let i = 0; i < normalized.length; i += SYNC_CHUNK_SIZE) {
                    const outcome = await uploadChunk(normalized.slice(i, i + SYNC_CHUNK_SIZE));
                    if (outcome !== 'complete') {
                        const processed = [...uploaded, ...deadLettered];
                        if (processed.length > 0 && isAuthIdentityScopeCurrent(scope)) {
                            await commitProgress(processed);
                        }
                        return outcome;
                    }
                }
                // One atomic generation rewrite after the upload pass avoids
                // O(n²) storage churn on a large backlog. A crash before this
                // commit merely replays already-upserted operation ids.
                await commitProgress([...uploaded, ...deadLettered]);
                return 'complete';
            },
        );
        if (uploadOutcome !== 'complete') return synced;

        // An archive request made while the voyage existed only in the local
        // queue cannot affect a cloud row until that row uploads. Re-run the
        // durable intent now so the outbox can reach verified convergence.
        await retryPendingVoyageArchiveIntents(state, authenticatedScope, false);

        // A voyage deleted WHILE this upload was in flight (its tombstone
        // landed after our snapshot) may have just been re-inserted — issue
        // the cloud delete again so the bin sticks.
        const stonesAfter = await loadTombstones(state);
        const entryStonesAfter = await loadEntryTombstones(state);
        const resurrected = new Set(
            uploaded.filter((e) => isTombstoned(stonesAfter, e)).map((e) => e.voyageId || 'default_voyage'),
        );
        const resurrectedEntries = uploaded.filter((entry) => entryStonesAfter[entry.queue_id] !== undefined);
        if (resurrected.size > 0) {
            await retryPendingVoyageDeletions(state, authenticatedScope);
            log.warn(`syncOfflineQueue: re-applied ${resurrected.size} mid-flight voyage deletion(s)`);
        }
        if (resurrectedEntries.length > 0) {
            await retryEntryDeletions(state, authenticatedScope);
            log.warn(`syncOfflineQueue: re-applied ${resurrectedEntries.length} mid-flight entry deletion(s)`);
        }
        if (synced > 0) log.warn(`syncOfflineQueue: uploaded ${synced} entries`);
        return synced;
    } catch (error) {
        log.error('syncOfflineQueue failed', error);
        return 0;
    } finally {
        state.isSyncing = false;
    }
}

/**
 * Get count of offline queue entries.
 */
export async function getOfflineQueueCount(): Promise<number> {
    try {
        const state = getQueueState();
        const [queue, voyageStones, entryStones] = await Promise.all([
            loadQueue(state),
            loadTombstones(state),
            loadEntryTombstones(state),
        ]);
        return queue.filter((entry) => !isTombstoned(voyageStones, entry) && entryStones[entry.queue_id] === undefined)
            .length;
    } catch (e) {
        log.error('getOfflineQueueCount failed', e);
        throw e;
    }
}

/**
 * Get offline queued entries for display (when not connected to database).
 * Adds temporary IDs for rendering.
 */
export async function getOfflineEntries(): Promise<ShipLogEntry[]> {
    try {
        const state = getQueueState();
        const [queue, voyageStones, entryStones] = await Promise.all([
            loadQueue(state),
            loadTombstones(state),
            loadEntryTombstones(state),
        ]);

        // The display id encodes the immutable queue operation id. Index-based
        // offline_0 ids changed after every deletion and could never be mapped
        // back to the queued record.
        return queue
            .filter((entry) => !isTombstoned(voyageStones, entry) && entryStones[entry.queue_id] === undefined)
            .map(
                (entry) =>
                    ({
                        ...entry,
                        id: `offline_${entry.queue_id}`,
                    }) as ShipLogEntry,
            );
    } catch (error) {
        log.error('getOfflineEntries failed', error);
        throw error;
    }
}

/**
 * Delete entries from offline queue by voyage ID.
 */
export async function deleteVoyageFromOfflineQueue(voyageId: string): Promise<boolean> {
    const state = getQueueState();
    if (!voyageId) return false;
    bumpVoyageEpoch(state, voyageId);
    try {
        return await withVoyageOperationLock(state, voyageId, async () => {
            // Tombstone FIRST — even if nothing is queued locally, an
            // in-flight sync snapshot may still hold this voyage's entries.
            await withVoyageTombstoneLock(state, async () => {
                const stones = await loadTombstones(state);
                if (!isAuthIdentityScopeCurrent(state.scope)) {
                    throw new Error('Account changed while voyage deletion was queued');
                }
                const previous = stones[voyageId];
                const previousSnapshot = previous ? { ...previous } : null;
                const deletedAt = Date.now();
                if (previous) {
                    // Re-deleting default_voyage advances its time boundary so
                    // newer ungrouped rows are included. It also supersedes a
                    // later archive command and re-opens cloud convergence.
                    previous.deleted_at = Math.max(previous.deleted_at, deletedAt);
                    previous.cloud_deleted_at = undefined;
                } else {
                    stones[voyageId] = { owner_user_id: state.scope.userId, deleted_at: deletedAt };
                }
                try {
                    await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
                } catch (error) {
                    if (previousSnapshot) stones[voyageId] = previousSnapshot;
                    else delete stones[voyageId];
                    throw asError(error, 'Voyage deletion could not be queued durably');
                }
            });
            try {
                await clearVoyageArchiveIntent(state, voyageId, state.scope);
            } catch (error) {
                // The newer tombstone timestamp still supersedes the stale
                // intent in every read/append/retry path. Physical compaction
                // of the outbox can retry later.
                log.warn(`Voyage ${voyageId} archive intent cleanup remains pending`, error);
            }
            let queue: OwnedOfflineEntry[];
            try {
                queue = await loadQueue(state);
            } catch (error) {
                // The tombstone above is the durable acceptance boundary and
                // already hides/rejects this voyage. Queue repair can happen
                // later without making the delete appear to fail.
                log.warn(`Voyage ${voyageId} queue cleanup remains pending`, error);
                return true;
            }
            const routeDay = plannedVoyageDay(voyageId);
            const routeName = routeDay ? inferPlannedRouteName(queue, voyageId) : null;
            const plannedVoyageId = routeDay ? inferPlannedVoyageId(queue, voyageId) : null;
            if ((routeName && routeDay) || plannedVoyageId) {
                try {
                    await withVoyageTombstoneLock(state, async () => {
                        const stones = await loadTombstones(state);
                        const stone = stones[voyageId];
                        if (!stone) throw new Error('Voyage deletion fence disappeared before cascade metadata');
                        const previous = {
                            planned_route_name: stone.planned_route_name,
                            planned_route_day: stone.planned_route_day,
                            planned_voyage_id: stone.planned_voyage_id,
                            cascade_link_unavailable_at: stone.cascade_link_unavailable_at,
                            draft_cascade_completed_at: stone.draft_cascade_completed_at,
                            active_cascade_completed_at: stone.active_cascade_completed_at,
                        };
                        if (routeName && routeDay) {
                            stone.planned_route_name = routeName;
                            stone.planned_route_day = routeDay;
                        }
                        if (plannedVoyageId) {
                            stone.planned_voyage_id = plannedVoyageId;
                            stone.cascade_link_unavailable_at = undefined;
                        } else if (!stone.planned_voyage_id) {
                            stone.cascade_link_unavailable_at ??= Date.now();
                        }
                        try {
                            await Preferences.set({ key: state.tombstoneKey, value: JSON.stringify(stones) });
                        } catch (error) {
                            Object.assign(stone, previous);
                            throw asError(error, 'Planned-voyage deletion metadata could not be queued durably');
                        }
                    });
                } catch (error) {
                    log.warn(`Voyage ${voyageId} planned-route metadata remains pending`, error);
                }
            }
            try {
                await purgeVoyageFromQueueLocked(state, voyageId);
            } catch (error) {
                log.warn(`Voyage ${voyageId} queue cleanup remains pending`, error);
            }
            return true;
        });
    } catch (error) {
        log.error('deleteVoyageFromOfflineQueue failed', error);
        throw error;
    }
}

/**
 * Delete entry from offline queue by ID.
 */
export async function deleteEntryFromOfflineQueue(entryId: string): Promise<boolean> {
    const state = getQueueState();
    try {
        const encodedOperationId = entryId.startsWith('offline_') ? entryId.slice('offline_'.length) : null;
        if (encodedOperationId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(encodedOperationId)) return false;

        // When the display/database caller already supplies the immutable
        // operation id, commit its tiny tombstone before touching the much
        // larger queue. Even a corrupt queue or failed generation rewrite
        // cannot make an accepted delete reappear or replay.
        if (encodedOperationId) {
            await addEntryTombstone(encodedOperationId, state.scope);
        }

        let queue: OwnedOfflineEntry[];
        try {
            queue = await loadQueue(state);
        } catch (error) {
            if (encodedOperationId) {
                log.warn(`Entry ${encodedOperationId} queue cleanup remains pending`, error);
                return true;
            }
            throw error;
        }
        const matched = queue.find(
            (entry) => entry.id === entryId || entry.queue_id === entryId || `offline_${entry.queue_id}` === entryId,
        );
        const operationId = matched?.queue_id ?? encodedOperationId;
        if (!operationId || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) return false;

        // Tombstone before removal: an in-flight sync may already hold this
        // operation in its upload snapshot. The durable ledger re-deletes any
        // late commit and prevents the local row from being replayed.
        if (!encodedOperationId) {
            await addEntryTombstone(operationId, state.scope);
        }

        // The queue can drain between rendering and the delayed delete action.
        // A valid encoded id still creates the durable cloud-delete fence.
        if (!matched) return encodedOperationId !== null;
        const filtered = queue.filter((entry) => entry.queue_id !== operationId);

        queue.length = 0;
        queue.push(...filtered);
        markQueueDirty(state, 0, true);
        try {
            await persistNow(state, true); // destructive op — hit disk immediately
        } catch (error) {
            // The durable tombstone is authoritative and filters both reads
            // and replay. Queue compaction can safely retry without changing
            // the accepted user-visible outcome.
            log.warn(`Entry ${operationId} queue cleanup remains pending`, error);
        }
        return true;
    } catch (error) {
        log.error('deleteEntryFromOfflineQueue failed', error);
        throw error;
    }
}
