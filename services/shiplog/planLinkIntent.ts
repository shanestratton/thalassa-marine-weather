/**
 * planLinkIntent — durable intent ledger for the public followed-route link.
 *
 * voyage_plan_links had FIVE writers (cast-off sheet, DeparturePrompts banner,
 * plan-card button, Settings picker, the stop-tracking clear) and NOT ONE
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
 */
import { VoyageLogService } from '../VoyageLogService';
import { withDeadline } from '../../utils/deadline';
import { authScopedStorageKey, getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('planLinkIntent');

const LEDGER_KEY = 'thalassa_plan_link_intents_v1';
const ATTEMPT_DEADLINE_MS = 10_000;
const RETRY_DELAY_MS = 30_000;

type Ledger = Record<string, string | null>; // voyageId → planId (null = clear)

function readLedger(): Ledger {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(LEDGER_KEY));
        const parsed = raw ? (JSON.parse(raw) as Ledger) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeLedger(ledger: Ledger): void {
    try {
        const key = authScopedStorageKey(LEDGER_KEY);
        if (Object.keys(ledger).length === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(ledger));
    } catch {
        /* storage unavailable — in-session retry still works via the timer */
    }
}

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

/**
 * Apply every recorded intent. Success removes the intent; failure keeps it
 * and schedules another pass. Safe to call any time; coalesces concurrent
 * callers.
 */
export async function flushPlanLinkIntents(): Promise<void> {
    if (flushing) return;
    flushing = true;
    const scope = getAuthIdentityScope();
    try {
        const ledger = readLedger();
        for (const [voyageId, planId] of Object.entries(ledger)) {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            try {
                const ok = await withDeadline(
                    VoyageLogService.setVoyagePlanLink(voyageId, planId),
                    ATTEMPT_DEADLINE_MS,
                    'plan-link write',
                );
                if (!isAuthIdentityScopeCurrent(scope)) return;
                if (ok) {
                    const current = readLedger();
                    // Only remove if OUR intent is still the recorded one — a
                    // newer intent written mid-flight must survive to flush.
                    if (current[voyageId] === planId) {
                        delete current[voyageId];
                        writeLedger(current);
                    }
                } else {
                    scheduleRetry();
                }
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
 */
export async function setPlanLinkWithRetry(voyageId: string, planId: string | null): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    armListeners();
    const ledger = readLedger();
    ledger[voyageId] = planId;
    writeLedger(ledger);
    try {
        const ok = await withDeadline(
            VoyageLogService.setVoyagePlanLink(voyageId, planId),
            ATTEMPT_DEADLINE_MS,
            'plan-link write',
        );
        if (ok && isAuthIdentityScopeCurrent(scope)) {
            const current = readLedger();
            if (current[voyageId] === planId) {
                delete current[voyageId];
                writeLedger(current);
            }
        } else if (!ok) {
            scheduleRetry();
        }
        return ok;
    } catch (err) {
        log.warn(`plan-link write queued for retry: ${err instanceof Error ? err.message : String(err)}`);
        scheduleRetry();
        return false;
    }
}

/** Test-only: ledger and timers outlive instances by design. */
export function resetPlanLinkIntentsForTest(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    flushing = false;
    try {
        localStorage.removeItem(authScopedStorageKey(LEDGER_KEY));
    } catch {
        /* fine */
    }
}
