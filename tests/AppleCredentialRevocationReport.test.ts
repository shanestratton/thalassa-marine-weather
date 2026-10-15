import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A native "credential revoked" event signs the sailor out. Until build 124 it
 * did so silently, so a kick right after Sign in with Apple left no trace.
 * Each handled event is now reported to Sentry (log.error with an Error) by
 * its reason and state alone: never the Apple user id it carries.
 */

const m = vi.hoisted(() => ({
    listener: null as null | ((event: unknown) => void),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    plugin: {
        checkCredentialState: vi.fn(async (_options: unknown) => ({ state: 'authorized' })),
        bindCredential: vi.fn(async (_options: unknown) => ({ state: 'authorized' })),
        clearCredential: vi.fn(async (_options: unknown) => undefined),
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true },
    registerPlugin: () => ({
        addListener: vi.fn(async (_event: string, listener: (event: unknown) => void) => {
            m.listener = listener;
            return { remove: vi.fn(async () => undefined) };
        }),
        checkCredentialState: m.plugin.checkCredentialState,
        bindCredential: m.plugin.bindCredential,
        clearCredential: m.plugin.clearCredential,
    }),
}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => m.log }));

import {
    bindAppleCredentialUser,
    clearBoundAppleCredential,
    startAppleCredentialRevocationMonitoring,
} from '../services/auth/appleCredentialState';

const APPLE_USER = '001234.SENTINELAPPLEUSER.0099';

beforeEach(() => {
    vi.clearAllMocks();
    m.listener = null;
});

describe('Apple credential revocation report', () => {
    it.each([
        ['sign_in', 'revoked'],
        ['cold_start', 'not_found'],
        ['credential_revoked_notification', 'transferred'],
    ])('reports reason=%s state=%s to Sentry and still hands the event on', async (reason, state) => {
        const onRevoked = vi.fn(async () => undefined);
        await startAppleCredentialRevocationMonitoring(onRevoked);

        m.listener!({ state, reason, userId: APPLE_USER });

        expect(onRevoked).toHaveBeenCalledWith({ state, reason, userId: APPLE_USER });
        const reported = m.log.error.mock.calls.flatMap((args: unknown[]) =>
            args.filter((arg): arg is Error => arg instanceof Error).map((error) => error.message),
        );
        expect(reported).toEqual([`apple_credential_revoked reason=${reason} state=${state}`]);
        expect(JSON.stringify(m.log.error.mock.calls)).not.toContain(APPLE_USER);
    });

    it('reduces anything unexpected from native to a safe token', async () => {
        await startAppleCredentialRevocationMonitoring(vi.fn(async () => undefined));

        m.listener!({ state: `weird ${APPLE_USER}`, reason: 'x'.repeat(200), userId: APPLE_USER });

        const [message] = m.log.error.mock.calls[0];
        expect(message).toMatch(/^apple_credential_revoked reason=x{1,40} state=other$/);
        expect(JSON.stringify(m.log.error.mock.calls)).not.toContain('SENTINEL');
    });

    it('reports a duplicate delivered while the first is being handled only once', async () => {
        let finish!: () => void;
        const onRevoked = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        await startAppleCredentialRevocationMonitoring(onRevoked);

        m.listener!({ state: 'revoked', reason: 'sign_in', userId: APPLE_USER });
        m.listener!({ state: 'revoked', reason: 'sign_in', userId: APPLE_USER });
        finish();

        expect(onRevoked).toHaveBeenCalledOnce();
        expect(m.log.error).toHaveBeenCalledOnce();
    });

    it('hands on another Apple user’s event delivered meanwhile once the first is handled, never dropping it (131-01)', async () => {
        const finish: Array<() => void> = [];
        const onRevoked = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish.push(resolve);
                }),
        );
        await startAppleCredentialRevocationMonitoring(onRevoked);

        // An older build's binding and the signed-in account's, reported together.
        m.listener!({ state: 'revoked', reason: 'cold_start', userId: 'apple-old' });
        m.listener!({ state: 'revoked', reason: 'explicit_check', userId: APPLE_USER });
        expect(onRevoked).toHaveBeenCalledOnce();

        finish[0]();
        await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(2));
        expect(onRevoked.mock.calls[1]).toEqual([{ state: 'revoked', reason: 'explicit_check', userId: APPLE_USER }]);
        finish[1]();
        expect(m.log.error).toHaveBeenCalledTimes(2);
    });
});

describe('one Keychain binding per account (131-01)', () => {
    it('checks the signed-in account’s own binding, naming its Apple subjects for the one-time move', async () => {
        await startAppleCredentialRevocationMonitoring(
            vi.fn(async () => undefined),
            {
                accountId: 'account-a',
                appleUserIds: [APPLE_USER],
            },
        );
        expect(m.plugin.checkCredentialState).toHaveBeenCalledWith({ accountId: 'account-a', userIds: [APPLE_USER] });
    });

    it('with nobody signed in, checks the one binding an older build kept, as before', async () => {
        await startAppleCredentialRevocationMonitoring(vi.fn(async () => undefined));
        expect(m.plugin.checkCredentialState).toHaveBeenCalledWith({});
    });

    it('binds and clears by account, and clears nothing without one', async () => {
        await bindAppleCredentialUser(APPLE_USER, 'account-a');
        expect(m.plugin.bindCredential).toHaveBeenCalledWith({ userId: APPLE_USER, accountId: 'account-a' });

        await clearBoundAppleCredential('account-a');
        expect(m.plugin.clearCredential).toHaveBeenCalledWith({ accountId: 'account-a' });

        m.plugin.clearCredential.mockClear();
        await clearBoundAppleCredential(null);
        await clearBoundAppleCredential('');
        expect(m.plugin.clearCredential).not.toHaveBeenCalled();
    });

    it('still refuses a binding Apple does not call authorized', async () => {
        m.plugin.bindCredential.mockResolvedValueOnce({ state: 'revoked' });
        await expect(bindAppleCredentialUser(APPLE_USER, 'account-a')).rejects.toThrow(
            'Apple credential is not authorized',
        );
    });
});
