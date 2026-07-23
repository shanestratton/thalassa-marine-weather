import { beforeEach, describe, expect, it, vi } from 'vitest';

type NativeCallback = (payload: any) => void;

const pushMocks = vi.hoisted(() => ({
    callbacks: new Map<string, NativeCallback>(),
    handles: new Map<string, { remove: ReturnType<typeof vi.fn> }>(),
    addListener: vi.fn(),
    checkPermissions: vi.fn(() => Promise.resolve({ receive: 'granted' })),
    requestPermissions: vi.fn(() => Promise.resolve({ receive: 'granted' })),
    register: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
    removeAllDeliveredNotifications: vi.fn(() => Promise.resolve()),
}));

const dbMocks = vi.hoisted(() => ({
    remoteUserId: 'account-a' as string | null,
    getUser: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
    },
}));

vi.mock('@capacitor/push-notifications', () => ({
    PushNotifications: {
        addListener: pushMocks.addListener,
        checkPermissions: pushMocks.checkPermissions,
        requestPermissions: pushMocks.requestPermissions,
        register: pushMocks.register,
        unregister: pushMocks.unregister,
        removeAllDeliveredNotifications: pushMocks.removeAllDeliveredNotifications,
    },
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: dbMocks.getUser },
        rpc: dbMocks.rpc,
    },
}));

async function loadService(userId = 'account-a') {
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope(userId);
    dbMocks.remoteUserId = userId;
    const { PushNotificationService } = await import('../services/PushNotificationService');
    await PushNotificationService.initialize();
    await PushNotificationService.setUser(userId);
    return { identity, service: PushNotificationService };
}

async function switchUser(
    identity: Awaited<ReturnType<typeof loadService>>['identity'],
    service: Awaited<ReturnType<typeof loadService>>['service'],
    userId: string,
): Promise<void> {
    identity.setAuthIdentityScope(userId);
    dbMocks.remoteUserId = userId;
    await service.setUser(userId);
}

function emit(event: string, payload: unknown): void {
    const callback = pushMocks.callbacks.get(event);
    if (!callback) throw new Error(`${event} listener was not installed`);
    callback(payload);
}

function emitRegistration(token = 'device-token-that-is-long-enough'): void {
    emit('registration', { value: token });
}

beforeEach(() => {
    vi.resetModules();
    pushMocks.addListener.mockReset();
    pushMocks.checkPermissions.mockReset();
    pushMocks.requestPermissions.mockReset();
    pushMocks.register.mockReset();
    pushMocks.unregister.mockReset();
    pushMocks.removeAllDeliveredNotifications.mockReset();
    dbMocks.getUser.mockReset();
    dbMocks.rpc.mockReset();
    pushMocks.callbacks.clear();
    pushMocks.handles.clear();
    dbMocks.remoteUserId = 'account-a';
    pushMocks.checkPermissions.mockResolvedValue({ receive: 'granted' });
    pushMocks.requestPermissions.mockResolvedValue({ receive: 'granted' });
    pushMocks.register.mockResolvedValue(undefined);
    pushMocks.unregister.mockResolvedValue(undefined);
    pushMocks.removeAllDeliveredNotifications.mockResolvedValue(undefined);
    pushMocks.addListener.mockImplementation((event: string, callback: NativeCallback) => {
        const handle = { remove: vi.fn(() => Promise.resolve()) };
        pushMocks.callbacks.set(event, callback);
        pushMocks.handles.set(event, handle);
        return Promise.resolve(handle);
    });
    dbMocks.getUser.mockImplementation(() =>
        Promise.resolve({
            data: { user: dbMocks.remoteUserId ? { id: dbMocks.remoteUserId } : null },
            error: null,
        }),
    );
    dbMocks.rpc.mockResolvedValue({ data: true, error: null });
});

describe('PushNotificationService identity ownership', () => {
    it('installs native listeners only once when initialize calls overlap', async () => {
        const identity = await import('../services/authIdentityScope');
        identity.setAuthIdentityScope('account-a');
        const { PushNotificationService } = await import('../services/PushNotificationService');

        await Promise.all([PushNotificationService.initialize(), PushNotificationService.initialize()]);

        expect(pushMocks.addListener).toHaveBeenCalledTimes(4);
        expect([...pushMocks.callbacks.keys()]).toEqual([
            'registration',
            'registrationError',
            'pushNotificationReceived',
            'pushNotificationActionPerformed',
        ]);
    });

    it('physically removes a partially installed listener when initialization fails', async () => {
        const firstHandle = { remove: vi.fn(() => Promise.resolve()) };
        pushMocks.addListener
            .mockResolvedValueOnce(firstHandle)
            .mockRejectedValueOnce(new Error('native listener unavailable'));
        const { PushNotificationService } = await import('../services/PushNotificationService');

        await expect(PushNotificationService.initialize()).resolves.toBeUndefined();

        expect(firstHandle.remove).toHaveBeenCalledOnce();
    });

    it('dispose physically removes every native listener', async () => {
        const { service } = await loadService();

        await service.dispose();

        expect([...pushMocks.handles.values()].every((handle) => handle.remove.mock.calls.length === 1)).toBe(true);
    });

    it('serializes account claims and transfers one opaque token atomically from A to B', async () => {
        const { identity, service } = await loadService();
        let resolveAccountA!: (result: { data: true; error: null }) => void;
        dbMocks.rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveAccountA = resolve;
                }),
        );

        emitRegistration();
        await vi.waitFor(() => expect(dbMocks.rpc).toHaveBeenCalledOnce());

        identity.setAuthIdentityScope('account-b');
        dbMocks.remoteUserId = 'account-b';
        const switching = service.setUser('account-b');
        await Promise.resolve();
        expect(dbMocks.rpc).toHaveBeenCalledOnce();

        resolveAccountA({ data: true, error: null });
        await switching;

        expect(dbMocks.rpc.mock.calls).toEqual([
            [
                'claim_push_device_token',
                {
                    p_expected_user_id: 'account-a',
                    p_device_token: 'device-token-that-is-long-enough',
                    p_platform: 'ios',
                },
            ],
            [
                'claim_push_device_token',
                {
                    p_expected_user_id: 'account-b',
                    p_device_token: 'device-token-that-is-long-enough',
                    p_platform: 'ios',
                },
            ],
        ]);
        expect(Object.isFrozen(dbMocks.rpc.mock.calls[1][1])).toBe(true);
    });

    it('quarantines a late native registration callback initiated by A after B becomes current', async () => {
        const { identity, service } = await loadService();

        const registration = service.requestPermissionAndRegister();
        await vi.waitFor(() => expect(pushMocks.register).toHaveBeenCalledOnce());
        await switchUser(identity, service, 'account-b');
        await expect(registration).resolves.toBeNull();

        emitRegistration('late-account-a-device-token');

        await Promise.resolve();
        expect(dbMocks.rpc).not.toHaveBeenCalled();
    });

    it('abandons a permission request when its exact auth generation changes', async () => {
        const { identity, service } = await loadService();
        let resolvePermission!: (value: { receive: 'granted' }) => void;
        pushMocks.checkPermissions.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolvePermission = resolve;
                }),
        );

        const registration = service.requestPermissionAndRegister();
        await vi.waitFor(() => expect(pushMocks.checkPermissions).toHaveBeenCalledOnce());
        await switchUser(identity, service, 'account-b');
        resolvePermission({ receive: 'granted' });

        await expect(registration).resolves.toBeNull();
        expect(pushMocks.register).not.toHaveBeenCalled();
        expect(dbMocks.rpc).not.toHaveBeenCalled();
    });

    it('returns null instead of reporting a token whose server claim failed', async () => {
        const { service } = await loadService();
        dbMocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { message: 'claim refused' },
        });

        const registration = service.requestPermissionAndRegister();
        await vi.waitFor(() => expect(pushMocks.register).toHaveBeenCalledOnce());
        emitRegistration();

        await expect(registration).resolves.toBeNull();
    });

    it('verifies the remote user before an owner-bound token claim', async () => {
        const { service } = await loadService();
        dbMocks.remoteUserId = 'different-remote-account';

        const registration = service.requestPermissionAndRegister();
        await vi.waitFor(() => expect(pushMocks.register).toHaveBeenCalledOnce());
        emitRegistration();

        await expect(registration).resolves.toBeNull();
        expect(dbMocks.getUser).toHaveBeenCalled();
        expect(dbMocks.rpc).not.toHaveBeenCalled();
    });

    it('releases the captured prior owner during logout with immutable expected-user arguments', async () => {
        const { identity, service } = await loadService();
        emitRegistration();
        await vi.waitFor(() => expect(dbMocks.rpc).toHaveBeenCalledOnce());
        dbMocks.rpc.mockClear();

        identity.setAuthIdentityScope(null);
        await service.clearUser();

        expect(dbMocks.rpc).toHaveBeenCalledWith('release_push_device_token', {
            p_expected_user_id: 'account-a',
            p_device_token: 'device-token-that-is-long-enough',
        });
        expect(Object.isFrozen(dbMocks.rpc.mock.calls[0][1])).toBe(true);
    });

    it('unregisters native push and removes delivered notifications even when this cold process has no token', async () => {
        const { identity, service } = await loadService();

        identity.setAuthIdentityScope(null);
        await service.clearUser();

        expect(pushMocks.unregister).toHaveBeenCalledOnce();
        expect(pushMocks.removeAllDeliveredNotifications).toHaveBeenCalledOnce();
        expect(dbMocks.rpc).not.toHaveBeenCalled();
        expect(service.getToken()).toBeNull();
    });

    it('allows logout when native unregister succeeds even if the server release is offline', async () => {
        const { identity, service } = await loadService();
        emitRegistration();
        await vi.waitFor(() => expect(dbMocks.rpc).toHaveBeenCalledOnce());
        dbMocks.rpc.mockReset();
        dbMocks.rpc.mockRejectedValueOnce(new Error('offline'));

        identity.setAuthIdentityScope(null);
        await expect(service.clearUser()).resolves.toBeUndefined();

        expect(pushMocks.unregister).toHaveBeenCalledOnce();
        expect(service.getToken()).toBeNull();
    });

    it('rejects logout isolation when both server release and native unregister fail', async () => {
        const { identity, service } = await loadService();
        emitRegistration();
        await vi.waitFor(() => expect(dbMocks.rpc).toHaveBeenCalledOnce());
        dbMocks.rpc.mockReset();
        dbMocks.rpc.mockRejectedValueOnce(new Error('server offline'));
        pushMocks.unregister.mockRejectedValueOnce(new Error('native unregister failed'));

        identity.setAuthIdentityScope(null);
        await expect(service.clearUser()).rejects.toThrow('could not be isolated');

        expect(service.getToken()).toBe('device-token-that-is-long-enough');
    });

    it('settles the matching registration waiter immediately on a native registration error', async () => {
        const { service } = await loadService();

        const registration = service.requestPermissionAndRegister();
        await vi.waitFor(() => expect(pushMocks.register).toHaveBeenCalledOnce());
        emit('registrationError', { message: 'APNs unavailable' });

        await expect(registration).resolves.toBeNull();
    });

    it('ignores malformed native token callbacks instead of poisoning later account binding', async () => {
        const { service } = await loadService();

        emitRegistration('short token');
        await Promise.resolve();

        expect(service.getToken()).toBeNull();
        expect(dbMocks.rpc).not.toHaveBeenCalled();
    });

    it('claims a rotated token before releasing the exact previous token', async () => {
        await loadService();
        emitRegistration('first-device-token-that-is-long-enough');
        await vi.waitFor(() => expect(dbMocks.rpc).toHaveBeenCalledOnce());
        dbMocks.rpc.mockClear();

        emitRegistration('second-device-token-that-is-long-enough');
        await vi.waitFor(() => expect(dbMocks.rpc).toHaveBeenCalledTimes(2));

        expect(dbMocks.rpc.mock.calls).toEqual([
            [
                'claim_push_device_token',
                {
                    p_expected_user_id: 'account-a',
                    p_device_token: 'second-device-token-that-is-long-enough',
                    p_platform: 'ios',
                },
            ],
            [
                'release_push_device_token',
                {
                    p_expected_user_id: 'account-a',
                    p_device_token: 'first-device-token-that-is-long-enough',
                },
            ],
        ]);
    });

    it('rejects a setUser call that does not exactly match AuthIdentityScope', async () => {
        const { service } = await loadService();

        await expect(service.setUser('account-b')).rejects.toThrow('current auth identity scope');
    });

    it('drops A foreground and tap bindings in B, then accepts freshly bound B handlers', async () => {
        const { identity, service } = await loadService();
        const foregroundA = vi.fn();
        const tapA = vi.fn();
        const scopeA = identity.getAuthIdentityScope();
        const cleanupA = service.bindNotificationHandlers(scopeA, {
            onForegroundPush: foregroundA,
            onNotificationTap: tapA,
        });

        await switchUser(identity, service, 'account-b');
        emit('pushNotificationReceived', {
            title: 'private A warning',
            body: 'for A',
            data: { notification_type: 'dm' },
        });
        emit('pushNotificationActionPerformed', {
            notification: { data: { notification_type: 'dm' } },
        });
        expect(foregroundA).not.toHaveBeenCalled();
        expect(tapA).not.toHaveBeenCalled();

        const foregroundB = vi.fn();
        const tapB = vi.fn();
        const cleanupB = service.bindNotificationHandlers(identity.getAuthIdentityScope(), {
            onForegroundPush: foregroundB,
            onNotificationTap: tapB,
        });
        cleanupA();
        const nativeForegroundData = { notification_type: 'weather_alert' };
        emit('pushNotificationReceived', {
            title: 'B warning',
            body: 'for B',
            data: nativeForegroundData,
        });
        emit('pushNotificationActionPerformed', {
            notification: { data: { notification_type: 'weather_alert' } },
        });

        expect(foregroundB).toHaveBeenCalledOnce();
        expect(tapB).toHaveBeenCalledOnce();
        expect(Object.isFrozen(foregroundB.mock.calls[0][0])).toBe(true);
        expect(Object.isFrozen(foregroundB.mock.calls[0][0].data)).toBe(true);
        expect(Object.isFrozen(tapB.mock.calls[0][0])).toBe(true);
        expect(foregroundB.mock.calls[0][0].data).not.toBe(nativeForegroundData);

        cleanupB();
        emit('pushNotificationReceived', { title: 'after cleanup' });
        expect(foregroundB).toHaveBeenCalledOnce();
    });

    it('refuses handler installation with a stale explicit scope', async () => {
        const { identity, service } = await loadService();
        const staleScope = identity.getAuthIdentityScope();
        await switchUser(identity, service, 'account-b');
        const foreground = vi.fn();

        service.bindNotificationHandlers(staleScope, {
            onForegroundPush: foreground,
            onNotificationTap: vi.fn(),
        });
        emit('pushNotificationReceived', { title: 'B notification' });

        expect(foreground).not.toHaveBeenCalled();
    });

    it('does not let an A badge clear continue after the scope switches to B', async () => {
        const { identity, service } = await loadService();
        emitRegistration();
        await vi.waitFor(() => expect(dbMocks.rpc).toHaveBeenCalledOnce());
        dbMocks.rpc.mockClear();

        let resolveRemoteUser!: (result: { data: { user: { id: string } }; error: null }) => void;
        dbMocks.getUser.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveRemoteUser = resolve;
                }),
        );
        const clearing = service.clearBadge();
        identity.setAuthIdentityScope('account-b');
        dbMocks.remoteUserId = 'account-b';
        resolveRemoteUser({ data: { user: { id: 'account-a' } }, error: null });

        await clearing;
        expect(pushMocks.removeAllDeliveredNotifications).not.toHaveBeenCalled();
        expect(dbMocks.rpc).not.toHaveBeenCalled();
    });
});
