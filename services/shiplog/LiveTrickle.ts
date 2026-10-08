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
const LIVE_TRACK_RETIREMENTS_TABLE = 'live_track_retirements';
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
    /** Vessel captured at cast-off; live rows must not follow a later fleet switch. */
    readonly boatId?: string;
    running: boolean;
    cancelled: boolean;
    lastAttemptMs: number;
    tickPromise: Promise<void> | null;
    pruned: boolean;
    intervalHandle: ReturnType<typeof setInterval> | null;
    /** One warn per session when the skipper-device claim vetoes publishing. */
    claimWarned?: boolean;
    /** Last automatic-handover attempt (ms); at most one per TRICKLE_INTERVAL_MS. */
    handoverAttemptMs?: number;
    /** Last claim heartbeat attempt (ms); at most one per CLAIM_HEARTBEAT_MS. */
    heartbeatAttemptMs?: number;
}

type SettingsModule = typeof import('../../stores/settingsStore');
type SkipperModule = typeof import('../skipperDevice');
type SkipperClaim = import('../skipperDevice').SkipperClaim;

/** Why a live tail was deliberately made permanently ineligible to publish. */
export type LiveTrackRetirementReason = 'archived' | 'deleted' | 'discarded';

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

function normalizedLiveVoyageId(voyageId: string): string | null {
    const normalized = voyageId.trim();
    // `default_voyage` is a display sentinel for old ungrouped log rows. It
    // is never an immutable active-track id and must not become a permanent
    // retirement fence for future ungrouped captures.
    if (!normalized || normalized === 'default_voyage' || normalized.length > 256) return null;
    return normalized;
}

/**
 * Wait for the exact account's in-flight upsert before deleting its rows.
 * This closes the otherwise subtle race where an opt-out/delete sends a
 * DELETE, then a pre-existing upsert completes afterwards and resurrects the
 * public tail.
 */
async function settleLiveTrickleTick(
    scope: AuthIdentityScope,
    voyageId?: string,
    disarmMatchingVoyage = false,
): Promise<void> {
    const session = activeSession;
    if (!session || !sameScope(session.scope, scope) || (voyageId && session.voyageId !== voyageId)) return;

    if (disarmMatchingVoyage) cancelSession(session);
    try {
        await session.tickPromise;
    } catch {
        // The caller still needs to issue the delete/retirement fence. A
        // failed trickle is not a reason to leave the stale tail public.
    }
}

/**
 * The account's newest live point (ms): a sign of life a claim may not carry,
 * because a holder on an older build publishes without a heartbeat. live_track
 * has no device id, so this says only that the page is still moving, not who
 * moved it — which is all the handover needs. null: no rows; undefined: could
 * not ask (offline, refused), and then the caller must not guess.
 */
async function newestLivePointMs(session: TrickleSession): Promise<number | null | undefined> {
    try {
        if (!supabase || !sessionIsCurrent(session)) return undefined;
        const { data, error } = await supabase
            .from(LIVE_TRACK_TABLE)
            .select('timestamp,created_at')
            .eq('user_id', session.ownerUserId)
            .order('timestamp', { ascending: false })
            .limit(1);
        if (error || !sessionIsCurrent(session)) return undefined;
        const row = (data as Array<{ timestamp?: string; created_at?: string }> | null)?.[0];
        if (!row) return null;
        const ms = Math.max(
            Date.parse(row.timestamp ?? '') || -Infinity,
            Date.parse(row.created_at ?? '') || -Infinity,
        );
        return Number.isFinite(ms) ? ms : null;
    } catch {
        return undefined;
    }
}

/**
 * Take over a FORGOTTEN claim (build 125, 125-12). Shane at the marina,
 * 2026-10-09: recording, live share on, and "iPhone/iPad · 1353 holds the
 * skipper claim (active 32 days ago)" — an install that no longer existed, so
 * nothing would ever release it and the public page stayed empty.
 *
 * Only here, so only while this device is recording with live share ON, and
 * only when the holder has shown no sign of life for CLAIM_STALE_AFTER_MS: not
 * its heartbeat, not its claim, not the account's live track. Inside that
 * window a second device is a real conflict and the takeover stays a
 * deliberate confirm (the Log notice, the Vessel card). The write is guarded
 * (writeSkipperClaimIfUnchanged) so a holder that heartbeats in the meantime
 * keeps the page. At most one attempt per trickle interval: never a write loop.
 */
async function takeOverForgottenClaim(
    session: TrickleSession,
    claim: SkipperClaim | null,
    settings: SettingsModule,
    skipper: SkipperModule,
): Promise<boolean> {
    const now = Date.now();
    if (!claim?.deviceId || !skipper.isClaimStale(claim, now)) return false;
    if (now - (session.handoverAttemptMs ?? 0) < TRICKLE_INTERVAL_MS) return false;
    session.handoverAttemptMs = now;
    const newestLive = await newestLivePointMs(session);
    if (newestLive === undefined || !sessionIsCurrent(session)) return false;
    if (!skipper.isClaimStale(claim, now, newestLive)) return false;
    const result = await settings.writeSkipperClaimIfUnchanged(claim, skipper.buildClaim());
    if (result !== 'written' || !sessionIsCurrent(session)) return false;
    const message = skipper.autoHandoverMessage(claim, now, newestLive);
    log.warn(`skipper claim taken over: ${message}`);
    // Said once, plainly; the takeover is this device's from now on. A device
    // displaced earlier and back tracking may still show App's "no longer the
    // skipper" toast from this same tick: withdraw it, or the two contradict.
    try {
        const { toast } = await import('../../components/Toast');
        const displaced = skipper.takeDisplacedNotice();
        if (typeof displaced === 'number') toast.dismiss(displaced);
        toast.info(message, 8_000);
    } catch {
        /* no UI to tell — the Vessel card and the log say who publishes */
    }
    return true;
}

/**
 * The holder's heartbeat: after a successful upload, refresh the claim's
 * lastSeenAt so the other device can tell a live holder from a forgotten one.
 * Piggy-backed on the upload (never its own loop), at most once per
 * CLAIM_HEARTBEAT_MS per session, and guarded like the handover.
 */
async function heartbeatSkipperClaim(
    session: TrickleSession,
    settings: SettingsModule,
    skipper: SkipperModule,
): Promise<void> {
    try {
        const claim = settings.useSettingsStore.getState().settings.skipperDevice ?? null;
        const now = Date.now();
        if (!claim || !skipper.heartbeatDue(claim, now)) return;
        if (now - (session.heartbeatAttemptMs ?? 0) < skipper.CLAIM_HEARTBEAT_MS) return;
        session.heartbeatAttemptMs = now;
        if (!sessionIsCurrent(session)) return;
        await settings.writeSkipperClaimIfUnchanged(claim, skipper.withHeartbeat(claim, now));
    } catch (error) {
        log.warn('skipper claim heartbeat failed:', error);
    }
}

/**
 * Return true only when this tick found a real eligible point or encountered
 * a delivery failure. An empty start pulse must not consume the two-minute
 * send window: the Voyage Start marker is intentionally not trackworthy, and
 * the first vetted GPS point should be able to publish straight afterwards.
 */
async function doTick(session: TrickleSession): Promise<boolean> {
    try {
        if (!supabase || !sessionIsCurrent(session) || !(await isEnabled(session))) return false;
        if (!sessionIsCurrent(session)) return false;

        const user = await getCurrentUser();
        if (!sessionIsCurrent(session) || !user || user.id !== session.ownerUserId) return false;

        const [settingsModule, skipper] = await Promise.all([
            import('../../stores/settingsStore'),
            import('../skipperDevice'),
        ]);
        const { useSettingsStore: store, refreshSkipperClaim } = settingsModule;
        const { mayPublish, deviceIdReady } = skipper;
        if (!sessionIsCurrent(session)) return false;
        // This install's id once the iOS Keychain has answered, so a reinstall
        // compares as the same device (build 125).
        await deviceIdReady();
        if (!sessionIsCurrent(session)) return false;
        // Re-check publishing authority against the CLOUD before every push
        // (throttled to 60 s inside). Without this the gate below read only the
        // local claim, which no code path ever refreshed mid-session — so a
        // takeover on the other device never reached this one and BOTH kept
        // publishing, the exact dual-source failure the claim exists to stop.
        // Offline: refresh no-ops and the local claim stands (fail-open at sea).
        await refreshSkipperClaim();
        if (!sessionIsCurrent(session)) return false;
        const claim = store.getState().settings.skipperDevice ?? null;
        if (!mayPublish(claim) && !(await takeOverForgottenClaim(session, claim, settingsModule, skipper))) {
            // The single-publisher veto is correct behaviour — but it was
            // SILENT, and a skipper with live-share ON stared at an empty
            // public page with no clue why (field mystery 2026-08-03: a
            // stale claim from a previous install muted the trickle while
            // every other part of the chain was healthy). One warn per
            // session names the holder so the console answers instantly. A
            // forgotten holder was just taken over above; a live one waits for
            // the deliberate takeover on the Log notice or the Vessel card.
            if (!session.claimWarned) {
                session.claimWarned = true;
                log.warn(
                    `live share is ON but this device does not hold the skipper claim — publishing suppressed. ` +
                        `Claim holder: ${claim?.deviceName ?? 'unknown'} (claimed ${claim?.claimedAt ?? '?'}, ` +
                        `last seen ${claim?.lastSeenAt ?? 'never'}). ` +
                        `"Publish from this device" on the Log or Vessel page takes it over.`,
                );
            }
            return false;
        }
        session.claimWarned = false;

        const mark = await readMark(session);
        if (!sessionIsCurrent(session)) return false;
        const queue = await getOfflineEntries();
        if (!sessionIsCurrent(session)) return false;
        const fresh = queue
            .filter(
                (entry) =>
                    entryOwner(entry) === session.ownerUserId &&
                    entry.voyageId === session.voyageId &&
                    (!session.boatId || entry.boatId === session.boatId) &&
                    typeof entry.timestamp === 'string' &&
                    entry.timestamp > mark &&
                    typeof entry.latitude === 'number' &&
                    typeof entry.longitude === 'number' &&
                    isTrackworthyEntry(entry),
            )
            .sort((left, right) => (left.timestamp < right.timestamp ? -1 : 1));
        if (fresh.length === 0) return false;

        const decimated = decimate(fresh);
        const chunk = decimated.slice(0, MAX_BATCH);
        const newest = decimated[decimated.length - 1];
        const batch = chunk[chunk.length - 1] === newest ? chunk : [...chunk, newest];
        const rows = batch.map((entry) => ({
            user_id: session.ownerUserId,
            boat_id: session.boatId ?? entry.boatId ?? null,
            voyage_id: session.voyageId,
            timestamp: entry.timestamp,
            latitude: entry.latitude,
            longitude: entry.longitude,
            speed_kts: entry.speedKts ?? null,
            course_deg: entry.courseDeg ?? null,
            // Preserve capture-time water verification so public consumers
            // can distinguish a vetted water fix from a land/uncertain fix
            // without re-running geospatial checks in the Edge function.
            is_on_water: entry.isOnWater ?? null,
            source: 'device',
        }));

        if (!sessionIsCurrent(session)) return false;
        const { error } = await supabase
            .from(LIVE_TRACK_TABLE)
            .upsert(rows, { onConflict: 'user_id,timestamp', ignoreDuplicates: true });
        if (!sessionIsCurrent(session)) return false;
        if (error) {
            log.info('trickle upsert failed (will retry):', error.message);
            return true;
        }
        await writeMark(session, chunk[chunk.length - 1].timestamp as string);
        if (!sessionIsCurrent(session)) return false;
        log.info(`trickled ${rows.length} live point(s)`);
        await heartbeatSkipperClaim(session, settingsModule, skipper);
        if (!sessionIsCurrent(session)) return false;

        if (!session.pruned) {
            session.pruned = true;
            const cutoff = new Date(Date.now() - PRUNE_AFTER_MS).toISOString();
            try {
                if (!sessionIsCurrent(session)) return false;
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
        return true;
    } catch (error) {
        log.warn('trickle tick failed:', error);
        // A failed network/storage attempt deserves normal throttling; only
        // the benign no-point case should immediately retry on the next fix.
        return true;
    }
}

function tick(session: TrickleSession): Promise<void> {
    if (session.tickPromise) return session.tickPromise;
    const promise = doTick(session)
        .then((attemptedDelivery) => {
            if (attemptedDelivery && sessionIsCurrent(session)) session.lastAttemptMs = Date.now();
        })
        .finally(() => {
            if (session.tickPromise === promise) session.tickPromise = null;
        });
    session.tickPromise = promise;
    return promise;
}

/** Throttled heartbeat, optionally bound to the capture owner's scope. */
export function noteLiveTrickleHeartbeat(
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
    activeVoyageId?: string | null,
    boatId?: string,
): void {
    const session = activeSession;
    const healthy =
        !!session && session.running && sameScope(session.scope, expectedScope) && sessionIsCurrent(session);
    const wrongVoyage = healthy && activeVoyageId ? session.voyageId !== activeVoyageId : false;
    if (!healthy || wrongVoyage) {
        // SELF-HEAL (2026-09-01): a recording that captures fixes must have
        // a trickle session whenever the caller can name its voyage. A
        // Cast-Off departure reached the Log page recording with no session
        // armed — planned route on the public page, no live tail, "No trip
        // started yet" — while a Log-page start was fine. Whichever start
        // path forgets to arm (or a WebView reload drops the session), the
        // first captured fix re-arms it. The liveTrackShare gate stays
        // inside the tick, so sharing-off punters trickle nothing.
        if (activeVoyageId) startLiveTrickle(activeVoyageId, expectedScope, boatId);
        return;
    }
    const now = Date.now();
    if (now - session.lastAttemptMs < TRICKLE_INTERVAL_MS) return;
    void tick(session);
}

/** Wire live sharing to one immutable recording owner and voyage. */
export function startLiveTrickle(
    activeVoyageId: string | null,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    boatId?: string,
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
        boatId,
        running: true,
        cancelled: false,
        lastAttemptMs: 0,
        tickPromise: null,
        pruned: false,
        intervalHandle: null,
    };
    session.intervalHandle = setInterval(() => noteLiveTrickleHeartbeat(session.scope), TRICKLE_INTERVAL_MS);
    activeSession = session;
    // Publish an already-buffered first point immediately after (re)arming.
    // If there is only the non-trackworthy Voyage Start marker, doTick leaves
    // the throttle open so the first vetted GPS point can trigger its own
    // immediate heartbeat below.
    noteLiveTrickleHeartbeat(scope);
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
        // Do not disarm here: this is the settings opt-out path, and the
        // existing session should naturally resume if the skipper re-enables
        // sharing during the same recording. Waiting is enough because the
        // setting has already changed before this helper is called.
        await settleLiveTrickleTick(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return false;
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

/**
 * Retire one immutable voyage's public live tail.
 *
 * The short-lived live_track rows are deleted immediately, while the durable
 * retirement row prevents a delayed/retried client upsert from recreating
 * them. The latter is especially important for a voyage discarded before its
 * local-first ship_log points ever reach Supabase.
 */
export async function retireLiveTrackVoyage(
    voyageId: string,
    reason: LiveTrackRetirementReason,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    const normalizedVoyageId = normalizedLiveVoyageId(voyageId);
    if (!supabase || !normalizedVoyageId || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;

    // A retirement is terminal for this voyage. If it happens to be the live
    // session currently armed on this device, stop that session first so its
    // final flush cannot race the deletion below.
    await settleLiveTrickleTick(scope, normalizedVoyageId, true);
    if (!isAuthIdentityScopeCurrent(scope)) return false;

    try {
        const user = await getCurrentUser();
        if (!isAuthIdentityScopeCurrent(scope) || !user || user.id !== scope.userId) return false;

        // Establish the server-side no-revival fence first. If an older app
        // has an in-flight upsert, the migration's BEFORE INSERT trigger
        // silently suppresses it once this row exists.
        const { error: retirementError } = await supabase.from(LIVE_TRACK_RETIREMENTS_TABLE).upsert(
            {
                user_id: scope.userId,
                voyage_id: normalizedVoyageId,
                reason,
                retired_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,voyage_id' },
        );
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        if (retirementError) {
            // Still attempt the direct removal below. This keeps a migration
            // rollout hiccup from turning a user action into a seven-day
            // public-tail leak; the offline deletion ledger retries the fence.
            log.warn('live_track retirement fence failed:', retirementError.message);
        }

        const { error: purgeError } = await supabase
            .from(LIVE_TRACK_TABLE)
            .delete()
            .eq('user_id', scope.userId)
            .eq('voyage_id', normalizedVoyageId);
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        if (purgeError) {
            log.warn('live_track voyage purge failed:', purgeError.message);
            return false;
        }
        if (!retirementError) log.info(`live_track retired for voyage ${normalizedVoyageId}`);
        return retirementError === null;
    } catch (error) {
        log.warn('live_track voyage retirement failed:', error);
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
        boatId: undefined,
        running: false,
        cancelled: false,
        lastAttemptMs: 0,
        tickPromise: null,
        pruned: false,
        intervalHandle: null,
    };
    await writeMark(session, new Date().toISOString());
}
