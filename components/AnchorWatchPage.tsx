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
import {
    AnchorWatchService,
    type AnchorWatchSnapshot,
    type AnchorWatchConfig,
} from '../services/AnchorWatchService';
import {
    AnchorWatchSyncService,
    type SyncState,
    type SyncBroadcast,
    type PositionBroadcast,
} from '../services/AnchorWatchSyncService';

// ------- TYPES -------

type ViewMode = 'setup' | 'watching' | 'shore';

interface AnchorWatchPageProps {
    onBack?: () => void;
}

// ------- HELPERS -------

/** Compute weather-aware scope recommendation */
function getWeatherRecommendation(windKts: number, gustKts: number, waveM: number) {
    const effectiveWind = Math.max(windKts, gustKts * 0.85);
    if (effectiveWind >= 30 || waveM >= 3) {
        return { scope: 10, label: 'Storm Scope', severity: 'red' as const, icon: '🌊' };
    }
    if (effectiveWind >= 20 || waveM >= 2) {
        return { scope: 8, label: 'Strong Wind', severity: 'amber' as const, icon: '💨' };
    }
    if (effectiveWind >= 10 || waveM >= 1) {
        return { scope: 7, label: 'Moderate', severity: 'sky' as const, icon: '🌬️' };
    }
    return { scope: 5, label: 'Light Air', severity: 'emerald' as const, icon: '☀️' };
}

/** Format meters to human-readable */
function formatDistance(meters: number): string {
    if (meters < 1000) return `${meters.toFixed(0)}m`;
    return `${(meters / 1852).toFixed(2)} NM`;
}

/** Format bearing to compass cardinal */
function bearingToCardinal(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

/** Format elapsed time since timestamp */
function formatElapsed(startMs: number): string {
    const elapsed = Date.now() - startMs;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// ------- MAIN COMPONENT -------

export const AnchorWatchPage: React.FC<AnchorWatchPageProps> = ({ onBack }) => {
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
    const [safetyMargin, setSafetyMargin] = useState(10);
    const [sessionCode, setSessionCode] = useState('');
    const [showShoreModal, setShowShoreModal] = useState(false);

    // Track iOS keyboard height via visualViewport so the modal stays above the keyboard
    const [keyboardOffset, setKeyboardOffset] = useState(0);
    useEffect(() => {
        if (!showShoreModal) { setKeyboardOffset(0); return; }
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

    // Canvas ref for swing circle
    const canvasRef = useRef<HTMLCanvasElement>(null);

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

        return () => { unsubState(); unsubBroadcast(); };
    }, []);

    // Elapsed time ticker (once per minute)
    useEffect(() => {
        if (viewMode === 'watching' || viewMode === 'shore') {
            tickRef.current = setInterval(() => setTick(t => t + 1), 60000);
        }
        return () => { if (tickRef.current) clearInterval(tickRef.current); };
    }, [viewMode]);

    // Keep a ref to the latest snapshot so the broadcast interval always has fresh data
    const snapshotRef = useRef(snapshot);
    useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);

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

    // Draw premium radar-style swing circle visualization
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !snapshot?.anchorPosition) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = rect.height;
        const cx = W / 2;
        const cy = H / 2;
        const isAlarm = snapshot.state === 'alarm';

        // Clear
        ctx.clearRect(0, 0, W, H);

        // Scale: fit swing radius + margin into canvas
        const displayRadius = Math.min(W, H) * 0.35;
        const scale = snapshot.swingRadius > 0 ? displayRadius / snapshot.swingRadius : 1;

        // ── Ocean depth background gradient ──
        const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
        bgGrad.addColorStop(0, 'rgba(8, 47, 73, 0.4)');
        bgGrad.addColorStop(0.5, 'rgba(7, 33, 54, 0.25)');
        bgGrad.addColorStop(1, 'rgba(2, 6, 23, 0.1)');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // ── Compass rose tick marks ──
        const numTicks = 36;
        for (let i = 0; i < numTicks; i++) {
            const angle = (i * 360 / numTicks - 90) * Math.PI / 180;
            const isMajor = i % 9 === 0;
            const isMinor = i % 3 === 0;
            const innerR = displayRadius + (isMajor ? 12 : isMinor ? 16 : 18);
            const outerR = displayRadius + 22;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
            ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
            ctx.strokeStyle = isMajor ? 'rgba(148, 163, 184, 0.5)' : 'rgba(100, 116, 139, 0.2)';
            ctx.lineWidth = isMajor ? 1.5 : 0.5;
            ctx.stroke();
        }

        // ── Compass cardinal labels ──
        const labelOffset = displayRadius + 32;
        ctx.font = 'bold 13px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const cardinals = [
            { label: 'N', angle: -90, color: 'rgba(248, 113, 113, 0.8)' },
            { label: 'E', angle: 0, color: 'rgba(148, 163, 184, 0.5)' },
            { label: 'S', angle: 90, color: 'rgba(148, 163, 184, 0.5)' },
            { label: 'W', angle: 180, color: 'rgba(148, 163, 184, 0.5)' },
        ];
        cardinals.forEach(({ label, angle, color }) => {
            const rad = angle * Math.PI / 180;
            ctx.fillStyle = color;
            ctx.fillText(label, cx + Math.cos(rad) * labelOffset, cy + Math.sin(rad) * labelOffset);
        });

        // ── Color-coded zone bands ──
        // Green safe zone: 0 → 85% of swing radius
        const safeZoneGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, displayRadius * 0.85);
        safeZoneGrad.addColorStop(0, isAlarm ? 'rgba(239, 68, 68, 0.03)' : 'rgba(34, 197, 94, 0.06)');
        safeZoneGrad.addColorStop(0.7, isAlarm ? 'rgba(239, 68, 68, 0.04)' : 'rgba(34, 197, 94, 0.08)');
        safeZoneGrad.addColorStop(1, isAlarm ? 'rgba(239, 68, 68, 0.06)' : 'rgba(34, 197, 94, 0.12)');
        ctx.beginPath();
        ctx.arc(cx, cy, displayRadius * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = safeZoneGrad;
        ctx.fill();

        // Green safe zone border ring at 85%
        ctx.beginPath();
        ctx.arc(cx, cy, displayRadius * 0.85, 0, Math.PI * 2);
        ctx.strokeStyle = isAlarm ? 'rgba(239, 68, 68, 0.12)' : 'rgba(34, 197, 94, 0.2)';
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Amber caution band: 85% → 100% of swing radius
        ctx.beginPath();
        ctx.arc(cx, cy, displayRadius, 0, Math.PI * 2);
        ctx.arc(cx, cy, displayRadius * 0.85, 0, Math.PI * 2, true); // cut out inner
        ctx.fillStyle = isAlarm ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.07)';
        ctx.fill();

        // Red alarm halo: 100% → 120% (danger zone beyond boundary)
        ctx.beginPath();
        ctx.arc(cx, cy, displayRadius * 1.2, 0, Math.PI * 2);
        ctx.arc(cx, cy, displayRadius, 0, Math.PI * 2, true);
        ctx.fillStyle = isAlarm ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.03)';
        ctx.fill();

        // Swing radius boundary ring (solid, prominent)
        ctx.beginPath();
        ctx.arc(cx, cy, displayRadius, 0, Math.PI * 2);
        ctx.strokeStyle = isAlarm ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.4)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Subtle 50% reference ring (no label)
        ctx.beginPath();
        ctx.arc(cx, cy, displayRadius * 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(71, 85, 105, 0.12)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // ── Anchor icon at center ──
        ctx.font = '18px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
        ctx.fillText('⚓', cx, cy);

        // ── Position history trail — gradient heat map ──
        if (snapshot.positionHistory.length > 1 && snapshot.anchorPosition) {
            const histLen = snapshot.positionHistory.length;
            for (let i = 1; i < histLen; i++) {
                const prev = snapshot.positionHistory[i - 1];
                const curr = snapshot.positionHistory[i];
                const pDx = (prev.longitude - snapshot.anchorPosition!.longitude) * 111320 * Math.cos(snapshot.anchorPosition!.latitude * Math.PI / 180);
                const pDy = (prev.latitude - snapshot.anchorPosition!.latitude) * 110540;
                const cDx = (curr.longitude - snapshot.anchorPosition!.longitude) * 111320 * Math.cos(snapshot.anchorPosition!.latitude * Math.PI / 180);
                const cDy = (curr.latitude - snapshot.anchorPosition!.latitude) * 110540;

                const t = i / histLen; // 0=old, 1=new
                const alpha = 0.15 + t * 0.55;

                ctx.beginPath();
                ctx.moveTo(cx + pDx * scale, cy - pDy * scale);
                ctx.lineTo(cx + cDx * scale, cy - cDy * scale);

                // Green→Sky→Red heat map based on recency
                const r = Math.round(56 + t * 183);
                const g = Math.round(189 - t * 121);
                const b = Math.round(248 - t * 200);
                ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
                ctx.lineWidth = 1 + t * 1.5;
                ctx.stroke();
            }
        }

        // ── Vessel position with glowing marker ──
        if (snapshot.vesselPosition && snapshot.anchorPosition) {
            const dx = (snapshot.vesselPosition.longitude - snapshot.anchorPosition.longitude) * 111320 * Math.cos(snapshot.anchorPosition.latitude * Math.PI / 180);
            const dy = (snapshot.vesselPosition.latitude - snapshot.anchorPosition.latitude) * 110540;
            const vx = cx + dx * scale;
            const vy = cy - dy * scale;

            // Outer glow pulse
            const pulseSize = 18 + Math.sin(Date.now() / 400) * 4;
            const outerGlow = ctx.createRadialGradient(vx, vy, 0, vx, vy, pulseSize);
            if (isAlarm) {
                outerGlow.addColorStop(0, 'rgba(239, 68, 68, 0.3)');
                outerGlow.addColorStop(1, 'rgba(239, 68, 68, 0)');
            } else {
                outerGlow.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
                outerGlow.addColorStop(1, 'rgba(56, 189, 248, 0)');
            }
            ctx.beginPath();
            ctx.arc(vx, vy, pulseSize, 0, Math.PI * 2);
            ctx.fillStyle = outerGlow;
            ctx.fill();

            // Inner ring
            ctx.beginPath();
            ctx.arc(vx, vy, 8, 0, Math.PI * 2);
            ctx.strokeStyle = isAlarm ? 'rgba(239, 68, 68, 0.6)' : 'rgba(56, 189, 248, 0.5)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Core dot
            ctx.beginPath();
            ctx.arc(vx, vy, 4, 0, Math.PI * 2);
            const coreGrad = ctx.createRadialGradient(vx, vy, 0, vx, vy, 4);
            coreGrad.addColorStop(0, isAlarm ? '#fca5a5' : '#7dd3fc');
            coreGrad.addColorStop(1, isAlarm ? '#ef4444' : '#38bdf8');
            ctx.fillStyle = coreGrad;
            ctx.fill();

            // GPS accuracy circle
            if (snapshot.gpsAccuracy > 0) {
                const accRadius = snapshot.gpsAccuracy * scale;
                ctx.beginPath();
                ctx.arc(vx, vy, accRadius, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
                ctx.lineWidth = 0.5;
                ctx.setLineDash([2, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

    }, [snapshot?.vesselPosition?.timestamp, snapshot?.state, snapshot?.swingRadius]);

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

    // ---- RENDER: ALARM OVERLAY ----
    if (snapshot?.state === 'alarm') {
        return (
            <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
                style={{ background: 'radial-gradient(circle at center, #450a0a 0%, #1c0505 50%, #0a0202 100%)' }}>
                {/* Animated concentric pulse rings */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                    {[0, 1, 2].map(i => (
                        <div key={i}
                            className="absolute rounded-full border-2 border-red-500/20 animate-ping"
                            style={{
                                width: `${200 + i * 120}px`, height: `${200 + i * 120}px`,
                                top: '50%', left: '50%',
                                transform: 'translate(-50%, -50%)',
                                animationDelay: `${i * 0.4}s`,
                                animationDuration: '2s',
                            }}
                        />
                    ))}
                </div>

                {/* Alarm icon with glow */}
                <div className="text-8xl mb-6 drop-shadow-[0_0_30px_rgba(239,68,68,0.5)]" style={{ animation: 'pulse 1s ease-in-out infinite' }}>
                    🚨
                </div>

                {/* DRAG ALARM heading */}
                <h1 className="text-4xl font-black text-red-400 tracking-[0.2em] mb-4 uppercase"
                    style={{ textShadow: '0 0 30px rgba(239,68,68,0.4)' }}
                    role="alert" aria-live="assertive">
                    Drag Alarm
                </h1>

                {/* Distance readout */}
                <div className="text-center mb-8">
                    <div className="text-7xl font-mono font-black text-white mb-1"
                        style={{ textShadow: '0 0 20px rgba(255,255,255,0.2)' }}>
                        {formatDistance(snapshot.distanceFromAnchor)}
                    </div>
                    <div className="text-lg text-red-300/80">
                        from anchor ({formatDistance(snapshot.swingRadius)} radius)
                    </div>
                    <div className="text-sm text-red-400/60 mt-2 font-mono">
                        {snapshot.bearingToAnchor.toFixed(0)}° {bearingToCardinal(snapshot.bearingToAnchor)} to anchor
                    </div>
                </div>

                {/* Bearing compass — gradient ring */}
                <div className="w-24 h-24 rounded-full flex items-center justify-center mb-8 relative"
                    style={{ background: 'conic-gradient(from 0deg, rgba(239,68,68,0.1), rgba(239,68,68,0.3), rgba(239,68,68,0.1))', border: '3px solid rgba(239,68,68,0.3)' }}>
                    <div
                        className="absolute w-1 h-10 rounded-full origin-bottom"
                        style={{
                            transform: `rotate(${snapshot.bearingToAnchor}deg)`,
                            bottom: '50%', left: 'calc(50% - 2px)',
                            background: 'linear-gradient(to top, transparent, #ef4444)',
                        }}
                    />
                    <span className="text-sm text-red-400/80 font-bold">⚓</span>
                </div>

                {/* Silence button — premium gradient */}
                <button
                    onClick={handleAcknowledgeAlarm}
                    className="px-10 py-4 rounded-2xl text-white text-xl font-black transition-all active:scale-95"
                    style={{
                        background: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
                        boxShadow: '0 8px 32px rgba(220, 38, 38, 0.4), 0 0 60px rgba(220, 38, 38, 0.2)',
                    }}
                    aria-label="Acknowledge Alarm">
                    Silence Alarm
                </button>

                <p className="text-red-400/40 text-sm mt-4 tracking-wider">
                    Monitoring continues after silencing
                </p>
            </div>
        );
    }

    // ---- RENDER: SETUP (IDLE) ----
    if (viewMode === 'setup') {
        return (
            <div ref={keyboardScrollRef} className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden`} style={{ overscrollBehaviorY: 'none' }}>
                {/* Header — compact */}
                <div className={t.header.bar}>
                    <h1 className={`${t.typography.pageTitle} flex items-center gap-2`}>
                        ⚓ Anchor Watch
                    </h1>
                </div>

                {/* Content area — fills available space, no scroll */}
                <div className="flex-1 min-h-0 flex flex-col p-3 pb-[113px] gap-2">
                    {/* Shore Watch Button — full width, outside card */}
                    <button
                        onClick={() => setShowShoreModal(true)}
                        className={`w-full py-3 ${t.colors.accent.sky.bg} backdrop-blur border ${t.colors.accent.sky.border} rounded-lg ${t.colors.accent.sky.text} text-sm font-bold flex items-center justify-center gap-2 transition-all ${t.animation.press} hover:bg-sky-500/20`}
                    >
                        <span>📱</span> Shore Watch
                    </button>

                    {/* Ground Tackle Configuration */}
                    <div className={t.card.base}>
                        <h3 className={`${t.typography.sectionTitle} mb-1.5 flex items-center gap-1.5`}>
                            <span className="text-amber-400">⛓</span>
                            Ground Tackle
                        </h3>

                        {/* Rode Type */}
                        <div className="mb-2">
                            <div className="flex gap-1.5">
                                {(['chain', 'rope', 'mixed'] as const).map(type => (
                                    <button
                                        key={type}
                                        onClick={() => setRodeType(type)}
                                        className={`flex-1 py-1.5 rounded-lg text-sm font-bold capitalize transition-all ${rodeType === type
                                            ? 'bg-amber-500/30 border border-amber-500/60 text-amber-400'
                                            : `bg-slate-800/60 ${t.border.subtle} text-slate-500`
                                            }`}
                                    >
                                        {type === 'chain' ? '⛓ Chain' : type === 'rope' ? '🪢 Rope' : '🔗 Mixed'}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Rode Length */}
                        <div className="mb-2">
                            <div className="flex justify-between items-center mb-0.5">
                                <label className="text-sm text-slate-400">Rode Deployed</label>
                                <span className="text-sm font-black text-white font-mono">{rodeLength}m</span>
                            </div>
                            <input
                                type="range"
                                min={5}
                                max={100}
                                step={1}
                                value={rodeLength}
                                onChange={e => setRodeLength(Number(e.target.value))}
                                className="w-full h-1.5 bg-slate-800/50 rounded-full accent-amber-500 appearance-none cursor-pointer"
                                style={{ touchAction: 'none' }}
                            />
                            {/* Recommended scope notches */}
                            <div className="relative w-full h-3 mt-0.5">
                                <span
                                    className="absolute text-sm text-amber-500/60 -translate-x-1/2"
                                    style={{ left: `${((waterDepth * 5 - 5) / 95) * 100}%` }}
                                >
                                    ▲ 5:1
                                </span>
                                <span
                                    className="absolute text-sm text-emerald-500/60 -translate-x-1/2"
                                    style={{ left: `${Math.min(100, ((waterDepth * 7 - 5) / 95) * 100)}%` }}
                                >
                                    ▲ 7:1
                                </span>
                            </div>
                        </div>

                        {/* Water Depth */}
                        <div className="mb-2">
                            <div className="flex justify-between items-center mb-0.5">
                                <label className="text-sm text-slate-400">Water Depth</label>
                                <span className="text-sm font-black text-white font-mono">{waterDepth}m</span>
                            </div>
                            <input
                                type="range"
                                min={1}
                                max={30}
                                step={0.5}
                                value={waterDepth}
                                onChange={e => setWaterDepth(Number(e.target.value))}
                                className="w-full h-1.5 bg-slate-800/50 rounded-full accent-sky-500 appearance-none cursor-pointer"
                                style={{ touchAction: 'none' }}
                            />
                        </div>

                        {/* Scope & Radius Preview — pushed to bottom of card */}
                        <div className="grid grid-cols-2 gap-2">
                            <div className={t.card.inset}>
                                <div className="text-sm text-slate-400 uppercase">Scope</div>
                                <div className="text-base font-black text-white">{(rodeLength / Math.max(waterDepth, 0.1)).toFixed(1)}:1</div>
                                <div className={`text-sm font-bold ${rodeLength / waterDepth >= 7 ? 'text-emerald-400' : rodeLength / waterDepth >= 5 ? 'text-amber-400' : 'text-red-400'}`}>
                                    {rodeLength / waterDepth >= 7 ? 'Excellent' : rodeLength / waterDepth >= 5 ? 'Adequate' : 'Poor'}
                                </div>
                            </div>
                            <div className={t.card.inset}>
                                <div className="text-sm text-slate-400 uppercase">Swing Radius</div>
                                <div className="text-base font-black text-sky-400">
                                    {formatDistance(
                                        Math.sqrt(Math.max(0, rodeLength * rodeLength - waterDepth * waterDepth)) *
                                        (rodeType === 'chain' ? 0.85 : rodeType === 'rope' ? 0.95 : 0.90) +
                                        safetyMargin
                                    )}
                                </div>
                                <div className="text-sm text-slate-400">alarm boundary</div>
                            </div>
                        </div>
                    </div>

                    {/* Weather Recommends Card — fixed height */}
                    {weatherData?.current && (
                        <div className={`shrink-0 bg-slate-900/70 rounded-xl border p-2 ${wxRecommendation.severity === 'red' ? 'border-red-500/30' :
                            wxRecommendation.severity === 'amber' ? 'border-amber-500/20' :
                                wxRecommendation.severity === 'sky' ? 'border-sky-500/20' :
                                    'border-emerald-500/20'
                            }`}>
                            <h3 className={`${t.typography.sectionTitle} mb-1 flex items-center gap-1.5`}>
                                <span>{wxRecommendation.icon}</span>
                                Weather Recommends
                                <span className={`ml-auto text-sm font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${wxRecommendation.severity === 'red' ? 'bg-red-500/20 text-red-400' :
                                    wxRecommendation.severity === 'amber' ? 'bg-amber-500/20 text-amber-400' :
                                        wxRecommendation.severity === 'sky' ? 'bg-sky-500/20 text-sky-400' :
                                            'bg-emerald-500/20 text-emerald-400'
                                    }`}>{wxRecommendation.label}</span>
                            </h3>

                            <div className="grid grid-cols-3 gap-1.5 mb-1.5">
                                <div className={t.card.inset}>
                                    <div className={`${t.typography.labelSm}`}>Wind</div>
                                    <div className={`${t.typography.dataSm}`}>{wxRecommendation.wind.toFixed(0)}<span className={t.typography.unit}>kts</span></div>
                                </div>
                                <div className={t.card.inset}>
                                    <div className={`${t.typography.labelSm}`}>Gusts</div>
                                    <div className={`${t.typography.dataSm}`}>{wxRecommendation.gust.toFixed(0)}<span className={t.typography.unit}>kts</span></div>
                                </div>
                                <div className={t.card.inset}>
                                    <div className={`${t.typography.labelSm}`}>Waves</div>
                                    <div className={`${t.typography.dataSm}`}>{wxRecommendation.wave.toFixed(1)}<span className={t.typography.unit}>ft</span></div>
                                </div>
                            </div>

                            <button
                                onClick={() => setRodeLength(wxRecommendation.rode)}
                                className={`w-full py-3 rounded-lg text-sm font-bold transition-all active:scale-[0.97] flex items-center justify-center gap-2 ${rodeLength === wxRecommendation.rode
                                    ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400'
                                    : `bg-white/5 ${t.border.default} text-white hover:bg-white/10`
                                    }`}
                            >
                                {rodeLength === wxRecommendation.rode ? (
                                    <>✓ Rode set to {wxRecommendation.rode}m ({wxRecommendation.scope}:1 scope)</>
                                ) : (
                                    <>Set Rode to {wxRecommendation.rode}m — {wxRecommendation.scope}:1 scope</>
                                )}
                            </button>
                        </div>
                    )}

                    {/* Drop Anchor Button — pushed to bottom */}
                    <div className="mt-auto pt-2">
                        <button
                            onClick={handleSetAnchor}
                            disabled={isSettingAnchor}
                            className={t.button.primary}
                            aria-label="Set Anchor">
                            {isSettingAnchor ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm">{gpsStatus}</span>
                                </>
                            ) : (
                                <>⚓ Drop Anchor</>
                            )}
                        </button>
                    </div>
                </div>

                {/* Shore Watch Modal */}
                {
                    showShoreModal && (
                        <div
                            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex flex-col items-center"
                            style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 108px)' }}
                            onClick={() => setShowShoreModal(false)}
                        >
                            <div
                                className="w-[calc(100%-1.5rem)] max-w-md bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl"
                                onClick={e => e.stopPropagation()}
                            >
                                {/* Modal Header */}
                                <div className={t.modal.header}>
                                    <div className="flex items-center gap-2">
                                        <span className="text-sky-400 text-lg">📱</span>
                                        <h2 className="text-base font-black text-white tracking-tight">Shore Watch</h2>
                                    </div>
                                    <button
                                        onClick={() => setShowShoreModal(false)}
                                        className={t.modal.close}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>
                                </div>

                                {/* Modal Content */}
                                <div className={t.modal.body}>
                                    <p className="text-sm text-slate-400 leading-relaxed">
                                        Monitor your vessel`s anchor from shore. Enter the <span className="text-white font-bold">6-digit session code</span> displayed on the vessel device to connect.
                                    </p>

                                    {/* How it works */}
                                    <div className="space-y-2">
                                        <p className="text-sm font-bold text-slate-500 uppercase tracking-widest">How it works</p>
                                        <div className="space-y-1.5">
                                            <div className="flex items-start gap-2">
                                                <span className="text-emerald-400 text-sm mt-px">1.</span>
                                                <p className="text-sm text-slate-300">Start Anchor Watch on the vessel device</p>
                                            </div>
                                            <div className="flex items-start gap-2">
                                                <span className="text-emerald-400 text-sm mt-px">2.</span>
                                                <p className="text-sm text-slate-300">Note the 6-digit code shown on screen</p>
                                            </div>
                                            <div className="flex items-start gap-2">
                                                <span className="text-emerald-400 text-sm mt-px">3.</span>
                                                <p className="text-sm text-slate-300">Enter the code below to monitor remotely</p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Divider */}
                                    <div className="border-t border-white/5" />

                                    {/* Code entry */}
                                    <div>
                                        <p className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-2">Session Code</p>
                                        <div className="flex gap-2 items-center">
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                maxLength={6}
                                                placeholder="000000"
                                                value={sessionCode}
                                                onChange={e => setSessionCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                                className={`flex-1 min-w-0 ${t.input.code} text-lg`}
                                                autoFocus
                                            />
                                            <button
                                                onClick={() => {
                                                    handleJoinShore();
                                                    setShowShoreModal(false);
                                                }}
                                                disabled={sessionCode.length !== 6}
                                                className="shrink-0 px-5 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-lg text-white text-sm font-bold transition-all disabled:opacity-30 active:scale-95"
                                            >
                                                Join
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                }
            </div >
        );
    }

    // ---- RENDER: SHORE MODE ----
    if (viewMode === 'shore') {
        return (
            <div className="h-full bg-slate-950 flex flex-col">
                {/* Header — glassmorphism */}
                <div className="bg-gradient-to-r from-slate-900/80 via-slate-950/90 to-slate-900/80 backdrop-blur-xl border-b border-white/[0.06] px-4 py-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-lg font-black text-white flex items-center gap-2">
                                <span className="text-sky-400">📱</span> Shore Watch
                            </h1>
                            <p className="text-sm flex items-center gap-1.5 mt-0.5">
                                {syncState?.peerConnected ? (
                                    <><span className="w-2 h-2 bg-emerald-500 rounded-full inline-block animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.5)]" /> <span className="text-emerald-400">Vessel Connected</span></>
                                ) : (
                                    <><span className="w-2 h-2 bg-red-500 rounded-full inline-block" /> <span className="text-red-400">Vessel Offline</span></>
                                )}
                            </p>
                        </div>
                        <button
                            onClick={handleStopWatch}
                            className="px-3 py-1.5 bg-red-500/[0.08] backdrop-blur border border-red-500/20 rounded-lg text-red-400 text-sm font-bold transition-all active:scale-95"
                            aria-label="Stop Watch">
                            Leave
                        </button>
                    </div>
                </div>

                {/* Remote Data Display */}
                <div className="flex-1 p-4 flex flex-col items-center justify-center">
                    {shoreData ? (
                        <>
                            {/* Status circle with glow */}
                            <div className={`w-36 h-36 rounded-full flex items-center justify-center mb-6 relative ${shoreData.isAlarm
                                ? 'animate-pulse'
                                : ''
                                }`}
                                style={{
                                    background: shoreData.isAlarm
                                        ? 'radial-gradient(circle, rgba(127,29,29,0.5) 0%, rgba(69,10,10,0.3) 70%, transparent 100%)'
                                        : 'radial-gradient(circle, rgba(6,78,59,0.3) 0%, rgba(6,78,59,0.1) 70%, transparent 100%)',
                                    border: `3px solid ${shoreData.isAlarm ? 'rgba(239,68,68,0.5)' : 'rgba(16,185,129,0.3)'}`,
                                    boxShadow: shoreData.isAlarm
                                        ? '0 0 40px rgba(239,68,68,0.2), inset 0 0 30px rgba(239,68,68,0.1)'
                                        : '0 0 30px rgba(16,185,129,0.1), inset 0 0 20px rgba(16,185,129,0.05)',
                                }}>
                                <div className="text-center">
                                    <div className={`text-3xl font-black font-mono ${shoreData.isAlarm ? 'text-red-400' : 'text-white'}`}>
                                        {shoreData.distance.toFixed(0)}m
                                    </div>
                                    <div className="text-sm text-slate-400">from anchor</div>
                                </div>
                            </div>

                            {/* Status badge */}
                            <div role="status" aria-live="polite" aria-atomic="true" className={`px-5 py-2 rounded-full text-sm font-black tracking-wider uppercase mb-6 flex items-center gap-2 ${shoreData.isAlarm
                                ? 'bg-red-500/10 text-red-400 border border-red-500/30'
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25'
                                }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${shoreData.isAlarm ? 'bg-red-400' : 'bg-emerald-400'}`} />
                                {shoreData.isAlarm ? 'Drag Alarm' : 'Holding'}
                            </div>

                            {/* Data cards — glassmorphism */}
                            <div className="grid grid-cols-2 gap-3 w-full max-w-sm">
                                <div className="bg-slate-800/50 backdrop-blur rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Swing Radius</div>
                                    <div className="text-lg font-bold text-white">{formatDistance(shoreData.swingRadius)}</div>
                                </div>
                                <div className="bg-slate-800/50 backdrop-blur rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Rode</div>
                                    <div className="text-lg font-bold text-amber-400">{shoreData.config.rodeLength}m</div>
                                </div>
                                <div className="bg-slate-800/50 backdrop-blur rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Depth</div>
                                    <div className="text-lg font-bold text-sky-400">{shoreData.config.waterDepth}m</div>
                                </div>
                                <div className="bg-slate-800/50 backdrop-blur rounded-xl p-3 text-center border border-white/[0.04]">
                                    <div className="text-sm text-slate-400 uppercase tracking-wider">Last Update</div>
                                    <div className="text-lg font-bold text-white">
                                        {new Date(shoreData.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="text-center">
                            <div className="w-12 h-12 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                            <div className="text-slate-400">Waiting for vessel data...</div>
                            <div className="text-sm text-slate-600 mt-2">Session: {syncState?.sessionCode}</div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // ---- RENDER: WATCHING ----
    const isHolding = snapshot && snapshot.distanceFromAnchor <= snapshot.swingRadius;
    const holdPercent = snapshot && snapshot.swingRadius > 0
        ? Math.min(100, (snapshot.distanceFromAnchor / snapshot.swingRadius) * 100)
        : 0;

    return (
        <div className={`h-full ${t.colors.bg.base} flex flex-col overflow-hidden overflow-x-hidden`}>
            {/* Header — glassmorphism */}
            <div className={t.header.glass}>
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className={`${t.typography.pageTitle} flex items-center gap-2`}>
                            <span className="text-amber-400">⚓</span> Anchor Deployed
                        </h1>
                        <p className={`${t.typography.caption} font-mono`}>
                            {snapshot?.watchStartedAt ? `${formatElapsed(snapshot.watchStartedAt)} elapsed` : 'Monitoring...'}
                        </p>
                    </div>
                    <div className={`w-3 h-3 rounded-full ${isHolding ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'}`} />
                </div>
            </div>

            {/* Action Buttons — glassmorphism pills */}
            <div className="shrink-0 px-3 py-1.5 flex gap-2">
                {syncState?.connected ? (
                    <div className="flex-1 flex items-center justify-center gap-2 py-2 bg-sky-500/[0.08] backdrop-blur border border-sky-500/20 rounded-xl">
                        <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.5)]" />
                        <span className="text-sm text-sky-400 font-mono font-bold tracking-wider">{syncState.sessionCode}</span>
                        <span className="text-sm text-slate-400 uppercase">sharing</span>
                    </div>
                ) : (
                    <button
                        onClick={handleCreateSession}
                        className="flex-1 py-2 bg-sky-500/[0.08] backdrop-blur border border-sky-500/20 rounded-xl text-sm text-sky-400 font-bold transition-all active:scale-[0.97] hover:bg-sky-500/[0.12]"
                        aria-label="Create Sessi">
                        📱 Shore Share
                    </button>
                )}
                <button
                    onClick={handleStopWatch}
                    className={`flex-1 ${t.button.danger}`}
                    aria-label="Stop Watch">
                    ⏏ Weigh Anchor
                </button>
            </div>

            {/* Main Card — gradient glass */}
            <div className="flex-1 min-h-0 mx-3 mb-2 bg-gradient-to-b from-slate-900/70 to-slate-950/50 rounded-2xl border border-white/[0.07] flex flex-col overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.3)]">
                {/* Status Badge — animated with dot */}
                <div className="shrink-0 flex justify-center py-2">
                    <div className={`px-6 py-1.5 rounded-full text-sm font-black tracking-widest uppercase transition-all flex items-center gap-2 ${isHolding
                        ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                        : 'bg-red-500/10 border border-red-500/30 text-red-400 animate-pulse'
                        }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${isHolding ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        {isHolding ? 'Holding' : 'Drifting'}
                    </div>
                </div>

                {/* Canvas — fills available space */}
                <div className="flex-1 relative min-h-0">
                    <canvas
                        ref={canvasRef}
                        className="w-full h-full"
                        style={{ touchAction: 'none' }}
                        role="img"
                        aria-label={`Anchor watch radar display. ${isHolding ? 'Vessel holding position' : 'Vessel drifting'}. Current distance from anchor: ${snapshot ? formatDistance(snapshot.distanceFromAnchor) : 'unknown'}. Swing radius: ${snapshot ? formatDistance(snapshot.swingRadius) : 'unknown'}.`}
                    />
                </div>

                {/* Stats Grid — 2×3 */}
                <div className="shrink-0 px-2.5 pb-1.5">
                    <div className="grid grid-cols-3 gap-1.5">
                        <div className="bg-slate-800/50 backdrop-blur rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.labelSm}>GPS</div>
                            <div className={`text-sm font-black font-mono ${(snapshot?.gpsAccuracy ?? 99) < 10 ? 'text-emerald-400' : (snapshot?.gpsAccuracy ?? 99) < 20 ? 'text-amber-400' : 'text-red-400'}`}>
                                ±{snapshot?.gpsAccuracy.toFixed(0) ?? '--'}m
                            </div>
                        </div>
                        <div className="bg-slate-800/50 backdrop-blur rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className={t.typography.labelSm}>Bearing</div>
                            <div className="text-sm font-black font-mono text-slate-200">
                                {snapshot ? `${snapshot.bearingToAnchor.toFixed(0)}° ${bearingToCardinal(snapshot.bearingToAnchor)}` : `--`}
                            </div>
                        </div>
                        <div className="bg-slate-800/50 backdrop-blur rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Max Drift</div>
                            <div className="text-sm font-black font-mono text-slate-200">
                                {snapshot ? formatDistance(snapshot.maxDistanceRecorded) : `--`}
                            </div>
                        </div>
                        <div className="bg-slate-800/50 backdrop-blur rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Rode</div>
                            <div className="text-sm font-black font-mono text-amber-400">
                                {snapshot?.config.rodeLength ?? `--`}m
                            </div>
                        </div>
                        <div className="bg-slate-800/50 backdrop-blur rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Depth</div>
                            <div className="text-sm font-black font-mono text-sky-400">
                                {snapshot?.config.waterDepth ?? `--`}m
                            </div>
                        </div>
                        <div className="bg-slate-800/50 backdrop-blur rounded-lg px-2 py-1.5 text-center border border-white/[0.04]">
                            <div className="text-sm text-slate-400 uppercase tracking-wider">Scope</div>
                            <div className="text-sm font-black font-mono text-slate-200">
                                {snapshot ? (snapshot.config.rodeLength / snapshot.config.waterDepth).toFixed(1) : `--`}:1
                            </div>
                        </div>
                    </div>
                </div>

                {/* Distance / Radius — premium readout */}
                <div className="shrink-0 border-t border-white/[0.06] px-4 py-2.5 bg-slate-900/30">
                    <div className="flex items-center justify-around gap-4">
                        <div className="text-center flex-1">
                            <div className="text-sm text-slate-500 uppercase tracking-wider mb-0.5">Distance</div>
                            <div className={`text-3xl font-black font-mono ${isHolding ? 'text-emerald-400' : 'text-red-400'}`}>
                                {snapshot ? formatDistance(snapshot.distanceFromAnchor) : '--'}
                            </div>
                        </div>
                        <div className="w-px h-10 bg-gradient-to-b from-transparent via-white/10 to-transparent" />
                        <div className="text-center flex-1">
                            <div className="text-sm text-slate-500 uppercase tracking-wider mb-0.5">Radius</div>
                            <div className="text-3xl font-black font-mono text-white">
                                {snapshot ? formatDistance(snapshot.swingRadius) : `--`}
                            </div>
                        </div>
                    </div>

                    {/* Gradient usage bar */}
                    <div className="mt-2 h-2 bg-slate-800/60 rounded-full overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                                width: `${holdPercent}%`,
                                background: holdPercent > 85
                                    ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                                    : holdPercent > 60
                                        ? 'linear-gradient(90deg, #22c55e, #f59e0b)'
                                        : 'linear-gradient(90deg, #06b6d4, #22c55e)',
                            }}
                        />
                    </div>
                    <div className="flex justify-between text-sm text-slate-500 mt-0.5">
                        <span>Anchor</span>
                        <span className="font-bold font-mono">{holdPercent.toFixed(0)}%</span>
                        <span>Alarm</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
