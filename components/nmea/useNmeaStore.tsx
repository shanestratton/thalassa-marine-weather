/**
 * useNmeaStore — React hooks for consuming NMEA instrument data with
 * stale-data awareness.
 *
 * Usage:
 *   const { tws, twa, stw, connectionStatus } = useNmeaStore();
 *   return <NmeaValue metric={tws} unit="kts" decimals={1} />;
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import React from 'react';
import { NmeaStore, type NmeaStoreState, type TimestampedMetric, type DataFreshness } from '../../services/NmeaStore';

/** Subscribe to the full NmeaStore state */
export function useNmeaStore(): NmeaStoreState {
    const [state, setState] = useState<NmeaStoreState>(NmeaStore.getState());

    useEffect(() => {
        const unsub = NmeaStore.subscribe(setState);
        return unsub;
    }, []);

    return state;
}

/** Subscribe to a single metric from the store */
export function useNmeaMetric(selector: (s: NmeaStoreState) => TimestampedMetric): TimestampedMetric {
    const state = useNmeaStore();
    return useMemo(() => selector(state), [state]);
}

// ═══════════════════════════════════════════
// NmeaValue — Renders a metric value with 3-tier freshness styling
// ═══════════════════════════════════════════

interface NmeaValueProps {
    metric: TimestampedMetric;
    unit?: string;
    decimals?: number;
    deadText?: string;     // What to show when dead (default: "--.-")
    className?: string;    // Base classes (applied to all tiers)
    liveClass?: string;    // Additional classes for live tier
    staleClass?: string;   // Additional classes for stale tier
    deadClass?: string;    // Additional classes for dead tier
}

/**
 * Renders an NMEA metric value with automatic 3-tier freshness styling:
 *   LIVE  (0-3s):  Bright text, full opacity
 *   STALE (3-10s): Muted, 50% opacity, yellow tint
 *   DEAD  (>10s):  Dashes + red warning icon
 */
export const NmeaValue: React.FC<NmeaValueProps> = ({
    metric,
    unit,
    decimals = 1,
    deadText = '--.-',
    className = '',
    liveClass = 'text-white',
    staleClass = 'text-yellow-400/50',
    deadClass = 'text-gray-600',
}) => {
    const freshnessStyles: Record<DataFreshness, string> = {
        live: liveClass,
        stale: `${staleClass} transition-opacity duration-500`,
        dead: deadClass,
    };

    const isDead = metric.freshness === 'dead' || metric.value === null;

    return (
        <span className={`inline-flex items-center gap-1 ${className} ${freshnessStyles[metric.freshness]}`}>
            {isDead ? (
                <>
                    <svg className="w-3 h-3 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    <span>{deadText}</span>
                </>
            ) : (
                <>
                    <span>{metric.value!.toFixed(decimals)}</span>
                    {unit && <span className="text-[0.7em] opacity-60">{unit}</span>}
                </>
            )}
        </span>
    );
};

// ═══════════════════════════════════════════
// NmeaReconnectBanner — Slides down when connection is lost
// ═══════════════════════════════════════════

/**
 * Full-width banner that appears when NMEA connection is lost.
 * Slides down from top, auto-dismisses on reconnection.
 */
export const NmeaReconnectBanner: React.FC = () => {
    const state = useNmeaStore();
    const isDisconnected = state.connectionStatus === 'disconnected' || state.connectionStatus === 'error';

    // Only show if we were previously connected (lastAnyUpdate > 0 means we've received data before)
    const wasConnected = state.lastAnyUpdate > 0;
    const showBanner = isDisconnected && wasConnected;

    // Animate presence
    const [visible, setVisible] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        if (showBanner) {
            setMounted(true);
            // Small delay for CSS transition
            requestAnimationFrame(() => setVisible(true));
        } else {
            setVisible(false);
            const timer = setTimeout(() => setMounted(false), 300);
            return () => clearTimeout(timer);
        }
    }, [showBanner]);

    if (!mounted) return null;

    return (
        <div
            className={`fixed top-0 left-0 right-0 z-[9999] transition-transform duration-300 ease-out ${visible ? 'translate-y-0' : '-translate-y-full'
                }`}
        >
            <div className="bg-gradient-to-r from-red-600 to-red-700 px-4 py-3 flex items-center justify-center gap-3 shadow-2xl shadow-red-500/30">
                {/* Pulsing warning icon */}
                <svg className="w-5 h-5 text-white animate-pulse flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>

                <div className="text-center">
                    <p className="text-white text-sm font-black tracking-wide">
                        ⚠️ Axiom Network Lost
                    </p>
                    <p className="text-red-200 text-[10px] font-bold uppercase tracking-widest">
                        Reconnecting — instrument data frozen
                    </p>
                </div>

                {/* Spinning reconnect indicator */}
                <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin flex-shrink-0" />
            </div>

            {/* Stale data time indicator */}
            {state.lastAnyUpdate > 0 && (
                <StaleTimer lastUpdate={state.lastAnyUpdate} />
            )}
        </div>
    );
};

/** Shows how long ago the last data was received */
const StaleTimer: React.FC<{ lastUpdate: number }> = ({ lastUpdate }) => {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => {
            setElapsed(Math.floor((Date.now() - lastUpdate) / 1000));
        }, 1000);
        return () => clearInterval(timer);
    }, [lastUpdate]);

    const formatElapsed = (s: number): string => {
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
        return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    };

    return (
        <div className="bg-red-900/80 text-center py-1">
            <span className="text-[9px] font-mono font-bold text-red-300 uppercase tracking-widest">
                Last data: {formatElapsed(elapsed)}
            </span>
        </div>
    );
};

// ═══════════════════════════════════════════
// NmeaStatusDot — Compact connection indicator
// ═══════════════════════════════════════════

/** Small dot indicator for NMEA connection status */
export const NmeaStatusDot: React.FC<{ className?: string }> = ({ className = '' }) => {
    const state = useNmeaStore();

    const config: Record<NmeaStoreState['connectionStatus'], { color: string; label: string }> = {
        connected: { color: 'bg-emerald-400', label: 'NMEA Connected' },
        connecting: { color: 'bg-amber-400 animate-pulse', label: 'Connecting…' },
        disconnected: { color: 'bg-gray-500', label: 'NMEA Disconnected' },
        error: { color: 'bg-red-400 animate-pulse', label: 'NMEA Error' },
    };

    const c = config[state.connectionStatus];

    return (
        <div className={`flex items-center gap-1.5 ${className}`} title={c.label}>
            <div className={`w-2 h-2 rounded-full ${c.color}`} />
            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">{c.label}</span>
        </div>
    );
};
