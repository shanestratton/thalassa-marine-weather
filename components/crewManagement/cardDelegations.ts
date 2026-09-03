/**
 * CrewManagement — readiness-card delegation storage.
 *
 * Moved verbatim out of components/CrewManagement.tsx.
 */
import { authScopedStorageKey, type AuthIdentityScope } from '../../services/authIdentityScope';

export const DELEGATION_STORAGE_KEY = 'thalassa_card_delegations_v2';
export type CardDelegationsByVoyage = Record<string, Record<string, string>>;

export function readDelegations(scope: AuthIdentityScope): CardDelegationsByVoyage {
    try {
        // The old unscoped map has no owner marker. Never assign its crew
        // email addresses to whichever account happens to sign in next.
        const stored = localStorage.getItem(authScopedStorageKey(DELEGATION_STORAGE_KEY, scope));
        if (!stored) return {};
        const parsed: unknown = JSON.parse(stored);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const result: CardDelegationsByVoyage = {};
        for (const [voyageId, assignments] of Object.entries(parsed)) {
            if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) continue;
            const validAssignments = Object.fromEntries(
                Object.entries(assignments).filter(
                    ([cardKey, email]) => Boolean(cardKey) && typeof email === 'string' && email.length > 0,
                ),
            ) as Record<string, string>;
            if (Object.keys(validAssignments).length > 0) result[voyageId] = validAssignments;
        }
        return result;
    } catch {
        return {};
    }
}
