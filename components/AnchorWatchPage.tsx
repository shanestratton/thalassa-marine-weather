/**
 * @filesize-justified 3 view modes (setup/watching/shore) sharing 15+ state variables. Splitting would require a context or prop-drilling.
 */
/**
 * AnchorWatchPage — Premium anchor watch UI
 *
 * States:
 * - IDLE: Setup screen with anchor drop configuration
 * - WATCHING: Live monitoring with swing circle visualization
 * - ALARM: Full-screen drag alarm with distance info
 * - SHORE: Remote monitoring via Supabase Realtime sync
 *
 * Replaces the old CompassPage in the navigation.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useWeather } from '../context/WeatherContext';
import { t } from '../theme';
import { useKeyboardScroll } from '../hooks/useKeyboardScroll';
import { AnchorWatchService, type AnchorWatchSnapshot, type AnchorWatchConfig } from '../services/AnchorWatchService';
import {
    AnchorWatchSyncService,
    type SyncState,
    type SyncBroadcast,
    type PositionBroadcast,
} from '../services/AnchorWatchSyncService';
import { AlarmAudioService } from '../services/AlarmAudioService';
import { triggerHaptic } from '../utils/system';
import { SwingCircleCanvas, type AisTargetDot } from './anchor-watch/SwingCircleCanvas';
import { ScopeRadar } from './anchor-watch/ScopeRadar';
import { VpnHairpinNotice } from './network/VpnHairpinNotice';
import { SoundCheckModal } from './anchor-watch/SoundCheckModal';
import { ShoreWatchModal } from './anchor-watch/ShoreWatchModal';
import { AisStreamService } from '../services/AisStreamService';
import { PageHeader } from './ui/PageHeader';
import { toast } from './Toast';
import { createLogger } from '../utils/createLogger';
import { AnchorIcon, AlertTriangleIcon, MuteIcon, CheckIcon, PhoneIcon, PowerBoatIcon } from './Icons';
import { useAuthStore } from '../stores/authStore';
import { SignInScreen } from './SignInScreen';

import {
    navStatusColorSimple,
    getWeatherRecommendation,
    formatDistance,
    bearingToCardinal,
    formatElapsed,
} from './anchor-watch/anchorUtils';

const log = createLogger('AnchorWatch');
/** Vessel positions are broadcast every five seconds; three missed updates are stale. */
export const SHORE_DATA_STALE_MS = 15_000;

// ------- TYPES -------

type ViewMode = 'setup' | 'watching' | 'shore';

interface AnchorWatchPageProps {
    onBack?: () => void;
}

// ------- MAIN COMPONENT -------

export const AnchorWatchPage: React.FC<AnchorWatchPageProps> = React.memo(({ onBack }) => {
    const { weatherData } = useWeather();
    const authedUser = useAuthStore((state) => state.user);
    const keyboardScrollRef = useKeyboardScroll<HTMLDivElement>();

    const [viewMode, setViewMode] = useState<ViewMode>('setup');
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot | null>(null);
    const [syncState, setSyncState] = useState<SyncState | null>(null);
    const [shoreData, setShoreData] = useState<PositionBroadcast | null>(null);
    const [shoreDataReceivedAt, setShoreDataReceivedAt] = useState<number | null>(null);
    const [shoreAlarmMutedLocally, setShoreAlarmMutedLocally] = useState(false);

    // Setup form state
    const [rodeLength, setRodeLength] = useState(30);
    const [waterDepth, setWaterDepth] = useState(5);
    const [rodeType, setRodeType] = useState<'chain' | 'rope' | 'mixed'>('chain');
    const [safetyMargin, _setSafetyMargin] = useState(10);
    const [sessionCode, setSessionCode] = useState('');
    const [showShoreModal, setShowShoreModal] = useState(false);
    const [showShoreSignIn, setShowShoreSignIn] = useState(false);

    // Sound check modal — shown once per session before first anchor set
    const [showSoundCheck, setShowSoundCheck] = useState(false);

    // AIS targets on anchor watch radar
    const [aisTargets, setAisTargets] = useState<AisTargetDot[]>([]);
    const [showAisOnRadar, setShowAisOnRadar] = useState(() => {
        try {
            return localStorage.getItem('thalassa_anchor_ais') !== 'off';
        } catch (e) {
            console.warn('Suppressed:', e);
            return true;
        }
    });

    // Canvas ref no longer needed — SwingCircleCanvas manages its own ref

    const [isSettingAnchor, setIsSettingAnchor] = useState(false);
    const [isRetryingMonitoring, setIsRetryingMonitoring] = useState(false);
    const [gpsStatus, setGpsStatus] = useState<string>('Waiting for GPS...');
    // The gateway the NMEA GPS source is configured against, for the
    // hairpin check. Read once — it only changes on the NMEA page.
    const [nmeaHost] = useState<string | null>(() => {
        try {
            return localStorage.getItem('nmea_host');
        } catch {
            return null;
        }
    });

    // Weather-smart rode recommendation
    const wxRecommendation = useMemo(() => {
        const wind = weatherData?.current?.windSpeed ?? 0;
        const gust = weatherData?.current?.windGust ?? 0;
        const waveFt = weatherData?.current?.waveHeight ?? 0; // already in feet from transformer
        const waveM = waveFt / 3.28084; // convert back to meters for scope thresholds
        const rec = getWeatherRecommendation(wind, gust, waveM);
        const recRode = Math.min(100, Math.round(rec.scope * waterDepth));
        return { ...rec, rode: recRode, wind, gust, wave: waveFt };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weatherData?.current?.windSpeed, weatherData?.current?.windGust, weatherData?.current?.waveHeight, waterDepth]);

    // Elapsed time ticker
    const [, setTick] = useState(0);
    const tickRef = useRef<ReturnType<typeof setInterval>>();

    // Subscribe to anchor watch state updates
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snap) => {
            setSnapshot(snap);
            if (snap.state === 'idle' && viewMode === 'watching') {
                setViewMode('setup');
            }
        });
        return unsub;
    }, [viewMode]);

    // Subscribe to sync state and restore persisted sessions on mount
    useEffect(() => {
        const unsubState = AnchorWatchSyncService.onStateChange(setSyncState);
        const unsubBroadcast = AnchorWatchSyncService.onBroadcast((data: SyncBroadcast) => {
            if (data.type === 'position') {
                setShoreData(data);
                setShoreDataReceivedAt(Date.now());
            }
        });

        // Auto-restore persisted state after app crash/close
        // 1. Restore anchor watch state (anchor position, config, GPS monitoring)
        // 2. Restore sync session (Supabase channel reconnection)
        const restore = async () => {
            // First restore anchor watch — this re-establishes geofence + GPS
            const watchRestored = await AnchorWatchService.restoreWatchState();
            if (watchRestored) {
                setViewMode('watching');
            }

            // Then restore sync session — reconnect to Supabase channel
            const syncRestored = await AnchorWatchSyncService.restoreSession();
            if (syncRestored) {
                const state = AnchorWatchSyncService.getState();
                if (state.role === 'shore') {
                    setViewMode('shore');
                } else if (state.role === 'vessel' && !watchRestored) {
                    // Sync says vessel but anchor watch didn't restore
                    // (e.g., stale anchor state was cleared but sync session still active)
                    setViewMode('watching');
                }
            } else {
                // Auto-reconnect didn't land (no comms right now, session aged
                // out, or it just didn't come back). If the last session was a
                // SHORE (follower) join, pre-fill the code field so the punter
                // reconnects in one tap — never re-typing the session code.
                const last = AnchorWatchSyncService.getState();
                const lastCode = AnchorWatchSyncService.getLastSessionCode();
                if (last.role === 'shore' && lastCode) {
                    setSessionCode(lastCode);
                }
            }
        };
        restore();

        return () => {
            unsubState();
            unsubBroadcast();
        };
    }, []);

    // Shore stale data timeout — if no vessel data arrives within 60s, auto-leave
    useEffect(() => {
        if (viewMode !== 'shore' || shoreData) return;
        const timeout = setTimeout(async () => {
            // Still no data after 60s — stale/orphaned session
            if (!shoreData) {
                await AnchorWatchSyncService.leaveSession();
                setViewMode('setup');
                setShoreData(null);
                setShoreDataReceivedAt(null);
            }
        }, 60_000);
        return () => clearTimeout(timeout);
    }, [viewMode, shoreData]);

    // Shore alarm — trigger full alarm on shore watcher's phone when vessel drags
    const shoreAlarmLeaseRef = useRef<string | null>(null);
    const shoreAlarmAttemptRef = useRef(0);

    const releaseShoreAlarmLease = useCallback(async () => {
        shoreAlarmAttemptRef.current += 1;
        const lease = shoreAlarmLeaseRef.current;
        if (!lease) return;
        try {
            await AlarmAudioService.release(lease);
            if (shoreAlarmLeaseRef.current === lease) shoreAlarmLeaseRef.current = null;
        } catch (error) {
            log.error('Failed to release Shore Watch alarm audio', error);
            throw error;
        }
    }, []);

    useEffect(() => {
        if (viewMode !== 'shore') {
            void releaseShoreAlarmLease().catch(() => undefined);
            setShoreAlarmMutedLocally(false);
            return;
        }

        if (shoreData?.isAlarm && !shoreAlarmLeaseRef.current && !shoreAlarmMutedLocally) {
            // Vessel is dragging — sound the alarm on shore phone
            const attempt = ++shoreAlarmAttemptRef.current;
            void AlarmAudioService.acquire('shore-watch')
                .then((lease) => {
                    if (shoreAlarmAttemptRef.current !== attempt) {
                        AlarmAudioService.releaseEventually(lease);
                        return;
                    }
                    shoreAlarmLeaseRef.current = lease;
                })
                .catch((error) => {
                    log.error('Failed to start Shore Watch alarm audio', error);
                    toast.error('The Shore Watch alarm could not sound on this device. Check audio and volume now.');
                });
            triggerHaptic('heavy');

            // Repeat haptic every 2s while alarming
            const hapticInterval = setInterval(() => {
                triggerHaptic('heavy');
            }, 2000);

            return () => clearInterval(hapticInterval);
        } else if (!shoreData?.isAlarm) {
            // Vessel back inside swing circle — silence
            void releaseShoreAlarmLease().catch(() => undefined);
            setShoreAlarmMutedLocally(false);
        }
    }, [releaseShoreAlarmLease, viewMode, shoreData?.isAlarm, shoreAlarmMutedLocally]);

    // Cleanup alarm on unmount
    useEffect(() => {
        return () => {
            // The page is gone, so there is no mounted retry control left. Hand
            // this exact owner's token to detached cleanup; never force-stop or
            // risk silencing another active alarm owner.
            shoreAlarmAttemptRef.current += 1;
            const lease = shoreAlarmLeaseRef.current;
            shoreAlarmLeaseRef.current = null;
            if (lease) AlarmAudioService.releaseEventually(lease);
        };
    }, []);

    // Shore-data freshness is safety-visible, so age it each second. The local
    // vessel view only needs its elapsed clock refreshed once per minute.
    useEffect(() => {
        if (viewMode === 'watching' || viewMode === 'shore') {
            tickRef.current = setInterval(() => setTick((t) => t + 1), viewMode === 'shore' ? 1000 : 60000);
        }
        return () => {
            if (tickRef.current) clearInterval(tickRef.current);
        };
    }, [viewMode]);

    // Keep a ref to the latest snapshot so the broadcast interval always has fresh data
    const snapshotRef = useRef(snapshot);
    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);

    // Broadcast position to shore devices when watching — every 5 seconds
    useEffect(() => {
        if (viewMode !== 'watching' || !syncState?.connected) return;

        const broadcastNow = () => {
            const snap = snapshotRef.current;
            if (!snap?.anchorPosition || !snap?.vesselPosition) {
                return;
            }
            AnchorWatchSyncService.broadcastPosition({
                vessel: snap.vesselPosition,
                anchor: snap.anchorPosition,
                distance: snap.distanceFromAnchor,
                swingRadius: snap.swingRadius,
                isAlarm: snap.state === 'alarm',
                config: snap.config,
            });
        };

        // Send immediately on connect
        broadcastNow();

        // Then every 5 seconds
        const interval = setInterval(broadcastNow, 5000);
        return () => clearInterval(interval);
    }, [viewMode, syncState?.connected]);

    // Swing circle visualization extracted to SwingCircleCanvas component

    // ── AIS target polling for anchor watch radar ──
    useEffect(() => {
        if (viewMode !== 'watching' || !showAisOnRadar) {
            setAisTargets([]);
            return;
        }

        const fetchAisTargets = async () => {
            const snap = snapshotRef.current;
            if (!snap?.anchorPosition) return;

            try {
                const geojson = await AisStreamService.fetchNearby({
                    lat: snap.anchorPosition.latitude,
                    lon: snap.anchorPosition.longitude,
                    radiusNm: 2,
                    limit: 50,
                });

                const dots: AisTargetDot[] = (geojson.features || [])
                    .filter((f) => {
                        const coords = (f.geometry as GeoJSON.Point)?.coordinates;
                        return coords && coords.length >= 2;
                    })
                    .map((f) => {
                        const p = f.properties || {};
                        const coords = (f.geometry as GeoJSON.Point).coordinates;
                        return {
                            mmsi: Number(p.mmsi),
                            name: p.name || `MMSI ${p.mmsi}`,
                            lat: coords[1],
                            lon: coords[0],
                            cog: Number(p.cog ?? 0),
                            sog: Number(p.sog ?? 0),
                            statusColor: navStatusColorSimple(p.navStatus ?? p.nav_status ?? 15),
                        };
                    });

                setAisTargets(dots);
            } catch (e) {
                console.warn('Suppressed:', e);
                // Silently fail — AIS is a nice-to-have overlay
            }
        };

        fetchAisTargets();
        const interval = setInterval(fetchAisTargets, 30_000);
        return () => clearInterval(interval);
    }, [viewMode, showAisOnRadar]);

    // ---- HANDLERS ----

    const handleSetAnchor = useCallback(async () => {
        setIsSettingAnchor(true);
        // Arming is five steps, only one of which is the fix. This used to
        // print 'Acquiring GPS fix...' once and never change, so a stall in
        // permissions, the geofence or the background lease all read as a GPS
        // failure — and the skipper went looking at satellites (Shane
        // 2026-08-08). Poll the service for the step actually in flight.
        setGpsStatus('Starting…');
        const stagePoll = setInterval(() => {
            const stage = AnchorWatchService.getSetupStage();
            if (stage) setGpsStatus(`${stage}…`);
        }, 250);

        const config: Partial<AnchorWatchConfig> = {
            rodeLength,
            waterDepth,
            rodeType,
            safetyMargin,
            scopeRatio: rodeLength / waterDepth,
        };

        const success = await AnchorWatchService.setAnchor(config);
        clearInterval(stagePoll);
        setIsSettingAnchor(false);

        if (success) {
            setViewMode('watching');
            // First-time hint dismissal — the intro card at the top
            // of the setup view only shows for users who haven't
            // armed yet. After one successful arm, they know.
            try {
                localStorage.setItem('thalassa_anchor_watch_armed_once', '1');
            } catch {
                // localStorage unavailable (private browsing etc) —
                // harmless; hint will keep showing.
            }
        } else {
            setGpsStatus(
                AnchorWatchService.getLastSetupError() ??
                    'Anchor Watch could not start. Check location and notification permissions.',
            );
        }
    }, [rodeLength, waterDepth, rodeType, safetyMargin]);

    const handleStopWatch = useCallback(async () => {
        // Shore follower: there's no local anchor watch to stop — leaving just
        // tears down the shared session, which CLEARS the saved code so it
        // doesn't pre-fill (and confuse) on the next anchor. Do this
        // independently of stopWatch() — a follower has no watch to stop, and
        // previously a throw there skipped leaveSession() and stranded the code.
        if (viewMode === 'shore') {
            try {
                await AnchorWatchSyncService.leaveSession();
            } catch (e) {
                log.warn('leaveSession (shore) failed', e);
            }
            setViewMode('setup');
            setShoreData(null);
            setShoreDataReceivedAt(null);
            return;
        }
        // Vessel host: stopping is a SAFETY action — must never fail silently.
        // If the service throws, the watch may still be armed; tell the user so
        // they can retry rather than walking away thinking it's off.
        try {
            await AnchorWatchService.stopWatch();
            await AnchorWatchSyncService.leaveSession();
            setViewMode('setup');
            setShoreData(null);
            setShoreDataReceivedAt(null);
        } catch (e) {
            log.error('Failed to stop anchor watch', e);
            toast.error('Could not stop the anchor watch — it may still be armed. Try again.');
        }
    }, [viewMode]);

    const handleMuteShoreAlarm = useCallback(async () => {
        try {
            await releaseShoreAlarmLease();
            setShoreAlarmMutedLocally(true);
            triggerHaptic('medium');
        } catch {
            toast.error('The Shore Watch alarm could not be silenced on this device. Try again.');
        }
    }, [releaseShoreAlarmLease]);

    const handleRetryMonitoring = useCallback(async () => {
        if (isRetryingMonitoring) return;
        setIsRetryingMonitoring(true);
        try {
            await AnchorWatchService.restoreWatchState();
            const current = AnchorWatchService.getSnapshot();
            if (current.state === 'paused') {
                throw new Error(current.setupError || 'Anchor Watch safety monitoring is still blocked.');
            }
            if (current.state !== 'watching' && current.state !== 'alarm') {
                throw new Error('Anchor Watch could not confirm that monitoring restarted.');
            }
            toast.success('Anchor Watch monitoring restarted.');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Anchor Watch monitoring could not restart.';
            toast.error(message);
        } finally {
            setIsRetryingMonitoring(false);
        }
    }, [isRetryingMonitoring]);

    const handleCreateSession = useCallback(async () => {
        if (!authedUser) {
            setShowShoreSignIn(true);
            return;
        }
        try {
            const code = await AnchorWatchSyncService.createSession();
            if (code) {
                setSessionCode(code);
            } else {
                toast.error('Could not start a shore-watch session — check your connection.');
            }
        } catch (e) {
            log.error('createSession failed', e);
            toast.error('Could not start a shore-watch session — check your connection.');
        }
    }, [authedUser]);

    const handleJoinShore = useCallback(async () => {
        if (!authedUser) {
            setShowShoreModal(false);
            setShowShoreSignIn(true);
            return;
        }
        if (sessionCode.length !== 12) return;
        try {
            const joined = await AnchorWatchSyncService.joinSession(sessionCode);
            if (joined) {
                setViewMode('shore');
            } else {
                toast.error('Could not join — check the 12-character code and try again.');
            }
        } catch (e) {
            log.error('joinSession failed', e);
            toast.error('Could not join the shore watch — check your connection.');
        }
    }, [authedUser, sessionCode]);
    // Slide-to-confirm state (must be before any early returns — React Rules of Hooks)
    const slideTrackRef = useRef<HTMLDivElement>(null);
    const [slideX, setSlideX] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [slideCommitted, setSlideCommitted] = useState(false);
    const slideThreshold = 0.85; // 85% to trigger
    const lastSlideRatioRef = useRef(0);
    const lastHapticRatioRef = useRef(0); // throttle progressive haptics

    // Live offset alongside state: the release check must read the LAST
    // move, not the last render — a fast flick could end on a stale value.
    const slideXRef = useRef(0);

    const handleSlideStart = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (isSettingAnchor) return;
            // Capture the pointer so move/up/cancel keep routing here no
            // matter where the finger wanders. Without capture, an iOS
            // touch cancel (system gesture, notification banner) never
            // delivered an end event and the thumb froze mid-track in the
            // committed style (field bug 2026-06-13).
            try {
                e.currentTarget.setPointerCapture?.(e.pointerId);
            } catch {
                /* best-effort — jsdom and odd inputs lack capture */
            }
            setIsDragging(true);
            setSlideCommitted(false);
            lastSlideRatioRef.current = 0;
            lastHapticRatioRef.current = 0;
        },
        [isSettingAnchor],
    );

    const handleSlideMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!isDragging || !slideTrackRef.current) return;
            const rect = slideTrackRef.current.getBoundingClientRect();
            const thumbWidth = 56;
            const maxTravel = rect.width - thumbWidth;
            const offset = e.clientX - rect.left - thumbWidth / 2;
            const clamped = Math.max(0, Math.min(offset, maxTravel));
            slideXRef.current = clamped;
            setSlideX(clamped);

            const ratio = clamped / maxTravel;

            // Progressive haptic feedback — tap every 15% of travel
            if (ratio - lastHapticRatioRef.current >= 0.15) {
                lastHapticRatioRef.current = ratio;
                triggerHaptic('light');
            }

            // Commit snap — heavy haptic when crossing threshold
            if (ratio >= slideThreshold && lastSlideRatioRef.current < slideThreshold) {
                triggerHaptic('heavy');
                setSlideCommitted(true);
            } else if (ratio < slideThreshold && lastSlideRatioRef.current >= slideThreshold) {
                // Pulled back below threshold
                setSlideCommitted(false);
            }

            lastSlideRatioRef.current = ratio;
        },
        [isDragging],
    );

    const handleSlideEnd = useCallback(() => {
        if (!isDragging || !slideTrackRef.current) return;
        setIsDragging(false);
        const rect = slideTrackRef.current.getBoundingClientRect();
        const thumbWidth = 56;
        const maxTravel = rect.width - thumbWidth;
        const ratio = slideXRef.current / maxTravel;
        if (ratio >= slideThreshold) {
            // Every arming attempt requires a fresh audible test because route,
            // volume, Focus, and connected audio hardware can change at any time.
            setShowSoundCheck(true);
        }
        slideXRef.current = 0;
        setSlideX(0);
        setSlideCommitted(false);
    }, [isDragging]);

    const handleSlideCancel = useCallback(() => {
        // iOS cancels (not ends) the touch for system gestures and
        // banners — never drop the anchor from a cancel, just spring back.
        if (!isDragging) return;
        setIsDragging(false);
        slideXRef.current = 0;
        setSlideX(0);
        setSlideCommitted(false);
    }, [isDragging]);

    // Confirm and proceed from sound check modal
    const handleSoundCheckConfirm = useCallback(() => {
        setShowSoundCheck(false);
        handleSetAnchor();
    }, [handleSetAnchor]);

    // Reset slide position when not dragging
    useEffect(() => {
        if (!isDragging) {
            slideXRef.current = 0;
            setSlideX(0);
        }
    }, [isDragging]);

    // ---- ALARM OVERLAY ----
    // Rendered app-level by GlobalAnchorAlarmGate (App.tsx) so the alarm
    // covers every page, not just this one. The page-local early return
    // here would stack a second copy of the same critical portal.
    // ---- RENDER: SETUP (IDLE) — Instrument-Grade Dashboard ----

    // Derived values for the scope quality indicator (used in context strip)
    const scopeRatio = rodeLength / Math.max(waterDepth, 0.1);
    const scopeQuality: 'excellent' | 'adequate' | 'poor' =
        scopeRatio >= 7 ? 'excellent' : scopeRatio >= 5 ? 'adequate' : 'poor';

    if (viewMode === 'setup') {
        return (
            <div
                ref={keyboardScrollRef}
                className={`anchor-setup-page h-full ${t.colors.bg.base} flex flex-col overflow-hidden slide-up-enter`}
                style={{ overscrollBehaviorY: 'none' }}
            >
                <PageHeader
                    title="Anchor Watch"
                    onBack={onBack}
                    action={
                        <button
                            aria-label={authedUser ? 'Open Shore Watch join' : 'Sign in to use Shore Watch'}
                            onClick={() => (authedUser ? setShowShoreModal(true) : setShowShoreSignIn(true))}
                            className="min-h-11 px-3 rounded-lg text-xs font-bold text-slate-400 bg-slate-800/60 border border-white/[0.06] hover:text-slate-300 transition-colors"
                        >
                            {authedUser ? 'Shore' : 'Shore · Sign in'}
                        </button>
                    }
                />

                {/* Setup remains compact in portrait, but it must be a real
                    scrollport on short landscape/keyboard viewports so the
                    arming control can never be clipped below the screen. */}
                <div className="anchor-setup-scroll flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-y-contain pb-[98px]">
                    {/* First-time-user guidance card — added 2026-05-17.
                        Shows for users who haven't yet armed an anchor
                        watch (gated by the
                        `thalassa_anchor_watch_armed_once` localStorage
                        flag set in `handleDropAnchor`'s success branch).
                        Anchor Watch is a safety feature — vague setup
                        UX = real risk. The card explains the three
                        configuration knobs in plain English and the
                        slide-to-arm gesture. Hides permanently after
                        the user successfully arms once. */}
                    {typeof window !== 'undefined' && !localStorage.getItem('thalassa_anchor_watch_armed_once') && (
                        <div className="shrink-0 mx-4 mt-2 mb-1 rounded-xl bg-sky-500/[0.06] border border-sky-500/15 px-3 py-2.5">
                            <p className="text-[12px] text-sky-200 leading-relaxed">
                                <span className="font-bold text-sky-300">Drop anchor, then arm the watch.</span> Set
                                your <span className="font-semibold text-white">water depth</span>,{' '}
                                <span className="font-semibold text-white">rode out</span>, and{' '}
                                <span className="font-semibold text-white">tackle type</span> below — Thalassa
                                calculates a safe swing circle. Slide the bar at the bottom to arm. Background warning
                                depends on this device’s GPS and notification permissions, so run the Sound Check and
                                keep Thalassa running.
                            </p>
                        </div>
                    )}

                    {/* ── Hero: Scope Radar ── */}
                    <div className="anchor-setup-radar flex-1 min-h-0 flex items-center justify-center px-4 py-2 relative">
                        <ScopeRadar
                            rodeLength={rodeLength}
                            waterDepth={waterDepth}
                            rodeType={rodeType}
                            safetyMargin={safetyMargin}
                        />
                    </div>

                    {/* ── Controls Section ── */}
                    <div className="shrink-0 px-4 space-y-3">
                        {/* Tackle Type — compact segmented row */}
                        <div className="flex gap-1.5">
                            {(['chain', 'rope', 'mixed'] as const).map((type) => (
                                <button
                                    aria-label={`Select ${type} anchor rode type`}
                                    key={type}
                                    onClick={() => setRodeType(type)}
                                    className={`flex-1 min-h-11 rounded-xl text-sm font-bold transition-all ${
                                        rodeType === type
                                            ? 'bg-amber-500/20 border border-amber-500/40 text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.1)]'
                                            : 'bg-slate-800/40 border border-white/[0.06] text-slate-400 hover:text-slate-400'
                                    }`}
                                >
                                    {type === 'chain' ? '⛓' : type === 'rope' ? '🪢' : '🔗'}
                                    <span className="ml-1 hidden min-[380px]:inline capitalize">{type}</span>
                                </button>
                            ))}
                        </div>

                        {/* Sliders */}
                        <div className="space-y-2.5">
                            {/* Water Depth */}
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs text-slate-400 uppercase tracking-wider font-bold">
                                        Water Depth
                                    </label>
                                    <span className="text-sm font-black text-sky-400 font-mono tabular-nums">
                                        {waterDepth}m
                                    </span>
                                </div>
                                <input
                                    aria-label="Water depth in metres"
                                    type="range"
                                    min={1}
                                    max={30}
                                    step={0.5}
                                    value={waterDepth}
                                    onChange={(e) => setWaterDepth(Number(e.target.value))}
                                    className="w-full h-2 bg-slate-800/60 rounded-full accent-sky-500 appearance-none cursor-pointer"
                                    style={{ touchAction: 'none' }}
                                />
                            </div>

                            {/* Rode Deployed */}
                            <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs text-slate-400 uppercase tracking-wider font-bold">
                                        Rode Deployed
                                    </label>
                                    <span className="text-sm font-black text-amber-400 font-mono tabular-nums">
                                        {rodeLength.toFixed(1)}m
                                    </span>
                                </div>
                                <input
                                    aria-label="Rode deployed in metres"
                                    type="range"
                                    min={5}
                                    max={100}
                                    step={1}
                                    value={rodeLength}
                                    onChange={(e) => setRodeLength(Number(e.target.value))}
                                    className="w-full h-2 bg-slate-800/60 rounded-full accent-amber-500 appearance-none cursor-pointer"
                                    style={{ touchAction: 'none' }}
                                />
                            </div>
                        </div>

                        {/* ── Context Strip — weather + safety ── */}
                        <div className="flex items-center gap-2 bg-slate-800/30 border border-white/[0.04] rounded-xl px-3 py-2">
                            {/* Weather left */}
                            <button
                                aria-label="Rode Length"
                                onClick={() => setRodeLength(wxRecommendation.rode)}
                                className="flex-1 min-h-11 flex items-center gap-1.5 text-left group"
                                title={`Tap to set rode to ${wxRecommendation.rode}m (${wxRecommendation.scope}:1)`}
                            >
                                <span className="text-base">{wxRecommendation.icon}</span>
                                <div className="min-w-0">
                                    <div className="text-xs text-slate-300 font-bold truncate group-hover:text-white transition-colors">
                                        {wxRecommendation.label} · {wxRecommendation.wind.toFixed(0)}kts
                                    </div>
                                    <div className="text-[11px] text-slate-400 group-hover:text-slate-400 transition-colors inline-flex items-center gap-1">
                                        {rodeLength === wxRecommendation.rode ? (
                                            <>
                                                <CheckIcon className="w-3 h-3" />
                                                <span>{`${wxRecommendation.scope}:1 set`}</span>
                                            </>
                                        ) : (
                                            `Tap → ${wxRecommendation.rode}m`
                                        )}
                                    </div>
                                </div>
                            </button>

                            {/* Divider */}
                            <div className="w-px h-6 bg-white/[0.06]" />

                            {/* Safety status right */}
                            <div className="flex items-center gap-1.5">
                                <span
                                    className={`w-2 h-2 rounded-full ${
                                        scopeQuality === 'excellent'
                                            ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                                            : scopeQuality === 'adequate'
                                              ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]'
                                              : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)] animate-pulse'
                                    }`}
                                />
                                <span
                                    className={`text-xs font-bold ${
                                        scopeQuality === 'excellent'
                                            ? 'text-emerald-400'
                                            : scopeQuality === 'adequate'
                                              ? 'text-amber-400'
                                              : 'text-red-400'
                                    }`}
                                >
                                    {scopeQuality === 'excellent'
                                        ? 'Safe'
                                        : scopeQuality === 'adequate'
                                          ? 'OK'
                                          : 'Poor'}{' '}
                                    {scopeRatio.toFixed(0)}:1
                                </span>
                            </div>
                        </div>

                        {/* ── Slide to Confirm — safety orange ── */}
                        <div className="pt-1 pb-2">
                            {/* Arming against the boat's own GPS means the feed
                                has to be sound. A VPN hairpinning boat-LAN
                                traffic degrades it into exactly the dropouts
                                that make a watch go blind. */}
                            <VpnHairpinNotice hostIp={nmeaHost} hostLabel="the NMEA gateway" className="mb-2" />
                            {!isSettingAnchor && gpsStatus !== 'Waiting for GPS...' && (
                                <p
                                    role="alert"
                                    className="mb-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-bold leading-relaxed text-red-200"
                                >
                                    {gpsStatus}
                                </p>
                            )}
                            {isSettingAnchor ? (
                                /* Loading state */
                                <div
                                    className="w-full h-14 rounded-full flex items-center justify-center gap-3"
                                    style={{
                                        background:
                                            'linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(217,119,6,0.1) 100%)',
                                        border: '1px solid rgba(245,158,11,0.2)',
                                    }}
                                >
                                    <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm text-amber-300 font-bold">{gpsStatus}</span>
                                </div>
                            ) : (
                                /* Slide track */
                                <div
                                    ref={slideTrackRef}
                                    className="relative w-full h-14 rounded-full overflow-hidden select-none"
                                    style={{
                                        background:
                                            'linear-gradient(135deg, rgba(234,88,12,0.25) 0%, rgba(194,65,12,0.2) 100%)',
                                        border: '1px solid rgba(251,146,60,0.25)',
                                        touchAction: 'none',
                                    }}
                                    onPointerDown={handleSlideStart}
                                    onPointerMove={handleSlideMove}
                                    onPointerUp={handleSlideEnd}
                                    onPointerCancel={handleSlideCancel}
                                    role="button"
                                    tabIndex={0}
                                    aria-label="Drop anchor and arm Anchor Watch"
                                    onKeyDown={(event) => {
                                        if (event.key !== 'Enter' && event.key !== ' ') return;
                                        event.preventDefault();
                                        setShowSoundCheck(true);
                                    }}
                                >
                                    {/* Shimmer animation */}
                                    <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
                                        <div
                                            className="absolute inset-0"
                                            style={{
                                                background:
                                                    'linear-gradient(90deg, transparent 0%, rgba(251,146,60,0.08) 30%, rgba(251,146,60,0.15) 50%, rgba(251,146,60,0.08) 70%, transparent 100%)',
                                                animation: 'shimmer 2.5s ease-in-out infinite',
                                            }}
                                        />
                                    </div>

                                    {/* Fill trail — glows behind thumb as it slides */}
                                    <div
                                        className="absolute top-0 left-0 bottom-0 rounded-full pointer-events-none transition-opacity"
                                        style={{
                                            width: `${slideX + 56}px`,
                                            background: slideCommitted
                                                ? 'linear-gradient(90deg, rgba(34,197,94,0.15) 0%, rgba(34,197,94,0.3) 100%)'
                                                : 'linear-gradient(90deg, rgba(251,146,60,0.08) 0%, rgba(251,146,60,0.2) 100%)',
                                            opacity: slideX > 2 ? 1 : 0,
                                            transition: isDragging
                                                ? 'background 0.3s'
                                                : 'width 0.3s ease, opacity 0.2s',
                                        }}
                                    />

                                    {/* Label text */}
                                    <div
                                        className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                        style={{
                                            opacity:
                                                1 -
                                                slideX /
                                                    ((slideTrackRef.current?.getBoundingClientRect().width ?? 300) -
                                                        56),
                                        }}
                                    >
                                        <span className="text-sm font-bold text-amber-300/70 tracking-wider uppercase">
                                            Slide to Drop Anchor
                                        </span>
                                    </div>

                                    {/* Draggable thumb */}
                                    <div
                                        className="absolute top-1 left-1 w-12 h-12 rounded-full flex items-center justify-center cursor-grab active:cursor-grabbing transition-shadow"
                                        style={{
                                            transform: `translateX(${slideX}px)`,
                                            background: slideCommitted
                                                ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'
                                                : 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                                            boxShadow: slideCommitted
                                                ? '0 4px 16px rgba(34,197,94,0.5), 0 0 24px rgba(34,197,94,0.2)'
                                                : '0 4px 16px rgba(249,115,22,0.4), 0 0 20px rgba(249,115,22,0.15)',
                                            transition: isDragging
                                                ? 'background 0.3s, box-shadow 0.3s'
                                                : 'transform 0.3s ease, background 0.3s, box-shadow 0.3s',
                                        }}
                                    >
                                        {slideCommitted ? (
                                            <CheckIcon className="w-5 h-5 text-white" />
                                        ) : (
                                            <AnchorIcon className="w-5 h-5 text-white" />
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* ══ Sound Check Confirmation Modal ══ */}
                {showSoundCheck && (
                    <SoundCheckModal onConfirm={handleSoundCheckConfirm} onCancel={() => setShowSoundCheck(false)} />
                )}

                {/* Shore Watch Modal — rendered via portal to bypass PullToRefresh transform */}
                {showShoreModal && (
                    <ShoreWatchModal
                        sessionCode={sessionCode}
                        onSessionCodeChange={setSessionCode}
                        onJoin={handleJoinShore}
                        onClose={() => setShowShoreModal(false)}
                    />
                )}

                <SignInScreen
                    isOpen={showShoreSignIn}
                    onClose={() => setShowShoreSignIn(false)}
                    prompt="Sign in to share Anchor Watch between your vessel and shore devices. Local Anchor Watch remains available without an account."
                />

                {/* Shimmer keyframe */}
                <style>{`
                    @keyframes shimmer {
                        0%, 100% { transform: translateX(-100%); }
                        50% { transform: translateX(100%); }
                    }
                `}</style>
            </div>
        );
    }

    // ---- RENDER: SHORE MODE ----
    if (viewMode === 'shore') {
        const shoreDataAgeMs = shoreDataReceivedAt === null ? null : Math.max(0, Date.now() - shoreDataReceivedAt);
        const shoreDataFresh =
            syncState?.peerConnected === true &&
            shoreData !== null &&
            shoreDataAgeMs !== null &&
            shoreDataAgeMs <= SHORE_DATA_STALE_MS;
        const shoreDataAgeLabel =
            shoreDataAgeMs === null ? 'no update received' : `${Math.floor(shoreDataAgeMs / 1000)}s ago`;
        const shoreStatusLabel = shoreDataFresh
            ? shoreData?.isAlarm
                ? 'Drag Alarm'
                : 'Holding'
            : shoreData?.isAlarm
              ? 'Last-known drag alarm'
              : 'Last-known data';
        const shoreStatusIsAlarm = shoreData?.isAlarm === true;
        const shoreDisconnectedWithKnownData = syncState?.peerConnected !== true && shoreData !== null;

        return (
            <div className={`h-full ${t.colors.bg.base} flex flex-col`}>
                <PageHeader
                    title="Shore Watch"
                    subtitle={
                        <p className="text-[11px] flex items-center gap-1.5 mt-0.5 font-bold uppercase tracking-widest">
                            {shoreDataFresh ? (
                                <>
                                    <span className="w-2 h-2 bg-emerald-500 rounded-full inline-block animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.5)]" />{' '}
                                    <span className="text-emerald-400">Vessel Data Live</span>
                                </>
                            ) : syncState?.peerConnected ? (
                                <>
                                    <span className="w-2 h-2 bg-amber-500 rounded-full inline-block" />{' '}
                                    <span className="text-amber-400">
                                        {shoreData ? 'Vessel Data Stale' : 'Waiting for Vessel Data'}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className="w-2 h-2 bg-red-500 rounded-full inline-block animate-pulse" />{' '}
                                    <span className="text-red-400">Vessel Offline</span>
                                </>
                            )}
                        </p>
                    }
                    onBack={onBack}
                    action={
                        <button
                            onClick={handleStopWatch}
                            className="px-3 py-1.5 bg-red-500/[0.08] border border-red-500/20 rounded-lg text-red-400 text-sm font-bold transition-all active:scale-95"
                            aria-label="Stop Watch"
                        >
                            Leave
                        </button>
                    }
                />

                {/* Connection/freshness banner. Retained vessel values are useful,
                    but must be unmistakably last-known whenever the peer is gone
                    or the five-second position feed has stopped. */}
                {!shoreDataFresh && (
                    <div
                        className={`shrink-0 mx-3 mt-1 px-3 py-2.5 flex items-center gap-2 rounded-xl border ${
                            shoreDisconnectedWithKnownData ||
                            (!syncState?.peerConnected && syncState?.peerDisconnectedAt)
                                ? 'bg-red-500/[0.08] border-red-500/25'
                                : 'bg-amber-500/[0.08] border-amber-500/25'
                        }`}
                    >
                        <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 animate-pulse ${
                                shoreDisconnectedWithKnownData ||
                                (!syncState?.peerConnected && syncState?.peerDisconnectedAt)
                                    ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                                    : 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]'
                            }`}
                        />
                        <span
                            className={`text-sm font-bold flex-1 inline-flex items-center gap-1.5 ${
                                shoreDisconnectedWithKnownData ||
                                (!syncState?.peerConnected && syncState?.peerDisconnectedAt)
                                    ? 'text-red-400'
                                    : 'text-amber-400'
                            }`}
                        >
                            {(shoreDisconnectedWithKnownData ||
                                (!syncState?.peerConnected && !!syncState?.peerDisconnectedAt)) && (
                                <AlertTriangleIcon className="w-4 h-4" />
                            )}
                            <span>
                                {shoreDisconnectedWithKnownData
                                    ? `Vessel offline · showing last-known data from ${shoreDataAgeLabel}`
                                    : !syncState?.peerConnected && syncState?.peerDisconnectedAt
                                      ? `Vessel connection lost · no current vessel data received`
                                      : syncState?.peerConnected && shoreData
                                        ? `Vessel data is stale · showing last-known update from ${shoreDataAgeLabel}`
                                        : 'Connecting to vessel · waiting for current data…'}
                            </span>
                        </span>
                        <span
                            className={`text-xs animate-pulse ${
                                shoreDisconnectedWithKnownData ||
                                (!syncState?.peerConnected && syncState?.peerDisconnectedAt)
                                    ? 'text-red-500/50'
                                    : 'text-amber-500/60'
                            }`}
                        >
                            {!syncState?.peerConnected
                                ? 'Reconnecting...'
                                : shoreData
                                  ? 'Awaiting update...'
                                  : 'Connecting...'}
                        </span>
                    </div>
                )}

                {/* Remote Data Display */}
                <div className="flex-1 p-4 flex flex-col items-center justify-center">
                    {shoreData ? (
                        <>
                            {/* Status circle with glow */}
                            <div
                                className={`w-36 h-36 rounded-full flex items-center justify-center mb-6 relative ${
                                    shoreData.isAlarm && shoreDataFresh ? 'animate-pulse' : ''
                                }`}
                                style={{
                                    background: shoreStatusIsAlarm
                                        ? 'radial-gradient(circle, rgba(127,29,29,0.5) 0%, rgba(69,10,10,0.3) 70%, transparent 100%)'
                                        : !shoreDataFresh
                                          ? 'radial-gradient(circle, rgba(120,53,15,0.35) 0%, rgba(69,26,3,0.15) 70%, transparent 100%)'
                                          : 'radial-gradient(circle, rgba(6,78,59,0.3) 0%, rgba(6,78,59,0.1) 70%, transparent 100%)',
                                    border: `3px solid ${
                                        shoreStatusIsAlarm
                                            ? 'rgba(239,68,68,0.5)'
                                            : shoreDataFresh
                                              ? 'rgba(16,185,129,0.3)'
                                              : 'rgba(245,158,11,0.35)'
                                    }`,
                                    boxShadow: shoreStatusIsAlarm
                                        ? '0 0 40px rgba(239,68,68,0.2), inset 0 0 30px rgba(239,68,68,0.1)'
                                        : !shoreDataFresh
                                          ? '0 0 30px rgba(245,158,11,0.08), inset 0 0 20px rgba(245,158,11,0.04)'
                                          : '0 0 30px rgba(16,185,129,0.1), inset 0 0 20px rgba(16,185,129,0.05)',
                                }}
                            >
                                <div className="text-center">
                                    <div
                                        className={`text-3xl font-black font-mono ${shoreStatusIsAlarm ? 'text-red-400' : 'text-white'}`}
                                    >
                                        {shoreData.distance.toFixed(0)}m
                                    </div>
                                    <div className="text-sm text-slate-400">
                                        {shoreDataFresh ? 'from anchor' : 'last-known from anchor'}
                                    </div>
                                </div>
                            </div>

                            {/* Status badge */}
                            <div
                                role="status"
                                aria-live="polite"
                                aria-atomic="true"
                                className={`px-5 py-2 rounded-full text-sm font-black tracking-wider uppercase mb-6 flex items-center gap-2 ${
                                    shoreStatusIsAlarm
                                        ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                                        : shoreDataFresh
                                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25'
                                          : 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
                                }`}
                            >
                                <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                        shoreStatusIsAlarm
                                            ? 'bg-red-400'
                                            : shoreDataFresh
                                              ? 'bg-emerald-400'
                                              : 'bg-amber-400'
                                    }`}
                                />
                                {shoreStatusLabel}
                            </div>

                            {/* Shore silence button — only shown during alarm */}
                            {shoreData.isAlarm && (
                                <button
                                    type="button"
                                    aria-label="Mute alarm on this device only"
                                    disabled={shoreAlarmMutedLocally}
                                    onClick={() => void handleMuteShoreAlarm()}
                                    className="px-8 py-3 rounded-2xl text-white text-base font-black mb-6 transition-all active:scale-95 disabled:opacity-70"
                                    style={{
                                        background: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
                                        boxShadow: '0 6px 24px rgba(220, 38, 38, 0.4)',
                                    }}
                                >
                                    <span className="inline-flex items-center gap-2 justify-center">
                                        <MuteIcon className="w-4 h-4" />
                                        <span>
                                            {shoreAlarmMutedLocally
                                                ? 'Muted on this device only'
                                                : 'Mute this device only'}
                                        </span>
                                    </span>
                                    <span className="block mt-1 text-[10px] font-semibold normal-case tracking-normal text-red-100/80">
                                        This only silences this device; it does not acknowledge or change the vessel
                                        alarm.
                                    </span>
                                </button>
                            )}

                            {/* Data cards — glassmorphism */}
                            <div className="grid grid-cols-2 gap-3 w-full max-w-sm">
                                <div
                                    className={`${t.colors.bg.inset} rounded-xl p-3 text-center ${t.colors.border.glass}`}
                                >
                                    <div className={t.typography.label}>Swing Radius</div>
                                    <div className="text-lg font-bold text-white">
                                        {formatDistance(shoreData.swingRadius)}
                                    </div>
                                </div>
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className={t.typography.label}>Rode</div>
                                    <div className="text-lg font-bold text-amber-400">
                                        {shoreData.config.rodeLength.toFixed(1)}m
                                    </div>
                                </div>
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className={t.typography.label}>Depth</div>
                                    <div className="text-lg font-bold text-sky-400">
                                        {shoreData.config.waterDepth.toFixed(1)}m
                                    </div>
                                </div>
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className={t.typography.label}>
                                        {shoreDataFresh ? 'Last Update' : 'Last-Known Update'}
                                    </div>
                                    <div className="text-lg font-bold text-white">
                                        {new Date(shoreData.timestamp).toLocaleTimeString([], {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="text-center">
                            <div className="w-12 h-12 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                            <div className="text-slate-400">Waiting for vessel data...</div>
                            <div className="text-sm text-slate-400 mt-2">Session: {syncState?.sessionCode}</div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // ---- RENDER: WATCHING ----
    const monitoringBlocked = snapshot?.state === 'paused';
    const foreignAccountRecovery = Boolean(
        monitoringBlocked && !snapshot?.anchorPosition && snapshot?.setupError?.includes('Account changed'),
    );
    const corruptConfigRecovery = Boolean(
        monitoringBlocked && snapshot?.setupError?.startsWith('Saved Anchor Watch is blocked'),
    );
    const isHolding = Boolean(snapshot && !monitoringBlocked && snapshot.distanceFromAnchor <= snapshot.swingRadius);
    const liveStatusLabel = monitoringBlocked ? 'Not Monitoring' : isHolding ? 'Holding' : 'Drifting';
    const holdPercent =
        snapshot && snapshot.swingRadius > 0
            ? Math.min(100, (snapshot.distanceFromAnchor / snapshot.swingRadius) * 100)
            : 0;

    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden pb-[98px]`}>
            <PageHeader
                title={monitoringBlocked ? 'Anchor Watch Blocked' : 'Anchor Deployed'}
                subtitle={
                    monitoringBlocked
                        ? 'Safety monitoring is not running'
                        : snapshot?.watchStartedAt
                          ? `${formatElapsed(snapshot.watchStartedAt)} elapsed`
                          : 'Monitoring...'
                }
                onBack={onBack}
                action={
                    <div className="flex items-center gap-2">
                        {/* Guardian status badge */}
                        {!monitoringBlocked && snapshot?.guardianStatus && snapshot.guardianStatus !== 'idle' && (
                            <div
                                className={`px-2 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 border ${
                                    snapshot.guardianStatus === 'armed' || snapshot.guardianStatus === 'already_armed'
                                        ? 'bg-emerald-500/[0.08] border-emerald-500/20 text-emerald-400'
                                        : snapshot.guardianStatus === 'arming'
                                          ? 'bg-sky-500/[0.08] border-sky-500/20 text-sky-400'
                                          : 'bg-red-500/[0.08] border-red-500/20 text-red-400'
                                }`}
                            >
                                <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                        snapshot.guardianStatus === 'armed' ||
                                        snapshot.guardianStatus === 'already_armed'
                                            ? 'bg-emerald-400'
                                            : snapshot.guardianStatus === 'arming'
                                              ? 'bg-sky-400 animate-pulse'
                                              : 'bg-red-400'
                                    }`}
                                />
                                {snapshot.guardianStatus === 'armed'
                                    ? 'Armed'
                                    : snapshot.guardianStatus === 'already_armed'
                                      ? 'Armed'
                                      : snapshot.guardianStatus === 'arming'
                                        ? 'Arming'
                                        : 'Failed'}
                            </div>
                        )}
                        {/* Hold status dot */}
                        <div
                            className={`w-3 h-3 rounded-full ${monitoringBlocked ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]' : isHolding ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'}`}
                        />
                    </div>
                }
            />

            {monitoringBlocked && (
                <div
                    role="alert"
                    className="mx-3 mt-1 shrink-0 rounded-2xl border-2 border-amber-300/60 bg-amber-950/90 px-4 py-3 shadow-[0_0_24px_rgba(245,158,11,0.18)]"
                >
                    <div className="flex items-start gap-3">
                        <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                        <div className="min-w-0">
                            <p className="text-sm font-black uppercase tracking-wider text-amber-200">
                                Not monitoring — act now
                            </p>
                            <p className="mt-1 text-sm font-semibold leading-snug text-amber-50">
                                {snapshot?.setupError ||
                                    'Anchor Watch could not confirm its GPS, geofence, audio, or recovery safety path.'}
                            </p>
                            <p className="mt-1 text-xs text-amber-200/80">
                                {snapshot?.anchorPosition && !corruptConfigRecovery
                                    ? 'The anchor position below is retained reference data only. Keep a physical watch until monitoring is restarted.'
                                    : foreignAccountRecovery
                                      ? 'Saved watch details belong to the previous account and remain hidden. Retry Weigh Anchor until cleanup is confirmed.'
                                      : 'Saved watch details are unavailable or corrupt. Use Weigh Anchor to clear the blocked recovery record.'}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Action Buttons — glassmorphism pills */}
            <div className="shrink-0 px-3 py-1.5 flex gap-2">
                {monitoringBlocked && snapshot?.anchorPosition && !corruptConfigRecovery ? (
                    <button
                        onClick={() => void handleRetryMonitoring()}
                        disabled={isRetryingMonitoring}
                        className="flex-1 rounded-xl border border-amber-300/40 bg-amber-500/15 py-3 text-sm font-black text-amber-100 transition-all active:scale-[0.97] disabled:cursor-wait disabled:opacity-60"
                        aria-label="Retry Anchor Watch monitoring"
                    >
                        {isRetryingMonitoring ? 'Retrying Safety Checks…' : 'Retry Monitoring'}
                    </button>
                ) : monitoringBlocked ? (
                    <div className="flex-1 rounded-xl border border-amber-300/30 bg-amber-500/10 px-3 py-3 text-center text-xs font-black text-amber-100">
                        {foreignAccountRecovery ? 'Previous account — cleanup only' : 'Blocked recovery — cleanup only'}
                    </div>
                ) : syncState?.connected ? (
                    <div className="flex-1 flex items-center justify-center gap-2 py-3 bg-sky-500/[0.08] border border-sky-500/20 rounded-xl">
                        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.5)]" />
                        <span className="text-sm text-sky-400 font-mono font-bold tracking-wider">
                            {syncState.sessionCode}
                        </span>
                        <span className="text-sm text-slate-400 uppercase">sharing</span>
                    </div>
                ) : (
                    <button
                        onClick={handleCreateSession}
                        className="flex-1 py-3 bg-sky-500/[0.08] border border-sky-500/20 rounded-xl text-sm text-sky-400 font-bold transition-all active:scale-[0.97] hover:bg-sky-500/[0.12]"
                        aria-label="Create Session"
                    >
                        <span className="inline-flex items-center gap-2 justify-center">
                            <PhoneIcon className="w-4 h-4" />
                            <span>{authedUser ? 'Shore Share' : 'Sign in to Shore Share'}</span>
                        </span>
                    </button>
                )}
                <button
                    onClick={() => {
                        const next = !showAisOnRadar;
                        setShowAisOnRadar(next);
                        try {
                            localStorage.setItem('thalassa_anchor_ais', next ? 'on' : 'off');
                        } catch (e) {
                            console.warn('Suppressed:', e);
                            /* */
                        }
                        triggerHaptic('light');
                    }}
                    disabled={monitoringBlocked}
                    className={`py-3 px-3 border rounded-xl text-sm font-bold transition-all active:scale-[0.97] disabled:hidden ${
                        showAisOnRadar
                            ? 'bg-sky-500/[0.12] border-sky-500/30 text-sky-400'
                            : 'bg-white/[0.03] border-white/[0.06] text-slate-500'
                    }`}
                    aria-label={showAisOnRadar ? 'Hide AIS targets' : 'Show AIS targets'}
                >
                    <PowerBoatIcon className="w-5 h-5 mx-auto" />
                </button>
                <button
                    onClick={handleStopWatch}
                    className={`flex-1 py-3 bg-red-500/[0.08] border border-red-500/20 rounded-xl text-red-400 text-sm font-bold transition-all active:scale-[0.97] hover:bg-red-500/[0.12]`}
                    aria-label="Stop Watch"
                >
                    ⏏ Weigh Anchor
                </button>
            </div>

            {/* Shore Disconnection Banner — visible when shore device drops */}
            {syncState?.connected && !syncState.peerConnected && syncState.sessionCode && (
                <div className="shrink-0 mx-3 mb-1.5 px-3 py-2 flex items-center gap-2 bg-amber-500/[0.08] border border-amber-500/25 rounded-xl animate-pulse">
                    <span className="w-2 h-2 bg-amber-400 rounded-full shrink-0" />
                    <span className="text-xs text-amber-400 font-bold flex-1 inline-flex items-center gap-1.5">
                        {!!syncState.peerDisconnectedAt && <AlertTriangleIcon className="w-3.5 h-3.5" />}
                        <span>
                            {syncState.peerDisconnectedAt
                                ? `Shore device disconnected · Lost ${formatElapsed(syncState.peerDisconnectedAt)} ago`
                                : 'Waiting for shore device…'}
                        </span>
                    </span>
                    <span className="text-xs text-amber-500/60">Waiting...</span>
                </div>
            )}

            {/* Main Card — gradient glass, fits available space */}
            <div className="flex-1 min-h-0 mx-3 mb-3 bg-gradient-to-b from-slate-900/70 to-slate-950/50 rounded-2xl border border-white/[0.07] flex flex-col overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.3)]">
                {/* Status Badge — animated with dot */}
                <div className="shrink-0 flex justify-center py-2">
                    <div
                        className={`px-6 py-1.5 rounded-full text-sm font-black tracking-widest uppercase transition-all flex items-center gap-2 ${
                            monitoringBlocked
                                ? 'bg-amber-500/15 border border-amber-300/40 text-amber-200'
                                : isHolding
                                  ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                                  : 'bg-red-500/10 border border-red-500/30 text-red-400 animate-pulse'
                        }`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full ${monitoringBlocked ? 'bg-amber-300' : isHolding ? 'bg-emerald-400' : 'bg-red-400'}`}
                        />
                        {liveStatusLabel}
                    </div>
                </div>

                {/* Canvas — fills available space */}
                <div className="flex-1 relative min-h-0">
                    <SwingCircleCanvas
                        snapshot={snapshot}
                        aisTargets={showAisOnRadar ? aisTargets : undefined}
                        ariaLabel={`Anchor watch radar display. ${monitoringBlocked ? 'Monitoring is blocked; values are retained reference data only' : isHolding ? 'Vessel holding position' : 'Vessel drifting'}. Current distance from anchor: ${snapshot ? formatDistance(snapshot.distanceFromAnchor) : 'unknown'}. Swing radius: ${snapshot ? formatDistance(snapshot.swingRadius) : 'unknown'}.`}
                    />
                </div>

                {/* Stats Grid — 2×3 */}
                <div className="shrink-0 px-2.5 pb-1.5">
                    <div className="grid grid-cols-3 gap-1.5">
                        {/* WHICH receiver the watch believes, not just how
                            accurate it is. 'BOAT' means the vessel's own GPS;
                            'PHONE' means this device — and if this device is
                            ashore, the swing circle is being measured from the
                            wrong place. Those two must never look alike
                            (Shane 2026-08-08, monitoring over Tailscale). */}
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.labelSm}>
                                {snapshot?.gpsSource === 'nmea' ? (
                                    <span className="text-cyan-300">⚓ BOAT GPS</span>
                                ) : snapshot?.gpsSource === 'native' ? (
                                    <span className="text-amber-300">📱 PHONE GPS</span>
                                ) : (
                                    'GPS'
                                )}
                            </div>
                            <div
                                className={`text-sm font-black font-mono ${(snapshot?.gpsAccuracy ?? 99) < 10 ? 'text-emerald-400' : (snapshot?.gpsAccuracy ?? 99) < 20 ? 'text-amber-400' : 'text-red-400'}`}
                            >
                                ±{snapshot?.gpsAccuracy.toFixed(0) ?? '--'}m
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.labelSm}>Bearing</div>
                            <div className="text-sm font-black font-mono text-slate-200">
                                {snapshot
                                    ? `${snapshot.bearingToAnchor.toFixed(0)}° ${bearingToCardinal(snapshot.bearingToAnchor)}`
                                    : `--`}
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.label}>Max Drift</div>
                            <div className="text-sm font-black font-mono text-slate-200">
                                {snapshot ? formatDistance(snapshot.maxDistanceRecorded) : `--`}
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.label}>Rode</div>
                            <div className="text-sm font-black font-mono text-amber-400">
                                {snapshot ? `${snapshot.config.rodeLength.toFixed(1)}m` : '--'}
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.label}>Depth</div>
                            <div className="text-sm font-black font-mono text-sky-400">
                                {snapshot ? `${snapshot.config.waterDepth.toFixed(1)}m` : '--'}
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.label}>Scope</div>
                            <div className="text-sm font-black font-mono text-slate-200">
                                {snapshot ? (snapshot.config.rodeLength / snapshot.config.waterDepth).toFixed(1) : `--`}
                                :1
                            </div>
                        </div>
                    </div>
                </div>

                {/* Distance / Radius — premium readout */}
                <div className="shrink-0 border-t border-white/[0.06] px-4 py-1.5 bg-slate-900/30">
                    <div className="flex items-center justify-around gap-4">
                        <div className="text-center flex-1">
                            <div className="text-xs text-slate-400 uppercase tracking-wider">
                                {monitoringBlocked ? 'Last-Known Distance' : 'Distance'}
                            </div>
                            <div
                                className={`text-xl font-black font-mono ${monitoringBlocked ? 'text-amber-300' : isHolding ? 'text-emerald-400' : 'text-red-400'}`}
                            >
                                {snapshot ? formatDistance(snapshot.distanceFromAnchor) : '--'}
                            </div>
                        </div>
                        <div className="w-px h-8 bg-gradient-to-b from-transparent via-white/10 to-transparent" />
                        <div className="text-center flex-1">
                            <div className="text-xs text-slate-400 uppercase tracking-wider">Radius</div>
                            <div className="text-xl font-black font-mono text-white">
                                {snapshot ? formatDistance(snapshot.swingRadius) : `--`}
                            </div>
                        </div>
                    </div>

                    {/* Gradient usage bar */}
                    <div className="mt-1.5 h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                                width: `${holdPercent}%`,
                                background:
                                    holdPercent > 85
                                        ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                                        : holdPercent > 60
                                          ? 'linear-gradient(90deg, #22c55e, #f59e0b)'
                                          : 'linear-gradient(90deg, #06b6d4, #22c55e)',
                            }}
                        />
                    </div>
                    <div className="flex justify-between text-xs text-slate-400 mt-0.5">
                        <span>Anchor</span>
                        <span className="font-bold font-mono">{holdPercent.toFixed(0)}%</span>
                        <span>Alarm</span>
                    </div>
                </div>
            </div>

            <SignInScreen
                isOpen={showShoreSignIn}
                onClose={() => setShowShoreSignIn(false)}
                prompt="Sign in to share Anchor Watch between your vessel and shore devices. Local Anchor Watch remains available without an account."
            />
        </div>
    );
});
