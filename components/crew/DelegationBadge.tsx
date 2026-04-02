/**
 * DelegationBadge — Shows who is responsible for each readiness card.
 *
 * - SKIPPER_ONLY cards show a fixed "Skipper" badge.
 * - Delegatable cards show an "Assign" dropdown to assign crew.
 *
 * Extracted from CrewManagement to keep it focused.
 */

import React from 'react';

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
    crewList: { crew_email: string }[];
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
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/15 text-[9px] font-bold text-amber-400/80 uppercase tracking-wider ml-1.5">
                👨‍✈️ Skipper
            </span>
        );
    }

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
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider transition-all border ${
                    assigned
                        ? 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                        : 'bg-white/[0.04] border-white/[0.08] text-gray-500 hover:text-gray-300 hover:bg-white/[0.08]'
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
                    <div className="px-3 py-1.5 text-[9px] font-bold text-gray-500 uppercase tracking-widest">
                        {DELEGATABLE_CARDS[cardKey]?.roles.join(' · ') || 'Assign To'}
                    </div>
                    {crewList.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] text-gray-500 italic">No crew members yet</div>
                    ) : (
                        crewList.map((c) => (
                            <button
                                key={c.crew_email}
                                onClick={() => onAssign(cardKey, c.crew_email)}
                                className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                                    assigned === c.crew_email
                                        ? 'bg-sky-500/10 text-sky-400 font-bold'
                                        : 'text-gray-300 hover:bg-white/[0.06]'
                                }`}
                            >
                                <span className="mr-1.5">{assigned === c.crew_email ? '✓' : '○'}</span>
                                {c.crew_email}
                            </button>
                        ))
                    )}
                    {assigned && (
                        <>
                            <div className="border-t border-white/[0.06] my-1" />
                            <button
                                onClick={() => onAssign(cardKey, null)}
                                className="w-full text-left px-3 py-2 text-xs text-red-400/70 hover:bg-red-500/10 transition-colors"
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
