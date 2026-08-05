import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase';

const log = createLogger('OwnedMediaCleanup');
const CLEANUP_KEY = 'thalassa_owned_media_cleanup_v1';
const ALLOWED_BUCKETS = ['chat-avatars', 'crew-list-photos', 'recipe-photos'] as const;

export type OwnedMediaBucket = (typeof ALLOWED_BUCKETS)[number];

export type OwnedMediaReference =
    | { kind: 'unreferenced' }
    | { kind: 'chat-profile-avatar' }
    | { kind: 'dating-photo' }
    | { kind: 'crew-photo' }
    | { kind: 'recipe-photo'; recipeId: string };

export interface OwnedMediaCleanupJob {
    ownerId: string;
    bucket: OwnedMediaBucket;
    path: string;
    reference: OwnedMediaReference;
    createdAt: number;
}

/**
 * An access token captured immediately before an owner-scoped upload.
 * It is deliberately process-local and short-lived; cleanup queues never
 * persist bearer credentials.
 */
export interface OwnedMediaAuthorization {
    readonly ownerId: string;
    readonly accessToken: string;
}

type ReferenceState = 'referenced' | 'unreferenced' | 'unknown';

function cleanupStorageKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(CLEANUP_KEY, scope);
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isAllowedOwnedPath(job: Pick<OwnedMediaCleanupJob, 'ownerId' | 'bucket' | 'path' | 'reference'>): boolean {
    const { ownerId, bucket, path, reference } = job;
    if (
        !ownerId ||
        ownerId.length > 128 ||
        ownerId.includes('/') ||
        ownerId.includes('\\') ||
        ownerId.includes('..') ||
        [...ownerId].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) ||
        !path ||
        path.length > 512 ||
        path.startsWith('/') ||
        path.endsWith('/') ||
        path.includes('..') ||
        path.includes('\\') ||
        [...path].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
    ) {
        return false;
    }

    if (reference.kind === 'chat-profile-avatar') {
        return bucket === 'chat-avatars' && path.startsWith(`${ownerId}/`);
    }
    if (reference.kind === 'dating-photo') {
        return bucket === 'chat-avatars' && path.startsWith(`dating/${ownerId}/`);
    }
    if (reference.kind === 'crew-photo') {
        return bucket === 'crew-list-photos' && path.startsWith(`${ownerId}/`);
    }
    if (reference.kind === 'recipe-photo') {
        if (bucket !== 'recipe-photos' || !isUuid(reference.recipeId)) return false;
        return path === `${ownerId}/${reference.recipeId}.jpg` || path === `${reference.recipeId}.jpg`;
    }

    if (bucket === 'chat-avatars') {
        return path.startsWith(`${ownerId}/`) || path.startsWith(`dating/${ownerId}/`);
    }
    if (bucket === 'crew-list-photos') return path.startsWith(`${ownerId}/`);
    if (bucket === 'recipe-photos') return path.startsWith(`${ownerId}/`);
    return false;
}

function isReference(value: unknown): value is OwnedMediaReference {
    if (!value || typeof value !== 'object') return false;
    const record = value as { kind?: unknown; recipeId?: unknown };
    if (
        record.kind === 'unreferenced' ||
        record.kind === 'chat-profile-avatar' ||
        record.kind === 'dating-photo' ||
        record.kind === 'crew-photo'
    ) {
        return true;
    }
    return record.kind === 'recipe-photo' && typeof record.recipeId === 'string' && isUuid(record.recipeId);
}

function readJobs(scope: AuthIdentityScope): OwnedMediaCleanupJob[] {
    try {
        const raw = localStorage.getItem(cleanupStorageKey(scope));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is OwnedMediaCleanupJob => {
            if (!value || typeof value !== 'object') return false;
            const job = value as Partial<OwnedMediaCleanupJob>;
            return (
                job.ownerId === scope.userId &&
                ALLOWED_BUCKETS.includes(job.bucket as OwnedMediaBucket) &&
                typeof job.path === 'string' &&
                isReference(job.reference) &&
                typeof job.createdAt === 'number' &&
                Number.isFinite(job.createdAt) &&
                isAllowedOwnedPath(job as OwnedMediaCleanupJob)
            );
        });
    } catch (error) {
        log.warn('Could not read the owner media cleanup queue:', error);
        return [];
    }
}

function writeJobs(scope: AuthIdentityScope, jobs: OwnedMediaCleanupJob[]): boolean {
    try {
        localStorage.setItem(cleanupStorageKey(scope), JSON.stringify(jobs));
        return true;
    } catch (error) {
        log.warn('Could not persist the owner media cleanup queue:', error);
        return false;
    }
}

function queueJob(scope: AuthIdentityScope, job: OwnedMediaCleanupJob): boolean {
    if (scope.userId !== job.ownerId || !isAllowedOwnedPath(job)) return false;
    const jobs = readJobs(scope);
    const duplicate = jobs.find((candidate) => candidate.bucket === job.bucket && candidate.path === job.path);
    const withoutDuplicate = jobs.filter(
        (candidate) => !(candidate.bucket === job.bucket && candidate.path === job.path),
    );
    const nextJob = duplicate ? { ...job, createdAt: Math.max(job.createdAt, duplicate.createdAt + 1) } : job;
    return writeJobs(scope, [...withoutDuplicate, nextJob]);
}

function storagePathFromUrl(bucket: OwnedMediaBucket, value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    try {
        const url = new URL(value);
        if (!supabaseUrl || url.origin !== new URL(supabaseUrl).origin) return null;
        const markers = [`/storage/v1/object/public/${bucket}/`, `/storage/v1/object/sign/${bucket}/`];
        const marker = markers.find((candidate) => url.pathname.includes(candidate));
        if (!marker) return null;
        const encodedPath = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
        return decodeURIComponent(encodedPath);
    } catch {
        return null;
    }
}

function urlReferenceState(bucket: OwnedMediaBucket, value: unknown, expectedPath: string): ReferenceState {
    if (value === null || value === undefined || value === '') return 'unreferenced';
    const path = storagePathFromUrl(bucket, value);
    if (!path) return 'unknown';
    return path === expectedPath ? 'referenced' : 'unreferenced';
}

function combinedUrlReferenceState(
    bucket: OwnedMediaBucket,
    values: readonly unknown[],
    expectedPath: string,
): ReferenceState {
    const states = values.map((value) => urlReferenceState(bucket, value, expectedPath));
    if (states.includes('referenced')) return 'referenced';
    return states.includes('unknown') ? 'unknown' : 'unreferenced';
}

function sameReference(left: OwnedMediaReference, right: OwnedMediaReference): boolean {
    if (left.kind !== right.kind) return false;
    return left.kind !== 'recipe-photo' || (right.kind === 'recipe-photo' && left.recipeId === right.recipeId);
}

function sameJob(left: OwnedMediaCleanupJob, right: OwnedMediaCleanupJob): boolean {
    return (
        left.ownerId === right.ownerId &&
        left.bucket === right.bucket &&
        left.path === right.path &&
        left.createdAt === right.createdAt &&
        sameReference(left.reference, right.reference)
    );
}

async function referenceState(job: OwnedMediaCleanupJob, scope: AuthIdentityScope): Promise<ReferenceState> {
    if (!supabase || !isAuthIdentityScopeCurrent(scope) || scope.userId !== job.ownerId) return 'unknown';
    if (job.reference.kind === 'unreferenced') return 'unreferenced';

    try {
        if (job.reference.kind === 'chat-profile-avatar') {
            const { data, error } = await supabase
                .from('chat_profiles')
                .select('avatar_url')
                .eq('user_id', job.ownerId)
                .maybeSingle();
            if (error || !isAuthIdentityScopeCurrent(scope)) return 'unknown';
            if (!data) return 'unreferenced';
            return urlReferenceState(job.bucket, data.avatar_url, job.path);
        }

        if (job.reference.kind === 'dating-photo') {
            const { data, error } = await supabase
                .from('sailor_dating_profiles')
                .select('photos')
                .eq('user_id', job.ownerId)
                .maybeSingle();
            if (error || !isAuthIdentityScopeCurrent(scope)) return 'unknown';
            if (!data || data.photos === null || data.photos === undefined) return 'unreferenced';
            if (!Array.isArray(data.photos)) return 'unknown';
            return combinedUrlReferenceState(job.bucket, data.photos, job.path);
        }

        if (job.reference.kind === 'crew-photo') {
            const { data, error } = await supabase
                .from('sailor_crew_profiles')
                .select('crew_photo_path, crew_photo_paths')
                .eq('user_id', job.ownerId)
                .maybeSingle();
            if (error || !isAuthIdentityScopeCurrent(scope)) return 'unknown';
            if (!data) return 'unreferenced';
            if (
                (data.crew_photo_path !== null &&
                    data.crew_photo_path !== undefined &&
                    typeof data.crew_photo_path !== 'string') ||
                (data.crew_photo_paths !== null &&
                    data.crew_photo_paths !== undefined &&
                    !Array.isArray(data.crew_photo_paths)) ||
                (Array.isArray(data.crew_photo_paths) && data.crew_photo_paths.some((path) => typeof path !== 'string'))
            ) {
                return 'unknown';
            }
            const paths = [
                typeof data?.crew_photo_path === 'string' ? data.crew_photo_path : null,
                ...(Array.isArray(data?.crew_photo_paths) ? data.crew_photo_paths : []),
            ];
            return paths.includes(job.path) ? 'referenced' : 'unreferenced';
        }

        const recipeId = job.reference.recipeId;
        const [communityResult, personalResult] = await Promise.all([
            supabase
                .from('community_recipes')
                .select('image_url')
                .eq('id', recipeId)
                .eq('user_id', job.ownerId)
                .maybeSingle(),
            supabase.from('recipes').select('image_url').eq('id', recipeId).eq('user_id', job.ownerId).maybeSingle(),
        ]);
        if (communityResult.error || personalResult.error || !isAuthIdentityScopeCurrent(scope)) return 'unknown';
        const urls = [communityResult.data?.image_url, personalResult.data?.image_url];
        return combinedUrlReferenceState(job.bucket, urls, job.path);
    } catch (error) {
        log.warn('Could not reconcile an uncertain owner media reference:', error);
        return 'unknown';
    }
}

export async function captureOwnedMediaAuthorization(
    scope: AuthIdentityScope,
): Promise<OwnedMediaAuthorization | null> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    try {
        const { data, error } = await supabase.auth.getSession();
        const session = data.session;
        if (
            error ||
            !session?.access_token ||
            session.user?.id !== scope.userId ||
            !isAuthIdentityScopeCurrent(scope)
        ) {
            return null;
        }
        return Object.freeze({ ownerId: scope.userId, accessToken: session.access_token });
    } catch (error) {
        log.warn('Could not capture owner media cleanup authorization:', error);
        return null;
    }
}

async function removeWithCapturedAuthorization(
    authorization: OwnedMediaAuthorization,
    job: OwnedMediaCleanupJob,
): Promise<boolean> {
    if (!supabaseUrl || !supabaseAnonKey || authorization.ownerId !== job.ownerId || !isAllowedOwnedPath(job)) {
        return false;
    }

    try {
        const response = await fetch(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(job.bucket)}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${authorization.accessToken}`,
                apikey: supabaseAnonKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prefixes: [job.path] }),
        });
        return response.ok;
    } catch (error) {
        log.warn('Immediate owner media cleanup failed; retaining a retry job:', error);
        return false;
    }
}

/**
 * Retire an exact object which is already proven unreferenced. The captured
 * owner token handles an A→B transition; a durable token-free retry remains
 * if the network or old session is unavailable.
 */
export async function retireOwnedMedia(
    scope: AuthIdentityScope,
    authorization: OwnedMediaAuthorization | null,
    bucket: OwnedMediaBucket,
    path: string,
): Promise<boolean> {
    if (!scope.userId) return false;
    const job: OwnedMediaCleanupJob = {
        ownerId: scope.userId,
        bucket,
        path,
        reference: { kind: 'unreferenced' },
        createdAt: Date.now(),
    };
    if (!isAllowedOwnedPath(job)) return false;
    if (authorization && (await removeWithCapturedAuthorization(authorization, job))) return true;
    const queued = queueJob(scope, job);
    if (queued && isAuthIdentityScopeCurrent(scope)) void reconcileOwnedMediaCleanup(scope);
    return false;
}

/**
 * Record an upload whose database outcome is unknown. Reconciliation queries
 * the canonical owner row first and only deletes when the exact path is no
 * longer referenced.
 */
export function retainUncertainOwnedMedia(
    scope: AuthIdentityScope,
    bucket: OwnedMediaBucket,
    path: string,
    reference: Exclude<OwnedMediaReference, { kind: 'unreferenced' }>,
): boolean {
    if (!scope.userId) return false;
    const queued = queueJob(scope, {
        ownerId: scope.userId,
        bucket,
        path,
        reference,
        createdAt: Date.now(),
    });
    if (queued && isAuthIdentityScopeCurrent(scope)) void reconcileOwnedMediaCleanup(scope);
    return queued;
}

export async function reconcileOwnedMediaCleanup(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    let user: { id?: string } | null;
    let error: unknown;
    try {
        const authResult = await supabase.auth.getUser();
        user = authResult.data.user;
        error = authResult.error;
    } catch (authError) {
        log.warn('Could not authenticate owner media cleanup:', authError);
        return;
    }
    if (error || user?.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) return;

    const jobs = readJobs(scope);
    if (jobs.length === 0) return;
    const completed: OwnedMediaCleanupJob[] = [];

    for (const job of jobs) {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const state = await referenceState(job, scope);
        if (state === 'unknown') continue;
        if (state === 'referenced') {
            // The ambiguous database mutation committed. The row owns this
            // object, so retire the cleanup ticket without touching bytes.
            completed.push(job);
            continue;
        }
        try {
            const { error: removeError } = await supabase.storage.from(job.bucket).remove([job.path]);
            if (!removeError && isAuthIdentityScopeCurrent(scope)) completed.push(job);
        } catch (removeError) {
            log.warn('Could not remove reconciled owner media:', removeError);
        }
    }

    if (!isAuthIdentityScopeCurrent(scope) || completed.length === 0) return;

    // Queueing is synchronous but canonical reads and Storage deletes are not.
    // Merge against the latest persisted queue so a job added or replaced while
    // this pass was awaiting the network can never be erased by a stale write.
    const latestJobs = readJobs(scope);
    writeJobs(
        scope,
        latestJobs.filter((candidate) => !completed.some((finished) => sameJob(candidate, finished))),
    );
}

subscribeAuthIdentityScope((next) => {
    if (!next.userId) return;
    queueMicrotask(() => void reconcileOwnedMediaCleanup(next));
});
