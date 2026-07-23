/**
 * useAppBootstrap — centralises App-level side-effects.
 *
 * Extracted from App.tsx to reduce the main component's complexity.
 * Each logical concern is a standalone useEffect with its own cleanup.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useUI } from '../context/UIContext';
import { pushForegroundToast } from '../components/PushToast';
import { useAuthStore } from '../stores/authStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const subscribeIdentitySnapshot = (notify: () => void): (() => void) => subscribeAuthIdentityScope(() => notify());
const getIdentitySnapshot = (): AuthIdentityScope => getAuthIdentityScope();

export function useAppBootstrap() {
    const { currentView, setPage } = useUI();
    const authChecked = useAuthStore((state) => state.authChecked);
    const authenticatedUserId = useAuthStore((state) => state.user?.id ?? null);
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getIdentitySnapshot, getIdentitySnapshot);
    const activeUserId = authenticatedUserId === identityScope.userId ? authenticatedUserId : null;

    // ── Unread DM badge count ──────────────────────────────────────
    const [chatUnreadState, setChatUnreadState] = useState<{
        scope: AuthIdentityScope;
        count: number;
    }>(() => ({ scope: identityScope, count: 0 }));
    const chatUnread =
        activeUserId &&
        chatUnreadState.scope.key === identityScope.key &&
        chatUnreadState.scope.generation === identityScope.generation &&
        isAuthIdentityScopeCurrent(chatUnreadState.scope)
            ? chatUnreadState.count
            : 0;

    useEffect(() => {
        const actionScope = identityScope;
        let active = true;
        let timer: ReturnType<typeof setInterval> | null = null;
        let requestEpoch = 0;
        setChatUnreadState({ scope: actionScope, count: 0 });
        if (!authChecked || !activeUserId || !isAuthIdentityScopeCurrent(actionScope)) {
            return () => {
                active = false;
            };
        }
        import('../services/ChatService').then(({ ChatService }) => {
            if (!active || !isAuthIdentityScopeCurrent(actionScope)) return;
            const poll = () => {
                const pollEpoch = ++requestEpoch;
                return ChatService.getUnreadDMCount()
                    .then((n) => {
                        if (active && pollEpoch === requestEpoch && isAuthIdentityScopeCurrent(actionScope)) {
                            setChatUnreadState({ scope: actionScope, count: n });
                        }
                    })
                    .catch(() => {});
            };
            poll();
            timer = setInterval(poll, 30000);
        });
        return () => {
            active = false;
            requestEpoch++;
            if (timer) clearInterval(timer);
        };
    }, [activeUserId, authChecked, identityScope]);

    useEffect(() => {
        if (currentView === 'chat' && isAuthIdentityScopeCurrent(identityScope)) {
            setChatUnreadState({ scope: identityScope, count: 0 });
        }
    }, [currentView, identityScope]);

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
        if (!authChecked || authenticatedUserId !== identityScope.userId) return;
        const actionScope = identityScope;
        let active = true;
        import('../services/AnchorWatchService')
            .then((m) => {
                if (active && isAuthIdentityScopeCurrent(actionScope)) {
                    return m.AnchorWatchService.restoreWatchState();
                }
                return undefined;
            })
            .catch(() => {});
        return () => {
            active = false;
        };
    }, [authChecked, authenticatedUserId, identityScope]);

    // ── Internet reachability probe ────────────────────────────────
    // `navigator.onLine` can't tell "have WiFi" apart from "have WAN" —
    // critical when the user's Pi is serving cached weather over a LAN
    // whose uplink is down. The probe hits a public 204 endpoint and
    // flips uiStore.isOffline → true when the WAN isn't actually
    // reachable, so the staleness banner shows.
    useEffect(() => {
        let active = true;
        let stop: (() => void) | null = null;
        import('../services/internetProbe').then(({ startInternetProbe }) => {
            const started = startInternetProbe();
            if (active) stop = started;
            else started();
        });
        return () => {
            active = false;
            stop?.();
        };
    }, []);

    // ── Signal K auto-reconnect ───────────────────────────────────
    useEffect(() => {
        console.info('[Boot] AvNav: importing service...');
        import('../services/AvNavService')
            .then(({ AvNavService }) => {
                console.info('[Boot] AvNav: imported OK, calling autoStart');
                AvNavService.autoStart();
            })
            .catch((err) => {
                console.error('[Boot] AvNav: IMPORT FAILED:', err?.message || err);
            });
    }, []);

    // ── Local-first DB + sync engine ───────────────────────────────
    useEffect(() => {
        const actionScope = identityScope;
        if (!authChecked || authenticatedUserId !== actionScope.userId || !isAuthIdentityScopeCurrent(actionScope)) {
            return;
        }

        let active = true;
        let stopSync: (() => void) | null = null;
        import('../services/vessel')
            .then(({ initLocalDatabase, startSyncEngine, stopSyncEngine, requestFullReconciliation }) => {
                // A superseded dynamic import must never stop B's newly
                // started singleton engine.
                if (!active || !isAuthIdentityScopeCurrent(actionScope)) return;
                stopSync = stopSyncEngine;
                stopSyncEngine();

                initLocalDatabase(actionScope.userId)
                    .then(() => {
                        if (!active || !actionScope.userId || !isAuthIdentityScopeCurrent(actionScope)) return;
                        startSyncEngine();
                        void requestFullReconciliation();
                    })
                    .catch((e) => console.error('[App] Local DB init failed:', e));
            })
            .catch((error) => {
                if (active && isAuthIdentityScopeCurrent(actionScope)) {
                    console.error('[App] Local DB services could not be loaded:', error);
                }
            });
        return () => {
            active = false;
            stopSync?.();
        };
    }, [authChecked, authenticatedUserId, identityScope]);

    // ── Push notification wiring ───────────────────────────────────
    useEffect(() => {
        const actionScope = identityScope;
        let active = true;
        let unbind: (() => void) | null = null;
        const foregroundHandler = (notification: Parameters<typeof pushForegroundToast>[0]) => {
            pushForegroundToast(notification);
        };
        const tapHandler = (data: Readonly<Record<string, unknown>>) => {
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
        import('../services/PushNotificationService').then(({ PushNotificationService }) => {
            if (!active || !isAuthIdentityScopeCurrent(actionScope)) return;
            unbind = PushNotificationService.bindNotificationHandlers(actionScope, {
                onForegroundPush: foregroundHandler,
                onNotificationTap: tapHandler,
            });
        });
        return () => {
            active = false;
            unbind?.();
        };
    }, [identityScope, setPage]);

    // ── Clear badge on foreground ──────────────────────────────────
    useEffect(() => {
        let active = true;
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
                    if (active) listener = l;
                    else l.remove();
                });
            })
            .catch(() => {});

        import('../services/PushNotificationService').then(({ PushNotificationService }) => {
            PushNotificationService.clearBadge();
        });

        return () => {
            active = false;
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
