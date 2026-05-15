import React from 'react';
import { useBandwidthMode, type BandwidthMode } from '../bandwidthMode';

const OPTIONS: { id: BandwidthMode; label: string; icon: string }[] = [
    { id: 'satlink', label: 'Sat-Link', icon: '📡' },
    { id: 'starlink', label: 'Starlink', icon: '🛰️' },
];

/** Viewer-side bandwidth toggle for the Voyage Log header. */
export const BandwidthToggle: React.FC = () => {
    const { mode, setMode } = useBandwidthMode();
    return (
        <div className="flex rounded-lg overflow-hidden border border-white/10 bg-slate-800/80 text-[10px] font-bold uppercase tracking-wider">
            {OPTIONS.map((o) => (
                <button
                    key={o.id}
                    onClick={() => setMode(o.id)}
                    aria-label={`${o.label} bandwidth mode`}
                    aria-pressed={mode === o.id}
                    className={`px-2 sm:px-2.5 py-1 transition-colors flex items-center gap-1 ${
                        mode === o.id ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-white/10'
                    }`}
                >
                    <span>{o.icon}</span>
                    <span className="hidden sm:inline">{o.label}</span>
                </button>
            ))}
        </div>
    );
};
