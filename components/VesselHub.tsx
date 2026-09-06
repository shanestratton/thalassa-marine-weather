/**
 * VesselHub — Nav Station dashboard.
 *
 * Layout (top → bottom):
 *   Hero band:           vessel name · voyage state · position fix · time-since-fix
 *   Watch Status:        4 pinned tiles — anchor, guardian, MOB, radio (never scrolls)
 *   ── the scrolling area starts here (Shane 2026-08-30) ──
 *   Diary + Scuttlebutt: the two read-most screens, so they lead
 *   Skipper device:      publishing authority · which GPS speaks for the boat
 *   Passage Planning:    voyage prep, directly below Skipper device
 *   Boat Binder:         GPX import + inventory + reference
 *   Inventory & Maint.:  Stores · Equipment · Repairs & Maintenance
 *   Reference:           Checklists · Polars · Documents
 *   Atmosphere:          Music (Apple Music) — "music on watch", non-essential
 *   Connect:             NMEA Gateway · Boat Network
 *   Account:             Settings + tier
 *
 * Recipe Library has moved to the Galley; keeping it in two places
 * confused users and the Galley is the natural home for it.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AnchorWatchSyncService } from '../services/AnchorWatchSyncService';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { useSettings } from '../context/SettingsContext';
import { buildClaim, claimAgeLabel, holdsClaim, type SkipperClaim } from '../services/skipperDevice';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';
import { piCache } from '../services/PiCacheService';
import { useCloudTelemetry } from '../hooks/useCloudTelemetry';
import { useNmeaConnectionStatus } from './nmea/useNmeaStore';
import { refreshSkipperClaim } from '../stores/settingsStore';
import { useWeather } from '../context/WeatherContext';
import { useUIStore } from '../stores/uiStore';
import { triggerHaptic } from '../utils/system';
import { convertLength } from '../utils/units';
import { calculateDistance } from '../utils/navigationCalculations';
import { getMyCrew } from '../services/CrewService';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { useVesselReadinessCounts } from '../hooks/useVesselReadinessCounts';
import { GpsService, type GpsPosition } from '../services/GpsService';
import { getCachedActiveVoyage, type Voyage } from '../services/VoyageService';
import { WindIcon, WaveIcon, ThermometerIcon, DropletIcon, EyeIcon } from './Icons';
import { useAuthStore } from '../stores/authStore';
import { SignInScreen } from './SignInScreen';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { BackButton } from './ui/BackButton';
import { PUBLIC_BETA_ACCESS, TIER_INFO } from '../services/SubscriptionService';
import type { SubscriptionTier } from '../types/settings';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';
import { vesselCrewAboard } from '../services/units';

import { CONTOUR_BG, GLASS, PASSAGE_PLANNING_GROUP } from './vesselHub/glass';
import { formatCoord, formatDuration, formatTimeSince, pressureTrendIndicator } from './vesselHub/format';
import {
    BookIcon,
    BoxIcon,
    ChartIcon,
    ChatBubbleIcon,
    ChecklistIcon,
    ChevronRight,
    ClipboardIcon,
    CrewIcon,
    DocShieldIcon,
    GalleyIcon,
    GpxIcon,
    MapChartIcon,
    MobIcon,
    PenIcon,
    ShieldIcon,
    SignalIcon,
    UserIcon,
    WrenchIcon,
} from './vesselHub/icons';
import { BinderSubLabel, CollapsibleContent, ListDivider, OfficeRow } from './vesselHub/listRows';
import { MetricChipStrip } from './vesselHub/MetricChip';
import { SectionHeader } from './vesselHub/SectionHeader';
import { SwingArc } from './vesselHub/SwingArc';
import { useTripRoute } from '../hooks/useTripRoute';
import { type MetricChipData, type SkipperDeviceControlProps, type VesselHubProps } from './vesselHub/types';
import { useGuardianTileState } from './vesselHub/useGuardianTileState';
import { usePendingCrewInvites } from './vesselHub/usePendingCrewInvites';
import { useTripLogActive } from './vesselHub/useTripLogActive';

// The four pinned navigation-station controls are operational safety tools,
// not ordinary shortcuts. Give the group a calm, visible emerald bezel so it
// can be found immediately, while the alert variant below remains red for
// genuine emergency states (MOB and a dragging anchor).
const SAFETY_CONTROL_GROUP = {
    background:
        'var(--vessel-safety-group-bg, linear-gradient(135deg, rgba(16, 185, 129, 0.14) 0%, rgba(6, 78, 59, 0.08) 48%, rgba(20, 25, 35, 0.08) 100%))',
    border: '1px solid var(--vessel-safety-group-border, rgba(74, 222, 128, 0.28))',
    boxShadow: '0 0 0 1px rgba(16, 185, 129, 0.06), 0 10px 26px rgba(5, 150, 105, 0.10)',
} as React.CSSProperties;

const SAFETY_CONTROL_CARD = {
    ...GLASS.card,
    background:
        'var(--vessel-safety-card-bg, linear-gradient(145deg, rgba(16, 185, 129, 0.15) 0%, rgba(20, 25, 35, 0.82) 72%))',
    border: '1px solid var(--vessel-safety-card-border, rgba(74, 222, 128, 0.42))',
    boxShadow:
        'inset 0 1px 0 rgba(167, 243, 208, 0.22), 0 0 0 1px rgba(16, 185, 129, 0.10), 0 8px 22px rgba(16, 185, 129, 0.12)',
} as React.CSSProperties;

const ALERT_SAFETY_CONTROL_CARD = {
    ...SAFETY_CONTROL_CARD,
    background:
        'var(--vessel-alert-card-bg, linear-gradient(145deg, rgba(127, 29, 29, 0.56) 0%, rgba(20, 25, 35, 0.86) 72%))',
    border: '1px solid rgba(248, 113, 113, 0.62)',
    boxShadow:
        'inset 0 1px 0 rgba(254, 202, 202, 0.20), 0 0 0 1px rgba(239, 68, 68, 0.14), 0 8px 22px rgba(239, 68, 68, 0.16)',
} as React.CSSProperties;

export const VesselHub: React.FC<VesselHubProps> = React.memo(({ onNavigate, settings }) => {
    // ── Vessel state ──
    const { settings: ctx, updateSettings } = useSettings();
    const authenticatedUserId = useAuthStore((state) => state.user?.id ?? null);
    const isObserver = (ctx as { vessel?: { type?: string } })?.vessel?.type === 'observer';
    // Which device speaks for this boat (services/skipperDevice.ts). Read from
    // the live store rather than the `settings` prop so a takeover on another
    // device reflects here as soon as settings sync brings it down.
    const skipperClaim =
        (ctx as { skipperDevice?: import('../services/skipperDevice').SkipperClaim })?.skipperDevice ?? null;

    // ── Anchor state ──
    const [anchorStatus, setAnchorStatus] = useState<'armed' | 'disarmed' | 'alarm'>('disarmed');
    // Whether something OTHER than this phone is keeping the watch.
    //
    // The card used to read AnchorWatchService alone, which is this device's
    // OWN watch. When the Pi takes the watch, handleAcceptPiWatch stops the
    // local one — that is the point of going ashore — so the local state goes
    // idle and this card reported "Off" while the boat was being watched all
    // night. Wrong, and wrong in the reassuring direction: a glance at the
    // Vessel page said nothing was guarding the anchor.
    const [anchorWatchedRemotely, setAnchorWatchedRemotely] = useState(false);
    const [anchorRadius, setAnchorRadius] = useState(0);
    // The daily operational tiles and the Diary/Scuttlebutt pair are now
    // permanently visible. Only the low-priority Settings & Connect area
    // remains collapsible; it starts closed.
    // The broader IA groups are:
    //   - Watch Status (always-visible daily ops grid)
    //   - Diary + Scuttlebutt (always-visible navigation tiles)
    //   - Boat Binder  (collapsed: imports / inventory / reference rows)
    //   - Atmosphere   (collapsed: Music — Scuttlebutt moved out to
    //                   Sharing 2026-05-17, section renamed from
    //                   "Wardroom" to "Atmosphere" the same day. The
    //                   bucket exists for "music on watch" — non-
    //                   essential, intentionally low-key, but reachable
    //                   in 2 taps. Section ID stays 'wardroom' so any
    //                   persisted expanded-state from localStorage
    //                   continues to match — only the label changed.)
    //   - Settings & Connect (collapsed: NMEA + Boat Network + Account)
    // Section IDs renamed: 'passage' + 'inventory' + 'reference' →
    // 'binder', 'connect' + 'account' → 'setup'. Any old persisted
    // expanded-state from localStorage referencing the old IDs is
    // harmless; the Set just won't match any current section.
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // Boat Binder is a SCREEN, not a section — see the row that opens it below.
    const [binderOpen, setBinderOpen] = useState(() => {
        if (typeof window === 'undefined') return false;
        const key = authScopedStorageKey('thalassa_boat_binder_return');
        try {
            const shouldReturn = sessionStorage.getItem(key) === '1';
            sessionStorage.removeItem(key);
            return shouldReturn;
        } catch {
            return false;
        }
    });

    // ── Hero band state — vessel name, active voyage, GPS fix, wind, network ──
    const rawVesselName = (ctx as { vessel?: { name?: string } })?.vessel?.name as string | undefined;
    const vesselName: string = rawVesselName || 'Your Vessel';
    // How the boat is being read right now: her own gateway when aboard, the
    // Pi's cloud snapshot when away (Shane 2026-09-07: "update the NMEA
    // Gateway card since it will not need to directly connect any more").
    const nmeaLink = useNmeaConnectionStatus();
    const gatewayStatus =
        nmeaLink.status === 'connected'
            ? 'Connected · instruments & AIS'
            : nmeaLink.status === 'remote'
              ? `Away · reading her via ${nmeaLink.remote?.deviceLabel ?? 'the Pi'}`
              : 'Instruments & AIS · connect when aboard';
    const gatewayStatusColor =
        nmeaLink.status === 'connected' ? '#6ee7b7' : nmeaLink.status === 'remote' ? '#7dd3fc' : '#94a3b8';
    const vesselNameSet = !!rawVesselName && rawVesselName.trim().length > 0;
    const [activeVoyage, setActiveVoyage] = useState<Voyage | null>(() => getCachedActiveVoyage());
    const [position, setPosition] = useState<GpsPosition | null>(null);
    // ── Hero band weather chips: single source of truth ──
    // Pull from WeatherContext (the same orchestrator the Glass page
    // uses) instead of running a parallel fetchFastWeather call.
    // Glass and Nav Station now read identical numbers from the same
    // cache — no more "wind is 12kt on Glass but 14kt on Nav Station"
    // mismatch from two independent fetch paths racing each other.
    //
    // The orchestrator handles its own refresh schedule; Nav Station
    // re-renders automatically when weatherData changes.
    const { weatherData, fetchWeather } = useWeather();
    const current = weatherData?.current;
    const windSpeed = current?.windSpeed ?? null;
    const windDir = current?.windDirection || null;
    // weatherData.current.waveHeight is always stored in FEET — every
    // upstream transformer (openmeteo / transformers / weatherRouter)
    // converts metres → feet before assigning. Convert here using the
    // user's preferred unit so the hero chip shows the right number
    // alongside the right label. Without this, a 1 m wave was showing
    // as "3.3 m" — the feet value labelled meters.
    const waveUnit = ((ctx as { units?: { waveHeight?: 'ft' | 'm' } })?.units?.waveHeight ?? 'm') as 'ft' | 'm';
    const rawWaveFt = current?.waveHeight ?? null;
    const waveHeight = rawWaveFt !== null ? convertLength(rawWaveFt, waveUnit) : null;
    const airTemp = current?.airTemperature ?? null;
    const seaTemp = current?.waterTemperature ?? null;
    const visibility = current?.visibility ?? null;
    const pressureTrend = current?.pressureTrend ?? null;
    const tideTrend = current?.tideTrend ?? null;
    // Probe-driven WAN reachability (uiStore.isOffline ← internetProbe),
    // not navigator.onLine — a boat LAN with a dead uplink reports
    // onLine=true, which used to green-light weather fetches into a wall.
    const isOnline = !useUIStore((s) => s.isOffline);

    // Extended anchor snapshot for the relative swing viz — vessel
    // offset (m) and bearing FROM anchor TO vessel (deg). Both come
    // off the AnchorWatchSnapshot directly.
    const [anchorOffset, setAnchorOffset] = useState<number>(0);
    const [anchorBearing, setAnchorBearing] = useState<number>(0);

    // Active route destination — populated by PassageStore when the
    // user has planned a route. Used for distance-remaining on the
    // voyage row in the hero band.
    const [destCoords, setDestCoords] = useState<{ lat: number; lon: number } | null>(null);
    const [routeNm, setRouteNm] = useState<number | null>(null);

    const tripLogActive = useTripLogActive();

    useEffect(() => {
        // Refresh cached voyage on mount (cheap localStorage read).
        setActiveVoyage(getCachedActiveVoyage());

        // Validate the cache against Supabase so a stale "active"
        // voyage from a deleted route can't keep showing in the hero
        // band. getActiveVoyage() queries the DB for any voyage with
        // status='active' for this user; if there's none, it clears
        // the local cache for us via cacheVoyage(null) inside.
        let cancelled = false;
        (async () => {
            try {
                const { getActiveVoyage } = await import('../services/VoyageService');
                const fresh = await getActiveVoyage();
                if (!cancelled) setActiveVoyage(fresh);
            } catch {
                /* offline — keep the cached value */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        // Watch GPS for the hero band. Throttle re-renders by caching
        // the previous timestamp — we only repaint when we get a fresh
        // fix (avoids re-rendering on every duplicate event from the
        // BgGeoManager when the boat is stationary).
        let lastTs = 0;
        const unsub = GpsService.watchPosition((pos) => {
            if (pos.timestamp > lastTs) {
                lastTs = pos.timestamp;
                setPosition(pos);
            }
        });
        // Also read one foreground fix if the OS grant already exists. The
        // Nav Station may be restored at launch, so this must never prompt or
        // initialize background/motion tracking merely to paint its hero band.
        GpsService.getCurrentPositionIfGranted({ staleLimitMs: 60_000, timeoutSec: 8 })
            .then((pos) => {
                if (pos && pos.timestamp > lastTs) {
                    lastTs = pos.timestamp;
                    setPosition(pos);
                }
            })
            .catch(() => {
                /* GPS not available — hero band will show "no fix" */
            });
        return unsub;
    }, []);

    // Re-render once a minute so "1 min ago" → "2 min ago" updates
    // even when the GPS fix hasn't changed.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 60_000);
        return () => clearInterval(id);
    }, []);

    // If WeatherContext has no data yet (user landed on Nav Station
    // first, before the Dashboard auto-fetched), kick off a fetch via
    // the shared orchestrator using our GPS position. This populates
    // the SAME cache the Glass page reads — no parallel pipeline.
    // Refreshes are handled by the orchestrator's schedule (already
    // running in WeatherContext); we don't poll here.
    const weatherLatitudeBucket = position ? Math.round(position.latitude * 10) : null;
    const weatherLongitudeBucket = position ? Math.round(position.longitude * 10) : null;
    useEffect(() => {
        if (weatherData) return; // already populated — orchestrator handles refresh
        if (weatherLatitudeBucket === null || weatherLongitudeBucket === null || !isOnline) return;
        // Round to 0.1° to dedupe near-identical re-renders.
        const lat = weatherLatitudeBucket / 10;
        const lon = weatherLongitudeBucket / 10;
        // silent=true so the orchestrator doesn't show a loading
        // overlay — the Nav Station hero chips just stay empty until
        // the data lands.
        fetchWeather('Current Position', false, { lat, lon }, false, true).catch(() => {
            /* offline — chips stay empty */
        });
    }, [weatherData, weatherLatitudeBucket, weatherLongitudeBucket, isOnline, fetchWeather]);

    const toggleSection = (id: string) => {
        triggerHaptic('light');
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snapshot) => {
            setAnchorRadius(snapshot.swingRadius || 0);
            setAnchorStatus(
                snapshot.state === 'alarm' ? 'alarm' : snapshot.state === 'watching' ? 'armed' : 'disarmed',
            );
            // Extended snapshot for the relative swing viz — keeps the
            // hero arc showing the boat's actual offset/bearing from
            // the anchor point, not just a static radius circle.
            setAnchorOffset(snapshot.distanceFromAnchor || 0);
            setAnchorBearing(snapshot.bearingToAnchor || 0);
        });
        return unsub;
    }, []);

    useEffect(
        () =>
            AnchorWatchSyncService.onStateChange((state) =>
                setAnchorWatchedRemotely(state.role === 'shore' && !!state.sessionCode),
            ),
        [],
    );

    // Subscribe to PassageStore for the active planned route's
    // destination coords + total distance. Populated when the user
    // plans a route from the Charts page; stays null otherwise.
    useEffect(() => {
        let cancelled = false;
        let unsub: (() => void) | null = null;
        (async () => {
            try {
                const { PassageStore } = await import('../stores/PassageStore');
                const apply = (s: {
                    hasRoute: boolean;
                    arriveLat: number | null;
                    arriveLon: number | null;
                    totalDistanceNM: number;
                }) => {
                    if (cancelled) return;
                    if (s.hasRoute && s.arriveLat !== null && s.arriveLon !== null) {
                        setDestCoords({ lat: s.arriveLat, lon: s.arriveLon });
                        setRouteNm(s.totalDistanceNM || null);
                    } else {
                        setDestCoords(null);
                        setRouteNm(null);
                    }
                };
                apply(PassageStore.getState());
                unsub = PassageStore.subscribe(apply);
            } catch {
                /* PassageStore not loaded yet */
            }
        })();
        return () => {
            cancelled = true;
            if (unsub) unsub();
        };
    }, []);

    const pendingCrewInvites = usePendingCrewInvites(authenticatedUserId);

    // ── Live tile state — guardian status, maintenance overdue ──
    // entriesToday + routeCount + trackCount removed 2026-05-17:
    // they powered the Log Book tile in Quick Actions which got
    // deleted (duplicated the bottom-nav Log tab). Their fetch +
    // event-subscription logic moved to LogPage.tsx where the
    // counts now render as a status header above the voyage list.
    const { guardianArmed, guardianNearby } = useGuardianTileState();

    // ── Live counts for Boat Binder row badges ──
    // Maintenance overdue / Documents expiring / Equipment warranty.
    // Extracted to a hook (useVesselReadinessCounts) so the
    // mutation→event→refetch propagation path — the one behind the
    // "1 Overdue still showing" bug — is independently testable.
    const { overdueCount, expiringDocsCount, expiringEquipCount } = useVesselReadinessCounts();

    // ── Draft passage plans ──
    const [passageCrewCount, setPassageCrewCount] = useState(0);
    // Refresh the crew count whenever vessel_crew changes (invite
    // accepted / crew removed) — not just on mount. Added 2026-05-20
    // in the staleness-hardening sweep: this tile was the one
    // summary surface still reading once on mount with no refresh
    // trigger, so the "{n} crew" planning hint could go stale while
    // the Nav Station stayed open. useRealtimeSync mirrors the
    // pattern the Documents / Equipment tiles already use.
    const configuredPassageCrewCount = vesselCrewAboard((ctx as { vessel?: { crewCount?: number } }).vessel);
    const loadPassageCrew = useCallback(async () => {
        const scope = getAuthIdentityScope();
        if (scope.userId !== authenticatedUserId) return;
        try {
            const c = await getMyCrew();
            if (!isAuthIdentityScopeCurrent(scope)) return;
            // max(settings count, actual crew + captain)
            const actualWithCaptain = c.length + 1;
            setPassageCrewCount(Math.max(configuredPassageCrewCount, actualWithCaptain));
        } catch {
            /* offline — keep previous count */
        }
    }, [authenticatedUserId, configuredPassageCrewCount]);
    useEffect(() => {
        setPassageCrewCount(0);
        void loadPassageCrew();
    }, [loadPassageCrew]);
    useRealtimeSync('vessel_crew', loadPassageCrew);

    // ── Saved-route library count ──
    // This is the canonical tracer/saved_routes library shown on the Plan
    // page, not the old planned_* Log mirror. Read local storage first so the
    // Vessel card is useful offline, then pull-merge the account copy. Every
    // async boundary is fenced to the identity that started it: route names
    // and even their count are private account data.
    // The Saved Routes row this fed is gone (2026-08-04), but the effect
    // stays: it pull-merges the account's saved routes on Vessel mount,
    // which Passage Planning relies on being warm.
    const [_savedRouteCount, setSavedRouteCount] = useState(0);
    useEffect(() => {
        let cancelled = false;
        let requestId = 0;

        const refresh = (scope: AuthIdentityScope) => {
            const thisRequest = ++requestId;
            // Hide the previous account's count synchronously. The local read
            // below restores the new account's count as soon as its chunk is
            // available, before any network round-trip.
            setSavedRouteCount(0);

            void (async () => {
                try {
                    const { loadSavedTraces } = await import('../services/routeTracer');
                    if (cancelled || thisRequest !== requestId || !isAuthIdentityScopeCurrent(scope)) {
                        return;
                    }
                    setSavedRouteCount(loadSavedTraces(scope).length);

                    const { syncSavedRoutes } = await import('../services/savedRoutesSync');
                    if (cancelled || thisRequest !== requestId || !isAuthIdentityScopeCurrent(scope)) {
                        return;
                    }
                    const merged = await syncSavedRoutes();
                    if (cancelled || thisRequest !== requestId || !isAuthIdentityScopeCurrent(scope)) {
                        return;
                    }
                    setSavedRouteCount(merged.length);
                } catch {
                    // Offline/import failure: retain the local count if it was
                    // already recovered, otherwise the honest empty state.
                }
            })();
        };

        refresh(getAuthIdentityScope());
        const unsubscribeIdentity = subscribeAuthIdentityScope((next) => refresh(next));
        return () => {
            cancelled = true;
            requestId += 1;
            unsubscribeIdentity();
        };
    }, []);

    // ── Anchor display ──
    // anchorRadius comes from `snapshot.swingRadius`, which is computed
    // via Math.sqrt(rodeLength² - waterDepth²) * sensor-type factor —
    // i.e. naturally a long float. Clamp to 1 decimal so the nav-station
    // card reads "Armed — 50.0m" instead of "Armed — 50.000000000004m".
    // One word, because a quarter-width tile cannot hold more. This replaced a
    // richer label ("Armed — 45.0m", plus a triangle icon on DRAG ALARM) when the
    // tiles went four-across; the radius is one tap away on the Anchor screen,
    // and the colour-coded dot — which pulses on alarm — does the shouting.
    // 'Off' said nothing useful under a heading that already reads "Anchor" —
    // off what? Down/Up is what a skipper actually says about an anchor, and
    // the remote case is named outright so it is never mistaken for this phone
    // watching (Shane 2026-09-04: "the anchor card says anchor off, maybe it
    // should say anchor on??? or down?????").
    const anchorEffectivelyArmed = anchorStatus === 'armed' || anchorWatchedRemotely;
    const anchorLabelShort: string =
        anchorStatus === 'alarm'
            ? 'DRAGGING'
            : anchorStatus === 'armed'
              ? 'Down'
              : anchorWatchedRemotely
                ? 'Down · Pi'
                : 'Up';
    const anchorColor = anchorStatus === 'alarm' ? '#ef4444' : anchorEffectivelyArmed ? '#22d3ee' : '#9ca3af';
    // The hero card asks the same question ("At Anchor" vs "Underway"), so it
    // must get the same answer. A boat whose anchor is watched by the Pi is at
    // anchor; only this phone's involvement changed.
    const anchorStatusEffective: 'armed' | 'disarmed' | 'alarm' =
        anchorStatus === 'alarm' ? 'alarm' : anchorEffectivelyArmed ? 'armed' : 'disarmed';

    const navigateFromBinder = useCallback(
        (page: string) => {
            try {
                sessionStorage.setItem(authScopedStorageKey('thalassa_boat_binder_return'), '1');
            } catch {
                /* navigation still works when session storage is unavailable */
            }
            onNavigate(page);
        },
        [onNavigate],
    );

    // BOAT BINDER SCREEN. Rendered instead of the hub — same wrapper and scroll
    // container, its own header, hardware-free back. Kept INSIDE VesselHub rather
    // than extracted to a routed view because the rows below read a dozen pieces
    // of this component's state (live counts, handlers, GLASS); lifting them out
    // would mean threading all of that through props for no user-visible gain.
    if (binderOpen) {
        return (
            <div
                className="vessel-hub-surface w-full h-full flex flex-col animate-in fade-in duration-300 vessel-hub-no-scrollbar"
                style={{
                    paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                    backgroundImage: CONTOUR_BG,
                    backgroundSize: '400px 400px',
                    backgroundColor: 'var(--vessel-surface-bg, transparent)',
                }}
            >
                <div className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-4">
                    <BackButton
                        onClick={() => {
                            triggerHaptic('light');
                            setBinderOpen(false);
                        }}
                        label="Back to Vessel"
                        className="shrink-0"
                    />
                    <span className="text-xl font-extrabold uppercase tracking-wider text-white">Boat Binder</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto vessel-hub-no-scrollbar px-4 pb-4">
                    {/* The Passage subgroup is gone (Shane 2026-09-02, binder
                        review, shelf #1): after Saved Routes was culled
                        (2026-08-04) it was a grand heading over one import
                        button. Import GPX now lives at the tail of Reference
                        below AND on the Plan page's front door — the tool
                        kept its shelf, routes kept their home. */}

                    {/* — Inventory & Stores subgroup — */}
                    <BinderSubLabel>Inventory &amp; Stores</BinderSubLabel>
                    <div style={GLASS.listContainer}>
                        <OfficeRow
                            icon={<BoxIcon color="#cbd5e1" />}
                            label="Ship's Stores"
                            status="Provisions & Spares"
                            statusColor="#94a3b8"
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('inventory');
                            }}
                        />
                        <ListDivider />
                        {/* Checklists moved here from Reference (Shane
                            2026-09-04). A checklist is something you WORK
                            THROUGH against the boat and its stores — safety
                            gear, passage prep — not something you look up, so
                            it belongs beside Ship's Stores and Equipment
                            rather than filed with the polars. */}
                        <OfficeRow
                            icon={<ChecklistIcon color="#cbd5e1" />}
                            label="Checklists"
                            status="Safety & Passage"
                            statusColor="#94a3b8"
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('checklists');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<ClipboardIcon color="#cbd5e1" />}
                            label="Equipment"
                            status={expiringEquipCount > 0 ? `${expiringEquipCount} Warranty Soon` : 'Register'}
                            statusColor={expiringEquipCount > 0 ? '#f59e0b' : '#94a3b8'}
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('equipment');
                            }}
                            badge={expiringEquipCount > 0 ? expiringEquipCount : undefined}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<WrenchIcon color={overdueCount > 0 ? '#ef4444' : '#cbd5e1'} />}
                            label="Repairs & Maintenance"
                            status={overdueCount > 0 ? `${overdueCount} Overdue` : 'Tasks & Expiry'}
                            statusColor={overdueCount > 0 ? '#ef4444' : '#94a3b8'}
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('maintenance');
                            }}
                            badge={overdueCount > 0 ? overdueCount : undefined}
                            badgeUrgent={overdueCount > 0}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<DocShieldIcon color={expiringDocsCount > 0 ? '#ef4444' : '#cbd5e1'} />}
                            label="Documents"
                            status={expiringDocsCount > 0 ? `${expiringDocsCount} Expiring` : 'Legal'}
                            statusColor={expiringDocsCount > 0 ? '#ef4444' : '#94a3b8'}
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('documents');
                            }}
                            badge={expiringDocsCount > 0 ? expiringDocsCount : undefined}
                            badgeUrgent={expiringDocsCount > 0}
                        />
                    </div>

                    {/* Documents moved here from Reference (Shane 2026-09-02,
                        binder review): the ship's papers live with the ship's
                        stores — everything the vessel CARRIES in one group,
                        tools-you-consult in the other. */}

                    {/* — Reference subgroup — */}
                    <BinderSubLabel>Reference</BinderSubLabel>
                    <div style={GLASS.listContainer}>
                        {/* Galley moved here from Inventory & Stores (Shane
                            2026-09-04). It reads as recipes and meal planning —
                            reference material you consult — while its LINK to
                            stores is the provisioning flow inside it, not the
                            menu it hangs off.

                            Kept from the 2026-05-17 orphan audit, because it
                            still matters: GalleyPage's docstring once claimed
                            it was reachable from a grid whose tile had been
                            silently removed, so paying users could not reach a
                            feature they had bought. PaywallGate is auto-applied
                            by viewRegistry via gatedFeature: 'galley', so free
                            users get an upgrade prompt, not a broken page. */}
                        <OfficeRow
                            icon={<GalleyIcon color="#cbd5e1" />}
                            label="Galley"
                            status="Meal Planning"
                            statusColor="#94a3b8"
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('galley');
                            }}
                        />
                        {/* Weather Window row culled (Shane 2026-09-02, binder
                            review): "it is no good, we already have one on the
                            passage planning" — the go/no-go score lives where
                            the passage decision is made. */}
                        <ListDivider />
                        <OfficeRow
                            icon={<BookIcon color="#38bdf8" />}
                            label="Skipper's Reference"
                            status="GRIB · Synoptic · Squalls"
                            statusColor="#38bdf8"
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('skipperReference');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<ChartIcon color="#cbd5e1" />}
                            label="Polars"
                            status={isObserver ? 'Vessel Required' : 'Tuning'}
                            statusColor={isObserver ? '#6b7280' : '#94a3b8'}
                            onClick={() => {
                                if (isObserver) return;
                                triggerHaptic('light');
                                navigateFromBinder('polars');
                            }}
                            disabled={isObserver}
                        />
                        {/* Notices to Mariners culled from the binder (Shane
                            2026-09-02): "wrong spot for them. we have them on
                            the obs page anyway. so lets not hide them here."
                            Notices are perishable and spatial — they live on
                            the chart, not in the reference drawer. */}
                        <ListDivider />
                        <OfficeRow
                            icon={<GpxIcon color="#cbd5e1" />}
                            label="Import GPX"
                            status="OpenCPN • Navionics"
                            statusColor="#94a3b8"
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('gpx-import');
                            }}
                        />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="vessel-hub-surface w-full h-full flex flex-col animate-in fade-in duration-300 vessel-hub-no-scrollbar"
            style={{
                paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                backgroundImage: CONTOUR_BG,
                backgroundSize: '400px 400px',
                backgroundColor: 'var(--vessel-surface-bg, transparent)',
            }}
        >
            {/*
                Fixed operational deck. This intentionally sits OUTSIDE the
                scroll port below: Safari can lose `position: sticky` while a
                stagger entrance animation leaves a transformed ancestor in
                place. Making the weather/position card and safety controls a
                non-shrinking flex sibling gives them a real, stationary home
                while only the lower-priority vessel content scrolls.

                The root already reserves the bottom-tab safe area; keeping
                this deck in normal flex layout also means its dynamic anchor
                and voyage states never overlap the first scrollable card.
            */}
            <section className="z-20 shrink-0 px-4 pt-4 pb-1" aria-label="Vessel status and safety controls">
                {/* ═══════════════════════════════════════════ */}
                {/* HERO BAND — situational awareness           */}
                {/* Vessel · voyage state · last fix            */}
                {/* ═══════════════════════════════════════════ */}
                <div>
                    <NavStationHero
                        vesselName={vesselName}
                        vesselNameSet={vesselNameSet}
                        voyage={activeVoyage}
                        tripLogActive={tripLogActive}
                        position={position}
                        anchorStatus={anchorStatusEffective}
                        anchorRadius={anchorRadius}
                        anchorOffset={anchorOffset}
                        anchorBearing={anchorBearing}
                        windSpeed={windSpeed}
                        windDir={windDir}
                        waveHeight={waveHeight}
                        waveUnit={waveUnit}
                        airTemp={airTemp}
                        seaTemp={seaTemp}
                        visibility={visibility}
                        pressureTrend={pressureTrend}
                        tideTrend={tideTrend}
                        destCoords={destCoords}
                        routeNm={routeNm}
                        onNavigate={onNavigate}
                    />

                    {/* The 4-bucket IA (2026-05-17) reordered the
                    sections so Quick Actions (daily ops) sits at the
                    top of the hub, followed by the Skipper Device and
                    Passage Planning, then Boat Binder (imports + vessel
                    records), Wardroom (social/comfort), and Settings &
                    Connect (config). */}

                    {/* ═══════════════════════════════════════════ */}
                    {/* WATCH STATUS — live operational status grid  */}
                    {/* (was "Quick Actions" with 6 tiles. The Log    */}
                    {/*  Book + Diary tiles were removed 2026-05-17   */}
                    {/*  because both routed to the same destinations  */}
                    {/*  as the new bottom-nav Log tab — pure         */}
                    {/*  duplication of the 5-tab nav restructure.    */}
                    {/*  Live counts that used to live on the Log    */}
                    {/*  Book tile moved to the top of LogPage         */}
                    {/*  itself. The remaining 4 tiles all share a   */}
                    {/*  unifying purpose: live operational status —  */}
                    {/*  Anchor armed/disarmed, Guardian watching,    */}
                    {/*  MOB rest state, Radio active. Section        */}
                    {/*  renamed accordingly. localStorage key 'quick' */}
                    {/*  preserved to retain the expanded state for    */}
                    {/*  existing users.) */}
                    {/* ═══════════════════════════════════════════ */}
                    {/* PINNED TO THE SCREEN (Shane 2026-07-19: "can we have it so the
                    Watch Status items are always on the screen (locked to the
                    screen) as they are quite important"). Anchor, Guardian, MOB
                    and Radio are the live safety states — scrolling down to the
                    Boat Binder should not take them off screen.
                    
                    The weather card and this grid share the fixed operational
                    deck above the scroll port. That keeps their variable
                    anchor/voyage height in one normal-flow block without
                    hard-coding a sticky offset or letting the controls overlap.

                    HEADER REMOVED (Shane: "remove the heading Watch Status, it
                    is just taking up space"). It was also the section's only
                    collapse control, and this section was always-expanded by
                    design anyway — so the tiles now render unconditionally
                    instead of through CollapsibleContent, and the 'quick' entry
                    in the expanded set is vestigial. Reclaiming that row is what
                    makes pinning the grid affordable. */}
                    <div className="mt-3">
                        {/* FOUR ACROSS, one line (Shane 2026-07-19: "on the vessel
                            page that we put the four boxes on one line"). These
                            tiles are PINNED, so their height is permanent screen
                            rather than something you scroll past — two rows cost
                            ~172px of it, one row ~78px, and the ~95px goes back to
                            the Boat Binder below.

                            Quarter width is ~80px on a phone: still well over the
                            44pt touch minimum, but far too narrow for the old
                            icon-beside-text layout. So each tile stacks — chip over
                            name over state — and the state shrinks to one word.
                            The colour is what gets read at a glance anyway; the
                            word is the confirmation. */}
                        <div
                            aria-label="Safety controls"
                            data-testid="vessel-safety-controls"
                            role="group"
                            style={SAFETY_CONTROL_GROUP}
                            /* A FIXED ROW, SIZED FROM THE CONTENT.
                               Four tiles in one grid row are all as tall as
                               the tallest, so the Anchor tile's extra content
                               used to stretch the whole deck the moment the
                               anchor went down and shrink it when it came up
                               (Shane 2026-09-05: "when the anchor is down, can
                               we not allow the anchor card to grow"). Pinning
                               it is the durable fix — removing today's extra
                               content would leave the next addition free to do
                               it again.

                               104, and the number is arithmetic rather than
                               taste: py-2.5 (20) + two gap-1.5 (12) + the h-8
                               icon (32) + an 11px heading + TWO 11px status
                               lines (22) = 97, plus slack for font metrics.

                               Two lines, because the status must never be
                               truncated. "OVERBOARD" is the longest word in
                               the narrowest tile and it was being cut to
                               "OVERBOA" — on the button a skipper reaches for
                               when someone is in the water. Shane, 2026-09-05:
                               "we really need to be able to see the entire
                               word claude, so i dont get sued, because a
                               punter went over the side and they didnt know
                               which button to press."

                               So `truncate` is gone from all four and the row
                               is tall enough for a wrap. A word that does not
                               fit now wraps and stays readable instead of
                               silently losing its ending — which is the only
                               acceptable failure mode for this control. Both
                               bounds are asserted next door: too short clips,
                               too tall lets a third line creep in. */
                            className={`grid ${FEATURE_VISIBILITY.guardian ? 'grid-cols-4' : 'grid-cols-3'} auto-rows-[104px] gap-2 rounded-[20px] p-1`}
                        >
                            {/* Order is deliberate (Shane 2026-08-04): MOB
                                first — the one you reach for in a genuine
                                emergency — then Radio position, Guardian,
                                Anchor. */}
                            <button
                                aria-label="Man Overboard"
                                onClick={() => {
                                    triggerHaptic('heavy');
                                    onNavigate('mob');
                                }}
                                style={ALERT_SAFETY_CONTROL_CARD}
                                className="card-lift flex flex-col items-center gap-1.5 px-1 py-2.5 transition-all hover:brightness-110 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                            >
                                <div
                                    className="flex h-8 w-8 items-center justify-center rounded-lg"
                                    style={{ background: 'rgba(239, 68, 68, 0.18)' }}
                                >
                                    <MobIcon color="#ef4444" />
                                </div>
                                <h4 className="text-[11px] font-black leading-none tracking-wide text-white">MOB</h4>
                                <p className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere] text-red-400">
                                    Overboard
                                </p>
                            </button>

                            <button
                                aria-label="Open radio position reporting"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('radio');
                                }}
                                style={SAFETY_CONTROL_CARD}
                                className="card-lift flex flex-col items-center gap-1.5 px-1 py-2.5 transition-all hover:bg-white/3 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                            >
                                <div
                                    className="flex h-8 w-8 items-center justify-center rounded-lg"
                                    style={{ background: 'rgba(103, 232, 249, 0.12)' }}
                                >
                                    <SignalIcon color="#67E8F9" />
                                </div>
                                <h4 className="text-[11px] font-black leading-none tracking-wide text-white">Radio</h4>
                                <p className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere] text-slate-400">
                                    Position
                                </p>
                            </button>

                            {FEATURE_VISIBILITY.guardian && (
                                <button
                                    aria-label="Open Guardian bay watch"
                                    onClick={() => {
                                        triggerHaptic('light');
                                        onNavigate('guardian');
                                    }}
                                    style={SAFETY_CONTROL_CARD}
                                    className="card-lift flex flex-col items-center gap-1.5 px-1 py-2.5 transition-all hover:bg-white/3 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                                >
                                    <div
                                        className="flex h-8 w-8 items-center justify-center rounded-lg"
                                        style={{ background: 'rgba(245, 158, 11, 0.12)' }}
                                    >
                                        <ShieldIcon color="#f59e0b" />
                                    </div>
                                    <h4 className="text-[11px] font-black leading-none tracking-wide text-white">
                                        Guardian
                                    </h4>
                                    <p
                                        className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere]"
                                        style={{ color: guardianArmed ? '#10b981' : '#f59e0b' }}
                                    >
                                        {/* The "· N nearby" suffix does not fit here; the
                                        count replaces the word so it is not lost. */}
                                        {guardianArmed
                                            ? guardianNearby > 0
                                                ? `${guardianNearby} near`
                                                : 'Watching'
                                            : 'Off'}
                                    </p>
                                </button>
                            )}

                            <button
                                aria-label="Anchor Watch"
                                onClick={() => {
                                    // 'compass', NOT 'anchor' — the Anchor Watch screen
                                    // has always been routed under the compass key, and
                                    // there is no 'anchor' route to fall back to, so the
                                    // guess landed on a blank page.
                                    triggerHaptic('light');
                                    onNavigate('compass');
                                }}
                                style={anchorStatus === 'alarm' ? ALERT_SAFETY_CONTROL_CARD : SAFETY_CONTROL_CARD}
                                className="card-lift flex flex-col items-center gap-1.5 px-1 py-2.5 transition-all hover:bg-white/3 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                            >
                                {/* THE SAME 8x8 DOT IN EVERY STATE. The live
                                    swing arc used to take this slot while the
                                    anchor was down — a picture worth having,
                                    but not at a quarter of the deck's width,
                                    where it made this tile taller than its
                                    three siblings and dragged the row with it.
                                    The arc still exists one tap away on the
                                    Anchor screen, and on the At Anchor card
                                    below where there is room for it. Here the
                                    colour does the work: cyan down, grey up,
                                    red and pulsing while dragging. */}
                                <div
                                    className="flex h-8 w-8 items-center justify-center rounded-lg"
                                    style={{ background: `${anchorColor}1f` }}
                                >
                                    <div
                                        className="h-3 w-3 rounded-full"
                                        style={{
                                            backgroundColor: anchorColor,
                                            boxShadow:
                                                anchorEffectivelyArmed || anchorStatus === 'alarm'
                                                    ? `0 0 8px ${anchorColor}60`
                                                    : 'none',
                                            animation: anchorStatus === 'alarm' ? 'pulse 1s infinite' : 'none',
                                        }}
                                    />
                                </div>
                                <h4 className="text-[11px] font-black leading-none tracking-wide text-white">Anchor</h4>
                                <p
                                    className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere]"
                                    style={{ color: anchorColor }}
                                >
                                    {anchorLabelShort}
                                </p>
                                {/* No "0m of 35m" fourth line. Three tiles
                                    carry an icon, a heading and one status
                                    word; a fourth line here made this one
                                    taller than all of them. The distance lives
                                    on the At Anchor card and the Anchor
                                    screen, both of which have the room. */}
                            </button>
                        </div>

                        {/* Weather Window + Skipper's Reference moved to the
                            Boat Binder's Reference group (Shane 2026-07-08:
                            "hidden a bit deeper — keep the important things
                            front and centre"). Watch Status is now purely the
                            daily-ops safety tiles: Anchor, Guardian, MOB, Radio. */}
                    </div>
                </div>
            </section>

            {/* Only the lower-priority vessel work scrolls. `min-h-0` is
                essential in this flex column: it constrains the scroll port
                above the persistent bottom safe-area padding instead of
                letting content push the fixed operational deck away. */}
            {/* PADDING INSIDE THE SCROLL PORT, not on a wrapper around it.
                This had px-4 pt-4 and no bottom padding at all, so the last
                row — Settings & Connect — sat flush against the bottom of the
                port, which is underneath the tab bar. It could not be scrolled
                clear because there was nothing below it to scroll (Shane
                2026-09-05: "the settings and connect button is not half
                hidden").

                On the OUTER element this would only shrink the port and move
                the problem; on the scroll container it adds a run-off the
                content can travel into. Same expression the Boat Binder branch
                above and AnchorWatchPage already use: the tab bar is 4rem plus
                the home-indicator inset, and 8px of air on top of it.

                FIT, not just scroll (Shane 2026-09-06): the outer surface
                already ends above the tab bar, so at its natural position the
                port CLIPS whatever falls below its bottom edge — which sat on
                the Settings & Connect header, right where the tab bar begins,
                and read as "blocked by the menu" with nothing hinting it
                scrolls. The vertical rhythm here (pt-2, pb-1 on the deck,
                mb-3 rows, mb-4 headers) is sized so the whole page fits an
                844pt phone without scrolling; smaller phones still scroll. */}
            <div
                className="flex-1 min-h-0 overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 stagger-in"
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)' }}
            >
                {/* Diary + Scuttlebutt lead the scrolling area (Shane
                    2026-08-30). They are the two things opened most often and
                    the only ones here that are read rather than configured, so
                    they come before the cards that answer "how is this boat set
                    up" — Skipper Device, Passage Planning, Boat Binder — and
                    before the menu headers below them. */}
                {/* Diary + Scuttlebutt — permanently visible peer tiles. */}
                <div className="mb-3">
                    <div className="grid grid-cols-2 gap-3">
                        {/* Diary — personal journal (left tile) */}
                        <button
                            aria-label="Open Diary"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('diary');
                            }}
                            style={GLASS.card}
                            className="p-4 text-left hover:bg-white/3 transition-all active:scale-[0.98] card-lift"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 rounded-lg" style={{ background: 'rgba(94, 234, 212, 0.12)' }}>
                                    <PenIcon color="#5EEAD4" />
                                </div>
                                <div>
                                    <h4 className="text-[13px] font-black text-white tracking-wide">Diary</h4>
                                    <p
                                        className="text-[11px] font-bold uppercase tracking-widest mt-0.5"
                                        style={{ color: '#5EEAD4' }}
                                    >
                                        Voyage Journal
                                    </p>
                                </div>
                            </div>
                        </button>

                        {/* Scuttlebutt — community channels + DMs
                                (right tile). Moved here from the Wardroom
                                section because it's a sharing surface
                                more than a "lounge" feature — pairs
                                naturally with Diary as the inward (Diary)
                                + outward (Scuttlebutt) halves of the
                                share-your-voyage story. Wardroom keeps
                                Music; could be renamed if it slims down
                                further. */}
                        <button
                            aria-label="Open Scuttlebutt"
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('chat');
                            }}
                            style={GLASS.card}
                            className="p-4 text-left hover:bg-white/3 transition-all active:scale-[0.98] card-lift"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 rounded-lg" style={{ background: 'rgba(125, 211, 252, 0.12)' }}>
                                    <ChatBubbleIcon color="#7dd3fc" />
                                </div>
                                <div>
                                    <h4 className="text-[13px] font-black text-white tracking-wide">Scuttlebutt</h4>
                                    <p
                                        className="text-[11px] font-bold uppercase tracking-widest mt-0.5"
                                        style={{ color: '#7dd3fc' }}
                                    >
                                        Community · DMs
                                    </p>
                                </div>
                            </div>
                        </button>
                    </div>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* ═══════════════════════════════════════════ */}
                {/* SKIPPER DEVICE — who speaks for this boat    */}
                {/* ═══════════════════════════════════════════ */}
                {/* Two devices signed into one account both published track
                    points under the same user_id, so the public page drew both
                    and its boat marker jumped to whichever reported last (Shane
                    2026-07-19: "which one will be the authority??"). The claim is
                    exclusive; a second device must take it over deliberately.

                    Takeover is always available, on purpose. A claim releasable
                    only from the device holding it strands you the moment that
                    device is overboard, soaked, flat or ashore — so this shows
                    WHO holds it and WHEN they were last seen, and lets you take
                    it rather than locking you out of your own boat. */}
                <SkipperDeviceControl
                    claim={skipperClaim}
                    authenticatedUserId={authenticatedUserId}
                    updateSettings={updateSettings}
                    vesselName={vesselNameSet ? vesselName : undefined}
                />

                {/* PASSAGE PLANNING — deliberately one tap from the Vessel
                    home, directly below the publishing-authority card. It used
                    to be inside Boat Binder, which made an operational voyage
                    workflow look like stored paperwork. Import GPX remains in
                    the Binder; planning the voyage belongs on the live hub. */}
                <div className="mb-3" style={PASSAGE_PLANNING_GROUP}>
                    <OfficeRow
                        icon={<CrewIcon color="#c4b5fd" />}
                        label="Passage Planning"
                        status={
                            passageCrewCount > 0
                                ? `${passageCrewCount} crew`
                                : pendingCrewInvites > 0
                                  ? `${pendingCrewInvites} Pending`
                                  : 'Plan Your Voyage'
                        }
                        statusColor={pendingCrewInvites > 0 ? '#f59e0b' : '#a78bfa'}
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('crew');
                        }}
                        badge={pendingCrewInvites > 0 ? pendingCrewInvites : undefined}
                    />
                    {/* Saved Routes row removed (Shane 2026-08-04): the
                        library is one tap away inside Passage Planning, so a
                        second entry point here was noise. */}
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* BOAT BINDER — imports / inventory / reference   */}
                {/* (4-bucket IA, 2026-05-17). Sailor's mental    */}
                {/* model: the physical binder every cruiser keeps */}
                {/* with vessel docs, equipment registry, log,    */}
                {/* polars, notices. ONE collapse reveals 9 rows  */}
                {/* organised into 3 subgroups via small labels — */}
                {/* no nested section chevrons.                   */}
                {/* ═══════════════════════════════════════════ */}
                {/* BOAT BINDER — its OWN SCREEN now (Shane 2026-07-19: "can boat
                    binder be its own screen when you click on it. at the moment it
                    scrolls up through the buttons at the top"). Expanding ~170 lines
                    of rows inline pushed the page far past a screen, so opening it
                    left the skipper mid-list with the pinned hero above and no sense
                    of place. A row that opens a screen is the honest shape for a
                    section this big. */}
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setBinderOpen(true);
                    }}
                    style={GLASS.card}
                    className="mb-3 flex w-full items-center gap-3 p-4 text-left transition-all hover:bg-white/3 active:scale-[0.99] card-lift"
                >
                    <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                        style={{ background: 'rgba(103, 232, 249, 0.12)' }}
                    >
                        <span aria-hidden className="text-base leading-none">
                            📒
                        </span>
                    </div>
                    <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-black tracking-wide text-white">Boat Binder</span>
                        <span className="mt-0.5 block text-[11px] font-bold uppercase tracking-widest text-cyan-300">
                            Inventory · Reference
                        </span>
                    </span>
                    <span aria-hidden className="shrink-0">
                        <ChevronRight />
                    </span>
                </button>

                {/* ═══════════════════════════════════════════ */}
                {/* WARDROOM — onboard comfort: music, etc.     */}
                {/* The wardroom is the officers' lounge on a   */}
                {/* vessel — the social/comfort space. Sits     */}
                {/* between Reference (tools) and Connect       */}
                {/* (instruments) intentionally: music isn't a  */}
                {/* tool you need to plan a passage, but it     */}
                {/* should still be a one-Nav-Station hop away  */}
                {/* rather than buried inside Calypso (which    */}
                {/* is Skipper-tier only). Future "lifestyle"   */}
                {/* features (ambient sounds for sleep, reading */}
                {/* lists, podcasts) belong here too.           */}
                {/* ═══════════════════════════════════════════ */}
                {/* ATMOSPHERE (Music) — removed 2026-07-19 ("it is not really
                    part of the app and it can be accessed via the mic at the top
                    anyway"), RESTORED 2026-08-08 at Shane's ask. The page and its
                    route were never deleted, only this entry; the mic and the
                    now-playing bar remained the only ways in, and neither helps
                    if you want to go and choose something. */}
                <div className="mb-4">
                    <SectionHeader
                        color="#f0abfc"
                        label="Atmosphere"
                        id="atmosphere"
                        expanded={expanded.has('atmosphere')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('atmosphere')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<span style={{ fontSize: 18 }}>🎧</span>}
                                label="Music"
                                status="Apple Music & speakers"
                                statusColor="#94a3b8"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('music');
                                }}
                            />
                        </div>
                    </CollapsibleContent>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* SETTINGS & CONNECT                          */}
                {/* (4-bucket IA, 2026-05-17). Merged the old   */}
                {/* Connect (NMEA + Boat Network) and Account   */}
                {/* sections — both are "configuration" surfaces*/}
                {/* the punter visits rarely, so they don't     */}
                {/* deserve two separate cognitive buckets.     */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionHeader
                        color="#67E8F9"
                        label="Settings & Connect"
                        id="setup"
                        expanded={expanded.has('setup')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('setup')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<SignalIcon color="#cbd5e1" />}
                                label="NMEA Gateway"
                                status={gatewayStatus}
                                statusColor={gatewayStatusColor}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('nmea');
                                }}
                            />
                            {/* ENC Library removed from Connect (Shane 2026-08-07:
                                "less is more"). The page and its route still
                                exist — the map's no-coverage affordance in
                                ChartDepthControls still opens it, which is where
                                it is actually useful. This menu is for things a
                                punter picks deliberately. */}
                            <ListDivider />
                            <OfficeRow
                                icon={<MapChartIcon color="#cbd5e1" />}
                                label="Boat Network"
                                status="Pi cache, Signal K & AvNav"
                                statusColor="#94a3b8"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('avnav');
                                }}
                            />
                            <ListDivider />
                            <OfficeRow
                                icon={<UserIcon color="#cbd5e1" />}
                                label="Account & Settings"
                                status={(() => {
                                    if (PUBLIC_BETA_ACCESS.enabled) return PUBLIC_BETA_ACCESS.label;
                                    // One source of truth for plan names —
                                    // the hub used to invent its own ("Vessel
                                    // Owner"/"Crew Plan") and disagree with
                                    // Settings and the paywall.
                                    const tier = (settings as Record<string, unknown>).subscriptionTier as string;
                                    return (
                                        (TIER_INFO[tier as SubscriptionTier] as { label: string } | undefined) ??
                                        TIER_INFO.free
                                    ).label;
                                })()}
                                statusColor={(() => {
                                    if (PUBLIC_BETA_ACCESS.enabled) return '#67E8F9';
                                    // Tier badge stays its own colour —
                                    // owner=amber (premium), crew=cyan,
                                    // free=grey. This is a deliberate
                                    // status signal, not chromatic noise.
                                    const tier = (settings as Record<string, unknown>).subscriptionTier as string;
                                    if (tier === 'owner') return '#f59e0b';
                                    if (tier === 'crew') return '#67E8F9';
                                    return '#94a3b8';
                                })()}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('settings');
                                }}
                            />
                        </div>
                    </CollapsibleContent>
                </div>
            </div>
        </div>
    );
});

// ══════════════════════════════════════
// ── Shared Components ──
// ══════════════════════════════════════

export const SkipperDeviceControl: React.FC<SkipperDeviceControlProps> = ({
    claim,
    authenticatedUserId,
    updateSettings,
    vesselName,
}) => {
    const claimHeld = holdsClaim(claim);
    // The Pi publishing the boat to the cloud within the last minute IS the
    // primary device (Shane 2026-09-06: "one source of truth"); phones stand
    // down and the claim button goes with them until she goes quiet.
    const cloud = useCloudTelemetry();
    const piPrimary = cloud.piPrimary;
    const piName = cloud.latest?.deviceLabel ?? 'The Pi';

    /**
     * Which GPS speaks for the boat.
     *
     * Shane's rule (2026-08-30): "if there is a pi connected, well stiff, that
     * is the source of truth for gps, as long as it has got one that is." So
     * the boat's own receiver wins whenever it is actually delivering a
     * position, and the phone is what you fall back to — not a peer.
     *
     * getFeedStatus() is the honest test of "as long as it has got one":
     * it reads NmeaStore directly and requires BOTH coordinates inside the
     * usable window, so a gateway that is connected but has no GPS behind it
     * reads as 'unavailable' and the card says Phone — rather than promising a
     * boat fix that does not exist. Polled rather than subscribed because the
     * interesting transition is the feed GOING AWAY, which emits nothing.
     */
    const boatGpsPresent = () => NmeaGpsProvider.getFeedStatus() !== 'unavailable' || piCache.isAvailable();
    const [vesselGpsLive, setVesselGpsLive] = useState(boatGpsPresent);
    useEffect(() => {
        const read = () => setVesselGpsLive(boatGpsPresent());
        read();
        const id = setInterval(read, 2_000);
        return () => clearInterval(id);
    }, []);

    const statusDescription = claim
        ? claimHeld
            ? 'This device publishes the boat’s position to your public page.'
            : `${claim.deviceName} is publishing — last claimed ${claimAgeLabel(claim)}.`
        : 'No device claimed yet — any signed-in device can publish.';

    // The claim rides in user_settings, which is pulled from the cloud ONCE per
    // sign-in — so without this, a claim made on the other device is invisible
    // here until a cold restart, and BOTH devices read "This Device" (Shane,
    // 2026-08-01, iPhone + iPad). Refresh whenever the card appears; maxAgeMs 0
    // because the skipper is looking at exactly this answer right now.
    useEffect(() => {
        void refreshSkipperClaim({ maxAgeMs: 0 });
    }, []);
    // Shane 2026-09-06: "Release - this is not the Primary Device" / "Press to make this the Primary Device".
    const actionLabel = claimHeld
        ? 'Release — this is not the Primary Device'
        : 'Press to make this the Primary Device';
    const [takeoverRequest, setTakeoverRequest] = useState<{
        scope: AuthIdentityScope;
        claim: SkipperClaim;
    } | null>(null);
    const actionInFlight = useRef(false);

    useEffect(() => {
        actionInFlight.current = false;
        setTakeoverRequest(null);
    }, [authenticatedUserId]);

    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                actionInFlight.current = false;
                setTakeoverRequest(null);
            }),
        [],
    );

    const applyClaim = useCallback(
        (nextClaim: SkipperClaim | undefined) => {
            if (actionInFlight.current) return;
            actionInFlight.current = true;
            try {
                updateSettings({ skipperDevice: nextClaim });
            } finally {
                queueMicrotask(() => {
                    actionInFlight.current = false;
                });
            }
        },
        [updateSettings],
    );

    const handleAction = useCallback(() => {
        if (actionInFlight.current || takeoverRequest) return;
        triggerHaptic('medium');
        if (claimHeld) {
            applyClaim(undefined);
            return;
        }

        const recent = claim && Date.now() - new Date(claim.claimedAt).getTime() < 30 * 60_000;
        if (recent) {
            const scope = getAuthIdentityScope();
            if (scope.userId !== authenticatedUserId) return;
            setTakeoverRequest({ scope, claim });
            return;
        }
        applyClaim(buildClaim());
    }, [applyClaim, authenticatedUserId, claim, claimHeld, takeoverRequest]);

    const confirmTakeover = useCallback(() => {
        const request = takeoverRequest;
        if (!request || actionInFlight.current) return;
        const sameClaim = claim?.deviceId === request.claim.deviceId && claim.claimedAt === request.claim.claimedAt;
        if (!sameClaim || !isAuthIdentityScopeCurrent(request.scope) || request.scope.userId !== authenticatedUserId) {
            setTakeoverRequest(null);
            return;
        }
        applyClaim(buildClaim());
        setTakeoverRequest(null);
    }, [applyClaim, authenticatedUserId, claim, takeoverRequest]);

    return (
        <>
            <div
                data-testid="skipper-device-card"
                className={`mb-4 h-[120px] overflow-hidden rounded-2xl border bg-slate-900/40 p-3 ${
                    claimHeld
                        ? 'border-emerald-400/35 shadow-[0_0_22px_-10px_rgba(52,211,153,0.45)]'
                        : 'border-cyan-400/35 shadow-[0_0_22px_-10px_rgba(34,211,238,0.4)]'
                }`}
            >
                {/* Shane 2026-09-06: the boat's name is the top line, the GPS
                    order is the next, the button says what pressing it does.
                    Fixed h-[120px] with overflow-hidden (tests assert it), so
                    every row has a fixed height and truncates, never wraps. */}
                <div className="mb-1.5 flex h-5 items-center gap-2">
                    <span aria-hidden="true" className="shrink-0 text-[12px] leading-none text-cyan-300">
                        ⚓
                    </span>
                    {vesselName ? (
                        <span
                            data-testid="skipper-device-vessel"
                            title={vesselName}
                            className="min-w-0 flex-1 truncate text-[13px] font-black tracking-wide text-white/90"
                        >
                            {vesselName}
                        </span>
                    ) : (
                        <span className="min-w-0 flex-1 truncate text-[11px] font-black uppercase tracking-widest text-cyan-300">
                            Skipper device
                        </span>
                    )}
                    {vesselName && (
                        <span className="shrink-0 text-[9px] font-black uppercase tracking-widest text-cyan-300/80">
                            {piPrimary ? 'Primary: the Pi' : 'Skipper device'}
                        </span>
                    )}
                </div>
                {/* The order the app believes GPS in: the boat's own receiver
                    (bus, or the Pi that holds it) when it is present, then this
                    device — or just this device when there is no boat GPS. */}
                <div className="mb-2 flex h-4 items-center gap-2">
                    <span
                        data-testid="skipper-device-gps-source"
                        title={
                            vesselGpsLive
                                ? 'The boat’s own GPS speaks first; this device stands in when it is quiet.'
                                : 'No boat GPS present — this device is the only position source.'
                        }
                        className="flex min-w-0 shrink-0 items-center gap-1.5"
                    >
                        {vesselGpsLive && (
                            <>
                                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-300">
                                    Boat GPS
                                </span>
                                <span aria-hidden="true" className="text-[10px] font-black text-gray-500">
                                    ›
                                </span>
                            </>
                        )}
                        <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
                                claimHeld ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/8 text-gray-300'
                            }`}
                        >
                            This device
                        </span>
                    </span>
                    {claim && !claimHeld && (
                        <span
                            title={statusDescription}
                            className="min-w-0 flex-1 truncate text-right text-[10px] font-bold text-amber-300"
                        >
                            {claim.deviceName} · {claimAgeLabel(claim)}
                        </span>
                    )}
                    <p className="sr-only">{statusDescription}</p>
                </div>
                {piPrimary ? (
                    <p
                        data-testid="skipper-device-pi-primary"
                        className="flex h-11 w-full items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-2 text-[10px] font-black uppercase tracking-[0.06em] text-emerald-300"
                    >
                        {piName} publishes the boat · phones stand down
                    </p>
                ) : (
                    <button
                        type="button"
                        onClick={handleAction}
                        aria-label={actionLabel}
                        className={`h-11 w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-xl px-2 text-[10px] font-black uppercase tracking-[0.06em] transition-colors active:brightness-110 ${
                            claimHeld ? 'bg-white/10 text-gray-300' : 'bg-cyan-500/20 text-cyan-300'
                        }`}
                    >
                        {actionLabel}
                    </button>
                )}
            </div>
            <ConfirmDialog
                isOpen={takeoverRequest !== null}
                title="Take over skipper publishing?"
                message={
                    takeoverRequest
                        ? `${takeoverRequest.claim.deviceName} was active ${claimAgeLabel(
                              takeoverRequest.claim,
                          )}. Taking over stops that device publishing and starts this one.`
                        : ''
                }
                confirmLabel="Take over"
                onConfirm={confirmTakeover}
                onCancel={() => {
                    if (!actionInFlight.current) setTakeoverRequest(null);
                }}
            />
        </>
    );
};

// ══════════════════════════════════════
// ── NavStationHero — situational-awareness band ──
// ══════════════════════════════════════

/** Derive a one-word voyage state for the hero band.
 *  Distinct colors per state so two states never share a hue:
 *    drag alarm   → red       (urgent)
 *    underway     → emerald   (motion / OK to be at sea)
 *    at anchor    → cyan      (still / watching)
 *    drafted      → violet    (planning)
 *    at rest      → grey      (idle)
 */
function deriveVoyageState(
    voyage: Voyage | null,
    anchorStatus: 'armed' | 'disarmed' | 'alarm',
    tripLogActive: boolean,
    /** The reassembled multi-leg route, when one could be resolved. */
    tripRoute: string | null,
): { label: string; color: string; route?: string } {
    if (anchorStatus === 'alarm') return { label: 'Drag Alarm', color: '#ef4444' };

    if (anchorStatus === 'armed') {
        // The WHOLE trip, not leg one — see hooks/useTripRoute. The voyage's
        // own two fields describe leg one only, which is why a
        // Newport → Coral Sea → Mackay → Whitsundays trip read as
        // "Newport → Coral Sea".
        const route =
            tripRoute ??
            (voyage && voyage.departure_port && voyage.destination_port
                ? `${voyage.departure_port} → ${voyage.destination_port}`
                : undefined);
        return { label: 'At Anchor', color: '#22d3ee', route };
    }

    // Updated 2026-05-05 per user feedback: Cast Off should put the
    // hero card into "Underway" and stay there until the user
    // explicitly ends the voyage. Previously the gate was
    // tripLogActive (GPS trip log recording), which meant the card
    // would slip back to "Standby" any time the log paused — boat
    // moored for a refuel, etc. That looked wrong: the user had cast
    // off, they're in Active Voyage Mode, the card should reflect
    // that. Now the gate is `voyage.status === 'active' OR
    // tripLogActive` — once the voyage is active, "Underway" sticks
    // until endVoyage() is called.
    const inActiveVoyageMode = !!voyage && voyage.status === 'active';
    if (tripLogActive || inActiveVoyageMode) {
        const route =
            tripRoute ??
            (voyage && voyage.departure_port && voyage.destination_port
                ? `${voyage.departure_port} → ${voyage.destination_port}`
                : voyage?.voyage_name || undefined);
        return { label: 'Underway', color: '#10b981', route };
    }

    if (voyage && voyage.status === 'planning') {
        const route =
            tripRoute ??
            (voyage.departure_port && voyage.destination_port
                ? `${voyage.departure_port} → ${voyage.destination_port}`
                : voyage.voyage_name || 'Drafted');
        return { label: 'Drafted', color: '#8b5cf6', route };
    }

    return { label: 'At Rest', color: '#9ca3af' };
}

const NavStationHero: React.FC<{
    vesselName: string;
    vesselNameSet: boolean;
    voyage: Voyage | null;
    tripLogActive: boolean;
    position: GpsPosition | null;
    anchorStatus: 'armed' | 'disarmed' | 'alarm';
    anchorRadius: number;
    anchorOffset: number;
    anchorBearing: number;
    windSpeed: number | null;
    windDir: string | null;
    waveHeight: number | null;
    /** Unit symbol matching `waveHeight` ('m' or 'ft') — already
     *  converted by the parent via convertLength. Defaults to 'm' if
     *  the parent forgot to thread it through. */
    waveUnit?: 'ft' | 'm';
    airTemp: number | null;
    seaTemp: number | null;
    visibility: number | null;
    pressureTrend: 'rising' | 'falling' | 'steady' | null;
    tideTrend: 'rising' | 'falling' | 'steady' | null;
    // isOnline removed 2026-04-28 — used to flip the GPS pill colour and
    // label, which conflated network state with GPS-fix state and made
    // the Nav Station look different online vs offline. The pill now
    // reflects GPS fix only.
    destCoords: { lat: number; lon: number } | null;
    routeNm: number | null;
    onNavigate: (page: string) => void;
}> = ({
    vesselName,
    vesselNameSet,
    voyage,
    tripLogActive,
    position,
    anchorStatus,
    anchorRadius,
    anchorOffset,
    anchorBearing,
    windSpeed,
    windDir,
    waveHeight,
    waveUnit = 'm',
    airTemp,
    seaTemp,
    visibility,
    pressureTrend,
    tideTrend,
    destCoords,
    routeNm,
    onNavigate,
}) => {
    const tripRoute = useTripRoute(voyage);
    const state = deriveVoyageState(voyage, anchorStatus, tripLogActive, tripRoute);

    // Underway = SOG > ~1 kt (0.51 m/s). Below that it's noise from
    // GPS jitter at anchor — don't print "SOG 0.3 kt" on a stationary boat.
    const sogMs = position?.speed ?? 0;
    const sogKt = sogMs * 1.94384;
    const showSog = sogKt > 1;
    const cogDeg = position?.heading ?? null;

    // Wind chip — show kn + cardinal direction. Both must be present.
    const showWind = windSpeed !== null && windDir;
    const windKt = windSpeed !== null ? Math.round(windSpeed) : 0;

    // Pressure / tide trends — render only when meaningfully moving.
    const presInd = pressureTrendIndicator(pressureTrend);
    const tideInd =
        tideTrend && tideTrend !== 'steady'
            ? tideTrend === 'rising'
                ? { arrow: '↑', color: '#22d3ee', label: 'flood' }
                : { arrow: '↓', color: '#a855f7', label: 'ebb' }
            : null;

    // ETA — show when voyage is active and ETA is set in the future.
    const etaMs = voyage?.eta ? Date.parse(voyage.eta) : null;
    const showEta = state.label === 'Underway' && etaMs && Number.isFinite(etaMs) && etaMs > Date.now();
    const etaRemaining = showEta && etaMs ? formatDuration(etaMs - Date.now()) : null;

    // Voyage day counter — "Day 2" of the passage. Only when underway
    // and a departure_time is set.
    const depMs = voyage?.departure_time ? Date.parse(voyage.departure_time) : null;
    const voyageDay =
        state.label === 'Underway' && depMs && Number.isFinite(depMs) && depMs <= Date.now()
            ? Math.max(1, Math.floor((Date.now() - depMs) / 86_400_000) + 1)
            : null;

    // Distance remaining (NM) — current position to active route's
    // destination. Only when underway and we have both points.
    let distRemainingNm: number | null = null;
    if (state.label === 'Underway' && position && destCoords) {
        distRemainingNm = calculateDistance(position.latitude, position.longitude, destCoords.lat, destCoords.lon);
    }
    // Fall back to total route NM if we have the route but no GPS yet.
    const showRouteNm = !distRemainingNm && routeNm !== null && state.label === 'Underway';

    // Show the anchor swing arc when armed (or alarm).
    const showSwing = anchorStatus !== 'disarmed' && anchorRadius > 0;

    const handleVesselTap = () => {
        triggerHaptic('light');
        // Deep-link to the Vessel Profile tab inside Settings — see
        // SettingsModal's activeTab initialiser. Avoids the user
        // landing on the General tab and hunting for vessel config.
        try {
            localStorage.setItem(authScopedStorageKey('thalassa_settings_initial_tab'), 'vessel');
        } catch {
            /* private-mode / quota — fall through, lands on default tab */
        }
        onNavigate('settings');
    };
    const handleVoyageTap = () => {
        triggerHaptic('light');
        onNavigate('crew');
    };
    const handlePositionTap = () => {
        triggerHaptic('light');
        onNavigate('map');
    };
    const handleAnchorTap = () => {
        triggerHaptic('light');
        onNavigate('compass');
    };

    // Sign-in CTA state. The empty-state vessel header (when the
    // punter hasn't named their vessel yet) shows a small
    // "Already have an account? Sign in →" link below the "Set up
    // your vessel" CTA — ONLY when the user is un-authed. Authed
    // users with no vessel have nothing to restore from the cloud,
    // so the link is suppressed for them. SignInScreen is the
    // canonical sign-in surface — Apple + Google + email.
    const authedUser = useAuthStore((s) => s.user);
    const [signInOpen, setSignInOpen] = useState(false);
    const handleSignInTap = (e: React.MouseEvent) => {
        // Stop the parent button from also firing (it would route
        // to Settings → Vessel, which is the OPPOSITE of what the
        // link is offering — the link is for users who already
        // have details in the cloud).
        e.stopPropagation();
        triggerHaptic('light');
        setSignInOpen(true);
    };

    // Environmental metric chips — hoisted so BOTH renders share them:
    // the slim at-rest strip and the full underway/anchor card.
    const metricChips = (
        [
            showWind
                ? {
                      key: 'wind',
                      icon: <WindIcon />,
                      value: String(windKt),
                      unit: 'kt',
                      suffix: windDir || undefined,
                  }
                : null,
            waveHeight !== null
                ? { key: 'wave', icon: <WaveIcon />, value: waveHeight.toFixed(1), unit: waveUnit }
                : null,
            airTemp !== null
                ? { key: 'air', icon: <ThermometerIcon />, value: `${Math.round(airTemp)}`, unit: '°' }
                : null,
            seaTemp !== null ? { key: 'sea', icon: <DropletIcon />, value: `${Math.round(seaTemp)}`, unit: '°' } : null,
            visibility !== null
                ? {
                      key: 'vis',
                      icon: <EyeIcon />,
                      // weatherData.current.visibility is already
                      // in KILOMETRES — openmeteo.ts converts
                      // metres → km at fetch time. To display
                      // NM we divide by 1.852 (km per NM), NOT
                      // 1852 (m per NM). The previous code
                      // assumed metres and divided by 1852, so
                      // a real 10 km visibility came out as
                      // 0.0054 → "0.0 NM" — the bug the user
                      // saw on the hero card. Cap at ">10" so
                      // a clear 50 km horizon doesn't read
                      // bigger than any handheld sensor can
                      // actually measure.
                      value: visibility / 1.852 >= 10 ? '>10' : (visibility / 1.852).toFixed(1),
                      unit: 'NM',
                  }
                : null,
            presInd
                ? {
                      key: 'bar',
                      label: 'BAR',
                      value: presInd.arrow,
                      color: presInd.color,
                      ariaLabel: `Barometer ${presInd.label}`,
                  }
                : null,
            tideInd
                ? {
                      key: 'tide',
                      label: 'TIDE',
                      value: tideInd.arrow,
                      color: tideInd.color,
                      ariaLabel: `Tide ${tideInd.label}`,
                  }
                : null,
        ] as (MetricChipData | null)[]
    ).filter((c): c is MetricChipData => c !== null);

    // WEATHER-ONLY MODE (Shane 2026-07-26: the skipper already knows when
    // the boat is underway). Keep the top of Vessel equally quiet whether
    // resting or logging: conditions only, no redundant Underway card.
    // Anchor watch and drag alarms deliberately retain the full card because
    // their swing/status information is safety-critical. A fresh install and
    // a drafted passage also retain their purposeful full-card states.
    //
    // At Rest / Underway used to collapse the hero to a bare strip of weather
    // chips. It went, 2026-08-09: the same numbers are already on The Glass,
    // which is one tab away and is where you look for them. A band of
    // duplicated conditions across the top of the Vessel page bought nothing
    // and pushed the actual vessel content down the screen.
    //
    // The FULL card below keeps its chips — there they sit beside swing and
    // anchor state, where the conditions are context for something rather
    // than the whole payload.
    const weatherOnlySlim = (state.label === 'At Rest' || state.label === 'Underway') && !showSwing && vesselNameSet;
    if (weatherOnlySlim) return null;

    // At anchor this card only repeats what the Anchor tile below already says,
    // and the swing arc has moved down there with it (Shane 2026-09-04: "when
    // we are at anchor, can we remove the card the says at anchor"). A DRAG
    // ALARM is emphatically not the same thing — that is the one moment this
    // card exists for, so it stays, red and pulsing.
    if (anchorStatus === 'armed') return null;

    return (
        <div
            className={`mb-4 overflow-hidden ${anchorStatus === 'alarm' ? 'nav-hero-alarm' : ''}`}
            style={{
                ...GLASS.card,
                background:
                    'var(--vessel-hero-bg, linear-gradient(135deg, rgba(20,25,35,0.75) 0%, rgba(14,165,233,0.08) 100%))',
                borderColor: 'var(--vessel-hero-border, rgba(255,255,255,0.12))',
                transition: 'border-color 300ms ease, box-shadow 300ms ease',
            }}
        >
            {/* Top row — vessel name + state pill (and swing arc if anchored) */}
            <div className="flex items-center gap-2 px-4 pt-4 pb-2">
                <div className="flex-1 min-w-0">
                    <button
                        type="button"
                        onClick={handleVesselTap}
                        aria-label={vesselNameSet ? 'Open vessel settings' : 'Set up your vessel'}
                        className="w-full active:opacity-70 transition-opacity text-left"
                    >
                        {vesselNameSet ? (
                            <h2 className="text-lg font-black text-white tracking-tight truncate">{vesselName}</h2>
                        ) : (
                            // Empty-state vessel header — was: a barely-
                            // visible italic 50%-white placeholder that
                            // most fresh-install users would scroll past
                            // without noticing. Now: cyan-tinted setup
                            // CTA with chevron affordance + a sub-line
                            // that explains the value ("personalise
                            // routing") so the user understands WHY they
                            // might tap. No force — DEFAULT_VESSEL still
                            // lets them plan without configuring; this
                            // is just an invitation.
                            <div className="flex flex-col gap-0.5">
                                <h2 className="text-lg font-black text-sky-300 tracking-tight truncate flex items-center gap-1">
                                    <span>Set up your vessel</span>
                                    <svg
                                        className="w-4 h-4 text-sky-400/80 shrink-0"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2.5}
                                        aria-hidden="true"
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                    </svg>
                                </h2>
                                <p className="text-[11px] font-medium text-slate-400 truncate">
                                    Personalise routing for your boat
                                </p>
                            </div>
                        )}
                    </button>
                    {/* A sibling button, never nested inside the vessel setup
                        button, so keyboard and screen-reader activation are valid. */}
                    {!vesselNameSet && !authedUser && (
                        <button
                            type="button"
                            onClick={handleSignInTap}
                            className="mt-1 inline-flex min-h-[44px] w-fit items-center gap-1 text-[11px] font-semibold text-cyan-200/80 hover:text-cyan-100 transition-colors"
                            aria-label="Already have a Thalassa account? Sign in to restore your saved vessel"
                        >
                            <span>Already have a Thalassa account?</span>
                            <span className="text-cyan-300 underline underline-offset-2">Sign in →</span>
                        </button>
                    )}
                </div>
                {showSwing ? (
                    <button
                        type="button"
                        onClick={handleAnchorTap}
                        aria-label={`Anchor watch ${anchorStatus}, ${Math.round(anchorOffset)}m of ${Math.round(anchorRadius)}m swing`}
                        className="active:scale-95 transition-transform"
                    >
                        <SwingArc
                            radiusM={anchorRadius}
                            offsetM={anchorOffset}
                            bearingDeg={anchorBearing}
                            alarm={anchorStatus === 'alarm'}
                        />
                    </button>
                ) : (
                    <span
                        className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-widest border whitespace-nowrap shrink-0"
                        style={{
                            color: state.color,
                            backgroundColor: `${state.color}1a`,
                            borderColor: `${state.color}33`,
                            transition: 'color 300ms ease, background-color 300ms ease, border-color 300ms ease',
                        }}
                    >
                        {state.label}
                    </span>
                )}
            </div>

            {/* When anchored, the swing arc replaces the state pill — bring
                back the state label as a small line below the vessel name
                so the user always sees what state they're in. */}
            {showSwing && (
                <div className="px-4 pb-1">
                    <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: state.color }}>
                        {state.label}
                    </span>
                </div>
            )}

            {/* Voyage row (tap → passage planning) */}
            {state.route && (
                <button
                    type="button"
                    onClick={handleVoyageTap}
                    aria-label="Open passage planning"
                    className="w-full flex items-center gap-2 px-4 py-1 active:opacity-70 transition-opacity text-left"
                >
                    <p className="text-[12px] font-semibold text-white/80 truncate flex-1">{state.route}</p>
                    {etaRemaining && (
                        <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 shrink-0 tabular-nums">
                            ETA {etaRemaining}
                        </span>
                    )}
                </button>
            )}

            {/* Voyage progress row — Day N · 142.3 NM remaining.
                Only renders when underway and we have something to show. */}
            {state.label === 'Underway' && (voyageDay !== null || distRemainingNm !== null || showRouteNm) && (
                <div className="w-full flex items-center gap-3 px-4 py-1 text-[11px]">
                    {voyageDay !== null && (
                        <span className="font-mono text-white/70 tabular-nums">
                            <span className="text-white/60 uppercase tracking-wider mr-1">Day</span>
                            {voyageDay}
                        </span>
                    )}
                    {distRemainingNm !== null && (
                        <span className="ml-auto font-mono text-white/85 tabular-nums">
                            {distRemainingNm.toFixed(1)}
                            <span className="text-white/60 text-[10px] ml-0.5">NM</span>
                            <span className="text-white/60 text-[10px] uppercase tracking-wider ml-1">to go</span>
                        </span>
                    )}
                    {showRouteNm && routeNm !== null && (
                        <span className="ml-auto font-mono text-white/60 tabular-nums">
                            {routeNm.toFixed(0)}
                            <span className="text-white/60 text-[10px] ml-0.5">NM</span>
                            <span className="text-white/60 text-[10px] uppercase tracking-wider ml-1">total</span>
                        </span>
                    )}
                </div>
            )}

            {/* Position row (tap → map). Coord text bumped to 13px
                (from 11px) for legibility — at-a-glance reading from
                arm's-length on a phone clamped to a binnacle was
                squinty at 11px. The "time since fix" label and the
                fix-status dot stay small so the lat/lon dominates the
                row. */}
            <button
                type="button"
                onClick={handlePositionTap}
                aria-label="Open chart at current position"
                className="min-h-[44px] w-full flex items-center gap-2 px-4 pt-1.5 pb-2 active:opacity-70 transition-opacity text-left"
            >
                {/* GPS pill — dot + lat/lon + time-since-fix.
                    2026-04-28: decoupled from network online/offline state.
                    Was previously flipping the dot from cyan to amber and
                    replacing the time-since-fix label with "OFFLINE" when
                    `navigator.onLine === false`. That conflated TWO
                    independent things: the GPS receiver (works fine without
                    network — it's just listening to satellites) and the
                    internet connection (irrelevant to whether you have a
                    position fix on this boat right now). It also made the
                    Nav Station look different between online/offline states,
                    which user feedback identified as visually disruptive on
                    boats bouncing between cellular dead-spots.
                    Dot now: gray = no fix, cyan = fix, regardless of network.
                    Right-side label: always time-since-fix, regardless of
                    network. Connection diagnostics live in the System Status
                    modal where they belong. */}
                <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                        backgroundColor: position ? '#22d3ee' : '#6b7280',
                        boxShadow: position ? '0 0 6px rgba(34,211,238,0.6)' : 'none',
                    }}
                    aria-label={position ? 'GPS fix' : 'No GPS fix'}
                />
                <span className="font-mono text-white/85 tabular-nums truncate flex-1 text-[13px] font-semibold">
                    {position ? formatCoord(position.latitude, position.longitude) : 'Awaiting GPS fix…'}
                </span>
                <span className="text-white/60 text-[10px] uppercase tracking-wider shrink-0">
                    {formatTimeSince(position?.timestamp ?? null)}
                </span>
            </button>

            {/* SOG/COG nav line — left-side, always when underway */}
            {showSog && (
                <div className="flex items-center gap-3 px-4 pt-1.5 pb-1 border-t border-white/6 text-[11px]">
                    <span className="font-mono text-white/85 tabular-nums">
                        <span className="text-white/60 uppercase tracking-wider mr-1">SOG</span>
                        {sogKt.toFixed(1)}
                        <span className="text-white/60 text-[10px] ml-0.5">kt</span>
                        {cogDeg !== null && (
                            <span className="ml-2">
                                <span className="text-white/60 uppercase tracking-wider mr-1">COG</span>
                                {Math.round(cogDeg).toString().padStart(3, '0')}°
                            </span>
                        )}
                    </span>
                </div>
            )}

            {/* Environmental metric chips — flex-wrap so they reflow on
                narrow screens. Icon + value + tiny unit pattern, all
                font-mono for tabular alignment. Each chip only renders
                when its source data is present, so an at-dock vessel
                with no fetched weather won't display empty rails. */}
            <MetricChipStrip showTopBorder={!showSog} chips={metricChips} />

            {/* Canonical sign-in surface — opens from the "Already
                have a Thalassa account? Sign in →" link above when
                the user has no vessel set up yet. Apple + Google +
                email options, auto-dismisses on auth success via
                SignInScreen's authStore subscription. */}
            <SignInScreen
                isOpen={signInOpen}
                onClose={() => setSignInOpen(false)}
                prompt="Sign in to restore your saved vessel details."
            />
        </div>
    );
};
