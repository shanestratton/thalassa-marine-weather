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
let currentScope: AuthIdentityScope = Object.freeze({
    key: ANONYMOUS_KEY,
    userId: null,
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
    if (key === currentScope.key) return currentScope;

    const previous = currentScope;
    currentScope = Object.freeze({
        key,
        userId: normalizedUserId,
        generation: previous.generation + 1,
    });
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
