import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
const functions = vi.hoisted(() => ({ invoke: vi.fn() }));
const rpc = vi.hoisted(() => vi.fn());

vi.mock('../services/supabase', () => ({ supabase: { auth, functions, rpc } }));

import { CrewPhoneVerificationError, CrewPhoneVerificationService } from '../services/CrewPhoneVerificationService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('CrewPhoneVerificationService', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        vi.clearAllMocks();
        auth.getUser.mockResolvedValue({ data: { user: { id: 'account-a' } }, error: null });
    });

    it('uses the authenticated Edge Function contract for status, start and check', async () => {
        functions.invoke
            .mockResolvedValueOnce({
                data: { verified: false, last4: null, verifiedAt: null, emailVerified: true },
                error: null,
            })
            .mockResolvedValueOnce({
                data: {
                    status: 'pending',
                    last4: '6789',
                    retryAfterSeconds: 30,
                    expiresAt: '2026-08-28T00:05:00.000Z',
                },
                error: null,
            })
            .mockResolvedValueOnce({
                data: { verified: true, last4: '6789', verifiedAt: '2026-08-28T00:01:00.000Z' },
                error: null,
            });

        await expect(CrewPhoneVerificationService.getStatus()).resolves.toEqual({
            verified: false,
            last4: null,
            verifiedAt: null,
            emailVerified: true,
        });
        await expect(CrewPhoneVerificationService.start('0412 345 678', 'au')).resolves.toMatchObject({
            status: 'pending',
            last4: '6789',
        });
        await expect(CrewPhoneVerificationService.check('123456')).resolves.toMatchObject({
            verified: true,
            last4: '6789',
        });

        expect(functions.invoke).toHaveBeenNthCalledWith(1, 'crew-phone-verification', {
            body: { action: 'status' },
        });
        expect(functions.invoke).toHaveBeenNthCalledWith(2, 'crew-phone-verification', {
            body: { action: 'start', phone: '0412 345 678', countryCode: 'AU' },
        });
        expect(functions.invoke).toHaveBeenNthCalledWith(3, 'crew-phone-verification', {
            body: { action: 'check', code: '123456' },
        });
    });

    it('preserves safe server error details and resend timing', async () => {
        functions.invoke.mockResolvedValue({
            data: null,
            error: {
                message: 'non-2xx response',
                context: {
                    clone: () => ({
                        json: async () => ({
                            error: 'Please wait before requesting another code',
                            code: 'RATE_LIMITED',
                            retryAfterSeconds: 42,
                        }),
                    }),
                },
            },
        });

        const request = CrewPhoneVerificationService.start('0412 345 678', 'AU');
        await expect(request).rejects.toMatchObject({
            message: 'Please wait before requesting another code',
            code: 'RATE_LIMITED',
            retryAfterSeconds: 42,
        });
        await expect(request).rejects.toBeInstanceOf(CrewPhoneVerificationError);
    });

    it('revokes the current verified identity through the server-owned privacy RPC', async () => {
        rpc.mockResolvedValue({ data: true, error: null });

        await expect(CrewPhoneVerificationService.remove()).resolves.toBe(true);

        expect(rpc).toHaveBeenCalledWith('revoke_current_crew_phone_identity');
        expect(rpc).toHaveBeenCalledWith(expect.any(String));
        expect(rpc.mock.calls[0]).toHaveLength(1);
    });

    it('rejects a response that completes after the signed-in account changes', async () => {
        const pending = deferred<{ data: Record<string, unknown>; error: null }>();
        functions.invoke.mockReturnValueOnce(pending.promise);

        const request = CrewPhoneVerificationService.getStatus();
        await vi.waitFor(() => expect(functions.invoke).toHaveBeenCalledTimes(1));
        setAuthIdentityScope('account-b');
        pending.resolve({
            data: { verified: true, last4: '6789', verifiedAt: '2026-08-28T00:00:00.000Z', emailVerified: true },
            error: null,
        });

        await expect(request).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    });
});
