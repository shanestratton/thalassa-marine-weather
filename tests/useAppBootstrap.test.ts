import { act, renderHook, waitFor } from '@testing-library/react';
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
    pushForegroundToast: vi.fn(),
    clearBadge: vi.fn(),
    appAddListener: vi.fn(),
    appStateHandler: null as ((state: { isActive: boolean }) => void) | null,
    authUserId: 'bootstrap-user' as string | null,
    authChecked: true,
}));

const pushService = vi.hoisted(() => ({
    onForegroundPush: null as ((notification: { title?: string }) => void) | null,
    onNotificationTap: null as ((data: Readonly<Record<string, unknown>>) => void) | null,
    bindNotificationHandlers: vi.fn(
        (
            _scope: unknown,
            handlers: {
                onForegroundPush: (notification: { title?: string }) => void;
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
vi.mock('../services/vessel', () => ({
    initLocalDatabase: boot.initLocalDatabase,
    startSyncEngine: boot.startSyncEngine,
    stopSyncEngine: boot.stopSyncEngine,
    requestFullReconciliation: boot.requestFullReconciliation,
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
import { setAuthIdentityScope } from '../services/authIdentityScope';

beforeEach(() => {
    vi.clearAllMocks();
    boot.authUserId = 'bootstrap-user';
    boot.authChecked = true;
    setAuthIdentityScope(null);
    setAuthIdentityScope('bootstrap-user');
    boot.currentView = 'dashboard';
    boot.appStateHandler = null;
    pushService.onForegroundPush = null;
    pushService.onNotificationTap = null;
    boot.getUnreadDMCount.mockResolvedValue(7);
    boot.startInternetProbe.mockImplementation(() => boot.stopInternetProbe);
    boot.initLocalDatabase.mockResolvedValue(undefined);
    boot.appAddListener.mockImplementation((_event: string, handler: (state: { isActive: boolean }) => void) => {
        boot.appStateHandler = handler;
        return Promise.resolve({ remove: vi.fn() });
    });
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('useAppBootstrap', () => {
    it('starts app services, routes global events, and cleans up owned callbacks', async () => {
        const { result, rerender, unmount } = renderHook(() => useAppBootstrap());

        await waitFor(() => {
            expect(result.current.chatUnread).toBe(7);
            expect(boot.initGlobalKeyboardScroll).toHaveBeenCalledOnce();
            expect(boot.restoreWatchState).toHaveBeenCalledOnce();
            expect(boot.startInternetProbe).toHaveBeenCalledOnce();
            expect(boot.autoStart).toHaveBeenCalledOnce();
            expect(boot.startSyncEngine).toHaveBeenCalledOnce();
            expect(pushService.onForegroundPush).toBeTypeOf('function');
            expect(pushService.onNotificationTap).toBeTypeOf('function');
            expect(boot.appStateHandler).toBeTypeOf('function');
        });

        act(() => {
            pushService.onForegroundPush?.({ title: 'Gale warning' });
        });
        expect(boot.pushForegroundToast).toHaveBeenCalledWith({ title: 'Gale warning' });

        const destinations: Array<[string, string]> = [
            ['dm', 'chat'],
            ['weather_alert', 'dashboard'],
            ['anchor_alarm', 'map'],
            ['bolo_alert', 'guardian'],
            ['hail', 'guardian'],
            ['unknown', 'dashboard'],
        ];
        act(() => {
            for (const [notification_type] of destinations) {
                pushService.onNotificationTap?.({ notification_type });
            }
        });
        expect(boot.setPage.mock.calls.slice(-destinations.length).map(([page]) => page)).toEqual(
            destinations.map(([, page]) => page),
        );

        boot.clearBadge.mockClear();
        act(() => {
            window.dispatchEvent(new CustomEvent('thalassa:navigate-tab', { detail: { tab: 'log' } }));
            boot.appStateHandler?.({ isActive: false });
            boot.appStateHandler?.({ isActive: true });
        });
        expect(boot.setPage).toHaveBeenCalledWith('log');
        await waitFor(() => expect(boot.clearBadge).toHaveBeenCalledOnce());

        const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
        Object.defineProperty(rejection, 'reason', { value: 'boom' });
        const preventDefault = vi.spyOn(rejection, 'preventDefault');
        act(() => {
            window.dispatchEvent(rejection);
        });
        expect(preventDefault).toHaveBeenCalledOnce();
        await waitFor(() => expect(boot.captureException).toHaveBeenCalledWith(new Error('boom')));

        const input = document.createElement('input');
        const outside = document.createElement('div');
        document.body.append(input, outside);
        input.focus();
        act(() => {
            outside.dispatchEvent(new Event('touchstart', { bubbles: true }));
        });
        expect(document.activeElement).not.toBe(input);
        input.focus();
        act(() => {
            input.dispatchEvent(new Event('touchstart', { bubbles: true }));
        });
        expect(document.activeElement).toBe(input);
        input.remove();
        outside.remove();

        boot.currentView = 'chat';
        rerender();
        expect(result.current.chatUnread).toBe(0);

        unmount();
        await waitFor(() => {
            expect(boot.stopInternetProbe).toHaveBeenCalledOnce();
            // The identity-aware bootstrap first tears down any previous
            // account's engine, then tears down this account on unmount.
            expect(boot.stopSyncEngine).toHaveBeenCalledTimes(2);
            expect(pushService.onForegroundPush).toBeNull();
            expect(pushService.onNotificationTap).toBeNull();
        });
    });

    it('removes a native listener that resolves after unmount', async () => {
        let resolveListener!: (listener: { remove: () => void }) => void;
        const remove = vi.fn();
        boot.appAddListener.mockImplementation((_event: string, handler: (state: { isActive: boolean }) => void) => {
            boot.appStateHandler = handler;
            return new Promise<{ remove: () => void }>((resolve) => {
                resolveListener = resolve;
            });
        });
        const { unmount } = renderHook(() => useAppBootstrap());
        await waitFor(() => expect(boot.appAddListener).toHaveBeenCalledOnce());

        unmount();
        resolveListener({ remove });

        await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    });

    it('hides A unread count immediately and drops its deferred poll after switching to B', async () => {
        let resolveA!: (count: number) => void;
        boot.getUnreadDMCount
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveA = resolve;
                }),
            )
            .mockResolvedValueOnce(3);

        const { result } = renderHook(() => useAppBootstrap());
        await waitFor(() => expect(boot.getUnreadDMCount).toHaveBeenCalledOnce());

        act(() => {
            boot.authUserId = 'bootstrap-user-b';
            setAuthIdentityScope('bootstrap-user-b');
        });

        expect(result.current.chatUnread).toBe(0);
        await waitFor(() => expect(result.current.chatUnread).toBe(3));

        await act(async () => {
            resolveA(9);
        });
        expect(result.current.chatUnread).toBe(3);
    });

    it('does not let a pre-logout database init start the sync engine after the same user signs back in', async () => {
        let resolveOldInit!: () => void;
        boot.initLocalDatabase
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        resolveOldInit = resolve;
                    }),
            )
            .mockResolvedValueOnce(undefined);

        renderHook(() => useAppBootstrap());
        await waitFor(() => expect(boot.initLocalDatabase).toHaveBeenCalledOnce());

        act(() => {
            setAuthIdentityScope(null);
            setAuthIdentityScope('bootstrap-user');
        });

        await waitFor(() => {
            expect(boot.initLocalDatabase).toHaveBeenCalledTimes(2);
            expect(boot.startSyncEngine).toHaveBeenCalledOnce();
        });

        await act(async () => {
            resolveOldInit();
        });
        expect(boot.startSyncEngine).toHaveBeenCalledOnce();
    });
});
