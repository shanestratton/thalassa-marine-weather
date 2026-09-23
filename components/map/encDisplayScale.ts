/** Passage overview is for an active plot, not a country-wide browsing boot.
 * Selection, byte/cell caps and scale-dependent detail remain in the merger. */
export const ENC_MERGE_MIN_ZOOM = 6.5;
export const ENC_DETAIL_MIN_ZOOM = 7;
export const ENC_OVERVIEW_MIN_ZOOM = 5;

export function encDisplayScale(zoom: number, plotting: boolean) {
    const overview = plotting && zoom < ENC_DETAIL_MIN_ZOOM;
    return {
        merge: zoom >= (plotting ? ENC_OVERVIEW_MIN_ZOOM : ENC_MERGE_MIN_ZOOM),
        overview,
        // Do not prefetch a whole coastline around a passage overview.
        windowFactor: overview ? 1 : 2.5,
    };
}
