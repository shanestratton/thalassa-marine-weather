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
            <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">{c.label}</span>
        </div>
    );
};
