/**
 * useReadinessSync — React hook for syncing checklist state to Supabase.
 *
 * Drop-in enhancement for any passage card with a checklist.
 * Handles load/save/sync with ReadinessCheckService.
 */

import { useEffect, useCallback, useRef } from 'react';
import { ReadinessCheckService } from '../services/ReadinessCheckService';

/**
 * Hook that syncs checklist items to Supabase on tick/untick.
 *
 * @param voyageId - The active voyage/passage ID (if null, sync is disabled)
 * @param cardKey - Unique key for this card (e.g. 'vessel_check', 'medical')
 * @param checkedItems - Current checked state from the card's own state
 * @param setCheckedItems - State setter to update the card's checked items
 * @param localStorageKey - The card's existing localStorage key (for migration)
 */
export function useReadinessSync(
    voyageId: string | undefined | null,
    cardKey: string,
    checkedItems: Record<string, boolean>,
    setCheckedItems: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
    localStorageKey: string,
): {
    syncCheck: (itemKey: string, checked: boolean, metadata?: Record<string, unknown>) => void;
} {
    const hasLoadedRef = useRef(false);
    const voyageIdRef = useRef(voyageId);
    voyageIdRef.current = voyageId;

    // Load from Supabase on mount (only once per voyageId)
    useEffect(() => {
        if (!voyageId) return;
        hasLoadedRef.current = false;

        (async () => {
            try {
                const serverChecks = await ReadinessCheckService.loadCardChecks(voyageId, cardKey);
                if (Object.keys(serverChecks).length > 0) {
                    // Merge server state into component state
                    const merged: Record<string, boolean> = {};
                    for (const [key, state] of Object.entries(serverChecks)) {
                        merged[key] = state.checked;
                    }
                    setCheckedItems((prev) => {
                        const combined = { ...prev, ...merged };
                        // Also update localStorage to keep them in sync
                        try {
                            localStorage.setItem(localStorageKey, JSON.stringify(combined));
                        } catch {
                            /* ignore */
                        }
                        return combined;
                    });
                }
                hasLoadedRef.current = true;
            } catch {
                // Silently fall back to localStorage
                hasLoadedRef.current = true;
            }
        })();
    }, [voyageId, cardKey, setCheckedItems, localStorageKey]);

    // Sync a check to Supabase (debounced inside the service)
    const syncCheck = useCallback(
        (itemKey: string, checked: boolean, metadata?: Record<string, unknown>) => {
            if (!voyageIdRef.current) return;
            ReadinessCheckService.upsertCheck(voyageIdRef.current, cardKey, itemKey, checked, metadata);
        },
        [cardKey],
    );

    return { syncCheck };
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
    const syncSingleCheck = useCallback(
        (checked: boolean, metadata?: Record<string, unknown>) => {
            if (!voyageId) return;
            ReadinessCheckService.upsertCheck(voyageId, cardKey, itemKey, checked, metadata);
        },
        [voyageId, cardKey, itemKey],
    );

    const loadSingleCheck = useCallback(async (): Promise<boolean> => {
        if (!voyageId) return false;
        const checks = await ReadinessCheckService.loadCardChecks(voyageId, cardKey);
        return checks[itemKey]?.checked ?? false;
    }, [voyageId, cardKey, itemKey]);

    return { syncSingleCheck, loadSingleCheck };
}
