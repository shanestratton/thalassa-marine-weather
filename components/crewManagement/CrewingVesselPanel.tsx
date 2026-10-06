/**
 * CrewingVesselPanel — the top of the Crew & Float Plan page while the account
 * is crew on a skipper's boat (Shane 2026-10-03: "it should all pertain to the
 * vessel that the punter has been invited on").
 *
 *   Crewing on Wandering Albatross
 *   Skipper: Capt Ana Reyes · Your role: Co-skipper
 *   [register chips]                      Switch boat · Leave
 *   Crew aboard Wandering Albatross — read-only, '(you)' against your row.
 *
 * Crew aboard is everyone, each once (Shane 2026-10-06: "it does not show the
 * other person ... we need all 3 people on both devices"): the skipper's own
 * vessel-profile people (his First mate, a partner who has no app) and the app
 * crew not already among them, merged exactly as the float plan card merges
 * them (crewVesselPeople). It used to list the app crew alone, so anyone the
 * skipper typed but never invited was missing here while the card counted
 * them. The order is the skipper's own profile order (his Skipper row is
 * usually first, but not if he put someone above it), then app crew he never
 * typed; an app skipper with no Skipper row heads the list. Names and roles
 * only: never a phone or an age, yours included.
 *
 * Presentational: CrewManagement decides what leaving or switching does. Never
 * an email: the skipper appears by name.
 */
import React, { useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { REGISTER_ICONS, REGISTER_LABELS, type CrewMember, type SharedRegister } from '../../services/CrewService';
import {
    crewRoleLabel,
    crewVesselName,
    crewVesselPeople,
    getCachedCrewVesselView,
    type CrewVesselView,
} from '../../services/crew/crewVesselView';
import { CREW_ROLE_SENIORITY, type FloatPlanSelfDetails } from '../../services/crew/floatPlanPeople';
import type { CrewVessel } from '../../services/vessel/sharedBinders';
import { SKIPPER_BOAT_FALLBACK } from '../vessel/SharedBinderLine';
import { triggerHaptic } from '../../utils/system';

/** The most senior role across the account's rows for this boat. */
export function seniorRole(rows: readonly Pick<CrewMember, 'role'>[], fallback?: string | null): string | null {
    const roles = rows.map((row) => row.role as string).filter(Boolean);
    if (fallback) roles.push(fallback);
    return roles.sort((a, b) => (CREW_ROLE_SENIORITY[b] ?? 0) - (CREW_ROLE_SENIORITY[a] ?? 0))[0] ?? null;
}

/** The hull this account is crew on, by the view's name first (see crewVesselName). */
export function crewBoatName(vessel: CrewVessel | null, view: CrewVesselView | null): string {
    return crewVesselName(vessel?.vesselName, view) || SKIPPER_BOAT_FALLBACK;
}

function lastUpdated(iso: string): string {
    const date = new Date(iso);
    return Number.isFinite(date.getTime())
        ? date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : 'earlier';
}

interface CrewingVesselPanelProps {
    vessel: CrewVessel;
    vessels: CrewVessel[];
    /** The account's own accepted rows for this boat (role and register chips). */
    rows: CrewMember[];
    view: CrewVesselView | null;
    /**
     * Your own details from Settings → Vessel Profile, so you are matched and
     * named as on the float plan card. Only the name is shown here.
     */
    self?: FloatPlanSelfDetails | null;
    stale: boolean;
    loading: boolean;
    onLeave: (rows: CrewMember[]) => void;
    onSwitch: (ownerId: string) => void;
}

export const CrewingVesselPanel: React.FC<CrewingVesselPanelProps> = ({
    vessel,
    vessels,
    rows,
    view,
    self = null,
    stale,
    loading,
    onLeave,
    onSwitch,
}) => {
    const [switching, setSwitching] = useState(false);
    const boat = crewBoatName(vessel, view);
    const skipper = view?.manifest.find((entry) => entry.isSkipper);
    const selfEntry = view?.manifest.find((entry) => entry.isSelf);
    const role = seniorRole(rows, vessel.role ?? (selfEntry && selfEntry.role !== 'crew' ? selfEntry.role : null));
    const registers = [...new Set(rows.flatMap((row) => row.shared_registers))] as SharedRegister[];
    const title = `Crewing on ${boat}`;
    const aboardTitle = `Crew aboard ${boat}`;
    const people = crewVesselPeople(view, self);

    return (
        <section aria-label={title} data-testid="crewing-vessel-panel" className="mb-5">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <h2 className="text-base font-black text-white">{title}</h2>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-emerald-200/80">
                    {skipper?.name ? <span>Skipper: {skipper.name}</span> : null}
                    <span>Your role: {crewRoleLabel(role)}</span>
                </div>
                {registers.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {registers.map((register) => (
                            <span
                                key={register}
                                className="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-[11px] font-bold text-gray-300"
                            >
                                {REGISTER_ICONS[register]} {REGISTER_LABELS[register] ?? register}
                            </span>
                        ))}
                    </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    {vessels.length > 1 && (
                        <button
                            type="button"
                            onClick={() => {
                                triggerHaptic('light');
                                setSwitching(true);
                            }}
                            className="min-h-[44px] rounded-lg px-3 text-[12px] font-bold text-sky-300 bg-sky-500/10 border border-sky-500/20"
                        >
                            Switch boat
                        </button>
                    )}
                    {rows.length > 0 && (
                        <button
                            type="button"
                            onClick={() => onLeave(rows)}
                            className="ml-auto min-h-[44px] rounded-lg px-3 text-[12px] font-bold text-red-300 bg-red-500/5 border border-red-500/20"
                        >
                            Leave {boat}
                        </button>
                    )}
                </div>
            </div>

            <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-1 h-4 rounded-full bg-sky-500" />
                    <h3 className="text-[11px] font-black text-sky-400 uppercase tracking-[0.2em]">{aboardTitle}</h3>
                </div>
                {people.length > 0 ? (
                    <ul aria-label={aboardTitle} className="space-y-1.5">
                        {people.map((person, index) => (
                            <li
                                key={`${person.isSelf ? 'self' : 'person'}-${index}`}
                                className="flex items-center justify-between gap-3 rounded-xl border border-white/6 bg-white/3 px-3 py-2.5"
                            >
                                <span className="text-sm font-semibold text-white truncate">
                                    {person.name ||
                                        (person.isSelf ? 'You' : person.role === 'Skipper' ? 'Skipper' : 'Crew')}
                                    {person.isSelf && person.name ? ' (you)' : ''}
                                </span>
                                <span className="shrink-0 text-[11px] font-bold text-sky-300/80">{person.role}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p
                        role="status"
                        className="rounded-xl border border-white/6 bg-white/2 px-3 py-3 text-[12px] text-gray-400"
                    >
                        {loading ? 'Loading the crew…' : `The crew list for ${boat} isn't available yet.`}
                    </p>
                )}
                {stale && view && (
                    <p className="mt-2 text-[11px] text-amber-300/70">Last updated {lastUpdated(view.fetchedAt)}</p>
                )}
            </div>

            {switching && (
                <ModalSheet isOpen={true} onClose={() => setSwitching(false)} title="Switch boat" maxWidth="max-w-sm">
                    <p className="text-xs text-gray-400 mb-3">Show the boat you're crewing on:</p>
                    <div className="space-y-2">
                        {vessels.map((candidate) => {
                            const selected = candidate.ownerId === vessel.ownerId;
                            return (
                                <button
                                    key={candidate.ownerId}
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => {
                                        triggerHaptic('medium');
                                        setSwitching(false);
                                        onSwitch(candidate.ownerId);
                                    }}
                                    className={`w-full min-h-[44px] rounded-xl px-4 py-3 text-left text-sm font-bold transition-colors ${
                                        selected
                                            ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                            : 'bg-white/5 text-white border border-white/5 hover:bg-white/10'
                                    }`}
                                >
                                    {/* Named as the panel names it: the hull's name first. */}
                                    {crewBoatName(
                                        candidate,
                                        selected ? view : getCachedCrewVesselView(candidate.ownerId),
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </ModalSheet>
            )}
        </section>
    );
};
