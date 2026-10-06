/**
 * lastPassageStatus — the Crew & Float Plan page's cache-first memory of the
 * passage access it last verified (2026-10-06). A first paint only: per
 * account, per passage, grants only, and a denial forgets.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { NO_PASSAGE_ACCESS, type PassageStatus } from '../services/PassagePlanService';
import { readLastPassageStatus, rememberPassageStatus } from '../services/crew/lastPassageStatus';

const KEY = 'thalassa_crew_page_passage_status_v1';

const grant = (voyageId: string, ownerUserId: string, isOwner: boolean): PassageStatus => ({
    visible: true,
    voyageId,
    ownerUserId,
    isOwner,
    canEditStores: isOwner,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: isOwner,
});

describe('lastPassageStatus', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('skipper-1');
    });

    it('remembers a verified grant for its passage and paints it back', () => {
        const scope = getAuthIdentityScope();
        rememberPassageStatus(scope, 'voyage-1', grant('voyage-1', 'skipper-1', true));
        expect(readLastPassageStatus(scope, 'voyage-1')).toEqual(grant('voyage-1', 'skipper-1', true));
        // Another passage has no memory.
        expect(readLastPassageStatus(scope, 'voyage-2')).toBeNull();
        expect(readLastPassageStatus(scope, null)).toBeNull();
    });

    it('keeps a crew grant on a skipper’s passage too', () => {
        const scope = getAuthIdentityScope();
        rememberPassageStatus(scope, 'voyage-9', grant('voyage-9', 'captain-7', false));
        expect(readLastPassageStatus(scope, 'voyage-9')).toEqual(grant('voyage-9', 'captain-7', false));
    });

    it('a denial forgets the grant, so a revoked passage never paints as granted again', () => {
        const scope = getAuthIdentityScope();
        rememberPassageStatus(scope, 'voyage-1', grant('voyage-1', 'skipper-1', true));
        rememberPassageStatus(scope, 'voyage-1', NO_PASSAGE_ACCESS);
        expect(readLastPassageStatus(scope, 'voyage-1')).toBeNull();
        expect(localStorage.getItem(authScopedStorageKey(KEY, scope))).toBeNull();
    });

    it("a denial for another passage leaves this passage's grant alone", () => {
        const scope = getAuthIdentityScope();
        rememberPassageStatus(scope, 'voyage-1', grant('voyage-1', 'skipper-1', true));
        rememberPassageStatus(scope, 'voyage-2', NO_PASSAGE_ACCESS);
        expect(readLastPassageStatus(scope, 'voyage-1')).not.toBeNull();
    });

    it('never reads across accounts', () => {
        rememberPassageStatus(getAuthIdentityScope(), 'voyage-1', grant('voyage-1', 'skipper-1', true));
        setAuthIdentityScope('someone-else');
        expect(readLastPassageStatus(getAuthIdentityScope(), 'voyage-1')).toBeNull();
        // Nor a record copied under another account's key.
        const raw = localStorage.getItem(
            authScopedStorageKey(KEY, { key: 'user:skipper-1', userId: 'skipper-1', generation: 0 }),
        );
        localStorage.setItem(authScopedStorageKey(KEY, getAuthIdentityScope()), raw ?? '');
        expect(readLastPassageStatus(getAuthIdentityScope(), 'voyage-1')).toBeNull();
    });

    it('refuses an owner grant that names a different owner, and anything malformed', () => {
        const scope = getAuthIdentityScope();
        const key = authScopedStorageKey(KEY, scope);
        localStorage.setItem(
            key,
            JSON.stringify({ version: 1, userId: 'skipper-1', voyageId: 'v', status: grant('v', 'captain-7', true) }),
        );
        expect(readLastPassageStatus(scope, 'v')).toBeNull();
        localStorage.setItem(key, '{not json');
        expect(readLastPassageStatus(scope, 'v')).toBeNull();
        localStorage.setItem(
            key,
            JSON.stringify({ version: 1, userId: 'skipper-1', voyageId: 'v', status: { visible: 'yes' } }),
        );
        expect(readLastPassageStatus(scope, 'v')).toBeNull();
        // Truthy strings are not grants.
        localStorage.setItem(
            key,
            JSON.stringify({
                version: 1,
                userId: 'skipper-1',
                voyageId: 'v',
                status: { ...grant('v', 'skipper-1', true), canEditStores: 'true' },
            }),
        );
        expect(readLastPassageStatus(scope, 'v')?.canEditStores).toBe(false);
    });

    it('does not write for a scope that is no longer current', () => {
        const stale = getAuthIdentityScope();
        setAuthIdentityScope('someone-else');
        rememberPassageStatus(stale, 'voyage-1', grant('voyage-1', 'skipper-1', true));
        expect(localStorage.getItem(authScopedStorageKey(KEY, stale))).toBeNull();
    });
});
