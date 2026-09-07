/**
 * planLinkIntent — durable intent ledger for the public followed-route link.
 *
 * voyage_plan_links had FIVE writers (cast-off sheet, the since-removed
 * DeparturePrompts banner, plan-card button, Settings picker, the
 * stop-tracking clear) and NOT ONE
 * retry: every write was a single unbounded network call whose failure was
 * toast-and-forget (hardening review 2026-08-01, findings C/22/26). Cast off in
 * a marina wifi shadow and the public page silently never showed the route;
 * stop in a dead spot at the anchorage and the ended passage stayed published.
 *
 * The ledger records the INTENT (voyageId → planId, null = clear) in
 * auth-scoped localStorage before the first attempt, and flushes on:
 *   - the attempt itself succeeding (intent removed),
 *   - the window 'online' event,
 *   - a delayed retry after a failure (one timer, coalesced).
 *
 * Last intent per voyage wins, which makes flush self-consistent without
 * consulting tracking state: stopping a voyage overwrites its link intent with
 * a clear intent, so a late flush can never resurrect a link the stop path
 * meant to delete.
 *
 * Every attempt is bounded by a JS deadline — CapacitorHttp ignores
 * AbortSignal ([[lesson_capacitorhttp_abortsignal_noop]]), and this path's
 * only native bound was the ~60 s request timeout, unacceptable behind a
 * just-closed sheet.
 *
 * AUTHORSHIP (2026-09-08). Two phones on one account: the second to sign in
 * could overwrite the route the first was following, and its stop could
 * delete it. Link rows now carry the device that wrote them (migration
 * 20260908150000), and this module keeps a "written here" ledger of the
 * links THIS device authored. A flush re-reads the row before it writes and
 * DROPS an intent that would overwrite or delete another device's link,
 * telling the page which device holds it; a stop only clears a link this
 * device wrote (or an unstamped, pre-migration one). Nothing here refuses the
 * skipper — the confirm that names the other device lives in
 * publishFollowedRoute's callers, and `replace` gets through unconditionally.
 */
import { VoyageLogService, type PlanLinkRow } from '../VoyageLogService';
import { getDeviceId } from '../skipperDevice';
import { withDeadline } from '../../utils/deadline';
import { authScopedStorageKey, getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('planLinkIntent');

const LEDGER_KEY = 'thalassa_plan_link_intents_v1';
const WRITTEN_HERE_KEY = 'thalassa_plan_links_written_here_v1';
const ATTEMPT_DEADLINE_MS = 10_000;
const RETRY_DELAY_MS = 30_000;

/** Fired when a queued link intent was dropped because another device holds the
 *  row. detail: PlanLinkIntentDropped. Pages show it inline — never a toast. */
export const PLAN_LINK_INTENT_DROPPED_EVENT = 'thalassa:plan-link-intent-dropped';

export interface PlanLinkIntentDropped {
    voyageId: string;
    /** The route this device meant to publish. */
    planVoyageId: string;
    /** The device whose link stands instead, as it named itself. */
    holderName: string;
    holderPlanVoyageId: string;
}

type Ledger = Record<string, string | null>; // voyageId → planId (null = clear)
type WrittenHere = Record<string, string>; // voyageId → planId this device authored

function readJson<T extends object>(key: string): T {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(key));
        const parsed = raw ? (JSON.parse(raw) as T) : ({} as T);
        return parsed && typeof parsed === 'object' ? parsed : ({} as T);
    } catch {
        return {} as T;
    }
}

function writeJson(key: string, value: object): void {
    try {
        const scoped = authScopedStorageKey(key);
        if (Object.keys(value).length === 0) localStorage.removeItem(scoped);
        else localStorage.setItem(scoped, JSON.stringify(value));
    } catch {
        /* storage unavailable — in-session retry still works via the timer */
    }
}

const readLedger = (): Ledger => readJson<Ledger>(LEDGER_KEY);
const writeLedger = (ledger: Ledger): void => writeJson(LEDGER_KEY, ledger);

// ── Written-here ledger ─────────────────────────────────────────────────

/** Remember that THIS device authored voyageId's link (to planId). */
export function markWrittenHere(voyageId: string, planId: string): void {
    const here = readJson<WrittenHere>(WRITTEN_HERE_KEY);
    here[voyageId] = planId;
    writeJson(WRITTEN_HERE_KEY, here);
}

export function forgetWrittenHere(voyageId: string): void {
    const here = readJson<WrittenHere>(WRITTEN_HERE_KEY);
    if (!(voyageId in here)) return;
    delete here[voyageId];
    writeJson(WRITTEN_HERE_KEY, here);
}

/** Did this device author the link that stands (or is queued) on voyageId? */
export function wroteLinkHere(voyageId: string): boolean {
    return typeof readJson<WrittenHere>(WRITTEN_HERE_KEY)[voyageId] === 'string';
}

/**
 * A row another device stamped. Unstamped rows (pre-migration, or written by
 * a build ahead of the migration) belong to nobody in particular and behave
 * as they always did — replaceable and clearable from any device.
 */
export function isForeignLink(row: PlanLinkRow | null | undefined): row is PlanLinkRow {
    return !!row?.deviceId && row.deviceId !== getDeviceId();
}

function announceDropped(detail: PlanLinkIntentDropped): void {
    try {
        window.dispatchEvent(new CustomEvent(PLAN_LINK_INTENT_DROPPED_EVENT, { detail }));
    } catch {
        /* non-DOM host */
    }
}

// ── Intent ledger ───────────────────────────────────────────────────────

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let listenersArmed = false;

function armListeners(): void {
    if (listenersArmed || typeof window === 'undefined') return;
    listenersArmed = true;
    window.addEventListener('online', () => void flushPlanLinkIntents());
}

function scheduleRetry(): void {
    if (retryTimer) return; // one pending retry is enough — flush drains ALL intents
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void flushPlanLinkIntents();
    }, RETRY_DELAY_MS);
}

function recordIntent(voyageId: string, planId: string | null): void {
    const ledger = readLedger();
    ledger[voyageId] = planId;
    writeLedger(ledger);
    if (planId) markWrittenHere(voyageId, planId);
    else forgetWrittenHere(voyageId);
}

/** Remove the intent only if OUR intent is still the recorded one — a newer
 *  intent written mid-flight must survive to flush. */
function settleIntent(voyageId: string, planId: string | null): void {
    const current = readLedger();
    if (voyageId in current && current[voyageId] === planId) {
        delete current[voyageId];
        writeLedger(current);
    }
}

/**
 * Apply every recorded intent. Success removes the intent; failure keeps it
 * and schedules another pass. Safe to call any time; coalesces concurrent
 * callers.
 *
 * Also arms the online-event listener: the ledger survives process death,
 * but until 2026-08-02 nothing re-armed the listener or flushed after a
 * relaunch — an intent queued in a dead spot sat orphaned forever if the
 * next session started online (the 'online' event never fires when you were
 * never offline). ShipLogService.initialize() now calls this at boot.
 *
 * Each intent is checked against the row's author before it is applied: an
 * intent queued while offline must not overwrite (or delete) a link another
 * device set in the meantime. A failed READ keeps the intent for the next
 * pass — this path never writes blind.
 */
export async function flushPlanLinkIntents(): Promise<void> {
    armListeners();
    if (flushing) return;
    flushing = true;
    const scope = getAuthIdentityScope();
    try {
        const ledger = readLedger();
        for (const [voyageId, planId] of Object.entries(ledger)) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            try {
                const read = await withDeadline(
                    VoyageLogService.getPlanLink(voyageId),
                    ATTEMPT_DEADLINE_MS,
                    'plan-link read',
                );
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (!read.ok) {
                    scheduleRetry();
                    continue;
                }
                if (isForeignLink(read.row)) {
                    const holder = read.row;
                    settleIntent(voyageId, planId);
                    if (planId && holder.planVoyageId === planId) {
                        // The other device already published the same route:
                        // satisfied, and re-stamping it as ours would be a lie.
                        continue;
                    }
                    forgetWrittenHere(voyageId);
                    if (planId) {
                        log.warn(
                            `plan-link intent dropped (${voyageId}): held by ${holder.deviceName ?? 'another device'}`,
                        );
                        announceDropped({
                            voyageId,
                            planVoyageId: planId,
                            holderName: holder.deviceName ?? 'another device',
                            holderPlanVoyageId: holder.planVoyageId,
                        });
                    }
                    continue;
                }
                const ok = await withDeadline(
                    VoyageLogService.setVoyagePlanLink(voyageId, planId),
                    ATTEMPT_DEADLINE_MS,
                    'plan-link write',
                );
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (ok) settleIntent(voyageId, planId);
                else scheduleRetry();
            } catch (err) {
                log.warn(`plan-link flush deferred (${voyageId}): ${err instanceof Error ? err.message : String(err)}`);
                scheduleRetry();
            }
        }
    } finally {
        flushing = false;
    }
}

/**
 * Record the intent durably, then attempt it now (bounded). Returns whether
 * THIS attempt landed — on false the intent is queued and will retry, so
 * callers should phrase failure as "will keep trying", not as loss.
 *
 * No author check here: callers that can be a SECOND device on the account
 * (publishFollowedRoute, clearPlanLinkIfWrittenHere) run it first; the
 * Settings picker and a confirmed replace mean to overwrite.
 */
export async function setPlanLinkWithRetry(voyageId: string, planId: string | null): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    armListeners();
    recordIntent(voyageId, planId);
    try {
        const ok = await withDeadline(
            VoyageLogService.setVoyagePlanLink(voyageId, planId),
            ATTEMPT_DEADLINE_MS,
            'plan-link write',
        );
        if (ok && isAuthIdentityScopeCurrent(scope)) settleIntent(voyageId, planId);
        else if (!ok) scheduleRetry();
        return ok;
    } catch (err) {
        log.warn(`plan-link write queued for retry: ${err instanceof Error ? err.message : String(err)}`);
        scheduleRetry();
        return false;
    }
}

/**
 * Record the intent WITHOUT attempting it now. For the device that cannot see
 * who holds the row (offline) and did not author it: the flush re-reads on
 * reconnect and drops the intent if another device's link stands.
 */
export function queuePlanLinkIntent(voyageId: string, planId: string | null): void {
    const scope = getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) return;
    armListeners();
    recordIntent(voyageId, planId);
    scheduleRetry();
}

export type ClearPlanLinkOutcome = 'cleared' | 'queued' | 'held-elsewhere' | 'unknown';

/**
 * Clear voyageId's public link if THIS device is entitled to: it authored the
 * link, or the row is unstamped (pre-migration), or no row stands. A link
 * another device set is left alone — that device's own stop clears it.
 * 'unknown' = this device did not author it and could not read the row.
 */
export async function clearPlanLinkIfWrittenHere(voyageId: string): Promise<ClearPlanLinkOutcome> {
    const scope = getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) return 'unknown';
    if (wroteLinkHere(voyageId)) {
        return (await setPlanLinkWithRetry(voyageId, null)) ? 'cleared' : 'queued';
    }
    let read: Awaited<ReturnType<typeof VoyageLogService.getPlanLink>>;
    try {
        read = await withDeadline(VoyageLogService.getPlanLink(voyageId), ATTEMPT_DEADLINE_MS, 'plan-link read');
    } catch (err) {
        log.warn(`plan-link clear skipped (${voyageId}): ${err instanceof Error ? err.message : String(err)}`);
        return 'unknown';
    }
    if (!isAuthIdentityScopeCurrent(scope)) return 'unknown';
    if (!read.ok) return 'unknown';
    if (!read.row) return 'cleared';
    if (isForeignLink(read.row)) {
        log.warn(`plan-link left standing (${voyageId}): set by ${read.row.deviceName ?? 'another device'}`);
        return 'held-elsewhere';
    }
    return (await setPlanLinkWithRetry(voyageId, null)) ? 'cleared' : 'queued';
}

/** Test-only: ledger and timers outlive instances by design. */
export function resetPlanLinkIntentsForTest(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    flushing = false;
    try {
        localStorage.removeItem(authScopedStorageKey(LEDGER_KEY));
        localStorage.removeItem(authScopedStorageKey(WRITTEN_HERE_KEY));
    } catch {
        /* fine */
    }
}
