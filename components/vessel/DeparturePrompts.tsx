import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShipLogService } from '../../services/ShipLogService';
import { VoyageLogService } from '../../services/VoyageLogService';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToast } from '../Toast';
import { triggerHaptic } from '../../utils/system';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { ModalSheet } from '../ui/ModalSheet';
import { Button } from '../ui/Button';

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

    const keepPrivate = () => {
        triggerHaptic('light');
        setSharePrompt(null);
    };

    // "Share this voyage live?" — surfaced at departure so the deep-menu
    // toggle isn't the only way to opt in. A centred ModalSheet, like every
    // other choice in the app: it slid up from the bottom, the one choice
    // surface that did (UX scorecard run 9). Closing it (X, backdrop, Escape)
    // is Keep private, as dismissing the old card was.
    return (
        <ModalSheet
            isOpen={sharePrompt !== null && sharePrompt === voyageId}
            onClose={keepPrivate}
            title="Share this voyage live?"
            maxWidth="max-w-sm"
            zIndex="z-9991"
        >
            <p className="text-sm leading-relaxed text-gray-300">
                Your track will build on your public page as you sail, so friends and family can follow along. You can
                turn it off any time.
            </p>
            <div className="mt-5 flex gap-2">
                <Button variant="secondary" onClick={keepPrivate} className="flex-1 text-gray-200">
                    Keep private
                </Button>
                <Button
                    variant="primary"
                    onClick={() => {
                        triggerHaptic('medium');
                        void enableLiveShare();
                    }}
                    className="flex-1"
                >
                    Share live
                </Button>
            </div>
        </ModalSheet>
    );
};
