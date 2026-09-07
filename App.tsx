import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NIGHT_SCRIM_Z_INDEX } from './components/ui/OverlayPortal';
import { useWeather } from './context/WeatherContext';
import { useSettings } from './context/SettingsContext';
import { useUI } from './context/UIContext';
import { useLocationStore } from './stores/LocationStore';
// authStore is no longer imported here — App.tsx is browse-free, no
// boot-time auth check. Save-point sheets and the Settings → Account
// entry import useAuthStore + SignInScreen directly where they need it.
import { useAppController } from './hooks/useAppController';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { Dashboard } from './components/Dashboard';
import { SearchIcon, MapIcon, RouteIcon, ClipboardIcon, SailBoatIcon } from './components/Icons';
import { AisGuardAlert } from './components/map/AisGuardAlert';
import { LocationStarMenu } from './components/LocationStarMenu';
import { SkeletonDashboard, SkeletonPage } from './components/SkeletonLoader';
import { NotificationManager } from './components/NotificationManager';
import { ProcessOverlay } from './components/ProcessOverlay';
import { PaywallGate } from './components/PaywallGate';
import { PullToRefresh } from './components/PullToRefresh';
import { NavButton } from './components/NavButton';
import { isBuilderDeepLink } from './services/deepLink';
import { StormGlassNavIcon } from './components/icons/StormGlassNavIcon';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ScreenDimHost } from './components/ScreenDimOverlay';
import { canAccess, PUBLIC_BETA_ACCESS, TIER_INFO } from './services/SubscriptionService';
import { AlertMonitorService } from './services/AlertMonitorService';
import { ToastPortal, toast } from './components/Toast';
import { GlobalAnchorAlarmGate } from './components/anchor-watch/GlobalAnchorAlarmGate';
import { PiPairingBanner } from './components/PiPairingBanner';
import { hasBeenDisplaced, holdsClaim, readRememberedHeld, rememberHeld } from './services/skipperDevice';
import { PushToast } from './components/PushToast';
import { PageTransition } from './components/ui/PageTransition';
import { BuilderDeepLink } from './components/BuilderDeepLink';
import { PlanSignOutButton } from './components/PlanSignOutButton';
import { useAuthStore } from './stores/authStore';
import { lazyRetry } from './utils/lazyRetry';
import { VIEW_REGISTRY, VESSEL_VIEWS, PULL_REFRESH_DISABLED_VIEWS, type ViewContext } from './viewRegistry';
import { SafeImage } from './components/ui/SafeImage';
import {
    GLASS_BRAND_ROW_HEIGHT_PX,
    GLASS_TOP_CARD_GAP_PX,
    getGlassTopLayout,
} from './components/dashboard/glassLayout';
import { FEATURE_VISIBILITY } from './utils/featureVisibility';
import { useViewportHeight } from './hooks/useViewportHeight';

// Only components NOT in the registry are lazy-loaded here
const ForecastSheet = lazyRetry(() => import('./components/ForecastSheet').then((m) => ({ default: m.ForecastSheet })));
const UpgradeModal = lazyRetry(
    () => import('./components/UpgradeModal').then((module) => ({ default: module.UpgradeModal })),
    'UpgradeModal',
);
const MapHub = lazyRetry(() => import('./components/map/MapHub').then((m) => ({ default: m.MapHub })), 'MapHub');
const OnboardingWizard = lazyRetry(
    () => import('./components/OnboardingWizard').then((module) => ({ default: module.OnboardingWizard })),
    'OnboardingWizard',
);
const IOSInstallPrompt = lazyRetry(
    () => import('./components/IOSInstallPrompt').then((m) => ({ default: m.IOSInstallPrompt })),
    'IOSInstallPrompt',
);
const SettingsRestoredModal = lazyRetry(
    () => import('./components/SettingsRestoredModal').then((m) => ({ default: m.SettingsRestoredModal })),
    'SettingsRestoredModal',
);
const SystemStatusButton = lazyRetry(
    () => import('./components/SystemStatusButton').then((module) => ({ default: module.SystemStatusButton })),
    'SystemStatusButton',
);
const OnboardingOverlay = lazyRetry(
    () => import('./components/ui/OnboardingOverlay').then((m) => ({ default: m.OnboardingOverlay })),
    'OnboardingOverlay',
);
// Departure prompts (share-live? / link-a-plan?) — mounted globally so
// they fire the moment a voyage is cast off from ANY screen (the prompts
// used to live in LogPage, which isn't mounted when you cast off from the
// helm — Shane 2026-07-05). Driven by ShipLogService's tracking listener.
const DeparturePrompts = lazyRetry(
    () => import('./components/vessel/DeparturePrompts').then((m) => ({ default: m.DeparturePrompts })),
    'DeparturePrompts',
);
const PassageKitPrompt = lazyRetry(
    () => import('./components/vessel/PassageKitPrompt').then((m) => ({ default: m.PassageKitPrompt })),
    'PassageKitPrompt',
);
// SignInScreen is no longer lazy-imported here — it's rendered by
// the save-point sheets and the Settings → Account entry in their
// own modules where each can lazy-load it on demand.
// Global now-playing bar — floats above the bottom nav on every
// page while music is playing. Lazy because the vast majority of
// app time has nothing in the queue and the bar's polling shouldn't
// even start on the dashboard. Restored 2026-08-10 with the MusicKit
// release (the public-beta excision kept the mount comment below as
// its own breadcrumb); renders nothing when the flag is off.
const GlobalNowPlayingBar = lazyRetry(
    () => import('./components/music/GlobalNowPlayingBar').then((m) => ({ default: m.GlobalNowPlayingBar })),
    'GlobalNowPlayingBar',
);
const SystemStatusFallback: React.FC = () => (
    <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-slate-900/40 text-sm font-bold text-white/45"
        role="status"
        aria-label="Loading system status"
    >
        <span aria-hidden="true">i</span>
    </div>
);

const App: React.FC = () => {
    // 1. DATA STATE
    const { weatherData, loading, loadingMessage, error, fetchWeather, refreshData } = useWeather();
    const { settings, updateSettings, loading: settingsLoading } = useSettings();
    const { currentView, previousView, setPage, isOffline, transitionDirection } = useUI();
    const isVesselView = VESSEL_VIEWS.has(currentView);

    // Resolve the active view config from the registry (null for dashboard/map)
    const activeViewConfig = VIEW_REGISTRY[currentView] ?? null;

    // ── Chart keep-alive ───────────────────────────────────────────
    // The chart mounts ONCE per process and survives navigation hidden,
    // instead of being torn down and rebuilt on every visit.
    //
    // Sealed on 2026-08-09 after six fixes chased memory that was never
    // there: chart → plan → chart → SIT STILL kills the WebContent process.
    // No plotting, no zooming, no interaction. The flight trail shows the
    // clean pair — map:create(#1) → map:remove(#1) → map:create(#2) → dead —
    // and a full Mapbox spin-up is the one mechanism here with a documented
    // body count (PassageRouteMap, 2026-08-04: "WebKit does not promptly
    // return that memory", JetsamEvent ~2.0 GB, lifetimeMax == rpages).
    // Two spin-ups in one process is over the line; ONE, held, is the
    // steady state the skipper already sails with all day.
    //
    // display:none while hidden — layout drops it, the a11y tree drops it,
    // and useMapInit's ResizeObserver fires map.resize() on re-show. The
    // tracer handoff still works hidden because it is event-driven
    // ('thalassa:trace-mode'), and MapHub's listener being ALIVE when the
    // plan page dispatches is strictly better than the old mount-race.
    // Cost: MapHub's timers keep ticking off-screen. That is one chart's
    // steady state, which was never the problem — the rebuild was.
    // Hoisted here with the other unconditional hooks: The Glass layout needs
    // the viewport height, but the call site sits after an early return.
    const glassViewportHeightPx = useViewportHeight();
    const [chartKeepAlive, setChartKeepAlive] = useState(false);
    useEffect(() => {
        if (currentView === 'map') setChartKeepAlive(true);
    }, [currentView]);
    const chartVisible = currentView === 'map';

    // --- AUTH: deferred to save-time, not boot-time. ---
    // authStore is consumed wherever identity matters (SignInScreen at
    // save points, useAppController's onboarding gate, the voyage log
    // publish flow, etc.). App.tsx itself no longer reads the auth
    // state — browsing is free, sign-in is the user's deliberate
    // choice when they hit an action that needs identity. See the
    // longer note above the JSX return below.

    // Track if map was opened from WX page (auto-return) vs tab bar (stay on map)
    const mapFromWxRef = useRef(false);
    const [mapPickerActive, setMapPickerActive] = useState(false);
    // Mobile landscape hides the bottom nav to buy vertical room for the wide
    // view. That is fine as a DEFAULT and fatal as an absolute: onboarding can
    // lock the device to landscape (settingsStore ScreenOrientation.lock), and
    // Settings — the only place to undo that choice — was reachable exclusively
    // THROUGH the nav it hid. Choosing "Landscape" on a phone therefore made the
    // app permanently unnavigable, with no route back short of a reinstall. The
    // nav is now summonable instead of absent.
    const [landscapeNavOpen, setLandscapeNavOpen] = useState(false);

    // Bosun voice console — registered as the 'voice' page in
    // viewRegistry. The mic button in the app header (and the floating
    // mic on the map) just call setPage('voice'); navigating to any
    // other tab fully unmounts it like every other registered view.
    // Gated to Skipper (owner) tier — top tier only, since the voice
    // console wraps the most expensive features (Pi AI, cloud Haiku,
    // ElevenLabs TTS, Cloudflare Worker proxy + Deepgram).
    // Calypso's console is parked (FEATURE_VISIBILITY.calypsoConsole, 2026-08-09).
    // Tier access is still evaluated so bringing him back is one flag, not an
    // archaeology exercise. MAYDAY and radio position reports are unaffected —
    // they go through safetyTts, which has never touched this console.
    const canUseBosunVoice = FEATURE_VISIBILITY.calypsoConsole && canAccess(settings.subscriptionTier, 'bosunVoice');

    // Standalone planner page (Shane 2026-07-17: "boat-name.thalassawx.app/plan
    // is a standalone page like the diary — the user should not have access to
    // any other part of the app from here"). The SPA path is fixed for the
    // session, so read it once: on /plan (or /builder) we hide the bottom tab
    // bar entirely, leaving just the planner + chart. Native serves from '/',
    // so this is web-only and never touches the app.
    const [isStandalonePlan] = useState(isBuilderDeepLink);

    // Routing-page declutter (Shane 2026-07-17): MapHub broadcasts when the
    // Route Tracer is active; the floating mic orb over the map steps aside
    // for the tracer card and comes back on Done.
    const [tracerActive, setTracerActive] = useState(false);

    // SKIPPER-DEVICE DISPLACEMENT NOTICE. The claim syncs last-write-wins, so a
    // takeover on another device silently stops this one publishing. A device
    // that believes it is broadcasting while the server disagrees is silent data
    // loss on the public page — worse than not publishing at all — so it has to
    // say so. Held-state is remembered across cold boots because the likely case
    // is being displaced while this app is closed.
    // `settings` above is already the live store (SettingsContext delegates to
    // it), so no second subscription is needed here.
    const skipperClaim = settings.skipperDevice;
    useEffect(() => {
        const nowHeld = holdsClaim(skipperClaim);
        if (hasBeenDisplaced(skipperClaim, readRememberedHeld()) && !nowHeld) {
            toast.info(
                `This device is no longer the skipper — ${skipperClaim?.deviceName ?? 'another device'} took over. ` +
                    `It has stopped publishing to your public page.`,
            );
        }
        rememberHeld(nowHeld);
    }, [skipperClaim]);
    useEffect(() => {
        const onTracer = (e: Event) => setTracerActive(Boolean((e as CustomEvent).detail?.active));
        window.addEventListener('thalassa:tracer-active', onTracer);
        return () => window.removeEventListener('thalassa:tracer-active', onTracer);
    }, []);

    // ── Bootstrap: chat badge, push notifications, keyboard, DB sync, etc. ──
    const { chatUnread } = useAppBootstrap();

    // 2. APP LOGIC / CONTROLLER
    const {
        query,
        bgImage,
        showOnboarding,
        handleOnboardingComplete,
        toggleFavorite,
        handleFavoriteSelect,
        handleMapTargetSelect,
        handleMapStaySelect,
        effectiveMode,
        handleLocateLite,
        sheetOpen,
        setSheetOpen,
        sheetData,
        isUpgradeOpen,
        setIsUpgradeOpen,
        isMobileLandscape,
        handleTabDashboard,
        handleTabMap,
    } = useAppController();

    // ── Tablet split view ──────────────────────────────────────────
    // Long-press The Glass to pin it beside whatever else you are doing; the
    // same tap closes it again. Gated on WIDTH rather than orientation because
    // width is the thing that actually decides whether two panes fit — that
    // gets iPad landscape and the desktop web build from one rule, and keeps
    // it off a phone in landscape, where 900px split in two is two useless
    // columns.
    //
    // The chart is excluded on purpose. It is a deliberate singleton kept
    // alive hidden (see the keep-alive note above) because two Mapbox
    // spin-ups in one process killed the WebContent process. Putting it in a
    // pane is the pairing worth having, but it is not worth guessing at.
    const [splitViewEnabled, setSplitViewEnabled] = useState(() => {
        try {
            return localStorage.getItem('thalassa_split_view') === '1';
        } catch {
            return false;
        }
    });
    const [wideEnoughForSplit, setWideEnoughForSplit] = useState(
        () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
    );
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const query = window.matchMedia('(min-width: 1024px)');
        // Both, deliberately. The media query alone misses cases where the window
        // is resized without the query firing a change the listener sees — iPad
        // Split View and Slide Over resize the app without an orientation change,
        // and it was measured going stale under viewport emulation too. Re-read
        // `matches` on every signal rather than trusting the event payload, so
        // whichever arrives first is enough and neither can leave a phone-width
        // window rendering two panes.
        const sync = () => setWideEnoughForSplit(query.matches);
        sync();
        query.addEventListener('change', sync);
        window.addEventListener('resize', sync);
        window.addEventListener('orientationchange', sync);
        return () => {
            query.removeEventListener('change', sync);
            window.removeEventListener('resize', sync);
            window.removeEventListener('orientationchange', sync);
        };
    }, []);

    const rememberSplitView = useCallback((next: boolean) => {
        setSplitViewEnabled(next);
        try {
            localStorage.setItem('thalassa_split_view', next ? '1' : '0');
        } catch {
            /* private mode — the preference just will not survive a restart */
        }
    }, []);

    // The chart is allowed in the split — but ONLY by repositioning the one
    // kept-alive Mapbox instance over the right pane. It never mounts twice:
    // two spin-ups in one process is the documented WebContent killer
    // (JetsamEvent ~2.0 GB, sealed 2026-08-09), so the map node stays exactly
    // where it lives in the DOM and CSS alone moves it.
    const splitActive = splitViewEnabled && wideEnoughForSplit && currentView !== 'dashboard';

    // Where the right frame ACTUALLY is, measured, because the header above
    // it changes height with orientation and visibility. The chart overlays
    // this rectangle with position:fixed; guessing it from CSS would couple
    // this to every header tweak forever.
    const splitRightFrameRef = useRef<HTMLDivElement | null>(null);
    const [splitChartRect, setSplitChartRect] = useState<{
        top: number;
        left: number;
        width: number;
        height: number;
    } | null>(null);
    const splitChartActive = splitActive && currentView === 'map';
    useEffect(() => {
        if (!splitChartActive) {
            setSplitChartRect(null);
            return;
        }
        const frame = splitRightFrameRef.current;
        if (!frame) return;
        const measure = () => {
            const r = frame.getBoundingClientRect();
            // Inset by the frame's 1px border so its edge stays visible around
            // the chart rather than being painted over.
            setSplitChartRect({ top: r.top + 1, left: r.left + 1, width: r.width - 2, height: r.height - 2 });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(frame);
        window.addEventListener('resize', measure);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [splitChartActive]);

    const toggleSplitView = useCallback(() => {
        if (!wideEnoughForSplit) return;
        if (splitViewEnabled) {
            rememberSplitView(false);
            return;
        }
        rememberSplitView(true);
        // Turning it on from The Glass would otherwise do NOTHING VISIBLE: the
        // split needs a second page for the right pane, and The Glass is already
        // the left one. Holding the tab you are looking at is the obvious way to
        // try this, so it has to land somewhere — the page you came from if that
        // still makes sense, the log otherwise. The chart is skipped because it
        // is excluded from the split entirely.
        if (currentView === 'dashboard' || currentView === 'map') {
            const back = previousView && previousView !== 'dashboard' && previousView !== 'map' ? previousView : null;
            setPage(back ?? 'details');
        }
    }, [wideEnoughForSplit, splitViewEnabled, rememberSplitView, currentView, previousView, setPage]);

    // Tapping The Glass while split collapses back to one view: the gesture
    // that opened it closes it, so there is nothing new to learn.
    const handleGlassTab = useCallback(() => {
        if (splitViewEnabled) rememberSplitView(false);
        handleTabDashboard();
    }, [splitViewEnabled, rememberSplitView, handleTabDashboard]);

    // Compute display mode BEFORE any early returns — needed by useEffect below
    const isLight = effectiveMode === 'light';

    // Sync display-light class to document root — ensures portaled components
    // (ModalSheet, toasts, etc.) rendered via createPortal(…, document.body)
    // inherit the light theme CSS overrides from index.css.
    useEffect(() => {
        if (isLight) {
            document.documentElement.classList.add('display-light');
        } else {
            document.documentElement.classList.remove('display-light');
        }
        return () => document.documentElement.classList.remove('display-light');
    }, [isLight]);

    // Global navigation event listener — used by components that can't thread setPage via props
    useEffect(() => {
        const handler = (e: Event) => {
            const tab = (e as CustomEvent).detail?.tab;
            if (tab) setPage(tab);
        };
        window.addEventListener('thalassa:navigate', handler);
        return () => window.removeEventListener('thalassa:navigate', handler);
    }, [setPage]);

    // Global "open upgrade modal" event — used by PaywallGate when it
    // renders deep inside a tree that doesn't have direct access to
    // setIsUpgradeOpen (e.g. a gated page inside ChatPage).
    useEffect(() => {
        const handler = () => setIsUpgradeOpen(true);
        window.addEventListener('thalassa:openUpgrade', handler);
        return () => window.removeEventListener('thalassa:openUpgrade', handler);
    }, [setIsUpgradeOpen]);

    // One-shot personal-port directory sync. Pulls the user's saved
    // ports from Supabase and merges them into the local cache so a
    // route the user planned on the iPad resolves instantly on the
    // iPhone (and vice versa). No-ops gracefully when the user is
    // signed out or offline. Fire-and-forget — the page renders
    // immediately and the merge populates as it lands.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { syncPortsFromCloud } = await import('./services/PersonalPortDirectory');
                if (cancelled) return;
                await syncPortsFromCloud();
            } catch {
                /* non-critical — local cache still works */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // One-shot saved-routes pull-merge (desktop builder Phase 5.3+).
    // Without this the phone only learned about desktop-built tracer
    // routes when the tracer panel opened — now they're already local
    // by the time the skipper looks. Runs once per app session, as soon
    // as a Supabase session is available (boot probe or later sign-in).
    // getState/subscribe, not a hook — App.tsx stays out of auth-driven
    // re-renders per the deferred-auth note below.
    useEffect(() => {
        let synced = false;
        const run = () => {
            if (synced) return;
            synced = true;
            void import('./services/savedRoutesSync').then(({ syncSavedRoutes }) => syncSavedRoutes()).catch(() => {});
        };
        if (useAuthStore.getState().user) run();
        const unsub = useAuthStore.subscribe((s) => {
            if (s.user) run();
        });
        return unsub;
    }, []);

    // One-shot ShipLog resume at BOOT — the relaunch black hole fix
    // (sail-day audit 2026-08-01). ShipLogService.initialize() is what
    // reconciles a persisted mid-voyage tracking state, resumes the SAME
    // voyage in place, re-arms the live trickle AND starts the offline-queue
    // upload retry — and its only caller was the Log page mount. So if the
    // app died under way (jetsam, webview reload, force-quit, reboot),
    // NOTHING recorded or uploaded on relaunch until Shane happened to open
    // the Log page; the 26 July voyage's public track went dark exactly this
    // way (at-stop upload stuck in the queue with no retry armed). Same
    // getState/subscribe pattern as the saved-routes pull above; initialize()
    // is idempotent and scope-guarded, so the Log page's own call stays
    // harmless. Deferred 4 s to stay out of the boot window (z10-boot audit).
    useEffect(() => {
        let armed = false;
        const arm = () => {
            if (armed) return;
            armed = true;
            setTimeout(() => {
                void import('./services/ShipLogService')
                    .then(({ ShipLogService }) => ShipLogService.initialize())
                    .catch(() => {});
            }, 4000);
        };
        if (useAuthStore.getState().user) arm();
        const unsub = useAuthStore.subscribe((s) => {
            if (s.user) arm();
        });
        return unsub;
    }, []);

    // One-shot anchor-watch share restore. A device that joined a shared
    // anchor watch persists the session; restoring it here on app startup
    // means a backgrounded/closed FOLLOWER auto-reconnects to the host
    // without re-entering the share code — regardless of which page the
    // app reopens to. No-ops when there's no saved session. (The Anchor
    // Watch page also restores on mount; restoreSession is idempotent.)
    useEffect(() => {
        (async () => {
            try {
                const { AnchorWatchSyncService } = await import('./services/AnchorWatchSyncService');
                await AnchorWatchSyncService.restoreSession();
                // And the Pi's side of it. The keeper's assignment used to be
                // memory only, so after iOS killed the app nothing renewed the
                // six-hour lease and nothing re-offered — the offer loop is
                // gated on viewMode === 'watching', which a shore-mode phone
                // never is. The Pi went quiet a few hours in, permanently,
                // while this phone showed a session it believed was healthy.
                const { AnchorPiWatchKeeper } = await import('./services/anchorPiWatchKeeper');
                AnchorPiWatchKeeper.restore();
            } catch {
                /* non-critical — the Anchor Watch page restores on mount too */
            }
        })();
    }, []);

    // Calypso proactive vessel alerts are held for public beta. The current
    // monitor lives in foreground JavaScript and cannot promise monitoring
    // after iOS suspends or terminates the app. Keep the dormant implementation
    // fail-closed even when an older settings envelope still says it was on.
    const alertsToggle = FEATURE_VISIBILITY.calypsoAlerts && (settings.calypsoAlertsEnabled ?? false);
    const alertsAllowed = FEATURE_VISIBILITY.calypsoAlerts && canAccess(settings.subscriptionTier, 'calypsoAlerts');
    useEffect(() => {
        if (!FEATURE_VISIBILITY.calypsoAlerts) {
            AlertMonitorService.stop();
            // Retire the old opt-in. A later, genuinely native implementation
            // must ask again instead of silently reactivating a safety feature
            // whose behaviour and guarantees have changed.
            if (settings.calypsoAlertsEnabled) {
                void updateSettings({ calypsoAlertsEnabled: false });
            }
            return undefined;
        }
        if (alertsToggle && alertsAllowed) {
            AlertMonitorService.start();
            return () => AlertMonitorService.stop();
        }
        // If we're not running, ensure any prior session is torn down.
        AlertMonitorService.stop();
        return undefined;
    }, [alertsToggle, alertsAllowed, settings.calypsoAlertsEnabled, updateSettings]);

    // Live GPS-derived location name — subscribed here (above the
    // conditional early return) so React's rules-of-hooks are happy.
    // The useLiveLocationName hook on the Dashboard writes to
    // LocationStore via setFromGPS on each successful reverse-geocode,
    // so subscribing here lets the header title update within ~1s of a
    // fresh GPS fix — even when the cached weather's locationName is
    // stale or was a bad forward-geocode from onboarding (e.g. 'Old
    // Aust Road, England' for a user who typed 'Newport' but meant
    // Newport, QLD).
    const locationStore = useLocationStore();
    const livePreferred = locationStore.source === 'gps' && locationStore.name ? locationStore.name : null;

    // Loading State
    if (settingsLoading) {
        return (
            <div className="flex items-center justify-center h-screen w-full bg-slate-950 flex-col gap-4">
                <img
                    src="/thalassa-icon-128.png"
                    alt=""
                    aria-hidden="true"
                    width={64}
                    height={64}
                    className="w-16 h-16 rounded-2xl animate-pulse"
                />
                <p className="text-[11px] font-bold uppercase tracking-wider text-sky-300">Thalassa</p>
            </div>
        );
    }

    const containerClasses =
        effectiveMode === 'night'
            ? 'bg-slate-950 text-red-600'
            : isLight
              ? 'bg-slate-200 text-slate-900'
              : 'bg-slate-950 text-white';

    // Header Title Logic
    // Show the location name as-is when it's a real place name.
    // Only prepend "WP" for raw decimal coordinates (e.g. "-27.47, 153.03").
    // Cardinal formats (e.g. "27.47°S, 153.03°E") are already human-readable — leave them.
    const rawTitle =
        livePreferred ||
        (weatherData ? weatherData.locationName : query || settings.defaultLocation || 'Select Location');
    let displayTitle = rawTitle;

    // Only catch truly raw/generic names:
    // 1. Starts with "Location" (generic placeholder)
    // 2. Starts with a raw decimal coordinate (digit or minus, NOT followed by degree symbol)
    //    e.g. "-27.47, 153.03" or "27.4700" but NOT "27.47°S" (already formatted)
    const isRawCoordinate = /^-?\d+\.?\d*\s*,\s*-?\d/.test(rawTitle);
    const isGenericName = /^(Location|Waypoint)\b/i.test(rawTitle);
    const needsWpPrefix = (isRawCoordinate || isGenericName) && !rawTitle.startsWith('WP');

    if (needsWpPrefix) {
        // Reconstruct as cardinal coordinate WP name
        if (weatherData?.coordinates) {
            const latStr =
                Math.abs(weatherData.coordinates.lat).toFixed(4) + (weatherData.coordinates.lat >= 0 ? '°N' : '°S');
            const lonStr =
                Math.abs(weatherData.coordinates.lon).toFixed(4) + (weatherData.coordinates.lon >= 0 ? '°E' : '°W');
            displayTitle = `WP ${latStr} ${lonStr}`;
        } else {
            displayTitle = `WP ${rawTitle}`;
        }
    }

    const showBackgroundImage = false; // Background images disabled — all modes use solid backgrounds
    const showHeader = !['map', 'warnings'].includes(currentView);
    const isDashboard = currentView === 'dashboard';
    const glassTopLayout = getGlassTopLayout(isMobileLandscape, glassViewportHeightPx);

    // --- AUTH: deferred to action-time, NOT boot-time ---
    // The previous hard gate (boot → SignInScreen) traded a real UX cost
    // (a stranger downloads the app, sees an auth wall, bounces) for a
    // real engineering benefit (no duplicate-vessel race on fresh
    // install). The engineering side now lives at the SAVE moment —
    // saving a passage plan, posting a voyage log, starting a shared
    // anchor watch — where identity actually has product meaning.
    //
    // Browsing is free. The Glass, Charts, planning a passage, looking
    // at notices — none of those require an account. Sign-in becomes a
    // contextual sheet the FIRST time the user commits to something
    // identity-bearing. See SignInScreen consumers and the
    // useAppController onboarding gate (which still requires authedUser
    // before showing the wizard — un-authed users have no cloud
    // account to attach a vessel to, so the wizard would dead-end).
    //
    // Note we DON'T render anything during the brief !authChecked
    // window any more either. The session probe is async (≤200ms in
    // practice), so blocking the entire first paint for it makes the
    // app feel slower than it is. Once the session resolves, settings/
    // boat/vessel data flows in via the existing useEffect chain.
    // authedUser is still consumed elsewhere; downstream code already
    // handles null gracefully (it's a normal React subscribe pattern).
    // SignInScreen is intentionally NOT removed from this file's
    // imports — it'll be rendered inline by save-point sheets and the
    // Settings → Account entry in subsequent PRs.

    // The Glass, lifted out of the view tree so it can be rendered in two
    // places without duplicating twenty props: its normal slot, and the left
    // pane of the tablet split view. Extraction only — the markup below is
    // byte-for-byte what was inline, because the Glass is frozen at
    // glass-beta-1 and this is a layout change, not a Glass change.
    const glassContent = (
        <>
            {error ? (
                <div className="p-8 bg-red-500/20 border border-red-500/30 rounded-2xl text-center max-w-lg mx-auto mt-20">
                    <h3 className="text-xl font-bold text-red-200 mb-2">Couldn't update conditions</h3>
                    <p className="text-white/80">Check your connection and try again.</p>
                    <p className="mt-2 text-xs text-white/40">{error}</p>
                    <button
                        aria-label="Retry loading weather data"
                        onClick={() => fetchWeather(query || settings.defaultLocation || '')}
                        className="mt-6 px-6 py-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors active:scale-95"
                    >
                        Retry
                    </button>
                </div>
            ) : !weatherData && !loading && !settings.defaultLocation ? (
                // True empty state — no location set, nothing
                // loading. Trust the OS GPS flow (one-tap
                // "Use my location" → iOS permission prompt
                // → reverse-geocode → live local weather) and
                // give a manual "Choose a port" fallback. No
                // dummy data, no Sydney conditions painted
                // for a Brisbane user. This matches what
                // Apple Weather / Windy / Predict Wind / Yr.no
                // all do — empty-state-with-intent beats fake
                // data every time.
                <div className="flex-1 w-full h-full bg-slate-950 flex items-center justify-center px-6">
                    <div className="max-w-sm w-full">
                        <div className="text-center mb-8">
                            <div className="text-5xl mb-3" aria-hidden="true">
                                ⛵
                            </div>
                            <h2 className="text-xl font-bold text-white mb-2">Welcome aboard</h2>
                            <p className="text-sm text-slate-400 leading-relaxed">
                                Set your location to see live marine conditions — wind, tide, swell, weather.
                            </p>
                        </div>
                        <div className="space-y-3">
                            <button
                                type="button"
                                onClick={handleLocateLite}
                                className="w-full h-12 rounded-xl bg-sky-500 hover:bg-sky-400 text-white font-semibold text-sm transition-colors shadow-lg flex items-center justify-center gap-2"
                            >
                                <svg
                                    className="w-4 h-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <circle cx="12" cy="12" r="3" />
                                    <path d="M12 1v6m0 6v6M1 12h6m6 0h6" />
                                </svg>
                                {isOffline ? 'Use GPS offline' : 'Use my location'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    mapFromWxRef.current = true;
                                    setMapPickerActive(true);
                                    setPage('map');
                                }}
                                className="w-full h-12 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-white font-semibold text-sm transition-colors border border-white/10 flex items-center justify-center gap-2"
                            >
                                <MapIcon className="w-4 h-4 text-emerald-400" />
                                Choose a port on the map
                            </button>
                        </div>
                        <p className="text-[11px] text-center text-slate-500 mt-4 leading-relaxed">
                            GPS works offline. Forecasts and place names update when connected, and coordinates are sent
                            to the provider needed for that request.
                        </p>
                    </div>
                </div>
            ) : !weatherData && !loading ? (
                <div className="flex-1 w-full h-full bg-slate-950 flex items-center justify-center px-6 text-center">
                    <div className="max-w-sm space-y-4" role="status">
                        <p className="text-sm text-slate-400">
                            {isOffline
                                ? 'Your location is saved, but no offline forecast is available yet.'
                                : 'Weather data is not available for this location yet.'}
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                            <button
                                type="button"
                                onClick={() => fetchWeather(query || settings.defaultLocation || '')}
                                disabled={isOffline}
                                className="rounded-xl bg-sky-500 px-5 py-2.5 text-sm font-bold text-white disabled:bg-slate-700 disabled:text-slate-400"
                            >
                                {isOffline ? 'Waiting for network' : 'Retry forecast'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    mapFromWxRef.current = true;
                                    setMapPickerActive(true);
                                    setPage('map');
                                }}
                                className="rounded-xl border border-white/10 bg-slate-800 px-5 py-2.5 text-sm font-bold text-white"
                            >
                                Choose another location
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                weatherData && (
                    <Dashboard
                        onOpenMap={() => {
                            mapFromWxRef.current = true;
                            setMapPickerActive(true);
                            setPage('map');
                        }}
                        onTriggerUpgrade={() => setIsUpgradeOpen(true)}
                        displayTitle={displayTitle}
                        timeZone={weatherData.timeZone}
                        utcOffset={weatherData.utcOffset}
                        timeDisplaySetting={settings.timeDisplay}
                        onToggleFavorite={toggleFavorite}
                        favorites={settings.savedLocations}
                        isRefreshing={loading}
                        isNightMode={effectiveMode === 'night'}
                        isMobileLandscape={isMobileLandscape}
                        viewMode={'overview'}
                        mapboxToken={settings.mapboxToken}
                        onLocationSelect={handleMapTargetSelect}
                    />
                )
            )}
        </>
    );

    return (
        <div
            className={`relative h-screen supports-[height:100dvh]:h-dvh w-full overflow-hidden font-sans transition-colors duration-500 ${containerClasses} ${isLight ? 'display-light' : ''} flex flex-col`}
        >
            {/* MODALS & OVERLAYS */}
            {/* Desktop-builder front door: only ever visible when the
                session started on thalassawx.app/plan (see the
                component header). Renders null on native. */}
            <BuilderDeepLink />
            {/* The tab bar is hidden on /plan, taking Settings → Account —
                and with it the only sign-out — out of reach. Renders null
                everywhere else and whenever there is no session. */}
            <PlanSignOutButton />
            <Suspense fallback={null}>
                {showOnboarding && <OnboardingWizard onComplete={handleOnboardingComplete} />}
                <UpgradeModal isOpen={isUpgradeOpen} onClose={() => setIsUpgradeOpen(false)} />
            </Suspense>

            <Suspense fallback={null}>
                <IOSInstallPrompt />
            </Suspense>

            {/* Welcome-back modal: self-listens for the
                `thalassa:settings-restored-modal` CustomEvent fired
                by settingsStore.pullFromCloud on a fresh-device
                cloud restore. Renders nothing until the event lands. */}
            <Suspense fallback={null}>
                <SettingsRestoredModal />
            </Suspense>
            <NotificationManager onNotify={(msg) => toast.info(msg)} />

            {/* Active-route status and stop controls live in SystemStatusButton
                instead of consuming fixed space above every tab. */}

            {/* BACKGROUND */}
            {showBackgroundImage ? (
                <div className="absolute inset-0 z-0 overflow-hidden">
                    <SafeImage
                        src={bgImage}
                        alt=""
                        aria-hidden="true"
                        loading="eager"
                        className="absolute inset-0 h-full w-full scale-105 object-cover transition-all duration-1000"
                    />
                    <div className="absolute inset-0 bg-black/30"></div>
                    <div className="absolute inset-0 bg-linear-to-b from-slate-900/90 via-slate-900/40 to-slate-900/90"></div>
                </div>
            ) : (
                <div className={`absolute inset-0 z-0 ${isLight ? 'bg-slate-200' : 'bg-slate-950'}`}></div>
            )}

            {loading && <ProcessOverlay message={loadingMessage} />}
            <Suspense fallback={null}>
                <OnboardingOverlay />
            </Suspense>

            <div className="relative z-10 flex flex-col h-full overflow-hidden">
                {/* The retired full-width connectivity strip used to live here.
                    Removed 2026-05-08 — three concrete problems it was causing:
                      (a) On Dashboard, the strip took ~70px of flex flow,
                          which pushed `<main>`'s PageTransition wrapper down.
                          PageTransition uses `transform`, which creates a
                          containing block for `position: fixed` children, so
                          every fixed-position widget inside the Glass page
                          (CompactHeaderRow, HeroHeader, conditions card,
                          hero container) shifted down by the banner height —
                          surfacing as a huge black gap between the location
                          pill and the warnings row.
                      (b) On Scuttlebutt + NavStation it was just visually
                          loud — a full-width "● NO SIGNAL" amber bar at the
                          top of an otherwise-tidy page.
                      (c) The Glass page already shows a tasteful wifi-slash
                          chip inside the location pill; the strip was
                          redundant on top of that.
                    Replaced with a small wifi-slash icon next to the "The
                    Sailor's Assistant" subtitle (see header below) and a
                    matching tiny chip on the map page. The map's floating
                    equivalent was removed at the same time. */}

                {/* GLOBAL TOAST PORTAL */}
                <ToastPortal />

                {/* ANCHOR ALARM — app-level gate so a drag/GPS-lost alarm
                    covers WHATEVER page is up, not just the anchor-watch
                    page it used to be local to. */}
                <GlobalAnchorAlarmGate />

                {/* Pi pairing offer — global, because the identity gate blocks
                    the ENC sync until the skipper pairs, and the offer used to
                    live only inside Settings where it was never seen. */}
                <PiPairingBanner />

                {/* Departure prompts — fire on cast-off from any view. */}
                <Suspense fallback={null}>
                    <DeparturePrompts />
                    <PassageKitPrompt />
                </Suspense>

                {/* Bosun voice console is now the 'voice' registered view —
                    selected via setPage('voice') from the mic button. No
                    global overlay; the registry handles mount/unmount on
                    navigation just like every other page. */}

                {/* PUSH NOTIFICATION FOREGROUND TOAST */}
                <PushToast
                    onTap={(data) => {
                        const type = data.notification_type as string;
                        switch (type) {
                            case 'dm':
                                setPage('chat');
                                break;
                            case 'weather_alert':
                                setPage('dashboard');
                                break;
                            case 'anchor_alarm':
                                // 'compass' is the anchor-watch page (swing circle,
                                // silence control). 'map' had NO alarm UI at all —
                                // an alarm tap used to land on a chart with nothing
                                // to acknowledge.
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
                    }}
                />

                {/* HEADER */}
                {showHeader && (
                    <header
                        className={`px-4 md:px-6 flex flex-col justify-between pointer-events-none shrink-0 ${isDashboard ? `fixed top-0 left-0 right-0 z-105 ${isLight ? 'bg-slate-200' : 'bg-black'}` : `${isMobileLandscape ? 'py-1' : 'py-2'}`} pt-[max(1rem,env(safe-area-inset-top))]`}
                        style={{ paddingBottom: isDashboard ? 0 : undefined, gap: `${GLASS_TOP_CARD_GAP_PX}px` }}
                    >
                        {/* Logo row — same style on all pages */}
                        <div
                            className="flex items-start justify-between pointer-events-auto shrink-0"
                            style={isDashboard ? { height: `${GLASS_BRAND_ROW_HEIGHT_PX}px` } : undefined}
                        >
                            <div className="flex min-w-0 items-center space-x-2">
                                {/* Bumped 40 → 46 → 51 → 64 px (2026-05-19).
                                    Combined with the app-icon SVG mark-scale
                                    bump (0.49 → 0.55), the in-app header now
                                    has a properly sized compass that doesn't
                                    drown next to the wordmark + Skipper pill. */}
                                <img
                                    src="/thalassa-icon-128.png"
                                    alt=""
                                    width={64}
                                    height={64}
                                    className="w-[64px] h-[64px] rounded-lg"
                                />
                                <div className="min-w-0">
                                    <div className="flex min-w-0 items-center gap-1">
                                        <h2 className="min-w-0 flex-1 truncate text-xl font-bold tracking-wider uppercase shadow-black drop-shadow-lg">
                                            Thalassa
                                        </h2>
                                        {PUBLIC_BETA_ACCESS.enabled ? (
                                            /* SKIPPER is the headline word again, with the
                                               beta framing demoted to a 7px sub-line beneath
                                               it (Shane 2026-08-06: "put back the skipper
                                               word, with beta - free underneath it in very
                                               small writing, so that it is not impacting
                                               anything else"). The beta unlocks every gate
                                               (canAccess returns true for all), so Skipper is
                                               the honest label for what the punter actually
                                               has. leading-none on both lines keeps the stack
                                               at ~26px — inside the text-xl wordmark's own
                                               line box, so the brand row height and the
                                               truncating h2 beside it are untouched. */
                                            <span className="flex shrink-0 flex-col items-center whitespace-nowrap rounded-sm border border-amber-300/30 bg-amber-400/15 px-1.5 py-0.5 text-amber-100 shadow-lg">
                                                <span className="text-[10px] font-bold uppercase leading-none tracking-wider">
                                                    Skipper
                                                </span>
                                                <span className="mt-px text-[7px] font-semibold uppercase leading-none tracking-wide text-amber-200/70">
                                                    Beta · Free
                                                </span>
                                            </span>
                                        ) : settings.subscriptionTier && settings.subscriptionTier !== 'free' ? (
                                            <span
                                                className={`px-1.5 py-0.5 rounded text-[11px] font-bold text-white uppercase tracking-wider shadow-lg ${
                                                    settings.subscriptionTier === 'owner'
                                                        ? 'bg-linear-to-r from-amber-500 to-orange-500'
                                                        : 'bg-linear-to-r from-cyan-500 to-blue-600'
                                                }`}
                                            >
                                                {TIER_INFO[settings.subscriptionTier].badge}
                                            </span>
                                        ) : null}
                                    </div>
                                    <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] uppercase tracking-widest text-sky-200 shadow-black drop-shadow-md">
                                        <span className="min-w-0 flex-1 truncate">The Sailor&apos;s Assistant</span>
                                        {/* Subtle offline indicator — tiny amber wifi-slash next
                                            to the tagline, matching the chip already inside the
                                            Glass page's location pill. Replaces the loud
                                            full-width "NO SIGNAL" strip. */}
                                        {isOffline && (
                                            <span
                                                className="inline-flex shrink-0 items-center gap-1 text-amber-400/80"
                                                title="Offline — using cached data"
                                                aria-label="Offline"
                                            >
                                                <svg
                                                    className="w-3 h-3"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                >
                                                    <path d="M1 1l22 22" />
                                                    <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
                                                    <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
                                                    <path d="M10.71 5.05A16 16 0 0122.58 9" />
                                                    <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
                                                    <path d="M8.53 16.11a6 6 0 016.95 0" />
                                                    <line x1="12" y1="20" x2="12.01" y2="20" />
                                                </svg>
                                            </span>
                                        )}
                                    </p>
                                </div>
                            </div>

                            {/* Calypso mic (Skipper-tier) + System status ℹ — paired top-right */}
                            <div className="flex shrink-0 items-center gap-2 pointer-events-auto">
                                {canUseBosunVoice && (
                                    <button
                                        onClick={() => setPage('voice')}
                                        className="w-12 h-12 rounded-full bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 flex items-center justify-center text-sky-400 transition-colors backdrop-blur-md"
                                        aria-label="Open Calypso voice console"
                                        title="Talk to Calypso"
                                    >
                                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                                            <path d="M19 11h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72z" />
                                        </svg>
                                    </button>
                                )}
                                <div className="flex flex-col items-end gap-1">
                                    <Suspense fallback={<SystemStatusFallback />}>
                                        <SystemStatusButton
                                            currentView={currentView}
                                            onNavigateAnchor={() => setPage('compass')}
                                        />
                                    </Suspense>
                                </div>
                            </div>
                        </div>

                        {/* Search bar — only shown on dashboard (non-registered views without explicit flag) */}
                        {!activeViewConfig && currentView !== 'map' && (
                            <div
                                className={`flex w-full items-center gap-3 md:w-auto ${isDashboard ? '' : isMobileLandscape ? 'h-8' : 'h-12'} pointer-events-auto`}
                                style={isDashboard ? { height: `${glassTopLayout.locationCardHeightPx}px` } : undefined}
                            >
                                <div className="relative grow md:w-96 group h-full">
                                    <form onSubmit={(e) => e.preventDefault()} className="relative w-full h-full">
                                        <input
                                            type="text"
                                            value={query}
                                            readOnly
                                            placeholder="Saved locations ★"
                                            aria-label="Current location"
                                            // Offline styling kept at the same contrast as online —
                                            // a deliberate but subtle ring change instead of the
                                            // previous opacity fade (which made the bar nearly
                                            // invisible). The offline state is communicated via
                                            // the amber wifi-off chip on the left, so the bar
                                            // itself doesn't need to shout.
                                            className={`w-full h-full text-white placeholder-gray-400 rounded-2xl pl-12 pr-12 outline-hidden transition-all shadow-2xl font-bold text-xl tracking-tight cursor-default bg-slate-900/60 border ${isOffline ? 'border-amber-500/40' : 'border-white/10'}`}
                                        />
                                        {/* Left adornment: swap between the usual search icon
                                            and a wifi-off glyph when offline. Keeps the layout
                                            stable (same slot) while giving a clear visual cue. */}
                                        {isOffline ? (
                                            <div
                                                className="absolute left-4 top-1/2 -translate-y-1/2 text-amber-400 bg-amber-500/15 p-1 rounded-md"
                                                title="Offline — showing cached data"
                                                aria-label="Offline"
                                            >
                                                <svg
                                                    className="w-4 h-4"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                >
                                                    {/* Wifi arcs with slash through — universal "no signal" glyph */}
                                                    <path d="M1 1l22 22" />
                                                    <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
                                                    <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
                                                    <path d="M10.71 5.05A16 16 0 0122.58 9" />
                                                    <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
                                                    <path d="M8.53 16.11a6 6 0 016.95 0" />
                                                    <line x1="12" y1="20" x2="12.01" y2="20" />
                                                </svg>
                                            </div>
                                        ) : (
                                            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-sky-400 bg-sky-500/10 p-1 rounded-md">
                                                <SearchIcon className="w-4 h-4" />
                                            </div>
                                        )}
                                        {/* Map picker REMOVED from the location box (Shane
                                            2026-07-21). Locations are saved from the chart's
                                            inspect popup and recalled from the ★ menu — the box
                                            itself is now a read-only display of where you are.
                                            The whole box used to open the picker too, not just
                                            the icon, so both went. */}
                                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                            <LocationStarMenu />
                                        </div>
                                    </form>
                                </div>
                            </div>
                        )}
                    </header>
                )}

                {/* System status now handled by SystemStatusButton in header */}

                {/* MAIN CONTENT AREA */}
                {currentView !== 'map' || splitActive ? (
                    <PullToRefresh
                        onRefresh={() => refreshData()}
                        disabled={
                            currentView === 'dashboard' ||
                            currentView === 'map' ||
                            PULL_REFRESH_DISABLED_VIEWS.has(currentView)
                        }
                    >
                        <main
                            id="main-content"
                            className={`grow relative flex flex-col ${isLight ? 'bg-slate-200' : 'bg-slate-950'} ${!showHeader ? 'pt-[max(2rem,env(safe-area-inset-top))]' : 'pt-0'} ${['settings', 'warnings'].includes(currentView) ? 'overflow-y-auto' : 'overflow-hidden'}`}
                        >
                            <ErrorBoundary boundaryName="MainContent">
                                <Suspense
                                    fallback={currentView === 'dashboard' ? <SkeletonDashboard /> : <SkeletonPage />}
                                >
                                    <div
                                        className={`relative flex-1 overflow-hidden ${
                                            splitActive
                                                ? 'flex gap-2 bg-black p-2 pb-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)]'
                                                : ''
                                        }`}
                                    >
                                        {splitActive && (
                                            <section
                                                // The frame owns the border, the rounding and the clip;
                                                // the aside inside keeps its negative-margin compensation
                                                // and the frame's overflow-hidden clips the dead reserved
                                                // band exactly as the app header used to cover it. The
                                                // cyan edge marks the PINNED pane — the same neon the tab
                                                // bar speaks — while the right pane stays neutral so the
                                                // eye knows which side will change when a tab is pressed.
                                                className="h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-cyan-400/50 bg-slate-950 shadow-[0_0_32px_rgba(34,211,238,0.18),inset_0_1px_0_rgba(255,255,255,0.08)]"
                                            >
                                                <aside
                                                    aria-label="The Glass"
                                                    // The Glass assumes it owns the viewport: its header is
                                                    // `position: fixed; width: 100%`, which ignores `relative`
                                                    // and painted straight over the right pane at full width.
                                                    // `contain: paint` makes this box a containing block for
                                                    // fixed descendants — the pane becomes the pane's viewport,
                                                    // which is exactly what a split needs, and it does it
                                                    // without touching the frozen Glass markup or forcing a
                                                    // compositing layer the way a transform hack would.
                                                    className="relative h-full w-full overflow-y-auto overflow-x-hidden"
                                                    style={{
                                                        contain: 'paint',
                                                        // The Glass reserves `locationHeaderHeightPx` at its top —
                                                        // the brand row plus the location card — because on a phone
                                                        // that chrome sits inside its viewport. In split, App draws
                                                        // that chrome ABOVE both panes, so the reservation is pure
                                                        // dead space and the content floats in the middle with a
                                                        // band above and the tide half off the bottom.
                                                        //
                                                        // The safe-area inset is double-counted for the same reason:
                                                        // the header already cleared it. Pull the pane up by both,
                                                        // give the height back, and the Glass's own arithmetic lands
                                                        // where it expects. Using its own numbers, not guessed
                                                        // pixels, so it stays correct if the layout is retuned.
                                                        marginTop: `calc(-1 * (max(1rem, env(safe-area-inset-top)) + ${glassTopLayout.locationHeaderHeightPx}px))`,
                                                        // Same correction at the bottom: the Glass anchors its footer at
                                                        // fixed bottom safe-inset+74px and its hero at +124px, clearing a
                                                        // tab bar that — in split — the frame has already cleared. Extend
                                                        // the pane past the frame bottom by that allowance (less 8px so
                                                        // the badge row keeps a breath of margin); the frame clips the
                                                        // rest. INSHORE/ECMWF land at the visible bottom and the tide
                                                        // graph stretches to meet them, exactly as on the phone.
                                                        height: `calc(100% + max(1rem, env(safe-area-inset-top)) + ${glassTopLayout.locationHeaderHeightPx}px + env(safe-area-inset-bottom) + 66px)`,
                                                    }}
                                                >
                                                    {glassContent}
                                                </aside>
                                            </section>
                                        )}
                                        <div
                                            ref={splitRightFrameRef}
                                            className={
                                                splitActive
                                                    ? 'relative h-full min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/25 bg-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                                                    : 'absolute inset-0'
                                            }
                                        >
                                            {/* Every page pads its own bottom to clear the tab bar that floats
                                                over it on the phone — but in split, the frame has already cleared
                                                the bar, so that padding became a dead band (the Instrument
                                                Panel's wind roses floated with "heaps of room" below them).
                                                Stretch the pane's inner surface down by exactly the allowance
                                                the container removed: pages behave as if the bar still overlaid
                                                them, the frame clips the excess, and every page's own clearance
                                                lands at the frame bottom. One rule, all pages. */}
                                            <div
                                                className="absolute inset-x-0 top-0"
                                                style={
                                                    splitActive
                                                        ? {
                                                              height: 'calc(100% + 4.5rem + env(safe-area-inset-bottom))',
                                                          }
                                                        : { height: '100%' }
                                                }
                                            >
                                                <PageTransition
                                                    pageKey={currentView}
                                                    direction={transitionDirection}
                                                    canSwipeBack={false}
                                                    onSwipeBack={() => setPage('vessel')}
                                                >
                                                    <div className="h-full overflow-y-auto overflow-x-hidden">
                                                        {/* Dashboard — special case with error/loading states */}
                                                        {currentView === 'dashboard' && glassContent}

                                                        {/* Registry-driven views — all non-dashboard/non-map pages */}
                                                        {activeViewConfig &&
                                                            (() => {
                                                                const ViewComponent = activeViewConfig.component;
                                                                const viewCtx: ViewContext = {
                                                                    setPage,
                                                                    previousView,
                                                                    setIsUpgradeOpen,
                                                                    settings: settings as unknown as Record<
                                                                        string,
                                                                        unknown
                                                                    >,
                                                                    updateSettings: updateSettings as unknown as (
                                                                        u: Record<string, unknown>,
                                                                    ) => void,
                                                                    handleFavoriteSelect,
                                                                    weatherAlerts: weatherData?.alerts || [],
                                                                };
                                                                const viewProps =
                                                                    activeViewConfig.getProps?.(viewCtx) ?? {};
                                                                const rendered = <ViewComponent {...viewProps} />;
                                                                // If this view is gated, PaywallGate decides whether to
                                                                // render the page or the upsell card based on the user's
                                                                // subscription tier. See services/SubscriptionService for
                                                                // the FEATURE_GATES table.
                                                                const gated = activeViewConfig.gatedFeature ? (
                                                                    <PaywallGate
                                                                        feature={activeViewConfig.gatedFeature}
                                                                        onUpgrade={() => setIsUpgradeOpen(true)}
                                                                        onBack={() => setPage('vessel')}
                                                                    >
                                                                        {rendered}
                                                                    </PaywallGate>
                                                                ) : (
                                                                    rendered
                                                                );
                                                                return (
                                                                    <ErrorBoundary
                                                                        boundaryName={activeViewConfig.boundaryName}
                                                                    >
                                                                        {gated}
                                                                    </ErrorBoundary>
                                                                );
                                                            })()}
                                                    </div>
                                                </PageTransition>
                                            </div>
                                        </div>
                                    </div>
                                </Suspense>
                            </ErrorBoundary>
                        </main>
                    </PullToRefresh>
                ) : null}
                {/* The chart — mounted on first visit, then kept alive hidden.
                    See the chart keep-alive note beside chartKeepAlive above.
                    id moves with visibility so main-content is never duplicated
                    while both mains exist. */}
                {(chartKeepAlive || chartVisible) && (
                    <main
                        // In split, the OTHER main also renders (it draws the
                        // frames), and it owns the main-content id — two
                        // elements with one id is how skip-links break.
                        id={chartVisible && !splitChartActive ? 'main-content' : undefined}
                        className={
                            splitChartActive && splitChartRect
                                ? 'overflow-hidden rounded-2xl bg-slate-900'
                                : 'grow w-full relative bg-slate-900 overflow-hidden'
                        }
                        style={
                            // One node, three outfits. Full-bleed on the phone;
                            // display:none while kept alive; and in split, FIXED
                            // over the measured right frame — repositioned, never
                            // remounted, because a second Mapbox spin-up is the
                            // documented process killer.
                            splitChartActive && splitChartRect
                                ? {
                                      position: 'fixed',
                                      top: splitChartRect.top,
                                      left: splitChartRect.left,
                                      width: splitChartRect.width,
                                      height: splitChartRect.height,
                                      zIndex: 40,
                                  }
                                : chartVisible
                                  ? undefined
                                  : { display: 'none' }
                        }
                    >
                        <ErrorBoundary boundaryName="MapView">
                            <Suspense
                                fallback={
                                    <div className="flex items-center justify-center h-full text-white">
                                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                                    </div>
                                }
                            >
                                <MapHub
                                    mapboxToken={settings.mapboxToken}
                                    homePort={settings.defaultLocation}
                                    pickerMode={mapPickerActive}
                                    pickerLabel="Tap the chart to choose your weather location"
                                    onLocationSelect={(lat: number, lon: number, name?: string) => {
                                        if (mapFromWxRef.current) {
                                            mapFromWxRef.current = false;
                                            setMapPickerActive(false);
                                            handleMapTargetSelect(lat, lon, name);
                                        } else {
                                            handleMapStaySelect(lat, lon, name);
                                        }
                                    }}
                                />
                            </Suspense>
                        </ErrorBoundary>
                        {/* Offline chip — matches the wifi-slash chip in the App header
                            and the Glass page's location-pill chip. Sits at top-left, only
                            visible when offline. Replaces the previous full-width amber
                            "NO SIGNAL" floating pill which clashed with the subtle treatment
                            on every other page. */}
                        {isOffline && (
                            <div
                                className="absolute z-601 pointer-events-auto flex items-center gap-1.5 px-2 py-1.5 bg-amber-500/15 border border-amber-500/25 rounded-lg backdrop-blur-md text-amber-400"
                                style={{
                                    top: 'calc(env(safe-area-inset-top) + 8px)',
                                    // The zoom readout now shares this top row.
                                    // Keep the offline indicator beside it rather
                                    // than allowing the two left-side pills to
                                    // overlap on a chart with no signal.
                                    left: '88px',
                                }}
                                title="Offline — using cached charts"
                                aria-label="Offline"
                            >
                                <svg
                                    className="w-4 h-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M1 1l22 22" />
                                    <path d="M16.72 11.06A10.94 10.94 0 0119 12.55" />
                                    <path d="M5 12.55a10.94 10.94 0 015.17-2.39" />
                                    <path d="M10.71 5.05A16 16 0 0122.58 9" />
                                    <path d="M1.42 9a15.91 15.91 0 014.7-2.88" />
                                    <path d="M8.53 16.11a6 6 0 016.95 0" />
                                    <line x1="12" y1="20" x2="12.01" y2="20" />
                                </svg>
                            </div>
                        )}
                        {/* Calypso mic (Skipper-tier) + System status ℹ — paired top-right on map view.
                            The mic steps aside while the Route Tracer is open (declutter 2026-07-17). */}
                        <div
                            className="absolute z-601 pointer-events-auto flex items-center gap-2"
                            style={{
                                top: 'calc(env(safe-area-inset-top) + 8px)',
                                right: '16px',
                            }}
                        >
                            {canUseBosunVoice && !tracerActive && (
                                <button
                                    onClick={() => setPage('voice')}
                                    className="w-12 h-12 rounded-full bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 flex items-center justify-center text-sky-400 transition-colors backdrop-blur-md shadow-lg"
                                    aria-label="Open Calypso voice console"
                                    title="Talk to Calypso"
                                >
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                                        <path d="M19 11h-1.7c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72z" />
                                    </svg>
                                </button>
                            )}
                            <Suspense fallback={<SystemStatusFallback />}>
                                <SystemStatusButton
                                    currentView={currentView}
                                    onNavigateAnchor={() => setPage('compass')}
                                    // Fixed landmark on the chart — the helm
                                    // menu below positions relative to it, so
                                    // it must not come and go.
                                    alwaysShow
                                />
                            </Suspense>
                        </div>
                        {/* Back chevron — middle-left of screen */}
                        <div className="absolute z-601 px-3" style={{ top: '50%', transform: 'translateY(-50%)' }}>
                            <button
                                onClick={() => {
                                    // Clear pin-view state when leaving map

                                    delete window.__thalassaPinView;
                                    // Go back to wherever we came from
                                    setPage(previousView || 'dashboard');
                                }}
                                aria-label="Back"
                                className="w-12 h-12 bg-slate-900/90 hover:bg-slate-800 rounded-full flex items-center justify-center border border-white/20 shadow-2xl transition-all hover:scale-110 active:scale-95"
                            >
                                <svg
                                    className="w-5 h-5 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M15.75 19.5L8.25 12l7.5-7.5"
                                    />
                                </svg>
                            </button>
                        </div>
                    </main>
                )}

                {/* BOTTOM FADE removed — was obscuring Start Tracking button on Log page */}

                <Suspense fallback={null}>
                    <ForecastSheet
                        data={sheetData}
                        isLoading={false}
                        units={settings.units}
                        isOpen={sheetOpen}
                        onClose={() => setSheetOpen(false)}
                        onViewFull={() => {
                            setSheetOpen(false);
                            setPage('dashboard');
                            if (sheetData) fetchWeather(sheetData.locationName);
                        }}
                    />
                </Suspense>

                {/* Global now-playing bar — floats above the bottom nav
                    on every page when music is queued, so the punter can
                    pause/dismiss without going back to the Music page.
                    Auto-hides on the music page itself (in-page bar
                    handles it) and when nothing's queued. */}
                {FEATURE_VISIBILITY.appleMusic && (
                    <Suspense fallback={null}>
                        <GlobalNowPlayingBar />
                    </Suspense>
                )}

                {/* The escape hatch for landscape. Deliberately small and
                    bottom-left so it stays clear of the chart FABs, and z-ordered
                    ABOVE the nav so it doubles as the close control once open. */}
                {isMobileLandscape && !isStandalonePlan && (
                    <button
                        type="button"
                        onClick={() => setLandscapeNavOpen((v) => !v)}
                        aria-label={landscapeNavOpen ? 'Hide navigation' : 'Show navigation'}
                        aria-expanded={landscapeNavOpen}
                        className="press fixed bottom-2 left-2 z-901 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-sky-500/25 bg-slate-950/90 text-sky-400 backdrop-blur-sm"
                        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
                    >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            {landscapeNavOpen ? (
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            ) : (
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                            )}
                        </svg>
                    </button>
                )}

                {/* ═══ AIS GUARD ZONE ALERT — APP-WIDE ═══
                    Detection runs everywhere (AisGuardWatch), but the alert
                    used to be mounted only on the chart surface and held its
                    list in local state. So a vessel entering the guard ring
                    while the skipper was anywhere else was announced to
                    nobody, and returning to the chart replayed nothing.

                    AisGuardZone is EDGE-triggered — once per entry, not again
                    while the vessel stays inside — so a lost alert was not
                    "you will be told again shortly". It was gone for as long
                    as that vessel remained in the ring. */}
                <AisGuardAlert />

                {(!isMobileLandscape || landscapeNavOpen) && !isStandalonePlan && (
                    <nav
                        className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                        style={{
                            background: 'rgba(10, 15, 20, 0.95)',
                            backdropFilter: 'blur(10px)',
                            WebkitBackdropFilter: 'blur(10px)',
                            borderColor: 'rgba(56, 189, 248, 0.12)',
                        }}
                        aria-label="Main"
                    >
                        <div
                            className="flex justify-around items-center h-16 mx-auto px-4 relative"
                            role="tablist"
                            aria-label="Main navigation"
                        >
                            <NavButton
                                icon={
                                    <StormGlassNavIcon
                                        className="w-full h-full object-contain"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                        }}
                                    />
                                }
                                label="The Glass"
                                active={currentView === 'dashboard' || splitActive}
                                onClick={handleGlassTab}
                                onLongPress={wideEnoughForSplit ? toggleSplitView : undefined}
                            />
                            <NavButton
                                icon={
                                    <div
                                        className="w-full h-full flex items-center justify-center text-cyan-300"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                        }}
                                    >
                                        <MapIcon className="w-7 h-7" />
                                    </div>
                                }
                                label="OBS"
                                ariaLabel="Navigate to Charts and observations"
                                // Plotting lives on the map surface but BELONGS to
                                // Plan: "Slide to Start Plotting" does setPage('map'),
                                // which lit OBS and made the tab bar contradict the
                                // journey the skipper is on (Shane 2026-07-18). While
                                // the tracer is up the highlight stays on Plan.
                                active={currentView === 'map' && !tracerActive}
                                onClick={() => {
                                    mapFromWxRef.current = false;
                                    // Already ON the map while plotting, so setPage
                                    // alone is inert — OBS was the one tab that
                                    // could not be reached from the tracer. Close the
                                    // tracer instead; MapHub keeps the pins and offers
                                    // the 🧭 pill to resume, so this costs nothing.
                                    if (tracerActive) {
                                        window.dispatchEvent(new CustomEvent('thalassa:trace-mode-exit'));
                                    }
                                    handleTabMap();
                                }}
                            />
                            {/* Plan — was: Scuttlebutt (chat). The 5-tab
                                restructure (Week 2) replaces the social
                                tab with the dedicated route planner.
                                Scuttlebutt is reachable from the Vessel
                                hub's Wardroom section. Icon `color` set
                                inline to #67E8F9 (cyan-300) so the
                                SVG's currentColor stroke matches the
                                cyan hue baked into the PNG nav icons
                                (Glass, OBS, Vessel). */}
                            <NavButton
                                icon={
                                    <div
                                        className="w-full h-full flex items-center justify-center"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            color: '#67E8F9',
                                        }}
                                    >
                                        <RouteIcon className="w-7 h-7" />
                                    </div>
                                }
                                label="Plan"
                                // Stays lit through the whole plan journey — the
                                // front door (voyage) AND the plotting surface the
                                // slide hands you to (map + tracer). Mirror of the
                                // OBS gate above; the two can't both be lit.
                                active={currentView === 'voyage' || (currentView === 'map' && tracerActive)}
                                onClick={() => setPage('voyage')}
                            />
                            {/* Log — promoted from a Vessel sub-page (was
                                reached via Nav Station → Log Book) to a
                                top-level tab in the Week 2 restructure.
                                Plan → Sail → Share → Hear → Trust order
                                means Log sits directly between Plan and
                                Vessel in the nav. Same #67E8F9 cyan as
                                Plan so the two new SVG tabs visually
                                pair with the PNG nav icons. */}
                            <NavButton
                                icon={
                                    <div
                                        className="w-full h-full flex items-center justify-center"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            color: '#67E8F9',
                                        }}
                                    >
                                        <ClipboardIcon className="w-7 h-7" />
                                    </div>
                                }
                                label="Log"
                                active={currentView === 'details'}
                                onClick={() => setPage('details')}
                            />
                            <NavButton
                                icon={
                                    <div
                                        className="w-full h-full flex items-center justify-center text-cyan-300"
                                        style={{
                                            WebkitMaskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                            maskImage: 'radial-gradient(circle, black 55%, transparent 75%)',
                                        }}
                                    >
                                        <SailBoatIcon className="w-7 h-7" />
                                    </div>
                                }
                                label="Vessel"
                                active={isVesselView || currentView === 'chat'}
                                onClick={() => setPage('vessel')}
                                // chatUnread badge moves to Vessel — chat
                                // now lives under Vessel → Wardroom →
                                // Scuttlebutt. Showing the unread count
                                // on Vessel surfaces new DMs / community
                                // activity at the same visibility as
                                // before, just one nav layer deeper.
                                badge={chatUnread > 0 ? chatUnread : undefined}
                            />
                        </div>
                    </nav>
                )}
            </div>

            {/* NIGHT-VISION SCRIM — must be the TOPMOST layer in the app.
                It sat at z-9999 and lost to twelve overlays at z >= 10000:
                the Chart depth controls (10060), the trip leg picker (10060),
                the Plan-on-web hint (10070), the departure prompt (10055), the
                trace report (10050), onboarding (10000) and more. Every one of
                those painted at FULL brightness over a scrim that exists to
                protect the helm's dark adaptation — worst at the chart, at
                night, which is exactly when it matters.

                Bumping the number would only lose the race to the next overlay,
                so the value is DERIVED from the overlay scale — one band below
                `critical`, the tier reserved for alarms that must outrank every
                other surface, because a drag alarm at 3am should punch through a
                night scrim. tests/NightVisionScrimCeiling.test.ts enforces that
                nothing else creeps above it. */}
            {/* App-wide screen dim — arms only while KeepAwake is held and the
                Aesthetics preference is on; MOB and anchor alarms suppress it.
                Sits one layer under the night scrim, below `critical`. */}
            <ScreenDimHost />
            {effectiveMode === 'night' && (
                <div
                    className="fixed inset-0 pointer-events-none touch-none"
                    style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: NIGHT_SCRIM_Z_INDEX }}
                    aria-hidden="true"
                ></div>
            )}
        </div>
    );
};

export default App;
