import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShipLogService } from '../../services/ShipLogService';
import { VoyageLogService } from '../../services/VoyageLogService';
import { fetchRoutesAndTracks, type RouteOrTrack } from '../../services/shiplog/RoutesAndTracks';
import { suggestPlanForDeparture } from '../../services/shiplog/planMatcher';
import { getLastPosition } from '../../services/shiplog/TrackingStateStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToast } from '../Toast';
import { triggerHaptic } from '../../utils/system';

/**
 * DeparturePrompts — the two "at departure" nudges:
 *   1. "Share this voyage live?" (flip the live-share toggle without
 *      hunting through Settings)
 *   2. "Sailing <plan>?" (one-tap link a saved passage plan to this voyage
 *      so the public page shows destination + live progress)
 *
 * WHY THIS IS GLOBAL (Shane 2026-07-05: "when I run a log it is not asking
 * me if I want to show the track on the public page / follow a suggested
 * route — it was supposed to do that"):
 *
 * These lived inside LogPage. But the app mounts ONE view at a time
 * (App.tsx <PageTransition pageKey={currentView}>), and a voyage is almost
 * always cast off from the helm's CastOffPanel — where LogPage isn't
 * mounted. So the LogPage effects never ran at departure and neither
 * prompt appeared. Driving them from ShipLogService's global tracking
 * listener instead of a mounted page fixes that: they now fire the moment
 * you cast off, from anywhere. Mounted once, near the global ToastPortal.
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
        void (async () => {
            try {
                const cfg = await VoyageLogService.getConfig();
                if (cfg?.enabled) setSharePrompt(vid);
            } catch {
                /* offline / no public log — the Settings toggle still works */
            }
        })();
    }, [isTracking, voyageId, liveTrackShare]);

    const enableLiveShare = useCallback(async () => {
        setSharePrompt(null);
        void updateSettings({ liveTrackShare: true });
        try {
            const { markLiveTrickleFreshStart } = await import('../../services/shiplog/LiveTrickle');
            await markLiveTrickleFreshStart();
        } catch {
            /* trickle module lazy-load failed — the toggle still took effect */
        }
        toast.success('Sharing live — your track will build on your public page');
    }, [updateSettings, toast]);

    // ── Passage-plan link prompt ──
    // Once the departing voyage has a real fix, suggest the most plausible
    // saved plan (departure date ±7 d, start within 10 NM) for a one-tap
    // link. NEVER links silently; dismissal is remembered per voyage, and a
    // missed prompt can be fixed later from Settings → Voyage Log.
    const [planPrompt, setPlanPrompt] = useState<{ voyageId: string; plan: RouteOrTrack } | null>(null);
    const [planPromptDismissedFor, setPlanPromptDismissedFor] = useState<string | null>(null);
    const planPromptCheckedFor = useRef<string | null>(null);
    useEffect(() => {
        if (!isTracking || !voyageId) return;
        if (planPromptCheckedFor.current === voyageId) return;
        const vid = voyageId;
        let alive = true;
        void (async () => {
            // Wait for a departure fix — local-first capture writes to the
            // offline queue, and the persisted last GPS is the dock. A short
            // retry covers the seconds between cast-off and first fix.
            const fix = await resolveDepartureFix(vid, () => alive);
            if (!alive || !fix) return;
            planPromptCheckedFor.current = vid; // only mark checked once we truly ran
            try {
                const [{ routes }, links] = await Promise.all([
                    fetchRoutesAndTracks(),
                    VoyageLogService.getPlanLinks(),
                ]);
                if (!alive || links.has(vid)) return; // already linked
                // Local-only plans can't drive the public page (their entries
                // aren't on the server yet) — never suggest them.
                const plan = suggestPlanForDeparture(
                    routes.filter((r) => !r.isLocal),
                    Date.now(),
                    fix,
                );
                if (alive && plan) setPlanPrompt({ voyageId: vid, plan });
            } catch {
                /* offline at the dock — retro-link from settings instead */
            }
        })();
        return () => {
            alive = false;
        };
    }, [isTracking, voyageId]);

    const linkPromptedPlan = useCallback(async () => {
        if (!planPrompt) return;
        const { voyageId: vid, plan } = planPrompt;
        setPlanPrompt(null);
        const ok = await VoyageLogService.setVoyagePlanLink(vid, plan.id);
        if (ok) toast.success(`Linked — your page now tracks ${plan.label}`);
        else toast.error(VoyageLogService.lastError ?? 'Link failed — try from Settings later');
    }, [planPrompt, toast]);

    // Clear any live prompt the moment tracking stops.
    useEffect(() => {
        if (!isTracking) {
            setSharePrompt(null);
            setPlanPrompt(null);
        }
    }, [isTracking]);

    if (!isTracking) return null;

    return (
        <>
            {/* "Share this voyage live?" — surfaced at departure so the
                deep-menu toggle isn't the only way to opt in. */}
            {sharePrompt && sharePrompt === voyageId && (
                <div
                    className="fixed left-4 right-4 z-[9991] animate-slide-up"
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

            {/* Passage-plan link prompt — one tap ties this voyage to a saved
                plan. Held back while the share prompt is up — one question at
                a time. */}
            {!sharePrompt &&
                planPrompt &&
                planPrompt.voyageId === voyageId &&
                planPromptDismissedFor !== planPrompt.voyageId && (
                    <div
                        className="fixed left-4 right-4 z-[9990] animate-slide-up"
                        style={{ bottom: 'calc(9rem + env(safe-area-inset-bottom))' }}
                    >
                        <div className="bg-slate-800 border border-sky-500/30 rounded-2xl px-4 py-3 shadow-2xl shadow-black/50">
                            <div className="text-sm font-bold text-white">Sailing {planPrompt.plan.label}?</div>
                            <div className="text-xs text-gray-400 mt-1">
                                Link this voyage and your public page will show the destination and live passage
                                progress.
                            </div>
                            <div className="flex gap-2 mt-3">
                                <button
                                    onClick={() => {
                                        triggerHaptic('medium');
                                        void linkPromptedPlan();
                                    }}
                                    className="flex-1 py-2 bg-sky-500/20 text-sky-300 rounded-xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all"
                                >
                                    Link passage
                                </button>
                                <button
                                    onClick={() => {
                                        triggerHaptic('light');
                                        setPlanPromptDismissedFor(planPrompt.voyageId);
                                        setPlanPrompt(null);
                                    }}
                                    className="flex-1 py-2 bg-white/5 text-gray-400 rounded-xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all"
                                >
                                    Not this trip
                                </button>
                            </div>
                        </div>
                    </div>
                )}
        </>
    );
};

const isValidFix = (lat: unknown, lon: unknown): lat is number =>
    typeof lat === 'number' && typeof lon === 'number' && !(lat === 0 && lon === 0);

/**
 * Resolve a departure position for the plan match. Checks the offline
 * queue (local-first capture target) and the persisted last GPS fix,
 * retrying for ~30 s to bridge the gap between cast-off and first fix.
 * `alive` lets the caller abort when the voyage ends mid-wait.
 */
async function resolveDepartureFix(
    voyageId: string,
    alive: () => boolean,
): Promise<{ lat: number; lon: number } | null> {
    for (let attempt = 0; attempt < 7 && alive(); attempt++) {
        try {
            const offline = await ShipLogService.getOfflineEntries();
            const e = offline.find((x) => x.voyageId === voyageId && isValidFix(x.latitude, x.longitude));
            if (e) return { lat: e.latitude, lon: e.longitude };
        } catch {
            /* keep trying */
        }
        try {
            const pos = await getLastPosition();
            if (pos && isValidFix(pos.latitude, pos.longitude)) return { lat: pos.latitude, lon: pos.longitude };
        } catch {
            /* keep trying */
        }
        if (!alive()) break;
        await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
}
