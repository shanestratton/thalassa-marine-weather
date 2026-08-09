/**
 * useAppBootstrap — centralises App-level side-effects.
 *
 * Extracted from App.tsx to reduce the main component's complexity.
 * Each logical concern is a standalone useEffect with its own cleanup.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useUI } from '../context/UIContext';
import { pushForegroundToast } from '../components/PushToast';
import { startAnimationBudgetGuard } from '../utils/animationBudget';
import { useAuthStore } from '../stores/authStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import { PI_INTEGRATION_ENABLED } from '../services/piPublicBetaBoundary';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

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
        let disposed = false;
        let stopKeyboardGuard: (() => void) | undefined;

        import('../utils/keyboardScroll').then(({ initGlobalKeyboardScroll }) => {
            if (disposed) return;
            stopKeyboardGuard = initGlobalKeyboardScroll();
        });

        return () => {
            disposed = true;
            stopKeyboardGuard?.();
        };
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

    // ── Sign in with Apple credential revocation ──────────────────
    useEffect(() => {
        if (!authChecked) return;
        let active = true;
        let stop: (() => Promise<void>) | null = null;

        import('../services/auth/appleCredentialState')
            .then(({ startAppleCredentialRevocationMonitoring }) =>
                startAppleCredentialRevocationMonitoring(async (event) => {
                    if (!active) return;
                    const { handleNativeAppleCredentialRevocation } = await import('../stores/authStore');
                    if (active) await handleNativeAppleCredentialRevocation(event.userId);
                }),
            )
            .then((started) => {
                if (active) stop = started;
                else void started();
            })
            .catch((error) => {
                if (active) console.error('[Auth] Apple credential-state monitor failed to start:', error);
            });

        return () => {
            active = false;
            void stop?.();
        };
    }, [authChecked]);

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
        // Public-beta production builds must not probe the boat LAN in
        // the background after the visible Boat Network UI is replaced.
        if (!PI_INTEGRATION_ENABLED) return;
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

    // ── NMEA gateway: reconnect on launch ──────────────────────────
    // autoStart() has existed on NmeaListenerService since the beginning and
    // NOTHING ever called it — AvNav's namesake above was wired up, this one
    // never was. So a saved gateway was silently forgotten on every cold
    // start and the skipper had to go to the NMEA page and press Connect
    // (Shane 2026-08-08). It no-ops when no host/port was ever saved, so a
    // punter with no gateway is unaffected. Deliberately NOT behind
    // PI_INTEGRATION_ENABLED: that gate is about probing the boat LAN for a
    // Pi, and this is a direct connection to a gateway the skipper
    // configured by hand.
    //
    // The store is started HERE too, and that half was missing (Shane
    // 2026-08-09: "the ydwg-02 is connected, the gps is working, however there
    // is nothing showing on the instrument panel"). Restoring the socket
    // without the store that consumes it produced exactly that: a healthy
    // gateway streaming into nothing, because NmeaStore was only ever started
    // by tapping Connect on the NMEA page. The instrument panel gates every
    // tile on the store's own connectionStatus, which stayed 'disconnected'.
    //
    // Store first, socket second — the store must be subscribed in time to
    // catch the initial 'connecting' status.
    useEffect(() => {
        Promise.all([import('../services/NmeaListenerService'), import('../services/NmeaStore')])
            .then(([{ NmeaListenerService }, { NmeaStore }]) => {
                if (!NmeaListenerService.getSavedConfig()) return;
                NmeaStore.start();
                NmeaListenerService.autoStart();
            })
            .catch((err) => console.error('[Boot] NMEA autoStart failed:', err?.message || err));
    }, []);

    // ── Did the web layer die under us last time? ──────────────────
    // The planning screen "crashing back to the Glass page" has been
    // unexplainable since 2026-08-01 because there was nothing to explain it
    // WITH: iOS kills the WebContent process under memory pressure, our logger
    // dies with it, Capacitor reloads, and uiStore seeds currentView from
    // bootView — 'dashboard'. A kill and a cold boot look identical from here.
    //
    // armSessionWatch raises a flag while the app is in the foreground and
    // lowers it on every orderly exit, backgrounding included. A flag still
    // raised at boot means the previous session was killed while the skipper
    // was looking at it — which is the case that matters and the only one
    // reported.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [{ armSessionWatch, shouldRestore, noteRestored }, { useUIStore, readLastView }] =
                    await Promise.all([import('../services/webContentKill'), import('../stores/uiStore')]);
                const crumb = readLastView();
                const died = armSessionWatch(crumb?.view ?? null);
                if (cancelled || !died) return;

                console.warn(
                    `[WebContentKill] the web layer died in the foreground ${died.count}x on this install; ` +
                        `most recently on '${died.view ?? 'unknown'}'`,
                );

                // Put the skipper back. Losing the leg they were drawing is
                // the part of this that actually costs them something.
                if (!died.view || died.view === useUIStore.getState().currentView) return;
                if (!shouldRestore(died.view)) {
                    // We already sent them there once and it died again.
                    // Restoring into the screen that kills the app is a loop
                    // the skipper cannot escape to reach Settings or the chart
                    // cache. Leave them somewhere that works.
                    console.warn(
                        `[WebContentKill] NOT restoring to '${died.view}' — it died again after the last restore`,
                    );
                    return;
                }
                console.warn(`[WebContentKill] restoring the skipper to '${died.view}'`);
                noteRestored(died.view);
                useUIStore.getState().setPage(died.view);
            } catch (err) {
                // A diagnostic must never be the thing that breaks boot.
                console.warn('[WebContentKill] session watch failed:', (err as Error)?.message || err);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // ── GPS warm-up ────────────────────────────────────────────────
    // Wired 2026-08-07. gpsWarmUp has existed since 2026-08-02 but nothing
    // ever called it, so every cold start began its satellite hunt at the
    // moment of need — which is what made the first MOB press feel slow.
    //
    // MOB no longer waits for a fix (it marks from cache and refines), so this
    // is no longer a safety dependency — it just makes that first cached fix
    // exist sooner and be fresher. It is deliberately fire-and-forget: it
    // never blocks boot, never prompts for permission, never reports errors,
    // and releases the engine on the first of a good fix, its 45 s time box,
    // or the app backgrounding.
    useEffect(() => {
        void import('../services/gpsWarmUp')
            .then(({ warmUpGps }) => warmUpGps())
            .catch(() => {
                /* convenience only — absence changes nothing but latency */
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
                    // 'compass' = the anchor-watch page — the surface with the
                    // alarm overlay + silence control ('map' has neither).
                    setPage('compass');
                    break;
                case 'bolo_alert':
                case 'suspicious_alert':
                case 'drag_warning':
                case 'geofence_alert':
                case 'hail':
                    setPage(FEATURE_VISIBILITY.guardian ? 'guardian' : 'dashboard');
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

    // ── Animation budget guard ─────────────────────────────────────
    // Measures the LIVE compositor-animation count and sheds decorative
    // motion before WebKit's 129-message cap kills the renderer. Also logs
    // the top offenders, which is how the next crash report will name the
    // source instead of narrowing it a guess at a time.
    useEffect(() => startAnimationBudgetGuard(), []);

    // ── Freeze animation while backgrounded + clear badge on foreground ──
    // Shane's 2026-08-04 crash logs: 28 minutes of "markAllLayersVolatile:
    // Failed" while the app sat backgrounded at anchor with the tracker
    // running, then the renderer killed with 129 queued
    // DrawingArea_AcceleratedAnimationDidStart messages — and the fresh
    // renderer flooded again within seconds. A backgrounded WKWebView cannot
    // drain its IPC queue, so every pulse/spinner/shimmer/entrance animation
    // that (re)starts while hidden accumulates until iOS shoots the process.
    // Pausing ALL CSS animation while hidden is invisible to the user and
    // lets WebKit actually quiesce the page. CSS rule lives in index.css
    // under `body.app-backgrounded`.
    useEffect(() => {
        const apply = (hidden: boolean) => {
            document.body.classList.toggle('app-backgrounded', hidden);
        };
        const onVisibility = () => apply(document.hidden);
        document.addEventListener('visibilitychange', onVisibility);
        apply(document.hidden);
        let active = true;
        let listener: { remove: () => void } | null = null;
        import('@capacitor/app')
            .then(({ App }) =>
                App.addListener('appStateChange', ({ isActive }) => {
                    apply(!isActive);
                    if (isActive) {
                        void import('../services/PushNotificationService').then(({ PushNotificationService }) => {
                            PushNotificationService.clearBadge();
                        });
                    }
                }).then((l) => {
                    if (active) listener = l;
                    else l.remove();
                }),
            )
            .catch(() => {});

        // Remove an old badge at boot as well as on every foreground event.
        void import('../services/PushNotificationService').then(({ PushNotificationService }) => {
            PushNotificationService.clearBadge();
        });
        return () => {
            active = false;
            document.removeEventListener('visibilitychange', onVisibility);
            listener?.remove();
            document.body.classList.remove('app-backgrounded');
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
