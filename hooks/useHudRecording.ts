import { useEffect, useState, useSyncExternalStore } from 'react';
import { ShipLogService } from '../services/ShipLogService';
import type { TrackingState } from '../services/shiplog/TrackingStateStore';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../services/authIdentityScope';
import { activatePassageHudForRecording } from '../stores/passageHudStore';

const IDLE: TrackingState = Object.freeze({ isTracking: false, isPaused: false, isRapidMode: false });
const subscribeIdentity = (notify: () => void) => subscribeAuthIdentityScope(() => notify());

/** Observe the recorder already owned by the app. Never initialize or acquire GPS here. */
export function useHudRecording(): TrackingState {
    const scope = useSyncExternalStore(subscribeIdentity, getAuthIdentityScope, getAuthIdentityScope);
    const [snapshot, setSnapshot] = useState(() => ({ scope, state: ShipLogService.getPublishedTrackingStatus() }));
    useEffect(() => {
        let current = true;
        const unsubscribe = ShipLogService.onTrackingStateChange(() => {
            if (current && getAuthIdentityScope() === scope) {
                setSnapshot({ scope, state: ShipLogService.getPublishedTrackingStatus() });
            }
        });
        return () => {
            current = false;
            unsubscribe();
        };
    }, [scope]);
    return snapshot.scope === scope ? snapshot.state : IDLE;
}

/** Mounted above navigation so starting in Log prepares OBS without changing pages. */
export function useHudRecordingActivation(): void {
    const recording = useHudRecording();
    const scope = getAuthIdentityScope();
    useEffect(() => {
        if (getAuthIdentityScope() !== scope) return;
        if (recording.isTracking && !recording.isPaused && recording.currentVoyageId) {
            activatePassageHudForRecording(recording.currentVoyageId);
        }
    }, [scope, recording.isTracking, recording.isPaused, recording.currentVoyageId]);
}
