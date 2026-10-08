/**
 * Picks in the location box, the same row picked again included (build 124).
 *
 * Shane 2026-10-08, of Obs: "it should read the boat once I select vessel in
 * the location box". Obs centres once per box (useObsStartupCamera), and
 * picking her row again leaves the box unchanged (it still follows 'boat'),
 * so a settled Obs never moved. Each pick counts, and Obs takes a new count
 * as a new box: it centres again on its next visit.
 *
 * Dependency-free on purpose: the location box is on The Glass, and must not
 * pull the chart's modules into its bundle.
 */
let picks = 0;
const listeners = new Set<() => void>();

/** The skipper picked a row in the location box (a boat, Current Location, a place). */
export function noteLocationBoxPick(): void {
    picks += 1;
    for (const listener of [...listeners]) listener();
}

export function getLocationBoxPicks(): number {
    return picks;
}

export function subscribeLocationBoxPicks(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
