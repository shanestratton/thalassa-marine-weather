/**
 * SystemStatusButton — Single ℹ circle that replaces all individual header badges.
 *
 * When ANY system is active (GPS tracking, anchor watch, NMEA, ext GPS, FollowRoute),
 * this blue circle appears top-right in the header. Tapping it opens the
 * SystemStatusModal showing all systems in a consolidated view.
 *
 * When >0 systems active: solid blue circle with ℹ
 * When >1 systems active: pulsing glow ring
 * When 0 active: hidden
 */

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ShipLogService } from '../services/ShipLogService';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../services/AnchorWatchService';
import { NmeaListenerService } from '../services/NmeaListenerService';
import { NmeaGpsProvider } from '../services/NmeaGpsProvider';
import { NmeaStore } from '../services/NmeaStore';
import { GpsPrecision } from '../services/shiplog/GpsPrecisionTracker';
import { useFollowRoute } from '../context/FollowRouteContext';
import { GpsService } from '../services/GpsService';

// ── Types ──

interface SystemState {
    gpsTracking: {
        active: boolean;
        isMoving: boolean;
        intervalMs: number;
        isRapidMode: boolean;
        gpsStatus: string;
    };
    anchorWatch: {
        active: boolean;
        state: 'idle' | 'holding' | 'drifting' | 'alarm';
        distance: number;
        swingRadius: number;
    };
    nmea: {
        active: boolean;
    };
    extGps: {
        active: boolean;
        isNmea: boolean;
        satellites: number | null;
        hdop: number | null;
        avgAccuracy: number | null;
        qualityLabel: string;
    };
    followRoute: {
        active: boolean;
        origin: string;
        destination: string;
        routeChanged: boolean;
        isRefreshing: boolean;
    };
}

// ── Helpers ──

function formatIntervalLabel(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
}

// ── SystemStatusModal ──

const SystemStatusModal: React.FC<{
    state: SystemState;
    onClose: () => void;
    onNavigateAnchor: () => void;
    onStopFollowing: () => void;
    onRefreshRoute: () => void;
    onAcceptChange: () => void;
    onDismissChange: () => void;
}> = ({ state, onClose, onNavigateAnchor, onStopFollowing, onRefreshRoute, onAcceptChange, onDismissChange }) => {
    const activeCount = [
        state.gpsTracking.active,
        state.anchorWatch.active,
        state.nmea.active,
        state.extGps.active,
        state.followRoute.active,
    ].filter(Boolean).length;

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/60 backdrop-blur-[2px]"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="System status"
            style={{
                paddingTop: 'calc(env(safe-area-inset-top) + 60px)',
                paddingBottom: 'calc(env(safe-area-inset-bottom) + 80px)',
            }}
        >
            <div
                className="w-full max-w-md bg-slate-900/95 border border-white/15 rounded-2xl shadow-2xl max-h-[80dvh] overflow-y-auto mx-4 animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-5 pb-3 sticky top-0 bg-slate-900/95 z-10 border-b border-white/[0.06]">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-sky-500/20 flex items-center justify-center">
                            <span className="text-sky-400 text-sm font-bold">ℹ</span>
                        </div>
                        <h2 className="text-base font-bold text-white tracking-tight">System Status</h2>
                        <span className="text-[11px] font-bold text-sky-400 bg-sky-500/15 px-1.5 py-0.5 rounded-lg">
                            {activeCount} active
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close system status"
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Systems Grid */}
                <div className="px-5 py-4 space-y-3">
                    {/* ── GPS Tracking (Passage) ── */}
                    <SystemRow
                        icon={
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <circle cx="12" cy="12" r="3" />
                                <path strokeLinecap="round" d="M12 2v4m0 12v4m10-10h-4M6 12H2" />
                            </svg>
                        }
                        label="GPS Tracking"
                        active={state.gpsTracking.active}
                        detail={
                            state.gpsTracking.active
                                ? `${state.gpsTracking.isMoving ? '🟢 Moving' : '🔴 Stationary'} · ${formatIntervalLabel(state.gpsTracking.isRapidMode ? 5000 : state.gpsTracking.intervalMs || 900_000)} interval${state.gpsTracking.isRapidMode ? ' · RAPID' : ''}`
                                : 'Not tracking'
                        }
                        dotColor={
                            state.gpsTracking.active
                                ? state.gpsTracking.isMoving
                                    ? 'bg-emerald-400'
                                    : 'bg-red-400'
                                : 'bg-slate-600'
                        }
                        pulse={state.gpsTracking.active}
                    />

                    {/* ── Anchor Watch ── */}
                    <SystemRow
                        icon={<span className="text-sm leading-none">⚓</span>}
                        label="Anchor Watch"
                        active={state.anchorWatch.active}
                        detail={
                            state.anchorWatch.active
                                ? `${state.anchorWatch.state === 'alarm' ? '🚨 ALARM' : state.anchorWatch.state === 'drifting' ? '⚠️ Drifting' : '✅ Holding'} · ${Math.round(state.anchorWatch.distance)}m / ${Math.round(state.anchorWatch.swingRadius)}m radius`
                                : 'Not deployed'
                        }
                        dotColor={
                            state.anchorWatch.active
                                ? state.anchorWatch.state === 'holding'
                                    ? 'bg-emerald-400'
                                    : 'bg-red-400'
                                : 'bg-slate-600'
                        }
                        pulse={state.anchorWatch.active && state.anchorWatch.state !== 'holding'}
                        action={
                            state.anchorWatch.active
                                ? { label: 'View', onClick: onNavigateAnchor }
                                : undefined
                        }
                    />

                    {/* ── NMEA Connection ── */}
                    <SystemRow
                        icon={
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0" />
                            </svg>
                        }
                        label="NMEA Backbone"
                        active={state.nmea.active}
                        detail={state.nmea.active ? 'Connected — live vessel data' : 'Not connected'}
                        dotColor={state.nmea.active ? 'bg-emerald-400' : 'bg-slate-600'}
                    />

                    {/* ── External GPS ── */}
                    <SystemRow
                        icon={
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.652a3.75 3.75 0 010-5.304m5.304 0a3.75 3.75 0 010 5.304m-7.425 2.121a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.788m13.788 0c3.808 3.808 3.808 9.98 0 13.788" />
                            </svg>
                        }
                        label="External GPS"
                        active={state.extGps.active}
                        detail={
                            state.extGps.active
                                ? state.extGps.isNmea
                                    ? `${state.extGps.qualityLabel}${state.extGps.satellites != null ? ` · ${state.extGps.satellites} sats` : ''}${state.extGps.hdop != null ? ` · HDOP ${state.extGps.hdop.toFixed(1)}` : ''}`
                                    : `${state.extGps.qualityLabel}${state.extGps.avgAccuracy != null ? ` · ±${state.extGps.avgAccuracy}m` : ''}`
                                : 'No external GPS detected'
                        }
                        dotColor={
                            state.extGps.active
                                ? state.extGps.isNmea
                                    ? 'bg-sky-400'
                                    : 'bg-emerald-400'
                                : 'bg-slate-600'
                        }
                        pulse={state.extGps.active}
                    />

                    {/* ── Follow Route (Passage Planning) ── */}
                    <SystemRow
                        icon={
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m0 0l3-3m-3 3l-3-3m12-1.5V15m0 0l3-3m-3 3l-3-3" />
                            </svg>
                        }
                        label="Following Route"
                        active={state.followRoute.active}
                        detail={
                            state.followRoute.active
                                ? `${state.followRoute.origin} → ${state.followRoute.destination}${state.followRoute.routeChanged ? ' · ⚠ Updated' : state.followRoute.isRefreshing ? ' · Refreshing...' : ''}`
                                : 'No active route'
                        }
                        dotColor={
                            state.followRoute.active
                                ? state.followRoute.routeChanged
                                    ? 'bg-amber-400'
                                    : 'bg-sky-400'
                                : 'bg-slate-600'
                        }
                        pulse={state.followRoute.active && state.followRoute.routeChanged}
                        action={
                            state.followRoute.active
                                ? state.followRoute.routeChanged
                                    ? { label: 'Accept', onClick: onAcceptChange }
                                    : { label: 'Stop', onClick: onStopFollowing, destructive: true }
                                : undefined
                        }
                    />
                </div>
            </div>
        </div>,
        document.body,
    );
};

// ── Individual System Row ──

const SystemRow: React.FC<{
    icon: React.ReactNode;
    label: string;
    active: boolean;
    detail: string;
    dotColor: string;
    pulse?: boolean;
    action?: { label: string; onClick: () => void; destructive?: boolean };
}> = ({ icon, label, active, detail, dotColor, pulse, action }) => (
    <div
        className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
            active
                ? 'bg-white/[0.04] border-white/10'
                : 'bg-white/[0.01] border-white/[0.04] opacity-50'
        }`}
    >
        {/* Status dot */}
        <div className="relative shrink-0">
            <span className={`block w-2.5 h-2.5 rounded-full ${dotColor} transition-colors`} />
            {pulse && (
                <span className={`absolute inset-0 rounded-full ${dotColor} animate-ping opacity-50`} />
            )}
        </div>

        {/* Icon */}
        <div className={`shrink-0 ${active ? 'text-white' : 'text-slate-500'}`}>{icon}</div>

        {/* Text */}
        <div className="flex-1 min-w-0">
            <p className={`text-xs font-bold uppercase tracking-widest ${active ? 'text-white' : 'text-slate-500'}`}>
                {label}
            </p>
            <p className={`text-[11px] leading-relaxed mt-0.5 truncate ${active ? 'text-slate-400' : 'text-slate-600'}`}>
                {detail}
            </p>
        </div>

        {/* Action button */}
        {action && (
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    action.onClick();
                }}
                className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 ${
                    action.destructive
                        ? 'bg-red-500/15 border border-red-500/30 text-red-400'
                        : 'bg-sky-500/15 border border-sky-500/30 text-sky-400'
                }`}
            >
                {action.label}
            </button>
        )}
    </div>
);

// ── Main Button Component ──

interface SystemStatusButtonProps {
    currentView: string;
    onNavigateAnchor: () => void;
}

export const SystemStatusButton: React.FC<SystemStatusButtonProps> = ({ currentView, onNavigateAnchor }) => {
    const [showModal, setShowModal] = useState(false);
    const [showStopConfirm, setShowStopConfirm] = useState(false);

    // ── GPS Tracking state ──
    const [gpsTracking, setGpsTracking] = useState(() => ShipLogService.getTrackingStatus());
    const [isMoving, setIsMoving] = useState(false);

    // ── Anchor Watch state ──
    const [anchorSnapshot, setAnchorSnapshot] = useState<AnchorWatchSnapshot | null>(null);

    // ── NMEA state ──
    const [nmeaStatus, setNmeaStatus] = useState(NmeaListenerService.getStatus());

    // ── External GPS state ──
    const [nmeaGpsActive, setNmeaGpsActive] = useState(false);
    const [precisionActive, setPrecisionActive] = useState(false);
    const [satellites, setSatellites] = useState<number | null>(null);
    const [hdop, setHdop] = useState<number | null>(null);
    const [avgAccuracy, setAvgAccuracy] = useState<number | null>(null);
    const [qualityLabel, setQualityLabel] = useState('GPS');

    // ── Follow Route state ──
    const {
        isFollowing,
        voyagePlan,
        routeChanged,
        isRefreshing: routeRefreshing,
        stopFollowing,
        acceptRouteChange,
        dismissRouteChange,
        refreshRoute,
    } = useFollowRoute();

    // ── Passive GPS accuracy feed ──
    useEffect(() => {
        const unsub = GpsService.watchPosition((pos) => {
            if (pos.accuracy > 0) {
                GpsPrecision.feed(pos.accuracy);
            }
        });
        return unsub;
    }, []);

    // ── Poll all system states ──
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe(setAnchorSnapshot);
        const nmeaUnsub = NmeaListenerService.onStatusChange((s) => setNmeaStatus(s));

        const id = setInterval(() => {
            if (document.hidden) return;

            // GPS Tracking
            const ts = ShipLogService.getTrackingStatus();
            setGpsTracking(ts);
            const nav = ShipLogService.getGpsNavData();
            setIsMoving(nav.sogKts !== null && nav.sogKts > 0.5);

            // NMEA
            setNmeaStatus(NmeaListenerService.getStatus());

            // External GPS
            const isNmea = NmeaGpsProvider.isActive();
            const isPrecision = GpsPrecision.isPrecision();
            GpsPrecision.checkStaleness();
            setNmeaGpsActive(isNmea);
            setPrecisionActive(isPrecision);

            if (isNmea) {
                const store = NmeaStore.getState();
                setSatellites(store.satellites.value !== null ? Math.round(store.satellites.value) : null);
                setHdop(store.hdop.value);
                setQualityLabel(NmeaGpsProvider.getQualityLabel());
            } else if (isPrecision) {
                setAvgAccuracy(Math.round(GpsPrecision.getAverageAccuracy() * 10) / 10);
                setQualityLabel('Precision GPS');
                setSatellites(null);
                setHdop(null);
            }
        }, 1000);

        return () => {
            unsub();
            nmeaUnsub();
            clearInterval(id);
        };
    }, []);

    // ── Build system state ──
    const systemState: SystemState = useMemo(
        () => ({
            gpsTracking: {
                active: gpsTracking.isTracking,
                isMoving,
                intervalMs: gpsTracking.currentIntervalMs || 900_000,
                isRapidMode: gpsTracking.isRapidMode || false,
                gpsStatus: ShipLogService.getGpsStatus(),
            },
            anchorWatch: {
                active:
                    !!anchorSnapshot &&
                    anchorSnapshot.state !== 'idle' &&
                    currentView !== 'compass',
                state: anchorSnapshot
                    ? anchorSnapshot.state === 'alarm' || !!anchorSnapshot.alarmTriggeredAt
                        ? 'alarm'
                        : (anchorSnapshot.distanceFromAnchor ?? 0) > (anchorSnapshot.swingRadius ?? 50)
                          ? 'drifting'
                          : anchorSnapshot.state === 'idle'
                            ? 'idle'
                            : 'holding'
                    : 'idle',
                distance: anchorSnapshot?.distanceFromAnchor ?? 0,
                swingRadius: anchorSnapshot?.swingRadius ?? 0,
            },
            nmea: {
                active: nmeaStatus === 'connected',
            },
            extGps: {
                active: nmeaGpsActive || precisionActive,
                isNmea: nmeaGpsActive,
                satellites,
                hdop,
                avgAccuracy,
                qualityLabel,
            },
            followRoute: {
                active: isFollowing && !!voyagePlan,
                origin: voyagePlan?.origin?.split(',')[0] || 'Origin',
                destination: voyagePlan?.destination?.split(',')[0] || 'Destination',
                routeChanged: routeChanged || false,
                isRefreshing: routeRefreshing || false,
            },
        }),
        [
            gpsTracking,
            isMoving,
            anchorSnapshot,
            currentView,
            nmeaStatus,
            nmeaGpsActive,
            precisionActive,
            satellites,
            hdop,
            avgAccuracy,
            qualityLabel,
            isFollowing,
            voyagePlan,
            routeChanged,
            routeRefreshing,
        ],
    );

    // ── Active count ──
    const activeCount = [
        systemState.gpsTracking.active,
        systemState.anchorWatch.active,
        systemState.nmea.active,
        systemState.extGps.active,
        systemState.followRoute.active,
    ].filter(Boolean).length;

    // Don't show if nothing is active
    if (activeCount === 0) return null;

    // Has urgent status (anchor alarm, route changed)?
    const hasUrgent =
        (systemState.anchorWatch.active && systemState.anchorWatch.state !== 'holding') ||
        (systemState.followRoute.active && systemState.followRoute.routeChanged);

    return (
        <>
            <button
                onClick={() => setShowModal(true)}
                aria-label={`System status: ${activeCount} active`}
                className="relative flex items-center justify-center pointer-events-auto"
            >
                {/* Glow ring when multiple systems active or urgent */}
                {(activeCount > 1 || hasUrgent) && (
                    <span
                        className={`absolute inset-[-3px] rounded-full animate-ping opacity-30 ${
                            hasUrgent ? 'bg-amber-400' : 'bg-sky-400'
                        }`}
                    />
                )}
                {/* Main button circle */}
                <span
                    className={`relative w-8 h-8 rounded-full flex items-center justify-center border shadow-lg transition-all ${
                        hasUrgent
                            ? 'bg-amber-500/90 border-amber-400/40 shadow-amber-500/30'
                            : 'bg-sky-500/90 border-sky-400/40 shadow-sky-500/30'
                    }`}
                >
                    <span className="text-white font-bold text-sm">ℹ</span>
                </span>

                {/* Active count badge */}
                {activeCount > 1 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-white text-slate-900 text-[10px] font-black flex items-center justify-center shadow-md">
                        {activeCount}
                    </span>
                )}
            </button>

            {/* Modal */}
            {showModal && (
                <SystemStatusModal
                    state={systemState}
                    onClose={() => setShowModal(false)}
                    onNavigateAnchor={() => {
                        setShowModal(false);
                        onNavigateAnchor();
                    }}
                    onStopFollowing={() => {
                        setShowStopConfirm(true);
                    }}
                    onRefreshRoute={() => {
                        refreshRoute();
                    }}
                    onAcceptChange={() => {
                        acceptRouteChange();
                        setShowModal(false);
                    }}
                    onDismissChange={() => {
                        dismissRouteChange();
                    }}
                />
            )}

            {/* Stop Following Confirmation */}
            {showStopConfirm && (
                <div
                    className="fixed inset-0 z-[10000] flex items-center justify-center p-6"
                    onClick={() => setShowStopConfirm(false)}
                >
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
                    <div
                        className="relative w-full max-w-sm bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="h-1 bg-gradient-to-r from-red-500 via-amber-500 to-red-500" />
                        <div className="p-6 text-center">
                            <h3 className="text-lg font-bold text-white mb-2">Stop Following Route?</h3>
                            <p className="text-sm text-gray-400 leading-relaxed">
                                This will remove the route overlay and stop weather auto-refresh.
                            </p>
                        </div>
                        <div className="px-6 pb-6 flex gap-3">
                            <button
                                onClick={() => setShowStopConfirm(false)}
                                className="flex-1 py-3.5 px-4 rounded-xl bg-white/5 border border-white/10 text-gray-300 font-bold text-sm hover:bg-white/10 transition-all active:scale-[0.97]"
                            >
                                Keep
                            </button>
                            <button
                                onClick={() => {
                                    stopFollowing();
                                    setShowStopConfirm(false);
                                    setShowModal(false);
                                }}
                                className="flex-1 py-3.5 px-4 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 font-bold text-sm hover:bg-red-500/25 transition-all active:scale-[0.97]"
                            >
                                Stop Route
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
