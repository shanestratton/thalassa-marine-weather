import React from 'react';
import { useNmeaStore } from '../nmea/useNmeaStore';
import { useInstrumentDerivations } from '../../hooks/useInstrumentDerivations';
export default function SailingPerformanceHud() {
    const state = useNmeaStore(),
        d = useInstrumentDerivations(state);
    const p = d.performance;
    if (p.kind !== 'available')
        return <p className="border-b border-white/10 px-1 py-1 text-[10px] text-gray-400">Performance unavailable</p>;
    return (
        <p
            className="border-b border-white/10 px-1 py-1 text-center text-[10px] text-cyan-200"
            title={`${p.polarLabel} · ${p.polarSource} · samples ${new Date(p.observedAt).toISOString()} · ${p.leewayApplied ? 'explicit leeway' : 'leeway uncorrected'}`}
        >
            VMG {p.vmgKts === null ? '—' : `${p.vmgKts.toFixed(1)} kn`}
            {p.performancePct !== null ? ` · ${Math.round(p.performancePct)}% polar` : ''}
            <br />
            <span className="text-gray-400">
                Water · {Math.max(0, Math.floor((d.now - p.observedAt) / 1000))} s old
                {d.evidence?.via === 'cloud' ? ' · Cloud' : ''}
            </span>
        </p>
    );
}
