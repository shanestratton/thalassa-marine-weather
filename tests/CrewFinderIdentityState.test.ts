import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCrewFinderState } from '../hooks/useCrewFinderState';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

describe('Crew Finder local identity state', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('switches interaction history and clears private in-memory state with the account', () => {
        const accountAScope = getAuthIdentityScope();
        localStorage.setItem(authScopedStorageKey('crew_liked_users', accountAScope), JSON.stringify(['liked-a']));
        localStorage.setItem(
            authScopedStorageKey('crew_messaged_users', accountAScope),
            JSON.stringify(['messaged-a']),
        );
        const { result } = renderHook(() => useCrewFinderState());

        expect(result.current.state.likedUsers).toEqual(new Set(['liked-a']));
        expect(result.current.state.messagedUsers).toEqual(new Set(['messaged-a']));
        act(() => {
            result.current.dispatch({
                type: 'SET_PROFILE',
                payload: { first_name: 'Private profile A' },
            });
            result.current.dispatch({
                type: 'SET_LISTINGS',
                payload: [{ user_id: 'private-listing-a' } as never],
            });
        });

        act(() => setAuthIdentityScope('account-b'));

        expect(result.current.state.profile).toEqual({});
        expect(result.current.state.listings).toEqual([]);
        expect(result.current.state.likedUsers).toEqual(new Set());
        expect(result.current.state.messagedUsers).toEqual(new Set());

        act(() => setAuthIdentityScope('account-a'));
        expect(result.current.state.likedUsers).toEqual(new Set(['liked-a']));
        expect(result.current.state.messagedUsers).toEqual(new Set(['messaged-a']));
    });

    it('does not adopt unattributable legacy interaction history', () => {
        localStorage.setItem('crew_liked_users', JSON.stringify(['legacy-like']));
        localStorage.setItem('crew_messaged_users', JSON.stringify(['legacy-message']));

        const { result } = renderHook(() => useCrewFinderState());

        expect(result.current.state.likedUsers).toEqual(new Set());
        expect(result.current.state.messagedUsers).toEqual(new Set());
    });
});
