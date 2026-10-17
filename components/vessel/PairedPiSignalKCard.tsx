import React, { useSyncExternalStore } from 'react';
import { PairedPiNotifications } from '../../services/signalk/PairedPiNotifications';
import { Button } from '../ui/Button';
import { SignalKNotifications } from './SignalKNotifications';

const words = {
    off: 'Notification reader stopped',
    connecting: 'Reading paired Pi…',
    reading: 'Paired Pi · boat LAN · read only',
    paused: 'Notification reader paused',
    unavailable: 'Paired Pi source unavailable',
    enrollment: 'Set up this phone with the code from the paired Pi',
    update: 'This Pi needs the Signal K reader update',
    error: 'Pi notifications unavailable',
};
export default function PairedPiSignalKCard() {
    const view = useSyncExternalStore(PairedPiNotifications.subscribe, PairedPiNotifications.getSnapshot);
    return (
        <section
            className="mb-3 space-y-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4"
            aria-label="Paired Pi Signal K notifications"
        >
            <h2 className="text-sm font-bold text-white">Signal K through the paired Pi</h2>
            <p className="text-xs leading-relaxed text-gray-300">
                Read cached server notifications over the pinned boat-LAN connection. The Pi handles the Signal K
                connection. This reader stops in the background; it does not provide an owner-away alarm.
            </p>
            <p role="status" className="text-sm text-sky-200">
                {words[view.status]}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void PairedPiNotifications.start()}>
                    Read Pi notifications
                </Button>
                <Button variant="secondary" onClick={() => PairedPiNotifications.stop()}>
                    Stop notifications
                </Button>
            </div>
            {view.status === 'reading' && (
                <label className="flex min-h-11 items-center gap-3 text-xs leading-relaxed text-gray-300">
                    <input
                        type="checkbox"
                        checked={view.soundEnabled}
                        disabled={view.truncated}
                        onChange={(e) => PairedPiNotifications.setNotificationSound(e.target.checked)}
                    />
                    Play a three-second cue for new server alarms while this reader is active. Sound depends on system
                    volume and audio route.
                </label>
            )}
            {view.truncated && (
                <p className="text-xs text-amber-200">
                    The bounded list omits some notifications. Sound cues are paused.
                </p>
            )}
            <SignalKNotifications source="Paired Pi" notices={view.notices} />
        </section>
    );
}
