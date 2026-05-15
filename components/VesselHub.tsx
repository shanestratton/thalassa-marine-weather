/**
 * VesselHub — Nav Station dashboard.
 *
 * Layout (top → bottom):
 *   Hero band:           vessel name · voyage state · position fix · time-since-fix
 *   Quick Actions:       6-tile 2-up grid — log book, diary, anchor, guardian, MOB, radio
 *   Passage Planning:    voyage prep + GPX import + Notices
 *   (Diary now lives inside Quick Actions — see the 6-tile grid above.)
 *   Inventory & Maint.:  Stores · Equipment · Repairs & Maintenance
 *   Reference:           Checklists · Polars · Documents
 *   Wardroom:            Music (Apple Music)
 *   Connect:             NMEA Gateway · Boat Network
 *   Account:             Settings + tier
 *
 * Recipe Library has moved to the Galley; keeping it in two places
 * confused users and the Galley is the natural home for it.
 */
import React, { useState, useEffect, useRef } from 'react';
import { AnchorWatchService } from '../services/AnchorWatchService';
import { ChatService } from '../services/ChatService';
import { useSettings } from '../context/SettingsContext';
import { useWeather } from '../context/WeatherContext';
import { triggerHaptic } from '../utils/system';
import { convertLength } from '../utils/units';
import { supabase } from '../services/supabase';
import { getPendingInviteCount, getMyCrew } from '../services/CrewService';
import { lazyRetry } from '../utils/lazyRetry';
import { GpsService, type GpsPosition } from '../services/GpsService';
import { getCachedActiveVoyage, type Voyage } from '../services/VoyageService';
const AdminPanel = lazyRetry(
    () => import('./AdminPanel').then((m) => ({ default: m.AdminPanel })),
    'AdminPanel_Vessel',
);

interface VesselHubProps {
    onNavigate: (page: string) => void;
    settings: Record<string, unknown>;
    onSave: (updates: Record<string, unknown>) => void;
}

// ── Glassmorphism constants ──
const GLASS = {
    card: {
        background: 'rgba(20, 25, 35, 0.6)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '16px',
    } as React.CSSProperties,
    listContainer: {
        background: 'rgba(20, 25, 35, 0.5)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: '16px',
        overflow: 'hidden' as const,
    } as React.CSSProperties,
};

// ── Bathymetric contour background SVG ──
const CONTOUR_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cdefs%3E%3Cpattern id='c' patternUnits='userSpaceOnUse' width='100' height='100'%3E%3Cpath d='M50 10 C60 25,85 30,90 50 C95 70,75 85,50 90 C25 95,10 75,10 50 C10 25,30 5,50 10Z' fill='none' stroke='rgba(100,140,180,0.04)' stroke-width='0.5'/%3E%3Cpath d='M50 25 C55 35,70 38,75 50 C80 62,68 72,50 75 C32 78,22 65,22 50 C22 35,38 28,50 25Z' fill='none' stroke='rgba(100,140,180,0.03)' stroke-width='0.5'/%3E%3C/pattern%3E%3C/defs%3E%3Crect width='400' height='400' fill='url(%23c)'/%3E%3C/svg%3E")`;

export const VesselHub: React.FC<VesselHubProps> = React.memo(({ onNavigate, settings, onSave: _onSave }) => {
    // ── Vessel state ──
    const { settings: ctx } = useSettings();
    const isObserver = (ctx as { vessel?: { type?: string } })?.vessel?.type === 'observer';

    // ── Anchor state ──
    const [anchorStatus, setAnchorStatus] = useState<'armed' | 'disarmed' | 'alarm'>('disarmed');
    const [anchorRadius, setAnchorRadius] = useState(0);
    const [showAdminPanel, setShowAdminPanel] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set(['quick', 'passage']));
    const [_isAdmin, setIsAdmin] = useState(false);

    // ── Hero band state — vessel name, active voyage, GPS fix, wind, network ──
    const rawVesselName = (ctx as { vessel?: { name?: string } })?.vessel?.name as string | undefined;
    const vesselName: string = rawVesselName || 'Your Vessel';
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
    const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

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

    // ── Trip-log state ──
    // The hero band's "Underway" pill shouldn't fire just because a
    // voyage row is marked status:active in the DB — that label means
    // "actively logging right now". Subscribe to ShipLogService for
    // live start/stop so a stale active voyage from a deleted route
    // can't show "Underway" with the boat sitting at the dock.
    const [tripLogActive, setTripLogActive] = useState<boolean>(false);

    useEffect(() => {
        let cancelled = false;
        let unsub: (() => void) | null = null;
        (async () => {
            try {
                const { ShipLogService } = await import('../services/ShipLogService');
                if (cancelled) return;
                unsub = ShipLogService.onTrackingStateChange((tracking, paused) => {
                    if (cancelled) return;
                    setTripLogActive(tracking && !paused);
                });
            } catch {
                /* ShipLogService unavailable — leave inactive */
            }
        })();
        return () => {
            cancelled = true;
            if (unsub) unsub();
        };
    }, []);

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
        // Also kick off a one-shot fetch so the hero band has data on
        // first render even if watchPosition has a slow first emit.
        GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 8 })
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

    // Online/offline indicator — boats lose connectivity. Show it.
    // Uses standard browser events; no @capacitor/network dep needed.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const goOnline = () => setIsOnline(true);
        const goOffline = () => setIsOnline(false);
        window.addEventListener('online', goOnline);
        window.addEventListener('offline', goOffline);
        return () => {
            window.removeEventListener('online', goOnline);
            window.removeEventListener('offline', goOffline);
        };
    }, []);

    // If WeatherContext has no data yet (user landed on Nav Station
    // first, before the Dashboard auto-fetched), kick off a fetch via
    // the shared orchestrator using our GPS position. This populates
    // the SAME cache the Glass page reads — no parallel pipeline.
    // Refreshes are handled by the orchestrator's schedule (already
    // running in WeatherContext); we don't poll here.
    useEffect(() => {
        if (weatherData) return; // already populated — orchestrator handles refresh
        if (!position || !isOnline) return;
        // Round to 0.1° to dedupe near-identical re-renders.
        const lat = Math.round(position.latitude * 10) / 10;
        const lon = Math.round(position.longitude * 10) / 10;
        // silent=true so the orchestrator doesn't show a loading
        // overlay — the Nav Station hero chips just stay empty until
        // the data lands.
        fetchWeather('Current Position', false, { lat, lon }, false, true).catch(() => {
            /* offline — chips stay empty */
        });
    }, [
        weatherData,
        position && Math.round(position.latitude * 10),
        position && Math.round(position.longitude * 10),
        isOnline,
        fetchWeather,
    ]);

    const toggleSection = (id: string) => {
        triggerHaptic('light');
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // Load admin role async
    useEffect(() => {
        ChatService.initialize()
            .then(() => {
                setIsAdmin(ChatService.isAdmin());
            })
            .catch(() => {
                // Non-critical — admin check is best-effort
            });
    }, []);

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

    // ── Crew invite badge ──
    const [pendingCrewInvites, setPendingCrewInvites] = useState(0);
    useEffect(() => {
        if (!supabase) return;
        supabase.auth.getUser().then(({ data }) => {
            if (data.user) {
                getPendingInviteCount().then(setPendingCrewInvites);
            }
        });
    }, []);

    // ── Live tile state — entries today, suggested/actual track counts, guardian, maintenance overdue ──
    const [entriesToday, setEntriesToday] = useState<number | null>(null);
    // Suggested/Actual track counts for the Log Book tile —
    // sourced from RoutesAndTracks (planned_* voyageIds vs everything
    // else). Refetches whenever a route is saved or a voyage deleted
    // (window event from invalidateRoutesAndTracks).
    const [routeCount, setRouteCount] = useState<number | null>(null);
    const [trackCount, setTrackCount] = useState<number | null>(null);
    const [guardianArmed, setGuardianArmed] = useState<boolean>(false);
    const [guardianNearby, setGuardianNearby] = useState<number>(0);
    const [overdueCount, setOverdueCount] = useState<number>(0);
    const [expiringDocsCount, setExpiringDocsCount] = useState<number>(0);
    const [expiringEquipCount, setExpiringEquipCount] = useState<number>(0);

    useEffect(() => {
        // Entries logged today (current voyage or any voyage). Source
        // of truth is ship_logs; we just need a count of entries
        // whose timestamp is on the current local day.
        let cancelled = false;
        (async () => {
            try {
                const { getLogEntries } = await import('../services/shiplog/EntryCrud');
                const entries = await getLogEntries(200);
                if (cancelled) return;
                // Compare by LOCAL calendar day, not ms-since-epoch
                // cutoff. The previous version used `setHours(0,0,0,0)`
                // which is correct local midnight — but a ship_log
                // timestamp stored as bare ISO (no timezone marker)
                // can be parsed as UTC by `Date.parse`, and an entry
                // made yesterday 23:30 AEST (= UTC 13:30 same day)
                // can then look like today UTC and incorrectly pass
                // `>= localMidnight`. Comparing year/month/day strings
                // sidesteps the parse ambiguity entirely: an entry
                // counts as "today" only if its rendered calendar date
                // matches today's calendar date.
                const today = new Date();
                const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
                const todays = entries.filter((e) => {
                    const d = new Date(e.timestamp);
                    if (Number.isNaN(d.getTime())) return false;
                    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey;
                }).length;
                setEntriesToday(todays);
            } catch {
                /* offline — leave null */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        // Suggested + Actual track counts for the Log Book
        // tile. Source of truth is RoutesAndTracks:
        //   routes  → planned_* voyageIds  (suggested / not yet sailed)
        //   tracks  → every other voyageId (actual / sailed passages)
        //
        // Dynamic: re-fetches on the `routes-and-tracks-changed`
        // window event (fired by invalidateRoutesAndTracks() from
        // PassagePlanSave + EntryCrud.deleteVoyage), and again when
        // the page becomes visible (skipper backgrounded the app and
        // came back). No polling.
        let cancelled = false;

        const refetch = async () => {
            try {
                const { fetchRoutesAndTracks } = await import('../services/shiplog/RoutesAndTracks');
                // Force=true bypasses the 60s cache so a delete reflects
                // immediately rather than waiting up to a minute.
                const data = await fetchRoutesAndTracks(true);
                if (cancelled) return;
                setRouteCount(data.routes.length);
                setTrackCount(data.tracks.length);
            } catch {
                /* offline — leave nulls so the tile shows the CTA */
            }
        };

        refetch();

        const onChanged = () => {
            void refetch();
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') void refetch();
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('thalassa:routes-and-tracks-changed', onChanged);
            document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
            cancelled = true;
            if (typeof window !== 'undefined') {
                window.removeEventListener('thalassa:routes-and-tracks-changed', onChanged);
                document.removeEventListener('visibilitychange', onVisibility);
            }
        };
    }, []);

    useEffect(() => {
        // Subscribe to Guardian for live armed-state + nearby-count.
        let cancelled = false;
        let unsub: (() => void) | null = null;
        (async () => {
            try {
                const { GuardianService } = await import('../services/GuardianService');
                unsub = GuardianService.subscribe((state) => {
                    if (cancelled) return;
                    setGuardianArmed(!!state.armed);
                    setGuardianNearby(state.nearbyCount || 0);
                });
            } catch {
                /* Guardian not available */
            }
        })();
        return () => {
            cancelled = true;
            if (unsub) unsub();
        };
    }, []);

    // ── Live counts for Inventory & Maintenance row badges ──
    //
    // Maintenance overdue / Documents expiring / Equipment warranty
    // counts all need to update the moment the user changes
    // something elsewhere (ticks off a service, edits a document,
    // adds equipment) — the user reported "1 Overdue" still showing
    // after they ticked the task off, because these effects only
    // ran on mount.
    //
    // Each fetch listens for its own data-change window event (fired
    // from the corresponding service's mutations) AND for
    // visibilitychange (so backgrounding + returning re-validates
    // even when changes happened on another device). Combined Maint
    // + Doc + Equip refetch in one effect to keep teardown clean.
    useEffect(() => {
        let cancelled = false;

        const refetchMaintenance = async () => {
            try {
                // Pull from BOTH sources — local cache (offline-first
                // primary) AND cloud — so the count reflects whichever
                // store has the freshest state. Local mutations fire
                // the event immediately; cloud-only mutations lag but
                // catch up on the visibility tick.
                const [{ LocalMaintenanceService }, { MaintenanceService }] = await Promise.all([
                    import('../services/vessel/LocalMaintenanceService'),
                    import('../services/MaintenanceService'),
                ]);
                if (cancelled) return;

                const localTasks = LocalMaintenanceService.getTasks();
                let cloudTasks: typeof localTasks = [];
                try {
                    cloudTasks = await MaintenanceService.getTasks();
                } catch {
                    /* offline — local-only count */
                }

                // Merge by id; cloud wins on conflict (server is
                // canonical for serviced/unserviced state once synced).
                const merged = new Map<string, (typeof localTasks)[number]>();
                for (const t of localTasks) merged.set(t.id, t);
                for (const t of cloudTasks) merged.set(t.id, t);

                const now = Date.now();
                const overdue = Array.from(merged.values()).filter(
                    (t) => t.is_active && t.next_due_date && Date.parse(t.next_due_date) < now,
                ).length;
                if (!cancelled) setOverdueCount(overdue);
            } catch {
                /* both sources unavailable — leave previous count */
            }
        };

        const refetchDocs = async () => {
            try {
                const { LocalDocumentService } = await import('../services/vessel/LocalDocumentService');
                const docs = LocalDocumentService.getAll();
                if (cancelled) return;
                const cutoff = Date.now() + 30 * 86_400_000;
                const expiring = docs.filter((d) => d.expiry_date && Date.parse(d.expiry_date) <= cutoff).length;
                setExpiringDocsCount(expiring);
            } catch {
                /* offline — no badge */
            }
        };

        const refetchEquip = async () => {
            try {
                const { LocalEquipmentService } = await import('../services/vessel/LocalEquipmentService');
                const items = LocalEquipmentService.getAll();
                if (cancelled) return;
                const cutoff = Date.now() + 30 * 86_400_000;
                const expiring = items.filter(
                    (e) => e.warranty_expiry && Date.parse(e.warranty_expiry) <= cutoff,
                ).length;
                setExpiringEquipCount(expiring);
            } catch {
                /* offline — no badge */
            }
        };

        // Initial fetch.
        void refetchMaintenance();
        void refetchDocs();
        void refetchEquip();

        // Per-source listeners — fire only when their data changes.
        const onMaintenance = () => void refetchMaintenance();
        const onDocs = () => void refetchDocs();
        const onEquip = () => void refetchEquip();

        // Visibility change refetches everything in case the user
        // mutated state in a different tab / from a synced device.
        const onVisibility = () => {
            if (document.visibilityState !== 'visible') return;
            void refetchMaintenance();
            void refetchDocs();
            void refetchEquip();
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('thalassa:maintenance-changed', onMaintenance);
            window.addEventListener('thalassa:documents-changed', onDocs);
            window.addEventListener('thalassa:equipment-changed', onEquip);
            document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
            cancelled = true;
            if (typeof window !== 'undefined') {
                window.removeEventListener('thalassa:maintenance-changed', onMaintenance);
                window.removeEventListener('thalassa:documents-changed', onDocs);
                window.removeEventListener('thalassa:equipment-changed', onEquip);
                document.removeEventListener('visibilitychange', onVisibility);
            }
        };
    }, []);

    // ── Draft passage plans ──
    const [passageCrewCount, setPassageCrewCount] = useState(0);
    useEffect(() => {
        getMyCrew().then((c) => {
            // Crew count from vessel settings
            let settingsCount = 2;
            try {
                const raw = localStorage.getItem('CapacitorStorage.thalassa_settings');
                if (raw) {
                    const s = JSON.parse(raw);
                    if (s?.vessel?.crewCount) settingsCount = s.vessel.crewCount;
                }
            } catch {
                /* ignore */
            }
            // max(settings count, actual crew + captain)
            const actualWithCaptain = c.length + 1;
            setPassageCrewCount(Math.max(settingsCount, actualWithCaptain));
        });
    }, []);

    // ── Anchor display ──
    // anchorRadius comes from `snapshot.swingRadius`, which is computed
    // via Math.sqrt(rodeLength² - waterDepth²) * sensor-type factor —
    // i.e. naturally a long float. Clamp to 1 decimal so the nav-station
    // card reads "Armed — 50.0m" instead of "Armed — 50.000000000004m".
    const anchorLabel =
        anchorStatus === 'alarm'
            ? '⚠️ DRAG ALARM'
            : anchorStatus === 'armed'
              ? `Armed — ${anchorRadius.toFixed(1)}m`
              : 'Disarmed';
    const anchorColor = anchorStatus === 'alarm' ? '#ef4444' : anchorStatus === 'armed' ? '#22d3ee' : '#9ca3af';

    return (
        <div
            className="w-full h-full flex flex-col animate-in fade-in duration-300 vessel-hub-no-scrollbar"
            style={{
                paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                backgroundImage: CONTOUR_BG,
                backgroundSize: '400px 400px',
            }}
        >
            {/* Scrollable content area */}
            <div className="flex-1 min-h-0 overflow-y-auto vessel-hub-no-scrollbar px-4 pt-4 stagger-in">
                {/* ═══════════════════════════════════════════ */}
                {/* HERO BAND — situational awareness           */}
                {/* Vessel · voyage state · last fix            */}
                {/* ═══════════════════════════════════════════ */}
                <NavStationHero
                    vesselName={vesselName}
                    vesselNameSet={vesselNameSet}
                    voyage={activeVoyage}
                    tripLogActive={tripLogActive}
                    position={position}
                    anchorStatus={anchorStatus}
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

                {/* ═══════════════════════════════════════════ */}
                {/* PASSAGE PLANNING — promoted to top of hub   */}
                {/* (was beneath Quick Actions, swapped with    */}
                {/*  the search bar to make it the primary       */}
                {/*  entry point on Nav Station.)                */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionHeader
                        color="#8b5cf6"
                        label="Passage Planning"
                        id="passage"
                        expanded={expanded.has('passage')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('passage')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<CrewIcon color="#8b5cf6" />}
                                label="Passage Planning"
                                status={
                                    passageCrewCount > 0
                                        ? `${passageCrewCount} crew`
                                        : pendingCrewInvites > 0
                                          ? `${pendingCrewInvites} Pending`
                                          : 'Plan Your Voyage'
                                }
                                statusColor={pendingCrewInvites > 0 ? '#f59e0b' : '#8b5cf6'}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('crew');
                                }}
                                badge={pendingCrewInvites > 0 ? pendingCrewInvites : undefined}
                            />
                            <OfficeRow
                                icon={<GpxIcon color="#10b981" />}
                                label="Import GPX"
                                status="OpenCPN • Navionics"
                                statusColor="#10b981"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('gpx-import');
                                }}
                            />
                        </div>
                    </CollapsibleContent>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* SECTIONS                                    */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionHeader
                        color="#ef4444"
                        label="Quick Actions"
                        id="quick"
                        expanded={expanded.has('quick')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('quick')}>
                        {/* Row 1 — Log Book + Route Planner */}
                        <div className="grid grid-cols-2 gap-3 mb-3">
                            <button
                                aria-label="Open log book"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('details');
                                }}
                                style={GLASS.card}
                                className="p-4 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98] card-lift"
                            >
                                <div className="flex items-center gap-3">
                                    <div
                                        className="p-2.5 rounded-lg"
                                        style={{ background: 'rgba(14, 165, 233, 0.12)' }}
                                    >
                                        <BookIcon color="#0ea5e9" />
                                    </div>
                                    {/* Log Book shows both counts on one line:
                                                  N PLAN  = saved suggested routes (not yet sailed)
                                                  N SAIL  = actually-logged tracks
                                                Tracking is `wide` (not `widest`) so 2-digit
                                                counts still fit inside the half-grid tile on
                                                a small phone — `tracking-widest` blew past
                                                the card edge. min-w-0 + truncate are belt &
                                                suspenders if a future change pushes the
                                                length out further. */}
                                    <div className="min-w-0 flex-1">
                                        <h4 className="text-[13px] font-black text-white tracking-wide truncate">
                                            Log Book
                                        </h4>
                                        <p className="text-[11px] font-bold uppercase tracking-wide text-sky-400 mt-0.5 tabular-nums truncate">
                                            {(() => {
                                                const r = routeCount ?? 0;
                                                const t = trackCount ?? 0;
                                                if (r === 0 && t === 0) {
                                                    return entriesToday !== null && entriesToday > 0
                                                        ? `${entriesToday} Today`
                                                        : 'Log Entry';
                                                }
                                                if (r === 0) return `${t} Sail`;
                                                if (t === 0) return `${r} Plan`;
                                                return `${r} Plan · ${t} Sail`;
                                            })()}
                                        </p>
                                    </div>
                                </div>
                            </button>

                            {/* Route Planner moved into the Passage Planning
                                        page (top of the readiness panel) so the
                                        skipper plans a route + crew + provisioning in
                                        one funnel. The slot here is now Diary —
                                        promoted out of its own single-item section
                                        into Quick Actions where it sits alongside
                                        the Log Book as the "open it daily" pair. */}
                            <button
                                aria-label="Diary"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('diary');
                                }}
                                style={GLASS.card}
                                className="p-4 text-left transition-all active:scale-[0.98] card-lift hover:bg-white/[0.03]"
                            >
                                <div className="flex items-center gap-3">
                                    <div
                                        className="p-2.5 rounded-lg"
                                        style={{ background: 'rgba(14, 165, 233, 0.12)' }}
                                    >
                                        <PenIcon color="#0ea5e9" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h4 className="text-[13px] font-black text-white tracking-wide truncate">
                                            Diary
                                        </h4>
                                        <p className="text-[11px] font-bold uppercase tracking-widest mt-0.5 text-sky-400">
                                            Daily Notes
                                        </p>
                                    </div>
                                </div>
                            </button>
                        </div>

                        {/* Row 2 — Anchor Watch + Guardian */}
                        <div className="grid grid-cols-2 gap-3 mb-3">
                            <button
                                aria-label="Anchor Watch"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('compass');
                                }}
                                style={GLASS.card}
                                className="p-4 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98] card-lift"
                            >
                                <div className="flex items-center gap-3">
                                    <div
                                        className="p-2.5 rounded-lg flex items-center justify-center"
                                        style={{ background: `${anchorColor}1f` }}
                                    >
                                        <div
                                            className="w-3 h-3 rounded-full"
                                            style={{
                                                backgroundColor: anchorColor,
                                                boxShadow:
                                                    anchorStatus !== 'disarmed' ? `0 0 8px ${anchorColor}60` : 'none',
                                                animation: anchorStatus === 'alarm' ? 'pulse 1s infinite' : 'none',
                                            }}
                                        />
                                    </div>
                                    <div>
                                        <h4 className="text-[13px] font-black text-white tracking-wide">
                                            Anchor Watch
                                        </h4>
                                        <p
                                            className="text-[11px] font-bold uppercase tracking-widest mt-0.5"
                                            style={{ color: anchorColor }}
                                        >
                                            {anchorLabel}
                                        </p>
                                    </div>
                                </div>
                            </button>

                            <button
                                aria-label="Open Guardian bay watch"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('guardian');
                                }}
                                style={GLASS.card}
                                className="p-4 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98] card-lift"
                            >
                                <div className="flex items-center gap-3">
                                    <div
                                        className="p-2.5 rounded-lg"
                                        style={{ background: 'rgba(245, 158, 11, 0.12)' }}
                                    >
                                        <ShieldIcon color="#f59e0b" />
                                    </div>
                                    <div>
                                        <h4 className="text-[13px] font-black text-white tracking-wide">Guardian</h4>
                                        <p
                                            className="text-[11px] font-bold uppercase tracking-widest mt-0.5"
                                            style={{ color: guardianArmed ? '#10b981' : '#f59e0b' }}
                                        >
                                            {guardianArmed
                                                ? guardianNearby > 0
                                                    ? `Watching · ${guardianNearby} nearby`
                                                    : 'Watching'
                                                : 'Bay Safety'}
                                        </p>
                                    </div>
                                </div>
                            </button>
                        </div>

                        {/* Row 3 — MOB + Radio Report */}
                        <div className="grid grid-cols-2 gap-3">
                            <button
                                aria-label="Man Overboard"
                                onClick={() => {
                                    triggerHaptic('heavy');
                                    onNavigate('mob');
                                }}
                                style={{
                                    ...GLASS.card,
                                    background:
                                        'linear-gradient(135deg, rgba(239,68,68,0.18) 0%, rgba(20,25,35,0.6) 100%)',
                                    borderColor: 'rgba(239,68,68,0.35)',
                                }}
                                className="p-4 text-left hover:brightness-110 transition-all active:scale-[0.98] card-lift"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="p-2.5 rounded-lg" style={{ background: 'rgba(239, 68, 68, 0.18)' }}>
                                        <MobIcon color="#ef4444" />
                                    </div>
                                    <div>
                                        <h4 className="text-[13px] font-black text-white tracking-wide">MOB</h4>
                                        <p className="text-[11px] font-bold uppercase tracking-widest text-red-400 mt-0.5">
                                            Person Overboard
                                        </p>
                                    </div>
                                </div>
                            </button>

                            <button
                                aria-label="Open radio position reporting"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('radio');
                                }}
                                style={GLASS.card}
                                className="p-4 text-left hover:bg-white/[0.03] transition-all active:scale-[0.98] card-lift"
                            >
                                <div className="flex items-center gap-3">
                                    <div
                                        className="p-2.5 rounded-lg"
                                        style={{ background: 'rgba(245, 158, 11, 0.12)' }}
                                    >
                                        <SignalIcon color="#f59e0b" />
                                    </div>
                                    <div>
                                        <h4 className="text-[13px] font-black text-white tracking-wide">
                                            Radio Report
                                        </h4>
                                        <p className="text-[11px] font-bold uppercase tracking-widest text-amber-400 mt-0.5">
                                            Position Broadcast
                                        </p>
                                    </div>
                                </div>
                            </button>
                        </div>
                    </CollapsibleContent>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* DIARY — personal journal                    */}
                {/* (voyage log entries live in Quick Actions)  */}
                {/* Diary section removed — Diary moved into the Quick
                            Actions grid alongside the Log Book. Single-row
                            sections were costing a section header for very
                            little, and Diary's natural pair is the Log Book
                            (one is for navigation, one is for journal — both
                            "open daily"). */}

                {/* ═══════════════════════════════════════════ */}
                {/* INVENTORY & MAINTENANCE                     */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionHeader
                        color="#f59e0b"
                        label="Inventory & Maintenance"
                        id="inventory"
                        expanded={expanded.has('inventory')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('inventory')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<BoxIcon color="#f59e0b" />}
                                label="Ship's Stores"
                                status="Provisions & Spares"
                                statusColor="#f59e0b"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('inventory');
                                }}
                            />
                            <ListDivider />
                            <OfficeRow
                                icon={<ClipboardIcon color="#ef4444" />}
                                label="Equipment"
                                status={expiringEquipCount > 0 ? `${expiringEquipCount} Warranty Soon` : 'Register'}
                                statusColor={expiringEquipCount > 0 ? '#f59e0b' : '#ef4444'}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('equipment');
                                }}
                                badge={expiringEquipCount > 0 ? expiringEquipCount : undefined}
                            />
                            <ListDivider />
                            <OfficeRow
                                icon={<WrenchIcon color={overdueCount > 0 ? '#ef4444' : '#0ea5e9'} />}
                                label="Repairs & Maintenance"
                                status={overdueCount > 0 ? `${overdueCount} Overdue` : 'Tasks & Expiry'}
                                statusColor={overdueCount > 0 ? '#ef4444' : '#0ea5e9'}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('maintenance');
                                }}
                                badge={overdueCount > 0 ? overdueCount : undefined}
                                badgeUrgent={overdueCount > 0}
                            />
                        </div>
                    </CollapsibleContent>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* REFERENCE                                   */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionHeader
                        color="#22d3ee"
                        label="Reference"
                        id="reference"
                        expanded={expanded.has('reference')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('reference')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<ChecklistIcon color="#22d3ee" />}
                                label="Checklists"
                                status="Safety & Passage"
                                statusColor="#22d3ee"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('checklists');
                                }}
                            />
                            <ListDivider />
                            <OfficeRow
                                icon={<ChartIcon color="#22d3ee" />}
                                label="Polars"
                                status={isObserver ? 'Vessel Required' : 'Tuning'}
                                statusColor={isObserver ? '#6b7280' : '#22d3ee'}
                                onClick={() => {
                                    if (isObserver) return;
                                    triggerHaptic('light');
                                    onNavigate('polars');
                                }}
                                disabled={isObserver}
                            />
                            <ListDivider />
                            <OfficeRow
                                icon={<DocShieldIcon color={expiringDocsCount > 0 ? '#ef4444' : '#0ea5e9'} />}
                                label="Documents"
                                status={expiringDocsCount > 0 ? `${expiringDocsCount} Expiring` : 'Legal'}
                                statusColor={expiringDocsCount > 0 ? '#ef4444' : '#0ea5e9'}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('documents');
                                }}
                                badge={expiringDocsCount > 0 ? expiringDocsCount : undefined}
                                badgeUrgent={expiringDocsCount > 0}
                            />
                            <ListDivider />
                            <OfficeRow
                                icon={<NoticeIcon color="#ef4444" />}
                                label="Notices to Mariners"
                                status="NAVAREA • HYDRO"
                                statusColor="#ef4444"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('notices');
                                }}
                            />
                        </div>
                    </CollapsibleContent>
                </div>

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
                <div className="mb-4">
                    <SectionHeader
                        color="#f472b6"
                        label="Wardroom"
                        id="wardroom"
                        expanded={expanded.has('wardroom')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('wardroom')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<MusicNoteIcon color="#f472b6" />}
                                label="Music"
                                status="Apple Music"
                                statusColor="#f472b6"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('music');
                                }}
                            />
                        </div>
                    </CollapsibleContent>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* CONNECT — instruments, AIS, charts          */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-4">
                    <SectionHeader
                        color="#a855f7"
                        label="Connect"
                        id="connect"
                        expanded={expanded.has('connect')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('connect')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<SignalIcon color="#a855f7" />}
                                label="NMEA Gateway"
                                status="Instruments & AIS"
                                statusColor="#a855f7"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('nmea');
                                }}
                            />
                            <ListDivider />
                            <OfficeRow
                                icon={<MapChartIcon color="#22d3ee" />}
                                label="Boat Network"
                                status="Pi & Charts"
                                statusColor="#22d3ee"
                                onClick={() => {
                                    triggerHaptic('light');
                                    onNavigate('avnav');
                                }}
                            />
                        </div>
                    </CollapsibleContent>
                </div>

                {/* ═══════════════════════════════════════════ */}
                {/* SECTION D: ACCOUNT — Settings only         */}
                {/* ═══════════════════════════════════════════ */}
                <div className="mb-6">
                    <SectionHeader
                        color="#9ca3af"
                        label="Account"
                        id="account"
                        expanded={expanded.has('account')}
                        onToggle={toggleSection}
                    />
                    <CollapsibleContent open={expanded.has('account')}>
                        <div style={GLASS.listContainer}>
                            <OfficeRow
                                icon={<UserIcon color="#9ca3af" />}
                                label="Account & Settings"
                                status={(() => {
                                    const tier = (settings as Record<string, unknown>).subscriptionTier as string;
                                    if (tier === 'owner') return 'Vessel Owner';
                                    if (tier === 'crew') return 'Crew Plan';
                                    return 'Free Plan';
                                })()}
                                statusColor={(() => {
                                    const tier = (settings as Record<string, unknown>).subscriptionTier as string;
                                    if (tier === 'owner') return '#f59e0b';
                                    if (tier === 'crew') return '#22d3ee';
                                    return '#9ca3af';
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

            {/* Admin Panel Modal */}
            <AdminPanel isOpen={showAdminPanel} onClose={() => setShowAdminPanel(false)} />
        </div>
    );
});

// ══════════════════════════════════════
// ── Shared Components ──
// ══════════════════════════════════════

/** Collapsible section header with colored pip and chevron.
 *  Tap target: min-h-[44px] meets Apple HIG minimum so wet-handed
 *  taps on a heeled boat actually hit. The previous py-1 was ~24pt
 *  and missed half the time. */
const SectionHeader: React.FC<{
    color: string;
    label: string;
    id: string;
    expanded: boolean;
    onToggle: (id: string) => void;
}> = ({ color, label, id, expanded, onToggle }) => {
    const buttonRef = useRef<HTMLButtonElement>(null);
    return (
        <button
            ref={buttonRef}
            onClick={() => {
                const wasExpanded = expanded;
                triggerHaptic('light');
                onToggle(id);
                // When opening a section that sits low on the page (Account,
                // Connect, etc.), the newly-revealed card otherwise lands
                // behind the bottom tab bar. Snap the section so its bottom
                // edge aligns with the scroll container's bottom — which
                // already sits above the tab bar thanks to the wrapper's
                // bottom padding. Wait 280 ms for the 250 ms collapse
                // animation to finish so we scroll to the FINAL height.
                if (!wasExpanded) {
                    setTimeout(() => {
                        const section = buttonRef.current?.parentElement;
                        section?.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
                    }, 280);
                }
            }}
            className="w-full flex items-center gap-2.5 mb-2 py-3 min-h-[44px] active:opacity-70 transition-opacity"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
        >
            <div className="w-1.5 h-4 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-xs font-black uppercase tracking-[0.2em] flex-1 text-left" style={{ color }}>
                {label}
            </span>
            <svg
                className="w-4 h-4 transition-transform duration-200"
                style={{
                    color,
                    opacity: 0.6,
                    transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
            >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
        </button>
    );
};

// ══════════════════════════════════════
// ── NavStationHero — situational-awareness band ──
// ══════════════════════════════════════

/** Format a relative time like "2 min ago" / "just now" / "1 hr ago". */
function formatTimeSince(ts: number | null): string {
    if (!ts) return 'no fix';
    const delta = Date.now() - ts;
    if (delta < 30_000) return 'just now';
    if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
    if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} hr ago`;
    return `${Math.round(delta / 86_400_000)} d ago`;
}

/** Format a coordinate as "27.4673°S 153.1234°E" (degrees + cardinal). */
function formatCoord(lat: number, lon: number): string {
    const latStr = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    return `${latStr}  ${lonStr}`;
}

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
): { label: string; color: string; route?: string } {
    if (anchorStatus === 'alarm') return { label: 'Drag Alarm', color: '#ef4444' };

    if (anchorStatus === 'armed') {
        const route =
            voyage && voyage.departure_port && voyage.destination_port
                ? `${voyage.departure_port} → ${voyage.destination_port}`
                : undefined;
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
            voyage && voyage.departure_port && voyage.destination_port
                ? `${voyage.departure_port} → ${voyage.destination_port}`
                : voyage?.voyage_name || undefined;
        return { label: 'Underway', color: '#10b981', route };
    }

    if (voyage && voyage.status === 'planning') {
        const route =
            voyage.departure_port && voyage.destination_port
                ? `${voyage.departure_port} → ${voyage.destination_port}`
                : voyage.voyage_name || 'Drafted';
        return { label: 'Drafted', color: '#8b5cf6', route };
    }

    return { label: 'At Rest', color: '#9ca3af' };
}

/** Format a duration in milliseconds to a compact "5h 23m" / "23m" / "1d 4h". */
function formatDuration(ms: number): string {
    if (ms <= 0) return 'now';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `${min}m`;
    const hrs = Math.floor(min / 60);
    const remMin = min % 60;
    if (hrs < 24) return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

/** Map a pressure trend to an indicator (arrow + colour). */
function pressureTrendIndicator(trend: 'rising' | 'falling' | 'steady' | null): {
    arrow: string;
    color: string;
    label: string;
} | null {
    if (!trend || trend === 'steady') return null;
    if (trend === 'rising') return { arrow: '↑', color: '#10b981', label: 'rising' };
    return { arrow: '↓', color: '#f59e0b', label: 'falling' };
}

/** Metric chip data — single source of truth for what a chip renders.
 *  Either icon+value (wind, wave, temp, visibility) OR label+value
 *  (BAR ↑, TIDE ↓ — trend indicators with no numeric value). */
interface MetricChipData {
    key: string;
    icon?: string;
    label?: string;
    value: string;
    unit?: string;
    suffix?: string;
    color?: string;
    ariaLabel?: string;
}

/** Compact icon-and-metric chip used on the hero band's environmental
 *  strip. Tabular-num alignment + monospace so a row of chips reads
 *  like a row of instrument readouts. */
const MetricChip: React.FC<MetricChipData> = ({ icon, label, value, unit, suffix, color, ariaLabel }) => (
    <span
        className="inline-flex items-center gap-1 font-mono tabular-nums whitespace-nowrap text-[11px] leading-none"
        style={color ? { color } : undefined}
        aria-label={ariaLabel}
        title={ariaLabel}
    >
        {icon && <span className="text-[12px] leading-none">{icon}</span>}
        {label && <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>}
        <span className={color ? 'font-bold text-base leading-none' : 'text-white/85'}>{value}</span>
        {unit && <span className="text-[10px] text-white/40">{unit}</span>}
        {suffix && <span className="text-[10px] text-white/60 ml-0.5">{suffix}</span>}
    </span>
);

/** A flex-wrap strip of MetricChips, distributed evenly across the
 *  row. Renders nothing when empty so we don't draw a hairline border
 *  for no payload. The optional top border slots in only when the
 *  row above isn't already drawing one (i.e. when SOG/COG isn't
 *  present).
 *
 *  Layout: `justify-between` on the parent spreads chips edge-to-edge
 *  across the available width — wind on the far left, tide on the
 *  far right — instead of clumping to the left as a left-justified
 *  row. When too many chips fit and they wrap, the second row
 *  distributes the same way. */
const MetricChipStrip: React.FC<{ chips: MetricChipData[]; showTopBorder?: boolean }> = ({ chips, showTopBorder }) => {
    if (chips.length === 0) return null;
    return (
        <div
            className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-4 pt-1.5 pb-3 ${
                showTopBorder ? 'border-t border-white/[0.06]' : ''
            }`}
        >
            {chips.map((chip) => (
                <MetricChip {...chip} key={chip.key} />
            ))}
        </div>
    );
};

/** Anchor swing arc — circular SVG showing the alarm radius AND
 *  the vessel's actual position relative to the anchor point.
 *
 *  Pass 4 had a static "swing radius circle". Pass 5 plots the
 *  vessel dot at its real bearing/offset — so a skipper glancing
 *  at the hero band can see "I'm at 35m to the south-east, my
 *  alarm is at 50m". The arc speaks the same language as a real
 *  electronic anchor display.
 *
 *  - Center cross   = anchor point
 *  - Outer dashed   = alarm radius (pre-set swing)
 *  - Inner faint    = ½ alarm radius reference
 *  - Vessel dot     = current position (bearing + offset)
 *  - Track line     = anchor → vessel (visual indicator of drift)
 *  - On alarm: whole arc pulses red. */
const SwingArc: React.FC<{
    radiusM: number;
    offsetM: number;
    bearingDeg: number;
    alarm: boolean;
}> = ({ radiusM, offsetM, bearingDeg, alarm }) => {
    const size = 44;
    const cx = size / 2;
    const cy = size / 2;
    const ringR = size / 2 - 3;
    const color = alarm ? '#ef4444' : '#22d3ee';

    // Plot vessel: bearing 0° = north (top of arc). Map polar
    // (bearing, ratio) → cartesian. Clamp ratio just past 1 so a
    // dragging boat visibly sits beyond the alarm ring.
    const safeRadius = Math.max(radiusM, 1);
    const ratio = Math.min(offsetM / safeRadius, 1.05);
    const r = ringR * ratio;
    const angleRad = ((bearingDeg - 90) * Math.PI) / 180;
    const vx = cx + r * Math.cos(angleRad);
    const vy = cy + r * Math.sin(angleRad);

    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {/* Alarm boundary ring (dashed) */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={ringR}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.45}
                    strokeWidth={1.25}
                    strokeDasharray="2 3"
                />
                {/* Inner reference ring at ½ alarm radius */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={ringR * 0.5}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.22}
                    strokeWidth={1}
                />
                {/* Anchor — center cross */}
                <line x1={cx - 2.5} y1={cy} x2={cx + 2.5} y2={cy} stroke={color} strokeOpacity={0.7} strokeWidth={1} />
                <line x1={cx} y1={cy - 2.5} x2={cx} y2={cy + 2.5} stroke={color} strokeOpacity={0.7} strokeWidth={1} />
                {/* Track line from anchor to vessel */}
                {offsetM > 1 && (
                    <line x1={cx} y1={cy} x2={vx} y2={vy} stroke={color} strokeOpacity={0.4} strokeWidth={0.8} />
                )}
                {/* Vessel dot — actual offset position */}
                <circle cx={vx} cy={vy} r={2.5} fill={color} />
            </svg>
            <div
                className="absolute inset-0 flex items-end justify-center pointer-events-none"
                style={{ paddingBottom: 1 }}
            >
                <span className="text-[9px] font-mono font-bold leading-none tabular-nums" style={{ color }}>
                    {Math.round(radiusM)}m
                </span>
            </div>
            {alarm && (
                <div
                    className="absolute inset-0 rounded-full pointer-events-none"
                    style={{ animation: 'pulse 1s infinite', boxShadow: '0 0 12px rgba(239,68,68,0.5)' }}
                />
            )}
        </div>
    );
};

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
    const state = deriveVoyageState(voyage, anchorStatus, tripLogActive);

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
        // Inline haversine — avoids dragging in navigationCalculations
        // for one call. Earth radius in NM (3440.065).
        const toRad = (d: number) => (d * Math.PI) / 180;
        const dLat = toRad(destCoords.lat - position.latitude);
        const dLon = toRad(destCoords.lon - position.longitude);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(position.latitude)) * Math.cos(toRad(destCoords.lat)) * Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distRemainingNm = 3440.065 * c;
    }
    // Fall back to total route NM if we have the route but no GPS yet.
    const showRouteNm = !distRemainingNm && routeNm !== null && state.label === 'Underway';

    // Show the anchor swing arc when armed (or alarm).
    const showSwing = anchorStatus !== 'disarmed' && anchorRadius > 0;

    const handleVesselTap = () => {
        triggerHaptic('light');
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

    return (
        <div
            className={`mb-4 overflow-hidden ${anchorStatus === 'alarm' ? 'nav-hero-alarm' : ''}`}
            style={{
                ...GLASS.card,
                background: 'linear-gradient(135deg, rgba(20,25,35,0.75) 0%, rgba(14,165,233,0.08) 100%)',
                borderColor: 'rgba(255,255,255,0.12)',
                transition: 'border-color 300ms ease, box-shadow 300ms ease',
            }}
        >
            {/* Top row — vessel name + state pill (and swing arc if anchored) */}
            <div className="flex items-center gap-2 px-4 pt-4 pb-2">
                <button
                    type="button"
                    onClick={handleVesselTap}
                    aria-label={vesselNameSet ? 'Open vessel settings' : 'Set vessel name'}
                    className="flex-1 min-w-0 active:opacity-70 transition-opacity text-left"
                >
                    {vesselNameSet ? (
                        <h2 className="text-lg font-black text-white tracking-tight truncate">{vesselName}</h2>
                    ) : (
                        <h2 className="text-lg font-black text-white/50 tracking-tight truncate italic">
                            Tap to name your vessel
                        </h2>
                    )}
                </button>
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
                            <span className="text-white/40 uppercase tracking-wider mr-1">Day</span>
                            {voyageDay}
                        </span>
                    )}
                    {distRemainingNm !== null && (
                        <span className="ml-auto font-mono text-white/85 tabular-nums">
                            {distRemainingNm.toFixed(1)}
                            <span className="text-white/40 text-[10px] ml-0.5">NM</span>
                            <span className="text-white/40 text-[10px] uppercase tracking-wider ml-1">to go</span>
                        </span>
                    )}
                    {showRouteNm && routeNm !== null && (
                        <span className="ml-auto font-mono text-white/60 tabular-nums">
                            {routeNm.toFixed(0)}
                            <span className="text-white/40 text-[10px] ml-0.5">NM</span>
                            <span className="text-white/40 text-[10px] uppercase tracking-wider ml-1">total</span>
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
                className="w-full flex items-center gap-2 px-4 pt-1.5 pb-2 active:opacity-70 transition-opacity text-left"
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
                <span className="text-white/40 text-[10px] uppercase tracking-wider shrink-0">
                    {formatTimeSince(position?.timestamp ?? null)}
                </span>
            </button>

            {/* SOG/COG nav line — left-side, always when underway */}
            {showSog && (
                <div className="flex items-center gap-3 px-4 pt-1.5 pb-1 border-t border-white/[0.06] text-[11px]">
                    <span className="font-mono text-white/85 tabular-nums">
                        <span className="text-white/40 uppercase tracking-wider mr-1">SOG</span>
                        {sogKt.toFixed(1)}
                        <span className="text-white/40 text-[10px] ml-0.5">kt</span>
                        {cogDeg !== null && (
                            <span className="ml-2">
                                <span className="text-white/40 uppercase tracking-wider mr-1">COG</span>
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
            <MetricChipStrip
                showTopBorder={!showSog}
                chips={(
                    [
                        showWind
                            ? {
                                  key: 'wind',
                                  icon: '💨',
                                  value: String(windKt),
                                  unit: 'kt',
                                  suffix: windDir || undefined,
                              }
                            : null,
                        waveHeight !== null
                            ? { key: 'wave', icon: '🌊', value: waveHeight.toFixed(1), unit: waveUnit }
                            : null,
                        airTemp !== null
                            ? { key: 'air', icon: '🌡', value: `${Math.round(airTemp)}`, unit: '°' }
                            : null,
                        seaTemp !== null
                            ? { key: 'sea', icon: '💧', value: `${Math.round(seaTemp)}`, unit: '°' }
                            : null,
                        visibility !== null
                            ? {
                                  key: 'vis',
                                  icon: '👁',
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
                ).filter((c): c is MetricChipData => c !== null)}
            />
        </div>
    );
};

/** Animated collapsible content wrapper */
const CollapsibleContent: React.FC<{ open: boolean; children: React.ReactNode }> = ({ open, children }) => (
    <div
        style={{
            display: 'grid',
            gridTemplateRows: open ? '1fr' : '0fr',
            transition: 'grid-template-rows 0.25s ease',
        }}
    >
        <div style={{ overflow: 'hidden' }}>{children}</div>
    </div>
);

/** Divider between list rows */
const ListDivider: React.FC = () => <div className="mx-4" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }} />;

/** Ship's Office list row.
 *  When `badgeUrgent` is true, the badge renders red (overdue / needs
 *  immediate action). Default amber (informational pending count). */
const OfficeRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    status: string;
    statusColor: string;
    onClick: () => void;
    disabled?: boolean;
    badge?: number;
    badgeUrgent?: boolean;
}> = ({ icon, label, status, statusColor, onClick, disabled, badge, badgeUrgent }) => (
    <button
        aria-label={label}
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all active:scale-[0.98] ${
            disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/[0.03]'
        }`}
    >
        <div className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
            {icon}
        </div>
        <span className="flex-1 text-[13px] font-bold text-white tracking-wide">{label}</span>
        {badge !== undefined && (
            <span
                className={`px-1.5 py-0.5 text-[11px] font-bold rounded-full ${
                    badgeUrgent ? 'bg-red-500/30 text-red-300 animate-pulse' : 'bg-amber-500/30 text-amber-300'
                }`}
            >
                {badge}
            </span>
        )}
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: statusColor }}>
            {status}
        </span>
        <ChevronRight />
    </button>
);

// ══════════════════════════════════════
// ── Icons (16x16) ──
// ══════════════════════════════════════

const ChevronRight: React.FC = () => (
    <svg
        className="w-3.5 h-3.5 text-gray-500 ml-1"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
    >
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
);

const CompassIcon: React.FC = () => (
    <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
        />
    </svg>
);

const ShieldIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />
    </svg>
);

const SignalIcon: React.FC<{ color?: string }> = ({ color = 'currentColor' }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
        />
    </svg>
);

const BookIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
        />
    </svg>
);

const MobIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4.5" />
        <circle cx="12" cy="12" r="1.5" fill={color} />
    </svg>
);

const PlusIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
);

const ChecklistIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
    </svg>
);

const PenIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
        />
    </svg>
);

const BoxIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
        />
    </svg>
);

const WrenchIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M11.42 15.17l-5.3 5.3a1.5 1.5 0 01-2.12 0l-.36-.36a1.5 1.5 0 010-2.12l5.3-5.3m2.1-2.1l4.24-4.24a3 3 0 014.24 0l.36.36a3 3 0 010 4.24l-4.24 4.24m-6.36-6.36l6.36 6.36"
        />
    </svg>
);

const ChartIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-1.5L12 12l3 1.5 3-3V6"
        />
    </svg>
);

const ClipboardIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
        />
    </svg>
);

const DocShieldIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
        />
    </svg>
);

const CrewIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
        />
    </svg>
);

const MapChartIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
        />
    </svg>
);

const GpxIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
        />
    </svg>
);

const NoticeIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
        />
    </svg>
);

const MusicNoteIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill={color} aria-hidden="true">
        <path d="M9 17.5a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 4 17.5 2.5 2.5 0 0 1 6.5 15c.34 0 .67.07.97.18V6L20 4v11.5a2.5 2.5 0 0 1-2.5 2.5 2.5 2.5 0 0 1-2.5-2.5 2.5 2.5 0 0 1 2.5-2.5c.34 0 .67.07.97.18V7.79L9 9.5v8z" />
    </svg>
);

const UserIcon: React.FC<{ color: string }> = ({ color }) => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth={1.5}>
        <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
        />
    </svg>
);
