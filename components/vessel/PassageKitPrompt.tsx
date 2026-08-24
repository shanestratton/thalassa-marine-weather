/**
 * PassageKitPrompt — the nudge that is never a gate.
 *
 * Two moments, one component, both one-shot per voyage:
 *
 *  1. DEPARTURE. Tracking starts, a plan is at hand (PassageStore's computed
 *     route, or the followed route's polyline), and the classifier calls it a
 *     passage — a card offers the passage kit. "Not now" is a first-class
 *     answer: a forced flow teaches skippers to misclassify the fifty-time
 *     delivery as a day cruise, poisoning both the data and the intent. A
 *     casual start with NO plan gets no card at all — there is nothing to
 *     classify, and the escalation path below covers the trip that turns
 *     into something bigger.
 *
 *  2. ESCALATION. The porous boundary: a day sail running long. While
 *     tracking, every ten minutes, the honest condition (2+ hours underway
 *     AND darkness within the hour at the CURRENT position — see
 *     escalationDue) is checked; when it first holds, a toast offers the
 *     night kit. Statistically this trip — the one nobody planned — is the
 *     one the ceremony exists for.
 *
 * "The kit" is not a new surface: accepting navigates to the existing
 * Passage Planning page ('crew'), where readiness, crew, watches and the
 * float plan already live. Mounted globally beside DeparturePrompts, whose
 * one-shot-per-voyageId shape this deliberately copies.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShipLogService } from '../../services/ShipLogService';
import { LocationStore } from '../../stores/LocationStore';
import { useUIStore } from '../../stores/uiStore';
import { PassageStore } from '../../stores/PassageStore';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { classifyPlannedRoute, escalationDue, type PassageVerdict } from '../../utils/passageClass';
import { toast } from '../Toast';
import { triggerHaptic } from '../../utils/system';

const ESCALATION_POLL_MS = 10 * 60 * 1000;

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

    // ── Departure verdict, one-shot per voyage ──
    const [prompt, setPrompt] = useState<{ voyageId: string; verdict: PassageVerdict } | null>(null);
    const checkedFor = useRef<string | null>(null);
    useEffect(() => {
        if (!isTracking || !voyageId) return;
        if (checkedFor.current === voyageId) return;
        checkedFor.current = voyageId;
        const plan = planAtHand();
        if (!plan) return; // casual start — nothing to classify, no card
        const verdict = classifyPlannedRoute(plan.points, Date.now(), plan.speedKts);
        if (verdict.kind === 'passage') setPrompt({ voyageId, verdict });
    }, [isTracking, voyageId]);

    // Clear the card the moment tracking stops.
    useEffect(() => {
        if (!isTracking) setPrompt(null);
    }, [isTracking]);

    const openKit = useCallback(() => {
        triggerHaptic('medium');
        setPrompt(null);
        setPage('crew');
    }, [setPage]);

    // ── Mid-trip escalation, one-shot per voyage ──
    const escalatedFor = useRef<string | null>(null);
    useEffect(() => {
        if (!isTracking || !voyageId) return;
        const vid = voyageId;
        const check = () => {
            if (escalatedFor.current === vid) return;
            // voyageStartTime is an ISO string in TrackingState — parse it,
            // and refuse to escalate on an unparseable one rather than
            // comparing a NaN.
            const startIso = ShipLogService.getTrackingStatus().voyageStartTime;
            const startMs = startIso ? Date.parse(startIso) : NaN;
            const { lat, lon } = LocationStore.getState();
            if (!Number.isFinite(startMs) || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
            if (!escalationDue(Date.now(), startMs, lat, lon)) return;
            escalatedFor.current = vid;
            toast.success('Running into night — this is becoming a passage', {
                label: 'Night kit',
                onClick: () => setPage('crew'),
            });
        };
        // First check shortly after start (a trip resumed at dusk should hear
        // about it now, not in ten minutes), then on the slow poll.
        const first = setTimeout(check, 30_000);
        const id = setInterval(check, ESCALATION_POLL_MS);
        return () => {
            clearTimeout(first);
            clearInterval(id);
        };
    }, [isTracking, voyageId, setPage]);

    if (!isTracking || !prompt || prompt.voyageId !== voyageId) return null;

    return (
        <div
            className="fixed left-4 right-4 z-[9991] animate-slide-up"
            style={{ bottom: 'calc(9rem + env(safe-area-inset-bottom))' }}
        >
            <div className="bg-slate-800 border border-indigo-500/30 rounded-2xl px-4 py-3 shadow-2xl shadow-black/50">
                <div className="text-sm font-bold text-white">
                    <span aria-hidden>🌙 </span>This looks like a passage
                </div>
                <div className="text-xs text-gray-400 mt-1">
                    {prompt.verdict.reasons.join(' · ')}. The passage kit lines up readiness, crew, watches and your
                    float plan — or just sail.
                </div>
                <div className="flex gap-2 mt-3">
                    <button
                        onClick={openKit}
                        className="flex-1 py-2 bg-indigo-500/20 text-indigo-300 rounded-xl text-xs font-black uppercase tracking-widest active:scale-95 transition-all"
                    >
                        Passage kit
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
