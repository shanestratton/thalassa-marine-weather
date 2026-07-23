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
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';

const log = createLogger('VoyageSummaryCache');
const CACHE_KEY = 'thalassa_voyage_summaries_v2';
const CACHE_VERSION = 2;

interface CachedSummaries {
    version: typeof CACHE_VERSION;
    ownerKey: string;
    ownerUserId: string;
    at: number;
    summaries: VoyageSummary[];
}

const keyFor = (scope: AuthIdentityScope) => authScopedStorageKey(CACHE_KEY, scope);

/** Read cached summaries for the captured account, or null if stale/invalid. */
export async function getCachedSummaries(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<VoyageSummary[] | null> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    try {
        const { value } = await Preferences.get({ key: keyFor(scope) });
        if (!isAuthIdentityScopeCurrent(scope) || !value) return null;
        const parsed = JSON.parse(value) as Partial<CachedSummaries>;
        if (
            parsed.version !== CACHE_VERSION ||
            parsed.ownerKey !== scope.key ||
            parsed.ownerUserId !== scope.userId ||
            !Array.isArray(parsed.summaries)
        ) {
            return null;
        }
        return parsed.summaries;
    } catch (e) {
        log.warn('read failed', e);
        return null;
    }
}

/** Persist the latest summaries for the captured account (last-write wins). */
export async function setCachedSummaries(
    summaries: VoyageSummary[],
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    const payload = JSON.stringify({
        version: CACHE_VERSION,
        ownerKey: scope.key,
        ownerUserId: scope.userId,
        at: Date.now(),
        summaries,
    } satisfies CachedSummaries);
    try {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await Preferences.set({ key: keyFor(scope), value: payload });
    } catch (e) {
        log.warn('write failed', e);
    }
}
