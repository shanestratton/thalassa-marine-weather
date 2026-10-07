/**
 * Process-local DENIAL-only private-message cutover. Native selection does not
 * establish authentication, encryption, peer trust or native readiness.
 *
 * No SDK, credentials, crypto, storage writes, transport or activation flag lives
 * here. The imported local scope can start from a provisional account identifier;
 * it is only a stale-work fence. Legacy callers must still enforce real Auth,
 * ownership and bilateral blocks, and recheck this hint before dispatch/commit/
 * publication. A hint cannot undo a remote operation already dispatched.
 */
import { getAuthIdentityScope, subscribeAuthIdentityScope, type AuthIdentityScope } from '../../authIdentityScope';

declare const legacyPrivateMessagePermitBrand: unique symbol;

/** Opaque cancellation hint, never an authentication or cryptographic capability. */
export interface LegacyPrivateMessagePermit {
    readonly [legacyPrivateMessagePermitBrand]: true;
}

/** Fixed local refusal; it says nothing about already dispatched remote work. */
export class PrivateMessageLegacyUnavailableError extends Error {
    readonly code = 'legacy-private-messages-unavailable' as const;
    constructor() {
        super('Legacy private messaging is unavailable.');
        this.name = 'PrivateMessageLegacyUnavailableError';
    }
}

export const isPrivateMessageLegacyUnavailable = (value: unknown): value is PrivateMessageLegacyUnavailableError =>
    value instanceof PrivateMessageLegacyUnavailableError;

export interface PrivateMessageCutoverPolicy {
    /** Explicit isolated entry only: deny the private legacy lane from boot,
     * before any account seed, SDK await or native availability check. No reset.
     * This is a local denial, never proof of durable account policy/readiness. */
    requireNativePrivateMessagesForProcess(): void;
    /** True means the exact-current denial request was admitted, never native readiness. */
    requireNativePrivateMessagesForScope(scope: AuthIdentityScope): boolean;
    captureLegacyPrivateMessagePermit(
        scope: AuthIdentityScope,
        peerAccountId?: string,
    ): LegacyPrivateMessagePermit | null;
    isLegacyPrivateMessagePermitCurrent(permit: unknown): boolean;
    captureLegacyPrivateMessageAbortScope(permit: unknown): LegacyPrivateMessageAbortScope | null;
    isLegacyPrivateMessageAbortSignalOwned(signal: unknown): boolean;
    isLegacyPrivateMessageAbortSignalCurrent(signal: unknown): boolean;
    cancelLegacyPrivateMessageAbortSignal(signal: unknown): void;
    subscribePrivateMessageCutover(listener: () => void): () => void;
}

/** Owned request cancellation only; a signal does not establish authentication. */
export interface LegacyPrivateMessageAbortScope {
    readonly signal: AbortSignal;
    /** Cancels this request and releases its slot; never clears a policy denial. */
    dispose(): void;
}

type SubscribeScopeChange = (listener: () => void) => () => void;
interface OwnedAbortScope {
    readonly controller: AbortController;
    readonly signal: AbortSignal;
    readonly permit: LegacyPrivateMessagePermit;
    active: boolean;
}

interface ScopeSnapshot {
    readonly key: string;
    readonly userId: string;
    readonly generation: number;
}

interface PermitSnapshot {
    readonly scope: ScopeSnapshot;
    readonly peerAccountId: string | null;
    readonly revision: number;
    readonly scopeEpoch: number;
}

const MAX_ACCOUNTS = 16;
const MAX_LISTENERS = 32;
const MAX_ABORT_SCOPES = 32;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const validAccountId = (value: unknown): value is string =>
    typeof value === 'string' && IDENTIFIER.exec(value)?.[0] === value;

function copyScope(value: unknown): ScopeSnapshot | null {
    try {
        if (!value || typeof value !== 'object') return null;
        const scope = value as AuthIdentityScope;
        // Capture scalar values once. Caller/current objects are never retained.
        const key = scope.key,
            userId = scope.userId,
            generation = scope.generation;
        if (!validAccountId(userId) || key !== `user:${userId}` || !Number.isSafeInteger(generation) || generation < 0)
            return null;
        return Object.freeze({ key, userId, generation });
    } catch {
        return null;
    }
}

const sameScope = (a: ScopeSnapshot, b: ScopeSnapshot | null) =>
    !!b && a.key === b.key && a.userId === b.userId && a.generation === b.generation;

/** Fresh isolated fixtures only; the application singleton has no reset/downgrade. */
export function createPrivateMessageCutoverPolicy(
    getCurrentScope: () => AuthIdentityScope,
    // Custom fixtures must supply their matching source to observe identity
    // transitions while an SDK token await is suspended. The real singleton
    // always subscribes to the existing synchronous local identity fence.
    subscribeScopeChange?: SubscribeScopeChange,
): Readonly<PrivateMessageCutoverPolicy> {
    const requiredAccounts = new Set<string>();
    const permits = new WeakMap<LegacyPrivateMessagePermit, PermitSnapshot>();
    const listeners = new Set<{ active: boolean; listener: () => void }>();
    const abortScopes = new Set<OwnedAbortScope>();
    // Recognize a private request even after disposal: a stale signal must never
    // be misrouted into ordinary/public transport because its active slot ended.
    const ownedAbortSignals = new WeakMap<AbortSignal, OwnedAbortScope>();
    let denyAllLegacy = false;
    let revision = 0;
    let scopeEpoch = 0;
    let notifying = false;
    let notificationPending = false;
    let cancellationDepth = 0;
    let abortAdmissions = 0;
    let scopeSubscriptionHealthy = true;

    const currentScope = () => {
        try {
            return copyScope(getCurrentScope());
        } catch {
            return null;
        }
    };
    // An omitted peer identifies an aggregate private operation (inbox, unread,
    // subscription or private push). After any native selection it cannot prove
    // that its rows belong only to unprotected peers, so refuse the whole aggregate.
    // This prototype trades aggregate availability for conservative local privacy;
    // it is not a server policy or a native readiness/encryption guarantee.
    const denied = (scope: ScopeSnapshot, peer: string | null) =>
        denyAllLegacy ||
        requiredAccounts.has(scope.userId) ||
        (peer === null ? requiredAccounts.size > 0 : requiredAccounts.has(peer));

    function cancelOwnedAbortScopes(entries: readonly OwnedAbortScope[] = [...abortScopes]): void {
        cancellationDepth += 1;
        // Commit removal for the entire set BEFORE any abort event can reenter.
        // No capture may admit another owned request during this cancellation.
        const active = entries.filter((entry) => entry.active && abortScopes.has(entry));
        for (const entry of active) {
            entry.active = false;
            abortScopes.delete(entry);
        }
        try {
            for (const entry of active) {
                try {
                    entry.controller.abort();
                } catch {
                    /* No raw callback/adapter diagnostics. */
                }
            }
        } finally {
            cancellationDepth -= 1;
            if (cancellationDepth === 0 && notificationPending) notify();
        }
    }

    function notify(): void {
        notificationPending = true;
        // An abort listener can request another denial. Its public notification
        // waits until ALL original signals are aborted, including outer passes.
        if (notifying || cancellationDepth > 0) return;
        notifying = true;
        try {
            // At most 16 new account latches plus one overflow can ever notify.
            // Reentrant requests enqueue a pass instead of recursively invoking
            // listeners. Each pass owns a bounded snapshot; cancellation wins.
            while (notificationPending) {
                notificationPending = false;
                for (const entry of [...listeners]) {
                    if (!entry.active || !listeners.has(entry)) continue;
                    try {
                        entry.listener();
                    } catch {
                        /* Signal-only refusal: no raw diagnostics. */
                    }
                }
            }
        } finally {
            notifying = false;
        }
    }

    const requireNativePrivateMessagesForScope = (scope: AuthIdentityScope): boolean => {
        const original = copyScope(scope);
        if (!original || !sameScope(original, currentScope())) return false;
        if (denyAllLegacy || requiredAccounts.has(original.userId)) return true;
        // Fail the whole legacy lane closed at capacity; never evict a denial
        // because a different account logs in or a native view disappears.
        if (requiredAccounts.size >= MAX_ACCOUNTS) denyAllLegacy = true;
        else requiredAccounts.add(original.userId);
        revision += 1;
        cancelOwnedAbortScopes();
        notify();
        return true;
    };

    const requireNativePrivateMessagesForProcess = (): void => {
        if (denyAllLegacy) return;
        // Commit the denial BEFORE abort/listener callbacks can reenter. Unlike
        // an owner-specific latch this works during provisional anonymous boot.
        denyAllLegacy = true;
        revision += 1;
        cancelOwnedAbortScopes();
        notify();
    };

    const captureLegacyPrivateMessagePermit = (
        scope: AuthIdentityScope,
        peerAccountId?: string,
    ): LegacyPrivateMessagePermit | null => {
        const original = copyScope(scope);
        if (!original || (peerAccountId !== undefined && !validAccountId(peerAccountId))) return null;
        const peer = peerAccountId ?? null;
        const capturedRevision = revision;
        const capturedScopeEpoch = scopeEpoch;
        if (
            !sameScope(original, currentScope()) ||
            denied(original, peer) ||
            capturedRevision !== revision ||
            capturedScopeEpoch !== scopeEpoch
        )
            return null;
        const permit = Object.freeze(Object.create(null)) as LegacyPrivateMessagePermit;
        permits.set(
            permit,
            Object.freeze({
                scope: original,
                peerAccountId: peer,
                revision: capturedRevision,
                scopeEpoch: capturedScopeEpoch,
            }),
        );
        return permit;
    };

    const isLegacyPrivateMessagePermitCurrent = (candidate: unknown): boolean => {
        if (!candidate || typeof candidate !== 'object') return false;
        const permit = candidate as LegacyPrivateMessagePermit;
        const original = permits.get(permit);
        if (!original) return false;
        if (
            original.revision !== revision ||
            original.scopeEpoch !== scopeEpoch ||
            !sameScope(original.scope, currentScope()) ||
            denied(original.scope, original.peerAccountId) ||
            original.revision !== revision ||
            original.scopeEpoch !== scopeEpoch
        ) {
            // Once observed obsolete, a permit never revives even if a broken
            // injected fixture later rolls its scope scalars back.
            permits.delete(permit);
            return false;
        }
        return true;
    };

    const captureLegacyPrivateMessageAbortScope = (permit: unknown): LegacyPrivateMessageAbortScope | null => {
        if (
            cancellationDepth > 0 ||
            !scopeSubscriptionHealthy ||
            abortScopes.size + abortAdmissions >= MAX_ABORT_SCOPES
        )
            return null;
        // Reserve before even reading current scope: a fixture getter or native
        // AbortController adapter may reenter. Pending admissions share the cap.
        abortAdmissions += 1;
        try {
            if (!isLegacyPrivateMessagePermitCurrent(permit)) return null;
            let controller: AbortController;
            let signal: AbortSignal;
            try {
                controller = new AbortController();
                signal = controller.signal;
            } catch {
                return null;
            }
            const entry: OwnedAbortScope = {
                controller,
                signal,
                permit: permit as LegacyPrivateMessagePermit,
                active: true,
            };
            abortScopes.add(entry);
            ownedAbortSignals.set(signal, entry);
            const dispose = () => {
                if (entry.active) cancelOwnedAbortScopes([entry]);
            };
            // Check the SAME owned permit after registration, never a replacement.
            if (
                cancellationDepth > 0 ||
                !scopeSubscriptionHealthy ||
                !isLegacyPrivateMessagePermitCurrent(permit) ||
                !entry.active ||
                signal.aborted
            ) {
                dispose();
                return null;
            }
            return Object.freeze({ signal, dispose });
        } finally {
            abortAdmissions -= 1;
        }
    };

    const ownedAbortEntry = (signal: unknown): OwnedAbortScope | undefined =>
        signal && typeof signal === 'object' ? ownedAbortSignals.get(signal as AbortSignal) : undefined;
    const isLegacyPrivateMessageAbortSignalOwned = (signal: unknown): boolean => !!ownedAbortEntry(signal);
    const isLegacyPrivateMessageAbortSignalCurrent = (signal: unknown): boolean => {
        const entry = ownedAbortEntry(signal);
        if (!entry || !entry.active || entry.signal.aborted || !isLegacyPrivateMessagePermitCurrent(entry.permit))
            return false;
        return entry.active && !entry.signal.aborted;
    };
    const cancelLegacyPrivateMessageAbortSignal = (signal: unknown): void => {
        const entry = ownedAbortEntry(signal);
        if (entry?.active) cancelOwnedAbortScopes([entry]);
    };

    const subscribePrivateMessageCutover = (listener: () => void): (() => void) => {
        if (typeof listener !== 'function' || listeners.size >= MAX_LISTENERS) return () => undefined;
        const entry = { active: true, listener };
        listeners.add(entry);
        return () => {
            if (!entry.active) return;
            entry.active = false;
            listeners.delete(entry);
        };
    };

    if (subscribeScopeChange) {
        try {
            const stop = subscribeScopeChange(() => {
                scopeEpoch += 1;
                cancelOwnedAbortScopes();
            });
            scopeSubscriptionHealthy = typeof stop === 'function';
        } catch {
            scopeSubscriptionHealthy = false;
        }
    }

    return Object.freeze({
        requireNativePrivateMessagesForProcess,
        requireNativePrivateMessagesForScope,
        captureLegacyPrivateMessagePermit,
        isLegacyPrivateMessagePermitCurrent,
        captureLegacyPrivateMessageAbortScope,
        isLegacyPrivateMessageAbortSignalOwned,
        isLegacyPrivateMessageAbortSignalCurrent,
        cancelLegacyPrivateMessageAbortSignal,
        subscribePrivateMessageCutover,
    });
}

// Normal builds retain legacy behavior until an explicit native selection asks
// for denial. This instance is process-lifetime and deliberately has no reset.
const privateMessageCutover = createPrivateMessageCutoverPolicy(getAuthIdentityScope, (listener) =>
    subscribeAuthIdentityScope(() => listener()),
);
export const requireNativePrivateMessagesForScope = privateMessageCutover.requireNativePrivateMessagesForScope;
export const requireNativePrivateMessagesForProcess = privateMessageCutover.requireNativePrivateMessagesForProcess;
export const captureLegacyPrivateMessagePermit = privateMessageCutover.captureLegacyPrivateMessagePermit;
export const isLegacyPrivateMessagePermitCurrent = privateMessageCutover.isLegacyPrivateMessagePermitCurrent;
export const captureLegacyPrivateMessageAbortScope = privateMessageCutover.captureLegacyPrivateMessageAbortScope;
export const isLegacyPrivateMessageAbortSignalOwned = privateMessageCutover.isLegacyPrivateMessageAbortSignalOwned;
export const isLegacyPrivateMessageAbortSignalCurrent = privateMessageCutover.isLegacyPrivateMessageAbortSignalCurrent;
export const cancelLegacyPrivateMessageAbortSignal = privateMessageCutover.cancelLegacyPrivateMessageAbortSignal;
export const subscribePrivateMessageCutover = privateMessageCutover.subscribePrivateMessageCutover;
