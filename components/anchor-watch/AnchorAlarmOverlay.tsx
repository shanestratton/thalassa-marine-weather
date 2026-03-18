/**
 * Anchor Alarm Overlay — Full-screen drag alarm display
 *
 * Extracted from AnchorWatchPage.tsx. Shows when the vessel has dragged
 * outside the swing circle radius.
 */

import React from 'react';
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { formatDistance, bearingToCardinal } from './anchorUtils';

interface AnchorAlarmOverlayProps {
    snapshot: AnchorWatchSnapshot;
    onAcknowledge: () => void;
}

export const AnchorAlarmOverlay: React.FC<AnchorAlarmOverlayProps> = React.memo(({ snapshot, onAcknowledge }) => (
    <div
        className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
        style={{ background: 'radial-gradient(circle at center, #450a0a 0%, #1c0505 50%, #0a0202 100%)' }}
    >
        {/* Animated concentric pulse rings */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
            {[0, 1, 2].map((i) => (
                <div
                    key={i}
                    className="absolute rounded-full border-2 border-red-500/20 animate-ping"
                    style={{
                        width: `${200 + i * 120}px`,
                        height: `${200 + i * 120}px`,
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        animationDelay: `${i * 0.4}s`,
                        animationDuration: '2s',
                    }}
                />
            ))}
        </div>

        {/* Alarm icon with glow */}
        <div
            className="text-4xl mb-6 drop-shadow-[0_0_30px_rgba(239,68,68,0.5)]"
            style={{ animation: 'pulse 1s ease-in-out infinite' }}
        >
            🚨
        </div>

        {/* DRAG ALARM heading */}
        <h1
            className="text-4xl font-black text-red-400 tracking-[0.2em] mb-4 uppercase"
            style={{ textShadow: '0 0 30px rgba(239,68,68,0.4)' }}
            role="alert"
            aria-live="assertive"
        >
            Drag Alarm
        </h1>

        {/* Distance readout */}
        <div className="text-center mb-8">
            <div
                className="text-4xl font-mono font-black text-white mb-1"
                style={{ textShadow: '0 0 20px rgba(255,255,255,0.2)' }}
            >
                {formatDistance(snapshot.distanceFromAnchor)}
            </div>
            <div className="text-lg text-red-300/80">from anchor ({formatDistance(snapshot.swingRadius)} radius)</div>
            <div className="text-sm text-red-400/60 mt-2 font-mono">
                {snapshot.bearingToAnchor.toFixed(0)}° {bearingToCardinal(snapshot.bearingToAnchor)} to anchor
            </div>
        </div>

        {/* Bearing compass — gradient ring */}
        <div
            className="w-24 h-24 rounded-full flex items-center justify-center mb-8 relative"
            style={{
                background: 'conic-gradient(from 0deg, rgba(239,68,68,0.1), rgba(239,68,68,0.3), rgba(239,68,68,0.1))',
                border: '3px solid rgba(239,68,68,0.3)',
            }}
        >
            <div
                className="absolute w-1 h-10 rounded-full origin-bottom"
                style={{
                    transform: `rotate(${snapshot.bearingToAnchor}deg)`,
                    bottom: '50%',
                    left: 'calc(50% - 2px)',
                    background: 'linear-gradient(to top, transparent, #ef4444)',
                }}
            />
            <span className="text-sm text-red-400/80 font-bold">⚓</span>
        </div>

        {/* Silence button — premium gradient */}
        <button
            onClick={onAcknowledge}
            className="px-10 py-4 rounded-2xl text-white text-xl font-black transition-all active:scale-95"
            style={{
                background: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
                boxShadow: '0 8px 32px rgba(220, 38, 38, 0.4), 0 0 60px rgba(220, 38, 38, 0.2)',
            }}
            aria-label="Acknowledge Alarm"
        >
            Silence Alarm
        </button>

        <p className="text-red-400/40 text-sm mt-4 tracking-wider">Monitoring continues after silencing</p>
    </div>
));
