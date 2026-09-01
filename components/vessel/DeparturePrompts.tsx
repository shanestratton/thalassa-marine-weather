import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShipLogService } from '../../services/ShipLogService';
import { VoyageLogService } from '../../services/VoyageLogService';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToast } from '../Toast';
import { triggerHaptic } from '../../utils/system';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';

/**
 * DeparturePrompts — the "at departure" nudge:
 *   "Share this voyage live?" (flip the live-share toggle without
 *   hunting through Settings)
 *
 * WHY THIS IS GLOBAL (Shane 2026-07-05: "when I run a log it is not asking
 * me if I want to show the track on the public page — it was supposed to do
 * that"):
 *
 * This lived inside LogPage. But the app mounts ONE view at a time
 * (App.tsx <PageTransition pageKey={currentView}>), and a voyage is almost
 * always cast off from the helm's CastOffPanel — where LogPage isn't
 * mounted. So the LogPage effect never ran at departure and the prompt
 * never appeared. Driving it from ShipLogService's global tracking
 * listener instead of a mounted page fixes that: it now fires the moment
 * you cast off, from anywhere. Mounted once, near the global ToastPortal.
 *
 * The second nudge that used to live here — the "Sailing <plan>? / Link
 * passage" suggestion banner — was REMOVED 2026-08-02 (Shane: "this message
 * has been superseded"). The cast-off "Following a route?" sheet on the Log
 * page is the one place that question is asked now; it lists every candidate
 * and links the picked one to the public page itself. The banner's
 * nearest-departure heuristic reliably guessed the FIRST row of that same
 * list and re-asked after the sheet closed, reading as a duplicate
 * confirmation that then linked the wrong track. Retro-linking a missed
 * voyage still works from Settings → Voyage Log.
 */
export const DeparturePrompts: React.FC = () => {
    const toast = useToast();
    const liveTrackShare = useSettingsStore((s) => s.settings.liveTrackShare);
    const updateSettings = useSettingsStore((s) => s.updateSettings);

    // ── Global tracking snapshot (service-driven, not page-driven) ──
    // onTrackingStateChange fires once immediately with the current state
    // and again on every start/stop/pause. currentVoyageId is set before
    // notifyTrackingChanged() in startTracking, so it's reliable here.
    const [isTracking, setIsTracking] = useState<boolean>(() => ShipLogService.getTrackingStatus().isTracking === true);
    const [voyageId, setVoyageId] = useState<string | undefined>(() => ShipLogService.getCurrentVoyageId());
    useEffect(() => {
        const unsub = ShipLogService.onTrackingStateChange((tracking) => {
            setIsTracking(tracking);
            setVoyageId(ShipLogService.getCurrentVoyageId());
        });
        return unsub;
    }, []);

    // ── "Share this voyage live?" ──
    // Fires once per new voyage, only when the public log is enabled AND
    // live-share is currently off (no nag once they've opted in).
    const [sharePrompt, setSharePrompt] = useState<string | null>(null); // voyageId
    const sharePromptCheckedFor = useRef<string | null>(null);
    useEffect(() => {
        if (!isTracking || !voyageId) return;
        if (sharePromptCheckedFor.current === voyageId) return;
        sharePromptCheckedFor.current = voyageId;
        if (liveTrackShare === true) return; // already sharing — don't ask
        const vid = voyageId;
        const operationScope = getAuthIdentityScope();
        let alive = true;
        void (async () => {
            try {
                const cfg = await VoyageLogService.getConfig();
                if (alive && isAuthIdentityScopeCurrent(operationScope) && cfg?.enabled) setSharePrompt(vid);
            } catch {
                /* offline / no public log — the Settings toggle still works */
            }
        })();
        return () => {
            alive = false;
        };
    }, [isTracking, voyageId, liveTrackShare]);

    const enableLiveShare = useCallback(async () => {
        const operationScope = getAuthIdentityScope();
        setSharePrompt(null);
        void updateSettings({ liveTrackShare: true });
        try {
            const { markLiveTrickleFreshStart } = await import('../../services/shiplog/LiveTrickle');
            if (!isAuthIdentityScopeCurrent(operationScope)) return;
            await markLiveTrickleFreshStart(operationScope);
        } catch {
            /* trickle module lazy-load failed — the toggle still took effect */
        }
        if (!isAuthIdentityScopeCurrent(operationScope)) return;
        toast.success('Sharing live — your track will build on your public page');
    }, [updateSettings, toast]);

    // Clear any live prompt the moment tracking stops.
    useEffect(() => {
        if (!isTracking) setSharePrompt(null);
    }, [isTracking]);

    if (!isTracking) return null;

    return (
        <>
            {/* "Share this voyage live?" — surfaced at departure so the
                deep-menu toggle isn't the only way to opt in. */}
            {sharePrompt && sharePrompt === voyageId && (
                <div
                    className="fixed left-4 right-4 z-9991 animate-slide-up"
                    style={{ bottom: 'calc(9rem + env(safe-area-inset-bottom))' }}
                >
                    <div className="bg-slate-800 border border-emerald-500/30 rounded-2xl px-4 py-3 shadow-2xl shadow-black/50">
                        <div className="text-sm font-bold text-white">Share this voyage live?</div>
                        <div className="text-xs text-gray-400 mt-1">
                            Your track will build on your public page as you sail, so friends and family can follow
                            along. You can turn it off any time.
                        </div>
                        <div className="flex gap-2 mt-3">
                            <button
                                onClick={() => {
                                    triggerHaptic('medium');
                                    void enableLiveShare();
                                }}
                                className="flex-1 py-2 bg-emerald-500/20 text-emerald-300 rounded-xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all"
                            >
                                Share live
                            </button>
                            <button
                                onClick={() => {
                                    triggerHaptic('light');
                                    setSharePrompt(null);
                                }}
                                className="flex-1 py-2 bg-white/5 text-gray-400 rounded-xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all"
                            >
                                Keep private
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
