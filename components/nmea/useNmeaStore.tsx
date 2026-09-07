/**
 * useNmeaStore — React hooks for consuming NMEA instrument data with
 * stale-data awareness.
 *
 * Usage:
 *   const { tws, twa, stw, connectionStatus } = useNmeaStore();
 *
 * The metric-value renderer, reconnect banner and stale timer that once lived
 * here were removed on 2026-09-03 — nothing imported them; the Glass and the
 * NMEA page render their own. Git history has them.
 */
import { useState, useEffect } from 'react';
import React from 'react';
import { NmeaStore, type NmeaStoreState } from '../../services/NmeaStore';

/** Subscribe to the full NmeaStore state */
export function useNmeaStore(): NmeaStoreState {
    const [state, setState] = useState<NmeaStoreState>(NmeaStore.getState());

    useEffect(() => {
        const unsub = NmeaStore.subscribe(setState);
        return unsub;
    }, []);

    return state;
}

/**
 * Just the connection state and who is feeding it — for rows and headers that
 * must not re-render on every instrument sample. Re-renders only when the
 * status, or the remote feed's source, changes.
 */
export function useNmeaConnectionStatus(): {
    status: NmeaStoreState['connectionStatus'];
    remote: NmeaStoreState['remote'];
} {
    const pick = (s: NmeaStoreState) => ({ status: s.connectionStatus, remote: s.remote });
    const [value, setValue] = useState(() => pick(NmeaStore.getState()));
    useEffect(
        () =>
            NmeaStore.subscribe((s) => {
                const next = pick(s);
                setValue((prev) =>
                    prev.status === next.status &&
                    prev.remote?.source === next.remote?.source &&
                    prev.remote?.deviceLabel === next.remote?.deviceLabel &&
                    prev.remote?.via === next.remote?.via
                        ? prev
                        : next,
                );
            }),
        [],
    );
    return value;
}

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
        remote: { color: 'bg-sky-400', label: 'Remote via cloud' },
    };

    const c =
        state.connectionStatus === 'remote' && state.remote?.via === 'lan'
            ? { color: 'bg-emerald-400', label: 'Live via the Pi' }
            : config[state.connectionStatus];

    return (
        <div className={`flex items-center gap-1.5 ${className}`} title={c.label}>
            <div className={`w-2 h-2 rounded-full ${c.color}`} />
            <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">{c.label}</span>
        </div>
    );
};
