/**
 * Sightings ⇄ the server (public.sightings, migration 20261005150000).
 *
 * The outbox drains one record at a time, oldest first:
 *   insert: upload the photos, then insert the row (a duplicate, 23505,
 *           means an earlier try landed: carry on and update it);
 *   update: upload any new photos, then PATCH the mutable columns only
 *           (where, when and the context never change after the insert);
 *           a row the server no longer has is inserted again;
 *   delete: remove the photos from storage, then the row.
 * A failed photo never blocks the sighting: its path is added later.
 *
 * Quiet before the migration push: PGRST205 / 42P01 / PGRST202 / 42883
 * (isNotPushedYet) hold everything on the phone, log at info only (a no-op
 * in production) and are re-tried after ten minutes. Logging still works.
 *
 * Refusals:
 *   - 42501 / 23503 with a boat: no longer crew on that boat (or the skipper
 *     is gone). The sighting is kept as this account's own, with no boat, and
 *     a Crew one becomes Private.
 *   - P0001 (the server's rate caps): held for an hour.
 *   - 55000 (account being deleted): held.
 *   - 23514 / 22023 / 22007 / 22P02 / 23502: refused for good; kept on the
 *     phone as 'failed' with the reason.
 *   - anything else (offline, a timeout): tried again later.
 *
 * Every step checks the auth identity fence: a record is only ever sent by
 * the account that logged it, under a real session for that account.
 */
import { supabase } from '../supabase';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { isNotPushedYet } from '../crew/floatPlanPeople';
import { clearSightingsOutboxFlag } from './outboxFlag';
import { createLogger } from '../../utils/createLogger';
import {
    deleteLocalSighting,
    getLocalSighting,
    getSightingMeta,
    listLocalSightings,
    loadPhotoBlob,
    putLocalSighting,
    putSightingMeta,
} from './sightingStore';
import {
    SIGHTING_LIMITS,
    SIGHTING_MUTABLE_COLUMNS,
    type LocalSighting,
    type PublicSighting,
    type ServerSightingRow,
    type SightingRow,
} from './types';

const log = createLogger('Sightings');

export const SIGHTINGS_TABLE = 'sightings';
export const SIGHTING_PHOTO_BUCKET = 'sighting-photos';
const NOT_PUSHED_RECHECK_MS = 10 * 60_000;
const RATE_LIMIT_HOLD_MS = 60 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const DRAIN_INTERVAL_MS = 60_000;
const CREW_FEED_DAYS = 30;
const CREW_FEED_LIMIT = 200;
const PULL_LIMIT = 1000;
const BOAT_SPECIES_LIMIT = 2000;

/** Every column the phone reads back. */
export const SIGHTING_SELECT = [
    'id',
    'observer_id',
    'vessel_owner_id',
    'boat_id',
    'voyage_id',
    'visibility',
    'taxon_group',
    'scientific_name',
    'vernacular_name',
    'taxon_rank',
    'individual_count',
    'count_is_estimate',
    'has_calf',
    'behavior',
    'observed_distance_m',
    'event_date',
    'created_at',
    'updated_at',
    'decimal_latitude',
    'decimal_longitude',
    'position_accuracy_m',
    'coordinate_uncertainty_in_meters',
    'position_source',
    'position_fix_at',
    'sampling_protocol',
    'sea_temp_c',
    'sea_temp_source',
    'water_depth_m',
    'depth_reference',
    'wind_speed_kts',
    'wind_dir_deg',
    'wind_source',
    'wave_height_m',
    'wx_model',
    'sog_kts',
    'cog_deg',
    'heading_deg',
    'occurrence_remarks',
    'photo_paths',
    'observer_display',
    'credit_public',
    'basis_of_record',
    'client_version',
].join(',');

// ── session state ───────────────────────────────────────────────────────────

let notPushedUntil = 0;
let draining: Promise<DrainResult> | null = null;
let inFlightId: string | null = null;

/** True while this session knows the server has no sightings table yet. */
export function sightingsServerUnavailable(now = Date.now()): boolean {
    return now < notPushedUntil;
}

/** The record the outbox is sending right now (the service turns a delete of it into a tombstone). */
export function isSightingInFlight(id: string): boolean {
    return inFlightId === id;
}

/** Test seam. */
export function resetSightingSyncState(): void {
    notPushedUntil = 0;
    draining = null;
    inFlightId = null;
}

function markNotPushed(what: string): void {
    if (!sightingsServerUnavailable()) log.info(`Sightings are not on the server yet (${what}); kept on this phone`);
    notPushedUntil = Date.now() + NOT_PUSHED_RECHECK_MS;
}

// ── errors ──────────────────────────────────────────────────────────────────

interface DbError {
    code?: string;
    message?: string;
}

export type ErrorKind =
    | 'not-pushed'
    | 'exists'
    | 'forbidden'
    | 'rate-limited'
    | 'tombstoned'
    | 'rejected'
    | 'auth'
    | 'retry';

export function classifyError(error: unknown): ErrorKind {
    if (isNotPushedYet(error)) return 'not-pushed';
    const code = typeof error === 'object' && error !== null ? (error as DbError).code : undefined;
    switch (code) {
        case '23505':
            return 'exists';
        case '42501':
        case '23503':
            return 'forbidden';
        case 'P0001':
            return 'rate-limited';
        case '55000':
            return 'tombstoned';
        case '23514':
        case '22023':
        case '22007':
        case '22008':
        case '22P02':
        case '23502':
        case '22003':
            return 'rejected';
        case 'PGRST301':
        case 'PGRST302':
            return 'auth';
        default:
            return 'retry';
    }
}

function errorText(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        const e = error as DbError;
        return [e.code, e.message].filter(Boolean).join(' ').slice(0, 200) || 'unknown error';
    }
    return String(error).slice(0, 200);
}

// ── payloads ────────────────────────────────────────────────────────────────

/** Storage path of a photo slot: <observer>/<sighting>/<slot>.jpg (the bucket policy's shape). */
export function photoPath(observerId: string, sightingId: string, slot: number): string {
    return `${observerId}/${sightingId}/${slot}.jpg`;
}

function uploadedPaths(record: LocalSighting): string[] {
    return record.photos
        .filter((p) => p.path)
        .sort((a, b) => a.slot - b.slot)
        .map((p) => p.path as string);
}

export type SendCheck = { ok: true } | { ok: false; reason: 'needs-position' | 'too-old' | 'signed-out' };

/** Can this row be sent as it stands? */
export function checkSendable(row: SightingRow, now = Date.now()): SendCheck {
    if (!row.observer_id) return { ok: false, reason: 'signed-out' };
    if (row.decimal_latitude === null || row.decimal_longitude === null || !row.position_source) {
        return { ok: false, reason: 'needs-position' };
    }
    const event = Date.parse(row.event_date);
    // A minute inside the server's 60-day window, for the trip there.
    if (!Number.isFinite(event) || now - event > SIGHTING_LIMITS.maxAgeMs - 60_000) {
        return { ok: false, reason: 'too-old' };
    }
    return { ok: true };
}

/** The INSERT body: the stored row with the uploaded photo paths. */
export function insertPayload(record: LocalSighting): Record<string, unknown> {
    return { ...record.row, photo_paths: uploadedPaths(record) };
}

/** The PATCH body: the mutable columns only (the migration's GRANT UPDATE list). */
export function updatePayload(record: LocalSighting): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const column of SIGHTING_MUTABLE_COLUMNS) {
        out[column] = column === 'photo_paths' ? uploadedPaths(record) : record.row[column];
    }
    return out;
}

/** No longer crew on that boat (or its skipper is gone): keep it as your own, Crew becomes Private. */
export function detachFromBoat(row: SightingRow): SightingRow {
    return {
        ...row,
        vessel_owner_id: null,
        boat_id: null,
        visibility: row.visibility === 'crew' ? 'private' : row.visibility,
    };
}

// ── the outbox ──────────────────────────────────────────────────────────────

export interface DrainResult {
    sent: number;
    remaining: number;
    stopped: null | 'signed-out' | 'not-pushed' | 'scope-changed' | 'auth' | 'offline';
}

function isDue(record: LocalSighting, now: number): boolean {
    if (!record.sync.op) return false;
    if (record.sync.state === 'needs-position' || record.sync.state === 'failed') return false;
    if (record.sync.nextAttemptAt && record.sync.nextAttemptAt > now) return false;
    return true;
}

function backoff(attempts: number): number {
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Write a step's outcome onto the CURRENT record: if the punter edited it
 * while it was in flight, their edit wins and is sent next time.
 */
async function commit(
    started: LocalSighting,
    userId: string,
    apply: (fresh: LocalSighting, untouched: boolean) => LocalSighting | 'remove',
): Promise<void> {
    const fresh = await getLocalSighting(started.id, userId);
    if (!fresh) return;
    const untouched = fresh.updatedAtLocal === started.updatedAtLocal;
    const next = apply(fresh, untouched);
    if (next === 'remove') {
        await deleteLocalSighting(fresh);
        return;
    }
    if (!untouched && next.sync.op !== 'delete' && fresh.sync.op !== null) {
        // Edited in flight: whatever the server took, the edit still has to go.
        next.sync = {
            ...next.sync,
            state: fresh.sync.state === 'needs-position' ? 'needs-position' : 'pending',
            op: fresh.sync.op === 'delete' ? 'delete' : next.sync.serverKnown ? 'update' : 'insert',
        };
    }
    await putLocalSighting(next);
}

/** Learn the uploaded paths on the fresh copy, by slot and blob. */
function withPaths(fresh: LocalSighting, sent: LocalSighting): LocalSighting {
    return {
        ...fresh,
        photos: fresh.photos.map((p) => {
            const done = sent.photos.find((s) => s.slot === p.slot && s.blobKey === p.blobKey && s.path);
            return done && !p.path ? { ...p, path: done.path } : p;
        }),
    };
}

type StepResult = 'sent' | 'skipped' | 'stop-not-pushed' | 'stop-auth' | 'stop-offline';

async function uploadPhotos(record: LocalSighting, userId: string): Promise<'ok' | 'not-pushed' | 'offline'> {
    if (!supabase) return 'offline';
    for (const photo of record.photos) {
        if (photo.path || !photo.blobKey) continue;
        const blob = await loadPhotoBlob(photo.blobKey);
        if (!blob) continue; // lost locally: the sighting goes without it
        const path = photoPath(userId, record.id, photo.slot);
        try {
            const { error } = await supabase.storage
                .from(SIGHTING_PHOTO_BUCKET)
                .upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' });
            if (error) {
                const status = String((error as { statusCode?: unknown }).statusCode ?? '');
                const message = error.message ?? '';
                if (status === '409' || /already exists|duplicate/i.test(message)) {
                    photo.path = path; // an earlier try landed
                } else if (/bucket not found/i.test(message)) {
                    markNotPushed('photo bucket');
                    return 'not-pushed';
                } else {
                    log.warn('A sighting photo did not upload; the sighting goes without it for now:', message);
                }
                continue;
            }
            photo.path = path;
        } catch (error) {
            log.warn('A sighting photo did not upload (offline?):', error);
            return 'offline';
        }
    }
    return 'ok';
}

/**
 * Remove photo objects the row no longer lists (best effort). Returns the
 * paths that are gone; the rest are tried after the next successful write.
 * Leftovers are still the owner's, under their uid, and go with the account.
 */
async function removeObjects(paths: string[] | undefined): Promise<string[]> {
    if (!supabase || !paths || paths.length === 0) return [];
    try {
        const { error } = await supabase.storage.from(SIGHTING_PHOTO_BUCKET).remove(paths);
        return error ? [] : paths;
    } catch {
        return [];
    }
}

async function sendInsert(record: LocalSighting, userId: string, retried = false): Promise<StepResult> {
    if (!supabase) return 'stop-offline';
    const photos = await uploadPhotos(record, userId);
    if (photos === 'not-pushed') return 'stop-not-pushed';
    let error: unknown = null;
    try {
        ({ error } = await supabase.from(SIGHTINGS_TABLE).insert(insertPayload(record)));
    } catch (thrown) {
        error = thrown;
    }
    const kind = error ? classifyError(error) : null;
    if (!error || kind === 'exists') {
        const photosPending = record.photos.some((p) => !p.path && p.blobKey);
        const removed = await removeObjects(record.removedPhotoPaths);
        await commit(record, userId, (fresh) => {
            const next = withPaths(fresh, record);
            return {
                ...next,
                removedPhotoPaths: (fresh.removedPhotoPaths ?? []).filter((p) => !removed.includes(p)),
                sync: {
                    ...next.sync,
                    serverKnown: true,
                    // A duplicate may hold an older version: send the content again.
                    op: kind === 'exists' || photosPending ? 'update' : null,
                    state: kind === 'exists' || photosPending ? 'pending' : 'synced',
                    attempts: 0,
                    lastError: null,
                    nextAttemptAt: photosPending ? Date.now() + backoff(1) : null,
                },
            };
        });
        if (kind === 'exists') {
            const fresh = await getLocalSighting(record.id, userId);
            if (fresh && fresh.sync.op === 'update') return sendUpdate(fresh, userId, true);
        }
        return 'sent';
    }
    return handleRefusal(record, userId, kind as ErrorKind, error, retried, 'insert');
}

async function sendUpdate(record: LocalSighting, userId: string, retried = false): Promise<StepResult> {
    if (!supabase) return 'stop-offline';
    const photos = await uploadPhotos(record, userId);
    if (photos === 'not-pushed') return 'stop-not-pushed';
    let error: unknown = null;
    let data: unknown = null;
    try {
        ({ data, error } = await supabase
            .from(SIGHTINGS_TABLE)
            .update(updatePayload(record))
            .eq('id', record.id)
            .select('id'));
    } catch (thrown) {
        error = thrown;
    }
    if (!error) {
        if (Array.isArray(data) && data.length === 0) {
            // The server no longer has it (deleted elsewhere, or never landed): this phone's copy goes again.
            await commit(record, userId, (fresh) => ({
                ...withPaths(fresh, record),
                photos: fresh.photos.map((p) => ({ ...p, path: null })),
                sync: { ...fresh.sync, serverKnown: false, op: 'insert', state: 'pending' },
            }));
            if (retried) return 'sent';
            const fresh = await getLocalSighting(record.id, userId);
            return fresh ? sendInsert(fresh, userId, true) : 'sent';
        }
        const photosPending = record.photos.some((p) => !p.path && p.blobKey);
        const removed = await removeObjects(record.removedPhotoPaths);
        await commit(record, userId, (fresh) => {
            const next = withPaths(fresh, record);
            return {
                ...next,
                removedPhotoPaths: (fresh.removedPhotoPaths ?? []).filter((p) => !removed.includes(p)),
                sync: {
                    ...next.sync,
                    serverKnown: true,
                    op: photosPending ? 'update' : null,
                    state: photosPending ? 'pending' : 'synced',
                    attempts: 0,
                    lastError: null,
                    nextAttemptAt: photosPending ? Date.now() + backoff(1) : null,
                },
            };
        });
        return 'sent';
    }
    return handleRefusal(record, userId, classifyError(error), error, retried, 'update');
}

async function sendDelete(record: LocalSighting, userId: string): Promise<StepResult> {
    if (!supabase) return 'stop-offline';
    if (!record.sync.serverKnown) {
        await commit(record, userId, () => 'remove');
        return 'sent';
    }
    const paths = [...uploadedPaths(record), ...(record.removedPhotoPaths ?? [])];
    try {
        if (paths.length > 0) {
            const { error } = await supabase.storage.from(SIGHTING_PHOTO_BUCKET).remove(paths);
            if (error && /bucket not found/i.test(error.message ?? '')) {
                markNotPushed('photo bucket');
                return 'stop-not-pushed';
            }
        }
    } catch {
        return 'stop-offline';
    }
    let error: unknown = null;
    try {
        ({ error } = await supabase.from(SIGHTINGS_TABLE).delete().eq('id', record.id));
    } catch (thrown) {
        error = thrown;
    }
    if (!error) {
        await commit(record, userId, () => 'remove');
        return 'sent';
    }
    return handleRefusal(record, userId, classifyError(error), error, true, 'delete');
}

async function handleRefusal(
    record: LocalSighting,
    userId: string,
    kind: ErrorKind,
    error: unknown,
    retried: boolean,
    op: 'insert' | 'update' | 'delete',
): Promise<StepResult> {
    const text = errorText(error);
    switch (kind) {
        case 'not-pushed':
            markNotPushed(`${op} ${text}`);
            return 'stop-not-pushed';
        case 'auth':
            return 'stop-auth';
        case 'forbidden':
            if (op !== 'delete' && record.row.vessel_owner_id && !retried) {
                log.warn('Not crew on that boat any more: the sighting is kept as your own, with no boat');
                await commit(record, userId, (fresh) => ({
                    ...withPaths(fresh, record),
                    row: detachFromBoat(fresh.row),
                    sync: { ...fresh.sync, lastError: 'not-crew' },
                }));
                const fresh = await getLocalSighting(record.id, userId);
                if (!fresh) return 'sent';
                return op === 'insert' ? sendInsert(fresh, userId, true) : sendUpdate(fresh, userId, true);
            }
            break;
        case 'rate-limited':
            await commit(record, userId, (fresh) => ({
                ...withPaths(fresh, record),
                sync: { ...fresh.sync, state: 'held', lastError: text, nextAttemptAt: Date.now() + RATE_LIMIT_HOLD_MS },
            }));
            return 'skipped';
        case 'tombstoned':
            await commit(record, userId, (fresh) => ({
                ...fresh,
                sync: { ...fresh.sync, state: 'held', lastError: text, nextAttemptAt: Date.now() + RETRY_MAX_MS },
            }));
            return 'skipped';
        case 'rejected':
            log.warn(`A sighting was refused by the server (${text}); kept on this phone`);
            await commit(record, userId, (fresh) => ({
                ...withPaths(fresh, record),
                sync: { ...fresh.sync, state: 'failed', lastError: text, nextAttemptAt: null },
            }));
            return 'skipped';
        default:
            break;
    }
    // Retry later, with backoff. A thrown fetch error means offline: stop the round.
    const attempts = record.sync.attempts + 1;
    await commit(record, userId, (fresh) => ({
        ...withPaths(fresh, record),
        sync: { ...fresh.sync, attempts, lastError: text, nextAttemptAt: Date.now() + backoff(attempts) },
    }));
    return kind === 'retry' && /fetch|network|timeout|offline/i.test(text) ? 'stop-offline' : 'skipped';
}

async function sendOne(record: LocalSighting, userId: string): Promise<StepResult> {
    if (record.sync.op === 'delete') return sendDelete(record, userId);
    if (record.row.observer_id !== userId) return 'skipped';
    const check = checkSendable(record.row);
    if (!check.ok) {
        await commit(record, userId, (fresh) => ({
            ...fresh,
            sync: {
                ...fresh.sync,
                state:
                    check.reason === 'needs-position'
                        ? 'needs-position'
                        : check.reason === 'too-old'
                          ? 'failed'
                          : 'held',
                lastError: check.reason,
            },
        }));
        return 'skipped';
    }
    return record.sync.op === 'update' && record.sync.serverKnown
        ? sendUpdate(record, userId)
        : sendInsert({ ...record, sync: { ...record.sync, op: 'insert' } }, userId);
}

async function sessionUserId(): Promise<string | null> {
    if (!supabase) return null;
    try {
        const { data } = await supabase.auth.getSession();
        return data.session?.user?.id ?? null;
    } catch {
        return null;
    }
}

/** Nothing of this account's is waiting any more: app start need not load the outbox. */
async function clearFlagIfIdle(userId: string): Promise<void> {
    const waiting = (await listLocalSightings(userId)).some(
        (r) => r.sync.op !== null && (r.sync.state === 'pending' || r.sync.state === 'held'),
    );
    if (!waiting) clearSightingsOutboxFlag(userId);
}

async function runDrain(): Promise<DrainResult> {
    const scope: AuthIdentityScope = getAuthIdentityScope();
    const userId = scope.userId;
    const result: DrainResult = { sent: 0, remaining: 0, stopped: null };
    if (!supabase || !userId) return { ...result, stopped: 'signed-out' };
    const queued = (await listLocalSightings(userId)).filter((r) => isDue(r, Date.now()));
    result.remaining = queued.length;
    if (queued.length === 0) {
        await clearFlagIfIdle(userId);
        return result;
    }
    if (sightingsServerUnavailable()) return { ...result, stopped: 'not-pushed' };
    // The boot scope is provisional: send only under a real session for this account.
    if ((await sessionUserId()) !== userId) return { ...result, stopped: 'signed-out' };
    queued.sort((a, b) => a.createdAtLocal - b.createdAtLocal);
    for (const record of queued) {
        if (!isAuthIdentityScopeCurrent(scope)) return { ...result, stopped: 'scope-changed' };
        inFlightId = record.id;
        let step: StepResult;
        try {
            step = await sendOne(record, userId);
        } finally {
            inFlightId = null;
        }
        if (step === 'sent') {
            result.sent += 1;
            result.remaining -= 1;
        } else if (step === 'stop-not-pushed') {
            return { ...result, stopped: 'not-pushed' };
        } else if (step === 'stop-auth') {
            return { ...result, stopped: 'auth' };
        } else if (step === 'stop-offline') {
            return { ...result, stopped: 'offline' };
        }
    }
    if (isAuthIdentityScopeCurrent(scope)) await clearFlagIfIdle(userId);
    return result;
}

/** Send what is waiting. One round at a time; a second call joins the first. Never throws. */
export function drainSightings(): Promise<DrainResult> {
    if (draining) return draining;
    draining = runDrain()
        .catch((error: unknown) => {
            log.warn('Sightings sync round failed:', error);
            return { sent: 0, remaining: 0, stopped: 'offline' as const };
        })
        .finally(() => {
            draining = null;
        });
    return draining;
}

// ── triggers ────────────────────────────────────────────────────────────────

let drainTimer: ReturnType<typeof setTimeout> | null = null;
let triggersInstalled = false;

/** Drain after `delayMs` (5 s while the sheet is open; 0 on Done). Restarts the wait. */
export function scheduleSightingDrain(delayMs = 5_000): void {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => {
        drainTimer = null;
        void drainSightings();
    }, delayMs);
}

/**
 * Send when the phone comes back online, when the app comes to the front,
 * and every minute while the Sightings code is loaded. Installed once.
 */
export function ensureSightingSyncTriggers(): void {
    if (triggersInstalled || typeof window === 'undefined') return;
    triggersInstalled = true;
    window.addEventListener('online', () => scheduleSightingDrain(1_000));
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') scheduleSightingDrain(1_000);
        });
    }
    setInterval(() => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        void drainSightings();
    }, DRAIN_INTERVAL_MS);
    subscribeAuthIdentityScope(() => scheduleSightingDrain(2_000));
}

// ── reads ───────────────────────────────────────────────────────────────────

export function localFromServer(row: ServerSightingRow, ownerUserId: string): LocalSighting {
    const { vernacular_name, taxon_rank: _rank, created_at, updated_at, basis_of_record: _basis, ...rest } = row;
    const sightingRow: SightingRow = { ...rest, photo_paths: row.photo_paths ?? [] };
    return {
        id: row.id,
        ownerUserId,
        row: sightingRow,
        photos: (row.photo_paths ?? []).map((path) => ({
            slot: Number(/\/([0-3])\.jpg$/.exec(path)?.[1] ?? 0),
            blobKey: null,
            path,
        })),
        sync: { state: 'synced', op: null, serverKnown: true, attempts: 0, lastError: null, nextAttemptAt: null },
        serverUpdatedAt: updated_at,
        vernacularName: vernacular_name,
        createdAtLocal: Date.parse(created_at) || Date.now(),
        updatedAtLocal: Date.parse(updated_at) || Date.now(),
    };
}

export interface ReadResult<T> {
    rows: T;
    /** The server has no sightings yet (migration not pushed). */
    unavailable: boolean;
    /** Served from this phone's cache (offline). */
    fromCache: boolean;
    fetchedAt: number | null;
}

/**
 * Bring this account's sightings from other devices onto this phone, and
 * drop synced ones deleted elsewhere. A record with changes waiting is never
 * overwritten.
 */
export async function pullMySightings(): Promise<{ pulled: number; unavailable: boolean }> {
    const scope = getAuthIdentityScope();
    const userId = scope.userId;
    if (!supabase || !userId || sightingsServerUnavailable()) {
        return { pulled: 0, unavailable: sightingsServerUnavailable() };
    }
    try {
        const { data, error } = await supabase
            .from(SIGHTINGS_TABLE)
            .select(SIGHTING_SELECT)
            .eq('observer_id', userId)
            .order('event_date', { ascending: false })
            .limit(PULL_LIMIT);
        if (!isAuthIdentityScopeCurrent(scope)) return { pulled: 0, unavailable: false };
        if (error) {
            if (isNotPushedYet(error)) {
                markNotPushed('pull');
                return { pulled: 0, unavailable: true };
            }
            log.warn('Could not fetch your sightings:', error.message);
            return { pulled: 0, unavailable: false };
        }
        const rows = (data ?? []) as unknown as ServerSightingRow[];
        const seen = new Set<string>();
        let pulled = 0;
        for (const row of rows) {
            seen.add(row.id);
            const local = await getLocalSighting(row.id, userId);
            if (local && local.sync.op !== null) continue; // this phone's change goes first
            if (local && local.serverUpdatedAt === row.updated_at) continue; // unchanged
            const incoming = localFromServer(row, userId);
            if (local) {
                // Keep this phone's photo blobs.
                incoming.photos = incoming.photos.map((p) => ({
                    ...p,
                    blobKey: local.photos.find((l) => l.path === p.path)?.blobKey ?? null,
                }));
            }
            if (!isAuthIdentityScopeCurrent(scope)) return { pulled, unavailable: false };
            await putLocalSighting(incoming);
            pulled += 1;
        }
        if (rows.length < PULL_LIMIT) {
            for (const local of await listLocalSightings(userId)) {
                if (local.sync.serverKnown && local.sync.op === null && !seen.has(local.id)) {
                    await deleteLocalSighting(local);
                }
            }
        }
        return { pulled, unavailable: false };
    } catch (error) {
        log.warn('Could not fetch your sightings (offline?):', error);
        return { pulled: 0, unavailable: false };
    }
}

interface CrewFeedCache {
    ownerId: string;
    fetchedAt: number;
    rows: ServerSightingRow[];
}

/**
 * The boat's Crew and Public sightings, live (RLS: you are the skipper or his
 * accepted crew). The last 30 days, newest first. Offline: the last copy.
 */
export async function fetchCrewSightings(ownerId: string): Promise<ReadResult<ServerSightingRow[]>> {
    const scope = getAuthIdentityScope();
    const userId = scope.userId;
    const cacheName = `crew-feed:${ownerId}`;
    const cached = async (): Promise<ReadResult<ServerSightingRow[]>> => {
        const hit = await getSightingMeta<CrewFeedCache>(userId, cacheName);
        return {
            rows: hit && hit.ownerId === ownerId ? hit.rows : [],
            unavailable: sightingsServerUnavailable(),
            fromCache: true,
            fetchedAt: hit?.fetchedAt ?? null,
        };
    };
    if (!supabase || !userId || sightingsServerUnavailable()) return cached();
    try {
        const since = new Date(Date.now() - CREW_FEED_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
            .from(SIGHTINGS_TABLE)
            .select(SIGHTING_SELECT)
            .eq('vessel_owner_id', ownerId)
            .in('visibility', ['crew', 'public'])
            .gte('event_date', since)
            .order('event_date', { ascending: false })
            .limit(CREW_FEED_LIMIT);
        if (!isAuthIdentityScopeCurrent(scope))
            return { rows: [], unavailable: false, fromCache: false, fetchedAt: null };
        if (error) {
            if (isNotPushedYet(error)) {
                markNotPushed('crew feed');
                return { rows: [], unavailable: true, fromCache: false, fetchedAt: null };
            }
            return cached();
        }
        const rows = (data ?? []) as unknown as ServerSightingRow[];
        const fetchedAt = Date.now();
        await putSightingMeta(userId, cacheName, { ownerId, fetchedAt, rows } satisfies CrewFeedCache);
        return { rows, unavailable: false, fromCache: false, fetchedAt };
    } catch {
        return cached();
    }
}

/** One named sighting of a boat, all it takes to draw its life list. */
export interface BoatSpeciesRow {
    id: string;
    scientific_name: string;
    taxon_group: ServerSightingRow['taxon_group'];
    vernacular_name: string | null;
    event_date: string;
}

interface BoatSpeciesCache {
    ownerId: string;
    fetchedAt: number;
    rows: BoatSpeciesRow[];
}

/**
 * The boat's life list, all time (the crew feed is the last 30 days only):
 * every named Crew or Public sighting on that boat that RLS lets you read,
 * oldest first so first-seen dates are true. `complete` is false when only
 * an offline copy (or nothing) was available.
 */
export async function fetchBoatSpecies(ownerId: string): Promise<ReadResult<BoatSpeciesRow[]> & { complete: boolean }> {
    const scope = getAuthIdentityScope();
    const userId = scope.userId;
    const cacheName = `boat-species:${ownerId}`;
    const cached = async () => {
        const hit = await getSightingMeta<BoatSpeciesCache>(userId, cacheName);
        const ok = !!hit && hit.ownerId === ownerId;
        return {
            rows: ok ? hit.rows : [],
            unavailable: sightingsServerUnavailable(),
            fromCache: true,
            fetchedAt: ok ? hit.fetchedAt : null,
            complete: false,
        };
    };
    if (!supabase || !userId || sightingsServerUnavailable()) return cached();
    try {
        const { data, error } = await supabase
            .from(SIGHTINGS_TABLE)
            .select('id,scientific_name,taxon_group,vernacular_name,event_date')
            .eq('vessel_owner_id', ownerId)
            .in('visibility', ['crew', 'public'])
            .not('scientific_name', 'is', null)
            .order('event_date', { ascending: true })
            .limit(BOAT_SPECIES_LIMIT);
        if (!isAuthIdentityScopeCurrent(scope)) {
            return { rows: [], unavailable: false, fromCache: false, fetchedAt: null, complete: false };
        }
        if (error) {
            if (isNotPushedYet(error)) {
                markNotPushed('boat species');
                return { rows: [], unavailable: true, fromCache: false, fetchedAt: null, complete: false };
            }
            return cached();
        }
        const rows = (data ?? []) as unknown as BoatSpeciesRow[];
        const fetchedAt = Date.now();
        await putSightingMeta(userId, cacheName, { ownerId, fetchedAt, rows } satisfies BoatSpeciesCache);
        return { rows, unavailable: false, fromCache: false, fetchedAt, complete: rows.length < BOAT_SPECIES_LIMIT };
    } catch {
        return cached();
    }
}

export interface PublicBox {
    south: number;
    west: number;
    north: number;
    east: number;
}

/** A box `radiusKm` around a point, clamped to what get_public_sightings accepts. */
export function boxAround(lat: number, lon: number, radiusKm: number): PublicBox {
    const dLat = Math.min(14.9, radiusKm / 111.32);
    const dLon = Math.min(14.9, radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180))));
    return {
        south: Math.max(-90, lat - dLat),
        north: Math.min(90, lat + dLat),
        west: Math.max(-180, lon - dLon),
        east: Math.min(180, lon + dLon),
    };
}

/**
 * Everyone's public sightings in a box: three hours late and on a grid,
 * decided by the server. Page with the last row's event_time and id.
 */
export async function fetchPublicSightings(
    box: PublicBox,
    page: { before: string; beforeId: string } | null = null,
    limit = 100,
): Promise<ReadResult<PublicSighting[]>> {
    const scope = getAuthIdentityScope();
    if (!supabase || !scope.userId || sightingsServerUnavailable()) {
        return { rows: [], unavailable: sightingsServerUnavailable(), fromCache: false, fetchedAt: null };
    }
    try {
        const { data, error } = await supabase.rpc('get_public_sightings', {
            p_south: box.south,
            p_west: box.west,
            p_north: box.north,
            p_east: box.east,
            p_before: page?.before ?? null,
            p_before_id: page?.beforeId ?? null,
            p_limit: limit,
        });
        if (!isAuthIdentityScopeCurrent(scope))
            return { rows: [], unavailable: false, fromCache: false, fetchedAt: null };
        if (error) {
            if (isNotPushedYet(error)) {
                markNotPushed('public feed');
                return { rows: [], unavailable: true, fromCache: false, fetchedAt: null };
            }
            log.warn('Could not fetch public sightings:', error.message);
            return { rows: [], unavailable: false, fromCache: false, fetchedAt: null };
        }
        return {
            rows: (data ?? []) as PublicSighting[],
            unavailable: false,
            fromCache: false,
            fetchedAt: Date.now(),
        };
    } catch {
        return { rows: [], unavailable: false, fromCache: false, fetchedAt: null };
    }
}

export type CrewSightingChange = { type: 'upsert'; row: ServerSightingRow } | { type: 'delete'; id: string };

/**
 * Live crew feed for one boat. RLS decides which INSERT/UPDATE events arrive;
 * a DELETE carries only the id (ignore ids you do not have). Returns the
 * unsubscribe; closes itself when the account changes.
 */
export function subscribeCrewSightings(ownerId: string, onChange: (change: CrewSightingChange) => void): () => void {
    const scope = getAuthIdentityScope();
    if (!supabase || !scope.userId || sightingsServerUnavailable()) return () => undefined;
    const sb = supabase;
    const channel = sb
        .channel(`sightings-crew-${ownerId}-${Math.random().toString(36).slice(2, 8)}`)
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: SIGHTINGS_TABLE, filter: `vessel_owner_id=eq.${ownerId}` },
            (payload: { eventType?: string; new?: unknown; old?: unknown }) => {
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (payload.eventType === 'DELETE') {
                    const id = (payload.old as { id?: unknown } | undefined)?.id;
                    if (typeof id === 'string') onChange({ type: 'delete', id });
                    return;
                }
                const row = payload.new as ServerSightingRow | undefined;
                if (row && typeof row.id === 'string') onChange({ type: 'upsert', row });
            },
        )
        .subscribe();
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        void sb.removeChannel(channel);
    };
    const unsubscribeIdentity = subscribeAuthIdentityScope(() => {
        close();
        unsubscribeIdentity();
    });
    return () => {
        unsubscribeIdentity();
        close();
    };
}

const signedUrls = new Map<string, { url: string; expiresAt: number }>();

/** A short-lived (1 h) URL for a photo you may see; null if not. Cached for 50 minutes. */
export async function sightingPhotoUrl(path: string): Promise<string | null> {
    const hit = signedUrls.get(path);
    if (hit && hit.expiresAt > Date.now()) return hit.url;
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.storage.from(SIGHTING_PHOTO_BUCKET).createSignedUrl(path, 3600);
        if (error || !data?.signedUrl) return null;
        signedUrls.set(path, { url: data.signedUrl, expiresAt: Date.now() + 50 * 60_000 });
        return data.signedUrl;
    } catch {
        return null;
    }
}
