/**
 * The boat's true heading, when it is fresh enough to act on.
 *
 * Shared by the Move anchor sheet (the bearing prefill) and the anchor watch
 * (126-07c: putting the mark at the bow rather than at a GPS antenna aft of
 * it). A heading more than 10 s old is not used: at anchor she swings, and a
 * stale heading points somewhere she no longer is. Degrees TRUE only; there
 * is no magnetic model yet.
 */
import { NmeaStore, type NmeaStoreState } from '../services/NmeaStore';

/** A true heading older than this is not used. */
export const HEADING_PREFILL_MAX_AGE_MS = 10_000;

/** A true heading as it was read: degrees, when the instruments sent it, and from where. */
export type HeadingReading = { deg: number; at: number; via: string };

/** The boat's true heading if it is fresh enough to stand for the bearing to the anchor. */
export function freshTrueHeading(
    state: Pick<NmeaStoreState, 'headingTrue' | 'remote'>,
    now: number,
): HeadingReading | null {
    const { value, lastUpdated } = state.headingTrue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 360) return null;
    const ageMs = now - lastUpdated;
    if (!(lastUpdated > 0) || ageMs < -1_000 || ageMs > HEADING_PREFILL_MAX_AGE_MS) return null;
    const via = !state.remote ? 'from the instruments' : state.remote.via === 'lan' ? 'via the Pi' : 'via the cloud';
    return { deg: value, at: lastUpdated, via };
}

/** The boat's true heading now, from the instruments or the Pi, or null. Never throws. */
export function currentTrueHeading(now = Date.now()): HeadingReading | null {
    try {
        return freshTrueHeading(NmeaStore.getState(), now);
    } catch {
        return null;
    }
}
