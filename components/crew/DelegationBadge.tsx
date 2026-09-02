/**
 * DelegationBadge — Shows who is responsible for each readiness card.
 *
 * - SKIPPER_ONLY cards show a fixed "Skipper" badge.
 * - Delegatable cards show an "Assign" dropdown to assign crew.
 *
 * Extracted from CrewManagement to keep it focused.
 */

import React from 'react';
import { type CrewMember } from '../../services/CrewService';

/** Cards that can be delegated to qualified crew */
export const DELEGATABLE_CARDS: Record<string, { label: string; roles: string[] }> = {
    vessel_check: { label: 'Vessel Pre-Check', roles: ['Bosun', 'Engineer', 'First Mate'] },
    medical: { label: 'Medical & First Aid', roles: ['Medic', 'Nurse', 'Doctor'] },
    essential_reserves: { label: 'Essential Reserves', roles: ['First Mate', 'Bosun'] },
    voyage_provisioning: { label: 'Voyage Provisioning', roles: ['Cook', 'First Mate', 'Bosun'] },
    watch_schedule: { label: 'Watch Schedule', roles: ['First Mate', 'Watch Captain'] },
    comms_plan: { label: 'Communications', roles: ['Radio Operator', 'First Mate'] },
    customs_clearance: { label: 'Customs & Clearance', roles: ["Ship's Agent", 'First Mate'] },
};

/** Cards that ONLY the skipper can sign off — not delegatable */
const SKIPPER_ONLY = ['weather_briefing', 'aid_to_navigation'];

interface DelegationBadgeProps {
    cardKey: string;
    delegations: Record<string, string>;
    crewList: CrewMember[];
    menuOpen: string | null;
    onMenuToggle: (key: string | null) => void;
    onAssign: (cardKey: string, crewEmail: string | null) => void;
}

export const DelegationBadge: React.FC<DelegationBadgeProps> = ({
    cardKey,
    delegations,
    crewList,
    menuOpen,
    onMenuToggle,
    onAssign,
}) => {
    if (SKIPPER_ONLY.includes(cardKey)) {
        return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/15 text-[11px] font-bold text-amber-400/80 uppercase tracking-wider ml-1.5">
                👨‍✈️ Skipper
            </span>
        );
    }

    // A pending invite is a useful planning target: the skipper can set
    // responsibility while that crew member is joining. Declined (and
    // malformed) roster rows must never create an otherwise-empty Assign
    // control.
    const eligibleCrew = crewList.filter(
        (crew) =>
            (crew.status === 'pending' || crew.status === 'accepted') &&
            typeof crew.crew_email === 'string' &&
            crew.crew_email.trim().length > 0,
    );

    // Passage Planning is deliberately quiet for a solo skipper. The
    // "Assign" affordance only appears once there is somebody real to
    // assign it to; the non-interactive skipper badge above still explains
    // skipper-only readiness gates.
    if (eligibleCrew.length === 0) return null;

    const assigned = delegations[cardKey];
    const emailPrefix = (email: string) => email.split('@')[0].slice(0, 12);
    const isOpen = menuOpen === cardKey;

    return (
        <span className="relative inline-flex ml-1.5">
            <button
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onMenuToggle(isOpen ? null : cardKey);
                }}
                className={`hit-target-44 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all border ${
                    assigned
                        ? 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                        : 'bg-white/4 border-white/8 text-gray-500 hover:text-gray-300 hover:bg-white/8'
                }`}
            >
                {assigned ? `👤 ${emailPrefix(assigned)}` : '👤 Assign'}
            </button>

            {isOpen && (
                <div
                    className="absolute top-full left-0 mt-1 z-50 w-48 bg-gray-900/95 backdrop-blur-lg border border-white/10 rounded-xl shadow-2xl py-1 animate-in fade-in slide-in-from-top-1 duration-150"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                >
                    <div className="px-3 py-1.5 text-[11px] font-bold text-gray-500 uppercase tracking-widest">
                        {DELEGATABLE_CARDS[cardKey]?.roles.length
                            ? `Suggested: ${DELEGATABLE_CARDS[cardKey].roles.join(' · ')}`
                            : 'Assign to'}
                    </div>
                    {eligibleCrew.map((crew) => (
                        <button
                            key={crew.crew_email}
                            onClick={() => onAssign(cardKey, crew.crew_email)}
                            className={`w-full min-h-[44px] text-left px-3 py-2 text-xs transition-colors ${
                                assigned === crew.crew_email
                                    ? 'bg-sky-500/10 text-sky-400 font-bold'
                                    : 'text-gray-300 hover:bg-white/6'
                            }`}
                        >
                            <span className="mr-1.5">{assigned === crew.crew_email ? '✓' : '○'}</span>
                            {crew.crew_email}
                        </button>
                    ))}
                    {assigned && (
                        <>
                            <div className="border-t border-white/6 my-1" />
                            <button
                                onClick={() => onAssign(cardKey, null)}
                                className="w-full min-h-[44px] text-left px-3 py-2 text-xs text-red-400/70 hover:bg-red-500/10 transition-colors"
                            >
                                ✕ Unassign
                            </button>
                        </>
                    )}
                </div>
            )}
        </span>
    );
};
