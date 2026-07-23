import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    authState: {
        user: { id: 'account-a' } as { id: string } | null,
        authChecked: true,
    },
    getUser: vi.fn(),
    vesselResult: {
        data: null as { user_id: string } | null,
        error: null as Error | null,
    },
    crewResult: {
        data: null as { role?: string; permissions?: Record<string, unknown> } | null,
        error: null as Error | null,
    },
}));

vi.mock('../stores/authStore', () => {
    const useAuthStore = Object.assign(
        (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
        {
            getState: () => mocks.authState,
        },
    );
    return { useAuthStore };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: mocks.getUser,
        },
        from: (table: string) => {
            const builder = {
                select: vi.fn(),
                eq: vi.fn(),
                limit: vi.fn(),
                maybeSingle: vi.fn(),
            };
            builder.select.mockReturnValue(builder);
            builder.eq.mockReturnValue(builder);
            builder.limit.mockReturnValue(builder);
            builder.maybeSingle.mockImplementation(async () =>
                table === 'vessel_identity' ? mocks.vesselResult : mocks.crewResult,
            );
            return builder;
        },
    },
}));

import { checkPermission, usePermissions } from '../hooks/usePermissions';

const noPermissions = {
    can_view_stores: false,
    can_edit_stores: false,
    can_view_galley: false,
    can_view_nav: false,
    can_view_weather: false,
    can_edit_log: false,
    can_view_passage: false,
    can_view_passage_meals: false,
    can_view_passage_chat: false,
    can_view_passage_route: false,
    can_view_passage_checklist: false,
};

function cacheEntry(userId: string, canEditStores: boolean) {
    return {
        version: 1,
        userId,
        role: canEditStores ? 'skipper' : 'punter',
        permissions: {
            ...noPermissions,
            can_view_stores: canEditStores,
            can_edit_stores: canEditStores,
        },
    };
}

describe('usePermissions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mocks.authState.user = { id: 'account-a' };
        mocks.authState.authChecked = true;
        mocks.getUser.mockResolvedValue({
            data: { user: { id: 'account-a' } },
            error: null,
        });
        mocks.vesselResult.data = null;
        mocks.vesselResult.error = null;
        mocks.crewResult.data = null;
        mocks.crewResult.error = null;
    });

    it('recognises the signed-in vessel owner and stores only an account-scoped grant', async () => {
        mocks.vesselResult.data = { user_id: 'account-a' };

        const { result } = renderHook(() => usePermissions());

        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.isSkipper).toBe(true);
        expect(result.current.canEditStores).toBe(true);
        expect(localStorage.getItem('thalassa_permissions')).toBeNull();
        expect(JSON.parse(localStorage.getItem('thalassa_permissions:account-a') ?? '{}')).toMatchObject({
            version: 1,
            userId: 'account-a',
            role: 'skipper',
        });
    });

    it('enables Stores mutations for an accepted crew editor', async () => {
        mocks.crewResult.data = {
            role: 'deckhand',
            permissions: {
                can_view_stores: true,
                can_edit_stores: true,
            },
        };

        const { result } = renderHook(() => usePermissions());

        await waitFor(() => expect(result.current.loaded).toBe(true));
        expect(result.current.isSkipper).toBe(false);
        expect(result.current.canViewStores).toBe(true);
        expect(result.current.canEditStores).toBe(true);
        expect(checkPermission('can_edit_stores')).toBe(true);
    });

    it('never exposes account A grants during an account B render', () => {
        localStorage.setItem('thalassa_permissions:account-a', JSON.stringify(cacheEntry('account-a', true)));
        mocks.getUser.mockReturnValue(new Promise(() => undefined));

        const { result, rerender } = renderHook(() => usePermissions());
        expect(result.current.loaded).toBe(true);
        expect(result.current.canEditStores).toBe(true);

        mocks.authState.user = { id: 'account-b' };
        rerender();

        expect(result.current.loaded).toBe(false);
        expect(result.current.canEditStores).toBe(false);
        expect(checkPermission('can_edit_stores')).toBe(false);
    });

    it('rejects missing, malformed, generic, and mismatched-user cache grants', () => {
        expect(checkPermission('can_edit_stores')).toBe(false);

        localStorage.setItem('thalassa_permissions', JSON.stringify(cacheEntry('account-a', true)));
        expect(checkPermission('can_edit_stores')).toBe(false);

        localStorage.setItem('thalassa_permissions:account-a', '{broken-json');
        expect(checkPermission('can_edit_stores')).toBe(false);

        localStorage.setItem('thalassa_permissions:account-a', JSON.stringify(cacheEntry('account-b', true)));
        expect(checkPermission('can_edit_stores')).toBe(false);
    });
});
