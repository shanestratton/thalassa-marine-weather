import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    pushForegroundToast: vi.fn(),
    clearBadge: vi.fn(),
    appAddListener: vi.fn(),
    appStateHandler: null as ((state: { isActive: boolean }) => void) | null,
}));

const pushService = vi.hoisted(() => ({
    onForegroundPush: null as ((notification: { title?: string }) => void) | null,
    onNotificationTap: null as ((data: Record<string, unknown>) => void) | null,
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
}));
vi.mock('../services/PushNotificationService', () => ({ PushNotificationService: pushService }));
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: boot.appAddListener,
    },
}));

import { useAppBootstrap } from '../hooks/useAppBootstrap';

beforeEach(() => {
    vi.clearAllMocks();
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
            expect(boot.stopSyncEngine).toHaveBeenCalledOnce();
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
});
