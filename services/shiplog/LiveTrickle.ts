/**
 * Account-bound live position shadow for the public Voyage Log.
 *
 * Every arming captures an immutable auth generation, owner and voyage.
 * Identity changes synchronously disarm timers; in-flight work may finish at
 * the transport layer, but cannot advance a mark, prune, or publish another
 * account's queue.
 */
import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../../utils/createLogger';
import { supabase, getCurrentUser } from '../supabase';
import { getOfflineEntries } from './OfflineQueue';
import { isTrackworthyEntry } from './helpers';
import type { ShipLogEntry } from '../../types/navigation';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';

const log = createLogger('LiveTrickle');

const LIVE_TRACK_TABLE = 'live_track';
const MARK_KEY = 'live_trickle_mark_v2';
const MARK_VERSION = 2;
const TRICKLE_INTERVAL_MS = 2 * 60 * 1000;
const MIN_SPACING_MS = 30 * 1000;
const MAX_BATCH = 200;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

interface MarkPayload {
    version: typeof MARK_VERSION;
    ownerKey: string;
    ownerUserId: string;
    timestamp: string;
}

interface TrickleSession {
    readonly scope: AuthIdentityScope;
    readonly ownerUserId: string;
    readonly voyageId: string;
    running: boolean;
    cancelled: boolean;
    lastAttemptMs: number;
    tickPromise: Promise<void> | null;
    pruned: boolean;
    intervalHandle: ReturnType<typeof setInterval> | null;
}

let activeSession: TrickleSession | null = null;
const markOperationTails = new Map<string, Promise<void>>();

function sameScope(left: AuthIdentityScope, right: AuthIdentityScope): boolean {
    return left.key === right.key && left.generation === right.generation;
}

function sessionIsCurrent(session: TrickleSession): boolean {
    return !session.cancelled && isAuthIdentityScopeCurrent(session.scope);
}

function markKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(MARK_KEY, scope);
}

function withMarkLock<T>(scope: AuthIdentityScope, staleValue: T, operation: () => Promise<T>): Promise<T> {
    const prior = markOperationTails.get(scope.key) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    markOperationTails.set(
        scope.key,
        result.then(
            () => undefined,
            () => undefined,
        ),
    );
    return result.catch(() => staleValue);
}

function cancelSession(session: TrickleSession): void {
    session.running = false;
    session.cancelled = true;
    if (session.intervalHandle !== null) {
        clearInterval(session.intervalHandle);
        session.intervalHandle = null;
    }
    if (activeSession === session) activeSession = null;
}

/** Synchronous safety disarm; intentionally performs no final flush. */
export function disarmLiveTrickleForIdentityChange(previousScope: AuthIdentityScope): void {
    const session = activeSession;
    if (!session || session.scope.key !== previousScope.key) return;
    cancelSession(session);
    log.info('live trickle disarmed for account transition');
}

subscribeAuthIdentityScope((_next, previous) => {
    disarmLiveTrickleForIdentityChange(previous);
});

async function isEnabled(session: TrickleSession): Promise<boolean> {
    try {
        const { useSettingsStore } = await import('../../stores/settingsStore');
        return sessionIsCurrent(session) && useSettingsStore.getState().settings.liveTrackShare === true;
    } catch {
        return false;
    }
}

async function readMark(session: TrickleSession): Promise<string> {
    return withMarkLock(session.scope, '', async () => {
        try {
            if (!sessionIsCurrent(session)) return '';
            const { value } = await Preferences.get({ key: markKey(session.scope) });
            if (!sessionIsCurrent(session) || !value) return '';
            const parsed = JSON.parse(value) as Partial<MarkPayload>;
            if (
                parsed.version !== MARK_VERSION ||
                parsed.ownerKey !== session.scope.key ||
                parsed.ownerUserId !== session.ownerUserId ||
                typeof parsed.timestamp !== 'string'
            ) {
                return '';
            }
            return parsed.timestamp;
        } catch {
            return '';
        }
    });
}

async function writeMark(session: TrickleSession, timestamp: string): Promise<void> {
    await withMarkLock(session.scope, undefined, async () => {
        if (!sessionIsCurrent(session)) return;
        const payload: MarkPayload = {
            version: MARK_VERSION,
            ownerKey: session.scope.key,
            ownerUserId: session.ownerUserId,
            timestamp,
        };
        try {
            await Preferences.set({ key: markKey(session.scope), value: JSON.stringify(payload) });
        } catch (error) {
            log.warn('mark write failed:', error);
        }
    });
}

/** Decimate ascending-time entries to ≥MIN_SPACING_MS, always keeping newest. */
function decimate(entries: Partial<ShipLogEntry>[]): Partial<ShipLogEntry>[] {
    const kept: Partial<ShipLogEntry>[] = [];
    let lastKeptMs = -Infinity;
    for (const entry of entries) {
        const ms = Date.parse(entry.timestamp ?? '');
        if (!Number.isFinite(ms)) continue;
        if (ms - lastKeptMs >= MIN_SPACING_MS) {
            kept.push(entry);
            lastKeptMs = ms;
        }
    }
    const newest = entries[entries.length - 1];
    if (newest && kept[kept.length - 1] !== newest) kept.push(newest);
    return kept;
}

function entryOwner(entry: Partial<ShipLogEntry>): string | null {
    const record = entry as Record<string, unknown>;
    const owner = record.owner_user_id ?? record.userId ?? record.user_id;
    return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}

async function doTick(session: TrickleSession): Promise<void> {
    try {
        if (!supabase || !sessionIsCurrent(session) || !(await isEnabled(session))) return;
        if (!sessionIsCurrent(session)) return;

        const user = await getCurrentUser();
        if (!sessionIsCurrent(session) || !user || user.id !== session.ownerUserId) return;

        const [{ useSettingsStore: store }, { mayPublish }] = await Promise.all([
            import('../../stores/settingsStore'),
            import('../skipperDevice'),
        ]);
        if (!sessionIsCurrent(session)) return;
        const claim = store.getState().settings.skipperDevice ?? null;
        if (!mayPublish(claim)) return;

        const mark = await readMark(session);
        if (!sessionIsCurrent(session)) return;
        const queue = await getOfflineEntries();
        if (!sessionIsCurrent(session)) return;
        const fresh = queue
            .filter(
                (entry) =>
                    entryOwner(entry) === session.ownerUserId &&
                    entry.voyageId === session.voyageId &&
                    typeof entry.timestamp === 'string' &&
                    entry.timestamp > mark &&
                    typeof entry.latitude === 'number' &&
                    typeof entry.longitude === 'number' &&
                    isTrackworthyEntry(entry),
            )
            .sort((left, right) => (left.timestamp < right.timestamp ? -1 : 1));
        if (fresh.length === 0) return;

        const decimated = decimate(fresh);
        const chunk = decimated.slice(0, MAX_BATCH);
        const newest = decimated[decimated.length - 1];
        const batch = chunk[chunk.length - 1] === newest ? chunk : [...chunk, newest];
        const rows = batch.map((entry) => ({
            user_id: session.ownerUserId,
            voyage_id: session.voyageId,
            timestamp: entry.timestamp,
            latitude: entry.latitude,
            longitude: entry.longitude,
            speed_kts: entry.speedKts ?? null,
            course_deg: entry.courseDeg ?? null,
            source: 'device',
        }));

        if (!sessionIsCurrent(session)) return;
        const { error } = await supabase
            .from(LIVE_TRACK_TABLE)
            .upsert(rows, { onConflict: 'user_id,timestamp', ignoreDuplicates: true });
        if (!sessionIsCurrent(session)) return;
        if (error) {
            log.info('trickle upsert failed (will retry):', error.message);
            return;
        }
        await writeMark(session, chunk[chunk.length - 1].timestamp as string);
        if (!sessionIsCurrent(session)) return;
        log.info(`trickled ${rows.length} live point(s)`);

        if (!session.pruned) {
            session.pruned = true;
            const cutoff = new Date(Date.now() - PRUNE_AFTER_MS).toISOString();
            try {
                if (!sessionIsCurrent(session)) return;
                await supabase
                    .from(LIVE_TRACK_TABLE)
                    .delete()
                    .eq('user_id', session.ownerUserId)
                    .lt('timestamp', cutoff);
            } catch (error) {
                if (sessionIsCurrent(session)) session.pruned = false;
                log.info('live_track prune failed (retries next tick):', error);
            }
        }
    } catch (error) {
        log.warn('trickle tick failed:', error);
    }
}

function tick(session: TrickleSession): Promise<void> {
    if (session.tickPromise) return session.tickPromise;
    const promise = doTick(session).finally(() => {
        if (session.tickPromise === promise) session.tickPromise = null;
    });
    session.tickPromise = promise;
    return promise;
}

/** Throttled heartbeat, optionally bound to the capture owner's scope. */
export function noteLiveTrickleHeartbeat(expectedScope: AuthIdentityScope = getAuthIdentityScope()): void {
    const session = activeSession;
    if (!session || !session.running || !sameScope(session.scope, expectedScope) || !sessionIsCurrent(session)) {
        return;
    }
    const now = Date.now();
    if (now - session.lastAttemptMs < TRICKLE_INTERVAL_MS) return;
    session.lastAttemptMs = now;
    void tick(session);
}

/** Wire live sharing to one immutable recording owner and voyage. */
export function startLiveTrickle(
    activeVoyageId: string | null,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    const ownerUserId = scope.userId;
    if (!activeVoyageId || !ownerUserId || !isAuthIdentityScopeCurrent(scope)) return;
    if (activeSession?.running && sameScope(activeSession.scope, scope) && activeSession.voyageId === activeVoyageId) {
        return;
    }
    if (activeSession) cancelSession(activeSession);

    const session: TrickleSession = {
        scope,
        ownerUserId,
        voyageId: activeVoyageId,
        running: true,
        cancelled: false,
        lastAttemptMs: 0,
        tickPromise: null,
        pruned: false,
        intervalHandle: null,
    };
    session.intervalHandle = setInterval(() => noteLiveTrickleHeartbeat(session.scope), TRICKLE_INTERVAL_MS);
    activeSession = session;
    log.info('live trickle armed');
}

/**
 * Stop only the exact owner's session. A different/current account cannot
 * flush or disarm the prior account's tail.
 */
export async function stopLiveTrickle(
    finalFlush = true,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    const session = activeSession;
    if (!session || !sameScope(session.scope, expectedScope) || !sessionIsCurrent(session)) {
        return;
    }
    session.running = false;
    if (session.intervalHandle !== null) {
        clearInterval(session.intervalHandle);
        session.intervalHandle = null;
    }
    if (finalFlush) {
        if (session.tickPromise) await session.tickPromise.catch(() => {});
        if (activeSession !== session || !sessionIsCurrent(session)) return;
        session.lastAttemptMs = 0;
        await tick(session);
    }
    if (activeSession === session) activeSession = null;
    session.cancelled = true;
    log.info('live trickle stopped');
}

/** Delete only the immutable captured owner's live rows. */
export async function purgeLiveTrack(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<boolean> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
    try {
        const user = await getCurrentUser();
        if (!isAuthIdentityScopeCurrent(scope) || !user || user.id !== scope.userId) return false;
        const { error } = await supabase.from(LIVE_TRACK_TABLE).delete().eq('user_id', scope.userId);
        if (!isAuthIdentityScopeCurrent(scope) || error) {
            if (error) log.warn('live_track purge failed:', error.message);
            return false;
        }
        log.info('live_track purged');
        return true;
    } catch (error) {
        log.warn('live_track purge failed:', error);
        return false;
    }
}

/** Forward-only consent mark, namespaced to the exact account generation. */
export async function markLiveTrickleFreshStart(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<void> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    const session: TrickleSession = {
        scope,
        ownerUserId: scope.userId,
        voyageId: '',
        running: false,
        cancelled: false,
        lastAttemptMs: 0,
        tickPromise: null,
        pruned: false,
        intervalHandle: null,
    };
    await writeMark(session, new Date().toISOString());
}
