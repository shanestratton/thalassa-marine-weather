/**
 * Is the passage HUD on the chart? (Build 124: there is no switch.)
 *
 * Shane, 2026-10-08: "I don't think that we need a setting for it. It should
 * just be the standard setup for routes. Or tracks on the log page." So the
 * pane is there whenever it has something to show:
 *   - a route being followed (with a line to measure along),
 *   - a recording running or paused (a Log-page track), or
 *   - a route previewed on Obs (stores/passageHudStore, the preview).
 * Whether its readings are open or tucked away is the only choice left, and
 * that stays the skipper's (usePassageHudOpen).
 */
import type { TrackingState } from '../services/shiplog/TrackingStateStore';
import { useFollowRouteStore } from '../stores/followRouteStore';
import { usePassageHudPreviewRoute, type PassageHudPreviewRoute } from '../stores/passageHudStore';
import { useHudRecording } from './useHudRecording';

export function passageHudAvailable(args: {
    following: boolean;
    preview: PassageHudPreviewRoute | null;
    recording: TrackingState;
}): boolean {
    return (
        args.following ||
        args.preview !== null ||
        (!!args.recording.currentVoyageId && (args.recording.isTracking || args.recording.isPaused))
    );
}

export function usePassageHudAvailable(): boolean {
    const following = useFollowRouteStore((s) => s.isFollowing && s.routeCoords.length >= 2);
    const preview = usePassageHudPreviewRoute();
    const recording = useHudRecording();
    return passageHudAvailable({ following, preview, recording });
}
