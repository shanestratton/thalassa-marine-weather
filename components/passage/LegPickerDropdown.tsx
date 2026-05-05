/**
 * LegPickerDropdown — Multi-leg passage planner helper.
 *
 * For a voyage like "Brisbane → Fiji" sailed as three legs
 * (Brisbane → Nouméa → Vanuatu → Fiji), this dropdown lets the
 * skipper pick which leg they're planning so the route planner's
 * Departure box auto-fills with the correct port. Saves them
 * re-typing "Nouméa" when they arrive there and want to plan the
 * next hop.
 *
 * Visibility rules:
 *   - Hidden when no voyage is active.
 *   - Hidden when the active voyage has no legs yet (Cast Off
 *     creates Leg 1 automatically, so this only happens during the
 *     pre-departure window).
 *
 * Options shown:
 *   - The active leg (in progress, or pre-arrival): label "Leg N
 *     — <departure> → <destination>" with the voyage's
 *     destination_port as the destination. Selecting fills origin
 *     with the leg's departure port (useful for re-planning the
 *     current leg's weather routing without losing the typed
 *     destination).
 *   - Each completed leg: label "Leg N — <departure> → <arrival> ✓".
 *     Selecting fills origin with the leg's departure port
 *     (re-plan a completed leg).
 *   - "Plan next leg from <last arrival>": only when there's a
 *     completed leg AND no active leg. Selecting fills origin
 *     with the last leg's arrival port and clears destination so
 *     the user types the next hop's destination.
 *
 * Live-syncs via the `thalassa:active-voyage-changed` event so the
 * picker repopulates the moment Cast Off / Arrive at Port runs in
 * a sibling component.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { triggerHaptic } from '../../utils/system';
import { getCachedActiveVoyage, type Voyage } from '../../services/VoyageService';
import { getLegsForVoyage, getActiveLeg } from '../../services/VoyageLegService';
import type { PassageLeg } from '../../types/navigation';

interface LegPickerDropdownProps {
    /** Setter for the Departure ("From") input — wired into useVoyageForm.setOrigin */
    onSelectDeparture: (port: string) => void;
    /** Optional setter for the Destination ("To") input — wired into useVoyageForm.setDestination.
     *  When provided AND the user picks a leg with a known arrival port (or "Plan
     *  next leg from X"), we clear the destination so the user types the next
     *  hop's destination cleanly. */
    onSelectDestination?: (port: string) => void;
}

interface LegOption {
    /** Stable key for the dropdown */
    key: string;
    /** Label rendered in the option ("Leg 2 — Nouméa → Vanuatu ✓") */
    label: string;
    /** Port that gets piped into the Departure input on select */
    departurePort: string;
    /** Optional port to pipe into Destination on select (cleared otherwise) */
    destinationPort?: string;
    /** Whether this option is the "next leg" placeholder (no real leg yet) */
    isNextLeg?: boolean;
}

export const LegPickerDropdown: React.FC<LegPickerDropdownProps> = ({ onSelectDeparture, onSelectDestination }) => {
    const [voyage, setVoyage] = useState<Voyage | null>(() => getCachedActiveVoyage());
    const [legs, setLegs] = useState<PassageLeg[]>(() => {
        const v = getCachedActiveVoyage();
        return v ? getLegsForVoyage(v.id) : [];
    });
    const [activeLeg, setActiveLeg] = useState<PassageLeg | null>(() => {
        const v = getCachedActiveVoyage();
        return v ? getActiveLeg(v.id) : null;
    });
    const [open, setOpen] = useState(false);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);

    // Re-pull legs whenever the active voyage changes (Cast Off, End
    // Voyage, Arrive at Port, Depart Next Leg) — the events fire from
    // CastOffPanel / VoyageService.
    const refresh = useCallback(() => {
        const v = getCachedActiveVoyage();
        setVoyage(v);
        if (v) {
            const all = getLegsForVoyage(v.id);
            setLegs(all);
            setActiveLeg(getActiveLeg(v.id));
        } else {
            setLegs([]);
            setActiveLeg(null);
        }
    }, []);

    useEffect(() => {
        const handler = () => refresh();
        window.addEventListener('thalassa:active-voyage-changed', handler);
        // Legs live in localStorage and don't fire their own event.
        // Poll every 5s while the panel is open so a Depart-Next-Leg or
        // Arrive-at-Port action in CastOffPanel is reflected without a
        // route planner remount. 5s is plenty — leg transitions are
        // user-initiated and rare.
        const t = setInterval(refresh, 5_000);
        return () => {
            window.removeEventListener('thalassa:active-voyage-changed', handler);
            clearInterval(t);
        };
    }, [refresh]);

    /**
     * Build the visible option list. We deliberately surface:
     *   - completed legs (allow re-planning a leg the user already
     *     sailed — useful for "what if I'd left at a different time"
     *     scenarios on the voyage's pilot debrief)
     *   - the active leg (re-plan with fresh weather)
     *   - "Plan next leg from <last>" only when there's no active
     *     leg AND at least one completed leg (i.e. the skipper has
     *     arrived somewhere mid-voyage and is about to depart again)
     */
    const options = useMemo<LegOption[]>(() => {
        if (!voyage || legs.length === 0) return [];

        const completed = legs.filter((l) => l.status === 'completed');
        const opts: LegOption[] = [];

        for (const leg of legs) {
            const arrival = leg.arrival_port ?? voyage.destination_port ?? '';
            const tick = leg.status === 'completed' ? ' ✓' : '';
            opts.push({
                key: `leg-${leg.id}`,
                label: `Leg ${leg.leg_number} — ${leg.departure_port}${arrival ? ` → ${arrival}` : ''}${tick}`,
                departurePort: leg.departure_port,
                destinationPort: leg.arrival_port ?? undefined,
            });
        }

        // "Plan next leg from <last arrival>" only makes sense when
        // there's no active leg (the skipper has arrived and is
        // sitting in a port). If they're mid-leg, the active leg
        // option already covers re-planning.
        if (!activeLeg && completed.length > 0) {
            const last = completed[completed.length - 1];
            if (last.arrival_port) {
                opts.push({
                    key: 'next-leg',
                    label: `Plan next leg from ${last.arrival_port}`,
                    departurePort: last.arrival_port,
                    destinationPort: undefined,
                    isNextLeg: true,
                });
            }
        }

        return opts;
    }, [voyage, legs, activeLeg]);

    const handleSelect = useCallback(
        (opt: LegOption) => {
            setSelectedKey(opt.key);
            setOpen(false);
            triggerHaptic('light');
            onSelectDeparture(opt.departurePort);
            // For the "next leg" planner, clear the destination so the
            // user types the next hop's destination cleanly. Same for
            // re-planning a completed leg where they may want to pick
            // a different arrival port. For the active leg, leave the
            // destination alone — it's almost always still correct.
            if (onSelectDestination && (opt.isNextLeg || opt.destinationPort)) {
                onSelectDestination(opt.destinationPort ?? '');
            }
        },
        [onSelectDeparture, onSelectDestination],
    );

    if (!voyage || options.length === 0) return null;

    const selectedLabel = options.find((o) => o.key === selectedKey)?.label;

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => {
                    setOpen((v) => !v);
                    triggerHaptic('light');
                }}
                className="w-full h-11 bg-amber-500/[0.06] border border-amber-500/20 hover:border-amber-500/40 rounded-xl px-4 text-sm text-amber-200 font-medium outline-none transition-all flex items-center justify-between gap-2"
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-black tracking-[0.18em] uppercase text-amber-400/80 shrink-0">
                        Leg
                    </span>
                    <span className="truncate text-left">
                        {selectedLabel ?? `${voyage.voyage_name} — pick a leg to auto-fill departure`}
                    </span>
                </div>
                <svg
                    className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="M6 9l6 6 6-6" />
                </svg>
            </button>

            {open && (
                <div
                    role="listbox"
                    className="absolute left-0 right-0 top-full mt-1 z-30 bg-[#0a0e14] border border-amber-500/20 rounded-xl shadow-xl shadow-black/40 overflow-hidden"
                >
                    {options.map((opt) => (
                        <button
                            key={opt.key}
                            type="button"
                            role="option"
                            aria-selected={selectedKey === opt.key}
                            onClick={() => handleSelect(opt)}
                            className={`w-full px-4 py-2.5 text-left text-sm border-b border-white/[0.04] last:border-b-0 transition-colors ${
                                opt.isNextLeg
                                    ? 'text-amber-300 hover:bg-amber-500/[0.08] font-bold'
                                    : 'text-white hover:bg-white/[0.05]'
                            }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
