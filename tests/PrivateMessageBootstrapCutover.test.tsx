/** Mocked bootstrap callbacks only; no live push, Auth or physical safety-device evidence. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
    currentView: 'dashboard',
    setPage: vi.fn(),
    getUnreadDMCount: vi.fn(),
    initGlobalKeyboardScroll: vi.fn(),
    captureException: vi.fn(),
    restoreWatchState: vi.fn(),
    stopInternetProbe: vi.fn(),
    startInternetProbe: vi.fn(),
    autoStart: vi.fn(),
    initLocalDatabase: vi.fn(),
    startSyncEngine: vi.fn(),
    stopSyncEngine: vi.fn(),
    requestFullReconciliation: vi.fn(),
    watchSharedBinderLoss: vi.fn(),
    stopSharedBinderLoss: vi.fn(),
    pushForegroundToast: vi.fn(),
    clearBadge: vi.fn(),
    receiveSafetyPush: vi.fn(),
    appAddListener: vi.fn(),
    appStateHandler: null as ((state: { isActive: boolean }) => void) | null,
    authUserId: 'bootstrap-user' as string | null,
    authChecked: true,
}));

const pushService = vi.hoisted(() => ({
    onForegroundPush: null as
        | ((notification: { title?: string; body?: string; data?: Record<string, unknown> }) => void)
        | null,
    onNotificationTap: null as ((data: Readonly<Record<string, unknown>>) => void) | null,
    bindNotificationHandlers: vi.fn(
        (
            _scope: unknown,
            handlers: {
                onForegroundPush: (notification: {
                    title?: string;
                    body?: string;
                    data?: Record<string, unknown>;
                }) => void;
                onNotificationTap: (data: Readonly<Record<string, unknown>>) => void;
            },
        ) => {
            const foreground = handlers.onForegroundPush;
            const tap = handlers.onNotificationTap;
            pushService.onForegroundPush = foreground;
            pushService.onNotificationTap = tap;
            return () => {
                if (pushService.onForegroundPush === foreground) pushService.onForegroundPush = null;
                if (pushService.onNotificationTap === tap) pushService.onNotificationTap = null;
            };
        },
    ),
    initialize: vi.fn(),
    setUser: vi.fn(),
    clearUser: vi.fn(),
    clearBadge: boot.clearBadge,
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ currentView: boot.currentView, setPage: boot.setPage }),
}));
vi.mock('../components/PushToast', () => ({ pushForegroundToast: boot.pushForegroundToast }));
vi.mock('../services/ChatService', () => ({
    ChatService: { getUnreadDMCount: boot.getUnreadDMCount },
}));
vi.mock('../utils/keyboardScroll', () => ({ initGlobalKeyboardScroll: boot.initGlobalKeyboardScroll }));
vi.mock('../services/sentry', () => ({
    captureException: boot.captureException,
    addBreadcrumb: vi.fn(),
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { restoreWatchState: boot.restoreWatchState },
}));
vi.mock('../services/internetProbe', () => ({ startInternetProbe: boot.startInternetProbe }));
vi.mock('../services/AvNavService', () => ({ AvNavService: { autoStart: boot.autoStart } }));
vi.mock('../services/InstrumentSourcePolicy', () => ({ InstrumentSourcePolicy: { boot: vi.fn() } }));
vi.mock('../services/vessel', () => ({
    initLocalDatabase: boot.initLocalDatabase,
    startSyncEngine: boot.startSyncEngine,
    stopSyncEngine: boot.stopSyncEngine,
    requestFullReconciliation: boot.requestFullReconciliation,
    watchSharedBinderLoss: boot.watchSharedBinderLoss,
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { authChecked: boolean; user: { id: string } | null }) => unknown) =>
        selector({
            authChecked: boot.authChecked,
            user: boot.authUserId ? { id: boot.authUserId } : null,
        }),
}));
vi.mock('../services/PushNotificationService', () => ({ PushNotificationService: pushService }));
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: boot.appAddListener,
    },
}));

import { useAppBootstrap } from '../hooks/useAppBootstrap';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

import type { PrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';
const policySlot = vi.hoisted(() => ({ policy: null as PrivateMessageCutoverPolicy | null }));
vi.mock('../services/chat/e2ee/privateMessageCutover', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/chat/e2ee/privateMessageCutover')>();
    return {
        ...actual,
        captureLegacyPrivateMessagePermit: (
            ...args: Parameters<PrivateMessageCutoverPolicy['captureLegacyPrivateMessagePermit']>
        ) => policySlot.policy!.captureLegacyPrivateMessagePermit(...args),
        isLegacyPrivateMessagePermitCurrent: (permit: unknown) =>
            policySlot.policy!.isLegacyPrivateMessagePermitCurrent(permit),
        subscribePrivateMessageCutover: (listener: () => void) =>
            policySlot.policy!.subscribePrivateMessageCutover(listener),
    };
});
import { createPrivateMessageCutoverPolicy } from '../services/chat/e2ee/privateMessageCutover';

vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: { receivePush: boot.receiveSafetyPush },
}));

beforeEach(() => {
    vi.clearAllMocks();
    boot.authUserId = 'bootstrap-user';
    boot.authChecked = true;
    boot.currentView = 'dashboard';
    setAuthIdentityScope(null);
    setAuthIdentityScope('bootstrap-user');
    policySlot.policy = createPrivateMessageCutoverPolicy(getAuthIdentityScope);
    pushService.onForegroundPush = null;
    pushService.onNotificationTap = null;
    boot.appStateHandler = null;
    boot.getUnreadDMCount.mockResolvedValue(7);
    boot.startInternetProbe.mockImplementation(() => boot.stopInternetProbe);
    boot.initLocalDatabase.mockResolvedValue(undefined);
    boot.watchSharedBinderLoss.mockImplementation(() => boot.stopSharedBinderLoss);
    boot.appAddListener.mockResolvedValue({ remove: vi.fn() });
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
});
function requireNative() {
    return policySlot.policy!.requireNativePrivateMessagesForScope(getAuthIdentityScope());
}

describe('bootstrap private badge and navigation cutover fixtures', () => {
    it('clears the badge and refuses a held same-auth unread result after cutover', async () => {
        let resolve!: (value: number) => void;
        const held = new Promise<number>((done) => {
            resolve = done;
        });
        boot.getUnreadDMCount.mockReturnValueOnce(held);
        const { result } = renderHook(() => useAppBootstrap());
        await waitFor(() => expect(boot.getUnreadDMCount).toHaveBeenCalledTimes(1));
        act(() => requireNative());
        await act(async () => {
            resolve(53);
            await held;
        });
        expect(result.current.chatUnread).toBe(0);
        expect(boot.getUnreadDMCount).toHaveBeenCalledTimes(1);
    });
    it('suppresses only dm/hail captured handlers while keeping anchor and weather navigation', async () => {
        renderHook(() => useAppBootstrap());
        await waitFor(() => expect(pushService.onNotificationTap).toBeTypeOf('function'));
        const foreground = pushService.onForegroundPush!,
            tap = pushService.onNotificationTap!;
        const originalScope = getAuthIdentityScope();
        act(() => {
            foreground({ body: 'Default private body', data: { notification_type: 'dm' } });
            tap({ notification_type: 'dm' });
        });
        expect(boot.pushForegroundToast).toHaveBeenCalledWith(
            { body: 'Default private body', data: { notification_type: 'dm' } },
            originalScope,
        );
        expect(boot.setPage).toHaveBeenCalledWith('chat');
        act(() => requireNative());
        boot.pushForegroundToast.mockClear();
        boot.setPage.mockClear();
        act(() => {
            for (const notification_type of ['dm', 'hail']) {
                foreground({ body: 'Refused private body', data: { notification_type } });
                tap({ notification_type });
            }
        });
        expect(boot.pushForegroundToast).not.toHaveBeenCalled();
        expect(boot.setPage).not.toHaveBeenCalled();
        act(() => {
            foreground({ body: 'Anchor safety body', data: { notification_type: 'anchor_alarm' } });
            tap({ notification_type: 'anchor_alarm' });
            tap({ notification_type: 'weather_alert' });
        });
        expect(boot.receiveSafetyPush).toHaveBeenCalledTimes(1);
        expect(boot.pushForegroundToast).toHaveBeenCalledWith({
            body: 'Anchor safety body',
            data: { notification_type: 'anchor_alarm' },
        });
        expect(boot.setPage.mock.calls.map(([page]) => page)).toEqual(['compass', 'dashboard']);
    });
    it('does not begin aggregate badge reads after a different account selected native', async () => {
        setAuthIdentityScope('native-other');
        requireNative();
        setAuthIdentityScope('bootstrap-user');
        const { result } = renderHook(() => useAppBootstrap());
        await waitFor(() => expect(pushService.onNotificationTap).toBeTypeOf('function'));
        expect(boot.getUnreadDMCount).not.toHaveBeenCalled();
        expect(result.current.chatUnread).toBe(0);
        act(() => pushService.onNotificationTap!({ notification_type: 'hail' }));
        expect(boot.setPage).not.toHaveBeenCalled();
    });
});
