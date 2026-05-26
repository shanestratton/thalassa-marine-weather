/**
 * Regression guard for the "track cut out / missing start / log says
 * not-running after backgrounding" bug.
 *
 * Root cause: on an iOS suspend/resume that reloads the WebView mid-voyage,
 * ShipLogService.initialize() used to mark the voyage STOPPED + stamp an end
 * time even though the native GPS engine was still recording — stranding the
 * already-recorded track under a dead voyage id. decideInitTrackingAction is
 * the pure decision that now drives that branch; this pins its behaviour.
 */
import { describe, it, expect } from 'vitest';
import { decideInitTrackingAction } from '../services/shiplog/TrackingStateStore';

describe('decideInitTrackingAction — voyage continuity across iOS suspend/resume', () => {
    const base = {
        persistedIsTracking: true,
        persistedIsPaused: false,
        schedulerRunning: false, // fresh JS context — no in-memory scheduler
        nativeTrackingEnabled: true,
        currentVoyageId: 'voyage_123' as string | null | undefined,
    };

    it('RESUMES the same voyage when native GPS is still live after a JS reload (the bug)', () => {
        // Persisted-tracking + no JS scheduler + native engine still enabled =
        // iOS suspended/reloaded the WebView mid-voyage. Must continue the SAME
        // voyage in place, not end it.
        expect(decideInitTrackingAction(base)).toEqual({ action: 'resume', voyageId: 'voyage_123' });
    });

    it('does NOTHING during in-session page navigation (scheduler still running)', () => {
        expect(decideInitTrackingAction({ ...base, schedulerRunning: true })).toEqual({ action: 'none' });
    });

    it('marks stopped on a genuine cold start / force-close (native engine NOT running)', () => {
        expect(decideInitTrackingAction({ ...base, nativeTrackingEnabled: false })).toEqual({
            action: 'mark-stopped',
        });
    });

    it('marks stopped when native is live but there is no voyage id to resume', () => {
        expect(decideInitTrackingAction({ ...base, currentVoyageId: undefined })).toEqual({ action: 'mark-stopped' });
        expect(decideInitTrackingAction({ ...base, currentVoyageId: null })).toEqual({ action: 'mark-stopped' });
    });

    it('does nothing when not tracking', () => {
        expect(decideInitTrackingAction({ ...base, persistedIsTracking: false })).toEqual({ action: 'none' });
    });

    it('does nothing when the voyage is intentionally paused', () => {
        expect(decideInitTrackingAction({ ...base, persistedIsPaused: true })).toEqual({ action: 'none' });
    });
});
