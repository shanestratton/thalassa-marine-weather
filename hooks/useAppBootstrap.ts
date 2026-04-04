/**
 * useAppBootstrap — centralises App-level side-effects.
 *
 * Extracted from App.tsx to reduce the main component's complexity.
 * Each logical concern is a standalone useEffect with its own cleanup.
 */
import { useEffect, useState } from 'react';
import { useUI } from '../context/UIContext';
import { pushForegroundToast } from '../components/PushToast';

export function useAppBootstrap() {
    const { currentView, setPage } = useUI();

    // ── Unread DM badge count ──────────────────────────────────────
    const [chatUnread, setChatUnread] = useState(0);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        import('../services/ChatService').then(({ ChatService }) => {
            const poll = () =>
                ChatService.getUnreadDMCount()
                    .then((n) => setChatUnread(n))
                    .catch(() => {});
            poll();
            timer = setInterval(poll, 30000);
        });
        return () => {
            if (timer) clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        if (currentView === 'chat') setChatUnread(0);
    }, [currentView]);

    // ── Global keyboard scroll ─────────────────────────────────────
    useEffect(() => {
        import('../utils/keyboardScroll').then(({ initGlobalKeyboardScroll }) => {
            initGlobalKeyboardScroll();
        });
    }, []);

    // ── Global unhandled rejection → Sentry ────────────────────────
    useEffect(() => {
        const handler = (event: PromiseRejectionEvent) => {
            event.preventDefault();
            import('../services/sentry').then(({ captureException }) => {
                captureException(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
            });
        };
        window.addEventListener('unhandledrejection', handler);
        return () => window.removeEventListener('unhandledrejection', handler);
    }, []);

    // ── Anchor watch restore ───────────────────────────────────────
    useEffect(() => {
        import('../services/AnchorWatchService').then((m) => m.AnchorWatchService.restoreWatchState()).catch(() => {});
    }, []);

    // ── Signal K auto-reconnect ───────────────────────────────────
    useEffect(() => {
        console.error('[Boot] AvNav: importing service...');
        import('../services/AvNavService')
            .then(({ AvNavService }) => {
                console.error('[Boot] AvNav: imported OK, calling autoStart');
                AvNavService.autoStart();
            })
            .catch((err) => {
                console.error('[Boot] AvNav: IMPORT FAILED:', err?.message || err);
            });
    }, []);

    // ── Local-first DB + sync engine ───────────────────────────────
    useEffect(() => {
        let stopSync: (() => void) | null = null;
        import('../services/vessel').then(({ initLocalDatabase, startSyncEngine, stopSyncEngine }) => {
            initLocalDatabase()
                .then(() => startSyncEngine())
                .catch((e) => console.error('[App] Local DB init failed:', e));
            stopSync = stopSyncEngine;
        });
        return () => {
            stopSync?.();
        };
    }, []);

    // ── Push notification wiring ───────────────────────────────────
    useEffect(() => {
        import('../services/PushNotificationService').then(({ PushNotificationService }) => {
            PushNotificationService.onForegroundPush = (notification) => {
                pushForegroundToast(notification);
            };
            PushNotificationService.onNotificationTap = (data) => {
                const type = data.notification_type as string;
                switch (type) {
                    case 'dm':
                        setPage('chat');
                        break;
                    case 'weather_alert':
                        setPage('dashboard');
                        break;
                    case 'anchor_alarm':
                        setPage('map');
                        break;
                    case 'bolo_alert':
                    case 'suspicious_alert':
                    case 'drag_warning':
                    case 'geofence_alert':
                    case 'hail':
                        setPage('guardian');
                        break;
                    default:
                        setPage('dashboard');
                        break;
                }
            };
        });
        return () => {
            import('../services/PushNotificationService').then(({ PushNotificationService }) => {
                PushNotificationService.onForegroundPush = null;
                PushNotificationService.onNotificationTap = null;
            });
        };
    }, [setPage]);

    // ── Clear badge on foreground ──────────────────────────────────
    useEffect(() => {
        let listener: { remove: () => void } | null = null;
        import('@capacitor/app')
            .then(({ App }) => {
                App.addListener('appStateChange', ({ isActive }) => {
                    if (isActive) {
                        import('../services/PushNotificationService').then(({ PushNotificationService }) => {
                            PushNotificationService.clearBadge();
                        });
                    }
                }).then((l) => {
                    listener = l;
                });
            })
            .catch(() => {});

        import('../services/PushNotificationService').then(({ PushNotificationService }) => {
            PushNotificationService.clearBadge();
        });

        return () => {
            listener?.remove();
        };
    }, []);

    // ── Cross-component tab navigation ─────────────────────────────
    useEffect(() => {
        const onNavigateTab = (e: Event) => {
            const { tab } = (e as CustomEvent).detail;
            if (tab) setPage(tab);
        };
        window.addEventListener('thalassa:navigate-tab', onNavigateTab);
        return () => window.removeEventListener('thalassa:navigate-tab', onNavigateTab);
    }, [setPage]);

    // ── Global keyboard dismiss (iOS) ──────────────────────────────
    useEffect(() => {
        const dismissKeyboard = (e: TouchEvent) => {
            const active = document.activeElement as HTMLElement | null;
            if (!active) return;
            const tag = active.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;

            const target = e.target as HTMLElement;
            const targetTag = target.tagName;
            if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT') return;
            if (target.closest('label')) return;
            if (target.closest('[data-modal-sheet]')) return;

            active.blur();
        };

        document.addEventListener('touchstart', dismissKeyboard, { passive: true });
        return () => document.removeEventListener('touchstart', dismissKeyboard);
    }, []);

    return { chatUnread };
}
