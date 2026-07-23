/**
 * useReadinessSync — React hook for syncing checklist state to Supabase.
 *
 * Drop-in enhancement for any passage card with a checklist.
 * Handles load/save/sync with ReadinessCheckService.
 */

import {
    useEffect,
    useCallback,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { ReadinessCheckService } from '../services/ReadinessCheckService';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const subscribeIdentity = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());

/** Reactive identity snapshot for readiness components with other async state. */
export function useReadinessIdentityScope(): AuthIdentityScope {
    return useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
}

/**
 * Card-local persistence is isolated by both account and voyage. A missing
 * voyage deliberately uses a separate draft bucket; unattributed legacy keys
 * are never imported because their owner cannot be established safely.
 */
export function readinessStorageKey(
    baseKey: string,
    voyageId: string | undefined | null,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): string {
    const voyageScope = voyageId?.trim() ? `voyage:${encodeURIComponent(voyageId.trim())}` : 'draft';
    return authScopedStorageKey(`${baseKey}::${voyageScope}`, scope);
}

export function readReadinessStorage<T>(
    baseKey: string,
    voyageId: string | undefined | null,
    fallback: T,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): T {
    try {
        const raw = localStorage.getItem(readinessStorageKey(baseKey, voyageId, scope));
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

export function writeReadinessStorage<T>(
    baseKey: string,
    voyageId: string | undefined | null,
    value: T,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    try {
        localStorage.setItem(readinessStorageKey(baseKey, voyageId, scope), JSON.stringify(value));
    } catch {
        /* local cache is best-effort; service persistence remains canonical */
    }
}

export function removeReadinessStorage(
    baseKey: string,
    voyageId: string | undefined | null,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    try {
        localStorage.removeItem(readinessStorageKey(baseKey, voyageId, scope));
    } catch {
        /* ignore */
    }
}

/**
 * A localStorage-backed React state cell that follows account and voyage
 * changes before paint. Its setter captures the current identity so an event
 * handler retained from account A cannot write into account B's namespace.
 */
export function useScopedReadinessStorageState<T>(
    baseKey: string,
    voyageId: string | undefined | null,
    initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
    const scope = useReadinessIdentityScope();
    const initialValueRef = useRef(initialValue);
    const currentStorageKey = readinessStorageKey(baseKey, voyageId, scope);
    const [cell, setCell] = useState<{ storageKey: string; value: T }>(() => ({
        storageKey: currentStorageKey,
        value: readReadinessStorage(baseKey, voyageId, initialValueRef.current, scope),
    }));
    // Identity transitions can render before layout effects run. Returning the
    // next scope's cache immediately prevents even that transitional render
    // (and its parent callbacks) from observing the previous owner's value.
    const visibleValue =
        cell.storageKey === currentStorageKey
            ? cell.value
            : readReadinessStorage(baseKey, voyageId, initialValueRef.current, scope);

    useLayoutEffect(() => {
        setCell({
            storageKey: currentStorageKey,
            value: readReadinessStorage(baseKey, voyageId, initialValueRef.current, scope),
        });
    }, [baseKey, currentStorageKey, voyageId, scope]);

    const setScopedValue = useCallback<Dispatch<SetStateAction<T>>>(
        (nextValue) => {
            const operationScope = scope;
            if (!isAuthIdentityScopeCurrent(operationScope)) return;
            setCell((previousCell) => {
                if (!isAuthIdentityScopeCurrent(operationScope)) return previousCell;
                const previous =
                    previousCell.storageKey === currentStorageKey
                        ? previousCell.value
                        : readReadinessStorage(baseKey, voyageId, initialValueRef.current, operationScope);
                const next =
                    typeof nextValue === 'function' ? (nextValue as (previousValue: T) => T)(previous) : nextValue;
                writeReadinessStorage(baseKey, voyageId, next, operationScope);
                return { storageKey: currentStorageKey, value: next };
            });
        },
        [baseKey, currentStorageKey, voyageId, scope],
    );

    return [visibleValue, setScopedValue];
}

/**
 * Hook that syncs checklist items to Supabase on tick/untick.
 *
 * @param voyageId - The active voyage/passage ID (if null, sync is disabled)
 * @param cardKey - Unique key for this card (e.g. 'vessel_check', 'medical')
 * @param checkedItems - Current checked state from the card's own state
 * @param setCheckedItems - State setter to update the card's checked items
 * @param localStorageKey - Base namespace for the card's scoped local mirror
 */
export function useReadinessSync(
    voyageId: string | undefined | null,
    cardKey: string,
    _checkedItems: Record<string, boolean>,
    setCheckedItems: Dispatch<SetStateAction<Record<string, boolean>>>,
    localStorageKey: string,
): {
    syncCheck: (itemKey: string, checked: boolean, metadata?: Record<string, unknown>) => void;
    clearChecks: () => void;
} {
    const scope = useReadinessIdentityScope();
    const voyageIdRef = useRef(voyageId);
    voyageIdRef.current = voyageId;

    // Reload from the exact owner/voyage cache before fetching the server.
    useEffect(() => {
        const operationScope = scope;
        const localAtLoadStart = readReadinessStorage<Record<string, boolean>>(
            localStorageKey,
            voyageId,
            {},
            operationScope,
        );
        setCheckedItems(localAtLoadStart);
        if (!voyageId) return;
        let cancelled = false;

        (async () => {
            try {
                const serverChecks = await ReadinessCheckService.loadCardChecks(voyageId, cardKey);
                if (cancelled || !isAuthIdentityScopeCurrent(operationScope)) return;
                if (Object.keys(serverChecks).length > 0) {
                    const merged: Record<string, boolean> = {};
                    for (const [key, state] of Object.entries(serverChecks)) {
                        merged[key] = state.checked;
                    }
                    const currentLocal = readReadinessStorage<Record<string, boolean>>(
                        localStorageKey,
                        voyageId,
                        {},
                        operationScope,
                    );
                    const combined = { ...currentLocal };
                    for (const [key, serverValue] of Object.entries(merged)) {
                        // A tap made while this load was in flight is newer
                        // than its snapshot and must not be rolled back.
                        if (currentLocal[key] === localAtLoadStart[key]) {
                            combined[key] = serverValue;
                        }
                    }
                    writeReadinessStorage(localStorageKey, voyageId, combined, operationScope);
                    setCheckedItems(combined);
                }
            } catch {
                // Silently fall back to localStorage
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [voyageId, cardKey, setCheckedItems, localStorageKey, scope]);

    // Sync a check to Supabase (debounced inside the service)
    const syncCheck = useCallback(
        (itemKey: string, checked: boolean, metadata?: Record<string, unknown>) => {
            const operationScope = scope;
            const operationVoyageId = voyageIdRef.current;
            if (!operationVoyageId || !isAuthIdentityScopeCurrent(operationScope)) return;
            void ReadinessCheckService.upsertCheck(operationVoyageId, cardKey, itemKey, checked, metadata);
        },
        [cardKey, scope],
    );

    const clearChecks = useCallback(() => {
        const operationScope = scope;
        const operationVoyageId = voyageIdRef.current;
        if (!isAuthIdentityScopeCurrent(operationScope)) return;
        removeReadinessStorage(localStorageKey, operationVoyageId, operationScope);
        setCheckedItems({});
        if (operationVoyageId) {
            void ReadinessCheckService.clearChecks(operationVoyageId, cardKey);
        }
    }, [cardKey, localStorageKey, scope, setCheckedItems]);

    return { syncCheck, clearChecks };
}

/**
 * Convenience: sync a single boolean state (e.g. a "confirm" checkbox).
 */
export function useSingleCheckSync(
    voyageId: string | undefined | null,
    cardKey: string,
    itemKey: string,
): {
    syncSingleCheck: (checked: boolean, metadata?: Record<string, unknown>) => void;
    loadSingleCheck: () => Promise<boolean>;
} {
    const scope = useReadinessIdentityScope();
    const syncSingleCheck = useCallback(
        (checked: boolean, metadata?: Record<string, unknown>) => {
            if (!voyageId || !isAuthIdentityScopeCurrent(scope)) return;
            void ReadinessCheckService.upsertCheck(voyageId, cardKey, itemKey, checked, metadata);
        },
        [voyageId, cardKey, itemKey, scope],
    );

    const loadSingleCheck = useCallback(async (): Promise<boolean> => {
        const operationScope = scope;
        if (!voyageId || !isAuthIdentityScopeCurrent(operationScope)) return false;
        const checks = await ReadinessCheckService.loadCardChecks(voyageId, cardKey);
        if (!isAuthIdentityScopeCurrent(operationScope)) return false;
        return checks[itemKey]?.checked ?? false;
    }, [voyageId, cardKey, itemKey, scope]);

    return { syncSingleCheck, loadSingleCheck };
}
