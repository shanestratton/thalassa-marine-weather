/**
 * Synchronous auth-identity fence for browser-persisted/offline services.
 *
 * React auth state and Supabase calls are asynchronous. Offline queues cannot
 * wait for either before hiding the previous account's data, so authStore
 * switches this tiny process-local fence first. Services capture a snapshot
 * before async work and reject its result if the generation changed.
 */

export interface AuthIdentityScope {
    /** Stable namespace used for persisted and in-memory state. */
    readonly key: string;
    /** Authenticated owner, or null for the deliberately separate anonymous scope. */
    readonly userId: string | null;
    /** Monotonically increasing process-local fence for stale promises/timers. */
    readonly generation: number;
}

type IdentityListener = (next: AuthIdentityScope, previous: AuthIdentityScope) => void;

const ANONYMOUS_KEY = 'anonymous';

/**
 * The last user this device was signed in as — a synchronous, local mirror
 * of the Supabase session's identity, written on every confirmed identity
 * change and read ONCE at boot to seed the initial scope.
 *
 * WHY. The identity fence is a security boundary: every persisted record is
 * stamped with its owner, and a read under a different scope returns null.
 * That is exactly right when one account logs out and another logs in on the
 * same handset. But on a COLD START the scope began as `anonymous` and stayed
 * there until supabase.auth.getSession() resolved — an async call through the
 * client and its storage adapter, a noticeable beat on iOS. During that beat
 * the SAME user was fenced out of their OWN data: the Log page read the
 * persisted tracking record, parseOwnedValue saw ownerUserId !== null, and
 * returned nothing. So the live map's container did not exist at all for
 * several seconds after launch, appearing only once auth landed (Shane,
 * 2026-08-20: "the map is not there at all, not even the outline of the box,
 * just empty space"). Every fix that seeded state from local storage was
 * correct and useless, because the scope it read under was wrong.
 *
 * WHY THIS IS SAFE. The seed is PROVISIONAL. When the real session lands:
 *   - same user  → setAuthIdentityScope is a no-op (same key). Nothing moves.
 *   - logged out → scope flips to anonymous, generation bumps, every fence
 *                  resets. Exactly what a logout does today.
 *   - different  → scope flips to them, generation bumps, every fence resets.
 *                  Exactly what a logout+login does today.
 * The provisional scope therefore never grants anything the authoritative one
 * would not; it only stops the authoritative one's LATENESS from denying a
 * user their own device's state. localStorage is the right store: it is the
 * only synchronous one, and this value is an identifier, not a credential.
 */
const LAST_USER_KEY = 'thalassa_last_user_id_v1';

function readLastUserId(): string | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        const v = localStorage.getItem(LAST_USER_KEY);
        return v && v.trim() ? v.trim() : null;
    } catch {
        return null;
    }
}

function writeLastUserId(userId: string | null): void {
    try {
        if (typeof localStorage === 'undefined') return;
        if (userId) localStorage.setItem(LAST_USER_KEY, userId);
        else localStorage.removeItem(LAST_USER_KEY);
    } catch {
        /* storage unavailable — the next auth event will retry */
    }
}

const bootUserId = readLastUserId();
let currentScope: AuthIdentityScope = Object.freeze({
    key: bootUserId ? `user:${bootUserId}` : ANONYMOUS_KEY,
    userId: bootUserId,
    generation: 0,
});
const listeners = new Set<IdentityListener>();

function keyForUser(userId: string | null): string {
    return userId ? `user:${userId}` : ANONYMOUS_KEY;
}

/** Read the current identity and generation synchronously. */
export function getAuthIdentityScope(): AuthIdentityScope {
    return currentScope;
}

/**
 * Fence all subscribers onto a new identity. Call this before making the new
 * identity visible to application state. Repeating the same identity is a no-op.
 */
export function setAuthIdentityScope(userId: string | null): AuthIdentityScope {
    const normalizedUserId = userId?.trim() || null;
    const key = keyForUser(normalizedUserId);
    // Mirror every confirmed identity for the next boot's provisional seed —
    // including the no-op case, so a seed the session has just confirmed is
    // refreshed rather than left to age.
    writeLastUserId(normalizedUserId);
    if (key === currentScope.key) return currentScope;

    const previous = currentScope;
    currentScope = Object.freeze({
        key,
        userId: normalizedUserId,
        generation: previous.generation + 1,
    });
    // Every key change remounts identity-scoped React trees and re-fences all
    // persisted stores. Worth one console line: an unexpected flip here is the
    // root cause behind "the page reset itself mid-boot" symptoms.
    console.warn(
        `[AuthIdentityScope] fence ${previous.userId ? 'user' : 'anonymous'} -> ${normalizedUserId ? 'user' : 'anonymous'} gen=${currentScope.generation}`,
    );
    // Identity fencing is a security boundary shared by many independent
    // stores. One defective subscriber must never prevent the remaining
    // subscribers from hiding the previous account's state.
    for (const listener of [...listeners]) {
        try {
            listener(currentScope, previous);
        } catch (error) {
            console.error('[AuthIdentityScope] Identity subscriber failed:', error);
        }
    }
    return currentScope;
}

/** True only while a captured snapshot still represents the active identity. */
export function isAuthIdentityScopeCurrent(snapshot: AuthIdentityScope): boolean {
    return snapshot.key === currentScope.key && snapshot.generation === currentScope.generation;
}

/** Build a collision-safe localStorage key for an explicit or current scope. */
export function authScopedStorageKey(baseKey: string, scope: AuthIdentityScope = currentScope): string {
    return `${baseKey}::${encodeURIComponent(scope.key)}`;
}

/** Subscribe to synchronous identity fences. Returns an unsubscribe callback. */
export function subscribeAuthIdentityScope(listener: IdentityListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
