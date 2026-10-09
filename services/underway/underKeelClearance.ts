/**
 * The margin under the keel the shoal alarm keeps (build 126, 126-02a).
 *
 * Fixed at 0.5 m for now: the same half metre the charted-leads check adds to
 * the draft. 126-06 makes it the skipper's own setting and owns this getter
 * from then on; every reader asks here, so that is a one-file change.
 */
export const DEFAULT_UNDER_KEEL_CLEARANCE_M = 0.5;

/** Metres of water the shoal alarm wants under the keel. */
export function underKeelClearanceM(_settings?: unknown): number {
    return DEFAULT_UNDER_KEEL_CLEARANCE_M;
}
