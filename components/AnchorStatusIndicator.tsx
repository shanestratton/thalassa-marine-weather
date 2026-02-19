/**
 * AnchorStatusIndicator — Global persistent badge showing anchor watch status.
 * Visible on ALL screens (except the Anchor Watch page itself) when anchor is deployed.
 *
 * States:
 *   Holding  → green anchor + "Holding" label
 *   Drifting → red anchor + "Drift!" label + pulse animation
 *   Alarm    → red anchor + "ALARM" label + rapid pulse
 *
 * Positioned fixed top-left, beside the GPS tracking indicator on the right.
 * Tapping it navigates to the Anchor Watch page.
 */

import React, { useState, useEffect } from 'react';
import {
    AnchorWatchService,
    type AnchorWatchSnapshot,
} from '../services/AnchorWatchService';

interface AnchorStatusIndicatorProps {
    /** Current view name — hide when already on anchor watch */
    currentView: string;
    /** Navigate to anchor watch */
    onNavigate: () => void;
}

export const AnchorStatusIndicator: React.FC<AnchorStatusIndicatorProps> = ({
    currentView,
    onNavigate,
}) => {
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot | null>(null);

    useEffect(() => {
        const unsub = AnchorWatchService.subscribe(setSnapshot);
        return unsub;
    }, []);

    // Don't render if not watching or if we're already on the anchor watch page
    if (!snapshot || snapshot.state === 'idle' || currentView === 'compass') {
        return null;
    }

    const isHolding = snapshot.distanceFromAnchor <= snapshot.swingRadius;
    const isAlarm = snapshot.state === 'alarm' || !!snapshot.alarmTriggeredAt;

    // Determine visual state
    const status = isAlarm ? 'alarm' : !isHolding ? 'drifting' : 'holding';

    const config = {
        holding: {
            bg: 'bg-emerald-600/90 border-emerald-400/30',
            dot: 'bg-emerald-400',
            pulse: 'bg-emerald-500',
            text: 'Holding',
            textColor: 'text-emerald-100',
            animate: false,
        },
        drifting: {
            bg: 'bg-red-600/90 border-red-400/40',
            dot: 'bg-red-400',
            pulse: 'bg-red-500',
            text: 'Drift!',
            textColor: 'text-red-100',
            animate: true,
        },
        alarm: {
            bg: 'bg-red-600/95 border-red-400/50',
            dot: 'bg-red-400',
            pulse: 'bg-red-500',
            text: 'ALARM',
            textColor: 'text-red-100',
            animate: true,
        },
    }[status];

    return (
        <div className="fixed top-[max(0.75rem,env(safe-area-inset-top))] left-3 z-[950]">
            <button
                onClick={onNavigate}
                className={`relative flex items-center gap-1.5 px-2.5 py-1 rounded-full ${config.bg} border backdrop-blur-md shadow-lg transition-all active:scale-95`}
                aria-label={`Anchor watch: ${config.text}. Tap to view.`}
            >
                {/* Pulse ring */}
                <span className="relative flex h-2.5 w-2.5">
                    {config.animate && (
                        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.pulse} opacity-75`} />
                    )}
                    <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${config.dot}`} />
                </span>

                {/* Anchor icon */}
                <span className="text-sm" style={{ lineHeight: 1 }}>⚓</span>

                {/* Status label */}
                <span className={`${config.textColor} font-bold text-[11px] tracking-wide leading-none`}>
                    {config.text}
                </span>
            </button>
        </div>
    );
};
