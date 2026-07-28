import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShipLogService } from '../../services/ShipLogService';
import { VoyageLogService } from '../../services/VoyageLogService';
import { fetchRoutesAndTracks, type RouteOrTrack } from '../../services/shiplog/RoutesAndTracks';
import { suggestPlanForDeparture } from '../../services/shiplog/planMatcher';
import { getLastPosition } from '../../services/shiplog/TrackingStateStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToast } from '../Toast';
import { triggerHaptic } from '../../utils/system';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { buildFollowRoutePlanFromRoute } from '../../services/shiplog/followRoutePlan';
import { useFollowRouteStore } from '../../stores/followRouteStore';

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
        const operationScope = getAuthIdentityScope();
        let alive = true;
        const operationIsCurrent = () => alive && isAuthIdentityScopeCurrent(operationScope);
        void (async () => {
            // Wait for a departure fix — local-first capture writes to the
            // offline queue, and the persisted last GPS is the dock. A short
            // retry covers the seconds between cast-off and first fix.
            const fix = await resolveDepartureFix(vid, operationIsCurrent);
            if (!operationIsCurrent() || !fix) return;
            planPromptCheckedFor.current = vid; // only mark checked once we truly ran
            try {
                const [{ routes }, links] = await Promise.all([
                    fetchRoutesAndTracks(),
                    VoyageLogService.getPlanLinks(),
                ]);
                if (!operationIsCurrent() || links.has(vid)) return; // already linked
                // Local-only plans can't drive the public page (their entries
                // aren't on the server yet) — never suggest them.
                const plan = suggestPlanForDeparture(
                    routes.filter((r) => !r.isLocal),
                    Date.now(),
                    fix,
                );
                if (operationIsCurrent() && plan) setPlanPrompt({ voyageId: vid, plan });
            } catch {
                /* offline at the dock — retro-link from settings instead */
            }
        })();
        return () => {
            alive = false;
        };
    }, [isTracking, voyageId]);

    // Retire the suggestion the moment a link is made anywhere else — the
    // follow sheet publishes one on every pick. Without this the banner stays
    // armed behind the sheet and surfaces after it closes, reading as "confirm
    // the choice you just made" while actually proposing a different plan.
    useEffect(() => {
        const onLinked = (event: Event) => {
            const linkedId = (event as CustomEvent<{ voyageId?: string }>).detail?.voyageId;
            setPlanPrompt((current) => (current && (!linkedId || current.voyageId === linkedId) ? null : current));
        };
        window.addEventListener('thalassa:voyage-plan-link-changed', onLinked);
        return () => window.removeEventListener('thalassa:voyage-plan-link-changed', onLinked);
    }, []);

    const linkPromptedPlan = useCallback(async () => {
        if (!planPrompt) return;
        const operationScope = getAuthIdentityScope();
        const { voyageId: vid, plan } = planPrompt;
        setPlanPrompt(null);
        // A SUGGESTION MUST NEVER OVERWRITE A CHOICE.
        //
        // This banner arms from a one-shot `links.has(vid)` read taken the
        // moment the departure fix resolves, and never re-checks. The follow
        // sheet on the Log page appears immediately and sits at z-[10055],
        // above this banner at z-[9990] — so the ordinary sequence is: sheet
        // opens, snapshot is taken with no link yet, skipper picks a route,
        // sheet closes, and the banner is revealed still offering the plan
        // suggestPlanForDeparture guessed. Because that heuristic picks the
        // plan whose departure is nearest to now, and summaries are sorted
        // newest-first, its guess is reliably the FIRST ROW of the list the
        // skipper was just looking at — which is exactly what "I select one
        // and it uses the first one on the list" looks like from the cockpit.
        //
        // Re-read immediately before writing: an existing link was made
        // deliberately and outranks anything inferred from a timestamp.
        const existing = await VoyageLogService.getPlanLinks();
        if (!isAuthIdentityScopeCurrent(operationScope)) return;
        if (existing.has(vid)) return;

        const localPlan = buildFollowRoutePlanFromRoute(plan);
        if (localPlan && isAuthIdentityScopeCurrent(operationScope)) {
            useFollowRouteStore.getState().startFollowing(localPlan, plan.id, plan.points);
        }
        const ok = await VoyageLogService.setVoyagePlanLink(vid, plan.id);
        if (!isAuthIdentityScopeCurrent(operationScope)) return;
        if (ok) toast.success(`Following ${plan.label} — linked on your public page`);
        else if (localPlan)
            toast.error(VoyageLogService.lastError ?? 'Following locally — public link failed; try Settings later');
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
 * queue (local-first capture target) and the persisted last GPS fix.
 *
 * The window used to be 7 attempts at 5 s — about 35 seconds. Miss that and
 * the effect returned, its deps ([isTracking, voyageId]) never changed again,
 * and the public-page link prompt was gone for the WHOLE voyage. A cold GPS
 * start silently costs the skipper the prompt entirely, which is half of
 * "sometimes it does not ask if i want to link it to the public page".
 *
 * Now polls for ~5 minutes, easing from 5 s to 15 s so a long wait is cheap.
 * That is well within a passage's first leg, and `alive` aborts the moment
 * the voyage ends or the account changes, so a patient loop costs nothing
 * when it is not needed.
 */
async function resolveDepartureFix(
    voyageId: string,
    alive: () => boolean,
): Promise<{ lat: number; lon: number } | null> {
    // 24 attempts: 6 x 5 s then 18 x 15 s ≈ 5 minutes.
    for (let attempt = 0; attempt < 24 && alive(); attempt++) {
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
        await new Promise((r) => setTimeout(r, attempt < 6 ? 5000 : 15000));
    }
    return null;
}
