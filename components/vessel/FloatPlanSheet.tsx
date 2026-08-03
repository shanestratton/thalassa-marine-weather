/**
 * FloatPlanSheet — review and send the float plan.
 *
 * Generate → review → send, NOT a form. Nobody fills in a float plan form;
 * they mean to and then it's dark. Thalassa already knows the vessel, the
 * route, the departure and the ETA, so the sheet composes the whole document
 * and asks only for the three things it genuinely cannot know:
 *
 *   1. the overdue time — THE field, and the reason the document exists
 *   2. who to ring — VMR / Marine Rescue / water police
 *   3. souls on board, because that changes every trip
 *
 * Handed straight to the OS share sheet. Nothing is stored server-side and
 * there is no float-plan URL: this document names the EPIRB hex and the raft,
 * so it goes to one chosen person rather than onto a page.
 */

import React, { useMemo, useState } from 'react';
import { composeFloatPlan, trackDistanceNM } from '../../services/floatPlan';
import { loadSavedTraces } from '../../services/routeTracer';
import type { Voyage } from '../../services/VoyageService';
import { useSettingsStore } from '../../stores/settingsStore';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('FloatPlanSheet');

const HOUR_MS = 3_600_000;
/** Default grace on top of ETA before anyone should start worrying. */
const DEFAULT_OVERDUE_BUFFER_H = 4;

function toLocalInput(ms: number): string {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 16);
}

interface FloatPlanSheetProps {
    voyage: Voyage;
    onClose: () => void;
}

export const FloatPlanSheet: React.FC<FloatPlanSheetProps> = ({ voyage, onClose }) => {
    const vessel = useSettingsStore((s) => s.settings.vessel);

    const departureMs = useMemo(() => {
        const t = voyage.departure_time ? new Date(voyage.departure_time).getTime() : Number.NaN;
        return Number.isFinite(t) ? t : Date.now();
    }, [voyage.departure_time]);

    const etaMs = useMemo(() => {
        const t = voyage.eta ? new Date(voyage.eta).getTime() : Number.NaN;
        return Number.isFinite(t) ? t : null;
    }, [voyage.eta]);

    const [overdueMs, setOverdueMs] = useState<number>(
        () => (etaMs ?? departureMs) + DEFAULT_OVERDUE_BUFFER_H * HOUR_MS,
    );
    const [whoToCall, setWhoToCall] = useState('');
    const [contactAboard, setContactAboard] = useState('');
    const [personsOnBoard, setPersonsOnBoard] = useState<number>(() => voyage.crew_count || vessel?.crewCount || 1);
    const [sent, setSent] = useState(false);

    // The intended track, when this voyage came from a saved route. Best
    // effort: a plan without waypoints is still a float plan, and the
    // composer drops the section rather than printing an empty heading.
    const waypoints = useMemo(() => {
        if (!voyage.saved_route_id) return undefined;
        try {
            const trace = loadSavedTraces().find((t) => t.id === voyage.saved_route_id);
            return trace?.points.map((p) => ({ lat: p.lat, lon: p.lon }));
        } catch {
            return undefined;
        }
    }, [voyage.saved_route_id]);

    const planText = useMemo(
        () =>
            composeFloatPlan({
                vessel,
                route: {
                    name: voyage.voyage_name,
                    from: voyage.departure_port ?? undefined,
                    to: voyage.destination_port ?? undefined,
                    distanceNM: waypoints && waypoints.length >= 2 ? trackDistanceNM(waypoints) : undefined,
                    waypoints,
                },
                departureMs,
                etaMs,
                overdueMs,
                personsOnBoard,
                whoToCall: whoToCall.trim() || undefined,
                contactAboard: contactAboard.trim() || undefined,
            }),
        [vessel, voyage, waypoints, departureMs, etaMs, overdueMs, personsOnBoard, whoToCall, contactAboard],
    );

    // What the SAFETY section will carry — surfaced here so a missing hex ID
    // is discovered on the couch, not by the rescue coordinator.
    const safetyGear: { label: string; value: string | null }[] = [
        { label: 'EPIRB', value: vessel?.epirbHexId ? `hex ${vessel.epirbHexId}` : null },
        {
            label: 'Liferaft',
            value: vessel?.liferaftCapacity ? `${vessel.liferaftCapacity} person` : null,
        },
        { label: 'Flares', value: vessel?.flaresExpiry ? `expire ${vessel.flaresExpiry}` : null },
        { label: 'Other', value: vessel?.safetyNotes?.trim() || null },
    ];
    const missingGear = safetyGear.filter((g) => !g.value && g.label !== 'Other');

    const send = async () => {
        triggerHaptic('medium');
        try {
            const { Share } = await import('@capacitor/share');
            await Share.share({
                title: `Float plan — ${vessel?.name || 'vessel'}`,
                text: planText,
                dialogTitle: 'Send your float plan',
            });
            setSent(true);
        } catch (error) {
            // A cancelled share sheet rejects too — never treat it as failure.
            log.warn('float plan share dismissed or failed', error);
        }
    };

    return (
        <div className="space-y-3" data-testid="float-plan-sheet">
            <p className="text-[11px] leading-snug text-gray-400">
                Send this to one person ashore. It names your EPIRB and liferaft, so it never goes on your public page.
            </p>

            {/* THE field. Given its own block, in amber, because a float plan
                without an overdue time is just an itinerary. */}
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
                <label
                    htmlFor="float-overdue"
                    className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-amber-300"
                >
                    Raise the alarm if not heard from by
                </label>
                <input
                    id="float-overdue"
                    type="datetime-local"
                    value={toLocalInput(overdueMs)}
                    onChange={(e) => {
                        const t = new Date(e.target.value).getTime();
                        if (Number.isFinite(t)) setOverdueMs(t);
                    }}
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-sm font-bold text-white outline-none [color-scheme:dark] focus:border-amber-400"
                />
                <p className="mt-1.5 text-[10px] text-gray-400">
                    Defaults to {DEFAULT_OVERDUE_BUFFER_H} hours after your ETA.
                </p>
            </div>

            <div>
                <label
                    htmlFor="float-who"
                    className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-gray-400"
                >
                    Who should they call
                </label>
                <input
                    id="float-who"
                    type="text"
                    value={whoToCall}
                    onChange={(e) => setWhoToCall(e.target.value)}
                    placeholder="e.g. Marine Rescue Bundaberg — 07 4159 4600"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-sm text-white outline-none focus:border-sky-500"
                />
            </div>

            <div>
                <label
                    htmlFor="float-contact-aboard"
                    className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-gray-400"
                >
                    How to reach you
                </label>
                <input
                    id="float-contact-aboard"
                    type="text"
                    value={contactAboard}
                    onChange={(e) => setContactAboard(e.target.value)}
                    placeholder="e.g. VHF 16, sat phone +870…, Starlink email"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-sm text-white outline-none focus:border-sky-500"
                />
            </div>

            <div>
                <label
                    htmlFor="float-pob"
                    className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-gray-400"
                >
                    On board
                </label>
                <input
                    id="float-pob"
                    type="text"
                    inputMode="numeric"
                    value={String(personsOnBoard)}
                    onChange={(e) => {
                        const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
                        setPersonsOnBoard(Number.isFinite(n) ? n : 0);
                    }}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-sm text-white outline-none focus:border-sky-500"
                />
            </div>

            {/* Safety gear the document will carry — a missing hex ID gets
                discovered on the couch, not by the rescue coordinator. */}
            <div className="rounded-xl border border-white/10 bg-white/5 p-3" data-testid="float-plan-safety">
                <p className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-gray-400">
                    Safety gear in this plan
                </p>
                <div className="space-y-0.5">
                    {safetyGear
                        .filter((g) => g.value)
                        .map((g) => (
                            <p key={g.label} className="text-[11px] text-gray-300">
                                <span className="font-bold text-white">{g.label}</span> — {g.value}
                            </p>
                        ))}
                    {safetyGear.every((g) => !g.value) && (
                        <p className="text-[11px] text-gray-400">Nothing recorded yet.</p>
                    )}
                </div>
                {missingGear.length > 0 && (
                    <p className="mt-1.5 text-[10px] text-amber-300">
                        No {missingGear.map((g) => g.label).join(', ')} recorded — add under Settings → Vessel → Safety
                        so rescue knows what to look for.
                    </p>
                )}
            </div>

            <details open className="rounded-xl border border-white/10 bg-black/30">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400">
                    Preview
                </summary>
                <pre
                    data-testid="float-plan-preview"
                    className="max-h-56 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-[10px] leading-relaxed text-gray-300"
                >
                    {planText}
                </pre>
            </details>

            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    className="flex-1 rounded-xl bg-white/10 py-2.5 text-xs font-black uppercase tracking-wide text-gray-300 active:scale-95"
                >
                    {sent ? 'Done' : 'Cancel'}
                </button>
                <button
                    type="button"
                    onClick={send}
                    className="flex-[2] rounded-xl bg-amber-500/20 py-2.5 text-xs font-black uppercase tracking-wide text-amber-200 active:scale-95"
                >
                    {sent ? 'Send again' : 'Send float plan'}
                </button>
            </div>
        </div>
    );
};
