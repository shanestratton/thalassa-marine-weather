/**
 * planDeparture — the Plan page's departure time, read and written in one
 * place (build 124: Plan Your Day's "Plot on chart" is its second writer).
 *
 * Extracted unchanged from DepartControl (2026-07-16): the same key, the same
 * account-scoped sessionStorage, and the same identity-tagged window event.
 * The chart's route plotter reads the key when it mounts and listens for the
 * event while it is open (useTracerSessionEffects); DepartControl listens too,
 * so the Plan page's Departure card follows a time set somewhere else.
 *
 * An empty departure means "leaving now". A departure more than an hour gone
 * is forgotten, as the card always has.
 */
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';

export const PLAN_DEPARTURE_KEY = 'thalassa_trace_departure_ms';
export const PLAN_DEPARTURE_EVENT = 'thalassa:departure-changed';
/** A departure further in the past than this reads as "leaving now". */
const FORGET_AFTER_MS = 3_600_000;

export interface PlanDepartureEventDetail {
    ms: number | null;
    scopeKey: string;
    scopeGeneration: number;
}

/** The departure saved for this account, or null ("leaving now"). */
export function readPlanDeparture(scope: AuthIdentityScope = getAuthIdentityScope(), now = Date.now()): number | null {
    try {
        const scoped = sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, scope));
        // The old unscoped key carried no owner: only the anonymous scope reads it.
        const raw = scoped ?? (scope.userId ? null : sessionStorage.getItem(PLAN_DEPARTURE_KEY));
        const value = raw ? Number(raw) : Number.NaN;
        return Number.isFinite(value) && value > now - FORGET_AFTER_MS ? value : null;
    } catch {
        return null;
    }
}

/**
 * Set (or, with null, clear) the departure for the account the caller began
 * under, and tell every open surface. False when that account is no longer
 * the active one, or the time is not a number: nothing is written or sent.
 */
export function setPlanDeparture(ms: number | null, scope: AuthIdentityScope = getAuthIdentityScope()): boolean {
    if (ms !== null && !Number.isFinite(ms)) return false;
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    try {
        const key = authScopedStorageKey(PLAN_DEPARTURE_KEY, scope);
        if (ms === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, String(ms));
    } catch {
        /* private mode — the open surfaces still hear the event below */
    }
    try {
        const detail: PlanDepartureEventDetail = { ms, scopeKey: scope.key, scopeGeneration: scope.generation };
        window.dispatchEvent(new CustomEvent(PLAN_DEPARTURE_EVENT, { detail }));
    } catch {
        /* sessionStorage alone covers the next mount */
    }
    return true;
}

/** The departure an event carries, when it is this account's; else null. */
export function planDepartureFromEvent(
    event: Event,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): { ms: number | null } | null {
    const detail = (event as CustomEvent).detail as Partial<PlanDepartureEventDetail> | null | undefined;
    if (!detail || detail.scopeKey !== scope.key || detail.scopeGeneration !== scope.generation) return null;
    const ms = detail.ms;
    return { ms: typeof ms === 'number' && Number.isFinite(ms) ? ms : null };
}
