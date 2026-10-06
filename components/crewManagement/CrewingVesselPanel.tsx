/**
 * CrewingVesselPanel — the top of the Crew & Float Plan page while the account
 * is crew on a skipper's boat (Shane 2026-10-03: "it should all pertain to the
 * vessel that the punter has been invited on").
 *
 *   Crewing on Wandering Albatross
 *   Skipper: Capt Ana Reyes · Your role: Co-skipper
 *   [register chips]
 *   Switch boat (with more than one boat)
 *   Crew aboard Wandering Albatross — read-only, '(you)' against your row.
 *
 * The tier-1 look (2026-10-06, styles/crew-page.css): the boat is the page's
 * lead card in the Diary/Scuttlebutt wash and the people one glass list.
 * "Leave Wandering Albatross" is destructive, so it is no longer here beside
 * Switch boat: CrewManagement draws it as the page's last row (CrewDangerRow).
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
 * Presentational: CrewManagement decides what switching does. Never an email:
 * the skipper appears by name.
 */
import React, { useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import type { CrewMember, SharedRegister } from '../../services/CrewService';
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
import { RegisterChips } from '../crew/RegisterChips';
import { PersonGlyph, SailboatGlyph, SwapGlyph } from '../crew/crewGlyphs';

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
            <div className="crew-feature-card p-4">
                <div className="flex items-start gap-3">
                    <span aria-hidden="true" className="crew-tile-icon">
                        <SailboatGlyph />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2
                            className="text-[15px] font-black leading-tight text-white"
                            style={{ overflowWrap: 'anywhere' }}
                        >
                            {title}
                        </h2>
                        <div className="crew-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] font-semibold">
                            {skipper?.name ? <span>Skipper: {skipper.name}</span> : null}
                            <span>Your role: {crewRoleLabel(role)}</span>
                        </div>
                    </div>
                </div>
                <RegisterChips registers={registers} className="mt-3" />
                {vessels.length > 1 && (
                    <div className="mt-3">
                        <button
                            type="button"
                            onClick={() => {
                                triggerHaptic('light');
                                setSwitching(true);
                            }}
                            className="crew-quiet"
                        >
                            <SwapGlyph />
                            <span>Switch boat</span>
                        </button>
                    </div>
                )}
            </div>

            <div className="mt-5">
                <h3 className="crew-eyebrow mb-2">{aboardTitle}</h3>
                {people.length > 0 ? (
                    <ul aria-label={aboardTitle} className="crew-card crew-list">
                        {people.map((person, index) => (
                            <li
                                key={`${person.isSelf ? 'self' : 'person'}-${index}`}
                                className="flex min-h-[48px] items-center gap-3 px-3.5 py-2.5"
                            >
                                <PersonGlyph className="crew-accent h-4 w-4 shrink-0" />
                                <span
                                    className="min-w-0 flex-1 text-sm font-semibold text-white"
                                    style={{ overflowWrap: 'anywhere' }}
                                >
                                    {person.name ||
                                        (person.isSelf ? 'You' : person.role === 'Skipper' ? 'Skipper' : 'Crew')}
                                    {person.isSelf && person.name ? ' (you)' : ''}
                                </span>
                                <span className="crew-pill shrink-0">{person.role}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p role="status" className="crew-note">
                        {loading ? 'Loading the crew…' : `The crew list for ${boat} isn't available yet.`}
                    </p>
                )}
                {stale && view && (
                    <p className="mt-2 text-[11px] text-amber-300/80">Last updated {lastUpdated(view.fetchedAt)}</p>
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
                                            ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                                            : 'bg-white/5 text-white border border-white/8 hover:bg-white/10'
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
