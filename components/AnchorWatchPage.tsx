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
import { AnchorAlarmOverlay } from './anchor-watch/AnchorAlarmOverlay';
import { ScopeRadar } from './anchor-watch/ScopeRadar';
import { SoundCheckModal } from './anchor-watch/SoundCheckModal';
import { ShoreWatchModal } from './anchor-watch/ShoreWatchModal';
import { AisStreamService } from '../services/AisStreamService';

import {
    navStatusColorSimple,
    getWeatherRecommendation,
    formatDistance,
    bearingToCardinal,
    formatElapsed,
} from './anchor-watch/anchorUtils';

// ------- TYPES -------

type ViewMode = 'setup' | 'watching' | 'shore';

interface AnchorWatchPageProps {
    onBack?: () => void;
}

// ------- MAIN COMPONENT -------

export const AnchorWatchPage: React.FC<AnchorWatchPageProps> = React.memo(({ onBack }) => {
    const { weatherData } = useWeather();
    const keyboardScrollRef = useKeyboardScroll<HTMLDivElement>();

    const [viewMode, setViewMode] = useState<ViewMode>('setup');
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot | null>(null);
    const [syncState, setSyncState] = useState<SyncState | null>(null);
    const [shoreData, setShoreData] = useState<PositionBroadcast | null>(null);

    // Setup form state
    const [rodeLength, setRodeLength] = useState(30);
    const [waterDepth, setWaterDepth] = useState(5);
    const [rodeType, setRodeType] = useState<'chain' | 'rope' | 'mixed'>('chain');
    const [safetyMargin, _setSafetyMargin] = useState(10);
    const [sessionCode, setSessionCode] = useState('');
    const [showShoreModal, setShowShoreModal] = useState(false);

    // Sound check modal — shown once per session before first anchor set
    const [showSoundCheck, setShowSoundCheck] = useState(false);
    const soundCheckShownRef = useRef(false);

    // AIS targets on anchor watch radar
    const [aisTargets, setAisTargets] = useState<AisTargetDot[]>([]);
    const [showAisOnRadar, setShowAisOnRadar] = useState(() => {
        try {
            return localStorage.getItem('thalassa_anchor_ais') !== 'off';
        } catch {
            return true;
        }
    });

    // Canvas ref no longer needed — SwingCircleCanvas manages its own ref

    // Track iOS keyboard height via visualViewport so the modal stays above the keyboard
    const [_keyboardOffset, setKeyboardOffset] = useState(0);
    useEffect(() => {
        if (!showShoreModal) {
            setKeyboardOffset(0);
            return;
        }
        const vv = window.visualViewport;
        if (!vv) return;
        const update = () => {
            // On iOS, when keyboard opens, visualViewport.height shrinks
            const offset = Math.max(0, window.innerHeight - vv.height);
            setKeyboardOffset(offset);
        };
        vv.addEventListener('resize', update);
        vv.addEventListener('scroll', update);
        return () => {
            vv.removeEventListener('resize', update);
            vv.removeEventListener('scroll', update);
        };
    }, [showShoreModal]);
    const [isSettingAnchor, setIsSettingAnchor] = useState(false);
    const [gpsStatus, setGpsStatus] = useState<string>('Waiting for GPS...');

    // Weather-smart rode recommendation
    const wxRecommendation = useMemo(() => {
        const wind = weatherData?.current?.windSpeed ?? 0;
        const gust = weatherData?.current?.windGust ?? 0;
        const waveFt = weatherData?.current?.waveHeight ?? 0; // already in feet from transformer
        const waveM = waveFt / 3.28084; // convert back to meters for scope thresholds
        const rec = getWeatherRecommendation(wind, gust, waveM);
        const recRode = Math.min(100, Math.round(rec.scope * waterDepth));
        return { ...rec, rode: recRode, wind, gust, wave: waveFt };
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
            }
        }, 60_000);
        return () => clearTimeout(timeout);
    }, [viewMode, shoreData]);

    // Shore alarm — trigger full alarm on shore watcher's phone when vessel drags
    const shoreAlarmActiveRef = useRef(false);
    useEffect(() => {
        if (viewMode !== 'shore') {
            // Stop alarm if we leave shore mode
            if (shoreAlarmActiveRef.current) {
                AlarmAudioService.stopAlarm();
                shoreAlarmActiveRef.current = false;
            }
            return;
        }

        if (shoreData?.isAlarm && !shoreAlarmActiveRef.current) {
            // Vessel is dragging — sound the alarm on shore phone
            shoreAlarmActiveRef.current = true;
            AlarmAudioService.startAlarm();
            triggerHaptic('heavy');

            // Repeat haptic every 2s while alarming
            const hapticInterval = setInterval(() => {
                triggerHaptic('heavy');
            }, 2000);

            return () => clearInterval(hapticInterval);
        } else if (!shoreData?.isAlarm && shoreAlarmActiveRef.current) {
            // Vessel back inside swing circle — silence
            AlarmAudioService.stopAlarm();
            shoreAlarmActiveRef.current = false;
        }
    }, [viewMode, shoreData?.isAlarm]);

    // Cleanup alarm on unmount
    useEffect(() => {
        return () => {
            if (shoreAlarmActiveRef.current) {
                AlarmAudioService.stopAlarm();
                shoreAlarmActiveRef.current = false;
            }
        };
    }, []);

    // Elapsed time ticker (once per minute)
    useEffect(() => {
        if (viewMode === 'watching' || viewMode === 'shore') {
            tickRef.current = setInterval(() => setTick((t) => t + 1), 60000);
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
            } catch {
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
        setGpsStatus('Acquiring GPS fix...');

        const config: Partial<AnchorWatchConfig> = {
            rodeLength,
            waterDepth,
            rodeType,
            safetyMargin,
            scopeRatio: rodeLength / waterDepth,
        };

        const success = await AnchorWatchService.setAnchor(config);
        setIsSettingAnchor(false);

        if (success) {
            setViewMode('watching');
        } else {
            setGpsStatus('GPS fix failed. Check location permissions.');
        }
    }, [rodeLength, waterDepth, rodeType, safetyMargin]);

    const handleStopWatch = useCallback(async () => {
        await AnchorWatchService.stopWatch();
        await AnchorWatchSyncService.leaveSession();
        setViewMode('setup');
        setShoreData(null);
    }, []);

    const handleAcknowledgeAlarm = useCallback(() => {
        AnchorWatchService.acknowledgeAlarm();
    }, []);

    const handleCreateSession = useCallback(async () => {
        const code = await AnchorWatchSyncService.createSession();
        if (code) setSessionCode(code);
    }, []);

    const handleJoinShore = useCallback(async () => {
        if (sessionCode.length !== 6) return;
        const joined = await AnchorWatchSyncService.joinSession(sessionCode);
        if (joined) setViewMode('shore');
    }, [sessionCode]);
    // Slide-to-confirm state (must be before any early returns — React Rules of Hooks)
    const slideTrackRef = useRef<HTMLDivElement>(null);
    const [slideX, setSlideX] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const slideThreshold = 0.85; // 85% to trigger

    const handleSlideStart = useCallback(
        (_clientX: number) => {
            if (isSettingAnchor) return;
            setIsDragging(true);
        },
        [isSettingAnchor],
    );

    const handleSlideMove = useCallback(
        (clientX: number) => {
            if (!isDragging || !slideTrackRef.current) return;
            const rect = slideTrackRef.current.getBoundingClientRect();
            const thumbWidth = 56;
            const maxTravel = rect.width - thumbWidth;
            const offset = clientX - rect.left - thumbWidth / 2;
            setSlideX(Math.max(0, Math.min(offset, maxTravel)));
        },
        [isDragging],
    );

    const handleSlideEnd = useCallback(() => {
        if (!isDragging || !slideTrackRef.current) return;
        setIsDragging(false);
        const rect = slideTrackRef.current.getBoundingClientRect();
        const thumbWidth = 56;
        const maxTravel = rect.width - thumbWidth;
        const ratio = slideX / maxTravel;
        if (ratio >= slideThreshold) {
            // Show sound check modal the first time, then go straight to anchor
            if (!soundCheckShownRef.current) {
                setShowSoundCheck(true);
            } else {
                handleSetAnchor();
            }
        }
        setSlideX(0);
    }, [isDragging, slideX, handleSetAnchor]);

    // Confirm and proceed from sound check modal
    const handleSoundCheckConfirm = useCallback(() => {
        soundCheckShownRef.current = true;
        setShowSoundCheck(false);
        handleSetAnchor();
    }, [handleSetAnchor]);

    // Reset slide position when not dragging
    useEffect(() => {
        if (!isDragging) setSlideX(0);
    }, [isDragging]);

    // ---- RENDER: ALARM OVERLAY ----
    if (snapshot?.state === 'alarm') {
        return <AnchorAlarmOverlay snapshot={snapshot} onAcknowledge={handleAcknowledgeAlarm} />;
    }
    // ---- RENDER: SETUP (IDLE) — Instrument-Grade Dashboard ----

    // Derived values for the scope quality indicator (used in context strip)
    const scopeRatio = rodeLength / Math.max(waterDepth, 0.1);
    const scopeQuality: 'excellent' | 'adequate' | 'poor' =
        scopeRatio >= 7 ? 'excellent' : scopeRatio >= 5 ? 'adequate' : 'poor';

    if (viewMode === 'setup') {
        return (
            <div
                ref={keyboardScrollRef}
                className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden`}
                style={{ overscrollBehaviorY: 'none' }}
            >
                {/* ── Header — consistent with other vessel pages ── */}
                <div className="shrink-0 px-4 pt-4 pb-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {onBack && (
                                <button
                                    onClick={onBack}
                                    aria-label="Go back"
                                    className="p-1.5 -ml-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    <svg
                                        className="w-5 h-5"
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
                            )}
                            <h1 className="text-xl font-extrabold text-white uppercase tracking-wider">Anchor Watch</h1>
                        </div>
                        {/* Shore toggle */}
                        <button
                            onClick={() => setShowShoreModal(true)}
                            className="px-3 py-1 rounded-lg text-xs font-bold text-slate-400 bg-slate-800/60 border border-white/[0.06] hover:text-slate-300 transition-colors"
                        >
                            Shore
                        </button>
                    </div>
                </div>

                {/* ── Content — single screen, no scroll ── */}
                <div className="flex-1 min-h-0 flex flex-col pb-[98px]">
                    {/* ── Hero: Scope Radar ── */}
                    <div className="flex-1 min-h-0 flex items-center justify-center px-4 py-2 relative">
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
                                    key={type}
                                    onClick={() => setRodeType(type)}
                                    className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${
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
                                        {rodeLength}m
                                    </span>
                                </div>
                                <input
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
                                onClick={() => setRodeLength(wxRecommendation.rode)}
                                className="flex-1 flex items-center gap-1.5 text-left group"
                                title={`Tap to set rode to ${wxRecommendation.rode}m (${wxRecommendation.scope}:1)`}
                            >
                                <span className="text-base">{wxRecommendation.icon}</span>
                                <div className="min-w-0">
                                    <div className="text-xs text-slate-300 font-bold truncate group-hover:text-white transition-colors">
                                        {wxRecommendation.label} · {wxRecommendation.wind.toFixed(0)}kts
                                    </div>
                                    <div className="text-[11px] text-slate-400 group-hover:text-slate-400 transition-colors">
                                        {rodeLength === wxRecommendation.rode
                                            ? `✓ ${wxRecommendation.scope}:1 set`
                                            : `Tap → ${wxRecommendation.rode}m`}
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
                                    onMouseDown={(e) => handleSlideStart(e.clientX)}
                                    onMouseMove={(e) => handleSlideMove(e.clientX)}
                                    onMouseUp={handleSlideEnd}
                                    onMouseLeave={handleSlideEnd}
                                    onTouchStart={(e) => handleSlideStart(e.touches[0].clientX)}
                                    onTouchMove={(e) => handleSlideMove(e.touches[0].clientX)}
                                    onTouchEnd={handleSlideEnd}
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
                                            background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                                            boxShadow:
                                                '0 4px 16px rgba(249,115,22,0.4), 0 0 20px rgba(249,115,22,0.15)',
                                            transition: isDragging ? 'none' : 'transform 0.3s ease',
                                        }}
                                    >
                                        <span className="text-lg">⚓</span>
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
        return (
            <div className="h-full bg-slate-950 flex flex-col">
                {/* Header — glassmorphism */}
                <div className="bg-gradient-to-r from-slate-900/80 via-slate-950/90 to-slate-900/80 border-b border-white/[0.06] px-4 py-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-lg font-black text-white flex items-center gap-2">
                                <span className="text-sky-400">📱</span> Shore Watch
                            </h1>
                            <p className="text-sm flex items-center gap-1.5 mt-0.5">
                                {syncState?.peerConnected ? (
                                    <>
                                        <span className="w-2 h-2 bg-emerald-500 rounded-full inline-block animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.5)]" />{' '}
                                        <span className="text-emerald-400">Vessel Connected</span>
                                    </>
                                ) : (
                                    <>
                                        <span className="w-2 h-2 bg-red-500 rounded-full inline-block animate-pulse" />{' '}
                                        <span className="text-red-400">Vessel Offline</span>
                                    </>
                                )}
                            </p>
                        </div>
                        <button
                            onClick={handleStopWatch}
                            className="px-3 py-1.5 bg-red-500/[0.08] border border-red-500/20 rounded-lg text-red-400 text-sm font-bold transition-all active:scale-95"
                            aria-label="Stop Watch"
                        >
                            Leave
                        </button>
                    </div>
                </div>

                {/* Vessel Disconnection Banner */}
                {!syncState?.peerConnected && (
                    <div className="shrink-0 mx-3 mt-1 px-3 py-2.5 flex items-center gap-2 bg-red-500/[0.08] border border-red-500/25 rounded-xl">
                        <span className="w-2.5 h-2.5 bg-red-500 rounded-full shrink-0 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.5)]" />
                        <span className="text-sm text-red-400 font-bold flex-1">
                            ⚠️ Vessel connection lost
                            {syncState?.peerDisconnectedAt
                                ? ` · ${formatElapsed(syncState.peerDisconnectedAt)} ago`
                                : ''}
                        </span>
                        <span className="text-xs text-red-500/50 animate-pulse">Reconnecting...</span>
                    </div>
                )}

                {/* Remote Data Display */}
                <div className="flex-1 p-4 flex flex-col items-center justify-center">
                    {shoreData ? (
                        <>
                            {/* Status circle with glow */}
                            <div
                                className={`w-36 h-36 rounded-full flex items-center justify-center mb-6 relative ${
                                    shoreData.isAlarm ? 'animate-pulse' : ''
                                }`}
                                style={{
                                    background: shoreData.isAlarm
                                        ? 'radial-gradient(circle, rgba(127,29,29,0.5) 0%, rgba(69,10,10,0.3) 70%, transparent 100%)'
                                        : 'radial-gradient(circle, rgba(6,78,59,0.3) 0%, rgba(6,78,59,0.1) 70%, transparent 100%)',
                                    border: `3px solid ${shoreData.isAlarm ? 'rgba(239,68,68,0.5)' : 'rgba(16,185,129,0.3)'}`,
                                    boxShadow: shoreData.isAlarm
                                        ? '0 0 40px rgba(239,68,68,0.2), inset 0 0 30px rgba(239,68,68,0.1)'
                                        : '0 0 30px rgba(16,185,129,0.1), inset 0 0 20px rgba(16,185,129,0.05)',
                                }}
                            >
                                <div className="text-center">
                                    <div
                                        className={`text-3xl font-black font-mono ${shoreData.isAlarm ? 'text-red-400' : 'text-white'}`}
                                    >
                                        {shoreData.distance.toFixed(0)}m
                                    </div>
                                    <div className="text-sm text-slate-400">from anchor</div>
                                </div>
                            </div>

                            {/* Status badge */}
                            <div
                                role="status"
                                aria-live="polite"
                                aria-atomic="true"
                                className={`px-5 py-2 rounded-full text-sm font-black tracking-wider uppercase mb-6 flex items-center gap-2 ${
                                    shoreData.isAlarm
                                        ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                                        : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25'
                                }`}
                            >
                                <span
                                    className={`w-1.5 h-1.5 rounded-full ${shoreData.isAlarm ? 'bg-red-400' : 'bg-emerald-400'}`}
                                />
                                {shoreData.isAlarm ? 'Drag Alarm' : 'Holding'}
                            </div>

                            {/* Shore silence button — only shown during alarm */}
                            {shoreData.isAlarm && shoreAlarmActiveRef.current && (
                                <button
                                    onClick={() => {
                                        AlarmAudioService.stopAlarm();
                                        shoreAlarmActiveRef.current = false;
                                        triggerHaptic('medium');
                                    }}
                                    className="px-8 py-3 rounded-2xl text-white text-base font-black mb-6 transition-all active:scale-95"
                                    style={{
                                        background: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
                                        boxShadow: '0 6px 24px rgba(220, 38, 38, 0.4)',
                                    }}
                                >
                                    🔇 Silence Alarm
                                </button>
                            )}

                            {/* Data cards — glassmorphism */}
                            <div className="grid grid-cols-2 gap-3 w-full max-w-sm">
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Swing Radius</div>
                                    <div className="text-lg font-bold text-white">
                                        {formatDistance(shoreData.swingRadius)}
                                    </div>
                                </div>
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Rode</div>
                                    <div className="text-lg font-bold text-amber-400">
                                        {shoreData.config.rodeLength}m
                                    </div>
                                </div>
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Depth</div>
                                    <div className="text-lg font-bold text-sky-400">{shoreData.config.waterDepth}m</div>
                                </div>
                                <div className="bg-slate-800/50 rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Last Update</div>
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
    const isHolding = snapshot && snapshot.distanceFromAnchor <= snapshot.swingRadius;
    const holdPercent =
        snapshot && snapshot.swingRadius > 0
            ? Math.min(100, (snapshot.distanceFromAnchor / snapshot.swingRadius) * 100)
            : 0;

    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden pb-[98px]`}>
            {/* Header — glassmorphism */}
            <div className={t.header.glass}>
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className={`${t.typography.pageTitle} flex items-center gap-2`}>
                            <span className="text-amber-400">⚓</span> Anchor Deployed
                        </h1>
                        <p className={`${t.typography.caption} font-mono`}>
                            {snapshot?.watchStartedAt
                                ? `${formatElapsed(snapshot.watchStartedAt)} elapsed`
                                : 'Monitoring...'}
                        </p>
                    </div>
                    <div
                        className={`w-3 h-3 rounded-full ${isHolding ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'}`}
                    />
                </div>
            </div>

            {/* Action Buttons — glassmorphism pills */}
            <div className="shrink-0 px-3 py-1.5 flex gap-2">
                {syncState?.connected ? (
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
                        📱 Shore Share
                    </button>
                )}
                <button
                    onClick={() => {
                        const next = !showAisOnRadar;
                        setShowAisOnRadar(next);
                        try {
                            localStorage.setItem('thalassa_anchor_ais', next ? 'on' : 'off');
                        } catch {
                            /* */
                        }
                        triggerHaptic('light');
                    }}
                    className={`py-3 px-3 border rounded-xl text-sm font-bold transition-all active:scale-[0.97] ${
                        showAisOnRadar
                            ? 'bg-sky-500/[0.12] border-sky-500/30 text-sky-400'
                            : 'bg-white/[0.03] border-white/[0.06] text-slate-500'
                    }`}
                    aria-label={showAisOnRadar ? 'Hide AIS targets' : 'Show AIS targets'}
                >
                    🚢
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
                    <span className="text-xs text-amber-400 font-bold flex-1">
                        ⚠️ Shore device disconnected
                        {syncState.peerDisconnectedAt
                            ? ` · Lost ${formatElapsed(syncState.peerDisconnectedAt)} ago`
                            : ''}
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
                            isHolding
                                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                                : 'bg-red-500/10 border border-red-500/30 text-red-400 animate-pulse'
                        }`}
                    >
                        <span className={`w-1.5 h-1.5 rounded-full ${isHolding ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        {isHolding ? 'Holding' : 'Drifting'}
                    </div>
                </div>

                {/* Canvas — fills available space */}
                <div className="flex-1 relative min-h-0">
                    <SwingCircleCanvas
                        snapshot={snapshot}
                        aisTargets={showAisOnRadar ? aisTargets : undefined}
                        ariaLabel={`Anchor watch radar display. ${isHolding ? 'Vessel holding position' : 'Vessel drifting'}. Current distance from anchor: ${snapshot ? formatDistance(snapshot.distanceFromAnchor) : 'unknown'}. Swing radius: ${snapshot ? formatDistance(snapshot.swingRadius) : 'unknown'}.`}
                    />
                </div>

                {/* Stats Grid — 2×3 */}
                <div className="shrink-0 px-2.5 pb-1.5">
                    <div className="grid grid-cols-3 gap-1.5">
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.labelSm}>GPS</div>
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
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Max Drift</div>
                            <div className="text-sm font-black font-mono text-slate-200">
                                {snapshot ? formatDistance(snapshot.maxDistanceRecorded) : `--`}
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Rode</div>
                            <div className="text-sm font-black font-mono text-amber-400">
                                {snapshot?.config.rodeLength ?? `--`}m
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Depth</div>
                            <div className="text-sm font-black font-mono text-sky-400">
                                {snapshot?.config.waterDepth ?? `--`}m
                            </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Scope</div>
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
                            <div className="text-xs text-slate-400 uppercase tracking-wider">Distance</div>
                            <div
                                className={`text-xl font-black font-mono ${isHolding ? 'text-emerald-400' : 'text-red-400'}`}
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
        </div>
    );
});
