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
    watchSharedBinderLoss: vi.fn(),
    stopSharedBinderLoss: vi.fn(),
    pushForegroundToast: vi.fn(),
    clearBadge: vi.fn(),
    appAddListener: vi.fn(),
    appStateHandler: null as ((state: { isActive: boolean }) => void) | null,
    authUserId: 'bootstrap-user' as string | null,
    authChecked: true,
    startPiAlarmCloud: vi.fn(),
}));

const pushService = vi.hoisted(() => ({
    onForegroundPush: null as ((notification: { title?: string; data?: Record<string, unknown> }) => void) | null,
    onNotificationTap: null as ((data: Readonly<Record<string, unknown>>) => void) | null,
    bindNotificationHandlers: vi.fn(
        (
            _scope: unknown,
            handlers: {
                onForegroundPush: (notification: { title?: string; data?: Record<string, unknown> }) => void;
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
// The Pi's cloud alarm link (126-04b), started by a push from the Pi.
vi.mock('../services/piNightWatch', () => ({
    startPiAlarmCloud: boot.startPiAlarmCloud,
    startPiNightWatch: vi.fn(() => () => undefined),
}));
vi.mock('@capacitor/app', () => ({
    App: {
        addListener: boot.appAddListener,
    },
}));

import { useAppBootstrap } from '../hooks/useAppBootstrap';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { AisGuardAlertStore } from '../services/aisGuardAlertStore';
import { PiNightWatchStatus } from '../services/piNightWatchStatus';

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
    boot.watchSharedBinderLoss.mockImplementation(() => boot.stopSharedBinderLoss);
    boot.appAddListener.mockImplementation((_event: string, handler: (state: { isActive: boolean }) => void) => {
        // Keep the FIRST registration. Two things listen for appStateChange
        // now — the bootstrap itself and webContentKill's session watch — and
        // a mock that keeps the last one silently hands these tests the wrong
        // handler, which reads as the bootstrap having stopped working.
        boot.appStateHandler = boot.appStateHandler ?? handler;
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
            // Changes to a skipper's binder a sync could not keep get a toast.
            expect(boot.watchSharedBinderLoss).toHaveBeenCalledOnce();
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
            // 'compass' = the anchor-watch page (alarm UI + silence control);
            // 'map' had no alarm surface at all (2026-08-03 audit fix).
            ['anchor_alarm', 'compass'],
            // Guardian shipped 2026-08-06 (its presence-privacy migration
            // closed the hold), so a bolo now routes to the page itself.
            ['bolo_alert', 'guardian'],
            ['hail', 'guardian'],
            ['unknown', 'dashboard'],
        ];
        act(() => {
            for (const [notification_type] of destinations) {
                pushService.onNotificationTap?.({ notification_type });
            }
        });
        const routedPages = boot.setPage.mock.calls.slice(-destinations.length).map(([page]) => page);
        expect(routedPages).toEqual(destinations.map(([, page]) => page));
        expect(routedPages.slice(3, 5)).toEqual(['guardian', 'guardian']);

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
            expect(boot.stopSharedBinderLoss).toHaveBeenCalledOnce();
            expect(pushService.onForegroundPush).toBeNull();
            expect(pushService.onNotificationTap).toBeNull();
        });
    });

    it('a push from the Pi opens the chart with its card; in the foreground, no toast for a card already shown', async () => {
        // Build 126 (126-04b). Fictional: Nordlicht 211000001, Bay Runner 366000002, a SART 970000003.
        PiNightWatchStatus.__resetForTests();
        AisGuardAlertStore.clear();
        renderHook(() => useAppBootstrap());
        await waitFor(() => expect(pushService.onNotificationTap).toBeTypeOf('function'));
        const raisedAt = Date.now() - 60_000;
        const nordlicht = {
            notification_type: 'collision_alarm',
            kind: 'collision',
            alarm_key: `collision:211000001:${raisedAt}`,
            mmsi: 211000001,
            name: 'NORDLICHT',
            cpa_nm: 0.08,
            tcpa_min: 4.2,
            range_nm: 1.6,
            bearing_deg: 312,
        };
        act(() => pushService.onNotificationTap?.(nordlicht));
        expect(boot.setPage).toHaveBeenLastCalledWith('map');
        expect(PiNightWatchStatus.piCards().map((c) => c.key)).toEqual([nordlicht.alarm_key]);
        await waitFor(() => expect(boot.startPiAlarmCloud).toHaveBeenCalled());

        act(() =>
            pushService.onNotificationTap?.({
                notification_type: 'distress_alarm',
                kind: 'distress',
                alarm_key: `distress:970000003:${raisedAt}`,
                mmsi: 970000003,
                name: '',
                distress_kind: 'sart',
                position_known: false,
            }),
        );
        expect(boot.setPage).toHaveBeenLastCalledWith('map');
        act(() => pushService.onNotificationTap?.({ notification_type: 'pi_watch_notice', kind: 'test' }));
        expect(boot.setPage).toHaveBeenLastCalledWith('map');

        // Foreground: Nordlicht is already a card here, so no toast over it.
        boot.pushForegroundToast.mockClear();
        act(() => pushService.onForegroundPush?.({ title: 'Collision risk: NORDLICHT', data: nordlicht }));
        expect(boot.pushForegroundToast).not.toHaveBeenCalled();
        // A vessel this phone has no card for: the toast, and a card from the Pi.
        const bayRunner = {
            ...nordlicht,
            alarm_key: `collision:366000002:${raisedAt}`,
            mmsi: 366000002,
            name: 'BAY RUNNER',
        };
        act(() => pushService.onForegroundPush?.({ title: 'Collision risk: BAY RUNNER', data: bayRunner }));
        expect(boot.pushForegroundToast).toHaveBeenCalledOnce();
        expect(PiNightWatchStatus.piCards().map((c) => c.mmsi)).toContain(366000002);
        PiNightWatchStatus.__resetForTests();
    });

    it('removes every native listener that resolves after unmount', async () => {
        // TWO registrations since 2026-08-09: the bootstrap's own, plus the
        // one webContentKill needs because WKWebView does not reliably fire
        // visibilitychange when a Capacitor app backgrounds. Both are promises
        // that can resolve after teardown, and BOTH must still be removed —
        // this test caught the second one leaking when it was added.
        const resolvers: ((listener: { remove: () => void }) => void)[] = [];
        const remove = vi.fn();
        boot.appAddListener.mockImplementation((_event: string, handler: (state: { isActive: boolean }) => void) => {
            boot.appStateHandler = handler;
            return new Promise<{ remove: () => void }>((resolve) => {
                resolvers.push(resolve);
            });
        });
        const { unmount } = renderHook(() => useAppBootstrap());
        await waitFor(() => expect(boot.appAddListener).toHaveBeenCalledTimes(2));

        unmount();
        for (const resolve of resolvers) resolve({ remove });

        await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
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
