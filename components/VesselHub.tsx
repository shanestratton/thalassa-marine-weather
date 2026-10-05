/**
 * VesselHub — Nav Station dashboard.
 *
 * Layout (top → bottom):
 *   Hero band:           vessel name · voyage state · position fix · time-since-fix
 *   Watch Status:        4 pinned tiles — anchor, guardian, MOB, radio (never scrolls)
 *   ── the scrolling area starts here (Shane 2026-08-30) ──
 *   Diary + Scuttlebutt: the two read-most screens, so they lead
 *   Skipper device:      publishing authority · which GPS speaks for the boat
 *   The menu, ONE box (Shane 2026-10-04), most used first: Crew & Float Plan ·
 *                        Boat Binder (its own screen: stores, equipment,
 *                        repairs, documents, reference, GPX import) · NMEA
 *                        Gateway · Music · Settings · Boat Network
 *
 * The whole page fits one screen, nothing folded (Shane 2026-10-04: "i prefer
 * that all of the menu itemed pages fit into one screen"): short screens and
 * split panes tighten it through styles/menu-page-fit.css.
 *
 * Recipe Library has moved to the Galley; keeping it in two places
 * confused users and the Galley is the natural home for it.
 */
import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../services/AnchorWatchService';
import { ShoreWatchAlarmService } from '../services/ShoreWatchAlarmService';
import { AnchorPiWatchKeeper } from '../services/anchorPiWatchKeeper';
import {
    anchorSwingGeometry,
    presentAnchorTile,
    presentAnchorWatchRow,
    shoreSwingKey,
    shoreWatchTileKey,
} from './anchor-watch/anchorWatchStatusRow';
import { useSettings } from '../context/SettingsContext';
import { buildClaim, claimAgeLabel, getDeviceId, holdsClaim, type SkipperClaim } from '../services/skipperDevice';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';
import { piCache } from '../services/PiCacheService';
import { useCloudTelemetry } from '../hooks/useCloudTelemetry';
import { useNmeaConnectionStatus } from './nmea/useNmeaStore';
import { refreshSkipperClaim } from '../stores/settingsStore';
import { useWeather } from '../context/WeatherContext';
import { useUIStore } from '../stores/uiStore';
import { triggerHaptic } from '../utils/system';
import { daylightUiColor } from '../utils/daylightUiColor';
import { convertLength } from '../utils/units';
import { calculateDistance } from '../utils/navigationCalculations';
import { getMyCrew } from '../services/CrewService';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { useVesselReadinessCounts } from '../hooks/useVesselReadinessCounts';
import { GpsService, type GpsPosition } from '../services/GpsService';
import { getCachedActiveVoyage, type Voyage } from '../services/VoyageService';
import {
    AnchorIcon,
    WindIcon,
    WaveIcon,
    ThermometerIcon,
    DropletIcon,
    EyeIcon,
    GearIcon,
    SailBoatIcon,
    ServerIcon,
    SpeakerWaveIcon,
} from './Icons';
import { useAuthStore } from '../stores/authStore';
import { SignInScreen } from './SignInScreen';
import { Button } from './ui/Button';
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

import { CONTOUR_BG, GLASS } from './vesselHub/glass';
import { formatCoord, formatDuration, formatTimeSince, pressureTrendIndicator } from './vesselHub/format';
import {
    BinderIcon,
    BookIcon,
    BoxIcon,
    ChartIcon,
    ChatBubbleIcon,
    ChecklistIcon,
    ClipboardIcon,
    CrewIcon,
    DocShieldIcon,
    GalleyIcon,
    GpxIcon,
    MobIcon,
    PenIcon,
    PlugIcon,
    ShieldIcon,
    SignalIcon,
    WrenchIcon,
} from './vesselHub/icons';

// The shared stroke icons are drawn at 2px; the hub's own set at 1.5px. This
// brings the borrowed glyphs down to the hub's line weight.
const HUB_ICON = 'h-4 w-4 [stroke-width:1.5]';

// The hub's one accent (UX scorecard run 7, C-vessel-seven-accents): card
// icons and section labels share sky, the Settings pages' heading colour, and
// red / amber / green are left to say state. It replaced a green Diary, a blue
// Scuttlebutt, a teal device card, a violet Crew card, a cyan Binder and a
// pink Music label on one screen. The Crew & Float Plan card's sky bezel went
// when the menu became one box (Shane 2026-10-04); the Diary and Scuttlebutt
// cards wear the same sky as a wash and an icon tile (vesselHub/JournalCard).
const HUB_ACCENT = 'var(--day-ui-accent, #7dd3fc)';

// Scroll-port edge fades (UX scorecard run 6, Y-vessel-hub-fades): the bottom
// always fades so a cut-off row reads as "more below", and the top fades once
// the content has moved, so a sliver of a card under the pinned deck fades out
// instead of showing as a hard line. The bottom is the same 14px as
// .thalassa-scroll-fade; kept as utilities because that class masks the bottom
// edge only. The top fade is off at scrollTop 0 (pt-2 is narrower than the fade
// and would dim the first row), and at the end of the scroll the bottom fade
// lands in pb-2.
// The top fade runs 8px clear then 28px of ramp (UX scorecard run 7,
// Y-hub-empty-tray-under-deck): at 14px the bottom edge of a card parked under
// the deck, 2-11px into the port, stayed visible as an empty rounded tray.
// 14px clear then an 18px ramp since run 8: in the long ramp a card title
// 8-15px into the port still read through as a ghost under the pinned tiles
// ("Serene Summer" showing through the gap), so the band under the deck is
// now clear for longer and the fade itself short.
const HUB_PORT_FADE_BOTTOM =
    '[-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%_-_14px),transparent)] [mask-image:linear-gradient(to_bottom,#000_calc(100%_-_14px),transparent)]';
const HUB_PORT_FADE_BOTH =
    '[-webkit-mask-image:linear-gradient(to_bottom,transparent_14px,#000_32px,#000_calc(100%_-_14px),transparent)] [mask-image:linear-gradient(to_bottom,transparent_14px,#000_32px,#000_calc(100%_-_14px),transparent)]';
import { BinderSubLabel, ListDivider, OfficeRow } from './vesselHub/listRows';
import { JournalCard } from './vesselHub/JournalCard';
import { MetricChipStrip } from './vesselHub/MetricChip';
import { SwingArc } from './vesselHub/SwingArc';
import { useTripRoute } from '../hooks/useTripRoute';
import { type MetricChipData, type SkipperDeviceControlProps, type VesselHubProps } from './vesselHub/types';
import { useGuardianTileState } from './vesselHub/useGuardianTileState';
import { usePendingCrewInvites } from './vesselHub/usePendingCrewInvites';
import { useCrewingVessel } from '../hooks/useCrewingVessel';
import { useCrewVesselView } from '../hooks/useCrewVesselView';
import { crewVesselAboard, crewVesselName } from '../services/crew/crewVesselView';
import { floatPlanSelfDetails } from '../services/crew/floatPlanPeople';
import { SKIPPER_BOAT_FALLBACK } from './vessel/SharedBinderLine';
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

// Daylight takes the hub's plain white card, not the mint --vessel-safety-card-bg
// (UX scorecard run 9, C-vessel-light-mint): a mint fill whatever the state put
// Guardian OFF on the same "all good" green a watching Guardian would wear,
// where dark mode gives the tiles a neutral fill. The green outline stays, and
// the state word and chip carry the colour in both themes. --vessel-card-bg is
// set only in daylight, so dark and night keep this gradient.
const SAFETY_CONTROL_CARD = {
    ...GLASS.card,
    background:
        'var(--vessel-card-bg, linear-gradient(145deg, rgba(16, 185, 129, 0.15) 0%, rgba(20, 25, 35, 0.82) 72%))',
    border: '1px solid var(--vessel-safety-card-border, rgba(74, 222, 128, 0.42))',
    boxShadow:
        'inset 0 1px 0 rgba(167, 243, 208, 0.22), 0 0 0 1px rgba(16, 185, 129, 0.10), 0 8px 22px rgba(16, 185, 129, 0.12)',
} as React.CSSProperties;

/** The Guardian shield without its tick: the tile's glyph while Guardian is
 *  off. The outline is vesselHub/icons ShieldIcon's own, so the two states
 *  differ only by the tick. */
const PlainShieldGlyph: React.FC<{ color: string }> = ({ color }) => (
    <svg aria-hidden="true" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 2.714A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />
    </svg>
);

/** Scroll room (pt) before a closed page gets a resting point at its end: twice
 *  the 24 pt a return gesture can leave the first row under the deck, so the
 *  end never sits nearer that gesture than home does. */
const END_REST_MIN_SCROLL = 48;

// The tiles' descriptors (MOB's "Overboard", Radio's "Position") in true
// slate-400, set inline: the app-wide caption rule lifts .text-slate-400 to
// slate-300, which sat 1.1:1 from the "Up" state word and read as one more
// state (UX scorecard run 8). 7:1 on the tile still; daylight takes the muted
// ink. The 9.5 px size is Shane's, and stays.
const DESCRIPTOR_INK = 'var(--day-ui-muted, #94a3b8)';

/** The idle ("not watching") state on a safety tile — Anchor's Up and
 *  Guardian's Off: a grey glyph and a full-ink state word. Colour is kept for
 *  the watching and alarm states (UX scorecard run 10). */
const IDLE_STATE_INK = '#e2e8f0';
const IDLE_GLYPH_INK = '#9ca3af';

const ALERT_SAFETY_CONTROL_CARD = {
    ...SAFETY_CONTROL_CARD,
    background:
        'var(--vessel-alert-card-bg, linear-gradient(145deg, rgba(127, 29, 29, 0.56) 0%, rgba(20, 25, 35, 0.86) 72%))',
    border: '1px solid rgba(248, 113, 113, 0.62)',
    boxShadow:
        'inset 0 1px 0 rgba(254, 202, 202, 0.20), 0 0 0 1px rgba(239, 68, 68, 0.14), 0 8px 22px rgba(239, 68, 68, 0.16)',
} as React.CSSProperties;

export const VesselHub: React.FC<VesselHubProps> = React.memo(({ onNavigate, settings, chatUnread = 0 }) => {
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
    // This phone's own watch. The card used to read it alone: when the Pi
    // takes the watch, handleAcceptPiWatch stops the local one (that is the
    // point of going ashore), so the card said "Off" while the boat was
    // watched all night. Wrong in the reassuring direction. The tile now reads
    // the same three sources as the System status box (below).
    // Seeded from the service so a page opened mid-watch does not paint "Up"
    // for one frame before the subscription below lands. (Test doubles that
    // mock only subscribe() throw here, and start from null as before.)
    const [anchorLocal, setAnchorLocal] = useState<AnchorWatchSnapshot | null>(() => {
        try {
            return AnchorWatchService.getSnapshot();
        } catch {
            return null;
        }
    });
    // The keeper has no listener. It is read on every render (a hand-off stops
    // the local watch and joins shore, each of which re-renders this), and a
    // slow poll catches a keeper change that arrives with no other news, such
    // as the restore after a relaunch.
    const [, setAnchorPiPoll] = useState<string | null>(null);
    const anchorPiSession = AnchorPiWatchKeeper.keepingSessionCode();
    // Re-render when the shore watch changes in a way the tile or the hero's
    // swing arc shows (whole metres, 5° steps), not on every identical report
    // the Pi sends; the snapshot itself is read at render.
    useSyncExternalStore(ShoreWatchAlarmService.subscribe, () => {
        const shore = ShoreWatchAlarmService.getSnapshot();
        const keeper = AnchorPiWatchKeeper.keepingSessionCode();
        return `${shoreWatchTileKey(shore, keeper)}|${shoreSwingKey(shore, keeper)}`;
    });
    const shoreWatch = ShoreWatchAlarmService.getSnapshot();
    const [anchorRadius, setAnchorRadius] = useState(0);
    // Everything on the page is permanently visible (Shane 2026-10-04): the
    // pinned safety tiles, the Diary/Scuttlebutt pair, the skipper card and
    // the one menu box. The collapsed "Connections & music" group (NMEA
    // Gateway, Boat Network, Music) and the per-device memory of whether it
    // was left open went with it; those rows are in the box.
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
    // The row's state sits in the right-hand slot, as the Settings rows show
    // theirs, and its subtitle stays a plain description (UX scorecard run 10,
    // vessel-row-status-slot): the state used to ride inline after a dot
    // ('Instruments & AIS · connect when aboard').
    const gatewayStatus = nmeaLink.status === 'remote' ? 'Reading her via the Pi' : 'Instruments & AIS';
    const gatewayState =
        nmeaLink.status === 'connected'
            ? 'Connected'
            : nmeaLink.status === 'remote'
              ? nmeaLink.remote?.via === 'lan'
                  ? 'Aboard'
                  : 'Away'
              : 'Not connected';
    const gatewayStatusColor =
        nmeaLink.status === 'connected' || nmeaLink.remote?.via === 'lan'
            ? '#6ee7b7'
            : nmeaLink.status === 'remote'
              ? '#7dd3fc'
              : '#94a3b8';
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
    const { weatherData, refreshData } = useWeather();
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

    // The shared weather context owns location intent. The hero band's phone
    // position must never replace vessel weather (including in split screen).
    useEffect(() => {
        if (weatherData) return; // already populated — orchestrator handles refresh
        if (!isOnline) return;
        refreshData(true);
    }, [weatherData, isOnline, refreshData]);

    // Whether the lower port has moved off its resting position — switches on
    // its top-edge fade (see HUB_PORT_FADE_BOTH). React bails out when the
    // value is unchanged, so this re-renders only when crossing the threshold.
    const [portScrolled, setPortScrolled] = useState(false);
    const handlePortScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
        setPortScrolled(event.currentTarget.scrollTop > 1);
    }, []);

    // Whether the port scrolls at all, and whether it scrolls far enough for
    // the page end to be a resting point of its own (see the menu box). The
    // page is sized to fit one screen (Shane 2026-10-04), so normally neither
    // is true; a fresh install's "Set up your vessel" card or an anchor drag
    // alarm can still push the box past a short screen. With home as the only
    // snap target, a part-way scroll pulled straight back under the fold.
    // The bottom "more below" fade is drawn only when there is more below: on
    // a page that fits it would only dim the box's lower edge.
    const portRef = useRef<HTMLDivElement>(null);
    const [portRoomy, setPortRoomy] = useState(false);
    const [portOverflows, setPortOverflows] = useState(false);
    useEffect(() => {
        const port = portRef.current;
        if (!port || typeof ResizeObserver === 'undefined') return;
        const measure = () => {
            const room = port.scrollHeight - port.clientHeight;
            setPortRoomy(room >= END_REST_MIN_SCROLL);
            setPortOverflows(room > 1);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(port);
        for (const child of Array.from(port.children)) observer.observe(child);
        measure();
        return () => observer.disconnect();
        // Boat Binder replaces the whole page, so the port remounts on return.
    }, [binderOpen]);
    const hubPortFade = portScrolled ? HUB_PORT_FADE_BOTH : portOverflows ? HUB_PORT_FADE_BOTTOM : '';

    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snapshot) => {
            setAnchorRadius(snapshot.swingRadius || 0);
            setAnchorLocal(snapshot);
            // Extended snapshot for the relative swing viz — keeps the
            // hero arc showing the boat's actual offset/bearing from
            // the anchor point, not just a static radius circle.
            setAnchorOffset(snapshot.distanceFromAnchor || 0);
            setAnchorBearing(snapshot.bearingToAnchor || 0);
        });
        return unsub;
    }, []);

    useEffect(() => {
        const id = setInterval(() => setAnchorPiPoll(AnchorPiWatchKeeper.keepingSessionCode()), 5_000);
        return () => clearInterval(id);
    }, []);

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
    // Only a count the skipper actually set, or real registered crew, may show.
    // vesselCrewAboard() answers 2 for an unset field, and "2 crew" on a fresh
    // or signed-out install read as a count (UX scorecard run 6).
    const passageVessel = (ctx as { vessel?: { crewCount?: number } }).vessel;
    const crewCountSet = typeof passageVessel?.crewCount === 'number' && Number.isFinite(passageVessel.crewCount);
    const configuredPassageCrewCount = crewCountSet ? vesselCrewAboard(passageVessel) : 0;
    // Crewing on a skipper's boat (2026-10-03): the row names that boat and
    // counts its people, from the cached crew view, not the account's own crew.
    const { vessel: crewingVessel } = useCrewingVessel();
    const crewingOwnerId = authenticatedUserId ? (crewingVessel?.ownerId ?? null) : null;
    const { view: crewingBoatView } = useCrewVesselView(crewingOwnerId, 0, { live: false });
    const loadPassageCrew = useCallback(async () => {
        const scope = getAuthIdentityScope();
        if (scope.userId !== authenticatedUserId || crewingOwnerId) return;
        try {
            const c = await getMyCrew();
            if (!isAuthIdentityScopeCurrent(scope)) return;
            // max(settings count, actual crew + captain) — the captain is only
            // counted alongside registered crew, never on his own as a default.
            const actualWithCaptain = c.length > 0 ? c.length + 1 : 0;
            setPassageCrewCount(Math.max(configuredPassageCrewCount, actualWithCaptain));
        } catch {
            /* offline — keep previous count */
        }
    }, [authenticatedUserId, configuredPassageCrewCount, crewingOwnerId]);
    useEffect(() => {
        setPassageCrewCount(0);
        void loadPassageCrew();
    }, [loadPassageCrew]);
    const passageCrewCountShown = crewingOwnerId
        ? (crewVesselAboard(crewingBoatView, floatPlanSelfDetails(ctx.vessel)) ?? 0)
        : passageCrewCount;
    const crewingBoatName = crewingOwnerId
        ? crewVesselName(crewingVessel?.vesselName, crewingBoatView) || SKIPPER_BOAT_FALLBACK
        : null;
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
    //
    // Derived from the System status box's row (presentAnchorWatchRow), so the
    // two surfaces share one truth table. The tile used to know only this
    // phone's watch and "a shore session exists": a watch only the Pi kept
    // read "Up", a paused watch read "Up", a drag alarm from the Pi stayed a
    // calm "Down · Pi", and another phone's session was credited to the Pi.
    const anchorRow = presentAnchorWatchRow(anchorLocal, shoreWatch, anchorPiSession);
    const anchorTile = presentAnchorTile(anchorRow);
    // The hero's swing arc comes from whichever device keeps the watch.
    const anchorSwing = anchorSwingGeometry(
        anchorRow,
        { radiusM: anchorRadius, offsetM: anchorOffset, bearingDeg: anchorBearing },
        shoreWatch,
    );
    const anchorStatus = anchorTile.status;
    const anchorEffectivelyArmed = anchorTile.tone !== 'off';
    const anchorLabelShort = anchorTile.label;
    const anchorColor =
        anchorTile.tone === 'red'
            ? '#ef4444'
            : anchorTile.tone === 'amber'
              ? '#f59e0b'
              : anchorTile.tone === 'cyan'
                ? '#22d3ee'
                : IDLE_GLYPH_INK;
    // The tile's second line is a STATE here, so it is inked as one: the
    // descriptors (MOB's "Overboard", Radio's "Position") are the dim slate
    // words, and a grey "Up" read as one of them (UX scorecard run 6). The
    // glyph keeps the grey; only the word moves to full ink.
    const anchorWordColor = anchorEffectivelyArmed ? anchorColor : IDLE_STATE_INK;
    // What VoiceOver hears. The tile's aria-label used to be a fixed "Anchor
    // Watch", which overrode the visible state entirely.
    const anchorSpoken = anchorTile.spoken;
    // The hero card asks the same question ("At Anchor" vs "Underway"), so it
    // gets the same answer: anchorStatus above is the tile's. A boat whose
    // anchor is watched by the Pi is at anchor; only this phone's involvement
    // changed.

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
                className="vessel-hub-surface w-full h-full flex flex-col animate-in fade-in duration-300 vessel-hub-no-scrollbar vessel-hub-binder"
                style={{
                    paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                    backgroundImage: CONTOUR_BG,
                    backgroundSize: '400px 400px',
                    backgroundColor: 'var(--vessel-surface-bg, transparent)',
                }}
            >
                <div className="vessel-binder-header flex shrink-0 items-center gap-3 px-4 pb-3 pt-4">
                    <BackButton
                        onClick={() => {
                            triggerHaptic('light');
                            setBinderOpen(false);
                        }}
                        label="Back to Vessel"
                        className="shrink-0"
                    />
                    {/* The binder is its own screen, so its title is the page's
                        h1 (it was a span, leaving the screen with no heading).
                        Same classes, so it looks exactly as before. */}
                    <h1 className="text-xl font-extrabold uppercase tracking-wider text-white">Boat Binder</h1>
                </div>
                <div className="vessel-binder-port flex-1 min-h-0 overflow-y-auto vessel-hub-no-scrollbar px-4 pb-4">
                    {/* The Passage subgroup is gone (Shane 2026-09-02, binder
                        review, shelf #1): after Saved Routes was culled
                        (2026-08-04) it was a grand heading over one import
                        button. Import GPX now lives at the tail of Reference
                        below AND on the Plan page's front door — the tool
                        kept its shelf, routes kept their home. */}

                    {/* — Inventory & Stores subgroup — */}
                    {/* Icons in the hub's one accent, like the hub's own rows;
                        red stays for overdue and expiring (UX scorecard run 7). */}
                    <BinderSubLabel>Inventory &amp; Stores</BinderSubLabel>
                    <div className="vessel-hub-menu" style={GLASS.listContainer}>
                        <OfficeRow
                            icon={<BoxIcon color={HUB_ACCENT} />}
                            label="Ship's Stores"
                            status="Provisions & spares"
                            statusColor="var(--day-ui-muted, #94a3b8)"
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
                            icon={<ChecklistIcon color={HUB_ACCENT} />}
                            label="Checklists"
                            status="Safety & passage"
                            statusColor="var(--day-ui-muted, #94a3b8)"
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('checklists');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<ClipboardIcon color={HUB_ACCENT} />}
                            label="Equipment"
                            status={
                                expiringEquipCount > 0
                                    ? `${expiringEquipCount} ${expiringEquipCount === 1 ? 'warranty' : 'warranties'} ending soon`
                                    : 'Register & warranties'
                            }
                            statusColor={expiringEquipCount > 0 ? '#f59e0b' : '#94a3b8'}
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('equipment');
                            }}
                            badge={expiringEquipCount > 0 ? expiringEquipCount : undefined}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={
                                <WrenchIcon color={overdueCount > 0 ? 'var(--day-ui-danger, #ef4444)' : HUB_ACCENT} />
                            }
                            label="Maintenance"
                            status={overdueCount > 0 ? `${overdueCount} overdue` : 'Tasks & expiry'}
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
                            icon={
                                <DocShieldIcon
                                    color={expiringDocsCount > 0 ? 'var(--day-ui-danger, #ef4444)' : HUB_ACCENT}
                                />
                            }
                            label="Documents"
                            status={expiringDocsCount > 0 ? `${expiringDocsCount} expiring` : 'Legal papers'}
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
                    <div className="vessel-hub-menu" style={GLASS.listContainer}>
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
                            icon={<GalleyIcon color={HUB_ACCENT} />}
                            label="Galley"
                            status="Meal planning"
                            statusColor="var(--day-ui-muted, #94a3b8)"
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
                            icon={<BookIcon color={HUB_ACCENT} />}
                            label="Skipper's Reference"
                            status="GRIB · synoptic · squalls"
                            statusColor="var(--day-ui-muted, #94a3b8)"
                            onClick={() => {
                                triggerHaptic('light');
                                navigateFromBinder('skipperReference');
                            }}
                        />
                        <ListDivider />
                        <OfficeRow
                            icon={<ChartIcon color={HUB_ACCENT} />}
                            label="Polars"
                            status={isObserver ? 'Vessel required' : 'Tuning'}
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
                            icon={<GpxIcon color={HUB_ACCENT} />}
                            label="Import GPX"
                            status="From OpenCPN or Navionics"
                            statusColor="var(--day-ui-muted, #94a3b8)"
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
            className="vessel-hub-surface w-full h-full flex flex-col animate-in fade-in duration-300 vessel-hub-no-scrollbar vessel-hub-home"
            style={{
                paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                backgroundImage: CONTOUR_BG,
                backgroundSize: '400px 400px',
                backgroundColor: 'var(--vessel-surface-bg, transparent)',
            }}
        >
            <h1 className="sr-only">Vessel</h1>
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
            <section
                className="vessel-hub-deck relative z-20 shrink-0 px-4 pt-4 pb-1"
                aria-label="Vessel status and safety controls"
            >
                {/* The deck's lower edge, once the port below has moved (UX
                    scorecard run 10, vessel-scroll-fade): a hairline and a short
                    shade, so a card scrolled up under the deck reads as going
                    on above instead of cut flat. It hangs below the deck
                    (top-full), over the port's clear band, so it costs no height
                    and the deck's box never moves. Off at home, like the port's
                    own top fade. */}
                <div
                    aria-hidden="true"
                    data-testid="vessel-deck-scroll-edge"
                    className={`pointer-events-none absolute inset-x-4 top-full h-3 border-t border-white/10 bg-linear-to-b from-black/45 to-transparent transition-opacity duration-200 [.display-light_&]:border-slate-300 [.display-light_&]:from-slate-900/6 ${
                        portScrolled ? 'opacity-100' : 'opacity-0'
                    }`}
                />
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
                        anchorStatus={anchorStatus}
                        anchorRadius={anchorSwing.radiusM}
                        anchorOffset={anchorSwing.offsetM}
                        anchorBearing={anchorSwing.bearingDeg}
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
                    {/* No top margin (UX scorecard run 7, Y-vessel-375-settings-
                        below-fold): with the hero card hidden, the deck's pt-4
                        plus an mt-3 left 28pt under the app header, 12pt more
                        than any other tab, and cost the 375x667 fold the row
                        that tells a skipper the list goes on. The hero, when
                        shown, brings its own mb-4. */}
                    <div className="relative">
                        {/* Heading outline (UX referee A-heading-outline): the
                            deck needs an h2. The visible "Watch Status" heading
                            was removed at Shane's ask to save the row, so this
                            one is for screen readers only and costs no height.
                            The tile names are spans, not h3s: a heading inside a
                            button is flattened into the button's name and never
                            reaches the heading rotor (UX scorecard run 7). */}
                        <h2 className="sr-only">Safety controls</h2>
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
                            {/* Accessible names lead with the visible tile name
                                (voice control) and end with the state word, so
                                VoiceOver hears OFF / UP rather than a fixed label
                                (UX scorecard run 6). Second lines: descriptors
                                (Overboard, Position) are dim slate; states (Off,
                                Up, Watching, Down) carry colour or full ink. */}
                            <button
                                aria-label="MOB, man overboard"
                                onClick={() => {
                                    triggerHaptic('heavy');
                                    onNavigate('mob');
                                }}
                                style={ALERT_SAFETY_CONTROL_CARD}
                                className="vessel-safety-tile card-lift flex flex-col items-center justify-center gap-1.5 px-1 py-2.5 transition-all hover:brightness-110 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                            >
                                <div
                                    className="vessel-safety-chip flex h-8 w-8 items-center justify-center rounded-lg"
                                    style={{ background: 'rgba(239, 68, 68, 0.18)' }}
                                >
                                    <MobIcon color="var(--day-ui-danger, #ef4444)" />
                                </div>
                                <span className="text-[11px] font-black leading-none tracking-wide text-white">
                                    MOB
                                </span>
                                <p
                                    className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere]"
                                    style={{ color: DESCRIPTOR_INK }}
                                >
                                    Overboard
                                </p>
                            </button>

                            <button
                                aria-label="Radio, position reporting"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('radio');
                                }}
                                style={SAFETY_CONTROL_CARD}
                                className="vessel-safety-tile card-lift flex flex-col items-center justify-center gap-1.5 px-1 py-2.5 transition-all hover:bg-white/3 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                            >
                                <div
                                    className="vessel-safety-chip flex h-8 w-8 items-center justify-center rounded-lg"
                                    style={{ background: 'rgba(103, 232, 249, 0.12)' }}
                                >
                                    <SignalIcon color="var(--day-ui-accent, #67E8F9)" />
                                </div>
                                <span className="text-[11px] font-black leading-none tracking-wide text-white">
                                    Radio
                                </span>
                                <p
                                    className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere]"
                                    style={{ color: DESCRIPTOR_INK }}
                                >
                                    Position
                                </p>
                            </button>

                            {FEATURE_VISIBILITY.guardian && (
                                <button
                                    aria-label={`Guardian, ${
                                        guardianArmed
                                            ? guardianNearby > 0
                                                ? `watching, ${guardianNearby} nearby`
                                                : 'watching'
                                            : 'off'
                                    }`}
                                    onClick={() => {
                                        triggerHaptic('light');
                                        onNavigate('guardian');
                                    }}
                                    style={SAFETY_CONTROL_CARD}
                                    className="vessel-safety-tile card-lift flex flex-col items-center justify-center gap-1.5 px-1 py-2.5 transition-all hover:bg-white/3 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                                >
                                    {/* Off wears the idle ink Anchor's Up wears (UX
                                        scorecard run 10, vessel-idle-ink-tabbar):
                                        amber OFF beside a white UP gave the two
                                        "not watching" states two colours. The grey
                                        glyph and full-ink word are Anchor's up
                                        state exactly; colour is kept for watching. */}
                                    <div
                                        className="vessel-safety-chip flex h-8 w-8 items-center justify-center rounded-lg"
                                        style={{
                                            background: guardianArmed
                                                ? 'rgba(245, 158, 11, 0.12)'
                                                : `${IDLE_GLYPH_INK}1f`,
                                        }}
                                    >
                                        {/* The tick only while Guardian watches (UX
                                            scorecard run 9): a shield-with-tick
                                            beside OFF said "protected". */}
                                        {guardianArmed ? (
                                            <ShieldIcon color="var(--day-ui-amber, #f59e0b)" />
                                        ) : (
                                            <PlainShieldGlyph color={daylightUiColor(IDLE_GLYPH_INK)} />
                                        )}
                                    </div>
                                    <span className="text-[11px] font-black leading-none tracking-wide text-white">
                                        Guardian
                                    </span>
                                    <p
                                        className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere]"
                                        style={{ color: daylightUiColor(guardianArmed ? '#10b981' : IDLE_STATE_INK) }}
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
                                aria-label={`Anchor watch, ${anchorSpoken}`}
                                onClick={() => {
                                    // 'compass', NOT 'anchor' — the Anchor Watch screen
                                    // has always been routed under the compass key, and
                                    // there is no 'anchor' route to fall back to, so the
                                    // guess landed on a blank page.
                                    triggerHaptic('light');
                                    onNavigate('compass');
                                }}
                                style={anchorStatus === 'alarm' ? ALERT_SAFETY_CONTROL_CARD : SAFETY_CONTROL_CARD}
                                className="vessel-safety-tile card-lift flex flex-col items-center justify-center gap-1.5 px-1 py-2.5 transition-all hover:bg-white/3 active:scale-[0.98] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                            >
                                {/* THE SAME GLYPH IN EVERY STATE. The live
                                    swing arc used to take this slot while the
                                    anchor was down — a picture worth having,
                                    but not at a quarter of the deck's width,
                                    where it made this tile taller than its
                                    three siblings and dragged the row with it.
                                    The arc still exists one tap away on the
                                    Anchor screen, and on the At Anchor card
                                    below where there is room for it. Here the
                                    colour does the work: cyan down, grey up,
                                    red and pulsing while dragging.
                                    An anchor, not a plain dot: a 12px grey dot
                                    beside three icon tiles read as a tile that
                                    had not loaded (UX referee 2026-09-26). */}
                                <div
                                    className="vessel-safety-chip flex h-8 w-8 items-center justify-center rounded-lg"
                                    style={{ background: `${anchorColor}1f` }}
                                >
                                    <span
                                        className="inline-flex"
                                        style={{
                                            color: daylightUiColor(anchorColor),
                                            filter:
                                                anchorEffectivelyArmed || anchorStatus === 'alarm'
                                                    ? `drop-shadow(0 0 4px ${anchorColor}60)`
                                                    : 'none',
                                            animation: anchorStatus === 'alarm' ? 'pulse 1s infinite' : 'none',
                                        }}
                                    >
                                        <AnchorIcon className="h-4 w-4" />
                                    </span>
                                </div>
                                <span className="text-[11px] font-black leading-none tracking-wide text-white">
                                    Anchor
                                </span>
                                <p
                                    className="max-w-full text-[9.5px] font-bold uppercase leading-[1.1] text-balance [overflow-wrap:anywhere]"
                                    style={{ color: daylightUiColor(anchorWordColor) }}
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

                FIT, not just scroll (Shane 2026-09-06, and 2026-10-04: "i
                would like to ensure that the vessel page all fits on one
                screen without needing to scroll"): the outer surface already
                ends above the tab bar, so at its natural position the port
                CLIPS whatever falls below its bottom edge. The vertical rhythm
                here (pt-2, pb-1 on the deck, mb-2 cards) fits a tall phone as
                drawn; shorter screens and split panes take the tighter rhythm
                in styles/menu-page-fit.css (a container query on this page's
                own height, so a pane is measured, not guessed), which keeps
                every row at least 44 pt. The port still scrolls if a state
                adds height (the fresh-install "Set up your vessel" card).

                FILL (Shane 2026-10-04: "make the whole thing take up the
                enitre page"): the port is a flex column, and the Diary pair
                and the menu box share whatever height is left, so the page
                ends at the tab bar on a tall phone or pane instead of ~170 px
                above it; a short screen leaves them at their 44 pt floor. */}
            <div
                ref={portRef}
                className={`flex-1 min-h-0 overflow-y-auto vessel-hub-no-scrollbar px-4 pt-2 pb-2 stagger-in vessel-hub-port ${hubPortFade}`}
                // The ROOT already ends 8px above the tab bar, so this port's own
                // bottom padding must not repeat that: with the tab-bar calc here
                // too, a page with nothing expanded still had ~100px of dead
                // scroll room, and a flick up parked the Diary and Scuttlebutt
                // tiles under the fixed deck with nothing to snap them back
                // (Shane 2026-09-09: "the diary and the scuttlebutt pages get
                // stuck under the 4 cards above them"). pb-2 keeps the last row
                // clear of the port's edge, 16 px off the tab bar with the
                // root's 8; overscroll stays inside the port.
                style={{
                    overscrollBehaviorY: 'contain',
                    scrollSnapType: 'y proximity',
                    // Match pt-2 so the first row rests at scrollTop 0,
                    // not one padding-width under the operational deck.
                    scrollPaddingTop: '0.5rem',
                    // The port's pb-2 (the menu box has no margin of its own),
                    // so the lower resting point is the true bottom of the
                    // page, not a second one short of it.
                    scrollPaddingBottom: '0.5rem',
                }}
                onScroll={handlePortScroll}
            >
                {/* Diary + Scuttlebutt lead the scrolling area (Shane
                    2026-08-30). They are the two things opened most often and
                    the only ones here that are read rather than configured, so
                    they come before the card that answers "who speaks for this
                    boat" — Skipper Device — and the menu box below it. */}
                {/* Diary + Scuttlebutt — permanently visible peer tiles. */}
                <div className="vessel-hub-journal relative mb-2" style={{ scrollSnapAlign: 'start' }}>
                    {/* Screen-reader section heading for the two tiles, so they
                        do not read as part of the safety controls above. */}
                    <h2 className="sr-only">Journal and community</h2>
                    {/* Title and a short subtitle (UX scorecard run 7,
                        W-vessel-settings-copy: no subtitle that restates the
                        title), one accent for both, names as spans: a heading
                        inside a button is flattened into the button's name.
                        Shane 2026-10-04 ("maybe make the didary and
                        scuttlebutt look better, also make the whole thing take
                        up the enitre page"): the pair is the page's richest
                        card, and it grows with the screen, see JournalCard. */}
                    <div className="vessel-hub-journal-pair grid h-full grid-cols-2 gap-3">
                        {/* Diary — personal journal (left tile) */}
                        <JournalCard
                            aria-label="Open Diary"
                            title="Diary"
                            subtitle="Notes & photos"
                            icon={<PenIcon color={HUB_ACCENT} />}
                            accent={HUB_ACCENT}
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('diary');
                            }}
                        />

                        {/* Scuttlebutt — community channels + DMs (right
                            tile), the outward half of the share-your-voyage
                            story beside the Diary's inward one. "Sailor chat"
                            under the sailor's word (UX scorecard run 10,
                            copy-nits-bundle): "Scuttlebutt" alone does not
                            say it is chat. Unread DMs (the Vessel tab's
                            badge) take that line and a count on the card. */}
                        <JournalCard
                            aria-label="Open Scuttlebutt"
                            title="Scuttlebutt"
                            subtitle={
                                chatUnread > 0
                                    ? `${chatUnread} new message${chatUnread === 1 ? '' : 's'}`
                                    : 'Sailor chat'
                            }
                            badge={chatUnread > 0 ? (chatUnread > 99 ? '99+' : String(chatUnread)) : undefined}
                            icon={<ChatBubbleIcon color={HUB_ACCENT} />}
                            accent={HUB_ACCENT}
                            onClick={() => {
                                triggerHaptic('light');
                                onNavigate('chat');
                            }}
                        />
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

                {/* ═══════════════════════════════════════════ */}
                {/* THE MENU — ONE BOX, most used first          */}
                {/* ═══════════════════════════════════════════ */}
                {/* Shane 2026-10-04: "the vessel page needs to have one box
                    around crew and float plan, boat binder, settings, nmea
                    gateway, boat network, and music. can you also order them
                    in a better order from most used to least." So the six rows
                    are one grouped card with dividers, and nothing is folded
                    away: the Crew & Float Plan card (with its sky bezel), the
                    Boat Binder + Settings card and the collapsed "Connections &
                    music" group are gone. The page fits one screen without the
                    fold ("i prefer that all of the menu itemed pages fit into
                    one screen"): see styles/menu-page-fit.css, which tightens
                    the page on short screens and panes.

                    Order, most used to least: Crew & Float Plan (every
                    passage, and its pending-invite badge is the most urgent
                    state on the menu), Boat Binder (stores, maintenance and
                    documents), NMEA Gateway (a skipper aboard opened the old
                    fold for it on every visit, UX scorecard run 8, and its
                    Connected / Aboard / Away state is worth a glance), Music
                    (non-essential, UX scorecard run 7), Settings, then Boat
                    Network, which is set up once.

                    A lower resting point exists only when the port has real
                    room to scroll (portRoomy) — a fresh install's "Set up your
                    vessel" card can still push the box past a short screen, and
                    with home as the only snap target a part-way scroll pulled
                    straight back. When it fits, there is nothing to snap. */}
                <div
                    data-testid="vessel-hub-menu"
                    className="vessel-hub-menu"
                    style={{ ...GLASS.listContainer, scrollSnapAlign: portRoomy ? 'end' : 'none' }}
                >
                    <h2 className="sr-only">Vessel menu</h2>
                    {/* CREW & FLOAT PLAN — the voyage workflow (readiness, crew,
                        watches, float plan, Cast Off). Named from the app
                        glossary (UX scorecard run 6): "Passage Planning"
                        collided with the Plan tab's route planner. Amber stays
                        for pending invites, a state. */}
                    <OfficeRow
                        icon={<CrewIcon color={HUB_ACCENT} />}
                        label="Crew & Float Plan"
                        status={
                            pendingCrewInvites > 0
                                ? `${pendingCrewInvites} crew ${pendingCrewInvites === 1 ? 'invite' : 'invites'} pending`
                                : crewingBoatName
                                  ? `Crewing on ${crewingBoatName}`
                                  : 'Readiness checks & cast off'
                        }
                        statusColor={pendingCrewInvites > 0 ? '#f59e0b' : '#94a3b8'}
                        value={passageCrewCountShown > 0 ? `${passageCrewCountShown} crew` : undefined}
                        valueColor="#e2e8f0"
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('crew');
                        }}
                        badge={pendingCrewInvites > 0 ? pendingCrewInvites : undefined}
                    />
                    <ListDivider />
                    {/* BOAT BINDER — its OWN SCREEN (Shane 2026-07-19: "can boat
                        binder be its own screen when you click on it"). The row
                        opens it in place; stores, equipment, maintenance,
                        documents and reference live there. */}
                    <OfficeRow
                        icon={<BinderIcon color={HUB_ACCENT} />}
                        label="Boat Binder"
                        status="Inventory & reference"
                        statusColor="#94a3b8"
                        onClick={() => {
                            triggerHaptic('light');
                            // The hub port remounts at the top on the way back.
                            setPortScrolled(false);
                            setBinderOpen(true);
                        }}
                    />
                    <ListDivider />
                    <OfficeRow
                        icon={<PlugIcon color={HUB_ACCENT} />}
                        label="NMEA Gateway"
                        status={gatewayStatus}
                        statusColor="#94a3b8"
                        value={gatewayState}
                        valueColor={gatewayStatusColor}
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('nmea');
                        }}
                    />
                    {/* ENC Library is not on this menu (Shane 2026-08-07: "less
                        is more"); the map's no-coverage affordance opens it. */}
                    <ListDivider />
                    {/* MUSIC — removed 2026-07-19, RESTORED 2026-08-08 at Shane's
                        ask: the mic and the now-playing bar do not help when you
                        want to go and choose something. */}
                    <OfficeRow
                        icon={
                            <span className="flex" style={{ color: HUB_ACCENT }}>
                                <SpeakerWaveIcon className={HUB_ICON} />
                            </span>
                        }
                        label="Music"
                        status="Apple Music & speakers"
                        statusColor="#94a3b8"
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('music');
                        }}
                    />
                    <ListDivider />
                    <OfficeRow
                        // "Settings", with what is in it, not "Account &
                        // Settings" over a sign-in status alone (UX scorecard
                        // run 6).
                        icon={
                            <span className="flex" style={{ color: HUB_ACCENT }}>
                                <GearIcon className={HUB_ICON} />
                            </span>
                        }
                        label="Settings"
                        // The account state in the right-hand slot, as the
                        // Settings rows show theirs; the subtitle says what is
                        // inside (UX scorecard run 10, vessel-row-status-slot).
                        status="Units, alerts, vessel"
                        statusColor="#94a3b8"
                        value={(() => {
                            // During the free public beta there is no
                            // plan to name, so say what is true of this
                            // account instead of "Free public beta"
                            // (UX referee W-developer-speak).
                            if (PUBLIC_BETA_ACCESS.enabled) return authenticatedUserId ? 'Signed in' : 'Not signed in';
                            // One source of truth for plan names —
                            // the hub used to invent its own ("Vessel
                            // Owner"/"Crew Plan") and disagree with
                            // Settings and the paywall.
                            const tier = (settings as Record<string, unknown>).subscriptionTier as string;
                            return (
                                (TIER_INFO[tier as SubscriptionTier] as { label: string } | undefined) ?? TIER_INFO.free
                            ).label;
                        })()}
                        valueColor={(() => {
                            if (PUBLIC_BETA_ACCESS.enabled) return authenticatedUserId ? '#7dd3fc' : '#94a3b8';
                            // Tier badge stays its own colour —
                            // owner=amber (premium), crew=the hub
                            // accent, free=grey. This is a deliberate
                            // status signal, not chromatic noise.
                            const tier = (settings as Record<string, unknown>).subscriptionTier as string;
                            if (tier === 'owner') return '#f59e0b';
                            if (tier === 'crew') return '#7dd3fc';
                            return '#94a3b8';
                        })()}
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('settings');
                        }}
                    />
                    <ListDivider />
                    <OfficeRow
                        // A server, not the folded map the OBS tab uses:
                        // this row is the boat computer (UX scorecard run 6).
                        icon={
                            <span className="flex" style={{ color: HUB_ACCENT }}>
                                <ServerIcon className={HUB_ICON} />
                            </span>
                        }
                        label="Boat Network"
                        // Plain words, and not "instruments": the gateway row
                        // is the instruments one (UX scorecard run 7). "Boat
                        // computer", not "The Pi" (UX scorecard run 9).
                        status="Boat computer, charts & devices"
                        statusColor="#94a3b8"
                        onClick={() => {
                            triggerHaptic('light');
                            onNavigate('avnav');
                        }}
                    />
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
    // Shane 2026-09-07: "calypso is not the boat name. it is the internal pi
    // name. so maybe just shorten it to Pi" — the hostname never reaches the
    // punter's eye; every boat's Pi is "the Pi".

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
            ? 'This device publishes the boat’s position to your public voyage page.'
            : `${claim.deviceName} is publishing — last claimed ${claimAgeLabel(claim)}.`
        : 'No phone is primary yet — any signed-in phone can post the boat’s position to your public voyage page.';

    // The claim rides in user_settings, which is pulled from the cloud ONCE per
    // sign-in — so without this, a claim made on the other device is invisible
    // here until a cold restart, and BOTH devices read "This Device" (Shane,
    // 2026-08-01, iPhone + iPad). Refresh whenever the card appears; maxAgeMs 0
    // because the skipper is looking at exactly this answer right now.
    useEffect(() => {
        void refreshSkipperClaim({ maxAgeMs: 0 });
    }, []);
    // Shane 2026-09-06: "Release - this is not the Primary Device" / "Press to make this the Primary Device".
    // Same two meanings, in sentence case: the full-width capitals shouted over
    // the card's own status (UX referee 2026-09-26).
    // Signed out, a claim publishes nothing — only a signed-in device can — so
    // the button asks for the sign-in instead of offering a claim that would
    // quietly do nothing (UX scorecard run 6). Releasing a held claim still works.
    const signedIn = !!authenticatedUserId;
    const needsSignIn = !signedIn && !claimHeld;
    const [signInOpen, setSignInOpen] = useState(false);
    // "This phone", not "this … device" (UX scorecard run 7,
    // W-vessel-settings-copy): the status beside it already says "Primary:
    // this phone", and "the primary device" read as system jargon. "Primary"
    // is Shane's word and stays.
    // Signed out, the nudge says what signing in lets this phone do, not
    // "make this phone primary" (UX scorecard run 9, W-vessel-card-copy): a
    // skipper could not tell what "primary" did. Signed in, the claim keeps
    // Shane's word.
    const actionLabel = claimHeld
        ? 'Release — stop being primary'
        : needsSignIn
          ? 'Sign in to share position from this phone'
          : 'Make this phone primary';
    const [takeoverRequest, setTakeoverRequest] = useState<{
        scope: AuthIdentityScope;
        claim: SkipperClaim;
    } | null>(null);
    const actionInFlight = useRef(false);

    useEffect(() => {
        actionInFlight.current = false;
        setTakeoverRequest(null);
        setSignInOpen(false);
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
        (nextClaim: SkipperClaim | null) => {
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
        if (needsSignIn) {
            triggerHaptic('light');
            setSignInOpen(true);
            return;
        }
        triggerHaptic('medium');
        if (claimHeld) {
            // null, never undefined: the cloud patch is JSON, and an undefined
            // key is dropped on the wire — the release never left this phone,
            // so the other device kept seeing a claim nobody held (2026-09-08).
            applyClaim(null);
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
    }, [applyClaim, authenticatedUserId, claim, claimHeld, needsSignIn, takeoverRequest]);

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
            {/* The hub's own card surface (UX scorecard run 7,
                C-vessel-seven-accents): the teal border it wore unclaimed was a
                seventh accent on the screen. Emerald stays for the claim held,
                which is a state. mb-2 like every other hub card. */}
            <div
                data-testid="skipper-device-card"
                className={`mb-2 h-[calc(7rem_+_2px)] overflow-hidden px-3 py-2 ${
                    claimHeld ? 'shadow-[0_0_22px_-10px_rgba(52,211,153,0.45)]' : ''
                }`}
                style={claimHeld ? { ...GLASS.card, border: '1px solid rgba(52, 211, 153, 0.35)' } : GLASS.card}
            >
                {/* Shane 2026-09-06: the boat's name is the top line, the GPS
                    order is the next, the button says what pressing it does.
                    Fixed at 7rem + 2px with overflow-hidden (tests assert it): in
                    rem, like the rows inside it, so the fluid root (13-17 px) can
                    never clip the button on a Plus phone; py-2 and 7rem, not p-3
                    and 120 px, since UX scorecard run 8. So
                    every row has a fixed height and truncates, never wraps.

                    The top line carries no "PRIMARY DEVICE" label any more: in
                    capitals beside the boat's name it read as a status, so a
                    skipper saw "Primary device" on an unclaimed card and did
                    not press (UX referee 2026-09-26). The status is now said
                    in words on the second line instead. */}
                <div className="skipper-device-title mb-1.5 flex h-5 items-center gap-2">
                    {/* A hull, not the anchor text glyph: the anchor belongs to
                        the Anchor watch tile above (UX scorecard run 6). */}
                    <span aria-hidden="true" className="flex shrink-0 text-sky-300">
                        <SailBoatIcon className="h-4 w-4" />
                    </span>
                    {/* The card's title is its h2 (UX scorecard run 7,
                        A-hub-dup-music-nested-headings): it was plain text, so
                        the heading rotor skipped the card. Card-title white,
                        like every other hub card. */}
                    {vesselName ? (
                        <h2
                            data-testid="skipper-device-vessel"
                            title={vesselName}
                            className="min-w-0 flex-1 truncate text-[13px] font-black tracking-wide text-white"
                        >
                            {vesselName}
                        </h2>
                    ) : (
                        <h2 className="min-w-0 flex-1 truncate text-[13px] font-black tracking-wide text-white">
                            Your vessel
                        </h2>
                    )}
                    {piPrimary && (
                        <span className="shrink-0 text-[12px] font-bold text-emerald-300">Primary: the Pi</span>
                    )}
                </div>
                {/* The order the app believes GPS in: the boat's own receiver
                    (bus, or the Pi that holds it) when it is present, then this
                    device — or just this device when there is no boat GPS —
                    followed by who is primary, in words. The full sentence is
                    for screen readers; the short one is what fits.
                    With the Pi primary this row says nothing (Shane 2026-09-08:
                    "get rid of this device unless there is no pi") — the pill
                    below says it all. The row keeps its height so the card
                    never moves. */}
                <div className="skipper-device-gps mb-2 flex h-4 items-center gap-2">
                    {piPrimary && <p className="sr-only">{statusDescription}</p>}
                    {!piPrimary && (
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
                                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[12px] font-bold leading-none text-emerald-300">
                                        Boat GPS
                                    </span>
                                    <span
                                        aria-hidden="true"
                                        className="text-[12px] font-black leading-none text-gray-500"
                                    >
                                        ›
                                    </span>
                                </>
                            )}
                            {/* A predicate, not a bare "This device" (UX scorecard
                                run 8): alone, the chip says what it is the source
                                of; after the Boat GPS pill the chain says it. */}
                            <span
                                className={`rounded-full px-2 py-0.5 text-[12px] font-bold leading-none ${
                                    claimHeld ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-400/15 text-gray-300'
                                }`}
                            >
                                {vesselGpsLive ? 'This phone' : 'GPS: this phone'}
                            </span>
                        </span>
                    )}
                    {!piPrimary && (
                        <span
                            aria-hidden="true"
                            data-testid="skipper-device-status"
                            title={statusDescription}
                            className={`min-w-0 flex-1 truncate text-right text-[12px] font-bold leading-none ${
                                claim ? (claimHeld ? 'text-emerald-300' : 'text-amber-300') : 'text-slate-300'
                            }`}
                        >
                            {claim
                                ? claimHeld
                                    ? 'Primary: this phone'
                                    : `Primary: ${claim.deviceName} · ${claimAgeLabel(claim)}`
                                : // Plain words, not "No primary device yet" (UX
                                  // scorecard run 7). The whole sentence is in the
                                  // title and the sr-only line; beside the Boat GPS
                                  // pill this fixed one-line row has room for less,
                                  // and "Any phone can post" would drop the sign-in
                                  // a post needs, so the short form names the state
                                  // in the words of "Primary: this phone" instead.
                                  // Post WHAT is said (UX scorecard run 8), in the
                                  // width left beside "GPS: this phone" at 375 pt.
                                  // "Share", not the system word "post" (UX
                                  // scorecard run 9). Signed out, the button
                                  // under it already says "share position", so
                                  // this names the state instead of saying it
                                  // twice (UX scorecard run 10).
                                  vesselGpsLive || needsSignIn
                                  ? 'No primary phone yet'
                                  : 'Signed-in phones share position'}
                        </span>
                    )}
                    {!piPrimary && <p className="sr-only">{statusDescription}</p>}
                </div>
                {piPrimary ? (
                    <p
                        data-testid="skipper-device-pi-primary"
                        className="skipper-device-action flex h-11 w-full items-center justify-center overflow-hidden rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-2 text-center text-[13px] font-bold leading-tight text-emerald-300"
                    >
                        The Pi is the Primary Device
                    </p>
                ) : needsSignIn ? (
                    // The house secondary button in the hub's accent, not the
                    // filled primary (UX scorecard run 9, C-sign-in-cta-weight):
                    // a filled full-width bar made this nudge the loudest thing
                    // on the page, louder than MOB. The accent outline and text
                    // on the card's own fill still read as the way forward; the
                    // filled style is kept for real actions. h-11 and text-sm
                    // (about 13 px on the fluid root at 375 pt) keep it on one
                    // line inside the fixed-height card.
                    <Button
                        variant="secondary"
                        onClick={handleAction}
                        className="skipper-device-action h-11 w-full whitespace-nowrap text-sm!"
                        style={{
                            color: HUB_ACCENT,
                            borderColor: `color-mix(in srgb, ${HUB_ACCENT} 60%, transparent)`,
                            background: 'transparent',
                        }}
                    >
                        {actionLabel}
                    </Button>
                ) : (
                    <button
                        type="button"
                        onClick={handleAction}
                        aria-label={actionLabel}
                        className={`skipper-device-action h-11 w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-xl px-2 text-[13px] font-bold transition-colors active:brightness-110 ${
                            claimHeld ? 'bg-white/10 text-gray-300' : 'bg-sky-500/20 text-sky-300'
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
            {/* Portalled; closes itself once sign-in succeeds, after which the
                button offers the claim. */}
            {needsSignIn && (
                <SignInScreen
                    isOpen={signInOpen}
                    onClose={() => setSignInOpen(false)}
                    prompt="Sign in to share your boat’s position from this phone."
                />
            )}
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
                        {/* Spans, not h2s (UX scorecard run 7): a heading inside
                            a button is flattened into the button's name, and the
                            skipper card's title is the vessel's heading. */}
                        {vesselNameSet ? (
                            <span className="block text-lg font-black text-white tracking-tight truncate">
                                {vesselName}
                            </span>
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
                                <span className="text-lg font-black text-sky-300 tracking-tight truncate flex items-center gap-1">
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
                                </span>
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
                            color: daylightUiColor(state.color),
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
                    <span
                        className="text-[11px] font-bold uppercase tracking-widest"
                        style={{ color: daylightUiColor(state.color) }}
                    >
                        {state.label}
                    </span>
                </div>
            )}

            {/* Voyage row (tap → passage planning) */}
            {state.route && (
                <button
                    type="button"
                    onClick={handleVoyageTap}
                    aria-label="Open crew & float plan"
                    className="w-full flex items-center gap-2 px-4 py-1 active:opacity-70 transition-opacity text-left"
                >
                    <p className="text-[12px] font-semibold text-white/80 truncate flex-1">
                        {state.route}
                        {/* Which phone holds the Ship's Log for this passage
                            (authorship 2026-09-08) — only when it is not this one. */}
                        {voyage?.status === 'active' &&
                            voyage.recording_device_id &&
                            voyage.recording_device_id !== getDeviceId() && (
                                <span className="text-white/50" data-testid="hero-recording-elsewhere">
                                    {' · recording on '}
                                    {voyage.recording_device_name?.trim() || 'another device'}
                                </span>
                            )}
                    </p>
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
