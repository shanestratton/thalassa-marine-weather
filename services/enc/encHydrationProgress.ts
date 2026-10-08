/**
 * Hydration progress (2026-07-12 audit, UX MAJOR): downloading was completely
 * SILENT — a registered-but-not-yet-downloaded cell rendered as the same dark
 * shell as genuinely uncharted water, and a cruiser panning to tomorrow's
 * anchorage concluded the app had no chart there. The map surfaces this as a
 * "Chart downloading… (n of m)" chip.
 *
 * Its own module (package 125-06) so Auto's route review can tell a download
 * walk landing charts round a fresh route from any other change, without
 * loading EncHazardService; the walk (EncHazardService hydrateMissingCells)
 * sets it, and EncHazardService re-exports the readers.
 */

export interface EncHydrationProgress {
    /** Cells still to attempt in the current walk (0 = idle). */
    remaining: number;
    /** Size of the walk when it started. */
    total: number;
}

let hydrationProgress: EncHydrationProgress = { remaining: 0, total: 0 };
const hydrationListeners = new Set<(p: EncHydrationProgress) => void>();

export function setHydrationProgress(next: EncHydrationProgress): void {
    hydrationProgress = next;
    for (const l of hydrationListeners) {
        try {
            l(hydrationProgress);
        } catch {
            /* listener errors never break the walk */
        }
    }
}

export function getHydrationProgress(): EncHydrationProgress {
    return hydrationProgress;
}

/** Subscribe to hydration progress. Returns an unsubscribe fn. */
export function subscribeHydration(listener: (p: EncHydrationProgress) => void): () => void {
    hydrationListeners.add(listener);
    return () => {
        hydrationListeners.delete(listener);
    };
}
