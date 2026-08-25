/**
 * PassageKitPrompt — the nudge that is never a gate.
 *
 * TWO deterministic moments, one amber card, each one-shot per key:
 *
 *  1. ROUTE COMMITTED. A saved route is picked to follow (the Log page's
 *     "follow this route" — Shane 2026-08-25: "i selected the newport, to
 *     coral sea route, but no message about it being a passage??"). The
 *     classifier reads the committed polyline; a passage shows the warning
 *     right there, before a single line is cast off — while provisioning
 *     and medications can still happen.
 *
 *  2. DEPARTURE. Tracking starts with a plan at hand (PassageStore's
 *     computed route, or the followed route's polyline) that was not
 *     already warned about at commit time.
 *
 * "Not now" is a first-class answer: a forced flow teaches skippers to
 * misclassify the fifty-time delivery as a day cruise, poisoning both the
 * data and the intent. A casual start with NO plan gets no card at all —
 * there is nothing to classify. NEVER a toast (Shane: "i hate toast
 * messages") and never compulsory.
 *
 * MID-TRIP ESCALATION WAS CUT (Shane, 2026-08-25): "the punter will avoid
 * it like the plague; also, things like provisioning, medications etc —
 * it's too late." The kit's whole value is before the lines come off; a
 * toast at dusk can't buy tinned food or fill a prescription. If the
 * passage nudge earns a second surface it will be BEFORE departure (the
 * planning banner), never during.
 *
 * "The kit" is not a new surface: accepting navigates to the existing
 * Passage Planning page ('crew'), where readiness, crew, watches and the
 * float plan already live. Mounted globally beside DeparturePrompts, whose
 * one-shot-per-voyageId shape this deliberately copies.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShipLogService } from '../../services/ShipLogService';
import { useUIStore } from '../../stores/uiStore';
import { PassageStore } from '../../stores/PassageStore';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { classifyPlannedRoute, type PassageVerdict } from '../../utils/passageClass';
import { triggerHaptic } from '../../utils/system';

/** Best available plan for the voyage just started, or null for a casual
 *  no-plan start. Reads only stores that are already resident. */
function planAtHand(): { points: { lat: number; lon: number }[]; speedKts?: number } | null {
    try {
        const ps = PassageStore.getState();
        if (ps?.routeCoordinates && ps.routeCoordinates.length >= 2) {
            return {
                points: ps.routeCoordinates.map(([lon, lat]: [number, number]) => ({ lat, lon })),
                speedKts: ps.avgSpeedKts ?? undefined,
            };
        }
    } catch {
        /* store shape drift must not break departure */
    }
    try {
        const fr = useFollowRouteStore.getState();
        if (fr?.routeCoords && fr.routeCoords.length >= 2) {
            return { points: fr.routeCoords.map((c: { lat: number; lon: number }) => ({ lat: c.lat, lon: c.lon })) };
        }
    } catch {
        /* same */
    }
    return null;
}

export const PassageKitPrompt: React.FC = () => {
    const setPage = useUIStore((s) => s.setPage);

    const [isTracking, setIsTracking] = useState<boolean>(() => ShipLogService.getTrackingStatus().isTracking === true);
    const [voyageId, setVoyageId] = useState<string | undefined>(() => ShipLogService.getCurrentVoyageId());
    useEffect(() => {
        const unsub = ShipLogService.onTrackingStateChange((tracking) => {
            setIsTracking(tracking);
            setVoyageId(ShipLogService.getCurrentVoyageId());
        });
        return unsub;
    }, []);

    // ── The card, one-shot per route GEOMETRY ──
    // Keyed on the polyline itself (ends + length), not on which trigger saw
    // it: a route warned about when it was picked must not warn again when
    // tracking starts on it — same water, same warning, once.
    const [prompt, setPrompt] = useState<{ key: string; verdict: PassageVerdict } | null>(null);
    const promptedKeys = useRef<Set<string>>(new Set());
    const offer = useCallback((points: { lat: number; lon: number }[], speedKts?: number) => {
        if (points.length < 2) return;
        const a = points[0];
        const b = points[points.length - 1];
        const key = `${points.length}:${a.lat.toFixed(3)},${a.lon.toFixed(3)}:${b.lat.toFixed(3)},${b.lon.toFixed(3)}`;
        if (promptedKeys.current.has(key)) return;
        const verdict = classifyPlannedRoute(points, Date.now(), speedKts);
        if (verdict.kind !== 'passage') return;
        promptedKeys.current.add(key);
        setPrompt({ key, verdict });
    }, []);

    // Trigger 1 — ROUTE COMMITTED: the followed route's polyline, the moment
    // it is picked. Fires on the Log page before any tracking exists.
    const followStartedAt = useFollowRouteStore((st) => st.startedAt);
    const followIsFollowing = useFollowRouteStore((st) => st.isFollowing);
    useEffect(() => {
        if (!followIsFollowing) return;
        const fr = useFollowRouteStore.getState();
        if (!fr.routeCoords || fr.routeCoords.length < 2) return;
        offer(fr.routeCoords);
    }, [followIsFollowing, followStartedAt, offer]);

    // Trigger 2 — DEPARTURE: tracking starts with a plan at hand that was
    // not already warned about when it was committed.
    useEffect(() => {
        if (!isTracking || !voyageId) return;
        const plan = planAtHand();
        if (!plan) return; // casual start — nothing to classify, no card
        offer(plan.points, plan.speedKts);
    }, [isTracking, voyageId, offer]);

    const openKit = useCallback(() => {
        triggerHaptic('medium');
        setPrompt(null);
        setPage('crew');
    }, [setPage]);

    if (!prompt) return null;

    return (
        <div
            className="fixed left-4 right-4 z-[9991] animate-slide-up"
            style={{ bottom: 'calc(9rem + env(safe-area-inset-bottom))' }}
        >
            <div className="bg-slate-900 border border-amber-500/40 rounded-2xl px-4 py-3 shadow-2xl shadow-black/50">
                <div className="text-sm font-bold text-amber-300">
                    <span aria-hidden>⚠️ </span>This is a passage
                </div>
                <div className="text-xs text-gray-300 mt-1">
                    {prompt.verdict.reasons.join(' · ')}. Passage planning lines up readiness, provisioning, crew,
                    watches and your float plan — or just sail.
                </div>
                <div className="flex gap-2 mt-3">
                    <button
                        onClick={openKit}
                        className="flex-1 py-2 bg-amber-500/20 text-amber-300 rounded-xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all"
                    >
                        Passage planning
                    </button>
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setPrompt(null);
                        }}
                        className="flex-1 py-2 bg-white/5 text-gray-400 rounded-xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all"
                    >
                        Not now
                    </button>
                </div>
            </div>
        </div>
    );
};
