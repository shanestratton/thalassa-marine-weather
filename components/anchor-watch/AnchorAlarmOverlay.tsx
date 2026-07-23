/**
 * Anchor Alarm Overlay — Full-screen drag alarm display
 *
 * Extracted from AnchorWatchPage.tsx. Shows when the vessel has dragged
 * outside the swing circle radius.
 */

import React, { useId, useRef } from 'react';
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatDistance, bearingToCardinal } from './anchorUtils';

interface AnchorAlarmOverlayProps {
    snapshot: AnchorWatchSnapshot;
    onAcknowledge: () => void;
}

export const AnchorAlarmOverlay: React.FC<AnchorAlarmOverlayProps> = React.memo(({ snapshot, onAcknowledge }) => {
    const gpsLost = snapshot.alarmCause === 'gps-lost';
    const titleId = useId();
    const descriptionId = useId();
    const acknowledgeRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: acknowledgeRef,
    });

    return (
        <div
            ref={dialogRef}
            className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
            style={{ background: 'radial-gradient(circle at center, #450a0a 0%, #1c0505 50%, #0a0202 100%)' }}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
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
                aria-hidden="true"
            >
                {gpsLost ? '📡' : '🚨'}
            </div>

            {/* Alarm heading */}
            <h1
                id={titleId}
                className="text-4xl font-black text-red-400 tracking-[0.2em] mb-4 uppercase"
                style={{ textShadow: '0 0 30px rgba(239,68,68,0.4)' }}
            >
                {gpsLost ? 'GPS Lost' : 'Drag Alarm'}
            </h1>

            {gpsLost ? (
                /* GPS-lost readout — the watch is blind; the distance is stale, so don't headline it */
                <div id={descriptionId} className="text-center mb-8 max-w-xs px-6">
                    <div className="text-lg text-red-200 font-bold mb-2">Anchor watch can&apos;t see your position</div>
                    <div className="text-sm text-red-300/70">
                        No GPS fix is arriving — dragging can no longer be detected. Check your position and GPS signal
                        now.
                    </div>
                    <div className="text-xs text-red-400/50 mt-3 font-mono">
                        last known {formatDistance(snapshot.distanceFromAnchor)} from anchor
                    </div>
                </div>
            ) : (
                <>
                    {/* Distance readout */}
                    <div id={descriptionId} className="text-center mb-8">
                        <div
                            className="text-4xl font-mono font-black text-white mb-1"
                            style={{ textShadow: '0 0 20px rgba(255,255,255,0.2)' }}
                        >
                            {formatDistance(snapshot.distanceFromAnchor)}
                        </div>
                        <div className="text-lg text-red-300/80">
                            from anchor ({formatDistance(snapshot.swingRadius)} radius)
                        </div>
                        <div className="text-sm text-red-400/60 mt-2 font-mono">
                            {snapshot.bearingToAnchor.toFixed(0)}° {bearingToCardinal(snapshot.bearingToAnchor)} to
                            anchor
                        </div>
                    </div>

                    {/* Bearing compass — gradient ring */}
                    <div
                        className="w-24 h-24 rounded-full flex items-center justify-center mb-8 relative"
                        style={{
                            background:
                                'conic-gradient(from 0deg, rgba(239,68,68,0.1), rgba(239,68,68,0.3), rgba(239,68,68,0.1))',
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
                        <span className="text-sm text-red-400/80 font-bold" aria-hidden="true">
                            ⚓
                        </span>
                    </div>
                </>
            )}

            {/* Silence button — premium gradient */}
            <button
                ref={acknowledgeRef}
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
    );
});
