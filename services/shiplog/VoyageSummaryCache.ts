/**
 * VoyageSummaryCache — local-first persistence for the Log's voyage list.
 *
 * Why: the Ship's Log list renders from per-voyage SUMMARIES. Fetching those
 * from Supabase (RPC or fallback) is a network round-trip — fine on wifi,
 * painful on a cellular/sat boat link, and impossible offline. Caching the
 * last-known summaries in Capacitor Preferences lets the Log paint the list
 * INSTANTLY on open (from the phone, zero network), then quietly refresh from
 * the cloud in the background.
 *
 * Keyed per-user so switching accounts on a shared device never shows the
 * wrong boat's voyages. Small payload (one aggregated row per voyage, no
 * track points), so no byte guard is needed in practice.
 */
import { Preferences } from '@capacitor/preferences';
import { createLogger } from '../../utils/createLogger';
import type { VoyageSummary } from './VoyageSummary';

const log = createLogger('VoyageSummaryCache');
const KEY_PREFIX = 'thalassa_voyage_summaries_v1_';

interface CachedSummaries {
    at: number;
    summaries: VoyageSummary[];
}

const keyFor = (userId: string) => `${KEY_PREFIX}${userId}`;

/** Read cached summaries for a user, or null if none/parse error. */
export async function getCachedSummaries(userId: string | null | undefined): Promise<VoyageSummary[] | null> {
    if (!userId) return null;
    try {
        const { value } = await Preferences.get({ key: keyFor(userId) });
        if (!value) return null;
        const parsed = JSON.parse(value) as CachedSummaries;
        return Array.isArray(parsed.summaries) ? parsed.summaries : null;
    } catch (e) {
        log.warn('read failed', e);
        return null;
    }
}

/** Persist the latest summaries for a user (last-write wins). */
export async function setCachedSummaries(userId: string | null | undefined, summaries: VoyageSummary[]): Promise<void> {
    if (!userId) return;
    try {
        const payload = JSON.stringify({ at: Date.now(), summaries } satisfies CachedSummaries);
        await Preferences.set({ key: keyFor(userId), value: payload });
    } catch (e) {
        log.warn('write failed', e);
    }
}
