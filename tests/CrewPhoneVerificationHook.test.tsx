import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setAuthIdentityScope } from '../services/authIdentityScope';

const service = vi.hoisted(() => ({
    getStatus: vi.fn(),
    start: vi.fn(),
    check: vi.fn(),
    remove: vi.fn(),
}));

vi.mock('../services/CrewPhoneVerificationService', () => ({
    CrewPhoneVerificationError: class CrewPhoneVerificationError extends Error {
        code: string;
        retryAfterSeconds?: number;

        constructor(message: string, code = 'UNKNOWN', retryAfterSeconds?: number) {
            super(message);
            this.code = code;
            this.retryAfterSeconds = retryAfterSeconds;
        }
    },
    CrewPhoneVerificationService: service,
}));

import { useCrewPhoneVerification } from '../hooks/useCrewPhoneVerification';

const unverified = {
    verified: false,
    last4: null,
    verifiedAt: null,
    emailVerified: true,
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('useCrewPhoneVerification', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        vi.clearAllMocks();
        service.getStatus.mockResolvedValue(unverified);
        service.start.mockResolvedValue({
            status: 'pending',
            last4: '6789',
            retryAfterSeconds: 30,
            expiresAt: '2026-08-28T00:05:00.000Z',
        });
        service.check.mockResolvedValue({
            verified: true,
            last4: '6789',
            verifiedAt: '2026-08-28T00:01:00.000Z',
        });
        service.remove.mockResolvedValue(true);
    });

    it('clears raw phone and code values at an account boundary', async () => {
        const rendered = renderHook(() => useCrewPhoneVerification());
        await waitFor(() => expect(rendered.result.current.loading).toBe(false));

        act(() => {
            rendered.result.current.setLocalNumber('0412 345 678');
            rendered.result.current.setCode('123456');
        });
        expect(rendered.result.current.localNumber).toBe('0412 345 678');
        expect(rendered.result.current.code).toBe('123456');

        act(() => setAuthIdentityScope('account-b'));
        await waitFor(() => expect(service.getStatus).toHaveBeenCalledTimes(2));
        expect(rendered.result.current.localNumber).toBe('');
        expect(rendered.result.current.code).toBe('');
        expect(rendered.result.current.pending).toBeNull();
    });

    it('keeps publication in a checking state until the current identity status is known', async () => {
        const status = deferred<typeof unverified>();
        service.getStatus.mockReturnValueOnce(status.promise);
        const rendered = renderHook(() => useCrewPhoneVerification());

        expect(rendered.result.current.publicationState).toBe('checking');
        expect(rendered.result.current.publicationReady).toBe(false);

        status.resolve(unverified);
        await waitFor(() => expect(rendered.result.current.publicationState).toBe('blocked'));
    });

    it('distinguishes an unavailable trust check from a known unverified account and can retry it', async () => {
        service.getStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(unverified);
        const rendered = renderHook(() => useCrewPhoneVerification());

        await waitFor(() => expect(rendered.result.current.publicationState).toBe('unavailable'));
        expect(rendered.result.current.error).toMatch(/could not be completed/i);

        await act(async () => rendered.result.current.refresh());
        expect(rendered.result.current.publicationState).toBe('blocked');
        expect(rendered.result.current.error).toBe('');
    });

    it('keeps the raw number only while an SMS challenge is pending, then masks the verified result', async () => {
        service.getStatus.mockResolvedValueOnce({ ...unverified, emailVerified: false });
        const rendered = renderHook(() => useCrewPhoneVerification());
        await waitFor(() => expect(rendered.result.current.loading).toBe(false));

        act(() => rendered.result.current.setLocalNumber('0412 345 678'));
        await act(async () => rendered.result.current.start());
        expect(service.start).toHaveBeenCalledWith('0412 345 678', 'AU');
        expect(rendered.result.current.pending?.last4).toBe('6789');
        expect(rendered.result.current.localNumber).toBe('0412 345 678');

        act(() => rendered.result.current.setCode('12a34 56'));
        expect(rendered.result.current.code).toBe('123456');
        await act(async () => rendered.result.current.check());

        expect(service.check).toHaveBeenCalledWith('123456');
        expect(rendered.result.current.status).toEqual({
            verified: true,
            last4: '6789',
            verifiedAt: '2026-08-28T00:01:00.000Z',
            emailVerified: true,
        });
        expect(rendered.result.current.localNumber).toBe('');
        expect(rendered.result.current.code).toBe('');
        expect(rendered.result.current.publicationReady).toBe(true);
    });

    it('clears local values and refreshes after removing a verified number', async () => {
        service.getStatus
            .mockResolvedValueOnce({
                verified: true,
                last4: '6789',
                verifiedAt: '2026-08-28T00:01:00.000Z',
                emailVerified: true,
            })
            .mockResolvedValueOnce(unverified);
        const rendered = renderHook(() => useCrewPhoneVerification());
        await waitFor(() => expect(rendered.result.current.publicationReady).toBe(true));
        act(() => {
            rendered.result.current.setLocalNumber('0412 345 678');
            rendered.result.current.setCode('123456');
        });

        await act(async () => rendered.result.current.remove());

        expect(service.remove).toHaveBeenCalledTimes(1);
        expect(service.getStatus).toHaveBeenCalledTimes(2);
        expect(rendered.result.current.status).toEqual(unverified);
        expect(rendered.result.current.localNumber).toBe('');
        expect(rendered.result.current.code).toBe('');
        expect(rendered.result.current.publicationReady).toBe(false);
    });

    it('always leaves the removal state when the revoke RPC reports no change', async () => {
        service.getStatus.mockResolvedValueOnce({
            verified: true,
            last4: '6789',
            verifiedAt: '2026-08-28T00:01:00.000Z',
            emailVerified: true,
        });
        service.remove.mockResolvedValueOnce(false);
        const rendered = renderHook(() => useCrewPhoneVerification());
        await waitFor(() => expect(rendered.result.current.publicationReady).toBe(true));

        await act(async () => rendered.result.current.remove());

        expect(rendered.result.current.removing).toBe(false);
        expect(rendered.result.current.error).toMatch(/could not change your verified mobile/i);
        expect(rendered.result.current.publicationReady).toBe(true);
    });
});
