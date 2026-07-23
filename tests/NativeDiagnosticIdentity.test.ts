import { describe, expect, it, vi } from 'vitest';
import { writeScopedNativeDiagnostic } from '../services/nativeDiagnostic';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

describe('writeScopedNativeDiagnostic', () => {
    it('writes redacted content only to the captured account namespace', async () => {
        setAuthIdentityScope(`diagnostic-a-${crypto.randomUUID()}`);
        const scope = getAuthIdentityScope();
        const set = vi.fn().mockResolvedValue(undefined);

        await expect(
            writeScopedNativeDiagnostic(
                { set },
                'BOOT_ERR',
                'failed https://example.test/callback?access_token=oauth-secret&ticket=proxy-secret',
                scope,
            ),
        ).resolves.toBe(true);

        expect(set).toHaveBeenCalledWith({
            key: authScopedStorageKey('BOOT_ERR', scope),
            value: expect.stringContaining('access_token=[REDACTED]'),
        });
        expect(set.mock.calls[0]?.[0].value).not.toContain('oauth-secret');
        expect(set.mock.calls[0]?.[0].value).not.toContain('proxy-secret');
    });

    it('rejects a stale callback before it writes into durable storage', async () => {
        setAuthIdentityScope(`diagnostic-a-${crypto.randomUUID()}`);
        const accountA = getAuthIdentityScope();
        const set = vi.fn().mockResolvedValue(undefined);
        setAuthIdentityScope(`diagnostic-b-${crypto.randomUUID()}`);

        await expect(writeScopedNativeDiagnostic({ set }, 'PICK_RESULT', 'account A', accountA)).resolves.toBe(false);
        expect(set).not.toHaveBeenCalled();
    });

    it('can finish an in-flight write only under account A and reports that A is no longer current', async () => {
        setAuthIdentityScope(`diagnostic-a-${crypto.randomUUID()}`);
        const accountA = getAuthIdentityScope();
        let release: (() => void) | undefined;
        const set = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );

        const pending = writeScopedNativeDiagnostic({ set }, 'BOOT_ERR', 'safe detail', accountA);
        await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
        setAuthIdentityScope(`diagnostic-b-${crypto.randomUUID()}`);
        release?.();

        await expect(pending).resolves.toBe(false);
        expect(set).toHaveBeenCalledWith({
            key: authScopedStorageKey('BOOT_ERR', accountA),
            value: 'safe detail',
        });
    });
});
