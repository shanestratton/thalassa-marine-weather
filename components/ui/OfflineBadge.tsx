/**
 * OfflineBadge — Subtle "Saved locally" indicator for forms when offline.
 *
 * Shows a small amber badge when the device is offline, reassuring
 * the user that their data is safe and will sync when connectivity returns.
 */
import React from 'react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

export const OfflineBadge: React.FC = () => {
    const isOnline = useOnlineStatus();
    if (isOnline) return null;

    return (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/15 rounded-lg animate-in fade-in duration-300">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-[11px] font-bold text-amber-400/80 uppercase tracking-wider">Saved locally</span>
        </div>
    );
};
