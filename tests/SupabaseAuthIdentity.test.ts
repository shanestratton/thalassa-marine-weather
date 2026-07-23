import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const h = vi.hoisted(() => ({
    getSession: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabaseAnonKey: 'public-anon-key',
    supabase: {
        auth: {
            getSession: h.getSession,
        },
    },
}));

import { getAuthenticatedFunctionHeaders } from '../services/supabaseAuth';

function session(userId: string, accessToken = `${userId}-token`) {
    return {
        data: {
            session: {
                access_token: accessToken,
                user: { id: userId },
            },
        },
        error: null,
    };
}

describe('authenticated Edge Function headers account boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('headers-a');
        h.getSession.mockResolvedValue(session('headers-a'));
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('returns a token only when the remote session exactly matches the active identity', async () => {
        await expect(getAuthenticatedFunctionHeaders()).resolves.toEqual({
            'Content-Type': 'application/json',
            Authorization: 'Bearer headers-a-token',
            apikey: 'public-anon-key',
        });

        h.getSession.mockResolvedValue(session('headers-b'));
        await expect(getAuthenticatedFunctionHeaders()).rejects.toThrow('Sign in');
    });

    it('rejects a deferred A token after B becomes active', async () => {
        let resolveA!: (value: ReturnType<typeof session>) => void;
        h.getSession.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveA = resolve;
            }),
        );
        const pending = getAuthenticatedFunctionHeaders();

        setAuthIdentityScope('headers-b');
        resolveA(session('headers-a'));

        await expect(pending).rejects.toThrow('Sign in');
    });

    it('does not consult a cached remote session for the anonymous scope', async () => {
        setAuthIdentityScope(null);

        await expect(getAuthenticatedFunctionHeaders()).rejects.toThrow('Sign in');
        expect(h.getSession).not.toHaveBeenCalled();
    });
});
